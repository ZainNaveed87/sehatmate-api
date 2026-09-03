/**
 * Phase D Agent tests: safe drafts plus explicit confirmed actions.
 */
import assert from 'node:assert/strict';

import { handleAgentMessage } from './agent/agent_core.js';
import { createAgentProvider } from './agent/agent_provider.js';
import {
  defineAgentCapability,
  executeConfirmedAgentCapability,
  executeAgentCapability,
  validateAgentCapabilityInput,
} from './agent/agent_capability_registry.js';
import { validateAgentPlan, buildAgentPlannerPrompts } from './agent/agent_planner.js';
import {
  reviewAgentCapabilityCall,
  reviewAgentConfirmedCapabilityCall,
} from './agent/agent_safety_gateway.js';
import {
  emptyAgentSessionState,
  sanitizeAgentSessionState,
  serializeAgentSessionState,
} from './agent/agent_session_state.js';

process.env.AGENT_ENABLED = 'true';

const USER = '42';
const OTHER_USER = '77';
const SESSION_ID = '501';
const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';
const OK_PACKET = { affectedRows: 1, insertId: 1 };

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function sessionRow(state = emptyAgentSessionState(), language = 'roman_ur') {
  const sanitized = sanitizeAgentSessionState(state);
  return {
    id: Number(SESSION_ID),
    user_id: Number(USER),
    language,
    state_json: serializeAgentSessionState(sanitized.ok ? sanitized.state : emptyAgentSessionState()),
    created_at: '2026-09-04 10:00:00',
    last_active_at: '2026-09-04 10:00:00',
    expires_at: '2999-09-04 10:00:00',
  };
}

function occurrence(overrides = {}) {
  return {
    id: 11,
    user_id: Number(USER),
    care_plan_id: 7,
    schedule_item_id: 31,
    occurrence_date: '2026-09-04',
    scheduled_time: '08:00',
    status: 'pending',
    completed_at: null,
    completed_time: null,
    outcome_source: 'system',
    note: '',
    title: 'Morning medicine reminder',
    task_kind: 'medicine',
    display_time: 'Morning',
    recurrence_text: 'Daily',
    grounding: 'suggested',
    ...overrides,
  };
}

function schedule(overrides = {}) {
  return {
    id: 31,
    user_id: Number(USER),
    care_plan_id: 7,
    instruction_id: 3,
    schedule_date: '2026-09-04',
    schedule_time: null,
    display_time: 'Morning',
    grounding: 'suggested',
    title: 'Morning medicine reminder',
    instruction: 'Take after breakfast',
    timing: 'morning',
    original_instruction: 'Take after breakfast',
    original_timing: 'morning',
    ...overrides,
  };
}

function pendingTaskState({ confirmationId = 'conf-task', outcome = 'completed', expiresAt = FUTURE, baseStatus = 'pending' } = {}) {
  return {
    ...emptyAgentSessionState(),
    pendingConfirmation: {
      confirmationId,
      kind: 'task_outcome',
      message: 'Mark "Morning medicine reminder" as completed.',
      expiresAt,
    },
    pendingDraft: {
      confirmationId,
      toolName: 'set_task_outcome',
      kind: 'task_outcome',
      occurrenceId: '11',
      outcome,
      note: '',
      baseStatus,
      targetLabel: 'Morning medicine reminder',
      message: 'Mark "Morning medicine reminder" as completed.',
      expiresAt,
    },
  };
}

function pendingScheduleState({ confirmationId = 'conf-schedule', expiresAt = FUTURE, scheduleTime = '08:00', displayTime = 'Morning' } = {}) {
  return {
    ...emptyAgentSessionState(),
    pendingConfirmation: {
      confirmationId,
      kind: 'schedule_time',
      message: 'Set "Morning medicine reminder" reminder to 08:00.',
      expiresAt,
    },
    pendingDraft: {
      confirmationId,
      toolName: 'confirm_schedule_item_time',
      kind: 'schedule_time',
      itemId: '31',
      displayTime,
      scheduleTime,
      learningSource: 'ai_suggestion_accept',
      targetLabel: 'Morning medicine reminder',
      message: 'Set "Morning medicine reminder" reminder to 08:00.',
      expiresAt,
    },
  };
}

