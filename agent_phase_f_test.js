/** Phase F voice + safe navigation regression tests. */
import assert from 'node:assert/strict';

import { handleAgentMessage } from './agent/agent_core.js';
import { createAgentProvider } from './agent/agent_provider.js';
import {
  createAgentVoiceProvider,
  validateAgentVoiceAudio,
  VOICE_PROVIDER_LIMITS,
} from './agent/agent_voice_provider.js';
import {
  authorizeAgentNavigationIntent,
  validateAgentNavigationIntent,
} from './agent/agent_navigation_registry.js';
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
const AUDIO_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
const TTS_MODEL = 'fish-audio/s2.1-pro-free:free';

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
    title: 'Morning exercise',
    task_kind: 'care_task',
    display_time: 'Morning',
    recurrence_text: 'Daily',
    grounding: 'suggested',
    ...overrides,
  };
}

function createFakePool({
  initialState = emptyAgentSessionState(),
  preferredLanguage = 'Roman Urdu',
  plans = [{ id: 7, title: 'Prescription Plan' }],
  gaps = [{ id: 9, planId: 7, title: 'Missing timing' }],
} = {}) {
  const calls = [];
  const auditRows = [];
  let row = sessionRow(initialState, 'roman_ur');
  let taskMutationCount = 0;
  const execute = async (sql, params = []) => {
    const text = normalizeSql(sql);
    calls.push({ sql: text, params });
    if (text.startsWith('SELECT preferred_language FROM patient_profiles')) {
      return [[{ preferred_language: preferredLanguage }]];
    }
    if (text.startsWith('UPDATE agent_sessions SET last_active_at')) {
      return [{ affectedRows: 1 }];
    }
    if (text.startsWith('UPDATE agent_sessions SET language')) {
      row = { ...row, language: params[0] };
      return [{ affectedRows: 1 }];
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
    if (text.includes('FROM care_gaps') && text.includes('LIMIT 1')) {
      const gap = gaps.find(
        (item) => String(item.id) === String(params[0]) && String(params[1]) === USER,
      );
      return [gap ? [{ id: Number(gap.id), care_plan_id: Number(gap.planId), title: gap.title }] : []];
    }
    if (text.includes('FROM care_task_occurrences o') && text.includes('WHERE o.id = ? AND o.user_id = ?')) {
      return [[occurrence()]];
    }
    if (text.includes('FROM care_task_outcome_operations')) {
      return [[]];
    }
    if (text.startsWith('UPDATE care_task_occurrences')) {
      taskMutationCount += 1;
      return [{ affectedRows: 1 }];
    }
    if (/^SELECT|^WITH|^SHOW|^DESCRIBE/i.test(text)) return [[]];
    return [{ affectedRows: 1, insertId: 1 }];
  };
  return {
    execute,
    getConnection: async () => ({
      execute,
      beginTransaction: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    }),
    calls,
    auditRows,
    get state() {
      return JSON.parse(row.state_json);
    },
    get taskMutationCount() {
      return taskMutationCount;
    },
  };
}

function config(overrides = {}) {
  return {
    enabled: true,
    apiKey: 'sk-or-test',
    audioModel: AUDIO_MODEL,
    ttsModel: TTS_MODEL,
    ttsVoice: '',
    appUrl: 'https://sehatmate.test',
    ...overrides,
  };
}

function responseJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function responseAudio(bytes = Buffer.from('mp3-bytes'), status = 200) {
  return new Response(bytes, {
    status,
    headers: { 'content-type': 'audio/mpeg' },
  });
}

function voiceProvider({ fetchImpl, configOverrides = {} } = {}) {
  return createAgentVoiceProvider({
    fetchImpl,
    config: () => config(configOverrides),
    timeoutMs: 25,
  });
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

function pendingTaskState({ confirmationId = 'conf-task' } = {}) {
  return {
    ...emptyAgentSessionState(),
    pendingConfirmation: {
      confirmationId,
      kind: 'task_outcome',
      message: 'Skip "Morning exercise".',
      expiresAt: FUTURE,
    },
    pendingDraft: {
      confirmationId,
      toolName: 'set_task_outcome',
      kind: 'task_outcome',
      occurrenceId: '11',
      outcome: 'skipped',
      note: '',
      baseStatus: 'pending',
      targetLabel: 'Morning exercise',
      message: 'Skip "Morning exercise".',
      expiresAt: FUTURE,
    },
  };
}

await test('voice audio validation rejects empty audio', () => {
  const result = validateAgentVoiceAudio({
    audioBuffer: Buffer.alloc(0),
    contentType: 'audio/mp4',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VOICE_EMPTY_AUDIO');
});

await test('voice audio validation rejects unsupported audio', () => {
  const result = validateAgentVoiceAudio({
    audioBuffer: Buffer.from('x'),
    contentType: 'audio/wav',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VOICE_UNSUPPORTED_AUDIO');
});

await test('voice audio validation rejects over-limit audio', () => {
  const result = validateAgentVoiceAudio({
    audioBuffer: Buffer.alloc(VOICE_PROVIDER_LIMITS.maxAudioBytes + 1),
    contentType: 'audio/mp4',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VOICE_AUDIO_TOO_LARGE');
});

await test('VOICE_AGENT_ENABLED=false fails safely', async () => {
  const result = await voiceProvider({ configOverrides: { enabled: false } }).transcribeAudio({
    audioBuffer: Buffer.from('audio'),
    contentType: 'audio/mp4',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VOICE_AGENT_DISABLED');
});

await test('missing OpenRouter API key fails safely', async () => {
  const result = await voiceProvider({ configOverrides: { apiKey: '' } }).transcribeAudio({
    audioBuffer: Buffer.from('audio'),
    contentType: 'audio/mp4',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VOICE_PROVIDER_UNCONFIGURED');
});

await test('configured audio model is used exactly with no hidden fallback', async () => {
  const requests = [];
  const provider = voiceProvider({
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return responseJson({ choices: [{ message: { content: '{"transcript":"Aaj mera next task kya hai?"}' } }] });
    },
  });
  const result = await provider.transcribeAudio({
    audioBuffer: Buffer.from('audio'),
    contentType: 'audio/mp4',
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, AUDIO_MODEL);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, AUDIO_MODEL);
  assert.equal(requests[0].body.model.includes('whisper'), false);
});

await test('transcription request contains only bounded transcription context and audio', async () => {
  let body;
  const provider = voiceProvider({
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return responseJson({ choices: [{ message: { content: '{"transcript":"Care plans kholo"}' } }] });
    },
  });
  await provider.transcribeAudio({
    audioBuffer: Buffer.from('audio'),
    contentType: 'audio/mp4',
    language: 'roman_ur',
  });
  const serialized = JSON.stringify(body);
  assert.equal(body.messages.length, 2);
  assert.match(serialized, /input_audio/);
  assert.doesNotMatch(serialized, /userId|user_id|currentFocus|pendingConfirmation|confirmationId|carePlanId/);
});

await test('provider timeout is normalized', async () => {
  const provider = voiceProvider({
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  const result = await provider.transcribeAudio({
    audioBuffer: Buffer.from('audio'),
    contentType: 'audio/mp4',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VOICE_PROVIDER_TIMEOUT');
});

await test('rate limit is normalized', async () => {
  const provider = voiceProvider({
    fetchImpl: async () => responseJson({ error: { message: 'rate limited' } }, 429),
  });
  const result = await provider.transcribeAudio({
    audioBuffer: Buffer.from('audio'),
    contentType: 'audio/mp4',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VOICE_PROVIDER_RATE_LIMITED');
});

await test('malformed provider response is rejected', async () => {
  const provider = voiceProvider({
    fetchImpl: async () => new Response('not json', { status: 200 }),
  });
  const result = await provider.transcribeAudio({
    audioBuffer: Buffer.from('audio'),
    contentType: 'audio/mp4',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VOICE_PROVIDER_MALFORMED');
});

await test('successful transcription produces bounded text', async () => {
  const provider = voiceProvider({
    fetchImpl: async () => responseJson({ choices: [{ message: { content: '{"transcript":"  haan  "}' } }] }),
  });
  const result = await provider.transcribeAudio({
    audioBuffer: Buffer.from('audio'),
    contentType: 'audio/mp4',
  });
  assert.deepEqual(
    { ok: result.ok, transcript: result.transcript },
    { ok: true, transcript: 'haan' },
  );
});

await test('transcription endpoint/provider executes zero Agent capabilities or navigation', async () => {
  let providerCalls = 0;
  const provider = voiceProvider({
    fetchImpl: async () => {
      providerCalls += 1;
      return responseJson({ choices: [{ message: { content: '{"transcript":"Skip exercise"}' } }] });
    },
  });
  const pool = createFakePool();
  const result = await provider.transcribeAudio({
    audioBuffer: Buffer.from('audio'),
    contentType: 'audio/mp4',
  });
  assert.equal(result.ok, true);
  assert.equal(providerCalls, 1);
  assert.equal(pool.calls.length, 0);
  assert.equal(pool.auditRows.length, 0);
  assert.equal(pool.taskMutationCount, 0);
});

await test('spoken action creates Phase D draft rather than mutation after normal Agent flow', async () => {
  const pool = createFakePool();
  const planned = plannedProvider({
    intent: 'skip_task',
    capabilityCalls: [{ name: 'draft_task_outcome', args: { occurrenceId: '11', outcome: 'skipped' } }],
    navigationIntent: null,
  });
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    sessionId: SESSION_ID,
    message: 'Aaj wali exercise skip kar do',
    provider: planned.provider,
  });
  assert.equal(result.ok, true);
  assert.equal(result.actionStatus, 'awaiting_confirmation');
  assert.ok(result.confirmation?.confirmationId);
  assert.equal(pool.taskMutationCount, 0);
});

await test('spoken bare haan with pending confirmation preserves Phase E zero-provider decision path', async () => {
  const pool = createFakePool({ initialState: pendingTaskState() });
  let providerCalls = 0;
  const provider = createAgentProvider({
    generateJson: async () => {
      providerCalls += 1;
      throw new Error('provider must not be called');
    },
    configuration: () => ({ configured: true, provider: 'mock', model: 'mock', message: null }),
  });
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    sessionId: SESSION_ID,
    message: 'haan',
    provider,
  });
  assert.equal(result.ok, true);
  assert.equal(result.actionStatus, 'confirmed');
  assert.equal(providerCalls, 0);
  assert.equal(pool.taskMutationCount, 1);
});

await test('spoken bare haan with no pending confirmation causes zero mutation', async () => {
  const pool = createFakePool();
  let providerCalls = 0;
  const provider = createAgentProvider({
    generateJson: async () => {
      providerCalls += 1;
      throw new Error('provider must not be called');
    },
    configuration: () => ({ configured: true, provider: 'mock', model: 'mock', message: null }),
  });
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    sessionId: SESSION_ID,
    message: 'haan',
    provider,
  });
  assert.equal(result.ok, true);
  assert.equal(result.actionStatus, 'rejected');
  assert.equal(providerCalls, 0);
  assert.equal(pool.taskMutationCount, 0);
});

await test('spoken cancel preserves Phase E cancellation path', async () => {
  const pool = createFakePool({ initialState: pendingTaskState() });
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    sessionId: SESSION_ID,
    message: 'nahi',
    provider: plannedProvider({ intent: 'unused', capabilityCalls: [], navigationIntent: null }).provider,
  });
  assert.equal(result.ok, true);
  assert.equal(result.actionStatus, 'cancelled');
  assert.equal(pool.taskMutationCount, 0);
});

await test('configured TTS model is used exactly with no fallback and exact approved reply', async () => {
  let body;
  const provider = voiceProvider({
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return responseAudio();
    },
  });
  const result = await provider.synthesizeApprovedReply({
    reply: 'Confirmed. The change was saved.',
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, TTS_MODEL);
  assert.equal(body.model, TTS_MODEL);
  assert.equal(body.input, 'Confirmed. The change was saved.');
  assert.equal(body.response_format, 'mp3');
});

await test('TTS failure does not modify action/session safety state', async () => {
  const provider = voiceProvider({
    fetchImpl: async () => responseJson({ error: { message: 'failed' } }, 500),
  });
  const pool = createFakePool({ initialState: pendingTaskState() });
  const before = JSON.stringify(pool.state);
  const result = await provider.synthesizeApprovedReply({ reply: 'Safe reply.' });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(pool.state), before);
  assert.equal(pool.taskMutationCount, 0);
});

await test('typed safe navigation still works through closed registry', async () => {
  const pool = createFakePool();
  const authorized = await authorizeAgentNavigationIntent({
    intent: { target: 'care_plans', params: {} },
    pool,
    userId: USER,
  });
  assert.equal(authorized.ok, true);
  assert.deepEqual(authorized.navigation, { target: 'care_plans', params: {} });
  assert.equal(pool.taskMutationCount, 0);
});

await test('voice navigation uses same registered navigation path after transcript', async () => {
  const pool = createFakePool();
  const planned = plannedProvider({
    intent: 'open_care_plans',
    capabilityCalls: [],
    navigationIntent: { target: 'care_plans', params: {} },
  });
  const result = await handleAgentMessage({
    pool,
    userId: USER,
    sessionId: SESSION_ID,
    message: 'Mujhe care plans par le jao',
    provider: planned.provider,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.navigation, { target: 'care_plans', params: {} });
  assert.equal(pool.taskMutationCount, 0);
});

await test('unknown navigation destination and arbitrary route strings are rejected', () => {
  assert.equal(validateAgentNavigationIntent({ target: '/admin', params: {} }).ok, false);
  assert.equal(
    validateAgentNavigationIntent({
      target: 'care_plans',
      params: { route: '/care-plans' },
    }).ok,
    false,
  );
});

await test('entity-specific navigation revalidates ownership', async () => {
  const owned = await authorizeAgentNavigationIntent({
    intent: { target: 'care_plan_detail', params: { carePlanId: '7' } },
    pool: createFakePool(),
    userId: USER,
  });
  assert.equal(owned.ok, true);

  const foreign = await authorizeAgentNavigationIntent({
    intent: { target: 'care_plan_detail', params: { carePlanId: '7' } },
    pool: createFakePool(),
    userId: OTHER_USER,
  });
  assert.equal(foreign.ok, false);
});

await test('entity-type mismatch cannot navigate', async () => {
  const result = await authorizeAgentNavigationIntent({
    intent: { target: 'care_plan_detail', params: { careGapId: '9' } },
    pool: createFakePool(),
    userId: USER,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_NAVIGATION_INTENT');
});

await test('navigation cannot bypass Phase D confirmation or mutate by itself', async () => {
  const pool = createFakePool({ initialState: pendingTaskState() });
  const result = await authorizeAgentNavigationIntent({
    intent: { target: 'care_gaps', params: { carePlanId: '7' } },
    pool,
    userId: USER,
  });
  assert.equal(result.ok, true);
  assert.equal(pool.taskMutationCount, 0);
  assert.ok(pool.state.pendingConfirmation);
});

console.log(`Agent Phase F tests passed (${passed} tests).`);
