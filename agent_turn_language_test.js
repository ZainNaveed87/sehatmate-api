/** Phase E/F multilingual turn-language regression tests. */
import assert from 'node:assert/strict';

import { handleAgentMessage } from './agent/agent_core.js';
import { createAgentProvider } from './agent/agent_provider.js';
import { generateGroundedAgentReply } from './agent/agent_response_grounder.js';
import {
  emptyAgentSessionState,
  sanitizeAgentSessionState,
  serializeAgentSessionState,
} from './agent/agent_session_state.js';
import {
  detectAgentTurnLanguage,
  resolveAgentTurnLanguage,
} from './agent/agent_turn_language.js';

process.env.AGENT_ENABLED = 'true';

const USER = '42';
const OTHER_USER = '77';
const SESSION_ID = '501';
const FUTURE = '2999-01-01T00:00:00.000Z';
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

function sessionRow({
  state = emptyAgentSessionState(),
  language = 'en',
} = {}) {
  const sanitized = sanitizeAgentSessionState(state);
  return {
    id: Number(SESSION_ID),
    user_id: Number(USER),
    language,
    state_json: serializeAgentSessionState(
      sanitized.ok ? sanitized.state : emptyAgentSessionState(),
    ),
    created_at: '2026-09-06 10:00:00',
    last_active_at: '2026-09-06 10:00:00',
    expires_at: '2999-09-06 10:00:00',
  };
}

function carePlanRow(overrides = {}) {
  return {
    id: 7,
    title: 'Prescription Plan',
    status: 'active',
    start_date: null,
    readiness_score: 80,
    understanding_score: 0,
    activated_at: null,
    completed_at: null,
    completion_reason: null,
    completed_by: null,
    duration_mode: 'prescription',
    suggested_end_date: null,
    planned_end_date: null,
    created_at: '2026-09-06 09:00:00',
    updated_at: '2026-09-06 09:00:00',
    document_count: 0,
    task_count: 2,
    open_gap_count: 0,
    setup_step: 'complete',
    ...overrides,
  };
}

function occurrenceRow(overrides = {}) {
  return {
    id: 11,
    user_id: Number(USER),
    care_plan_id: 7,
    schedule_item_id: 31,
    occurrence_date: '2026-09-06',
    scheduled_time: '08:00',
    status: 'pending',
    completed_at: null,
    completed_time: null,
    outcome_source: 'system',
    note: '',
    title: 'Morning walk',
    task_kind: 'care_task',
    display_time: 'Morning',
    recurrence_text: 'Daily',
    grounding: 'suggested',
    ...overrides,
  };
}

