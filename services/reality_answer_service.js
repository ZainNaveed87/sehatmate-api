/**
 * Authoritative Reality Check domain: question template resolution and
 * answer persistence.
 *
 * Both the REST routes in server.js and any future agent tool must call
 * the exported functions here instead of duplicating this logic. The
 * functions were moved verbatim from server.js during the Phase A
 * service extraction.
 *
 * Safety layers preserved unchanged:
 *   - reality_check_store.js version-aware question sets (a persisted set
 *     from an older generator safety version is never served)
 *   - stable question keys from reality_check_store.js
 *   - risk points and target tasks from reality_check_decision.js
 *   - only submitted question keys are written; unrelated answers stay
 *     untouched ('__clear__' deletes a single answer)
 *   - question-set version conflict protection during save
 */

import {
  localizedAiFallbackText,
  readPreferredLanguageForUser,
} from '../language_support.js';

import {
  refreshCareGaps,
} from '../care_gap_engine.js';

import {
  getOrCreateRealityQuestionSet,
  readActiveRealityQuestionSet,
  REALITY_CHECK_GENERATOR_VERSION,
} from '../reality_check_store.js';

import {
  dynamicQuestionToDecisionTemplate,
  legacyTemplateToDecisionTemplate,
  riskPointsForRealityAnswer,
  targetTasksForRealityQuestion,
} from '../reality_check_decision.js';

import {
  readRoutineProfile,
  recordRoutineLearningEvent,
} from '../routine_learning.js';

import {
  cleanText,
  idPattern,
  routineNoteTime,
  schedulePeriodKey,
} from './shared_utils.js';

function legacyRealityQuestionText(key, fallback, preferredLanguage) {
  const value = localizedAiFallbackText(key, preferredLanguage);
  return value || fallback;
}

