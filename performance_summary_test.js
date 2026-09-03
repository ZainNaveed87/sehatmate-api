/**
 * Performance summary service tests (no HTTP, no real database, no LLM).
 *
 * These tests exercise the deterministic performance domain directly with a
 * fake mysql2 pool:
 *   - the verbatim route extractions (readTodayTasksState,
 *     readTaskOutcomeSummary) keep the exact REST semantics
 *   - the agent-facing summary/comparison functions compute every number
 *     deterministically (completion rates, trends, next task, Reality
 *     Check completion, Simulation metrics) with no provider involvement
 *   - every user-owned query binds the authenticated userId
 *
 * The service module imports no AI provider code at all, so these tests
 * also prove the "no LLM calculation dependency" requirement structurally.
 */
import assert from 'node:assert/strict';

import {
  nextTaskFromTodayState,
  readPerformanceComparison,
  readPerformanceSummary,
  readTaskOutcomeSummary,
  readTodayTasksState,
} from './services/performance_summary_service.js';

const OK_PACKET = { affectedRows: 1, insertId: 0 };

/**
 * Minimal mysql2 pool double (same contract as services_boundary_test.js):
 * `respond(sql, params)` may return a result tuple or undefined; undefined
 * means "SELECT -> empty rows, everything else -> OK packet". Every
 * executed statement is recorded in pool.calls.
 */
function createFakePool(respond) {
  const calls = [];
  const execute = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: text, params });
    const custom = respond ? respond(text, params) : undefined;
    if (custom !== undefined) {
      if (custom instanceof Error) throw custom;
      return custom;
    }
    return /^SELECT|^WITH|^SHOW|^DESCRIBE/i.test(text) ? [[]] : [OK_PACKET];
  };
  const pool = {
    execute,
    async getConnection() {
      return {
        execute,
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
      };
    },
    calls,
  };
  return pool;
}

const USER = 'user-1';
const TODAY = '2026-09-03';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`ok - ${name}`);
};

const everyCallBindsUser = (pool, user) =>
  pool.calls
    .filter((call) => call.sql.includes('user_id'))
    .every((call) => call.params.includes(user));

// ---------------------------------------------------------------------------
// readTodayTasksState (verbatim GET /api/task-occurrences extraction)
// ---------------------------------------------------------------------------

const todayOccurrenceRows = [
  {
    id: 11,
    care_plan_id: 1,
    schedule_item_id: 101,
    occurrence_date: '2026-09-03',
    scheduled_time: '07:30',
    status: 'completed',
    completed_at: '2026-09-03 07:35:00',
    completed_time: '07:35',
    outcome_source: 'user',
    note: '',
    title: 'DemoMed Alpha',
    task_kind: 'medication',
    display_time: 'Morning',
    recurrence_text: 'Daily',
    grounding: 'verified',
    plan_title: 'Demo Plan',
  },
  {
    id: 14,
    care_plan_id: 2,
    schedule_item_id: 104,
    occurrence_date: '2026-09-03',
    scheduled_time: '10:00',
    status: 'missed',
    completed_at: null,
    completed_time: null,
    outcome_source: 'system',
    note: '',
    title: 'Follow-up',
    task_kind: 'appointment',
    display_time: 'Morning',
    recurrence_text: 'Daily',
    grounding: 'suggested',
    plan_title: 'Plan Two',
  },
  {
    id: 12,
    care_plan_id: 1,
    schedule_item_id: 102,
    occurrence_date: '2026-09-03',
    scheduled_time: '14:00',
    status: 'pending',
    completed_at: null,
    completed_time: null,
    outcome_source: 'user',
    note: '',
    title: 'DemoMed Beta',
    task_kind: 'medication',
    display_time: 'Afternoon',
    recurrence_text: 'Daily',
    grounding: 'verified',
    plan_title: 'Demo Plan',
  },
  {
    id: 13,
    care_plan_id: 1,
    schedule_item_id: 103,
    occurrence_date: '2026-09-03',
    scheduled_time: '22:30',
    status: 'pending',
    completed_at: null,
    completed_time: null,
    outcome_source: 'user',
    note: '',
    title: 'DemoMed Gamma',
    task_kind: 'medication',
    display_time: 'Bedtime',
    recurrence_text: 'Daily',
    grounding: 'verified',
    plan_title: 'Demo Plan',
  },
];