function createPool({
  preferredLanguage = 'English',
  initialState = emptyAgentSessionState(),
  sessionLanguage = 'en',
  plans = [carePlanRow()],
} = {}) {
  const calls = [];
  const auditRows = [];
  let row = sessionRow({ state: initialState, language: sessionLanguage });
  let taskMutationCount = 0;
  const execute = async (sql, params = []) => {
    const text = normalizeSql(sql);
    calls.push({ sql: text, params });

    if (text.startsWith('SELECT preferred_language FROM patient_profiles')) {
      return [[{ preferred_language: preferredLanguage }]];
    }

    if (text.startsWith('INSERT INTO agent_sessions')) {
      row = sessionRow({ state: emptyAgentSessionState(), language: params[1] });
      return [{ affectedRows: 1, insertId: Number(SESSION_ID) }];
    }

    if (text.startsWith('UPDATE agent_sessions SET language')) {
      row = { ...row, language: params[0] };
      return [OK_PACKET];
    }

    if (text.startsWith('UPDATE agent_sessions SET last_active_at')) {
      return [OK_PACKET];
    }

    if (text.startsWith('UPDATE agent_sessions SET state_json')) {
      const expected = params[3];
      if (expected !== undefined && row.state_json !== expected) {
        return [{ affectedRows: 0 }];
      }
      row = { ...row, state_json: params[0] };
      return [OK_PACKET];
    }

    if (text.includes('FROM agent_sessions WHERE id = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP')) {
      return String(params[0]) === SESSION_ID && String(params[1]) === USER
        ? [[row]]
        : [[]];
    }

    if (text.startsWith('SELECT id FROM agent_sessions WHERE id = ? AND user_id = ? LIMIT 1')) {
      return String(params[0]) === SESSION_ID && String(params[1]) === USER
        ? [[{ id: Number(SESSION_ID) }]]
        : [[]];
    }

    if (text.startsWith('INSERT INTO agent_action_audit')) {
      auditRows.push(params);
      return [{ affectedRows: 1, insertId: auditRows.length }];
    }

    if (text.startsWith('SELECT id, title FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1')) {
      const plan = plans.find(
        (item) => String(item.id) === String(params[0]) && String(params[1]) === USER,
      );
      return [plan ? [{ id: Number(plan.id), title: plan.title }] : []];
    }

    if (text.startsWith('SELECT care_plans.*,')) {
      return [plans];
    }

    if (text.includes('FROM care_task_occurrences o') && text.includes('WHERE o.id = ? AND o.user_id = ?')) {
      return [[occurrenceRow()]];
    }

    if (text.includes('FROM care_task_outcome_operations')) {
      return [[]];
    }

    if (text.startsWith('UPDATE care_task_occurrences')) {
      taskMutationCount += 1;
      return [OK_PACKET];
    }

    if (text.startsWith('INSERT IGNORE INTO care_task_outcome_operations')) {
      return [OK_PACKET];
    }

    if (/^SELECT|^WITH|^SHOW|^DESCRIBE/i.test(text)) return [[]];
    return [OK_PACKET];
  };

  return {
    execute,
    calls,
    auditRows,
    get state() {
      return JSON.parse(row.state_json);
    },
    get sessionLanguage() {
      return row.language;
    },
    get taskMutationCount() {
      return taskMutationCount;
    },
    async getConnection() {
      return {
        execute,
        beginTransaction: async () => undefined,
        commit: async () => undefined,
        rollback: async () => undefined,
        release: () => undefined,
      };
    },
  };
}