function fakeProvider(plan) {
  const calls = { plan: 0, reply: 0 };
  return {
    calls,
    provider: createAgentProvider({
      generateJson: async ({ systemPrompt }) => {
        if (systemPrompt.includes('planning stage')) {
          calls.plan += 1;
          return { json: plan, model: 'mock', provider: 'mock' };
        }
        calls.reply += 1;
        return {
          json: { messageTemplate: 'Safe reply.' },
          model: 'mock',
          provider: 'mock',
        };
      },
      configuration: () => ({
        configured: true,
        provider: 'mock',
        model: 'mock',
        message: null,
      }),
    }),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pausedPlanProvider({ plan, started, release }) {
  return createAgentProvider({
    generateJson: async ({ systemPrompt }) => {
      if (systemPrompt.includes('planning stage')) {
        started.resolve();
        await release.promise;
        return { json: plan, model: 'mock', provider: 'mock' };
      }
      return {
        json: { messageTemplate: 'Safe reply.' },
        model: 'mock',
        provider: 'mock',
      };
    },
    configuration: () => ({
      configured: true,
      provider: 'mock',
      model: 'mock',
      message: null,
    }),
  });
}

function createFakePool({
  initialState = emptyAgentSessionState(),
  preferredLanguage = 'Roman Urdu',
  occurrenceRow = occurrence(),
  scheduleRow = schedule(),
  siblings = [],
  beforeOutcomeMutation = null,
  beforeScheduleMutation = null,
  beforeClaimUpdate = null,
  beforeNormalStateUpdate = null,
} = {}) {
  const calls = [];
  const auditRows = [];
  let row = sessionRow(initialState, 'roman_ur');
  let currentOccurrence = occurrenceRow;
  let currentSchedule = scheduleRow;
  let outcomeMutationCount = 0;
  let scheduleMutationCount = 0;
  let normalStateMutationCount = 0;
  const operationKeys = new Set();

  const execute = async (sql, params = []) => {
    const text = normalizeSql(sql);
    calls.push({ sql: text, params });

    if (text.startsWith('SELECT preferred_language FROM patient_profiles')) {
      return [[{ preferred_language: preferredLanguage }]];
    }
    if (text.startsWith('INSERT INTO agent_sessions')) {
      row = sessionRow(emptyAgentSessionState(), params[1]);
      return [{ affectedRows: 1, insertId: Number(SESSION_ID) }];
    }
    if (
      text.startsWith('UPDATE agent_sessions SET state_json') &&
      (text.includes('AND state_json = ?') ||
        text.includes('AND BINARY state_json = BINARY ?'))
    ) {
      const nextStateJson = String(params[0]);
      const expectedStateJson = String(params[3]);
      const isClaimUpdate =
        expectedStateJson.includes('"pendingConfirmation":{') &&
        nextStateJson.includes('"pendingConfirmation":null') &&
        nextStateJson.includes('"pendingDraft":null');
      if (isClaimUpdate && beforeClaimUpdate) {
        await beforeClaimUpdate();
      } else if (!isClaimUpdate && beforeNormalStateUpdate) {
        await beforeNormalStateUpdate();
      }
      if (row.state_json !== params[3]) return [{ affectedRows: 0, insertId: 0 }];
      row = { ...row, state_json: params[0] };
      if (!isClaimUpdate) normalStateMutationCount += 1;
      return [OK_PACKET];
    }
    if (text.startsWith('UPDATE agent_sessions SET state_json')) {
      row = { ...row, state_json: params[0] };
      normalStateMutationCount += 1;
      return [OK_PACKET];
    }
    if (text.startsWith('UPDATE agent_sessions SET last_active_at')) return [OK_PACKET];
    if (text.startsWith('UPDATE agent_sessions SET language')) {
      row = { ...row, language: params[0] };
      return [OK_PACKET];
    }
    if (text.startsWith('SELECT id FROM agent_sessions WHERE id = ? AND user_id = ? LIMIT 1')) {
      return String(params[0]) === SESSION_ID && String(params[1]) === USER
        ? [[{ id: Number(SESSION_ID) }]]
        : [[]];
    }
    if (text.includes('FROM agent_sessions WHERE id = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP')) {
      return String(params[0]) === SESSION_ID && String(params[1]) === USER
        ? [[row]]
        : [[]];
    }
    if (text.startsWith('INSERT INTO agent_action_audit')) {
      auditRows.push({
        toolName: params[2],
        permissionClass: params[3],
        inputJson: params[4],
        resultStatus: params[5],
        backendConfirmed: params[6],
        targetType: params[7],
        targetId: params[8],
        errorCode: params[9],
      });
      return [{ affectedRows: 1, insertId: auditRows.length }];
    }
    if (text.startsWith('SELECT id, title, readiness_score FROM care_plans')) {
      return [[{ id: 7, title: 'Care plan', readiness_score: 85 }]];
    }
    if (text.includes('p.title AS plan_title')) {
      return currentOccurrence
        ? [[{ ...currentOccurrence, plan_title: 'Care plan' }]]
        : [[]];
    }
    if (text.startsWith('SELECT o.id, o.care_plan_id') && text.includes('FROM care_task_occurrences')) {
      const id = String(params[0]);
      const userId = String(params[1]);
      return currentOccurrence &&
        id === String(currentOccurrence.id) &&
        userId === String(currentOccurrence.user_id)
        ? [[currentOccurrence]]
        : [[]];
    }
    if (text.startsWith('SELECT id FROM care_task_outcome_operations')) {
      return operationKeys.has(`${params[0]}:${params[1]}`) ? [[{ id: 1 }]] : [[]];
    }
    if (text.startsWith('UPDATE care_task_occurrences SET status = ?')) {
      if (beforeOutcomeMutation) await beforeOutcomeMutation();
      outcomeMutationCount += 1;
      currentOccurrence = {
        ...currentOccurrence,
        status: params[0],
        note: params[3] || '',
      };
      return [OK_PACKET];
    }
    if (text.startsWith('DELETE FROM routine_learning_events')) return [OK_PACKET];
    if (text.startsWith('INSERT INTO routine_learning_events')) return [OK_PACKET];
    if (text.startsWith('INSERT IGNORE INTO care_task_outcome_operations')) {
      operationKeys.add(`${params[0]}:${params[2]}`);
      return [OK_PACKET];
    }
    if (text.startsWith('SELECT s.id, s.care_plan_id')) {
      const id = String(params[0]);
      const userId = String(params[1]);
      return currentSchedule &&
        id === String(currentSchedule.id) &&
        userId === String(currentSchedule.user_id)
        ? [[currentSchedule]]
        : [[]];
    }
    if (text.startsWith('SELECT id, TIME_FORMAT(schedule_time')) {
      return [siblings];
    }
    if (text.startsWith('UPDATE care_schedule_items')) {
      if (beforeScheduleMutation) await beforeScheduleMutation();
      scheduleMutationCount += 1;
      currentSchedule = {
        ...currentSchedule,
        schedule_time: params[0],
        display_time: params[1],
      };
      return [OK_PACKET];
    }
    if (text.startsWith('UPDATE care_task_occurrences SET scheduled_at')) {
      return [OK_PACKET];
    }
    if (/^SELECT|^WITH|^SHOW|^DESCRIBE/i.test(text)) return [[]];
    return [OK_PACKET];
  };

  return {
    execute,
    calls,
    auditRows,
    get outcomeMutationCount() {
      return outcomeMutationCount;
    },
    get scheduleMutationCount() {
      return scheduleMutationCount;
    },
    get normalStateMutationCount() {
      return normalStateMutationCount;
    },
    get state() {
      return JSON.parse(row.state_json);
    },
    async getConnection() {
      return {
        execute,
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
      };
    },
  };
}

async function handleWith({ pool, provider, confirmation = null, message = 'go', sessionId = SESSION_ID, userId = USER }) {
  return handleAgentMessage({
    pool,
    userId,
    sessionId,
    message,
    confirmation,
    provider,
  });
}

await test('DRAFT is available in normal Agent turns', async () => {
  const result = validateAgentPlan({
    intent: 'draft_task',
    capabilityCalls: [{ name: 'draft_task_outcome', args: { occurrenceId: '11', outcome: 'completed' } }],
    navigationIntent: null,
  });
  assert.equal(result.ok, true);
});

await test('REVERSIBLE_USER_ACTION is not directly plannable', async () => {
  const result = validateAgentPlan({
    intent: 'unsafe',
    capabilityCalls: [{
      name: 'set_task_outcome',
      args: { occurrenceId: '11', outcome: 'completed', baseStatus: 'pending', operationKey: 'x' },
    }],
    navigationIntent: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.permissionClass, 'REVERSIBLE_USER_ACTION');
});

await test('ordinary executeAgentCapability blocks reversible action', async () => {
  const pool = createFakePool();
  const result = await executeAgentCapability({
    name: 'set_task_outcome',
    pool,
    userId: USER,
    args: { occurrenceId: '11', outcome: 'completed', baseStatus: 'pending', operationKey: 'manual' },
  });
  assert.equal(result.ok, false);
  assert.equal(pool.outcomeMutationCount, 0);
});

await test('confirmed execution entry point rejects non-reversible capability classes', async () => {
  const pool = createFakePool();
  const readResult = await executeConfirmedAgentCapability({
    name: 'get_today_tasks',
    pool,
    userId: USER,
    args: {},
  });
  assert.equal(readResult.ok, false);
  assert.equal(readResult.permissionClass, 'READ');
});

defineAgentCapability({
  name: 'phase_d_sensitive_test_action',
  permissionClass: 'SENSITIVE_ACTION',
  description: 'Test sensitive action.',
  inputSchema: { properties: {}, required: [] },
  execute: () => ({ ok: true }),
  resultContract: '{}',
});

defineAgentCapability({
  name: 'phase_d_forbidden_test_action',
  permissionClass: 'FORBIDDEN_CLINICAL_ACTION',
  description: 'Test forbidden clinical action.',
  inputSchema: { properties: {}, required: [] },
  execute: () => ({ ok: true }),
  resultContract: '{}',
});

await test('SENSITIVE_ACTION remains blocked', async () => {
  const result = reviewAgentCapabilityCall({ name: 'phase_d_sensitive_test_action' });
  assert.equal(result.ok, false);
  assert.equal(result.permissionClass, 'SENSITIVE_ACTION');
});

await test('FORBIDDEN_CLINICAL_ACTION remains blocked', async () => {
  const result = reviewAgentCapabilityCall({ name: 'phase_d_forbidden_test_action' });
  assert.equal(result.ok, false);
  assert.equal(result.permissionClass, 'FORBIDDEN_CLINICAL_ACTION');
});

await test('draft task outcome causes zero mutation and returns confirmation', async () => {
  const { provider } = fakeProvider({
    intent: 'mark_task_done',
    capabilityCalls: [{ name: 'draft_task_outcome', args: { occurrenceId: '11', outcome: 'completed' } }],
    navigationIntent: null,
  });
  const pool = createFakePool();
  const result = await handleWith({ pool, provider });
  assert.equal(result.ok, true);
  assert.equal(result.actionStatus, 'awaiting_confirmation');
  assert.equal(result.confirmation.kind, 'task_outcome');
  assert.equal(pool.outcomeMutationCount, 0);
});

await test('draft next task outcome resolves occurrence server-side', async () => {
  const { provider } = fakeProvider({
    intent: 'mark_next_task_done',
    capabilityCalls: [{ name: 'draft_next_task_outcome', args: { outcome: 'completed' } }],
    navigationIntent: null,
  });
  const pool = createFakePool();
  const result = await handleWith({ pool, provider });
  assert.equal(result.ok, true);
  assert.equal(result.actionStatus, 'awaiting_confirmation');
  assert.equal(pool.state.pendingDraft.occurrenceId, '11');
  assert.equal(pool.outcomeMutationCount, 0);
});

await test('draft next task outcome rejects planner-supplied date', async () => {
  const result = validateAgentPlan({
    intent: 'mark_next_task_for_date',
    capabilityCalls: [{ name: 'draft_next_task_outcome', args: { outcome: 'completed', date: '2026-09-04' } }],
    navigationIntent: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_CAPABILITY_ARGS');
});

await test('draft reminder time causes zero mutation and returns confirmation', async () => {
  const { provider } = fakeProvider({
    intent: 'draft_time',
    capabilityCalls: [{ name: 'draft_schedule_time', args: { itemId: '31', scheduleTime: '08:00' } }],
    navigationIntent: null,
  });
  const pool = createFakePool();
  const result = await handleWith({ pool, provider });
  assert.equal(result.ok, true);
  assert.equal(result.actionStatus, 'awaiting_confirmation');
  assert.equal(result.confirmation.kind, 'schedule_time');
  assert.equal(pool.scheduleMutationCount, 0);
});

await test('draft schedule time rejects planner-supplied displayTime', async () => {
  const result = validateAgentPlan({
    intent: 'move_period',
    capabilityCalls: [{ name: 'draft_schedule_time', args: { itemId: '31', scheduleTime: '20:00', displayTime: 'Evening' } }],
    navigationIntent: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_CAPABILITY_ARGS');
});

await test('draft schedule time preflight rejects exact-time lock without card', async () => {
  const { provider } = fakeProvider({
    intent: 'draft_locked_time',
    capabilityCalls: [{ name: 'draft_schedule_time', args: { itemId: '31', scheduleTime: '17:00' } }],
    navigationIntent: null,
  });
  const pool = createFakePool({
    scheduleRow: schedule({ schedule_time: '14:00', grounding: 'explicit', timing: 'at 14:00', original_timing: 'at 14:00' }),
  });
  const result = await handleWith({ pool, provider });
  assert.equal(result.actionStatus, null);
  assert.equal(result.confirmation, null);
  assert.equal(result.fallbackCode, 'EXACT_TIME_LOCKED');
  assert.equal(pool.scheduleMutationCount, 0);
});

await test('draft result clearly requires confirmation', async () => {
  const { provider } = fakeProvider({
    intent: 'draft_task',
    capabilityCalls: [{ name: 'draft_task_outcome', args: { occurrenceId: '11', outcome: 'skipped' } }],
    navigationIntent: null,
  });
  const result = await handleWith({ pool: createFakePool(), provider });
  assert.match(result.reply, /review|jائزے|review/i);
  assert.equal(result.actionStatus, 'awaiting_confirmation');
});

await test('confirm task completed works', async () => {
  const pool = createFakePool({ initialState: pendingTaskState() });
  const { provider, calls } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } });
  assert.equal(result.actionStatus, 'confirmed');
  assert.equal(pool.outcomeMutationCount, 1);
  assert.equal(calls.plan, 0);
  assert.equal(calls.reply, 0);
});

await test('confirm task skipped works', async () => {
  const pool = createFakePool({ initialState: pendingTaskState({ outcome: 'skipped' }) });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } });
  assert.equal(result.actionStatus, 'confirmed');
  assert.equal(pool.outcomeMutationCount, 1);
});

await test('task outcome uses server-generated idempotency', async () => {
  const pool = createFakePool({ initialState: pendingTaskState({ confirmationId: 'abc-123' }) });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  await handleWith({ pool, provider, confirmation: { confirmationId: 'abc-123', decision: 'confirm' } });
  assert.ok(pool.calls.some((call) => String(call.params).includes('agent-confirmation:abc-123')));
});

await test('double confirmation does not double-mutate', async () => {
  const pool = createFakePool({ initialState: pendingTaskState() });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } });
  const second = await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } });
  assert.equal(pool.outcomeMutationCount, 1);
  assert.equal(second.actionStatus, 'rejected');
});

