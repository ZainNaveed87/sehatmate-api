/** Phase E conversation intelligence + structured memory regression tests. */
import assert from 'node:assert/strict';

import { handleAgentMessage } from './agent/agent_core.js';
import { createAgentProvider } from './agent/agent_provider.js';
import { defineAgentCapability } from './agent/agent_capability_registry.js';
import {
  buildAgentContextSlice,
  readAgentConversationStateContext,
} from './agent/agent_context_engine.js';
import {
  canonicalConversationEntityReference,
  deriveServerCapabilityNames,
  deriveServerNormalizedIntent,
  deriveVerifiedCurrentFocus,
  deriveVerifiedOrderedEntityList,
} from './agent/agent_conversation_state.js';
import {
  classifyBareConfirmationDecision,
  resolveAgentConversationReference,
  reviewPlanAgainstResolvedReference,
} from './agent/agent_reference_resolver.js';
import {
  emptyAgentSessionState,
  sanitizeAgentSessionState,
  serializeAgentSessionState,
} from './agent/agent_session_state.js';
import { updateAgentSessionState } from './agent/agent_session_store.js';

process.env.AGENT_ENABLED = 'true';

const USER = '42';
const SESSION_ID = '501';
const FUTURE = '2999-01-01T00:00:00.000Z';
let passed = 0;
let dummyMutationCount = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function sessionRow(state = emptyAgentSessionState()) {
  const sanitized = sanitizeAgentSessionState(state);
  return {
    id: Number(SESSION_ID),
    user_id: Number(USER),
    language: 'roman_ur',
    state_json: serializeAgentSessionState(sanitized.state),
    created_at: '2026-09-04 10:00:00',
    last_active_at: '2026-09-04 10:00:00',
    expires_at: '2999-09-04 10:00:00',
  };
}

function createPool({ initialState = emptyAgentSessionState(), plans = [] } = {}) {
  let row = sessionRow(initialState);
  const auditRows = [];
  const execute = async (sql, params = []) => {
    const text = normalizeSql(sql);
    if (text.startsWith('SELECT preferred_language FROM patient_profiles')) {
      return [[{ preferred_language: 'Roman Urdu' }]];
    }
    if (text.startsWith('UPDATE agent_sessions SET last_active_at')) {
      return [{ affectedRows: 1 }];
    }
    if (text.startsWith('UPDATE agent_sessions SET language')) {
      row = { ...row, language: params[0] };
      return [{ affectedRows: 1 }];
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
    if (text.startsWith('UPDATE agent_sessions SET state_json')) {
      const expected = params[3];
      if (expected !== undefined && row.state_json !== expected) {
        return [{ affectedRows: 0 }];
      }
      row = { ...row, state_json: params[0] };
      return [{ affectedRows: 1 }];
    }
    if (text.startsWith('INSERT INTO agent_action_audit')) {
      auditRows.push(params);
      return [{ affectedRows: 1, insertId: auditRows.length }];
    }
    if (text.startsWith('SELECT id, title FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1')) {
      const plan = plans.find(
        (item) => String(item.id) === String(params[0]) && String(params[1]) === USER,
      );
      return [plan ? [[{ id: Number(plan.id), title: plan.title }]][0] : []];
    }
    if (text.includes('FROM care_plans') && text.includes('WHERE care_plans.user_id = ?')) {
      return [plans.map((plan, index) => ({
        id: Number(plan.id),
        title: plan.title,
        status: 'active',
        start_date: null,
        readiness_score: 80 - index,
        understanding_score: 0,
        activated_at: null,
        completed_at: null,
        completion_reason: null,
        completed_by: null,
        duration_mode: 'prescription',
        suggested_end_date: null,
        planned_end_date: null,
        created_at: null,
        updated_at: null,
        document_count: 0,
        task_count: 0,
        open_gap_count: 0,
        setup_step: 'complete',
      }))];
    }
    if (/^SELECT|^WITH|^SHOW|^DESCRIBE/i.test(text)) return [[]];
    return [{ affectedRows: 1, insertId: 1 }];
  };
  return {
    execute,
    auditRows,
    get state() {
      return JSON.parse(row.state_json);
    },
    setState(state) {
      row = sessionRow(state);
    },
  };
}

function pendingDummyState({ confirmationId = 'phase-e-confirm' } = {}) {
  return {
    ...emptyAgentSessionState(),
    pendingConfirmation: {
      confirmationId,
      kind: 'task_outcome',
      message: 'Mark the task as completed.',
      expiresAt: FUTURE,
    },
    pendingDraft: {
      confirmationId,
      toolName: 'phase_e_test_action',
      kind: 'task_outcome',
      occurrenceId: '11',
      outcome: 'completed',
      baseStatus: 'pending',
      message: 'Mark the task as completed.',
      expiresAt: FUTURE,
    },
  };
}

try {
  defineAgentCapability({
    name: 'phase_e_test_action',
    permissionClass: 'REVERSIBLE_USER_ACTION',
    description: 'Phase E test-only reversible action.',
    inputSchema: {
      properties: {
        occurrenceId: { type: 'id' },
        outcome: { type: 'enum', values: ['completed', 'skipped'] },
        baseStatus: { type: 'enum', values: ['pending', 'completed', 'skipped', 'missed'] },
        operationKey: { type: 'string', maxLength: 200 },
        note: { type: 'string', maxLength: 200 },
      },
      required: ['occurrenceId', 'outcome', 'baseStatus', 'operationKey'],
    },
    execute: async () => {
      dummyMutationCount += 1;
      return { ok: true, data: { status: 'completed' } };
    },
    resultContract: '{ status }',
  });
} catch (error) {
  if (!String(error?.message || '').includes('already registered')) throw error;
}

function zeroCallProvider() {
  let calls = 0;
  return {
    provider: createAgentProvider({
      generateJson: async () => {
        calls += 1;
        throw new Error('provider should not be called');
      },
      configuration: () => ({ configured: true, provider: 'mock', model: 'mock', message: null }),
    }),
    get calls() { return calls; },
  };
}

function plannedProvider(plan) {
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
        return { json: { messageTemplate: 'Safe reply.' }, model: 'mock', provider: 'mock' };
      },
      configuration: () => ({ configured: true, provider: 'mock', model: 'mock', message: null }),
    }),
  };
}