{
  const pool = createFakePool((text) => {
    if (text.includes('COUNT(*) AS open_count')) return [[{ open_count: 2 }]];
    if (text.includes('readiness_score')) {
      return [[
        { id: 1, title: 'Demo Plan', readiness_score: 85 },
        { id: 2, title: 'Plan Two', readiness_score: 75 },
      ]];
    }
    if (text.includes('plan_title')) return [todayOccurrenceRows];
    return undefined;
  });

  const result = await readTodayTasksState({
    pool,
    userId: USER,
    date: TODAY,
    today: TODAY,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.date, TODAY);
  assert.equal(result.data.occurrences.length, 4);
  assert.equal(result.data.occurrences[0].title, 'DemoMed Alpha');
  assert.equal(result.data.occurrences[0].planTitle, 'Demo Plan');
  assert.equal(result.data.occurrences[0].status, 'completed');
  assert.equal(result.data.occurrences[1].planTitle, 'Plan Two');
  assert.deepEqual(result.data.summary, {
    total: 4,
    completed: 1,
    skipped: 0,
    missed: 1,
    pending: 2,
    activePlans: 2,
    openCareGaps: 2,
    careReadiness: 80,
  });
  assert.ok(everyCallBindsUser(pool, USER), 'every user-owned query binds the authenticated user');
  ok('readTodayTasksState: occurrence list, day summary, and user binding match the route contract');
}

// ---------------------------------------------------------------------------
// nextTaskFromTodayState (deterministic next-task derivation)
// ---------------------------------------------------------------------------

{
  const next = nextTaskFromTodayState({
    occurrences: todayOccurrenceRows.map((row) => ({
      id: String(row.id),
      carePlanId: String(row.care_plan_id),
      planTitle: row.plan_title,
      title: row.title,
      scheduledTime: row.scheduled_time,
      status: row.status,
    })),
  });
  assert.equal(next.occurrenceId, '12');
  assert.equal(next.title, 'DemoMed Beta');
  assert.equal(next.scheduledTime, '14:00');
  assert.equal(next.carePlanId, '1');
  assert.equal(next.status, 'pending');
  ok('nextTaskFromTodayState: the earliest pending occurrence is the next task');

  assert.equal(nextTaskFromTodayState({ occurrences: [] }), null);
  assert.equal(nextTaskFromTodayState(null), null);
  ok('nextTaskFromTodayState: no pending task or missing state resolves to null');
}

// ---------------------------------------------------------------------------
// readTaskOutcomeSummary (verbatim GET /api/task-outcomes/summary extraction)
// ---------------------------------------------------------------------------

const sevenDayWindowRows = [
  {
    occurrence_date: '2026-08-28',
    status: 'completed',
    scheduled_at: new Date('2026-08-28T07:30:00Z'),
    completed_at: new Date('2026-08-28T07:40:00Z'),
  },
  {
    occurrence_date: '2026-08-29',
    status: 'completed',
    scheduled_at: new Date('2026-08-29T07:30:00Z'),
    completed_at: new Date('2026-08-29T08:30:00Z'),
  },
  {
    occurrence_date: '2026-08-30',
    status: 'skipped',
    scheduled_at: new Date('2026-08-30T07:30:00Z'),
    completed_at: null,
  },
  {
    occurrence_date: '2026-09-01',
    status: 'missed',
    scheduled_at: new Date('2026-09-01T07:30:00Z'),
    completed_at: null,
  },
  {
    occurrence_date: '2026-09-02',
    status: 'pending',
    scheduled_at: new Date('2026-09-02T07:30:00Z'),
    completed_at: null,
  },
  {
    occurrence_date: '2026-09-03',
    status: 'completed',
    scheduled_at: new Date('2026-09-03T14:00:00Z'),
    completed_at: new Date('2026-09-03T14:05:00Z'),
  },
];

{
  const pool = createFakePool((text) => {
    if (text.includes('occurrence_date BETWEEN')) return [sevenDayWindowRows];
    return undefined;
  });

  const result = await readTaskOutcomeSummary({
    pool,
    userId: USER,
    endDate: TODAY,
    today: TODAY,
    days: 7,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.startDate, '2026-08-28');
  assert.equal(result.data.endDate, TODAY);
  assert.equal(result.data.days, 7);
  assert.deepEqual(result.data.summary, {
    scheduled: 6,
    completed: 3,
    onTime: 2,
    late: 1,
    skipped: 1,
    missed: 1,
    pending: 1,
  });
  assert.equal(result.data.daily.length, 7);
  assert.deepEqual(result.data.daily[0], {
    date: '2026-08-28',
    scheduled: 1,
    completed: 1,
    skipped: 0,
    missed: 0,
    pending: 0,
  });
  assert.equal(result.data.daily[5].pending, 1);
  assert.equal(result.data.daily[6].completed, 1);
  assert.ok(everyCallBindsUser(pool, USER));
  ok('readTaskOutcomeSummary: on-time/late threshold, statuses, and daily breakdown match the route contract');
}

{
  const pool = createFakePool();
  const clamped = await readTaskOutcomeSummary({
    pool,
    userId: USER,
    endDate: TODAY,
    today: TODAY,
    days: '40',
  });
  assert.equal(clamped.data.days, 31);

  const invalid = await readTaskOutcomeSummary({
    pool,
    userId: USER,
    endDate: TODAY,
    today: TODAY,
    days: 'abc',
  });
  assert.equal(invalid.data.days, 7);

  const zero = await readTaskOutcomeSummary({
    pool,
    userId: USER,
    endDate: TODAY,
    today: TODAY,
    days: '0',
  });
  assert.equal(zero.data.days, 7);
  ok('readTaskOutcomeSummary: day clamping and the days=0 default quirk are preserved exactly');
}

// ---------------------------------------------------------------------------
// readPerformanceComparison (deterministic compare_performance)
// ---------------------------------------------------------------------------

function windowRows({ scheduled, completed }) {
  const rows = [];
  for (let index = 0; index < scheduled; index += 1) {
    rows.push({
      occurrence_date: '2026-08-20',
      status: index < completed ? 'completed' : 'pending',
      scheduled_at: new Date('2026-08-20T08:00:00Z'),
      completed_at: index < completed ? new Date('2026-08-20T08:10:00Z') : null,
    });
  }
  return rows;
}

async function runComparison({ currentRows, baselineRows, periodDays, baselineDays }) {
  const pool = createFakePool((text, params) => {
    if (text.includes('occurrence_date BETWEEN')) {
      // The 7-day window starts 2026-08-28; every other start is the baseline.
      const isCurrent = params[1] === '2026-08-28';
      return [isCurrent ? currentRows : baselineRows];
    }
    return undefined;
  });
  return {
    pool,
    result: await readPerformanceComparison({
      pool,
      userId: USER,
      today: TODAY,
      periodDays: periodDays ?? 7,
      baselineDays: baselineDays ?? 30,
    }),
  };
}

{
  const { pool, result } = await runComparison({
    currentRows: windowRows({ scheduled: 6, completed: 3 }),
    baselineRows: windowRows({ scheduled: 20, completed: 5 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.date, TODAY);
  assert.equal(result.data.periods.current.label, 'last_7_days');
  assert.equal(result.data.periods.baseline.label, 'last_30_days');
  assert.equal(result.data.periods.current.completionRate, 50);
  assert.equal(result.data.periods.baseline.completionRate, 25);
  assert.equal(result.data.periods.comparison.completionRateChange, 25);
  assert.equal(result.data.periods.comparison.direction, 'improved');
  assert.ok(everyCallBindsUser(pool, USER));
  ok('readPerformanceComparison: deterministic rates and improved direction (50% vs 25%)');
}

{
  const { result } = await runComparison({
    currentRows: windowRows({ scheduled: 6, completed: 3 }),
    baselineRows: windowRows({ scheduled: 6, completed: 3 }),
  });
  assert.equal(result.data.periods.comparison.completionRateChange, 0);
  assert.equal(result.data.periods.comparison.direction, 'stable');
  ok('readPerformanceComparison: equal rates report stable');
}

{
  const { result } = await runComparison({
    currentRows: windowRows({ scheduled: 4, completed: 1 }),
    baselineRows: windowRows({ scheduled: 6, completed: 3 }),
  });
  assert.equal(result.data.periods.current.completionRate, 25);
  assert.equal(result.data.periods.baseline.completionRate, 50);
  assert.equal(result.data.periods.comparison.completionRateChange, -25);
  assert.equal(result.data.periods.comparison.direction, 'declined');
  ok('readPerformanceComparison: lower current rate reports declined');
}

{
  const { result } = await runComparison({
    currentRows: [],
    baselineRows: windowRows({ scheduled: 6, completed: 3 }),
  });
  assert.equal(result.data.periods.current.completionRate, null);
  assert.equal(result.data.periods.comparison.completionRateChange, null);
  assert.equal(result.data.periods.comparison.direction, 'insufficient_data');
  ok('readPerformanceComparison: an empty window reports unknown, never a fake 0%');
}

{
  const { result } = await runComparison({
    currentRows: windowRows({ scheduled: 6, completed: 3 }),
    baselineRows: windowRows({ scheduled: 6, completed: 3 }),
    periodDays: '40',
  });
  assert.equal(result.data.periods.current.days, 31);
  assert.equal(result.data.periods.current.label, 'last_31_days');
  ok('readPerformanceComparison: agent-supplied period days are clamped deterministically');
}

// ---------------------------------------------------------------------------
// readPerformanceSummary (deterministic get_performance_summary)
// ---------------------------------------------------------------------------

{
  const pool = createFakePool();
  const result = await readPerformanceSummary({
    pool,
    userId: USER,
    today: TODAY,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.date, TODAY);
  assert.deepEqual(result.data.today.summary, {
    total: 0,
    completed: 0,
    skipped: 0,
    missed: 0,
    pending: 0,
    activePlans: 0,
    openCareGaps: 0,
    careReadiness: 0,
  });
  assert.equal(result.data.today.nextTask, null);
  assert.equal(result.data.periods.current.completionRate, null);
  assert.equal(result.data.periods.comparison.direction, 'insufficient_data');
  assert.equal(result.data.primaryPlan, null);
  assert.equal(result.data.realityCheck, null);
  assert.equal(result.data.simulation, null);
  assert.ok(everyCallBindsUser(pool, USER));
  ok('readPerformanceSummary: a user with no active plans degrades to explicit nulls, never invented numbers');
}

{
  const pool = createFakePool((text) => {
    if (text.includes('readiness_score')) {
      return [[{ id: 1, title: 'Demo Plan', readiness_score: 85 }]];
    }
    if (text.startsWith('SELECT id, title FROM care_plans')) {
      return [[{ id: 1, title: 'Demo Plan' }]];
    }
    if (text.startsWith('SELECT id FROM care_plans WHERE id = ?')) {
      return [[{ id: 1 }]];
    }
    return undefined;
  });

  const result = await readPerformanceSummary({
    pool,
    userId: USER,
    today: TODAY,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.today.summary.activePlans, 1);
  assert.equal(result.data.today.summary.careReadiness, 85);
  assert.deepEqual(result.data.primaryPlan, { id: '1', title: 'Demo Plan' });
  assert.equal(result.data.realityCheck.planId, '1');
  assert.equal(result.data.realityCheck.planTitle, 'Demo Plan');
  assert.equal(result.data.realityCheck.totalQuestions, 0);
  assert.equal(result.data.realityCheck.answered, 0);
  assert.equal(result.data.realityCheck.unanswered, 0);
  assert.equal(result.data.realityCheck.complete, false);
  assert.equal(result.data.simulation.planId, '1');
  assert.equal(result.data.simulation.score, 100);
  // The authoritative simulation derives one blocking document gap for a
  // plan with no linked document, so the empty fake plan is hard blocked.
  assert.equal(result.data.simulation.hardBlockerCount, 1);
  assert.equal(result.data.simulation.activationAllowed, false);
  assert.deepEqual(result.data.simulation.metrics, {
    blocked: 1,
    atRisk: 0,
    ready: 0,
    unclear: 0,
  });
  assert.ok(everyCallBindsUser(pool, USER));
  ok('readPerformanceSummary: primary plan Reality Check completion and Simulation metrics come from the authoritative service');
}

console.log(`Performance summary tests passed (${passed} tests).`);