await test('concurrent task confirmations atomically execute once', async () => {
  const pool = createFakePool({ initialState: pendingTaskState() });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const [first, second] = await Promise.all([
    handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } }),
    handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } }),
  ]);
  assert.equal(pool.outcomeMutationCount, 1);
  assert.equal(
    [first.actionStatus, second.actionStatus].filter((status) => status === 'confirmed').length,
    1,
  );
});

await test('claimed confirmation finishing cannot erase a newer pending draft', async () => {
  const actionStarted = deferred();
  const releaseAction = deferred();
  let paused = false;
  const pool = createFakePool({
    initialState: pendingTaskState(),
    beforeOutcomeMutation: async () => {
      if (paused) return;
      paused = true;
      actionStarted.resolve();
      await releaseAction.promise;
    },
  });
  const confirmProvider = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null }).provider;
  const confirmPromise = handleWith({
    pool,
    provider: confirmProvider,
    confirmation: { confirmationId: 'conf-task', decision: 'confirm' },
  });

  await actionStarted.promise;

  const { provider: draftProvider } = fakeProvider({
    intent: 'new_draft',
    capabilityCalls: [{ name: 'draft_task_outcome', args: { occurrenceId: '11', outcome: 'skipped' } }],
    navigationIntent: null,
  });
  const draftResult = await handleWith({ pool, provider: draftProvider, message: 'skip it instead' });
  assert.equal(draftResult.actionStatus, 'awaiting_confirmation');
  const newConfirmationId = pool.state.pendingDraft.confirmationId;
  assert.equal(pool.state.pendingDraft.outcome, 'skipped');

  releaseAction.resolve();
  const confirmResult = await confirmPromise;

  assert.equal(confirmResult.actionStatus, 'confirmed');
  assert.equal(pool.outcomeMutationCount, 1);
  assert.equal(pool.state.pendingDraft.outcome, 'skipped');
  assert.equal(pool.state.pendingDraft.confirmationId, newConfirmationId);
});