function planProvider(plan, { mismatch = false, capture = null } = {}) {
  const calls = { plan: 0, reply: 0 };
  const provider = createAgentProvider({
    generateJson: async ({ systemPrompt, userPrompt, preferredLanguage }) => {
      if (systemPrompt.includes('planning stage')) {
        calls.plan += 1;
        capture?.planPrompts?.push(userPrompt);
        return { json: plan, model: 'mock-planner', provider: 'mock' };
      }
      calls.reply += 1;
      capture?.replyLanguages?.push(preferredLanguage);
      if (mismatch) {
        return {
          json: { messageTemplate: 'Your care plans include {{fact:c1_plans_1_title}}.' },
          model: 'mock-reply',
          provider: 'mock',
        };
      }
      const messageTemplate = preferredLanguage === 'Urdu'
        ? 'آپ کے care plans میں {{fact:c1_plans_1_title}} شامل ہے۔'
        : preferredLanguage === 'Roman Urdu'
          ? 'Aap ke care plans mein {{fact:c1_plans_1_title}} shamil hai.'
          : 'Your care plans include {{fact:c1_plans_1_title}}.';
      return {
        json: { messageTemplate },
        model: 'mock-reply',
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
  return { provider, calls };
}

function zeroProvider() {
  let calls = 0;
  return {
    provider: createAgentProvider({
      generateJson: async () => {
        calls += 1;
        throw new Error('provider should not be called');
      },
      configuration: () => ({
        configured: true,
        provider: 'mock',
        model: 'mock',
        message: null,
      }),
    }),
    get calls() {
      return calls;
    },
  };
}

function pendingTaskState({ lastTurnLanguage = 'en' } = {}) {
  return {
    ...emptyAgentSessionState(),
    lastTurnLanguage,
    pendingConfirmation: {
      confirmationId: 'confirm-1',
      kind: 'task_outcome',
      message: 'Mark "Morning walk" as completed.',
      expiresAt: FUTURE,
    },
    pendingDraft: {
      confirmationId: 'confirm-1',
      toolName: 'set_task_outcome',
      kind: 'task_outcome',
      occurrenceId: '11',
      outcome: 'completed',
      baseStatus: 'pending',
      targetLabel: 'Morning walk',
      message: 'Mark "Morning walk" as completed.',
      expiresAt: FUTURE,
    },
  };
}

const carePlanReadPlan = Object.freeze({
  intent: 'read_care_plans',
  capabilityCalls: [{ name: 'get_care_plans', args: {} }],
  navigationIntent: null,
});

await test('profile English + English message resolves English', () => {
  assert.equal(
    resolveAgentTurnLanguage({
      message: 'Show my care plans',
      profileLanguage: 'English',
    }).language,
    'en',
  );
});

await test('profile English + Roman Urdu message resolves Roman Urdu', () => {
  assert.equal(
    resolveAgentTurnLanguage({
      message: 'mere care plans dikhao',
      profileLanguage: 'English',
    }).language,
    'roman_ur',
  );
});

await test('profile English + Urdu-script message resolves Urdu', () => {
  assert.equal(
    resolveAgentTurnLanguage({
      message: 'میرے کیئر پلان دکھاؤ',
      profileLanguage: 'English',
    }).language,
    'ur',
  );
});

await test('profile Urdu + English message resolves English', () => {
  assert.equal(
    resolveAgentTurnLanguage({
      message: 'Show my care plans',
      profileLanguage: 'Urdu',
    }).language,
    'en',
  );
});

await test('profile Urdu + Roman Urdu message resolves Roman Urdu', () => {
  assert.equal(
    resolveAgentTurnLanguage({
      message: 'mujhe mera next task batao',
      profileLanguage: 'Urdu',
    }).language,
    'roman_ur',
  );
});

await test('profile Roman Urdu + English message resolves English', () => {
  assert.equal(
    resolveAgentTurnLanguage({
      message: 'Show my progress',
      profileLanguage: 'Roman Urdu',
    }).language,
    'en',
  );
});

await test('detector does not classify every Latin sentence as Roman Urdu', () => {
  assert.equal(detectAgentTurnLanguage('Show my care plans').language, 'en');
  assert.equal(detectAgentTurnLanguage('safe').language, null);
});

await test('Roman Urdu care-plan read succeeds when app/profile language is English', async () => {
  const capture = { planPrompts: [], replyLanguages: [] };
  const pool = createPool({ preferredLanguage: 'English', sessionLanguage: 'en' });
  const { provider } = planProvider(carePlanReadPlan, { capture });
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    message: 'mere care plan dikhao',
    provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.language, 'roman_ur');
  assert.equal(result.fallbackCode, undefined);
  assert.equal(
    result.reply,
    'Aap ke care plans mein Prescription Plan shamil hai.',
  );
  assert.deepEqual(capture.replyLanguages, ['Roman Urdu']);
  assert.match(capture.planPrompts[0], /"language":"roman_ur"/);
});

await test('Urdu-script care-plan read succeeds when app/profile language differs', async () => {
  const capture = { planPrompts: [], replyLanguages: [] };
  const pool = createPool({ preferredLanguage: 'Roman Urdu', sessionLanguage: 'roman_ur' });
  const { provider } = planProvider(carePlanReadPlan, { capture });
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    message: 'میرے کیئر پلان دکھاؤ',
    provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.language, 'ur');
  assert.equal(result.fallbackCode, undefined);
  assert.equal(result.reply, 'آپ کے care plans میں Prescription Plan شامل ہے۔');
  assert.deepEqual(capture.replyLanguages, ['Urdu']);
  assert.match(capture.planPrompts[0], /"language":"ur"/);
});

await test('grounded reply validation validates against detected turn language', async () => {
  const capture = { planPrompts: [], replyLanguages: [] };
  const pool = createPool({ preferredLanguage: 'English', sessionLanguage: 'en' });
  const { provider } = planProvider(carePlanReadPlan, { capture });
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    message: 'meri care plans dikhao',
    provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.language, 'roman_ur');
  assert.deepEqual(capture.replyLanguages, ['Roman Urdu']);
  assert.doesNotMatch(result.reply, /^Your care plans/i);
});

await test('clear language mismatch from provider fails closed', async () => {
  const capture = { planPrompts: [], replyLanguages: [] };
  const pool = createPool({ preferredLanguage: 'English', sessionLanguage: 'en' });
  const { provider } = planProvider(carePlanReadPlan, {
    mismatch: true,
    capture,
  });
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    message: 'mere care plans dikhao',
    provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.language, 'roman_ur');
  assert.equal(result.fallbackCode, 'AGENT_REPLY_LANGUAGE_MISMATCH');
  assert.match(result.reply, /Main abhi yeh request complete nahi kar saka/i);
  assert.deepEqual(capture.replyLanguages, ['Roman Urdu']);
});