export function realityQuestionTemplates(tasks, preferredLanguage = 'English') {
  const text = tasks.map((item) => `${item.title} ${item.display_time || ''} ${item.recurrence_text || ''} ${item.reason || ''}`).join(' ').toLowerCase();
  const kinds = new Set(tasks.map((item) => item.task_kind));
  const questions = [];
  const add = (key, category, question, options) => {
    if (!questions.some((item) => item.key === key)) {
      questions.push({
        key,
        category,
        question,
        reasonForAsking: localizedAiFallbackText(
          'legacyRealityReason',
          preferredLanguage,
        ),
        options,
      });
    }
  };

  if (/morning|breakfast|before food|after food/.test(text)) {
    add('morning_routine', 'Routine', legacyRealityQuestionText(
      'legacyMorningRoutineQuestion',
      'Which option best matches your usual morning routine?',
      preferredLanguage,
    ), [
      {
        label: 'I can follow the stated morning or meal instruction',
        points: 0,
      },
      {
        label: 'My morning time changes on some days',
        points: 8,
        reason: 'Your morning routine changes on some days, so one fixed reminder may not fit every day.',
        fix: 'Keep this honest answer. SehatMate can suggest a more practical reminder inside the allowed morning period without changing the medical instruction.',
        action: 'schedule',
      },
      {
        label: 'This timing is usually difficult for me',
        points: 15,
        reason: 'The current morning reminder does not fit your usual routine well.',
        fix: 'Keep this honest answer. Review or adjust the reminder within the allowed morning period. If the timing came directly from the verified instruction, ask the prescribing clinician or pharmacist before changing it.',
        action: 'schedule',
      },
    ]);
  }

  if (/afternoon|midday|lunch|3 times|three times/.test(text)) {
    add('daytime_access', 'Routine', legacyRealityQuestionText(
      'legacyDaytimeAccessQuestion',
      'Can you access this medicine or task during the daytime?',
      preferredLanguage,
    ), [
      {
        label: 'Yes, reliably',
        points: 0,
      },
      {
        label: 'Sometimes',
        points: 8,
        reason: 'Daytime access is not reliable every day, so this reminder may need a more practical slot.',
        fix: 'Keep this answer. SehatMate can suggest another allowed daytime reminder without changing the care instruction.',
        action: 'schedule',
      },
      {
        label: 'Usually not',
        points: 15,
        reason: 'You usually cannot access this medicine or task during the current daytime period.',
        fix: 'Keep this answer. Review the allowed schedule for a practical time. If the prescribed timing itself cannot be followed, contact the prescribing clinician or pharmacist instead of changing the medical instruction yourself.',
        action: 'schedule',
      },
    ]);
  }

  if (/evening|night|bedtime|dinner/.test(text)) {
    add('evening_routine', 'Routine', legacyRealityQuestionText(
      'legacyEveningRoutineQuestion',
      'Can you follow the stated evening or bedtime instruction?',
      preferredLanguage,
    ), [
      {
        label: 'Yes, reliably',
        points: 0,
      },
      {
        label: 'My evening routine changes',
        points: 8,
        reason: 'Your evening routine changes, so one fixed reminder may not fit reliably every day.',
        fix: 'Keep this answer. SehatMate can suggest another allowed evening or night reminder without changing the medical instruction.',
        action: 'schedule',
      },
      {
        label: 'This timing is usually difficult',
        points: 15,
        reason: 'The current evening or bedtime reminder is usually difficult for you to follow.',
        fix: 'Keep this answer. Review the reminder inside its allowed period. If the timing came directly from the verified instruction, confirm any change with the prescribing clinician or pharmacist.',
        action: 'schedule',
      },
    ]);
  }

  if (kinds.has('care_task') || /assist|caregiver|dressing/.test(text)) {
    add('caregiver_support', 'Support', legacyRealityQuestionText(
      'legacyCaregiverSupportQuestion',
      'Is the required help available for this care task?',
      preferredLanguage,
    ), [
      {
        label: 'Yes, when needed',
        points: 0,
      },
      {
        label: 'Only sometimes',
        points: 10,
        reason: 'Required help is only available sometimes, so this care task may be harder to complete reliably.',
        fix: 'Keep this answer. Arrange support for the times that need assistance where possible.',
        action: 'family_care',
      },
      {
        label: 'No help is currently available',
        points: 20,
        reason: 'This care task may need support that is not currently available.',
        fix: 'Keep this answer. Arrange caregiver or family support where possible. If the verified instruction requires assistance and support cannot be arranged, contact the care team for guidance.',
        action: 'family_care',
      },
    ]);
  }

  if (kinds.has('follow_up') || kinds.has('lab_test')) {
    add('travel_access', 'Visits and tests', legacyRealityQuestionText(
      'legacyTravelAccessQuestion',
      'Can you reach the clinic or laboratory at the stated time?',
      preferredLanguage,
    ), [
      {
        label: 'Yes, transport is arranged',
        points: 0,
      },
      {
        label: 'Transport still needs arranging',
        points: 10,
        reason: 'Transport has not been arranged yet, so the planned visit or test may be difficult to attend.',
        fix: 'Keep this answer. Arrange transport where possible. If the appointment time itself needs changing, confirm the new time with the clinic or laboratory.',
        action: 'calendar',
      },
      {
        label: 'I cannot reach it at that time',
        points: 20,
        reason: 'You cannot currently reach the clinic or laboratory at the stated time.',
        fix: 'Keep this answer. Contact the clinic or laboratory to confirm a workable appointment time before changing the plan.',
        action: 'calendar',
      },
    ]);
  }

  if (kinds.has('medicine')) {
    add('medicine_access', 'Medicine access', legacyRealityQuestionText(
      'legacyMedicineAccessQuestion',
      'Have you obtained the medicines listed in this verified plan?',
      preferredLanguage,
    ), [
      {
        label: 'Yes, all of them',
        points: 0,
      },
      {
        label: 'Some are still missing',
        points: 12,
        reason: 'One or more medicines in the verified plan are not currently available to you.',
        fix: 'Keep this answer. This is an availability warning, not a failed Reality Check. Obtain the prescribed medicines through your usual pharmacy or care provider when possible. Do not substitute or change a medicine without professional confirmation.',
        action: 'care_plan',
      },
      {
        label: 'None yet',
        points: 20,
        reason: 'The medicines in this verified plan have not been obtained yet.',
        fix: 'Keep this answer. Obtain the prescribed medicines through your usual pharmacy or care provider when possible. Do not start substitutes or change the prescription yourself.',
        action: 'care_plan',
      },
    ]);
  }

  return questions.slice(0, 6);
}