await test('losing concurrent confirmation cannot erase a newer pending draft', async () => {
  const bothAtClaim = deferred();
  const releaseClaims = deferred();
  let claimHits = 0;
  const actionStarted = deferred();
  const releaseAction = deferred();
  let pausedAction = false;
  const pool = createFakePool({
    initialState: pendingTaskState(),
    beforeClaimUpdate: async () => {
      claimHits += 1;
      if (claimHits === 2) bothAtClaim.resolve();
      await releaseClaims.promise;
    },
    beforeOutcomeMutation: async () => {
      if (pausedAction) return;
      pausedAction = true;
      actionStarted.resolve();
      await releaseAction.promise;
    },
  });
  const provider = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null }).provider;
  const first = handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } });
  const second = handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } });

  await bothAtClaim.promise;
  releaseClaims.resolve();
  await actionStarted.promise;

  const { provider: draftProvider } = fakeProvider({
    intent: 'new_draft_after_loss',
    capabilityCalls: [{ name: 'draft_task_outcome', args: { occurrenceId: '11', outcome: 'skipped' } }],
    navigationIntent: null,
  });
  await handleWith({ pool, provider: draftProvider, message: 'new draft' });
  const newConfirmationId = pool.state.pendingDraft.confirmationId;

  releaseAction.resolve();
  const results = await Promise.all([first, second]);

  assert.equal(pool.outcomeMutationCount, 1);
  assert.equal(results.filter((result) => result.actionStatus === 'confirmed').length, 1);
  assert.equal(results.filter((result) => result.actionStatus === 'rejected').length, 1);
  assert.equal(pool.state.pendingDraft.outcome, 'skipped');
  assert.equal(pool.state.pendingDraft.confirmationId, newConfirmationId);
});

