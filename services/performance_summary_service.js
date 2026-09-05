/**
 * Authoritative performance summary domain (today's tasks, outcome windows,
 * and the deterministic agent-facing performance summary).
 *
 * Part 1 is a verbatim extraction of the user-level route handlers in
 * server.js so the REST routes and the Phase B agent READ capabilities share
 * ONE implementation:
 *   - readTodayTasksState    <- GET /api/task-occurrences
 *   - readTaskOutcomeSummary <- GET /api/task-outcomes/summary
 * Behavior is preserved exactly, including the reconciliation and
 * occurrence-ensuring side effects that were part of the original GET
 * routes.
 *
 * Part 2 is the deterministic agent-facing summary required by the Phase B
 * specification (section 7). Every number is computed by backend code and
 * never by the LLM:
 *   - readPerformanceSummary    <- get_performance_summary capability
 *   - readPerformanceComparison <- compare_performance capability
 *
 * Documented formulas:
 *   completionRate:
 *     scheduled > 0 ? Math.round((completed / scheduled) * 100) : null
 *     - "scheduled" counts every occurrence row in the window
 *       (completed + skipped + missed + pending), exactly like the
 *       GET /api/task-outcomes/summary reduce step.
 *     - null means "no scheduled occurrences in the window" and must be
 *       reported as unknown, never as 0%.
 *   onTime: a completed occurrence with completed_at - scheduled_at
 *     <= 30 minutes (same threshold as GET /api/task-outcomes/summary).
 *   comparison.completionRateChange: currentRate - baselineRate in
 *     percentage points (integer).
 *   comparison.direction: 'improved' when the change is positive,
 *     'declined' when negative, 'stable' when zero, 'insufficient_data'
 *     when either completion rate is null.
 *   nextTask: the first occurrence with status 'pending' in today's
 *     occurrence list. The occurrences query already orders by
 *     scheduled_at, id ascending, so this is the earliest pending task of
 *     the day; earlier tasks that are still pending are surfaced rather
 *     than skipped past.
 *   primaryPlan: the most recently activated active plan, using the exact
 *     ordering of GET /api/task-occurrences (activated_at DESC, id DESC).
 *   realityCheck completion: answered = currentQuestionCount - unanswered
 *     where both numbers come from readSimulationState
 *     (realityDiagnostics.currentQuestionCount and the unanswered template
 *     count). complete means zero unanswered questions for the primary
 *     plan.
 *
 * Date semantics are preserved from the original routes: serverDateKey()
 * and taskOutcomeDate() UTC date keys and windows clamped to 1..31 days.
 * There is no second scheduling or reconciliation implementation here; the
 * agent-facing functions only compose the extracted route primitives and
 * readSimulationState.
 */

import {
  dbDateKey,
  serverDateKey,
  taskOutcomeDate,
} from './shared_utils.js';

import {
  ensureOccurrencesForDate,
  ensureOccurrencesForRange,
  reconcileExpiredFixedDurationOccurrences,
  reconcileMissedOccurrences,
  reconcilePlanLifecycle,
  taskOccurrenceJson,
} from './task_outcome_service.js';

import { readSimulationState } from './simulation_service.js';

import {
  careGapSummary,
} from '../care_gap_engine.js';

import {
  readCurrentPlanUnderstanding,
} from './teach_back_service.js';

/**
 * Verbatim extraction of the GET /api/task-occurrences handler.
 *
 * Reconciles plan lifecycle and missed occurrences, ensures today's (or the
 * requested date's) occurrences exist for every active plan, and returns
 * the occurrence list plus the day summary. Errors propagate to the caller
 * exactly like the original route's next(error) path.
 */