export async function realityDecisionTemplatesForPlan({
  db,
  planId,
  userId,
  tasks = [],
  createIfMissing = false,
  preferredLanguage = null,
}) {
  const resolvedPreferredLanguage =
    preferredLanguage || await readPreferredLanguageForUser(db, userId);
  let activeSet = await readActiveRealityQuestionSet({ db, planId, userId });

  // Never use a persisted question set produced by older safety rules.
  // A GET of the Reality Check may regenerate it; downstream readers that do
  // not create questions will use the deterministic fallback until that occurs.
  if (
    activeSet &&
    (
      activeSet.generatorVersion !== REALITY_CHECK_GENERATOR_VERSION ||
      activeSet.preferredLanguage !== resolvedPreferredLanguage
    )
  ) {
    activeSet = null;
  }

  if (createIfMissing && tasks.length > 0) {
    const [instructions] = await db.execute(
      `SELECT id, category, title, instruction, timing, review_status,
        requires_professional_confirmation
       FROM extracted_instructions
       WHERE care_plan_id = ?
       ORDER BY id`,
      [planId],
    );
    const routineProfile = await readRoutineProfile(db, userId);

    try {
      // Always go through the version-aware store resolver. It cheaply reuses
      // the current set, but regenerates when the generator safety version
      // changes. Assigning null is intentional: an obsolete set must not be
      // served if safe regeneration cannot produce valid questions.
      activeSet = await getOrCreateRealityQuestionSet({
        db,
        planId,
        userId,
        instructions,
        tasks,
        routineProfile,
        knownRealityFacts: [],
        refreshIfContextChanged: false,
        preferredLanguage: resolvedPreferredLanguage,
      });
    } catch (error) {
      activeSet = null;
      console.warn(
        `Reality Check AI generation failed for plan ${planId}; using the deterministic compatibility fallback.`,
        error?.message || error,
      );
    }
  }

  if (activeSet?.questions?.length) {
    return {
      source: 'ai_persisted',
      questionSet: activeSet,
      templates: activeSet.questions.map(dynamicQuestionToDecisionTemplate),
    };
  }

  return {
    source: 'legacy_fallback',
    questionSet: null,
    templates: realityQuestionTemplates(
      tasks,
      resolvedPreferredLanguage,
    ).map((template) =>
      legacyTemplateToDecisionTemplate(template, tasks)),
  };
}

/**
 * Read the Reality Check question set and any saved answers for one plan.
 *
 * Extracted verbatim from the GET /api/care-plans/:id/reality-check route
 * handler in server.js so the REST route and the Phase B agent
 * get_reality_check capability share ONE implementation. This is not a
 * pure read: with createIfMissing it may persist a newly generated
 * question set for the plan, preserving the original route behavior.
 *
 * Returns:
 *   { ok: false, code: 'INVALID_PLAN_ID', message }
 *   { ok: false, code: 'PLAN_NOT_FOUND', message }
 *   { ok: false, code: 'SCHEDULE_NOT_GENERATED', message }
 *   { ok: true, data: { source, questionSetVersion, questions } }
 */
export async function readRealityCheckState({
  pool,
  userId,
  planId,
  preferredLanguage = null,
}) {
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
    return {
      ok: false,
      code: 'PLAN_NOT_FOUND',
      message: 'Care plan not found.',
    };
  }

  const [tasks] = await pool.execute(
    `SELECT id, instruction_id, task_kind, schedule_date,
      TIME_FORMAT(schedule_time, '%H:%i') AS schedule_time,
      title, display_time, recurrence_text, grounding, reason,
      requires_confirmation
     FROM care_schedule_items
     WHERE care_plan_id = ? AND user_id = ?
     ORDER BY id`,
    [planId, userId],
  );
  if (!tasks.length) {
    return {
      ok: false,
      code: 'SCHEDULE_NOT_GENERATED',
      message: 'Generate the schedule before starting the reality check.',
    };
  }

  const reality = await realityDecisionTemplatesForPlan({
    db: pool,
    planId,
    userId,
    tasks,
    createIfMissing: true,
    preferredLanguage,
  });
  const [saved] = await pool.execute(
    `SELECT question_key, selected_answer, note
     FROM care_reality_answers
     WHERE care_plan_id = ? AND user_id = ?`,
    [planId, userId],
  );
  const savedByKey = new Map(saved.map((item) => [item.question_key, item]));

  return {
    ok: true,
    data: {
      source: reality.source,
      questionSetVersion: reality.questionSet?.version || null,
      questions: reality.templates.map((item) => ({
        key: item.key,
        category: item.category,
        question: item.question,
        options: item.options.map((option) => option.label),
        intent: item.intent,
        responseProfile: item.responseProfile,
        targetTaskIds: item.targetTaskIds,
        period: item.period,
        reasonForAsking: item.reasonForAsking,
        source: item.source,
        selectedAnswer:
          savedByKey.get(item.key)?.selected_answer === '__custom__'
            ? ''
            : savedByKey.get(item.key)?.selected_answer || '',
        note: savedByKey.get(item.key)?.note || '',
      })),
    },
  };
}

/**
 * Save one batch of Reality Check answers for a plan.
 *
 * Returns a structured domain result:
 *   { ok: false, code: 'INVALID_REALITY_ANSWERS', message }
 *   { ok: false, code: 'PLAN_NOT_FOUND', message }
 *   { ok: false, code: 'QUESTION_SET_VERSION_CONFLICT', message }
 *   { ok: false, code: 'INVALID_REALITY_ANSWER', message }
 *   { ok: true, message, data: { source, questionSetVersion } }
 */
