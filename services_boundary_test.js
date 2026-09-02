/**
 * Phase A service boundary tests (no HTTP, no real database).
 *
 * These tests exercise the extracted backend services directly with a fake
 * mysql2 pool, so both the REST layer and any future agent tool are covered
 * by the same authoritative implementations.
 *
 * Focus areas required by the Phase A plan:
 *   - user isolation (every ownership query binds the authenticated userId)
 *   - task outcome idempotency and optimistic conflict behavior
 *   - exact medical timing protection (schedule_time_guard stays authoritative)
 *   - Reality Check answer isolation (unrelated answers stay untouched)
 *   - Care Gap user ownership and auto-managed gap protection
 */
import assert from 'node:assert/strict';

import {
  applyTaskOutcome,
} from './services/task_outcome_service.js';

import {
  saveRealityAnswers,
} from './services/reality_answer_service.js';

import {
  confirmScheduleItem,
} from './services/schedule_confirm_service.js';

import {
  listCarePlans,
  readCarePlanDetail,
  readPlanLifecycleEvents,
} from './services/plan_query_service.js';

import {
  listCareGaps,
  readCareGapDetail,
  updateCareGapLifecycle,
} from './services/care_gap_service.js';

import {
  REALITY_CHECK_GENERATOR_VERSION,
} from './reality_check_store.js';

const OK_PACKET = { affectedRows: 1, insertId: 0 };

