/**
 * Authoritative Simulation read domain (readiness score, blocked / at-risk /
 * ready / unclear metrics, findings, and care-gap integration).
 *
 * Extracted verbatim from the /api/care-plans/:id/simulation route handler
 * in server.js so the REST route and the Phase B agent get_simulation
 * capability share ONE implementation. Behavior is preserved exactly,
 * including the authoritative persistence steps that were part of the
 * original GET route:
 *   - stale care_reality_answers.risk_points rows are reconciled from the
 *     current question template
 *   - care_plans.readiness_score (and setup-state status) are persisted
 *
 * The schedule-conflict and practical-adaptation helpers moved with the
 * route. scheduleTimeToMinutes, formatScheduleTime and
 * hasPracticalScheduleConflict are exported as well because the adapt-plan
 * route in server.js still uses them; everything else stays private to
 * this module.
 */

import {
  careGapJson,
  careGapSummary,
  refreshCareGaps,
} from '../care_gap_engine.js';

import {
  enrichSimulationFindingsWithContext,
  readCareContextInsightsForPlan,
} from '../care_context_engine.js';

import {
  actionForRealityIntent,
  matchRealityAnswersToTemplates,
  riskPointsForRealityAnswer,
  targetTasksForRealityQuestion,
} from '../reality_check_decision.js';

import { readRoutineProfile } from '../routine_learning.js';

import {
  realityDecisionTemplatesForPlan,
  realityQuestionTemplates,
} from './reality_answer_service.js';

import {
  idPattern,
  parseStoredObject,
  routineNoteTime,
  schedulePeriodKey,
  scheduleWindow,
  timeFitsScheduleWindow,
} from './shared_utils.js';

export function scheduleTimeToMinutes(value) {
  const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)/);
  if (!match) return null;
  return (Number(match[1]) * 60) + Number(match[2]);
}