export async function readTodayTasksState({ pool, userId, date = null, today = null }) {
  const dateKey = taskOutcomeDate(date) || serverDateKey();
  const clientToday = taskOutcomeDate(today) || serverDateKey();

  await reconcilePlanLifecycle({
    db: pool,
    userId,
    today: clientToday,
  });
  await reconcileMissedOccurrences({
    db: pool,
    userId,
    beforeDate: clientToday,
  });

  const [activePlans] = await pool.execute(
    `SELECT id, title, readiness_score
     FROM care_plans
     WHERE user_id = ? AND status = 'active'
     ORDER BY activated_at DESC, id DESC`,
    [userId],
  );

  for (const plan of activePlans) {
    await reconcileExpiredFixedDurationOccurrences({
      db: pool,
      userId,
      planId: plan.id,
      dateKey,
    });
    await ensureOccurrencesForDate({
      db: pool,
      userId,
      planId: plan.id,
      dateKey,
    });
  }

  const [rows] = await pool.execute(
    `SELECT o.id, o.care_plan_id, o.schedule_item_id, o.occurrence_date,
      TIME_FORMAT(o.scheduled_at, '%H:%i') AS scheduled_time,
      o.status, o.completed_at,
      TIME_FORMAT(o.completed_at, '%H:%i') AS completed_time,
      o.outcome_source, o.note,
      s.title, s.task_kind, s.display_time, s.recurrence_text, s.grounding,
      p.title AS plan_title
     FROM care_task_occurrences o
     JOIN care_schedule_items s ON s.id = o.schedule_item_id
     JOIN care_plans p ON p.id = o.care_plan_id
     WHERE o.user_id = ? AND o.occurrence_date = ?
     ORDER BY o.scheduled_at, o.id`,
    [userId, dateKey],
  );

  const summary = rows.reduce((value, row) => {
    value.total += 1;
    if (row.status === 'completed') value.completed += 1;
    else if (row.status === 'skipped') value.skipped += 1;
    else if (row.status === 'missed') value.missed += 1;
    else value.pending += 1;
    return value;
  }, {
    total: 0,
    completed: 0,
    skipped: 0,
    missed: 0,
    pending: 0,
  });

  const [gapRows] = await pool.execute(
    `SELECT COUNT(*) AS open_count
     FROM care_gaps g
     JOIN care_plans p ON p.id = g.care_plan_id
     WHERE p.user_id = ?
       AND g.lifecycle_status <> 'resolved'`,
    [userId],
  );

  const readinessValues = activePlans
    .map((plan) => Number(plan.readiness_score))
    .filter((value) => Number.isFinite(value));
  const careReadiness = readinessValues.length
    ? Math.round(readinessValues.reduce((sum, value) => sum + value, 0) / readinessValues.length)
    : 0;

  return {
    ok: true,
    data: {
      date: dateKey,
      occurrences: rows.map((row) => ({
        ...taskOccurrenceJson(row),
        planTitle: row.plan_title || 'Care plan',
      })),
      summary: {
        ...summary,
        activePlans: activePlans.length,
        openCareGaps: Number(gapRows[0]?.open_count || 0),
        careReadiness,
      },
    },
  };
}

/**
 * Verbatim extraction of the GET /api/task-outcomes/summary handler.
 *
 * Reconciles plan lifecycle and missed occurrences, ensures occurrences
 * exist for the whole requested window, and returns the window summary
 * (scheduled/completed/onTime/late/skipped/missed/pending) plus the
 * per-day breakdown. Days are clamped to 1..31 exactly like the original
 * route.
 */