await test('stale normal read cannot resurrect consumed confirmation', async () => {
  const planStarted = deferred();
  const releasePlan = deferred();
  const pool = createFakePool({ initialState: pendingTaskState() });
  const normalProvider = pausedPlanProvider({
    started: planStarted,
    release: releasePlan,
    plan: { intent: 'read_status', capabilityCalls: [], navigationIntent: null },
  });
  const normalTurn = handleWith({ pool, provider: normalProvider, message: 'status please' });

  await planStarted.promise;
  const confirmProvider = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null }).provider;
  const confirmed = await handleWith({
    pool,
    provider: confirmProvider,
    confirmation: { confirmationId: 'conf-task', decision: 'confirm' },
  });
  assert.equal(confirmed.actionStatus, 'confirmed');
  assert.equal(pool.state.pendingDraft, null);

  releasePlan.resolve();
  const normalResult = await normalTurn;

  assert.equal(normalResult.ok, true);
  assert.equal(pool.outcomeMutationCount, 1);
  assert.equal(pool.state.pendingDraft, null);
  assert.equal(pool.state.pendingConfirmation, null);
});

await test('stale normal turn cannot erase a newer pending draft', async () => {
  const planStarted = deferred();
  const releasePlan = deferred();
  const pool = createFakePool();
  const normalProvider = pausedPlanProvider({
    started: planStarted,
    release: releasePlan,
    plan: { intent: 'read_status', capabilityCalls: [], navigationIntent: null },
  });
  const normalTurn = handleWith({ pool, provider: normalProvider, message: 'status please' });

  await planStarted.promise;
  const { provider: draftProvider } = fakeProvider({
    intent: 'new_draft',
    capabilityCalls: [{ name: 'draft_task_outcome', args: { occurrenceId: '11', outcome: 'skipped' } }],
    navigationIntent: null,
  });
  const draftResult = await handleWith({ pool, provider: draftProvider, message: 'skip it' });
  assert.equal(draftResult.actionStatus, 'awaiting_confirmation');
  const newConfirmationId = pool.state.pendingDraft.confirmationId;

  releasePlan.resolve();
  const normalResult = await normalTurn;

  assert.equal(normalResult.ok, true);
  assert.equal(pool.state.pendingDraft.outcome, 'skipped');
  assert.equal(pool.state.pendingDraft.confirmationId, newConfirmationId);
});