await test('English reply validator rejects clear Roman Urdu provider prose', async () => {
  const result = await generateGroundedAgentReply({
    provider: createAgentProvider({
      generateJson: async () => ({
        json: { messageTemplate: 'Aap ke care plans ready hain.' },
        model: 'mock',
        provider: 'mock',
      }),
    }),
    language: 'en',
    message: 'Show my care plans',
    contextSlice: {},
    capabilityResults: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AGENT_REPLY_LANGUAGE_MISMATCH');
});

await test('conversation language detection never mutates profile preferred language', async () => {
  const pool = createPool({ preferredLanguage: 'English', sessionLanguage: 'en' });
  const { provider } = planProvider(carePlanReadPlan);
  await handleAgentMessage({
    pool,
    userId: USER,
    message: 'mere care plans dikhao',
    provider,
  });

  assert.ok(!pool.calls.some((call) => /^UPDATE patient_profiles\b/i.test(call.sql)));
});

await test('ambiguous short turn falls back to last turn language then profile language', () => {
  assert.equal(
    resolveAgentTurnLanguage({
      message: 'ok',
      lastTurnLanguage: 'roman_ur',
      profileLanguage: 'English',
    }).language,
    'roman_ur',
  );
  assert.equal(
    resolveAgentTurnLanguage({
      message: 'ok',
      profileLanguage: 'Urdu',
    }).language,
    'ur',
  );
});

await test('Roman Urdu turn followed by haan retains language/context', async () => {
  const pool = createPool({
    preferredLanguage: 'English',
    sessionLanguage: 'en',
    initialState: { ...emptyAgentSessionState(), lastTurnLanguage: 'roman_ur' },
  });
  const provider = zeroProvider();
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    sessionId: SESSION_ID,
    message: 'haan',
    provider: provider.provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.language, 'roman_ur');
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(provider.calls, 0);
});

await test('English turn followed by yes remains English', async () => {
  const pool = createPool({
    preferredLanguage: 'Urdu',
    sessionLanguage: 'ur',
    initialState: { ...emptyAgentSessionState(), lastTurnLanguage: 'en' },
  });
  const provider = zeroProvider();
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    sessionId: SESSION_ID,
    message: 'yes',
    provider: provider.provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.language, 'en');
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(provider.calls, 0);
});

await test('Urdu turn followed by Urdu-script haan remains Urdu', async () => {
  const pool = createPool({
    preferredLanguage: 'English',
    sessionLanguage: 'en',
    initialState: { ...emptyAgentSessionState(), lastTurnLanguage: 'ur' },
  });
  const provider = zeroProvider();
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    sessionId: SESSION_ID,
    message: 'ہاں',
    provider: provider.provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.language, 'ur');
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(provider.calls, 0);
});

