/**
 * Phase B Agent Core tests (no HTTP server, no real database, no real LLM).
 *
 * Covers the takeover-sensitive integration points:
 *   - importing Agent Core registers the Phase B READ capabilities
 *   - empty messages fail before a session is created
 *   - canonical roman_ur crosses the existing display-language boundary
 *   - READ capabilities execute through authoritative services and audit
 *   - semantic navigation verifies ownership before emission
 *   - exact facts are substituted only from the deterministic fact registry
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  defineAgentCapability,
  executeAgentCapability,
  listAgentCapabilities,
  validateAgentCapabilityInput,
} from './agent/agent_capability_registry.js';
import { readAgentScreenContext } from './agent/agent_context_engine.js';
import { handleAgentMessage } from './agent/agent_core.js';
import { createAgentProvider } from './agent/agent_provider.js';
import {
  buildAgentPlannerPrompts,
  planAgentMessage,
  validateAgentPlan,
} from './agent/agent_planner.js';
import {
  buildAgentReplyPrompts,
  createAgentFactRegistry,
  generateGroundedAgentReply,
  registerCapabilityResultFacts,
  validateAndSubstituteAgentTemplate,
} from './agent/agent_response_grounder.js';
import { emptyAgentSessionState } from './agent/agent_session_state.js';

const USER = '42';
const SESSION_ID = '501';
const TODAY = '2026-09-03';
const OK_PACKET = { affectedRows: 1, insertId: 0 };

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function sessionRow({ language = 'en', state = emptyAgentSessionState() } = {}) {
  return {
    id: Number(SESSION_ID),
    user_id: Number(USER),
    language,
    state_json: JSON.stringify(state),
    created_at: '2026-09-03 10:00:00',
    last_active_at: '2026-09-03 10:00:00',
    expires_at: '2026-09-03 14:00:00',
  };
}

function createFakePool({
  preferredLanguage = 'en',
  occurrenceRows = [],
  activePlans = [],
  careGaps = [],
  gapCount = 0,
  throwOnOccurrenceRead = false,
} = {}) {
  const calls = [];
  let row = sessionRow({ language: preferredLanguage });

  const execute = async (sql, params = []) => {
    const text = normalizeSql(sql);
    calls.push({ sql: text, params });

    if (text.startsWith('SELECT preferred_language FROM patient_profiles')) {
      return [[{ preferred_language: preferredLanguage }]];
    }

    if (text.startsWith('INSERT INTO agent_sessions')) {
      row = sessionRow({ language: params[1] });
      return [{ affectedRows: 1, insertId: Number(SESSION_ID) }];
    }

    if (text.startsWith('UPDATE agent_sessions SET state_json')) {
      row = { ...row, state_json: params[0] };
      return [OK_PACKET];
    }

    if (text.startsWith('UPDATE agent_sessions SET last_active_at')) {
      return [OK_PACKET];
    }

    if (text.startsWith('UPDATE agent_sessions SET language')) {
      row = { ...row, language: params[0] };
      return [OK_PACKET];
    }

    if (text.startsWith('SELECT id FROM agent_sessions WHERE id = ? AND user_id = ? LIMIT 1')) {
      return params[1] === USER ? [[{ id: Number(SESSION_ID) }]] : [[]];
    }

    if (text.includes('FROM agent_sessions WHERE id = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP')) {
      return params[1] === USER ? [[row]] : [[]];
    }

    if (text.startsWith('INSERT INTO agent_action_audit')) {
      return [{ affectedRows: 1, insertId: calls.length }];
    }

    if (text.includes('COUNT(*) AS open_count')) {
      return [[{ open_count: gapCount }]];
    }

    if (text.startsWith('SELECT care_plans.*,')) {
      return [activePlans];
    }

    if (text.startsWith('SELECT id, title, readiness_score FROM care_plans')) {
      return [activePlans];
    }

    if (text.includes('p.title AS plan_title')) {
      if (throwOnOccurrenceRead) throw new Error('performance read failed');
      return [occurrenceRows];
    }

    if (text.startsWith('SELECT id, title FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1')) {
      const plan = activePlans.find((item) => String(item.id) === String(params[0]));
      return plan ? [[{ id: plan.id, title: plan.title }]] : [[]];
    }

    if (text.includes('FROM care_gaps WHERE id = ? AND care_plan_id IN')) {
      const gap = careGaps.find((item) => String(item.id) === String(params[0]));
      return gap ? [[gap]] : [[]];
    }

    if (/^SELECT|^WITH|^SHOW|^DESCRIBE/i.test(text)) return [[]];
    return [OK_PACKET];
  };

  return {
    execute,
    calls,
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

function mockProvider({ plan, replyTemplate }) {
  const calls = { plan: 0, reply: 0 };
  return createAgentProvider({
    generateJson: async ({ systemPrompt, preferredLanguage }) => {
      if (systemPrompt.includes('planning stage')) {
        calls.plan += 1;
        return {
          json: plan,
          model: 'mock-planner',
          provider: 'mock',
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      calls.reply += 1;
      return {
        json: { messageTemplate: replyTemplate(preferredLanguage) },
        model: 'mock-reply',
        provider: 'mock',
        inputTokens: 0,
        outputTokens: 0,
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

function countingMockProvider({ plan, replyTemplate }) {
  const calls = { plan: 0, reply: 0 };
  const provider = createAgentProvider({
    generateJson: async ({ systemPrompt, preferredLanguage }) => {
      if (systemPrompt.includes('planning stage')) {
        calls.plan += 1;
        return {
          json: plan,
          model: 'mock-planner',
          provider: 'mock',
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      calls.reply += 1;
      return {
        json: { messageTemplate: replyTemplate(preferredLanguage) },
        model: 'mock-reply',
        provider: 'mock',
        inputTokens: 0,
        outputTokens: 0,
      };
    },
    configuration: () => ({
      configured: true,
      provider: 'mock',
      model: 'mock',
      message: null,
    }),
  });
  return { provider, calls };
}

process.env.AGENT_ENABLED = 'true';

await test('Agent Core import registers the Agent capability catalog', async () => {
  const names = listAgentCapabilities().map((capability) => capability.name).sort();
  assert.deepEqual(names, [
    'compare_performance',
    'confirm_schedule_item_time',
    'draft_next_task_outcome',
    'draft_schedule_time',
    'draft_task_outcome',
    'get_care_gap_detail',
    'get_care_gaps',
    'get_care_plan',
    'get_care_plans',
    'get_next_task',
    'get_performance_summary',
    'get_plan_progress',
    'get_reality_check',
    'get_routine_preferences',
    'get_simulation',
    'get_today_tasks',
    'set_task_outcome',
  ].sort());
});

await test('capability registry rejects unknown tools and model-supplied userId', async () => {
  const pool = createFakePool();
  const unknown = await executeAgentCapability({
    name: 'invented_tool',
    pool,
    userId: USER,
    args: {},
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_CAPABILITY');
  assert.equal(pool.calls.length, 0);

  const capability = listAgentCapabilities()
    .find((item) => item.name === 'get_today_tasks');
  const invalid = validateAgentCapabilityInput(capability, { userId: '999' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID_CAPABILITY_ARGS');
});

await test('planner validation rejects more than three calls and non-executable future tools', async () => {
  const tooMany = validateAgentPlan({
    intent: 'too_many_reads',
    capabilityCalls: [
      { name: 'get_today_tasks', args: {} },
      { name: 'get_next_task', args: {} },
      { name: 'get_care_plans', args: {} },
      { name: 'get_routine_preferences', args: {} },
    ],
    navigationIntent: null,
  });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, 'AGENT_TOO_MANY_CAPABILITY_CALLS');

  defineAgentCapability({
    name: 'sensitive_future_change_for_test',
    permissionClass: 'SENSITIVE_ACTION',
    description: 'A test-only sensitive capability that must not execute in a normal turn.',
    inputSchema: { properties: {}, required: [] },
    execute: () => {
      throw new Error('Sensitive capability must not execute in a normal turn');
    },
    resultContract: '{ never: true }',
  });
  const futureTool = validateAgentPlan({
    intent: 'try_future_sensitive_action',
    capabilityCalls: [{ name: 'sensitive_future_change_for_test', args: {} }],
    navigationIntent: null,
  });
  assert.equal(futureTool.ok, false);
  assert.equal(futureTool.code, 'AGENT_PERMISSION_CLASS_NOT_EXECUTABLE');
  assert.equal(futureTool.permissionClass, 'SENSITIVE_ACTION');
});

await test('planner/provider malformed output and unknown capability plans fail safely', async () => {
  const providerFailure = await planAgentMessage({
    provider: createAgentProvider({
      configuration: () => ({
        configured: false,
        provider: 'mock',
        model: 'mock',
        message: 'mock unconfigured',
      }),
      generateJson: async () => ({ json: {}, model: 'mock', provider: 'mock' }),
    }),
    message: 'Meri performance kesi hai?',
    contextSlice: {},
  });
  assert.equal(providerFailure.ok, false);
  assert.equal(providerFailure.code, 'AGENT_PROVIDER_UNCONFIGURED');

  const malformed = await planAgentMessage({
    provider: createAgentProvider({
      generateJson: async () => ({
        json: { capabilityCalls: [] },
        model: 'mock',
        provider: 'mock',
      }),
    }),
    message: 'Meri performance kesi hai?',
    contextSlice: {},
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'AGENT_PLAN_INVALID');

  const unknown = validateAgentPlan({
    intent: 'invented',
    capabilityCalls: [{ name: 'made_up_tool', args: {} }],
    navigationIntent: null,
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_CAPABILITY');
});

await test('planner prompt distinguishes open care gaps from screen navigation', async () => {
  const prompts = buildAgentPlannerPrompts({
    message: 'mere open care gaps list karo',
    contextSlice: {},
  });

  assert.match(prompts.systemPrompt, /open care gaps.*mean lifecycle=open, not opening a screen/i);
  assert.match(prompts.systemPrompt, /care gaps batao.*READ requests, not navigation requests/i);
  assert.match(prompts.systemPrompt, /For a general care-gap READ.*call get_care_plans/i);
  assert.match(prompts.systemPrompt, /Do not invent a planId/i);
});

await test('planner accepts routine settings as explicit navigation intent', async () => {
  const planned = validateAgentPlan({
    intent: 'open_routine_settings',
    capabilityCalls: [],
    navigationIntent: { target: 'routine_settings', params: {} },
  });

  assert.equal(planned.ok, true);
  assert.deepEqual(planned.plan.navigationIntent, {
    target: 'routine_settings',
    params: {},
  });
});

await test('planner can use get_care_plans for general care-gap reads without planId', async () => {
  const planned = validateAgentPlan({
    intent: 'read_general_care_gaps',
    capabilityCalls: [{ name: 'get_care_plans', args: {} }],
    navigationIntent: null,
  });

  assert.equal(planned.ok, true);
  assert.deepEqual(planned.plan.capabilityCalls, [
    { name: 'get_care_plans', args: {} },
  ]);
});

await test('planner can use get_care_gaps lifecycle=open with safe single-plan context', async () => {
  const prompts = buildAgentPlannerPrompts({
    message: 'mere open care gaps list karo',
    contextSlice: {
      currentEntity: { type: 'care_plan', id: '7', title: 'Prescription Care Plan' },
      recentEntities: [],
    },
  });
  assert.match(prompts.systemPrompt, /exactly one owned care_plan id is safely resolved/i);
  assert.match(prompts.systemPrompt, /get_care_gaps.*lifecycle="open"/i);

  const planned = validateAgentPlan({
    intent: 'read_open_care_gaps_for_plan',
    capabilityCalls: [{ name: 'get_care_gaps', args: { planId: '7', lifecycle: 'open' } }],
    navigationIntent: null,
  });

  assert.equal(planned.ok, true);
  assert.deepEqual(planned.plan.capabilityCalls, [
    { name: 'get_care_gaps', args: { planId: '7', lifecycle: 'open' } },
  ]);
});

await test('handleAgentMessage rejects an empty message before creating a session', async () => {
  const pool = createFakePool();
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    message: '   ',
    provider: mockProvider({
      plan: { intent: 'unused', capabilityCalls: [], navigationIntent: null },
      replyTemplate: () => 'unused',
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AGENT_MESSAGE_EMPTY');
  assert.equal(pool.calls.length, 0);
});

await test('canonical roman_ur fallback uses the existing Roman Urdu display boundary', async () => {
  process.env.AGENT_ENABLED = 'false';
  const pool = createFakePool({ preferredLanguage: 'roman_ur' });
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    message: 'hello',
    provider: mockProvider({
      plan: { intent: 'unused', capabilityCalls: [], navigationIntent: null },
      replyTemplate: () => 'unused',
    }),
  });
  process.env.AGENT_ENABLED = 'true';

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AGENT_DISABLED');
  assert.match(result.message, /filhal available nahi hai/i);
});

await test('foreign plan and gap screen context are dropped without leaking data', async () => {
  const pool = createFakePool({
    activePlans: [{ id: 7, title: 'Owned Plan', readiness_score: 80 }],
    careGaps: [
      {
        id: 3,
        care_plan_id: 7,
        title: 'Owned Gap',
        lifecycle_status: 'open',
        severity: 'attention',
      },
    ],
  });

  const foreignPlan = await readAgentScreenContext({
    pool,
    userId: USER,
    clientContext: {
      screenId: 'care_plan_detail',
      entity: { type: 'care_plan', id: '999' },
    },
  });
  assert.equal(foreignPlan.ok, true);
  assert.equal(foreignPlan.screenContext.screenId, 'care_plan_detail');
  assert.equal(foreignPlan.screenContext.entity, null);
  assert.ok(foreignPlan.notices.includes('entity_dropped'));

  const foreignGap = await readAgentScreenContext({
    pool,
    userId: USER,
    clientContext: {
      screenId: 'care_gap_detail',
      entity: { type: 'care_gap', id: '999' },
    },
  });
  assert.equal(foreignGap.ok, true);
  assert.equal(foreignGap.screenContext.screenId, 'care_gap_detail');
  assert.equal(foreignGap.screenContext.entity, null);
  assert.ok(foreignGap.notices.includes('entity_dropped'));
});

await test('foreign session id is rejected before planning', async () => {
  const pool = createFakePool();
  const provider = mockProvider({
    plan: { intent: 'should_not_plan', capabilityCalls: [], navigationIntent: null },
    replyTemplate: () => 'unused',
  });
  const result = await handleAgentMessage({
    pool,
    userId: '99',
    sessionId: SESSION_ID,
    message: 'hello',
    provider,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AGENT_SESSION_NOT_FOUND');
  assert.ok(!pool.calls.some((call) => call.sql.includes('INSERT INTO agent_action_audit')));
});

await test('clarification zero-tool plan does not invent an entity id', async () => {
  const pool = createFakePool();
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    message: 'Us care gap ko kholo.',
    provider: mockProvider({
      plan: {
        intent: 'clarify_entity_reference',
        capabilityCalls: [],
        navigationIntent: null,
      },
      replyTemplate: () => 'Which care gap should I open?',
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.navigation, null);
  assert.deepEqual(result.referencedEntities, []);
  assert.ok(!pool.calls.some((call) => call.sql.startsWith('SELECT id, title FROM care_plans')));
  assert.ok(!pool.calls.some((call) => call.sql.includes('FROM care_gaps WHERE id = ?')));
});

await test('general care-gap read without planId uses owned care-plan summaries', async () => {
  const pool = createFakePool({
    preferredLanguage: 'roman_ur',
    activePlans: [{
      id: 7,
      title: 'Prescription Care Plan',
      status: 'active',
      readiness_score: 85,
      open_gap_count: 1,
      document_count: 1,
      task_count: 4,
      updated_at: '2026-09-03 10:00:00',
    }],
  });

  const result = await handleAgentMessage({
    pool,
    userId: USER,
    message: 'mere open care gaps list karo',
    provider: mockProvider({
      plan: {
        intent: 'read_general_care_gaps',
        capabilityCalls: [{ name: 'get_care_plans', args: {} }],
        navigationIntent: null,
      },
      replyTemplate: () =>
        '{{fact:c1_plans_1_title}} mein {{fact:c1_plans_1_openGapCount}} open care gap hai. Individual gap details ke liye plan open/select karna hoga.',
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.reply,
    'Prescription Care Plan mein 1 open care gap hai. Individual gap details ke liye plan open/select karna hoga.',
  );
  assert.equal(result.navigation, null);
  assert.ok(
    pool.calls.some((call) =>
      call.sql.startsWith('SELECT care_plans.*,') &&
      call.params[0] === USER),
  );
  assert.ok(!pool.calls.some((call) => call.sql.includes('FROM care_gaps WHERE care_plan_id = ?')));
  assert.doesNotMatch(result.reply, /verified data nahi mila|refresh karein/i);
});

await test('navigation-only turn returns deterministic localized reply without reply provider', async () => {
  const pool = createFakePool({ preferredLanguage: 'roman_ur' });
  const { provider, calls } = countingMockProvider({
    plan: {
      intent: 'open_routine_settings',
      capabilityCalls: [],
      navigationIntent: { target: 'routine_settings', params: {} },
    },
    replyTemplate: () => 'abhi koi capability results nahi hain',
  });

  const result = await handleAgentMessage({
    pool,
    userId: USER,
    message: 'routine settings kholo',
    provider,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.plan, 1);
  assert.equal(calls.reply, 0);
  assert.equal(result.reply, 'Routine settings kholne ke liye neeche Kholein dabayein.');
  assert.deepEqual(result.navigation, {
    target: 'routine_settings',
    params: {},
  });
  assert.equal(result.fallbackCode, undefined);
});

await test('READ capability execution is audited and exact 14:00 facts are backend-grounded', async () => {
  const pool = createFakePool({
    preferredLanguage: 'en',
    activePlans: [{ id: 7, title: 'Demo Plan', readiness_score: 85 }],
    occurrenceRows: [
      {
        id: 12,
        care_plan_id: 7,
        schedule_item_id: 102,
        occurrence_date: TODAY,
        scheduled_time: '14:00',
        status: 'pending',
        completed_at: null,
        completed_time: null,
        outcome_source: 'user',
        note: '',
        title: 'DemoMed Beta',
        task_kind: 'medicine',
        display_time: 'Afternoon',
        recurrence_text: 'Daily',
        grounding: 'explicit',
        plan_title: 'Demo Plan',
      },
    ],
  });

  const result = await handleAgentMessage({
    pool,
    userId: USER,
    message: 'Aaj mera next task kya hai?',
    provider: mockProvider({
      plan: {
        intent: 'read_today_tasks',
        capabilityCalls: [{ name: 'get_today_tasks', args: { date: TODAY } }],
        navigationIntent: null,
      },
      replyTemplate: () =>
        'Your verified task is {{fact:c1_occurrences_1_title}} at {{fact:c1_occurrences_1_scheduledTime}}.',
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.reply, 'Your verified task is DemoMed Beta at 14:00.');
  assert.equal(result.fallbackCode, undefined);
  assert.ok(
    pool.calls.some((call) =>
      call.sql.startsWith('INSERT INTO agent_action_audit') &&
      call.params.includes('get_today_tasks') &&
      call.params.includes('READ') &&
      call.params.includes(1)),
  );
});

await test('GAP_NOT_FOUND short-circuits to fallback and skips reply generation', async () => {
  const pool = createFakePool({ preferredLanguage: 'en' });
  const { provider, calls } = countingMockProvider({
    plan: {
      intent: 'read_gap',
      capabilityCalls: [{ name: 'get_care_gap_detail', args: { gapId: '999' } }],
      navigationIntent: null,
    },
    replyTemplate: () => 'This should never be generated.',
  });

  const result = await handleAgentMessage({
    pool,
    userId: USER,
    message: '2 PM wala issue batao.',
    provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.fallbackCode, 'GAP_NOT_FOUND');
  assert.match(result.reply, /could not complete/i);
  assert.equal(calls.plan, 1);
  assert.equal(calls.reply, 0);
  assert.ok(
    pool.calls.some((call) =>
      call.sql.startsWith('INSERT INTO agent_action_audit') &&
      call.params.includes('get_care_gap_detail') &&
      call.params.includes('rejected') &&
      call.params.includes(0) &&
      call.params.includes('GAP_NOT_FOUND')),
  );
});

await test('failed performance read short-circuits without an invented performance answer', async () => {
  const pool = createFakePool({ throwOnOccurrenceRead: true });
  const { provider, calls } = countingMockProvider({
    plan: {
      intent: 'read_performance',
      capabilityCalls: [{ name: 'get_performance_summary', args: {} }],
      navigationIntent: null,
    },
    replyTemplate: () => 'Your performance is excellent.',
  });

  const result = await handleAgentMessage({
    pool,
    userId: USER,
    message: 'Meri performance kesi hai?',
    provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.fallbackCode, 'AGENT_CAPABILITY_FAILED');
  assert.doesNotMatch(result.reply, /excellent/i);
  assert.equal(calls.reply, 0);
  assert.ok(
    pool.calls.some((call) =>
      call.sql.startsWith('INSERT INTO agent_action_audit') &&
      call.params.includes('get_performance_summary') &&
      call.params.includes('failed') &&
      call.params.includes(0)),
  );
});

await test('semantic navigation verifies resource ownership before emitting params', async () => {
  const pool = createFakePool({
    preferredLanguage: 'en',
    activePlans: [{ id: 7, title: 'Demo Plan', readiness_score: 85 }],
  });

  const result = await handleAgentMessage({
    pool,
    userId: USER,
    message: 'Show my care plan.',
    provider: mockProvider({
      plan: {
        intent: 'open_care_plan',
        capabilityCalls: [],
        navigationIntent: { target: 'care_plan_detail', params: { carePlanId: '7' } },
      },
      replyTemplate: () => 'Opening your care plan.',
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.navigation, {
    target: 'care_plan_detail',
    params: { carePlanId: '7' },
  });
  assert.deepEqual(result.referencedEntities[0], {
    type: 'care_plan',
    id: '7',
    title: 'Demo Plan',
  });
  assert.ok(
    pool.calls.some((call) =>
      call.sql.startsWith('SELECT id, title FROM care_plans') &&
      call.params[0] === '7' &&
      call.params[1] === USER),
  );
});

await test('grounding rejects unknown fact ids and preserves exact placeholder values', async () => {
  const registry = createAgentFactRegistry();
  assert.equal(registry.register({ factId: 'score', value: 85 }).ok, true);
  const unknown = validateAndSubstituteAgentTemplate({
    registry,
    template: 'Score {{fact:missing_score}}.',
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'AGENT_FACT_UNKNOWN');

  const valid = validateAndSubstituteAgentTemplate({
    registry,
    template: 'Score {{fact:score}}.',
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.reply, 'Score 85.');
});

await test('grounding requires placeholders for exact times, doses, and percentages', async () => {
  const registry = createAgentFactRegistry();
  assert.equal(registry.register({ factId: 'betaName', value: 'DemoMed Beta' }).ok, true);
  assert.equal(registry.register({ factId: 'betaTime', value: '14:00' }).ok, true);
  assert.equal(registry.register({ factId: 'exerciseTime', value: '18:30' }).ok, true);
  assert.equal(registry.register({ factId: 'unrelatedCount', value: 5 }).ok, true);
  assert.equal(registry.register({ factId: 'score', value: 85 }).ok, true);

  const wrongAssociation = validateAndSubstituteAgentTemplate({
    registry,
    template: '{{fact:betaName}} is scheduled at 18:30.',
  });
  assert.equal(wrongAssociation.ok, false);
  assert.equal(wrongAssociation.code, 'AGENT_FACT_CONFLICT');
  assert.equal(wrongAssociation.kind, 'time');

  const correctTime = validateAndSubstituteAgentTemplate({
    registry,
    template: '{{fact:betaName}} is scheduled at {{fact:betaTime}}.',
  });
  assert.equal(correctTime.ok, true);
  assert.equal(correctTime.reply, 'DemoMed Beta is scheduled at 14:00.');

  const dose = validateAndSubstituteAgentTemplate({
    registry,
    template: 'The dose is 5 mg.',
  });
  assert.equal(dose.ok, false);
  assert.equal(dose.code, 'AGENT_FACT_CONFLICT');
  assert.equal(dose.kind, 'dose');

  const percent = validateAndSubstituteAgentTemplate({
    registry,
    template: 'Simulation is 85%.',
  });
  assert.equal(percent.ok, false);
  assert.equal(percent.code, 'AGENT_FACT_CONFLICT');
  assert.equal(percent.kind, 'percent');

  const placeholderScore = validateAndSubstituteAgentTemplate({
    registry,
    template: 'Simulation score is {{fact:score}}.',
  });
  assert.equal(placeholderScore.ok, true);
  assert.equal(placeholderScore.reply, 'Simulation score is 85.');
});

await test('grounding rejects literal canonical task names and statuses', async () => {
  const registry = createAgentFactRegistry();
  assert.equal(registry.register({ factId: 'betaName', value: 'DemoMed Beta' }).ok, true);
  assert.equal(registry.register({ factId: 'betaTime', value: '14:00' }).ok, true);
  assert.equal(registry.register({ factId: 'betaStatus', value: 'pending' }).ok, true);

  const literalName = validateAndSubstituteAgentTemplate({
    registry,
    template: 'DemoMed Beta is scheduled at {{fact:betaTime}}.',
  });
  assert.equal(literalName.ok, false);
  assert.equal(literalName.code, 'AGENT_FACT_CONFLICT');
  assert.equal(literalName.kind, 'canonical');
  assert.equal(literalName.factId, 'betaName');

  const correctName = validateAndSubstituteAgentTemplate({
    registry,
    template: '{{fact:betaName}} is scheduled at {{fact:betaTime}}.',
  });
  assert.equal(correctName.ok, true);
  assert.equal(correctName.reply, 'DemoMed Beta is scheduled at 14:00.');

  const literalStatus = validateAndSubstituteAgentTemplate({
    registry,
    template: '{{fact:betaName}} is pending.',
  });
  assert.equal(literalStatus.ok, false);
  assert.equal(literalStatus.code, 'AGENT_FACT_CONFLICT');
  assert.equal(literalStatus.factId, 'betaStatus');

  const placeholderStatus = validateAndSubstituteAgentTemplate({
    registry,
    template: '{{fact:betaName}} status is {{fact:betaStatus}}.',
  });
  assert.equal(placeholderStatus.ok, true);
  assert.equal(placeholderStatus.reply, 'DemoMed Beta status is pending.');
});

await test('grounding fails closed for a raw entity label with a verified time placeholder', async () => {
  const registry = createAgentFactRegistry();
  assert.equal(registry.register({ factId: 'betaName', value: 'DemoMed Beta' }).ok, true);
  assert.equal(registry.register({ factId: 'betaTime', value: '14:00' }).ok, true);

  const inventedLabel = validateAndSubstituteAgentTemplate({
    registry,
    template: 'DemoMed Gamma is scheduled at {{fact:betaTime}}.',
  });
  assert.equal(inventedLabel.ok, false);
  assert.equal(inventedLabel.code, 'AGENT_FACT_CONFLICT');
  assert.equal(inventedLabel.kind, 'canonical');
  assert.equal(inventedLabel.literal, 'entity label');

  const bypass = validateAndSubstituteAgentTemplate({
    registry,
    template:
      'DemoMed Gamma is scheduled at {{fact:betaTime}}.\nVerified medicine: {{fact:betaName}}.',
  });
  assert.equal(bypass.ok, false);
  assert.equal(bypass.code, 'AGENT_FACT_CONFLICT');
  assert.equal(bypass.kind, 'canonical');
  assert.equal(bypass.literal, 'entity label');
  assert.equal(bypass.factId, 'betaTime');
});

await test('grounding binds entity names and sensitive facts by matching fact group', async () => {
  const registry = createAgentFactRegistry();
  assert.equal(registry.register({ factId: 'alphaName', value: 'DemoMed Alpha' }).ok, true);
  assert.equal(registry.register({ factId: 'alphaTime', value: '07:30' }).ok, true);
  assert.equal(registry.register({ factId: 'betaName', value: 'DemoMed Beta' }).ok, true);
  assert.equal(registry.register({ factId: 'betaTime', value: '14:00' }).ok, true);

  const correctPairs = validateAndSubstituteAgentTemplate({
    registry,
    template:
      '{{fact:alphaName}} is scheduled at {{fact:alphaTime}}. {{fact:betaName}} is scheduled at {{fact:betaTime}}.',
  });
  assert.equal(correctPairs.ok, true);
  assert.equal(
    correctPairs.reply,
    'DemoMed Alpha is scheduled at 07:30. DemoMed Beta is scheduled at 14:00.',
  );

  const crossPair = validateAndSubstituteAgentTemplate({
    registry,
    template: '{{fact:alphaName}} is scheduled at {{fact:betaTime}}.',
  });
  assert.equal(crossPair.ok, false);
  assert.equal(crossPair.code, 'AGENT_FACT_CONFLICT');
  assert.equal(crossPair.kind, 'canonical');
  assert.equal(crossPair.literal, 'entity label');
  assert.equal(crossPair.factId, 'betaTime');
});

await test('grounding source-qualifies entity groups across capability calls', async () => {
  const registry = createAgentFactRegistry();
  const first = registerCapabilityResultFacts({
    registry,
    callIndex: 1,
    capabilityName: 'get_today_tasks',
    result: {
      ok: true,
      data: {
        occurrences: [{
          title: 'DemoMed Alpha',
          scheduledTime: '07:30',
        }],
      },
    },
  });
  const second = registerCapabilityResultFacts({
    registry,
    callIndex: 2,
    capabilityName: 'get_today_tasks',
    result: {
      ok: true,
      data: {
        occurrences: [{
          title: 'DemoMed Beta',
          scheduledTime: '14:00',
        }],
      },
    },
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const c1Pair = validateAndSubstituteAgentTemplate({
    registry,
    template: '{{fact:c1_occurrences_1_title}} is scheduled at {{fact:c1_occurrences_1_scheduledTime}}.',
  });
  assert.equal(c1Pair.ok, true);
  assert.equal(c1Pair.reply, 'DemoMed Alpha is scheduled at 07:30.');

  const c2Pair = validateAndSubstituteAgentTemplate({
    registry,
    template: '{{fact:c2_occurrences_1_title}} is scheduled at {{fact:c2_occurrences_1_scheduledTime}}.',
  });
  assert.equal(c2Pair.ok, true);
  assert.equal(c2Pair.reply, 'DemoMed Beta is scheduled at 14:00.');

  const c1TitleC2Time = validateAndSubstituteAgentTemplate({
    registry,
    template: '{{fact:c1_occurrences_1_title}} is scheduled at {{fact:c2_occurrences_1_scheduledTime}}.',
  });
  assert.equal(c1TitleC2Time.ok, false);
  assert.equal(c1TitleC2Time.code, 'AGENT_FACT_CONFLICT');
  assert.equal(c1TitleC2Time.factId, 'c2_occurrences_1_scheduledTime');

  const c2TitleC1Time = validateAndSubstituteAgentTemplate({
    registry,
    template: '{{fact:c2_occurrences_1_title}} is scheduled at {{fact:c1_occurrences_1_scheduledTime}}.',
  });
  assert.equal(c2TitleC1Time.ok, false);
  assert.equal(c2TitleC1Time.code, 'AGENT_FACT_CONFLICT');
  assert.equal(c2TitleC1Time.factId, 'c1_occurrences_1_scheduledTime');
});

await test('grounding normalizes Urdu-script digits during exact literal validation only', async () => {
  const registry = createAgentFactRegistry();
  assert.equal(registry.register({ factId: 'betaName', value: 'DemoMed Beta' }).ok, true);
  assert.equal(registry.register({ factId: 'betaTime', value: '14:00' }).ok, true);

  const arabicIndic = validateAndSubstituteAgentTemplate({
    registry,
    template: '{{fact:betaName}} ka time ١٤:٠٠ hai.',
  });
  assert.equal(arabicIndic.ok, false);
  assert.equal(arabicIndic.code, 'AGENT_FACT_CONFLICT');
  assert.equal(arabicIndic.kind, 'time');

  const easternArabic = validateAndSubstituteAgentTemplate({
    registry,
    template: '{{fact:betaName}} ka time ۱۴:۰۰ hai.',
  });
  assert.equal(easternArabic.ok, false);
  assert.equal(easternArabic.code, 'AGENT_FACT_CONFLICT');
  assert.equal(easternArabic.kind, 'time');

  const urduPlaceholder = validateAndSubstituteAgentTemplate({
    registry,
    template: '{{fact:betaName}} کا وقت {{fact:betaTime}} ہے۔',
  });
  assert.equal(urduPlaceholder.ok, true);
  assert.equal(urduPlaceholder.reply, 'DemoMed Beta کا وقت 14:00 ہے۔');
});

await test('reply prompts redact canonical raw values but keep placeholders visible', async () => {
  const prompts = buildAgentReplyPrompts({
    language: 'en',
    message: 'Aaj mera next task kya hai?',
    contextSlice: {},
    capabilityResults: [{
      name: 'get_today_tasks',
      result: {
        ok: true,
        data: {
          occurrences: [{
            title: 'DemoMed Beta',
            scheduledTime: '14:00',
            status: 'pending',
            reason: 'Take after lunch',
          }],
        },
      },
    }],
  });

  assert.doesNotMatch(prompts.userPrompt, /DemoMed Beta/);
  assert.doesNotMatch(prompts.userPrompt, /14:00/);
  assert.doesNotMatch(prompts.userPrompt, /\bpending\b/);
  assert.match(prompts.userPrompt, /\{\{fact:c1_occurrences_1_title\}\}/);
  assert.match(prompts.userPrompt, /\{\{fact:c1_occurrences_1_scheduledTime\}\}/);
  assert.match(prompts.userPrompt, /Take after lunch/);
});

await test('reply prompts make server-authoritative language mandatory', async () => {
  const roman = buildAgentReplyPrompts({
    language: 'roman_ur',
    message: 'Pichlay 7 din aur 30 din compare karo.',
    contextSlice: {},
    capabilityResults: [],
  });
  assert.match(roman.systemPrompt, /Mandatory output language: Roman Urdu \(canonical roman_ur\)/);
  assert.match(roman.systemPrompt, /All user-facing natural-language prose.*Roman Urdu/i);
  assert.match(roman.systemPrompt, /entire explanatory sentences must not silently switch to English/i);
  assert.doesNotMatch(roman.systemPrompt, /Mandatory output language: English \(canonical en\)/);
  assert.doesNotMatch(roman.userPrompt, /Reply language: English/);

  const urdu = buildAgentReplyPrompts({
    language: 'ur',
    message: 'Meri performance kesi hai?',
    contextSlice: {},
    capabilityResults: [],
  });
  assert.match(urdu.systemPrompt, /Mandatory output language: Urdu \(canonical ur\)/);
  assert.match(urdu.systemPrompt, /Urdu script/);
});

await test('reply prompt forbids raw internal machine labels', async () => {
  const prompts = buildAgentReplyPrompts({
    language: 'roman_ur',
    message: 'Compare performance',
    contextSlice: {},
    capabilityResults: [],
  });
  assert.match(prompts.systemPrompt, /insufficient_data/);
  assert.match(prompts.systemPrompt, /snake_case status values/);
  assert.match(prompts.systemPrompt, /Explain their meaning naturally/);

  const registry = createAgentFactRegistry();
  const rawLabel = validateAndSubstituteAgentTemplate({
    registry,
    template: 'Comparison direction is insufficient_data.',
  });
  assert.equal(rawLabel.ok, false);
  assert.equal(rawLabel.code, 'AGENT_FACT_CONFLICT');
  assert.equal(rawLabel.kind, 'internal_label');

  assert.equal(
    registry.register({
      factId: 'c1_periods_comparison_direction',
      value: 'insufficient_data',
    }).ok,
    true,
  );
  const placeholderLabel = validateAndSubstituteAgentTemplate({
    registry,
    template: 'Trend {{fact:c1_periods_comparison_direction}} hai.',
  });
  assert.equal(placeholderLabel.ok, false);
  assert.equal(placeholderLabel.code, 'AGENT_FACT_CONFLICT');
  assert.equal(placeholderLabel.kind, 'internal_label');
  assert.equal(placeholderLabel.literal, 'insufficient_data');
});

await test('internal semantic enum facts are explained without raw placeholder leakage', async () => {
  const prompts = buildAgentReplyPrompts({
    language: 'roman_ur',
    message: 'Pichlay 7 din aur 30 din compare karo.',
    contextSlice: {},
    capabilityResults: [{
      name: 'compare_performance',
      result: {
        ok: true,
        data: {
          periods: {
            comparison: {
              direction: 'insufficient_data',
            },
          },
        },
      },
    }],
  });

  assert.doesNotMatch(prompts.userPrompt, /insufficient_data/);
  assert.match(
    prompts.userPrompt,
    /there is not enough verified data to determine a trend/,
  );
  assert.doesNotMatch(
    prompts.userPrompt,
    /use \{\{fact:c1_periods_comparison_direction\}\}/,
  );

  const reply = await generateGroundedAgentReply({
    provider: createAgentProvider({
      generateJson: async () => ({
        json: {
          messageTemplate:
            'Is waqt trend clear nahi hai kyun ke enough verified data available nahi.',
        },
        model: 'mock',
        provider: 'mock',
      }),
    }),
    language: 'roman_ur',
    message: 'Pichlay 7 din aur 30 din compare karo.',
    contextSlice: {},
    capabilityResults: [{
      name: 'compare_performance',
      result: {
        ok: true,
        data: {
          periods: {
            comparison: {
              direction: 'insufficient_data',
            },
          },
        },
      },
    }],
  });

  assert.equal(reply.ok, true);
  assert.doesNotMatch(reply.reply, /insufficient_data/);
});

await test('care gap internal state can be explained without leaking enum labels', async () => {
  const reply = await generateGroundedAgentReply({
    provider: createAgentProvider({
      generateJson: async () => ({
        json: {
          messageTemplate:
            'Care gap ko attention chahiye; app verified details ke mutabiq is par nazar rakhni chahiye.',
        },
        model: 'mock',
        provider: 'mock',
      }),
    }),
    language: 'roman_ur',
    message: 'Care gaps batao.',
    contextSlice: {},
    capabilityResults: [{
      name: 'get_care_gaps',
      result: {
        ok: true,
        data: {
          gaps: [{
            state: 'needs_attention',
          }],
        },
      },
    }],
  });

  assert.equal(reply.ok, true);
  assert.doesNotMatch(reply.reply, /needs_attention/);
});

await test('empty capability results reject invented missing-data and refresh claims', async () => {
  const prompts = buildAgentReplyPrompts({
    language: 'roman_ur',
    message: 'routine settings kholo',
    contextSlice: {},
    capabilityResults: [],
  });
  assert.match(prompts.systemPrompt, /Do not claim verified data was missing/i);
  assert.match(prompts.systemPrompt, /refresh is needed/i);
  assert.match(prompts.systemPrompt, /unless a verified capability result explicitly says that/i);

  const reply = await generateGroundedAgentReply({
    provider: createAgentProvider({
      generateJson: async () => ({
        json: {
          messageTemplate:
            'Verified data nahi mila; routine settings se refresh karein.',
        },
        model: 'mock',
        provider: 'mock',
      }),
    }),
    language: 'roman_ur',
    message: 'routine settings kholo',
    contextSlice: {},
    capabilityResults: [],
  });

  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'AGENT_REPLY_INVALID');
});

await test('successful care-plan results still reject invented missing-data and refresh claims', async () => {
  const reply = await generateGroundedAgentReply({
    provider: createAgentProvider({
      generateJson: async () => ({
        json: {
          messageTemplate:
            'Verified data nahi mila; refresh karein.',
        },
        model: 'mock',
        provider: 'mock',
      }),
    }),
    language: 'roman_ur',
    message: 'mere open care gaps list karo',
    contextSlice: {},
    capabilityResults: [{
      name: 'get_care_plans',
      result: {
        ok: true,
        data: {
          plans: [{
            title: 'Prescription Care Plan',
            openGapCount: 1,
          }],
        },
      },
    }],
  });

  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'AGENT_REPLY_INVALID');
});

await test('reply language validation fails closed for Urdu and Roman Urdu script mismatches', async () => {
  const urduMismatch = await generateGroundedAgentReply({
    provider: createAgentProvider({
      generateJson: async () => ({
        json: { messageTemplate: 'I compared your recent performance.' },
        model: 'mock',
        provider: 'mock',
      }),
    }),
    language: 'ur',
    message: 'Meri performance kesi hai?',
    contextSlice: {},
    capabilityResults: [],
  });
  assert.equal(urduMismatch.ok, false);
  assert.equal(urduMismatch.code, 'AGENT_REPLY_LANGUAGE_MISMATCH');

  const romanMismatch = await generateGroundedAgentReply({
    provider: createAgentProvider({
      generateJson: async () => ({
        json: { messageTemplate: 'میں نے آپ کی performance compare کی۔' },
        model: 'mock',
        provider: 'mock',
      }),
    }),
    language: 'roman_ur',
    message: 'Meri performance kesi hai?',
    contextSlice: {},
    capabilityResults: [],
  });
  assert.equal(romanMismatch.ok, false);
  assert.equal(romanMismatch.code, 'AGENT_REPLY_LANGUAGE_MISMATCH');
});

await test('reply-stage malformed structured output fails safely', async () => {
  const malformed = await generateGroundedAgentReply({
    provider: createAgentProvider({
      generateJson: async () => ({
        json: { messageTemplate: 'ok', extra: 'not allowed' },
        model: 'mock',
        provider: 'mock',
      }),
    }),
    language: 'en',
    message: 'hello',
    contextSlice: {},
    capabilityResults: [],
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'AGENT_REPLY_INVALID');
});

await test('POST /api/agent/message route contract is auth and limiter guarded', async () => {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /app\.post\('\/api\/agent\/message', authenticate, agentLimiter, async \(req, res, next\) => \{/,
  );
  assert.match(source, /userId:\s*req\.auth\.userId/);
  assert.match(source, /sessionId:\s*req\.body\?\.sessionId \?\? null/);
  assert.match(source, /message:\s*req\.body\?\.message/);
  assert.doesNotMatch(source, /userId:\s*req\.body/);
  assert.doesNotMatch(source, /language:\s*req\.body/);
  assert.match(source, /AGENT_DISABLED:\s*503/);
});

console.log(`Phase B Agent tests passed (${passed} tests).`);