await test('competing draft writes only return the persisted pending action', async () => {
  const bothAtStateUpdate = deferred();
  const releaseStateUpdates = deferred();
  let stateUpdateHits = 0;
  const pool = createFakePool({
    beforeNormalStateUpdate: async () => {
      stateUpdateHits += 1;
      if (stateUpdateHits === 2) bothAtStateUpdate.resolve();
      await releaseStateUpdates.promise;
    },
  });
  const { provider: completedProvider } = fakeProvider({
    intent: 'draft_completed',
    capabilityCalls: [{ name: 'draft_task_outcome', args: { occurrenceId: '11', outcome: 'completed' } }],
    navigationIntent: null,
  });
  const { provider: skippedProvider } = fakeProvider({
    intent: 'draft_skipped',
    capabilityCalls: [{ name: 'draft_task_outcome', args: { occurrenceId: '11', outcome: 'skipped' } }],
    navigationIntent: null,
  });

  const first = handleWith({ pool, provider: completedProvider, message: 'mark complete' });
  const second = handleWith({ pool, provider: skippedProvider, message: 'mark skipped' });
  await bothAtStateUpdate.promise;
  releaseStateUpdates.resolve();
  const results = await Promise.all([first, second]);
  const persistedConfirmationId = pool.state.pendingDraft.confirmationId;

  assert.equal(pool.normalStateMutationCount, 1);
  assert.equal(results.filter((result) => result.actionStatus === 'awaiting_confirmation').length, 2);
  assert.equal(results.filter((result) => result.fallbackCode === 'AGENT_CONFIRMATION_ALREADY_PENDING').length, 1);
  assert.equal(results.filter((result) => !result.fallbackCode).length, 1);
  assert.equal(results[0].confirmation.confirmationId, persistedConfirmationId);
  assert.equal(results[1].confirmation.confirmationId, persistedConfirmationId);
  assert.ok(['completed', 'skipped'].includes(pool.state.pendingDraft.outcome));
});

await test('cancel causes zero mutation and clears pending state', async () => {
  const pool = createFakePool({ initialState: pendingTaskState() });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'cancel' } });
  assert.equal(result.actionStatus, 'cancelled');
  assert.equal(pool.outcomeMutationCount, 0);
  assert.equal(pool.state.pendingDraft, null);
});

await test('mismatched confirmation ID causes zero mutation', async () => {
  const pool = createFakePool({ initialState: pendingTaskState() });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'wrong', decision: 'confirm' } });
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(pool.outcomeMutationCount, 0);
  assert.equal(pool.state.pendingDraft.confirmationId, 'conf-task');
});

await test('expired confirmation causes zero mutation and clears pending state', async () => {
  const pool = createFakePool({ initialState: pendingTaskState({ expiresAt: PAST }) });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } });
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(result.fallbackCode, 'AGENT_CONFIRMATION_EXPIRED');
  assert.equal(pool.outcomeMutationCount, 0);
  assert.equal(pool.state.pendingDraft, null);
});

await test('expired confirmation CAS loss cannot erase newer pending draft', async () => {
  const claimStarted = deferred();
  const releaseClaim = deferred();
  let paused = false;
  const pool = createFakePool({
    initialState: pendingTaskState({ expiresAt: PAST }),
    beforeClaimUpdate: async () => {
      if (paused) return;
      paused = true;
      claimStarted.resolve();
      await releaseClaim.promise;
    },
  });
  const provider = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null }).provider;
  const expiredPromise = handleWith({
    pool,
    provider,
    confirmation: { confirmationId: 'conf-task', decision: 'confirm' },
  });

  await claimStarted.promise;
  const { provider: draftProvider } = fakeProvider({
    intent: 'new_draft_during_expired_cleanup',
    capabilityCalls: [{ name: 'draft_task_outcome', args: { occurrenceId: '11', outcome: 'skipped' } }],
    navigationIntent: null,
  });
  const draftResult = await handleWith({ pool, provider: draftProvider, message: 'new draft' });
  assert.equal(draftResult.actionStatus, 'awaiting_confirmation');
  const newConfirmationId = pool.state.pendingDraft.confirmationId;

  releaseClaim.resolve();
  const expiredResult = await expiredPromise;

  assert.equal(expiredResult.actionStatus, 'rejected');
  assert.equal(expiredResult.fallbackCode, 'AGENT_CONFIRMATION_ALREADY_CLAIMED');
  assert.equal(pool.outcomeMutationCount, 0);
  assert.equal(pool.state.pendingDraft.outcome, 'skipped');
  assert.equal(pool.state.pendingDraft.confirmationId, newConfirmationId);
});