export async function readTaskOutcomeSummary({
  pool,
  userId,
  endDate = null,
  today = null,
  days = null,
}) {
  const endKey = taskOutcomeDate(endDate) || serverDateKey();
  const clientToday = taskOutcomeDate(today) || serverDateKey();
  const dayCount = Math.max(1, Math.min(31, Number.parseInt(days, 10) || 7));
  const end = new Date(`${endKey}T00:00:00Z`);
  const start = new Date(end.getTime() - ((dayCount - 1) * 86400000));
  const startDate = start.toISOString().slice(0, 10);

  await reconcilePlanLifecycle({
    db: pool,
    userId,
    today: clientToday,
  });
  await reconcileMissedOccurrences({
    db: pool,
    userId,
    beforeDate: clientToday,
  });

  const [activePlans] = await pool.execute(
    `SELECT id
     FROM care_plans
     WHERE user_id = ? AND status = 'active'
     ORDER BY id`,
    [userId],
  );

  for (const plan of activePlans) {
    await ensureOccurrencesForRange({
      db: pool,
      userId,
      planId: plan.id,
      startDate,
      endDate: endKey,
    });
  }

  const [rows] = await pool.execute(
    `SELECT occurrence_date, status, scheduled_at, completed_at
     FROM care_task_occurrences
     WHERE user_id = ?
       AND occurrence_date BETWEEN ? AND ?
     ORDER BY occurrence_date, scheduled_at`,
    [userId, startDate, endKey],
  );

  const summary = rows.reduce((value, row) => {
    value.scheduled += 1;
    if (row.status === 'completed') {
      value.completed += 1;
      const scheduled = new Date(row.scheduled_at);
      const completed = new Date(row.completed_at);
      if (!Number.isNaN(scheduled.getTime()) && !Number.isNaN(completed.getTime())) {
        const deltaMinutes = Math.round((completed.getTime() - scheduled.getTime()) / 60000);
        if (deltaMinutes <= 30) value.onTime += 1;
        else value.late += 1;
      }
    } else if (row.status === 'skipped') value.skipped += 1;
    else if (row.status === 'missed') value.missed += 1;
    else value.pending += 1;
    return value;
  }, {
    scheduled: 0,
    completed: 0,
    onTime: 0,
    late: 0,
    skipped: 0,
    missed: 0,
    pending: 0,
  });

  const byDate = new Map();
  for (let offset = 0; offset < dayCount; offset += 1) {
    const day = new Date(start.getTime() + (offset * 86400000))
      .toISOString()
      .slice(0, 10);
    byDate.set(day, {
      date: day,
      scheduled: 0,
      completed: 0,
      skipped: 0,
      missed: 0,
      pending: 0,
    });
  }

  for (const row of rows) {
    const key = dbDateKey(row.occurrence_date);
    const day = byDate.get(key);
    if (!day) continue;
    day.scheduled += 1;
    if (row.status === 'completed') day.completed += 1;
    else if (row.status === 'skipped') day.skipped += 1;
    else if (row.status === 'missed') day.missed += 1;
    else day.pending += 1;
  }

  return {
    ok: true,
    data: {
      startDate,
      endDate: endKey,
      days: dayCount,
      summary,
      daily: [...byDate.values()],
    },
  };
}

function clampPeriodDays(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(31, parsed));
}

function completionRateFor(summary) {
  const scheduled = Number(summary?.scheduled || 0);
  const completed = Number(summary?.completed || 0);
  if (scheduled <= 0) return null;
  return Math.round((completed / scheduled) * 100);
}

function normalizeProgressWindowDays(value) {
  if (value === null || value === undefined || value === '') {
    return { ok: true, days: 7 };
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    return {
      ok: false,
      code: 'PROGRESS_INVALID_WINDOW',
      message: 'Choose a progress window between 1 and 31 days.',
    };
  }
  const parsed = Number.parseInt(text, 10);
  return {
    ok: true,
    days: Math.max(1, Math.min(31, parsed)),
  };
}

function trendPointFor(day) {
  return {
    date: day.date,
    scheduled: Number(day.scheduled || 0),
    completed: Number(day.completed || 0),
    value: completionRateFor(day),
  };
}

/**
 * Deterministic next-task derivation shared by the performance summary and
 * the future get_next_task capability: the first pending occurrence in the
 * day's scheduled order (see the module header for the exact formula).
 */
export function nextTaskFromTodayState(todayData) {
  const occurrence = todayData?.occurrences
    ?.find((item) => item.status === 'pending') || null;
  if (!occurrence) return null;
  return {
    occurrenceId: occurrence.id,
    carePlanId: occurrence.carePlanId,
    planTitle: occurrence.planTitle,
    title: occurrence.title,
    scheduledTime: occurrence.scheduledTime,
    status: occurrence.status,
  };
}