export async function saveRealityAnswers({
  pool,
  userId,
  planId,
  answers,
  questionSetVersion = 0,
  preferredLanguage = null,
}) {
  const canonicalAnswers = Array.isArray(answers) ? answers : [];
  const requestedQuestionSetVersion = Number(questionSetVersion || 0);
  if (!idPattern.test(planId) || !canonicalAnswers.length) {
    return {
      ok: false,
      code: 'INVALID_REALITY_ANSWERS',
      message: 'Complete the relevant reality-check questions.',
    };
  }

  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    const [plans] = await connection.execute(
      'SELECT id FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
      [planId, userId],
    );
    if (!plans.length) {
      return { ok: false, code: 'PLAN_NOT_FOUND', message: 'Care plan not found.' };
    }

    const [tasks] = await connection.execute(
      `SELECT id, instruction_id, task_kind, schedule_date,
        TIME_FORMAT(schedule_time, '%H:%i') AS schedule_time,
        title, display_time, recurrence_text, grounding, reason,
        requires_confirmation
       FROM care_schedule_items
       WHERE care_plan_id = ? AND user_id = ?
       ORDER BY id`,
      [planId, userId],
    );
    const resolvedPreferredLanguage =
      preferredLanguage || await readPreferredLanguageForUser(connection, userId);
    const reality = await realityDecisionTemplatesForPlan({
      db: connection,
      planId,
      userId,
      tasks,
      createIfMissing: false,
      preferredLanguage: resolvedPreferredLanguage,
    });
    const byKey = new Map(reality.templates.map((item) => [item.key, item]));

    if (
      requestedQuestionSetVersion > 0 &&
      reality.questionSet?.version &&
      requestedQuestionSetVersion !== Number(reality.questionSet.version)
    ) {
      return {
        ok: false,
        code: 'QUESTION_SET_VERSION_CONFLICT',
        message:
          'Your Reality Check was refreshed after this screen was opened. Reopen the Reality Check before saving these answers.',
      };
    }

    await connection.beginTransaction();
    transactionStarted = true;

    for (const answer of canonicalAnswers) {
      const key = cleanText(answer?.key, 80);
      const selected = cleanText(answer?.answer, 240);
      const note = cleanText(answer?.note, 500);
      const template = byKey.get(key);

      if (!template) throw new Error('INVALID_REALITY_ANSWER');

      if (selected === '__clear__') {
        await connection.execute(
          `DELETE FROM care_reality_answers
           WHERE care_plan_id = ? AND user_id = ? AND question_key = ?`,
          [planId, userId, key],
        );
        continue;
      }

      const option = template.options.find((item) => item.label === selected);
      const isCustom = selected === '__custom__' && note.length > 0;
      if (!option && !isCustom) throw new Error('INVALID_REALITY_ANSWER');

      const storedAnswer = isCustom ? '__custom__' : selected;
      const riskPoints = riskPointsForRealityAnswer({
        selectedAnswer: storedAnswer,
        note,
        template,
        storedRiskPoints: 0,
      });

      await connection.execute(
        `INSERT INTO care_reality_answers
          (care_plan_id, user_id, question_key, category, question_text,
           selected_answer, risk_points, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           category = VALUES(category),
           question_text = VALUES(question_text),
           selected_answer = VALUES(selected_answer),
           risk_points = VALUES(risk_points),
           note = VALUES(note),
           updated_at = CURRENT_TIMESTAMP`,
        [
          planId,
          userId,
          key,
          template.category,
          template.question,
          storedAnswer,
          riskPoints,
          note,
        ],
      );

      const targetTasks = targetTasksForRealityQuestion(template, tasks);
      const metadataPeriod = ['morning', 'afternoon', 'evening', 'night'].includes(template.period)
        ? template.period
        : null;
      const inferredPeriod = metadataPeriod || (
        targetTasks.length === 1
          ? schedulePeriodKey(`${targetTasks[0].display_time || ''} ${targetTasks[0].recurrence_text || ''}`)
          : null
      );

      await recordRoutineLearningEvent({
        db: connection,
        userId,
        carePlanId: planId,
        eventType: 'reality_answer',
        period: inferredPeriod,
        scheduleTime: routineNoteTime(note),
        signalValue: isCustom ? note : selected,
        sourceKey: `reality:${planId}:${key}`,
        metadata: {
          questionKey: key,
          intent: template.intent,
          responseProfile: template.responseProfile,
          targetTaskIds: template.targetTaskIds,
          period: template.period,
          source: template.source,
          custom: isCustom,
        },
      });
    }

    await connection.commit();
    transactionStarted = false;

    await refreshCareGaps({
      db: pool,
      planId,
      userId,
      realityQuestionTemplates,
    });

    return {
      ok: true,
      message: 'Reality-check answers saved.',
      data: {
        source: reality.source,
        questionSetVersion: reality.questionSet?.version || null,
      },
    };
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    if (error?.message === 'INVALID_REALITY_ANSWER') {
      return {
        ok: false,
        code: 'INVALID_REALITY_ANSWER',
        message: 'Choose an option or write your own answer for every question.',
      };
    }
    throw error;
  } finally {
    connection.release();
  }
}