await test('no pending confirmation causes zero mutation', async () => {
  const pool = createFakePool();
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'missing', decision: 'confirm' } });
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(pool.outcomeMutationCount, 0);
});

await test('cross-user resource causes zero mutation', async () => {
  const pool = createFakePool({
    initialState: pendingTaskState(),
    occurrenceRow: occurrence({ user_id: Number(OTHER_USER) }),
  });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } });
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(pool.outcomeMutationCount, 0);
});

await test('stale baseStatus fails safely', async () => {
  const pool = createFakePool({
    initialState: pendingTaskState({ baseStatus: 'pending' }),
    occurrenceRow: occurrence({ status: 'skipped' }),
  });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } });
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(pool.outcomeMutationCount, 0);
});

await test('confirm schedule time works through authoritative service', async () => {
  const pool = createFakePool({ initialState: pendingScheduleState() });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-schedule', decision: 'confirm' } });
  assert.equal(result.actionStatus, 'confirmed');
  assert.equal(pool.scheduleMutationCount, 1);
});

await test('concurrent schedule confirmations atomically execute once', async () => {
  const pool = createFakePool({ initialState: pendingScheduleState() });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const [first, second] = await Promise.all([
    handleWith({ pool, provider, confirmation: { confirmationId: 'conf-schedule', decision: 'confirm' } }),
    handleWith({ pool, provider, confirmation: { confirmationId: 'conf-schedule', decision: 'confirm' } }),
  ]);
  assert.equal(pool.scheduleMutationCount, 1);
  assert.equal(
    [first.actionStatus, second.actionStatus].filter((status) => status === 'confirmed').length,
    1,
  );
});

await test('exact verified reminder time cannot be changed', async () => {
  const pool = createFakePool({
    initialState: pendingScheduleState({ scheduleTime: '17:00' }),
    scheduleRow: schedule({ schedule_time: '14:00', grounding: 'explicit', timing: 'at 14:00', original_timing: 'at 14:00' }),
  });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-schedule', decision: 'confirm' } });
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(result.fallbackCode, 'EXACT_TIME_LOCKED');
  assert.equal(pool.scheduleMutationCount, 0);
  assert.ok(pool.auditRows.some((row) => row.errorCode === 'EXACT_TIME_LOCKED' && row.resultStatus === 'rejected' && row.backendConfirmed === 0));
});

await test('out-of-window reminder is rejected', async () => {
  const pool = createFakePool({
    initialState: pendingScheduleState({ scheduleTime: '22:00', displayTime: 'Morning' }),
  });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-schedule', decision: 'confirm' } });
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(result.fallbackCode, 'TIME_OUTSIDE_PERIOD_WINDOW');
});

await test('medical timing conflict is rejected', async () => {
  const pool = createFakePool({
    initialState: pendingScheduleState({ scheduleTime: '20:00', displayTime: 'Evening' }),
    scheduleRow: schedule({
      display_time: 'Evening',
      timing: 'after breakfast',
      original_timing: 'after breakfast',
    }),
  });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-schedule', decision: 'confirm' } });
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(result.fallbackCode, 'MEDICAL_TIMING_CONFLICT');
});

await test('duplicate reminder time is rejected', async () => {
  const pool = createFakePool({
    initialState: pendingScheduleState({ scheduleTime: '08:00' }),
    siblings: [{ id: 88, schedule_time: '08:00', display_time: 'Afternoon' }],
  });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-schedule', decision: 'confirm' } });
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(result.fallbackCode, 'DUPLICATE_REMINDER_TIME');
});

await test('duplicate reminder period is rejected', async () => {
  const pool = createFakePool({
    initialState: pendingScheduleState({ scheduleTime: '08:30', displayTime: 'Morning' }),
    siblings: [{ id: 88, schedule_time: '09:00', display_time: 'Morning' }],
  });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-schedule', decision: 'confirm' } });
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(result.fallbackCode, 'DUPLICATE_REMINDER_PERIOD');
});

await test('ambiguous target is not guessed by requiring concrete ids', async () => {
  const capability = { inputSchema: { properties: { itemId: { type: 'id' }, scheduleTime: { type: 'string', maxLength: 5 } }, required: ['itemId', 'scheduleTime'] } };
  const validated = validateAgentCapabilityInput(capability, { scheduleTime: '08:00' });
  assert.equal(validated.ok, false);
});