export function formatScheduleTime(value) {
  const minutes = scheduleTimeToMinutes(value);
  if (minutes == null) return String(value || '');
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function defaultSuggestionTimes(period) {
  switch (period) {
    case 'morning':
      return ['09:30', '10:30', '08:30', '11:00'];
    case 'afternoon':
      return ['14:30', '15:30', '13:30', '16:00'];
    case 'evening':
      return ['19:30', '20:00', '18:30', '17:30'];
    case 'night':
      return ['22:00', '23:00', '21:30', '00:30'];
    default:
      return [];
  }
}

function scheduleKindsCompatibleAtSameTime(first, second) {
  const firstKind = String(first?.task_kind || '').toLowerCase();
  const secondKind = String(second?.task_kind || '').toLowerCase();

  if (firstKind === 'medicine' && secondKind === 'medicine') {
    return true;
  }

  const appointmentKinds = new Set(['lab_test', 'follow_up']);
  if (appointmentKinds.has(firstKind) || appointmentKinds.has(secondKind)) {
    return false;
  }

  return true;
}

export function hasPracticalScheduleConflict(task, candidateTime, tasks) {
  return tasks.some((other) => {
    if (String(other.id) === String(task.id)) return false;
    if (String(other.schedule_date || '') !== String(task.schedule_date || '')) {
      return false;
    }
    const otherTime = String(other.schedule_time || '').slice(0, 5);
    if (!otherTime || otherTime !== candidateTime) return false;

    if (
      String(other.instruction_id || '') === String(task.instruction_id || '')
    ) {
      return true;
    }

    return !scheduleKindsCompatibleAtSameTime(task, other);
  });
}

function uniqueSuggestionCandidates(values) {
  return [...new Set(values.filter(Boolean))];
}

function suggestionTimeForTask(task, tasks, note, routineProfile = null) {
  const period = schedulePeriodKey(
    `${task.display_time || ''} ${task.recurrence_text || ''}`,
  );
  if (!period) return null;

  const window = scheduleWindow(period);
  const answerNoteTime = routineNoteTime(note);
  const profileNote = routineProfile?.notes?.[period] || '';
  const savedPreferenceTime = routineNoteTime(profileNote);
  const learnedTime = routineProfile?.learningEnabled
    ? routineProfile?.learned?.[period]?.preferredTime || null
    : null;

  const candidates = uniqueSuggestionCandidates([
    answerNoteTime,
    savedPreferenceTime,
    learnedTime,
    ...defaultSuggestionTimes(period),
  ]);

  const current = String(task.schedule_time || '').slice(0, 5);

  // Evaluate candidates strictly in priority order:
  // 1) exact time written in the current Reality Check answer
  // 2) manually saved routine preference
  // 3) learned preference
  // 4) generic period defaults
  //
  // A previous lower-priority preference must NOT make the current schedule
  // look "already resolved" when the user has just provided a newer,
  // higher-priority Reality Check time.
  for (const candidate of candidates) {
    const minutes = scheduleTimeToMinutes(candidate);
    if (minutes == null || !timeFitsScheduleWindow(minutes, window)) continue;
    if (hasPracticalScheduleConflict(task, candidate, tasks)) continue;

    const why = [];
    if (candidate === answerNoteTime) {
      why.push('It matches the time you mentioned in this Reality Check answer.');
    } else if (candidate === savedPreferenceTime) {
      why.push(`It matches your saved ${period} routine preference.`);
    } else if (candidate === learnedTime) {
      why.push(
        `SehatMate learned this ${period} time from your previous timing choices.`,
      );
    } else {
      why.push(`It is a practical starting point inside your allowed ${period} period.`);
    }
    why.push(`It stays inside the verified ${period} reminder period.`);
    why.push('It does not create a practical schedule conflict with your current plan.');

    if (candidate === current) {
      const currentWhy = [...why];
      currentWhy[0] =
        candidate === answerNoteTime
          ? 'The current reminder already matches the time you mentioned in this Reality Check answer.'
          : candidate === savedPreferenceTime
            ? `The current reminder already matches your saved ${period} routine preference.`
            : candidate === learnedTime
              ? `The current reminder already matches the ${period} time SehatMate learned from your previous choices.`
              : `The current reminder already matches the best available ${period} reminder slot.`;

      return {
        period,
        time: current,
        why: currentWhy,
        alreadyApplied: true,
      };
    }

    return { period, time: candidate, why };
  }

  return null;
}

function buildScheduleConflictFindings(tasks, routineProfile) {
  const grouped = new Map();

  for (const task of tasks) {
    const time = String(task.schedule_time || '').slice(0, 5);
    if (!time) continue;
    const key = `${String(task.schedule_date || '')}|${time}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(task);
  }

  const findings = [];
  for (const sameTimeTasks of grouped.values()) {
    if (sameTimeTasks.length < 2) continue;

    let conflictingPair = null;
    for (let i = 0; i < sameTimeTasks.length && !conflictingPair; i += 1) {
      for (let j = i + 1; j < sameTimeTasks.length; j += 1) {
        if (!scheduleKindsCompatibleAtSameTime(sameTimeTasks[i], sameTimeTasks[j])) {
          conflictingPair = [sameTimeTasks[i], sameTimeTasks[j]];
          break;
        }
      }
    }
    if (!conflictingPair) continue;

    const target =
      conflictingPair.find((task) => String(task.grounding || '') !== 'explicit') ||
      null;
    const fixed = target
      ? conflictingPair.find((task) => String(task.id) !== String(target.id))
      : conflictingPair[0];

    const currentTime = String(conflictingPair[0].schedule_time || '').slice(0, 5);
    const suggestion = target
      ? suggestionTimeForTask(target, tasks, '', routineProfile)
      : null;

    findings.push({
      key: `schedule_conflict:${conflictingPair.map((task) => task.id).join(':')}`,
      category: 'Schedule conflict',
      question: 'Two tasks may compete for the same time',
      answer: `${formatScheduleTime(currentTime)} · ${conflictingPair
        .map((task) => task.title)
        .join(' + ')}`,
      severity: 'at_risk',
      reason:
        'SehatMate found tasks at the same time that are not automatically treated as compatible. Medicine reminders at the same time are not flagged by themselves.',
      recommendation: target && suggestion
        ? `Move the flexible task "${target.title}" while keeping "${fixed.title}" unchanged.`
        : 'Review these tasks manually. SehatMate will not move an explicit verified time automatically.',
      action: suggestion ? 'apply_schedule_suggestion' : 'schedule',
      actionLabel: suggestion
        ? `Use ${formatScheduleTime(suggestion.time)}`
        : 'Review schedule',
      taskId: target ? String(target.id) : null,
      currentTime: target
        ? String(target.schedule_time || '').slice(0, 5) || null
        : currentTime,
      suggestedTime: suggestion?.time || null,
      suggestedPeriod: suggestion
        ? suggestion.period[0].toUpperCase() + suggestion.period.slice(1)
        : null,
      canApply: Boolean(target && suggestion),
      why: suggestion?.why || [
        'The conflicting task has an explicit verified time, so it is not moved automatically.',
      ],
    });
  }

  return findings;
}

function effectiveRealityRiskPoints(answer, template) {
  return riskPointsForRealityAnswer({
    selectedAnswer: answer?.selected_answer,
    note: answer?.note,
    template,
    storedRiskPoints: answer?.risk_points,
  });
}

function customRealityAction(questionKey) {
  if (['morning_routine', 'daytime_access', 'evening_routine'].includes(questionKey)) {
    return 'schedule';
  }
  if (questionKey === 'caregiver_support') return 'family_care';
  if (questionKey === 'travel_access') return 'calendar';
  if (questionKey === 'medicine_access') return 'care_plan';
  return 'reality_check';
}

function practicalAdaptationForAnswer(answer, template, option, tasks, routineProfile = null, taskDecisions = new Map()) {
  const key = String(answer?.question_key || '');
  const action = option?.action || actionForRealityIntent(template?.intent) || customRealityAction(key);

  if (action === 'schedule') {
    const candidates = targetTasksForRealityQuestion(template, tasks);
    const target = candidates.find((task) => String(task.grounding || '') !== 'explicit') || candidates[0] || null;

    if (!target) {
      return {
        action: 'schedule',
        actionLabel: 'Review schedule',
        recommendation: option?.fix || 'Review the related reminder and choose a practical time that stays within the verified instruction.',
        canApply: false,
      };
    }

    const latestDecision = taskDecisions.get(String(target.id)) || null;
    const answerUpdatedAt = answer?.updated_at ? new Date(answer.updated_at) : null;
    const decisionCreatedAt = latestDecision?.created_at
      ? new Date(latestDecision.created_at)
      : null;
    const decisionIsNewer =
      latestDecision &&
      answerUpdatedAt &&
      decisionCreatedAt &&
      !Number.isNaN(answerUpdatedAt.getTime()) &&
      !Number.isNaN(decisionCreatedAt.getTime()) &&
      decisionCreatedAt.getTime() > answerUpdatedAt.getTime();

    if (decisionIsNewer) {
      const currentTime = String(target.schedule_time || '').slice(0, 5) || null;
      const displayCurrent = currentTime ? formatScheduleTime(currentTime) : 'the current time';

      if (latestDecision.event_type === 'suggestion_rejected') {
        return {
          action: '',
          actionLabel: null,
          taskId: String(target.id),
          currentTime,
          suggestedTime: null,
          suggestedPeriod: schedulePeriodKey(
            `${target.display_time || ''} ${target.recurrence_text || ''}`,
          ),
          canApply: false,
          resolvedBySchedule: false,
          recommendation:
            `You chose to keep ${displayCurrent} after this Reality Check answer. SehatMate will not keep offering the older timing suggestion unless you update your Reality Check or schedule again.`,
          why: [
            'Your newer Keep current decision takes priority over the older routine suggestion.',
          ],
        };
      }

      if (
        latestDecision.event_type === 'manual_schedule_edit' ||
        latestDecision.event_type === 'suggestion_accepted'
      ) {
        return {
          action: '',
          actionLabel: null,
          taskId: String(target.id),
          currentTime,
          suggestedTime: null,
          suggestedPeriod: schedulePeriodKey(
            `${target.display_time || ''} ${target.recurrence_text || ''}`,
          ),
          canApply: false,
          resolvedBySchedule: true,
          recommendation:
            `Your current reminder at ${displayCurrent} was chosen after this Reality Check answer, so SehatMate treats it as your newer preference. The older timing note will not override it.`,
          why: [
            'Your newer manual or accepted reminder choice takes priority over the older Reality Check timing note.',
          ],
        };
      }
    }

    const suggestion = suggestionTimeForTask(
      target,
      tasks,
      answer.note,
      routineProfile,
    );
    const explicit = String(target.grounding || '') === 'explicit';

    if (suggestion?.alreadyApplied) {
      const periodLabel =
          suggestion.period[0].toUpperCase() + suggestion.period.slice(1);
      const display = formatScheduleTime(suggestion.time);
      return {
        action: '',
        actionLabel: null,
        taskId: String(target.id),
        currentTime: String(target.schedule_time || '').slice(0, 5) || null,
        suggestedTime: null,
        suggestedPeriod: periodLabel,
        canApply: false,
        resolvedBySchedule: true,
        why: suggestion.why,
        recommendation:
          `Your current reminder at ${display} already matches your saved routine for this ${periodLabel} task. No further timing change is needed.`,
      };
    }

    if (explicit) {
      return {
        action: 'schedule',
        actionLabel: 'Review prescribed time',
        taskId: String(target.id),
        currentTime: String(target.schedule_time || '').slice(0, 5) || null,
        canApply: false,
        recommendation:
          'This reminder time is grounded in an explicit verified instruction. SehatMate will not move it automatically. Keep the prescribed time, or ask the prescribing clinician or pharmacist if the timing itself is not workable.',
      };
    }

    if (suggestion) {
      const periodLabel = suggestion.period[0].toUpperCase() + suggestion.period.slice(1);
      const display = formatScheduleTime(suggestion.time);
      const noteUsed = routineNoteTime(answer.note) === suggestion.time;
      return {
        action: 'apply_schedule_suggestion',
        actionLabel: `Use ${display}`,
        taskId: String(target.id),
        currentTime: String(target.schedule_time || '').slice(0, 5) || null,
        suggestedTime: suggestion.time,
        suggestedPeriod: periodLabel,
        canApply: true,
        why: suggestion.why,
        recommendation: noteUsed
          ? `You mentioned that ${display} may work better. SehatMate can move this reminder to ${display} within the allowed ${periodLabel} period. This changes the reminder only, not the medical instruction.`
          : `A practical starting point is ${display} within the allowed ${periodLabel} period. You can apply it or choose another allowed time. This changes the reminder only, not the medical instruction.`,
      };
    }

    return {
      action: 'schedule',
      actionLabel: 'Choose another time',
      taskId: String(target.id),
      currentTime: String(target.schedule_time || '').slice(0, 5) || null,
      canApply: false,
      recommendation:
        'Keep your Reality Check answer as it is. Open the schedule and choose another allowed reminder time that fits your routine better. The medical instruction itself is not changed.',
    };
  }

  if (key === 'medicine_access') {
    return {
      action: 'care_plan',
      actionLabel: 'Review medicines',
      canApply: false,
      recommendation:
        'Keep this answer as it is. This is an availability warning, not a failed Reality Check. Obtain the prescribed medicine through your usual pharmacy or care provider when possible. Do not substitute or change a medicine without professional confirmation.',
    };
  }

  if (key === 'caregiver_support') {
    return {
      action: 'family_care',
      actionLabel: 'Arrange support',
      canApply: false,
      recommendation:
        'Keep this answer as it is. Add or arrange a caregiver for the times that need help. This remains a practical attention item and does not require you to give a more positive answer.',
    };
  }

  if (key === 'travel_access') {
    return {
      action: 'calendar',
      actionLabel: 'Review visit',
      canApply: false,
      recommendation:
        'Keep this answer as it is. Arrange transport if possible. If the appointment time itself cannot work, confirm a new time with the clinic or laboratory before changing the care plan.',
    };
  }

  return {
    action,
    actionLabel: 'Review plan',
    canApply: false,
    recommendation: option?.fix ||
      'Keep your honest Reality Check answer. Review the related practical setup instead of changing the answer just to improve the score.',
  };
}

/**
 * Read the authoritative Simulation state for one care plan.
 *
 * Extracted verbatim from the GET /api/care-plans/:id/simulation route
 * handler in server.js so the REST route and the Phase B agent
 * get_simulation capability share ONE implementation. This is not a pure
 * read: preserving the original route behavior means it still performs the
 * authoritative persistence steps documented at the top of this file
 * (care_reality_answers.risk_points reconciliation and the care_plans
 * readiness/setup-state update).
 *
 * Returns:
 *   { ok: false, code: 'INVALID_PLAN_ID', message }
 *   { ok: false, code: 'PLAN_NOT_FOUND', message }
 *   { ok: true, data: { readiness, activationAllowed, hardBlockerCount,
 *     metrics, tasks, findings, adaptations, blockers, unanswered,
 *     contextInsights, realityDiagnostics, careGaps } }
 */
export async function readSimulationState({ pool, userId, planId }) {
  if (!idPattern.test(planId)) {
    return {
      ok: false,
      code: 'INVALID_PLAN_ID',
      message: 'Invalid care plan ID.',
    };
  }

  const [plans] = await pool.execute(
    'SELECT id FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
    [planId, userId],
  );
  if (!plans.length) {
    return { ok: false, code: 'PLAN_NOT_FOUND', message: 'Care plan not found.' };
  }

  const [tasks] = await pool.execute(
    `SELECT id, instruction_id, title, task_kind, schedule_date,
      TIME_FORMAT(schedule_time, '%H:%i') AS schedule_time,
      display_time, recurrence_text, grounding, reason, requires_confirmation
     FROM care_schedule_items
     WHERE care_plan_id = ? AND user_id = ?
     ORDER BY schedule_date, schedule_time, id`,
    [planId, userId],
  );

  const [answers] = await pool.execute(
    `SELECT question_key, category, question_text, selected_answer,
      risk_points, note, updated_at
     FROM care_reality_answers
     WHERE care_plan_id = ? AND user_id = ?`,
    [planId, userId],
  );

  const reality = await realityDecisionTemplatesForPlan({
    db: pool,
    planId,
    userId,
    tasks,
    createIfMissing: false,
  });
  const templates = reality.templates;
  const routineProfile = await readRoutineProfile(pool, userId);

  const [decisionRows] = await pool.execute(
    `SELECT event_type, metadata_json, created_at
     FROM routine_learning_events
     WHERE user_id = ?
       AND care_plan_id = ?
       AND event_type IN ('manual_schedule_edit', 'suggestion_accepted', 'suggestion_rejected')
     ORDER BY created_at DESC, id DESC
     LIMIT 200`,
    [userId, planId],
  );
  const taskDecisions = new Map();
  for (const row of decisionRows) {
    const metadata = parseStoredObject(row.metadata_json);
    const taskId = metadata?.taskId == null ? '' : String(metadata.taskId);
    if (!taskId || taskDecisions.has(taskId)) continue;
    taskDecisions.set(taskId, {
      event_type: row.event_type,
      created_at: row.created_at,
    });
  }

  const answerResolution = matchRealityAnswersToTemplates(answers, templates);
  const unanswered = answerResolution.unansweredTemplates.length;
  const evaluatedAnswers = answerResolution.matches.map(({ answer: item, template, matchedBy }) => {
    const option = template?.options.find(
      (candidate) => candidate.label === item.selected_answer,
    );
    const riskPoints = effectiveRealityRiskPoints(item, template);
    const adaptation = practicalAdaptationForAnswer(
      item,
      template,
      option,
      tasks,
      routineProfile,
      taskDecisions,
    );
    return { item, template, option, riskPoints, adaptation, matchedBy };
  });

  // Older builds could leave a stale risk_points value in the database even
  // though the selected answer itself clearly represents a routine mismatch.
  // Reconcile those rows from the current question template so Simulation,
  // Care Gaps and Adapt My Plan all agree on the same answer.
  for (const evaluated of evaluatedAnswers) {
    if (Number(evaluated.item.risk_points || 0) === evaluated.riskPoints) {
      continue;
    }
    await pool.execute(
      `UPDATE care_reality_answers
       SET risk_points = ?, updated_at = CURRENT_TIMESTAMP
       WHERE care_plan_id = ? AND user_id = ? AND question_key = ?`,
      [
        evaluated.riskPoints,
        planId,
        userId,
        evaluated.item.question_key,
      ],
    );
    evaluated.item.risk_points = evaluated.riskPoints;
  }

  const unresolvedRiskAnswers = evaluatedAnswers.filter(
    ({ riskPoints, adaptation }) =>
      riskPoints > 0 &&
      adaptation?.resolvedBySchedule !== true,
  );

  const answerPenalty = unresolvedRiskAnswers.reduce(
    (sum, { riskPoints }) => sum + riskPoints,
    0,
  );
  const unclearTaskIds = new Set(
    tasks
      .filter((item) => Boolean(item.requires_confirmation))
      .map((item) => String(item.id)),
  );
  const atRiskTaskIds = new Set();
  let nonTaskRiskCount = 0;
  for (const evaluated of unresolvedRiskAnswers) {
    const targets = targetTasksForRealityQuestion(evaluated.template, tasks);
    if (targets.length === 0) {
      nonTaskRiskCount += 1;
      continue;
    }
    for (const task of targets) atRiskTaskIds.add(String(task.id));
  }
  const unclear = unclearTaskIds.size;
  const atRisk = atRiskTaskIds.size + nonTaskRiskCount;
  const ready = tasks.filter((item) => {
    const id = String(item.id);
    return !unclearTaskIds.has(id) && !atRiskTaskIds.has(id);
  }).length;
  const readiness = Math.max(
    0,
    Math.min(100, 100 - answerPenalty - (unclear * 8) - (unanswered * 10)),
  );

  let findings = unresolvedRiskAnswers.map(
    ({ item, option, adaptation }) => {
      return {
        key: item.question_key,
        category: item.category,
        question: item.question_text,
        answer:
          item.selected_answer === '__custom__'
            ? item.note
            : item.selected_answer,
        severity: 'at_risk',
        reason: option?.reason ||
          'This saved answer shows that part of the plan may need a practical adjustment.',
        recommendation: adaptation.recommendation ||
          option?.fix ||
          'Keep your honest answer and adjust the practical setup where possible.',
        action: adaptation.action || option?.action || 'care_plan',
        actionLabel: adaptation.actionLabel || null,
        taskId: adaptation.taskId || null,
        currentTime: adaptation.currentTime || null,
        suggestedTime: adaptation.suggestedTime || null,
        suggestedPeriod: adaptation.suggestedPeriod || null,
        canApply: Boolean(adaptation.canApply),
        why: Array.isArray(adaptation.why) ? adaptation.why : [],
      };
    });

  findings.push(...buildScheduleConflictFindings(tasks, routineProfile));

  const careGapRows = await refreshCareGaps({
    db: pool,
    planId,
    userId,
    realityQuestionTemplates,
  });
  const contextInsights = await readCareContextInsightsForPlan(
    pool,
    planId,
  );

  findings = enrichSimulationFindingsWithContext(
    findings,
    contextInsights,
  );

  const adaptations = findings
    .filter(
      (finding) =>
        finding?.canApply === true &&
        finding?.taskId &&
        finding?.suggestedTime &&
        finding?.suggestedPeriod,
    )
    .map((finding) => ({
      ...finding,
      taskId: String(finding.taskId),
    }));
  const gapSummary = careGapSummary(careGapRows);
  const openBlockingGaps = careGapRows.filter(
    (item) =>
      item.lifecycle_status !== 'resolved' &&
      item.severity === 'blocking',
  );

  const blockers = openBlockingGaps.map((gap) => {
    const json = careGapJson(gap);
    return {
      type: 'care_gap',
      gapId: String(gap.id),
      title: gap.title,
      severity: 'blocked',
      reason: gap.reason || gap.summary,
      recommendation: gap.next_step || 'Resolve this required care-plan item before activation.',
      action: json.action_type || 'care_plan',
    };
  });

  if (tasks.length === 0) {
    blockers.unshift({
      type: 'schedule',
      title: 'No scheduled tasks',
      severity: 'blocked',
      reason: 'A care plan needs a schedule before reminders can be activated.',
      recommendation: 'Generate the schedule and confirm the required reminder times.',
      action: 'schedule',
    });
  }

  const activationAllowed = blockers.length === 0;

  const simulationStatus =
    blockers.length > 0 || atRisk > 0 ? 'needs_attention' : 'reality_check';

  // Simulation is allowed to update setup-state plans, but it must never
  // silently deactivate an already active plan (or reopen a completed one).
  // Active-plan edits can change readiness/Care Gaps while the lifecycle
  // status remains active until the user explicitly completes the plan.
  await pool.execute(
    `UPDATE care_plans
     SET readiness_score = ?,
         status = CASE
           WHEN status IN ('active', 'completed') THEN status
           ELSE ?
         END
     WHERE id = ? AND user_id = ?`,
    [
      readiness,
      simulationStatus,
      planId,
      userId,
    ],
  );

  return {
    ok: true,
    data: {
      readiness,
      activationAllowed,
      hardBlockerCount: blockers.length,
      metrics: {
        blocked: blockers.length,
        atRisk,
        ready,
        unclear,
      },
      tasks: tasks.map((item) => {
        const id = String(item.id);
        const status = unclearTaskIds.has(id)
          ? 'unclear'
          : atRiskTaskIds.has(id)
              ? 'at_risk'
              : 'ready';
        return {
          ...item,
          id,
          status,
        };
      }),
      findings,
      adaptations,
      blockers,
      unanswered,
      contextInsights,
      realityDiagnostics: {
        currentQuestionCount: templates.length,
        storedAnswerCount: answers.length,
        matchedAnswerCount: answerResolution.matches.length,
        recoveredByQuestionText: answerResolution.matches.filter(
          (item) => item.matchedBy === 'question_text',
        ).length,
      },
      careGaps: {
        summary: gapSummary,
        items: careGapRows
          .filter((item) => item.lifecycle_status !== 'resolved')
          .map(careGapJson),
      },
    },
  };
}