async function readPeriodPair({ pool, userId, endDate, today, currentDays, baselineDays }) {
  const current = await readTaskOutcomeSummary({
    pool,
    userId,
    endDate,
    today,
    days: currentDays,
  });
  const baseline = await readTaskOutcomeSummary({
    pool,
    userId,
    endDate,
    today,
    days: baselineDays,
  });

  const currentRate = completionRateFor(current.data.summary);
  const baselineRate = completionRateFor(baseline.data.summary);
  const rateChange = currentRate === null || baselineRate === null
    ? null
    : currentRate - baselineRate;
  const direction = rateChange === null
    ? 'insufficient_data'
    : rateChange > 0
      ? 'improved'
      : rateChange < 0
        ? 'declined'
        : 'stable';

  return {
    current: {
      label: `last_${current.data.days}_days`,
      startDate: current.data.startDate,
      endDate: current.data.endDate,
      days: current.data.days,
      summary: current.data.summary,
      completionRate: currentRate,
    },
    baseline: {
      label: `last_${baseline.data.days}_days`,
      startDate: baseline.data.startDate,
      endDate: baseline.data.endDate,
      days: baseline.data.days,
      summary: baseline.data.summary,
      completionRate: baselineRate,
    },
    comparison: {
      completionRateChange: rateChange,
      direction,
    },
  };
}

/**
 * Deterministic performance comparison for the compare_performance
 * capability: two outcome windows ending on the same day (defaults: last 7
 * days vs last 30 days) with computed completion rates and the change
 * between them.
 */
export async function readPerformanceComparison({
  pool,
  userId,
  today = null,
  periodDays = 7,
  baselineDays = 30,
}) {
  const clientToday = taskOutcomeDate(today) || serverDateKey();
  const currentDays = clampPeriodDays(periodDays, 7);
  const baselineCount = clampPeriodDays(baselineDays, 30);

  const periods = await readPeriodPair({
    pool,
    userId,
    endDate: clientToday,
    today: clientToday,
    currentDays,
    baselineDays: baselineCount,
  });

  return {
    ok: true,
    data: {
      date: clientToday,
      periods,
    },
  };
}

/**
 * Deterministic agent-facing performance summary for the
 * get_performance_summary capability.
 *
 * Composes only the extracted route primitives and readSimulationState:
 *   - today's counts and next task (readTodayTasksState)
 *   - two outcome windows ending today (defaults: 7 and 30 days) with
 *     completion rates and the comparison between them
 *   - the primary plan's Reality Check completion state and Simulation
 *     score / blocked / at-risk / ready / unclear metrics
 *
 * If the primary plan's simulation state cannot be read, the simulation
 * and realityCheck sections are reported as null instead of failing the
 * whole summary.
 */
export async function readPerformanceSummary({
  pool,
  userId,
  today = null,
  periodDays = 7,
  baselineDays = 30,
}) {
  const clientToday = taskOutcomeDate(today) || serverDateKey();
  const currentDays = clampPeriodDays(periodDays, 7);
  const baselineCount = clampPeriodDays(baselineDays, 30);

  const todayState = await readTodayTasksState({
    pool,
    userId,
    date: clientToday,
    today: clientToday,
  });

  const periods = await readPeriodPair({
    pool,
    userId,
    endDate: clientToday,
    today: clientToday,
    currentDays,
    baselineDays: baselineCount,
  });

  const [activePlans] = await pool.execute(
    `SELECT id, title
     FROM care_plans
     WHERE user_id = ? AND status = 'active'
     ORDER BY activated_at DESC, id DESC`,
    [userId],
  );
  const primaryPlan = activePlans[0]
    ? {
        id: String(activePlans[0].id),
        title: activePlans[0].title || 'Care plan',
      }
    : null;

  let realityCheck = null;
  let simulation = null;
  if (primaryPlan) {
    const simulationResult = await readSimulationState({
      pool,
      userId,
      planId: primaryPlan.id,
    });
    if (simulationResult.ok) {
      const state = simulationResult.data;
      const totalQuestions = Number(
        state.realityDiagnostics?.currentQuestionCount || 0,
      );
      const unansweredCount = Number(state.unanswered || 0);
      realityCheck = {
        planId: primaryPlan.id,
        planTitle: primaryPlan.title,
        totalQuestions,
        answered: Math.max(0, totalQuestions - unansweredCount),
        unanswered: unansweredCount,
        complete: totalQuestions > 0 && unansweredCount === 0,
      };
      simulation = {
        planId: primaryPlan.id,
        planTitle: primaryPlan.title,
        score: state.readiness,
        activationAllowed: state.activationAllowed,
        hardBlockerCount: state.hardBlockerCount,
        metrics: state.metrics,
      };
    }
  }

  return {
    ok: true,
    data: {
      date: clientToday,
      today: {
        summary: todayState.data.summary,
        nextTask: nextTaskFromTodayState(todayState.data),
      },
      periods,
      primaryPlan,
      realityCheck,
      simulation,
    },
  };
}