await test('planner/provider cannot inject userId', async () => {
  const result = validateAgentPlan({
    intent: 'inject',
    capabilityCalls: [{ name: 'draft_task_outcome', args: { occurrenceId: '11', outcome: 'completed', userId: USER } }],
    navigationIntent: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_CAPABILITY_ARGS');
});

await test('unknown action names fail closed', async () => {
  const result = reviewAgentConfirmedCapabilityCall({
    name: 'unknown_action',
    pendingDraft: { toolName: 'unknown_action', confirmationId: 'x' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN_CAPABILITY');
});

await test('provider failure causes no action', async () => {
  const pool = createFakePool();
  const provider = createAgentProvider({
    generateJson: async () => { throw new Error('no provider'); },
    configuration: () => ({ configured: true, provider: 'mock', model: 'mock', message: null }),
  });
  const result = await handleWith({ pool, provider, sessionId: null });
  assert.equal(result.ok, true);
  assert.equal(pool.outcomeMutationCount, 0);
});

await test('confirm/cancel path uses zero LLM calls', async () => {
  const pool = createFakePool({ initialState: pendingTaskState() });
  const { provider, calls } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'cancel' } });
  assert.equal(calls.plan + calls.reply, 0);
});

await test('action success is audited with backendConfirmed true', async () => {
  const pool = createFakePool({ initialState: pendingTaskState() });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } });
  assert.ok(pool.auditRows.some((row) => row.permissionClass === 'REVERSIBLE_USER_ACTION' && row.backendConfirmed === 1));
});

await test('failed action never has backendConfirmed true', async () => {
  const pool = createFakePool({ initialState: pendingTaskState(), occurrenceRow: null });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } });
  assert.ok(pool.auditRows.every((row) => row.errorCode == null || row.backendConfirmed === 0));
});

await test('deterministic ownership and validation denials audit as rejected', async () => {
  const pool = createFakePool({ initialState: pendingTaskState(), occurrenceRow: null });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } });
  assert.ok(pool.auditRows.some((row) => row.errorCode === 'TASK_OCCURRENCE_NOT_FOUND' && row.resultStatus === 'rejected'));
});

await test('forbidden clinical action cannot produce executable pending draft', async () => {
  const result = reviewAgentConfirmedCapabilityCall({
    name: 'phase_d_forbidden_test_action',
    pendingDraft: { toolName: 'phase_d_forbidden_test_action', confirmationId: 'x' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.permissionClass, 'FORBIDDEN_CLINICAL_ACTION');
});

await test('pending action cannot be silently overwritten by another action', async () => {
  const { provider } = fakeProvider({
    intent: 'second_draft',
    capabilityCalls: [{ name: 'draft_task_outcome', args: { occurrenceId: '11', outcome: 'skipped' } }],
    navigationIntent: null,
  });
  const pool = createFakePool({ initialState: pendingTaskState() });
  const result = await handleWith({ pool, provider });
  assert.equal(result.actionStatus, 'awaiting_confirmation');
  assert.equal(result.fallbackCode, 'AGENT_CONFIRMATION_ALREADY_PENDING');
  assert.equal(pool.state.pendingDraft.outcome, 'completed');
});

await test('state sanitizer remains bounded', async () => {
  const sanitized = sanitizeAgentSessionState({
    ...pendingTaskState(),
    pendingDraft: {
      ...pendingTaskState().pendingDraft,
      extra1: '1',
      extra2: '2',
      extra3: '3',
      extra4: '4',
      extra5: '5',
      extra6: '6',
      extra7: '7',
      extra8: '8',
      extra9: '9',
    },
  });
  assert.equal(sanitized.ok, true);
  assert.ok(Object.keys(sanitized.state.pendingDraft).length <= 12);
});

await test('secrets are not written into state or audit input', async () => {
  const pool = createFakePool({ initialState: pendingTaskState() });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'confirm' } });
  assert.doesNotMatch(JSON.stringify(pool.state), /secret|token|jwt/i);
  assert.doesNotMatch(JSON.stringify(pool.auditRows), /secret|token|jwt/i);
});

await test('confirmation request requires session id', async () => {
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({
    pool: createFakePool(),
    provider,
    sessionId: null,
    confirmation: { confirmationId: 'x', decision: 'confirm' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_AGENT_SESSION_ID');
});

await test('confirmation request rejects invalid decision', async () => {
  const pool = createFakePool({ initialState: pendingTaskState() });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({ pool, provider, confirmation: { confirmationId: 'conf-task', decision: 'maybe' } });
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(pool.outcomeMutationCount, 0);
});

await test('ordinary planner catalog advertises drafts but not reversible actions', async () => {
  const prompts = buildAgentPlannerPrompts({ message: 'mark done', contextSlice: {} });
  assert.match(prompts.userPrompt, /draft_task_outcome/);
  assert.doesNotMatch(prompts.userPrompt, /set_task_outcome/);
});

await test('client-supplied identity is rejected by closed confirmation contract', async () => {
  const pool = createFakePool({ initialState: pendingTaskState() });
  const { provider } = fakeProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null });
  const result = await handleWith({
    pool,
    provider,
    confirmation: { confirmationId: 'conf-task', decision: 'confirm', userId: OTHER_USER },
  });
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(result.fallbackCode, 'INVALID_AGENT_CONFIRMATION_REQUEST');
  assert.equal(pool.outcomeMutationCount, 0);
});

console.log(`\nPhase D tests passed: ${passed}`);