/**
 * Minimal mysql2 pool/connection double.
 *
 * `respond(sql, params)` may return a mysql2 result tuple ([rows]) or
 * undefined. Undefined means "use the default": SELECT-like statements get
 * an empty row list, everything else gets a success packet. Every executed
 * statement is recorded in pool.calls for isolation assertions.
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
        beginTransaction: async () => {
          calls.push({ sql: 'BEGIN', params: [] });
        },
        commit: async () => {
          calls.push({ sql: 'COMMIT', params: [] });
        },
        rollback: async () => {
          calls.push({ sql: 'ROLLBACK', params: [] });
        },
        release: () => {},
      };
    },
    calls,
  };
  return pool;
}

const statementsMatching = (pool, pattern) =>
  pool.calls.filter((call) => pattern.test(call.sql));

let passedCount = 0;

async function test(name, fn) {
  await fn();
  passedCount += 1;
  console.log(`ok - ${name}`);
}

const USER_ID = '42';
const OTHER_USER_ID = '99';

const occurrenceRow = {
  id: 77,
  care_plan_id: 1,
  schedule_item_id: 5,
  occurrence_date: '2026-09-03',
  scheduled_time: '08:00',
  status: 'pending',
  completed_at: null,
  completed_time: null,
  outcome_source: 'system',
  note: '',
  title: 'Metformin 500mg',
  task_kind: 'medicine',
  display_time: 'Morning',
  recurrence_text: 'once daily',
  grounding: 'suggested',
};

function occurrencePool(row, { replayOperation = false } = {}) {
  return createFakePool((sql) => {
    if (/FROM care_task_occurrences o JOIN care_schedule_items s/.test(sql)) {
      return [[row]];
    }
    if (/FROM care_task_outcome_operations/.test(sql)) {
      return replayOperation ? [[{ id: 900 }]] : [[]];
    }
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// task_outcome_service.applyTaskOutcome
// ---------------------------------------------------------------------------

await test('applyTaskOutcome: occurrence of another user is not found (user isolation)', async () => {
  const pool = createFakePool(() => undefined);
  const result = await applyTaskOutcome({
    pool,
    userId: OTHER_USER_ID,
    occurrenceId: '77',
    outcome: 'completed',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TASK_OCCURRENCE_NOT_FOUND');

  const ownershipRead = statementsMatching(pool, /FOR UPDATE/);
  assert.equal(ownershipRead.length, 1);
  assert.deepEqual(ownershipRead[0].params, ['77', OTHER_USER_ID]);
  assert.ok(statementsMatching(pool, /^ROLLBACK$/).length >= 1);
  assert.equal(statementsMatching(pool, /UPDATE care_task_occurrences/).length, 0);
});

await test('applyTaskOutcome: invalid outcome is rejected before any database access', async () => {
  const pool = createFakePool(() => undefined);
  const result = await applyTaskOutcome({
    pool,
    userId: USER_ID,
    occurrenceId: '77',
    outcome: 'maybe',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_TASK_OUTCOME');
  assert.equal(pool.calls.length, 0);
});

await test('applyTaskOutcome: invalid baseStatus is rejected before any database access', async () => {
  const pool = createFakePool(() => undefined);
  const result = await applyTaskOutcome({
    pool,
    userId: USER_ID,
    occurrenceId: '77',
    outcome: 'completed',
    baseStatus: 'unknown',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_TASK_BASE_STATUS');
  assert.equal(pool.calls.length, 0);
});

await test('applyTaskOutcome: stale baseStatus conflicts and writes nothing (optimistic concurrency)', async () => {
  const row = { ...occurrenceRow, status: 'completed' };
  const pool = occurrencePool(row);
  const result = await applyTaskOutcome({
    pool,
    userId: USER_ID,
    occurrenceId: '77',
    outcome: 'skipped',
    baseStatus: 'pending',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TASK_BASE_STATUS_CONFLICT');
  assert.equal(result.data.conflict, true);
  assert.equal(result.data.occurrence.id, '77');

  assert.ok(statementsMatching(pool, /^ROLLBACK$/).length >= 1);
  assert.equal(statementsMatching(pool, /UPDATE care_task_occurrences/).length, 0);
  assert.equal(statementsMatching(pool, /INSERT IGNORE INTO care_task_outcome_operations/).length, 0);
});

await test('applyTaskOutcome: a past occurrence can never return to pending', async () => {
  const row = { ...occurrenceRow, occurrence_date: '2026-01-01', status: 'completed' };
  const pool = occurrencePool(row);
  const result = await applyTaskOutcome({
    pool,
    userId: USER_ID,
    occurrenceId: '77',
    outcome: 'pending',
    today: '2026-09-03',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PAST_OCCURRENCE_PENDING_CONFLICT');
  assert.equal(result.data.conflict, true);
  assert.ok(statementsMatching(pool, /^ROLLBACK$/).length >= 1);
  assert.equal(statementsMatching(pool, /UPDATE care_task_occurrences/).length, 0);
});

await test('applyTaskOutcome: success records the outcome and the operation key', async () => {
  const pendingRow = { ...occurrenceRow, status: 'pending' };
  const completedRow = { ...pendingRow, status: 'completed', outcome_source: 'user' };
  const pool = createFakePool((sql) => {
    if (/FROM care_task_occurrences o JOIN care_schedule_items s/.test(sql)) {
      return [[/FOR UPDATE/.test(sql) ? pendingRow : completedRow]];
    }
    if (/FROM care_task_outcome_operations/.test(sql)) {
      return [[]];
    }
    return undefined;
  });

  const result = await applyTaskOutcome({
    pool,
    userId: USER_ID,
    occurrenceId: '77',
    outcome: 'completed',
    operationKey: 'op-1',
  });

  assert.equal(result.ok, true);
  assert.equal(result.message, 'Task marked completed.');
  assert.equal(result.data.occurrence.status, 'completed');

  const update = statementsMatching(pool, /UPDATE care_task_occurrences SET status = \?/);
  assert.equal(update.length, 1);
  assert.deepEqual(update[0].params, ['completed', 1, 1, null, '77', USER_ID]);

  const operationInsert = statementsMatching(pool, /INSERT IGNORE INTO care_task_outcome_operations/);
  assert.equal(operationInsert.length, 1);
  assert.deepEqual(operationInsert[0].params, [USER_ID, '77', 'op-1', 'completed']);

  assert.ok(statementsMatching(pool, /^COMMIT$/).length === 1);
  assert.equal(statementsMatching(pool, /^ROLLBACK$/).length, 0);
});

await test('applyTaskOutcome: replaying the same operationKey writes nothing (idempotency)', async () => {
  const pool = occurrencePool(occurrenceRow, { replayOperation: true });
  const result = await applyTaskOutcome({
    pool,
    userId: USER_ID,
    occurrenceId: '77',
    outcome: 'completed',
    operationKey: 'op-1',
  });

  assert.equal(result.ok, true);
  assert.equal(result.message, 'Task outcome was already synchronized.');
  assert.equal(result.data.idempotentReplay, true);
  assert.equal(result.data.occurrence.id, '77');

  assert.equal(statementsMatching(pool, /UPDATE care_task_occurrences/).length, 0);
  assert.equal(statementsMatching(pool, /INSERT IGNORE INTO care_task_outcome_operations/).length, 0);
  assert.equal(statementsMatching(pool, /DELETE FROM routine_learning_events/).length, 0);
  assert.ok(statementsMatching(pool, /^COMMIT$/).length === 1);
  assert.equal(statementsMatching(pool, /^ROLLBACK$/).length, 0);
});

// ---------------------------------------------------------------------------
// reality_answer_service.saveRealityAnswers
// ---------------------------------------------------------------------------

const medicineTask = {
  id: 5,
  instruction_id: 9,
  task_kind: 'medicine',
  schedule_date: '2026-09-03',
  schedule_time: '08:00',
  title: 'Metformin 500mg',
  display_time: 'Morning',
  recurrence_text: 'once daily',
  grounding: 'suggested',
  reason: '',
  requires_confirmation: 0,
};

function realityPool({
  planRows = [{ id: 1 }],
  tasks = [medicineTask],
  setRows = [],
  questionRows = [],
} = {}) {
  return createFakePool((sql) => {
    if (/FROM care_plans WHERE id = \? AND user_id = \?/.test(sql)) {
      return [planRows];
    }
    if (/FROM care_schedule_items WHERE care_plan_id = \? AND user_id = \?/.test(sql)) {
      return [[...tasks]];
    }
    if (/FROM patient_profiles/.test(sql)) {
      return [[{ preferred_language: 'English' }]];
    }
    if (/FROM care_reality_question_sets/.test(sql)) {
      return [[...setRows]];
    }
    if (/FROM care_reality_questions WHERE question_set_id/.test(sql)) {
      return [[...questionRows]];
    }
    return undefined;
  });
}

await test('saveRealityAnswers: plan of another user is not found (user isolation)', async () => {
  const pool = realityPool({ planRows: [] });
  const result = await saveRealityAnswers({
    pool,
    userId: OTHER_USER_ID,
    planId: '1',
    answers: [{ key: 'morning_routine', answer: 'Yes, reliably' }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PLAN_NOT_FOUND');

  const ownershipRead = statementsMatching(pool, /FROM care_plans WHERE id = \? AND user_id = \?/);
  assert.equal(ownershipRead.length, 1);
  assert.deepEqual(ownershipRead[0].params, ['1', OTHER_USER_ID]);
  assert.equal(statementsMatching(pool, /INSERT INTO care_reality_answers/).length, 0);
});

await test('saveRealityAnswers: empty answers are rejected before any database access', async () => {
  const pool = realityPool();
  const result = await saveRealityAnswers({
    pool,
    userId: USER_ID,
    planId: '1',
    answers: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_REALITY_ANSWERS');
  assert.equal(pool.calls.length, 0);
});

await test('saveRealityAnswers: only submitted keys are written, other answers stay untouched', async () => {
  const pool = realityPool();
  const result = await saveRealityAnswers({
    pool,
    userId: USER_ID,
    planId: '1',
    answers: [
      { key: 'morning_routine', answer: 'I can follow the stated morning or meal instruction' },
      { key: 'medicine_access', answer: '__clear__' },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.message, 'Reality-check answers saved.');
  assert.equal(result.data.source, 'legacy_fallback');
  assert.equal(result.data.questionSetVersion, null);

  const inserts = statementsMatching(pool, /INSERT INTO care_reality_answers/);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].params[0], '1');
  assert.equal(inserts[0].params[1], USER_ID);
  assert.equal(inserts[0].params[2], 'morning_routine');

  const deletes = statementsMatching(pool, /DELETE FROM care_reality_answers/);
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].params, ['1', USER_ID, 'medicine_access']);

  const writtenKeys = new Set([
    ...inserts.map((call) => call.params[2]),
    ...deletes.map((call) => call.params[2]),
  ]);
  assert.deepEqual([...writtenKeys].sort(), ['medicine_access', 'morning_routine']);

  assert.ok(statementsMatching(pool, /^COMMIT$/).length === 1);
  assert.equal(statementsMatching(pool, /^ROLLBACK$/).length, 0);
});

await test('saveRealityAnswers: an unknown question key fails and rolls the transaction back', async () => {
  const pool = realityPool();
  const result = await saveRealityAnswers({
    pool,
    userId: USER_ID,
    planId: '1',
    answers: [{ key: 'not_a_real_question', answer: 'Yes, reliably' }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_REALITY_ANSWER');
  assert.ok(statementsMatching(pool, /^ROLLBACK$/).length >= 1);
  assert.equal(statementsMatching(pool, /INSERT INTO care_reality_answers/).length, 0);
});

await test('saveRealityAnswers: a stale question-set version is rejected before any write', async () => {
  const setRows = [{
    id: 10,
    care_plan_id: 1,
    user_id: Number(USER_ID),
    context_hash: 'abc',
    version: 3,
    generator_version: REALITY_CHECK_GENERATOR_VERSION,
    preferred_language: 'English',
    status: 'active',
    question_count: 1,
    created_at: null,
    updated_at: null,
  }];
  const questionRows = [{
    id: 101,
    question_set_id: 10,
    question_key: 'morning_routine',
    intent: 'instruction_feasibility',
    category: 'Routine',
    question_text: 'Which option best matches your usual morning routine?',
    response_profile: 'feasibility',
    target_task_ids_json: '[]',
    period: 'morning',
    reason_for_asking: 'Why we ask',
    source: 'ai_generated',
    status: 'active',
  }];
  const pool = realityPool({ setRows, questionRows });

  const result = await saveRealityAnswers({
    pool,
    userId: USER_ID,
    planId: '1',
    questionSetVersion: 2,
    answers: [{ key: 'morning_routine', answer: '__clear__' }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'QUESTION_SET_VERSION_CONFLICT');
  assert.equal(statementsMatching(pool, /^BEGIN$/).length, 0);
  assert.equal(statementsMatching(pool, /INSERT INTO care_reality_answers/).length, 0);
  assert.equal(statementsMatching(pool, /DELETE FROM care_reality_answers/).length, 0);
});

await test('saveRealityAnswers: the current question-set version is accepted', async () => {
  const setRows = [{
    id: 10,
    care_plan_id: 1,
    user_id: Number(USER_ID),
    context_hash: 'abc',
    version: 3,
    generator_version: REALITY_CHECK_GENERATOR_VERSION,
    preferred_language: 'English',
    status: 'active',
    question_count: 1,
    created_at: null,
    updated_at: null,
  }];
  const questionRows = [{
    id: 101,
    question_set_id: 10,
    question_key: 'morning_routine',
    intent: 'instruction_feasibility',
    category: 'Routine',
    question_text: 'Which option best matches your usual morning routine?',
    response_profile: 'feasibility',
    target_task_ids_json: '[]',
    period: 'morning',
    reason_for_asking: 'Why we ask',
    source: 'ai_generated',
    status: 'active',
  }];
  const pool = realityPool({ setRows, questionRows });

  const result = await saveRealityAnswers({
    pool,
    userId: USER_ID,
    planId: '1',
    questionSetVersion: 3,
    answers: [{ key: 'morning_routine', answer: '__clear__' }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.source, 'ai_persisted');
  assert.equal(result.data.questionSetVersion, 3);
  const deletes = statementsMatching(pool, /DELETE FROM care_reality_answers/);
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].params[2], 'morning_routine');
});

// ---------------------------------------------------------------------------
// schedule_confirm_service.confirmScheduleItem
// ---------------------------------------------------------------------------

const unlockedItemRow = {
  id: 5,
  care_plan_id: 1,
  instruction_id: 9,
  schedule_date: '2026-09-03',
  schedule_time: '08:00',
  display_time: 'Morning',
  grounding: 'suggested',
  title: 'Metformin 500mg',
  instruction: 'Take one tablet',
  timing: '',
  original_instruction: null,
  original_timing: null,
};

function schedulePool(itemRow, { siblings = [], learningEnabled = true } = {}) {
  return createFakePool((sql) => {
    if (/FROM care_schedule_items s LEFT JOIN extracted_instructions/.test(sql)) {
      return [[itemRow]];
    }
    if (/FROM care_schedule_items WHERE care_plan_id = \?/.test(sql)) {
      return [[...siblings]];
    }
    if (/FROM user_routine_profiles/.test(sql)) {
      return [[{ learning_enabled: learningEnabled ? 1 : 0 }]];
    }
    return undefined;
  });
}

await test('confirmScheduleItem: an invalid item ID is rejected before any database access', async () => {
  const pool = schedulePool(unlockedItemRow);
  const result = await confirmScheduleItem({
    pool,
    userId: USER_ID,
    itemId: 'abc',
    scheduleTime: '09:00',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_SCHEDULE_ITEM_ID');
  assert.equal(pool.calls.length, 0);
});

await test('confirmScheduleItem: a time that is not an exact clock time is rejected', async () => {
  const pool = schedulePool(unlockedItemRow);
  const result = await confirmScheduleItem({
    pool,
    userId: USER_ID,
    itemId: '5',
    scheduleTime: 'whenever',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_SCHEDULE_TIME');
  assert.equal(pool.calls.length, 0);
});

await test('confirmScheduleItem: schedule item of another user is not found (user isolation)', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM care_schedule_items s LEFT JOIN extracted_instructions/.test(sql)) {
      return [[]];
    }
    return undefined;
  });

  const result = await confirmScheduleItem({
    pool,
    userId: OTHER_USER_ID,
    itemId: '5',
    scheduleTime: '09:00',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'SCHEDULE_ITEM_NOT_FOUND');
  const ownershipRead = statementsMatching(pool, /FROM care_schedule_items s LEFT JOIN extracted_instructions/);
  assert.deepEqual(ownershipRead[0].params, ['5', OTHER_USER_ID]);
  assert.equal(statementsMatching(pool, /UPDATE care_schedule_items/).length, 0);
});

await test('confirmScheduleItem: a verified exact medical time cannot be moved (schedule_time_guard lock)', async () => {
  const lockedItemRow = {
    ...unlockedItemRow,
    grounding: 'explicit',
    schedule_time: '08:00',
    timing: '08:00',
    instruction: 'Take one tablet with breakfast',
  };
  const pool = schedulePool(lockedItemRow);

  const result = await confirmScheduleItem({
    pool,
    userId: USER_ID,
    itemId: '5',
    displayTime: 'Morning',
    scheduleTime: '09:30',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'EXACT_TIME_LOCKED');
  assert.equal(result.data.exactTimeLocked, true);
  assert.equal(result.data.medicalTimingConflict, true);
  assert.deepEqual(result.data.allowedTimes, ['08:00']);
  assert.equal(result.data.selectedTime, '09:30');
  assert.match(result.message, /fixed by the verified instruction/);

  assert.equal(statementsMatching(pool, /UPDATE care_schedule_items/).length, 0);
  assert.equal(statementsMatching(pool, /UPDATE care_task_occurrences/).length, 0);
});

await test('confirmScheduleItem: a conflicting care period is rejected with canonical conflict data', async () => {
  const dinnerItemRow = {
    ...unlockedItemRow,
    grounding: 'suggested',
    schedule_time: '21:00',
    display_time: 'Evening',
    instruction: 'Take one tablet with dinner',
    timing: 'with dinner',
  };
  const pool = schedulePool(dinnerItemRow);

  const result = await confirmScheduleItem({
    pool,
    userId: USER_ID,
    itemId: '5',
    displayTime: 'Night',
    scheduleTime: '22:00',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'MEDICAL_TIMING_CONFLICT');
  assert.equal(result.data.medicalTimingConflict, true);
  assert.equal(result.data.requiredPeriod, 'evening');
  assert.equal(result.data.selectedPeriod, 'night');
  assert.equal(result.data.selectedTime, '22:00');
  assert.equal(result.data.originalInstruction, 'Take one tablet with dinner');
  assert.match(result.message, /Medical timing conflict/);

  assert.equal(statementsMatching(pool, /UPDATE care_schedule_items/).length, 0);
  assert.equal(statementsMatching(pool, /UPDATE care_task_occurrences/).length, 0);
});

await test('confirmScheduleItem: a duplicate exact reminder time is rejected', async () => {
  const pool = schedulePool(unlockedItemRow, {
    siblings: [{ id: 6, schedule_time: '09:00', display_time: 'Morning' }],
  });

  const result = await confirmScheduleItem({
    pool,
    userId: USER_ID,
    itemId: '5',
    displayTime: 'Morning',
    scheduleTime: '09:00',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'DUPLICATE_REMINDER_TIME');
  assert.equal(statementsMatching(pool, /UPDATE care_schedule_items/).length, 0);
});

await test('confirmScheduleItem: a valid confirmation updates timing, occurrences, and learning', async () => {
  const pool = schedulePool(unlockedItemRow, { siblings: [] });

  const result = await confirmScheduleItem({
    pool,
    userId: USER_ID,
    itemId: '5',
    displayTime: 'Morning',
    scheduleTime: '09:00',
    learningSource: 'ai_suggestion_accept',
  });

  assert.equal(result.ok, true);
  assert.equal(result.message, 'Exact reminder time confirmed.');
  assert.deepEqual(result.data, { scheduleTime: '09:00' });

  const itemUpdate = statementsMatching(pool, /UPDATE care_schedule_items SET schedule_time = \?/);
  assert.equal(itemUpdate.length, 1);
  assert.deepEqual(itemUpdate[0].params, ['09:00', 'Morning', '5', USER_ID]);

  const occurrenceUpdate = statementsMatching(pool, /UPDATE care_task_occurrences SET scheduled_at = /);
  assert.equal(occurrenceUpdate.length, 1);
  assert.deepEqual(occurrenceUpdate[0].params, ['09:00', '5', USER_ID]);

  const learningInsert = statementsMatching(pool, /INSERT INTO routine_learning_events/);
  assert.equal(learningInsert.length, 1);
  assert.equal(learningInsert[0].params[0], USER_ID);
  assert.equal(learningInsert[0].params[2], 'suggestion_accepted');
  assert.equal(learningInsert[0].params[4], '09:00');
});

// ---------------------------------------------------------------------------
// plan_query_service
// ---------------------------------------------------------------------------

const planRow = {
  id: 3,
  title: 'Recovery plan',
  status: 'active',
  start_date: '2026-08-01',
  readiness_score: 80,
  understanding_score: 70,
  activated_at: '2026-08-02 10:00:00',
  completed_at: null,
  completion_reason: null,
  completed_by: null,
  duration_mode: 'prescription',
  suggested_end_date: null,
  planned_end_date: '2026-09-15',
  created_at: '2026-08-01 09:00:00',
  updated_at: '2026-09-01 09:00:00',
  document_count: 1,
  task_count: 2,
  open_gap_count: 1,
  setup_step: null,
};

function planListPool(rows) {
  return createFakePool((sql) => {
    if (/FROM care_plans WHERE care_plans\.user_id = \?/.test(sql)) {
      return [[...rows]];
    }
    return undefined;
  });
}

await test('listCarePlans: returns only plans of the authenticated user', async () => {
  const pool = planListPool([planRow]);
  const result = await listCarePlans({ pool, userId: USER_ID });

  assert.equal(result.ok, true);
  assert.equal(result.data.plans.length, 1);
  assert.equal(result.data.plans[0].id, '3');
  assert.equal(result.data.plans[0].title, 'Recovery plan');
  assert.equal(result.data.plans[0].setupStep, 'complete');
  assert.equal(result.data.plans[0].readinessScore, 80);

  const planRead = statementsMatching(pool, /FROM care_plans WHERE care_plans\.user_id = \?/);
  assert.equal(planRead.length, 1);
  assert.deepEqual(planRead[0].params, [USER_ID]);
});

await test('readCarePlanDetail: an invalid plan ID is rejected before any database access', async () => {
  const pool = planListPool([]);
  const result = await readCarePlanDetail({
    pool,
    userId: USER_ID,
    planId: 'abc',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_PLAN_ID');
  assert.equal(pool.calls.length, 0);
});

await test('readCarePlanDetail: plan of another user is not found (user isolation)', async () => {
  const pool = createFakePool((sql) => {
    if (/SELECT \* FROM care_plans WHERE id = \? AND user_id = \?/.test(sql)) {
      return [[]];
    }
    return undefined;
  });

  const result = await readCarePlanDetail({
    pool,
    userId: OTHER_USER_ID,
    planId: '3',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PLAN_NOT_FOUND');
  const ownershipRead = statementsMatching(pool, /SELECT \* FROM care_plans WHERE id = \? AND user_id = \?/);
  assert.equal(ownershipRead.length, 1);
  assert.deepEqual(ownershipRead[0].params, ['3', OTHER_USER_ID]);
});

await test('readCarePlanDetail: returns the full detail payload for the owning user', async () => {
  const pool = createFakePool((sql) => {
    if (/SELECT \* FROM care_plans WHERE id = \? AND user_id = \?/.test(sql)) {
      return [[planRow]];
    }
    return undefined;
  });

  const result = await readCarePlanDetail({
    pool,
    userId: USER_ID,
    planId: '3',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.plan.id, '3');
  assert.equal(result.data.plan.setupStep, 'complete');
  assert.deepEqual(result.data.tasks, []);
  assert.deepEqual(result.data.gaps, []);
  assert.equal(result.data.gapSummary.total, 0);
  assert.equal(result.data.verifiedInstructions.length, 0);
});

await test('readPlanLifecycleEvents: events are mapped and scoped to the owning user', async () => {
  const eventRow = {
    id: 12,
    event_type: 'auto_completed',
    reason: 'The selected care-plan end date was reached.',
    metadata_json: '{"plannedEndDate":"2026-09-15"}',
    created_at: '2026-09-15 00:30:00',
  };
  const pool = createFakePool((sql) => {
    if (/FROM care_plans WHERE id = \? AND user_id = \?/.test(sql)) {
      return [[{ id: 3 }]];
    }
    if (/FROM care_plan_lifecycle_events/.test(sql)) {
      return [[eventRow]];
    }
    return undefined;
  });

  const result = await readPlanLifecycleEvents({
    pool,
    userId: USER_ID,
    planId: '3',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.events.length, 1);
  assert.equal(result.data.events[0].id, '12');
  assert.equal(result.data.events[0].eventType, 'auto_completed');
  assert.deepEqual(result.data.events[0].metadata, { plannedEndDate: '2026-09-15' });

  const ownershipRead = statementsMatching(pool, /FROM care_plans WHERE id = \? AND user_id = \?/);
  assert.deepEqual(ownershipRead[0].params, ['3', USER_ID]);
});

// ---------------------------------------------------------------------------
// care_gap_service
// ---------------------------------------------------------------------------

const autoManagedGapRow = {
  id: 44,
  care_plan_id: 1,
  task_id: null,
  category: 'Verification',
  gap_type: 'verification',
  title: 'Metformin needs verification',
  status: 'unclear',
  severity: 'blocking',
  lifecycle_status: 'open',
  when_text: null,
  summary: 'This instruction is not yet verified.',
  instruction_snapshot: 'Take one tablet',
  patient_reality: null,
  reason: 'The uploaded source still contains an unresolved ambiguity.',
  next_step: 'Review the original document.',
  resolution_note: null,
  resolved_at: null,
  source_key: 'instruction:9:verification',
  source_kind: 'instruction',
  source_id: '9',
  due_at: null,
  auto_managed: 1,
  created_at: '2026-08-20 09:00:00',
  updated_at: '2026-08-20 09:00:00',
};

function gapPool(gapRow) {
  return createFakePool((sql) => {
    if (/FROM care_gaps WHERE id = \? AND care_plan_id IN \(SELECT id FROM care_plans WHERE user_id = \?\)/.test(sql)) {
      return gapRow ? [[gapRow]] : [[]];
    }
    if (/FROM care_gaps g JOIN care_plans p/.test(sql)) {
      return gapRow ? [[gapRow]] : [[]];
    }
    if (/FROM care_plans WHERE id = \? AND user_id = \?/.test(sql)) {
      return [[{ id: 1 }]];
    }
    return undefined;
  });
}

await test('readCareGapDetail: a gap of another user is not found (user ownership)', async () => {
  const pool = gapPool(null);
  const result = await readCareGapDetail({
    pool,
    userId: OTHER_USER_ID,
    gapId: '44',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'GAP_NOT_FOUND');

  const ownershipRead = statementsMatching(
    pool,
    /FROM care_gaps WHERE id = \? AND care_plan_id IN \(SELECT id FROM care_plans WHERE user_id = \?\)/,
  );
  assert.equal(ownershipRead.length, 1);
  assert.deepEqual(ownershipRead[0].params, ['44', OTHER_USER_ID]);
});

await test('readCareGapDetail: returns the gap and its doctor questions for the owner', async () => {
  const pool = gapPool(autoManagedGapRow);
  const result = await readCareGapDetail({
    pool,
    userId: USER_ID,
    gapId: '44',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.gap.id, '44');
  assert.equal(result.data.gap.care_plan_id, '1');
  assert.equal(result.data.gap.auto_recheck, true);
  assert.equal(result.data.gap.can_mark_resolved, false);
  assert.deepEqual(result.data.doctorQuestions, []);
});

await test('listCareGaps: invalid plan ID is rejected before any database access', async () => {
  const pool = gapPool(autoManagedGapRow);
  const result = await listCareGaps({
    pool,
    userId: USER_ID,
    planId: 'abc',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_PLAN_ID');
  assert.equal(pool.calls.length, 0);
});

await test('listCareGaps: plan of another user is not found (user isolation)', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM care_plans WHERE id = \? AND user_id = \?/.test(sql)) {
      return [[]];
    }
    return undefined;
  });

  const result = await listCareGaps({
    pool,
    userId: OTHER_USER_ID,
    planId: '1',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PLAN_NOT_FOUND');
  const ownershipRead = statementsMatching(pool, /FROM care_plans WHERE id = \? AND user_id = \?/);
  assert.deepEqual(ownershipRead[0].params, ['1', OTHER_USER_ID]);
});

await test('updateCareGapLifecycle: an invalid status is rejected before any database access', async () => {
  const pool = gapPool(autoManagedGapRow);
  const result = await updateCareGapLifecycle({
    pool,
    userId: USER_ID,
    gapId: '44',
    lifecycleStatus: 'done',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_CARE_GAP_STATUS');
  assert.equal(pool.calls.length, 0);
});

await test('updateCareGapLifecycle: an auto-managed gap cannot be resolved manually', async () => {
  const pool = gapPool(autoManagedGapRow);
  const result = await updateCareGapLifecycle({
    pool,
    userId: USER_ID,
    gapId: '44',
    lifecycleStatus: 'resolved',
    resolutionNote: 'I handled it.',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTO_MANAGED_GAP_NOT_RESOLVED');
  assert.equal(result.data.gap.id, '44');
  assert.equal(result.data.nextStep, 'Review the original document.');

  // The user-facing manual resolve statement must never run for auto-managed
  // gaps. (The engine's own auto-resolve statements have a different shape.)
  const manualResolve = statementsMatching(
    pool,
    /SET lifecycle_status = 'resolved', status = 'resolved', resolution_note = \?/,
  );
  assert.equal(manualResolve.length, 0);
});

await test('updateCareGapLifecycle: progress on a user-managed gap is saved', async () => {
  const userManagedGap = {
    ...autoManagedGapRow,
    id: 45,
    auto_managed: 0,
    severity: 'attention',
    lifecycle_status: 'open',
    status: 'at_risk',
  };
  const pool = gapPool(userManagedGap);

  const result = await updateCareGapLifecycle({
    pool,
    userId: USER_ID,
    gapId: '45',
    lifecycleStatus: 'in_progress',
  });

  assert.equal(result.ok, true);
  assert.equal(result.message, 'Care gap updated.');
  assert.equal(result.data.gap.id, '45');

  const progressUpdate = statementsMatching(pool, /SET lifecycle_status = 'in_progress'/);
  assert.equal(progressUpdate.length, 1);
  assert.deepEqual(progressUpdate[0].params, [null, '45']);
});

console.log(`Services boundary test passed (${passedCount} tests).`);