await test('bare confirmation/cancellation phrase matcher is closed and deterministic', async () => {
  assert.equal(classifyBareConfirmationDecision('haan'), 'confirm');
  assert.equal(classifyBareConfirmationDecision('Yes!'), 'confirm');
  assert.equal(classifyBareConfirmationDecision('nahi'), 'cancel');
  assert.equal(classifyBareConfirmationDecision('haan aur plans batao'), null);
});

await test('ordinal reference resolves only from the verified ordered list', async () => {
  const result = await resolveAgentConversationReference({
    pool: createPool(), userId: USER, message: 'pehla wala kholo',
    recentOrderedEntityList: {
      kind: 'care_plan',
      entities: [
        { type: 'care_plan', id: '17', title: 'Prescription Plan' },
        { type: 'care_plan', id: '21', title: 'Exercise Plan' },
      ],
    },
  });
  assert.equal(result.status, 'resolved');
  assert.deepEqual({ type: result.entity.type, id: result.entity.id }, { type: 'care_plan', id: '17' });
});

await test('out-of-range ordinal fails closed', async () => {
  const result = await resolveAgentConversationReference({
    pool: createPool(), userId: USER, message: 'doosra wala kholo',
    recentOrderedEntityList: {
      kind: 'care_plan',
      entities: [{ type: 'care_plan', id: '17', title: 'Prescription Plan' }],
    },
  });
  assert.equal(result.status, 'missing');
  assert.equal(result.reason, 'ordinal_out_of_range');
});