await test('reference resolution works after Roman Urdu care-plan list memory', async () => {
  const pool = createPool({
    preferredLanguage: 'English',
    sessionLanguage: 'en',
    plans: [
      carePlanRow({ id: 7, title: 'Prescription Plan' }),
      carePlanRow({ id: 9, title: 'Exercise Plan', readiness_score: 70 }),
    ],
  });
  const first = planProvider(carePlanReadPlan);
  const firstResult = await handleAgentMessage({
    pool,
    userId: USER,
    message: 'mere care plans dikhao',
    provider: first.provider,
  });
  assert.equal(firstResult.ok, true);
  assert.equal(pool.state.recentOrderedEntityList.entities[0].id, '7');

  const second = planProvider({
    intent: 'open_first_care_plan',
    capabilityCalls: [],
    navigationIntent: { target: 'care_plan_detail', params: { carePlanId: '7' } },
  });
  const secondResult = await handleAgentMessage({
    pool,
    userId: USER,
    sessionId: SESSION_ID,
    message: 'pehla wala kholo',
    provider: second.provider,
  });

  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.language, 'roman_ur');
  assert.deepEqual(secondResult.navigation, {
    target: 'care_plan_detail',
    params: { carePlanId: '7' },
  });
});

await test('ambiguous reference still asks clarification and does not guess', async () => {
  const pool = createPool({
    preferredLanguage: 'English',
    sessionLanguage: 'roman_ur',
    initialState: {
      ...emptyAgentSessionState(),
      lastTurnLanguage: 'roman_ur',
      lastReferencedEntities: [
        { type: 'care_plan', id: '7' },
        { type: 'care_plan', id: '9' },
      ],
    },
    plans: [
      carePlanRow({ id: 7, title: 'Prescription Plan' }),
      carePlanRow({ id: 9, title: 'Exercise Plan' }),
    ],
  });
  const provider = zeroProvider();
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    sessionId: SESSION_ID,
    message: 'us wala kholo',
    provider: provider.provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.language, 'roman_ur');
  assert.equal(result.fallbackCode, 'AGENT_REFERENCE_AMBIGUOUS');
  assert.equal(result.navigation, null);
  assert.equal(provider.calls, 0);
  assert.match(result.reply, /Aap kis wale ki baat kar rahe hain/i);
});

await test('Phase D pending confirmation safety works across language switching', async () => {
  const pool = createPool({
    preferredLanguage: 'English',
    sessionLanguage: 'en',
    initialState: pendingTaskState({ lastTurnLanguage: 'en' }),
  });
  const provider = zeroProvider();
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    sessionId: SESSION_ID,
    message: 'haan',
    provider: provider.provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.language, 'roman_ur');
  assert.equal(result.actionStatus, 'confirmed');
  assert.equal(pool.taskMutationCount, 1);
  assert.equal(provider.calls, 0);
});

await test('voice transcript uses the same turn-language resolver', async () => {
  const pool = createPool({ preferredLanguage: 'English', sessionLanguage: 'en' });
  const { provider } = planProvider(carePlanReadPlan);
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    sessionId: SESSION_ID,
    message: 'mere care plans dikhao',
    provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.language, 'roman_ur');
  assert.match(result.reply, /Aap ke care plans/i);
});

await test('cross-user session ownership still fails before planning', async () => {
  const pool = createPool({ preferredLanguage: 'English', sessionLanguage: 'en' });
  const { provider, calls } = planProvider(carePlanReadPlan);
  const result = await handleAgentMessage({
    pool,
    userId: OTHER_USER,
    sessionId: SESSION_ID,
    message: 'mere care plans dikhao',
    provider,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AGENT_SESSION_NOT_FOUND');
  assert.equal(calls.plan, 0);
  assert.equal(calls.reply, 0);
});

console.log(`Agent turn-language tests passed (${passed} tests).`);