export async function readProgressSummary({
  pool,
  userId,
  today = null,
  days = null,
}) {
  const window = normalizeProgressWindowDays(days);
  if (!window.ok) return window;

  const clientToday = taskOutcomeDate(today) || serverDateKey();
  const performance = await readPerformanceSummary({
    pool,
    userId,
    today: clientToday,
    periodDays: window.days,
  });
  if (!performance.ok) return performance;

  const taskOutcomes = await readTaskOutcomeSummary({
    pool,
    userId,
    endDate: clientToday,
    today: clientToday,
    days: window.days,
  });
  if (!taskOutcomes.ok) return taskOutcomes;

  const [activePlans] = await pool.execute(
    `SELECT id, title
     FROM care_plans
     WHERE user_id = ? AND status = 'active'
     ORDER BY activated_at DESC, id DESC`,
    [userId],
  );

  const [gapRows] = await pool.execute(
    `SELECT g.lifecycle_status, g.severity
     FROM care_gaps g
     JOIN care_plans p ON p.id = g.care_plan_id
     WHERE p.user_id = ?
       AND p.status = 'active'`,
    [userId],
  );

  const primaryPlan = performance.data.primaryPlan;
  let understanding = {
    available: false,
    score: null,
    planId: primaryPlan?.id || null,
    planTitle: primaryPlan?.title || null,
  };
  if (primaryPlan) {
    const currentUnderstanding = await readCurrentPlanUnderstanding({
      pool,
      userId,
      planId: primaryPlan.id,
    });
    if (currentUnderstanding.ok) {
      understanding = currentUnderstanding.data;
    }
  }

  const summary = taskOutcomes.data.summary;
  const activePlanCount = Number(activePlans.length || 0);
  const readinessScore = Number(performance.data.today?.summary?.careReadiness);
  const readinessAvailable =
    activePlanCount > 0 && Number.isFinite(readinessScore);

  return {
    ok: true,
    data: {
      date: clientToday,
      windowDays: window.days,
      activePlanCount,
      primaryPlan,
      readiness: {
        available: readinessAvailable,
        score: readinessAvailable ? readinessScore : null,
      },
      tasks: {
        scheduled: Number(summary.scheduled || 0),
        completed: Number(summary.completed || 0),
        skipped: Number(summary.skipped || 0),
        missed: Number(summary.missed || 0),
        pending: Number(summary.pending || 0),
        completionRate: completionRateFor(summary),
      },
      gaps: (() => {
        const summaryValue = careGapSummary(gapRows);
        return {
          total: summaryValue.total,
          open: summaryValue.open,
          inProgress: summaryValue.inProgress,
          resolved: summaryValue.resolved,
        };
      })(),
      understanding,
      trend: {
        metric: 'task_completion_rate',
        points: taskOutcomes.data.daily.map(trendPointFor),
      },
    },
  };
}