await test('ambiguous pronoun does not guess an entity', async () => {
  const result = await resolveAgentConversationReference({
    pool: createPool(), userId: USER, message: 'us wala kholo',
    recentEntities: [
      { type: 'care_plan', id: '17', title: 'Prescription Plan' },
      { type: 'care_plan', id: '21', title: 'Exercise Plan' },
    ],
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.entity, null);
});

await test('missing pronoun reference asks for clarification instead of inventing id', async () => {
  const result = await resolveAgentConversationReference({
    pool: createPool(), userId: USER, message: 'iska score?', recentEntities: [],
  });
  assert.equal(result.status, 'missing');
});

await test('explicit current-turn title overrides stale currentFocus', async () => {
  const result = await resolveAgentConversationReference({
    pool: createPool(), userId: USER, message: 'Exercise Plan ki simulation batao',
    currentFocus: { type: 'care_plan', id: '17', title: 'Prescription Plan' },
    recentEntities: [{ type: 'care_plan', id: '21', title: 'Exercise Plan' }],
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.source, 'explicit_current_turn');
  assert.equal(result.entity.id, '21');
});

await test('resolved reference rejects planner id invention', async () => {
  const reviewed = reviewPlanAgainstResolvedReference({
    resolution: { status: 'resolved', entity: { type: 'care_plan', id: '17' } },
    plan: {
      capabilityCalls: [{ name: 'get_simulation', args: { planId: '21' } }],
      navigationIntent: null,
    },
  });
  assert.equal(reviewed.ok, false);
  assert.equal(reviewed.code, 'AGENT_REFERENCE_MISMATCH');
});

await test('entity type mismatch cannot reinterpret care gap id as plan id', async () => {
  const reviewed = reviewPlanAgainstResolvedReference({
    resolution: { status: 'resolved', entity: { type: 'care_gap', id: '5' } },
    plan: {
      capabilityCalls: [{ name: 'get_simulation', args: { planId: '5' } }],
      navigationIntent: null,
    },
  });
  assert.equal(reviewed.ok, false);
  assert.equal(reviewed.code, 'AGENT_REFERENCE_TYPE_MISMATCH');
});

await test('successful list result stores only bounded ordered entity references', async () => {
  const list = deriveVerifiedOrderedEntityList([{ name: 'get_care_plans', result: {
    ok: true,
    data: { plans: Array.from({ length: 20 }, (_, index) => ({ id: String(index + 1), title: `Plan ${index + 1}`, readinessScore: 99 })) },
  } }]);
  assert.equal(list.kind, 'care_plan');
  assert.equal(list.entities.length, 10);
  assert.deepEqual(list.entities[0], { type: 'care_plan', id: '1' });
  assert.equal('title' in list.entities[0], false);
});

await test('currentFocus derives only from verified successful target/navigation', async () => {
  assert.deepEqual(
    deriveVerifiedCurrentFocus({ successfulCapabilityCalls: [{ name: 'get_simulation', args: { planId: '17' } }] }),
    { type: 'care_plan', id: '17' },
  );
  assert.deepEqual(
    deriveVerifiedCurrentFocus({ navigationEntity: { type: 'care_gap', id: '5', title: 'Gap' } }),
    { type: 'care_gap', id: '5' },
  );
  assert.equal(deriveVerifiedCurrentFocus({}), undefined);
});

await test('last intent/capability memory is server-normalized', async () => {
  const calls = [{ name: 'get_care_plan', args: { planId: '17' } }];
  assert.equal(deriveServerNormalizedIntent({ successfulCapabilityCalls: calls }), 'get_care_plan');
  assert.deepEqual(deriveServerCapabilityNames(calls), ['get_care_plan']);
});

await test('session state persists bounded Phase E references and drops transcript-shaped unknowns', async () => {
  const sanitized = sanitizeAgentSessionState({
    currentFocus: { type: 'care_plan', id: '17' },
    recentOrderedEntityList: { kind: 'care_plan', entities: [{ type: 'care_plan', id: '17' }] },
    lastIntent: 'get_simulation',
    lastCapabilityNames: ['get_simulation'],
    rawPrompt: 'secret transcript',
    modelResponse: 'raw reply',
  });
  assert.equal(sanitized.ok, true);
  assert.equal('rawPrompt' in sanitized.state, false);
  assert.equal('modelResponse' in sanitized.state, false);
  assert.deepEqual(sanitized.state.currentFocus, { type: 'care_plan', id: '17' });
});

await test('unsupported entity types cannot enter currentFocus/ordered list', async () => {
  const sanitized = sanitizeAgentSessionState({
    currentFocus: { type: 'document', id: '9' },
    recentOrderedEntityList: { kind: 'document', entities: [{ type: 'document', id: '9' }] },
  });
  assert.equal(sanitized.state.currentFocus, null);
  assert.equal(sanitized.state.recentOrderedEntityList, null);
  assert.equal(canonicalConversationEntityReference({ type: 'document', id: '9' }), null);
});

await test('remembered entities are ownership-revalidated before provider context use', async () => {
  const pool = createPool({ plans: [{ id: '17', title: 'Owned Plan' }] });
  const context = await readAgentConversationStateContext({
    pool,
    userId: USER,
    sessionState: {
      ...emptyAgentSessionState(),
      currentFocus: { type: 'care_plan', id: '17' },
      lastReferencedEntities: [
        { type: 'care_plan', id: '17' },
        { type: 'care_plan', id: '99' },
      ],
    },
  });
  assert.equal(context.currentFocus.id, '17');
  assert.deepEqual(context.recentEntities.map((item) => item.id), ['17']);
});

await test('provider context contains structured memory but no transcript', async () => {
  const slice = buildAgentContextSlice({
    language: 'roman_ur',
    sessionState: { lastActionSummary: 'intent:get_simulation' },
    conversationContext: {
      currentFocus: { type: 'care_plan', id: '17' },
      recentEntities: [{ type: 'care_plan', id: '17' }],
      recentOrderedEntityList: { kind: 'care_plan', entities: [{ type: 'care_plan', id: '17' }] },
      lastIntent: 'get_simulation',
      lastCapabilityNames: ['get_simulation'],
    },
    referenceResolution: { status: 'resolved', source: 'current_focus', entity: { type: 'care_plan', id: '17' } },
  });
  assert.equal(slice.currentFocus.id, '17');
  assert.equal(slice.lastIntent, 'get_simulation');
  assert.equal('messages' in slice, false);
  assert.equal('transcript' in slice, false);
});

await test('bare haan with no pending confirmation uses zero provider calls and no mutation', async () => {
  const pool = createPool();
  const provider = zeroCallProvider();
  const result = await handleAgentMessage({
    pool, userId: USER, sessionId: SESSION_ID, message: 'haan', provider: provider.provider,
  });
  assert.equal(result.ok, true);
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(provider.calls, 0);
  assert.equal(dummyMutationCount, 0);
});

await test('bare nahi cancels only the stored pending confirmation with zero provider calls', async () => {
  const pool = createPool({ initialState: pendingDummyState() });
  const provider = zeroCallProvider();
  const result = await handleAgentMessage({
    pool, userId: USER, sessionId: SESSION_ID, message: 'nahi', provider: provider.provider,
  });
  assert.equal(result.ok, true);
  assert.equal(result.actionStatus, 'cancelled');
  assert.equal(provider.calls, 0);
  assert.equal(pool.state.pendingConfirmation, null);
  assert.equal(pool.state.pendingDraft, null);
  assert.equal(dummyMutationCount, 0);
});

await test('bare haan confirms only the stored pending action with zero provider calls', async () => {
  dummyMutationCount = 0;
  const pool = createPool({ initialState: pendingDummyState({ confirmationId: 'exact-confirm' }) });
  const provider = zeroCallProvider();
  const result = await handleAgentMessage({
    pool, userId: USER, sessionId: SESSION_ID, message: 'haan', provider: provider.provider,
  });
  assert.equal(result.ok, true);
  assert.equal(result.actionStatus, 'confirmed');
  assert.equal(provider.calls, 0);
  assert.equal(dummyMutationCount, 1);
  assert.equal(pool.state.pendingConfirmation, null);
});

await test('CAS state update rejects a stale Phase E memory write', async () => {
  const pool = createPool({ initialState: {
    ...emptyAgentSessionState(), currentFocus: { type: 'care_plan', id: '17' },
  } });
  const stale = pool.state;
  const newer = { ...stale, currentFocus: { type: 'care_plan', id: '21' } };
  const first = await updateAgentSessionState({
    db: pool, userId: USER, sessionId: SESSION_ID, state: newer, expectedState: stale,
  });
  assert.equal(first.ok, true);
  const staleWrite = await updateAgentSessionState({
    db: pool, userId: USER, sessionId: SESSION_ID,
    state: { ...stale, lastIntent: 'get_simulation' }, expectedState: stale,
  });
  assert.equal(staleWrite.ok, false);
  assert.equal(staleWrite.code, 'AGENT_SESSION_STATE_CONFLICT');
  assert.equal(staleWrite.data.session.state.currentFocus.id, '21');
});

await test('Phase E memory remains inside the configured state byte bounds', async () => {
  const sanitized = sanitizeAgentSessionState({
    currentFocus: { type: 'care_plan', id: '17' },
    recentOrderedEntityList: {
      kind: 'care_plan',
      entities: Array.from({ length: 100 }, (_, index) => ({ type: 'care_plan', id: String(index + 1) })),
    },
    lastCapabilityNames: Array.from({ length: 100 }, () => 'get_simulation'),
  });
  assert.equal(sanitized.ok, true);
  assert.equal(sanitized.state.recentOrderedEntityList.entities.length, 10);
  assert.equal(sanitized.state.lastCapabilityNames.length, 5);
});

await test('core resolves pehla wala from verified ordered list and navigates exact plan', async () => {
  const pool = createPool({
    plans: [
      { id: '17', title: 'Prescription Plan' },
      { id: '21', title: 'Exercise Plan' },
    ],
    initialState: {
      ...emptyAgentSessionState(),
      recentOrderedEntityList: {
        kind: 'care_plan',
        entities: [
          { type: 'care_plan', id: '17' },
          { type: 'care_plan', id: '21' },
        ],
      },
    },
  });
  const provider = plannedProvider({
    intent: 'open_first_plan',
    capabilityCalls: [],
    navigationIntent: { target: 'care_plan_detail', params: { carePlanId: '17' } },
  });
  const result = await handleAgentMessage({
    pool, userId: USER, sessionId: SESSION_ID, message: 'pehla wala kholo', provider: provider.provider,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.navigation, { target: 'care_plan_detail', params: { carePlanId: '17' } });
  assert.equal(provider.calls.plan, 1);
  assert.equal(provider.calls.reply, 0);
  assert.deepEqual(pool.state.currentFocus, { type: 'care_plan', id: '17' });
});

await test('core ambiguous us wala asks clarification with zero provider calls', async () => {
  const pool = createPool({
    plans: [
      { id: '17', title: 'Prescription Plan' },
      { id: '21', title: 'Exercise Plan' },
    ],
    initialState: {
      ...emptyAgentSessionState(),
      lastReferencedEntities: [
        { type: 'care_plan', id: '17' },
        { type: 'care_plan', id: '21' },
      ],
    },
  });
  const provider = zeroCallProvider();
  const result = await handleAgentMessage({
    pool, userId: USER, sessionId: SESSION_ID, message: 'us wala kholo', provider: provider.provider,
  });
  assert.equal(result.ok, true);
  assert.equal(result.fallbackCode, 'AGENT_REFERENCE_AMBIGUOUS');
  assert.equal(result.navigation, null);
  assert.equal(provider.calls, 0);
});

await test('core rejects planner id that disagrees with resolved currentFocus', async () => {
  const pool = createPool({
    plans: [
      { id: '17', title: 'Prescription Plan' },
      { id: '21', title: 'Exercise Plan' },
    ],
    initialState: {
      ...emptyAgentSessionState(),
      currentFocus: { type: 'care_plan', id: '17' },
    },
  });
  const provider = plannedProvider({
    intent: 'get_simulation',
    capabilityCalls: [{ name: 'get_simulation', args: { planId: '21' } }],
    navigationIntent: null,
  });
  const result = await handleAgentMessage({
    pool, userId: USER, sessionId: SESSION_ID, message: 'iski simulation?', provider: provider.provider,
  });
  assert.equal(result.ok, true);
  assert.equal(result.fallbackCode, 'AGENT_REFERENCE_MISMATCH');
  assert.equal(provider.calls.plan, 1);
  assert.equal(provider.calls.reply, 0);
  assert.deepEqual(pool.state.currentFocus, { type: 'care_plan', id: '17' });
});

await test('pronoun prefers verified screen entity when it is relevant', async () => {
  const result = await resolveAgentConversationReference({
    pool: createPool(), userId: USER, message: 'iska detail batao',
    screenEntity: { type: 'care_gap', id: '5', title: 'Timing Gap' },
    currentFocus: { type: 'care_plan', id: '17', title: 'Prescription Plan' },
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.source, 'screen_entity');
  assert.equal(result.entity.id, '5');
});

await test('pronoun falls back to currentFocus when there is no screen entity', async () => {
  const result = await resolveAgentConversationReference({
    pool: createPool(), userId: USER, message: 'iski simulation?',
    currentFocus: { type: 'care_plan', id: '17', title: 'Prescription Plan' },
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.source, 'current_focus');
  assert.equal(result.entity.id, '17');
});

await test('single verified recent entity can resolve a pronoun', async () => {
  const result = await resolveAgentConversationReference({
    pool: createPool(), userId: USER, message: 'ye wala kholo',
    recentEntities: [{ type: 'care_plan', id: '17', title: 'Prescription Plan' }],
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.entity.id, '17');
});

await test('same plan type hint does not bind to an unrelated care-gap screen entity', async () => {
  const result = await resolveAgentConversationReference({
    pool: createPool(), userId: USER, message: 'same plan kholo',
    screenEntity: { type: 'care_gap', id: '5', title: 'Timing Gap' },
    currentFocus: { type: 'care_plan', id: '17', title: 'Prescription Plan' },
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.entity.type, 'care_plan');
  assert.equal(result.entity.id, '17');
});

await test('exact resolved care-plan binding is accepted', async () => {
  const reviewed = reviewPlanAgainstResolvedReference({
    resolution: { status: 'resolved', entity: { type: 'care_plan', id: '17' } },
    plan: {
      capabilityCalls: [{ name: 'get_simulation', args: { planId: '17' } }],
      navigationIntent: null,
    },
  });
  assert.equal(reviewed.ok, true);
});

await test('exact resolved care-gap binding is accepted', async () => {
  const reviewed = reviewPlanAgainstResolvedReference({
    resolution: { status: 'resolved', entity: { type: 'care_gap', id: '5' } },
    plan: {
      capabilityCalls: [{ name: 'get_care_gap_detail', args: { gapId: '5' } }],
      navigationIntent: null,
    },
  });
  assert.equal(reviewed.ok, true);
});

await test('resolved navigation cannot switch to a different id', async () => {
  const reviewed = reviewPlanAgainstResolvedReference({
    resolution: { status: 'resolved', entity: { type: 'care_plan', id: '17' } },
    plan: {
      capabilityCalls: [],
      navigationIntent: { target: 'care_plan_detail', params: { carePlanId: '21' } },
    },
  });
  assert.equal(reviewed.ok, false);
  assert.equal(reviewed.code, 'AGENT_REFERENCE_MISMATCH');
});

await test('care-gap list result stores a bounded ordered care-gap reference list', async () => {
  const list = deriveVerifiedOrderedEntityList([{ name: 'get_care_gaps', result: {
    ok: true,
    data: { gaps: [{ id: '5', title: 'Gap A' }, { id: '6', title: 'Gap B' }] },
  } }]);
  assert.deepEqual(list, {
    kind: 'care_gap',
    entities: [
      { type: 'care_gap', id: '5' },
      { type: 'care_gap', id: '6' },
    ],
  });
});

await test('non-list capability result does not fabricate an ordered list', async () => {
  const list = deriveVerifiedOrderedEntityList([{ name: 'get_simulation', result: {
    ok: true, data: { readiness: 85 },
  } }]);
  assert.equal(list, undefined);
});

await test('navigation intent memory is normalized by the server', async () => {
  assert.equal(
    deriveServerNormalizedIntent({ navigation: { target: 'care_plan_detail', params: { carePlanId: '17' } } }),
    'navigate_care_plan_detail',
  );
});

await test('invalid free-form lastIntent is not persisted as structured memory', async () => {
  const state = sanitizeAgentSessionState({ lastIntent: 'User probably wants medicine advice' }).state;
  assert.equal(state.lastIntent, null);
});

await test('invalid capability-memory labels are filtered', async () => {
  const state = sanitizeAgentSessionState({
    lastCapabilityNames: ['get_simulation', 'BAD TOOL VALUE', 'get_care_plan'],
  }).state;
  assert.deepEqual(state.lastCapabilityNames, ['get_simulation', 'get_care_plan']);
});

await test('ordered-list kind is closed to supported conversation entity types', async () => {
  const state = sanitizeAgentSessionState({
    recentOrderedEntityList: {
      kind: 'document',
      entities: [{ type: 'care_plan', id: '17' }],
    },
  }).state;
  assert.equal(state.recentOrderedEntityList, null);
});

await test('cross-user remembered focus is dropped during ownership revalidation', async () => {
  const pool = createPool({ plans: [{ id: '17', title: 'Owned by user 42' }] });
  const context = await readAgentConversationStateContext({
    pool,
    userId: '77',
    sessionState: {
      ...emptyAgentSessionState(),
      currentFocus: { type: 'care_plan', id: '17' },
      lastReferencedEntities: [{ type: 'care_plan', id: '17' }],
    },
  });
  assert.equal(context.currentFocus, null);
  assert.deepEqual(context.recentEntities, []);
});

await test('an arbitrary number is not treated as an ordinal/database reference', async () => {
  const result = await resolveAgentConversationReference({
    pool: createPool(), userId: USER, message: '17',
    recentOrderedEntityList: {
      kind: 'care_plan',
      entities: [{ type: 'care_plan', id: '17', title: 'Prescription Plan' }],
    },
  });
  assert.equal(result.status, 'none');
});

await test('second one resolves the second verified ordered entity', async () => {
  const result = await resolveAgentConversationReference({
    pool: createPool(), userId: USER, message: 'second one kholo',
    recentOrderedEntityList: {
      kind: 'care_plan',
      entities: [
        { type: 'care_plan', id: '17', title: 'Prescription Plan' },
        { type: 'care_plan', id: '21', title: 'Exercise Plan' },
      ],
    },
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.entity.id, '21');
});

await test('provider context never exposes pending draft/confirmation payloads', async () => {
  const slice = buildAgentContextSlice({
    language: 'en',
    sessionState: pendingDummyState(),
    conversationContext: {
      currentFocus: null,
      recentEntities: [],
      recentOrderedEntityList: null,
      lastIntent: null,
      lastCapabilityNames: [],
    },
  });
  assert.equal('pendingDraft' in slice, false);
  assert.equal('pendingConfirmation' in slice, false);
});

await test('newer ordered-list state survives a stale CAS write', async () => {
  const pool = createPool({ initialState: {
    ...emptyAgentSessionState(),
    recentOrderedEntityList: {
      kind: 'care_plan',
      entities: [{ type: 'care_plan', id: '17' }],
    },
  } });
  const stale = pool.state;
  const newer = {
    ...stale,
    recentOrderedEntityList: {
      kind: 'care_plan',
      entities: [{ type: 'care_plan', id: '21' }],
    },
  };
  assert.equal((await updateAgentSessionState({
    db: pool, userId: USER, sessionId: SESSION_ID, state: newer, expectedState: stale,
  })).ok, true);
  const conflict = await updateAgentSessionState({
    db: pool, userId: USER, sessionId: SESSION_ID,
    state: { ...stale, lastIntent: 'get_care_plan' }, expectedState: stale,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.data.session.state.recentOrderedEntityList.entities[0].id, '21');
});

await test('unknown factual-memory fields such as readiness or dose are dropped', async () => {
  const state = sanitizeAgentSessionState({
    currentFocus: { type: 'care_plan', id: '17' },
    readinessScore: 85,
    medicineDose: '10 mg',
    previousReply: 'Readiness was 85%.',
  }).state;
  assert.equal('readinessScore' in state, false);
  assert.equal('medicineDose' in state, false);
  assert.equal('previousReply' in state, false);
});

await test('raw model/user objects cannot create currentFocus through derivation', async () => {
  assert.equal(
    deriveVerifiedCurrentFocus({ successfulCapabilityCalls: [{ name: 'chat', args: { id: '17' } }] }),
    undefined,
  );
});

console.log(`\nPhase E tests passed: ${passed}`);
