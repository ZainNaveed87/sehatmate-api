/**
 * Phase A2 agent foundation tests (no HTTP, no real database).
 *
 * These tests exercise the agent configuration, session state contract,
 * session store, action audit service, and migration structure directly
 * with a fake mysql2 pool, following the same pattern as
 * services_boundary_test.js.
 *
 * Focus areas required by the Phase A2 plan:
 *   - session ownership: every query binds BOTH session id and user id
 *   - fixed expiry: expired sessions never act as active sessions
 *   - persisted language is the canonical code (en / ur / roman_ur)
 *   - bounded, sanitized session state (no arbitrary/unbounded shapes)
 *   - malformed stored JSON fails safe
 *   - audit writes bind the authenticated user; canonical classes only
 *   - secret-like values are never accepted into audit input
 *   - config parsing with safe fallbacks and no secret exposure
 *   - migration definition structure and idempotency
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  AGENT_CONFIG_DEFAULTS,
  agentConfig,
  agentRateLimits,
} from './agent/agent_config.js';

import {
  AGENT_STATE_LIMITS,
  AGENT_SESSION_STATE_VERSION,
  emptyAgentSessionState,
  sanitizeAgentSessionState,
} from './agent/agent_session_state.js';

import {
  AGENT_ACTION_AUDIT_DDL,
  AGENT_SESSIONS_DDL,
  ensureAgentFoundationSchema,
  verifyAgentFoundationSchema,
} from './agent/agent_schema.js';

import {
  createAgentSession,
  deleteAgentSession,
  deleteExpiredAgentSessions,
  readAgentSession,
  touchAgentSession,
  updateAgentSessionState,
} from './agent/agent_session_store.js';

import {
  AGENT_PERMISSION_CLASSES,
  readAgentActionsForUser,
  recordAgentAction,
  sanitizeAgentActionInput,
} from './agent/agent_action_audit.js';

// Tests must be deterministic regardless of the host environment.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('AGENT_')) delete process.env[key];
}

const OK_PACKET = { affectedRows: 1, insertId: 0 };

/**
 * Minimal mysql2 pool double, identical in spirit to the Phase A service
 * boundary tests. `respond(sql, params)` may return a mysql2 result tuple
 * or undefined (default: empty rows for SELECT, success packet otherwise).
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
  return { execute, calls };
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
const SESSION_ID = '501';

const sessionRow = {
  id: 501,
  user_id: 42,
  language: 'en',
  state_json: JSON.stringify(emptyAgentSessionState()),
  created_at: '2026-09-03 10:00:00',
  last_active_at: '2026-09-03 10:00:00',
  expires_at: '2026-09-03 14:00:00',
};

function sessionPool(row = sessionRow) {
  let currentLanguage = row.language;
  let currentStateJson = row.state_json;
  return createFakePool((sql, params) => {
    if (/^INSERT INTO agent_sessions/.test(sql)) {
      currentLanguage = params[1];
      currentStateJson = params[2];
      return [{ insertId: row.id, affectedRows: 1 }];
    }
    if (/^UPDATE agent_sessions SET state_json/.test(sql)) {
      currentStateJson = params[0];
      return [{ affectedRows: 1, insertId: 0 }];
    }
    if (/^DELETE FROM agent_sessions/.test(sql)) {
      return [{ affectedRows: 1, insertId: 0 }];
    }
    if (/FROM agent_sessions WHERE/.test(sql)) {
      const owned = params[1] === String(row.user_id);
      return owned
        ? [[{ ...row, language: currentLanguage, state_json: currentStateJson }]]
        : [[]];
    }
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// SESSION: create / read / ownership / expiry / language / state safety
// ---------------------------------------------------------------------------

await test('createAgentSession: creates a session with empty state and server-side expiry', async () => {
  const pool = sessionPool();
  const result = await createAgentSession({ db: pool, userId: USER_ID, language: 'ur' });

  assert.equal(result.ok, true);
  assert.equal(result.data.session.id, SESSION_ID);
  assert.equal(result.data.session.language, 'ur');
  assert.equal(result.data.session.state.version, AGENT_SESSION_STATE_VERSION);

  const insert = statementsMatching(pool, /^INSERT INTO agent_sessions/);
  assert.equal(insert.length, 1);
  assert.equal(insert[0].params[0], USER_ID);
  assert.equal(insert[0].params[1], 'ur');
  assert.deepEqual(
    JSON.parse(insert[0].params[2]),
    emptyAgentSessionState(),
  );
  assert.equal(insert[0].params[3], AGENT_CONFIG_DEFAULTS.maxSessionAgeMinutes);
  assert.match(insert[0].sql, /DATE_ADD\(CURRENT_TIMESTAMP, INTERVAL \? MINUTE\)/);
});

await test('readAgentSession: the owning user can read their session, scoped by id AND user', async () => {
  const pool = sessionPool();
  const result = await readAgentSession({ db: pool, userId: USER_ID, sessionId: SESSION_ID });

  assert.equal(result.ok, true);
  assert.equal(result.data.session.id, SESSION_ID);
  assert.equal(result.data.session.userId, USER_ID);

  const select = statementsMatching(pool, /FROM agent_sessions WHERE/);
  assert.equal(select.length, 1);
  assert.deepEqual(select[0].params, [SESSION_ID, USER_ID]);
  assert.match(select[0].sql, /WHERE id = \? AND user_id = \? AND expires_at > CURRENT_TIMESTAMP/);
});

await test('readAgentSession: a different user cannot read the session', async () => {
  const pool = sessionPool();
  const result = await readAgentSession({ db: pool, userId: OTHER_USER_ID, sessionId: SESSION_ID });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AGENT_SESSION_NOT_FOUND');

  const select = statementsMatching(pool, /FROM agent_sessions WHERE/);
  assert.equal(select.length, 1);
  assert.deepEqual(select[0].params, [SESSION_ID, OTHER_USER_ID]);
});

await test('updateAgentSessionState: updates are user-scoped and expiry-guarded', async () => {
  const pool = sessionPool();
  const result = await updateAgentSessionState({
    db: pool,
    userId: USER_ID,
    sessionId: SESSION_ID,
    state: { lastActionSummary: 'Reminder confirmed' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.session.state.lastActionSummary, 'Reminder confirmed');

  const update = statementsMatching(pool, /^UPDATE agent_sessions/);
  assert.equal(update.length, 1);
  assert.match(
    update[0].sql,
    /WHERE id = \? AND user_id = \? AND expires_at > CURRENT_TIMESTAMP/,
  );
  assert.equal(update[0].params[1], SESSION_ID);
  assert.equal(update[0].params[2], USER_ID);
  // State updates never alter the session language.
  assert.doesNotMatch(update[0].sql, /language/);
});

await test('expiry is enforced: active-use queries filter expires_at and expired sessions are not found', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM agent_sessions WHERE/.test(sql)) return [[]];
    return undefined;
  });

  const readResult = await readAgentSession({ db: pool, userId: USER_ID, sessionId: SESSION_ID });
  assert.equal(readResult.ok, false);
  assert.equal(readResult.code, 'AGENT_SESSION_NOT_FOUND');

  const touchResult = await touchAgentSession({ db: pool, userId: USER_ID, sessionId: SESSION_ID });
  assert.equal(touchResult.ok, false);
  assert.equal(touchResult.code, 'AGENT_SESSION_NOT_FOUND');

  const touchUpdate = statementsMatching(pool, /^UPDATE agent_sessions SET last_active_at/);
  assert.equal(touchUpdate.length, 1);
  assert.match(touchUpdate[0].sql, /expires_at > CURRENT_TIMESTAMP/);
  assert.match(touchUpdate[0].sql, /user_id = \?/);
  // Fixed expiry: touch never writes expires_at.
  assert.doesNotMatch(touchUpdate[0].sql, /SET [^W]*expires_at/);
  // Touch never alters the session language either.
  assert.doesNotMatch(touchUpdate[0].sql, /language/);
});

await test('createAgentSession: an invalid language safely falls back to the canonical en', async () => {
  const pool = sessionPool();
  const result = await createAgentSession({ db: pool, userId: USER_ID, language: 'Klingon' });

  assert.equal(result.ok, true);
  const insert = statementsMatching(pool, /^INSERT INTO agent_sessions/);
  assert.equal(insert[0].params[1], 'en');
  assert.equal(result.data.session.language, 'en');
});

await test('createAgentSession: the default language persists as the canonical en', async () => {
  const pool = sessionPool();
  const result = await createAgentSession({ db: pool, userId: USER_ID });

  assert.equal(result.ok, true);
  const insert = statementsMatching(pool, /^INSERT INTO agent_sessions/);
  assert.equal(insert[0].params[1], 'en');
  assert.equal(result.data.session.language, 'en');
});

await test('createAgentSession: language input is normalized to the canonical persisted codes', async () => {
  const cases = [
    ['en', 'en'],
    ['ur', 'ur'],
    ['roman_ur', 'roman_ur'],
    ['English', 'en'],
    ['Urdu', 'ur'],
    ['Roman Urdu', 'roman_ur'],
  ];
  for (const [input, expected] of cases) {
    const pool = sessionPool();
    const result = await createAgentSession({ db: pool, userId: USER_ID, language: input });

    assert.equal(result.ok, true, `create failed for input ${JSON.stringify(input)}`);
    const insert = statementsMatching(pool, /^INSERT INTO agent_sessions/);
    assert.equal(insert[0].params[1], expected, `persisted language for input ${JSON.stringify(input)}`);
    assert.equal(result.data.session.language, expected, `returned language for input ${JSON.stringify(input)}`);
  }
});

await test('readAgentSession: returns the canonical persisted language code', async () => {
  const pool = sessionPool({ ...sessionRow, language: 'ur' });
  const result = await readAgentSession({ db: pool, userId: USER_ID, sessionId: SESSION_ID });

  assert.equal(result.ok, true);
  assert.equal(result.data.session.language, 'ur');
});

await test('readAgentSession: a legacy non-canonical stored language is normalized to the canonical code', async () => {
  const pool = sessionPool({ ...sessionRow, language: 'English' });
  const result = await readAgentSession({ db: pool, userId: USER_ID, sessionId: SESSION_ID });

  assert.equal(result.ok, true);
  assert.equal(result.data.session.language, 'en');
});

await test('readAgentSession: malformed stored state JSON fails safe to the empty state', async () => {
  const pool = sessionPool({ ...sessionRow, state_json: 'not-valid-json{{' });
  const result = await readAgentSession({ db: pool, userId: USER_ID, sessionId: SESSION_ID });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.session.state, emptyAgentSessionState());
});

await test('readAgentSession: stored state is re-sanitized on read so unknown and unbounded data never escape', async () => {
  const stored = {
    version: 1,
    evilKey: 'must-not-escape',
    nestedPayload: { deep: { deeper: { blob: 'x'.repeat(5000) } } },
    lastReferencedEntities: Array.from({ length: 60 }, (_, i) => ({
      type: 'care_plan',
      id: String(i + 1),
    })),
    pendingDraft: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`key${i}`, `value-${i}`]),
    ),
    lastActionSummary: 'x'.repeat(5000),
  };
  const pool = sessionPool({ ...sessionRow, state_json: JSON.stringify(stored) });
  const result = await readAgentSession({ db: pool, userId: USER_ID, sessionId: SESSION_ID });

  assert.equal(result.ok, true);
  const state = result.data.session.state;
  assert.equal('evilKey' in state, false);
  assert.equal('nestedPayload' in state, false);
  assert.equal(state.version, AGENT_SESSION_STATE_VERSION);
  // Read-side bounds match the write-side bounds exactly.
  assert.equal(state.lastReferencedEntities.length, 20);
  assert.equal(Object.keys(state.pendingDraft).length, AGENT_STATE_LIMITS.draftMaxEntries);
  assert.equal(state.lastActionSummary.length, 500);
});

await test('readAgentSession: approved canonical stored state fields survive read-side sanitization', async () => {
  const stored = {
    version: 1,
    lastReferencedEntities: [{ type: 'care_plan', id: '7' }],
    currentFocus: { type: 'care_plan', id: '7' },
    recentOrderedEntityList: {
      kind: 'care_plan',
      entities: [{ type: 'care_plan', id: '7' }],
    },
    lastIntent: 'get_care_plan',
    lastCapabilityNames: ['get_care_plan'],
    pendingConfirmation: {
      confirmationId: 'confirm-state-1',
      kind: 'task_outcome',
      message: 'Confirm this reminder?',
      expiresAt: '2999-01-01T00:00:00.000Z',
    },
    pendingDraft: { title: 'Metformin' },
    lastActionSummary: 'Reminder confirmed',
  };
  const pool = sessionPool({ ...sessionRow, state_json: JSON.stringify(stored) });
  const result = await readAgentSession({ db: pool, userId: USER_ID, sessionId: SESSION_ID });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.session.state, stored);
});

await test('readAgentSession: an unsupported stored state version fails safe to the empty state', async () => {
  const pool = sessionPool({
    ...sessionRow,
    state_json: JSON.stringify({ version: 99, lastActionSummary: 'from the future' }),
  });
  const result = await readAgentSession({ db: pool, userId: USER_ID, sessionId: SESSION_ID });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.session.state, emptyAgentSessionState());
});

await test('readAgentSession: an oversized stored state fails safe to the empty state', async () => {
  process.env.AGENT_SESSION_STATE_MAX_BYTES = '1024';
  try {
    const oversized = {
      version: 1,
      lastReferencedEntities: Array.from({ length: 20 }, (_, i) => ({
        type: 'care_plan',
        id: `${i + 1}${'1'.repeat(50)}`,
      })),
    };
    const pool = sessionPool({ ...sessionRow, state_json: JSON.stringify(oversized) });
    const result = await readAgentSession({ db: pool, userId: USER_ID, sessionId: SESSION_ID });

    assert.equal(result.ok, true);
    assert.deepEqual(result.data.session.state, emptyAgentSessionState());
  } finally {
    delete process.env.AGENT_SESSION_STATE_MAX_BYTES;
  }
});

await test('createAgentSession: oversized state is rejected before any database access', async () => {
  process.env.AGENT_SESSION_STATE_MAX_BYTES = '1024';
  try {
    const pool = sessionPool();
    const result = await createAgentSession({
      db: pool,
      userId: USER_ID,
      state: {
        lastReferencedEntities: Array.from({ length: 20 }, (_, i) => ({
          type: 'care_plan',
          id: `${i + 1}${'1'.repeat(50)}`,
        })),
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'AGENT_STATE_TOO_LARGE');
    assert.equal(pool.calls.length, 0);
  } finally {
    delete process.env.AGENT_SESSION_STATE_MAX_BYTES;
  }
});

await test('createAgentSession: multibyte state under the character count but over the UTF-8 byte budget is rejected', async () => {
  process.env.AGENT_SESSION_STATE_MAX_BYTES = '1024';
  try {
    const pool = sessionPool();
    const urduSummary = 'اردو'.repeat(125); // 500 characters, 1000 UTF-8 bytes
    assert.equal(urduSummary.length, 500);
    const result = await createAgentSession({
      db: pool,
      userId: USER_ID,
      state: { lastActionSummary: urduSummary },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'AGENT_STATE_TOO_LARGE');
    assert.equal(pool.calls.length, 0);
  } finally {
    delete process.env.AGENT_SESSION_STATE_MAX_BYTES;
  }
});

await test('state and audit byte budgets measure real UTF-8 bytes with a deterministic boundary', () => {
  // ASCII within budget passes.
  const ascii = sanitizeAgentSessionState(
    { lastActionSummary: 'a'.repeat(500) },
    { maxStateBytes: 2048 },
  );
  assert.equal(ascii.ok, true);

  // Urdu state: 500 characters but ~1000 UTF-8 bytes plus the JSON wrapper
  // exceeds the 1024-byte budget that a character-count check would pass.
  const urduState = sanitizeAgentSessionState(
    { lastActionSummary: 'اردو'.repeat(125) },
    { maxStateBytes: 1024 },
  );
  assert.equal(urduState.ok, false);
  assert.equal(urduState.code, 'AGENT_STATE_TOO_LARGE');

  // Audit input: same UTF-8 rule.
  const urduAudit = sanitizeAgentActionInput(
    { note: 'ا'.repeat(400) }, // 400 characters, 800 UTF-8 bytes
    { maxStateBytes: 700 },
  );
  assert.equal(urduAudit.ok, false);
  assert.equal(urduAudit.code, 'AGENT_ACTION_INPUT_TOO_LARGE');

  // Deterministic boundary at the exact byte length.
  const payload = { note: 'x'.repeat(100) };
  const exactBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  assert.equal(sanitizeAgentActionInput(payload, { maxStateBytes: exactBytes }).ok, true);
  assert.equal(
    sanitizeAgentActionInput(payload, { maxStateBytes: exactBytes - 1 }).code,
    'AGENT_ACTION_INPUT_TOO_LARGE',
  );
});

await test('session state sanitizer rejects unexpected dangerous/unbounded shapes', async () => {
  assert.equal(sanitizeAgentSessionState('just a string').ok, false);
  assert.equal(sanitizeAgentSessionState('just a string').code, 'INVALID_AGENT_STATE');
  assert.equal(sanitizeAgentSessionState([1, 2, 3]).code, 'INVALID_AGENT_STATE');
  assert.equal(sanitizeAgentSessionState({ version: 99 }).code, 'UNSUPPORTED_AGENT_STATE_VERSION');
  assert.equal(
    sanitizeAgentSessionState({ lastReferencedEntities: 'not-a-list' }).code,
    'INVALID_AGENT_STATE',
  );

  const sanitized = sanitizeAgentSessionState({
    evilKey: 'dropped',
    version: 1,
    lastReferencedEntities: [
      { type: 'care_plan', id: '7' },
      { type: 'missing-id' },
      'junk-entry',
      { type: 'document', id: '9' },
    ],
    currentFocus: { type: 'care_plan', id: '7' },
    recentOrderedEntityList: {
      kind: 'care_plan',
      entities: [
        { type: 'care_plan', id: '7' },
        { type: 'care_gap', id: '5' },
        { type: 'document', id: '9' },
      ],
    },
    lastIntent: 'get_care_plan',
    lastCapabilityNames: ['get_care_plan', 'get_simulation'],
    pendingConfirmation: {
      confirmationId: 'confirm-state-2',
      kind: 'task_outcome',
      message: 'Confirm this reminder?',
      expiresAt: '2999-01-01T00:00:00.000Z',
    },
    pendingDraft: { title: 'Metformin', nestedObject: { deep: 'dropped' }, count: 3 },
    lastActionSummary: 'Reminder confirmed',
  });

  assert.equal(sanitized.ok, true);
  assert.deepEqual(
    sanitized.state.lastReferencedEntities,
    [{ type: 'care_plan', id: '7' }],
  );
  assert.deepEqual(
    sanitized.state.pendingConfirmation,
    {
      confirmationId: 'confirm-state-2',
      kind: 'task_outcome',
      message: 'Confirm this reminder?',
      expiresAt: '2999-01-01T00:00:00.000Z',
    },
  );
  assert.deepEqual(sanitized.state.pendingDraft, { title: 'Metformin' });
  assert.equal(sanitized.state.lastActionSummary, 'Reminder confirmed');
  assert.deepEqual(sanitized.state.currentFocus, { type: 'care_plan', id: '7' });
  assert.deepEqual(sanitized.state.recentOrderedEntityList, {
    kind: 'care_plan',
    entities: [
      { type: 'care_plan', id: '7' },
      { type: 'care_gap', id: '5' },
    ],
  });
  assert.equal(sanitized.state.lastIntent, 'get_care_plan');
  assert.deepEqual(sanitized.state.lastCapabilityNames, [
    'get_care_plan',
    'get_simulation',
  ]);
  assert.equal('evilKey' in sanitized.state, false);
});

await test('deleteAgentSession and deleteExpiredAgentSessions are scoped correctly', async () => {
  const pool = sessionPool();
  const deleteResult = await deleteAgentSession({ db: pool, userId: USER_ID, sessionId: SESSION_ID });
  assert.equal(deleteResult.ok, true);

  const del = statementsMatching(pool, /^DELETE FROM agent_sessions WHERE id/);
  assert.equal(del.length, 1);
  assert.deepEqual(del[0].params, [SESSION_ID, USER_ID]);

  const expiredResult = await deleteExpiredAgentSessions({ db: pool });
  assert.equal(expiredResult.ok, true);
  const expiredDelete = statementsMatching(pool, /^DELETE FROM agent_sessions WHERE expires_at/);
  assert.equal(expiredDelete.length, 1);
  assert.match(expiredDelete[0].sql, /expires_at <= CURRENT_TIMESTAMP/);
  assert.match(expiredDelete[0].sql, /LIMIT 500/);
});

await test('readAgentSession: an invalid session ID is rejected before any database access', async () => {
  const pool = sessionPool();
  const result = await readAgentSession({ db: pool, userId: USER_ID, sessionId: 'abc' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_AGENT_SESSION_ID');
  assert.equal(pool.calls.length, 0);
});

// ---------------------------------------------------------------------------
// AUDIT: user binding, canonical values, secret stripping
// ---------------------------------------------------------------------------

const auditRow = {
  id: 701,
  user_id: 42,
  session_id: 501,
  tool_name: 'read_care_plan',
  permission_class: 'READ',
  input_json: JSON.stringify({ planId: '7' }),
  result_status: 'succeeded',
  backend_confirmed: 1,
  target_type: 'care_plan',
  target_id: '7',
  error_code: null,
  created_at: '2026-09-03 10:05:00',
};

function auditPool({ row = auditRow, sessions = [{ id: 501, user_id: 42 }] } = {}) {
  return createFakePool((sql, params) => {
    // Session-ownership probe issued by recordAgentAction before inserting.
    if (/FROM agent_sessions WHERE id = \? AND user_id = \?/.test(sql)) {
      const owned = sessions.filter(
        (session) =>
          String(session.id) === String(params[0]) &&
          String(session.user_id) === String(params[1]),
      );
      return [owned];
    }
    if (/^INSERT INTO agent_action_audit/.test(sql)) {
      return [{ insertId: 701, affectedRows: 1 }];
    }
    if (/FROM agent_action_audit/.test(sql)) {
      return [[row]];
    }
    return undefined;
  });
}

await test('recordAgentAction: the write binds the authenticated user', async () => {
  const pool = auditPool();
  const result = await recordAgentAction({
    db: pool,
    userId: USER_ID,
    toolName: 'read_care_plan',
    permissionClass: 'READ',
    resultStatus: 'succeeded',
    backendConfirmed: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.actionId, '701');

  const insert = statementsMatching(pool, /^INSERT INTO agent_action_audit/);
  assert.equal(insert.length, 1);
  assert.equal(insert[0].params[0], USER_ID);
  assert.equal(insert[0].params[2], 'read_care_plan');
  assert.equal(insert[0].params[3], 'READ');
  assert.equal(insert[0].params[5], 'succeeded');
});

await test('readAgentActionsForUser: reads always bind the requesting user id', async () => {
  const pool = auditPool({ row: { ...auditRow, user_id: 99 } });
  const result = await readAgentActionsForUser({ db: pool, userId: OTHER_USER_ID, sessionId: SESSION_ID });

  assert.equal(result.ok, true);
  assert.equal(result.data.actions[0].userId, OTHER_USER_ID);

  const select = statementsMatching(pool, /FROM agent_action_audit/);
  assert.equal(select.length, 1);
  assert.match(select[0].sql, /WHERE user_id = \? AND session_id = \?/);
  assert.deepEqual(select[0].params, [OTHER_USER_ID, SESSION_ID]);
  // The read limit is bounded server-side.
  assert.match(select[0].sql, /LIMIT 50/);
});

await test('recordAgentAction: a session-scoped audit write verifies session ownership first', async () => {
  const ownerPool = auditPool();
  const ownerResult = await recordAgentAction({
    db: ownerPool,
    userId: USER_ID,
    sessionId: SESSION_ID,
    toolName: 'read_care_plan',
    permissionClass: 'READ',
    resultStatus: 'succeeded',
  });

  assert.equal(ownerResult.ok, true);
  const ownershipCheck = statementsMatching(
    ownerPool,
    /FROM agent_sessions WHERE id = \? AND user_id = \?/,
  );
  assert.equal(ownershipCheck.length, 1);
  assert.deepEqual(ownershipCheck[0].params, [SESSION_ID, USER_ID]);
  assert.equal(statementsMatching(ownerPool, /^INSERT INTO agent_action_audit/).length, 1);

  const otherPool = auditPool();
  const otherResult = await recordAgentAction({
    db: otherPool,
    userId: OTHER_USER_ID,
    sessionId: SESSION_ID,
    toolName: 'read_care_plan',
    permissionClass: 'READ',
    resultStatus: 'succeeded',
  });

  assert.equal(otherResult.ok, false);
  assert.equal(otherResult.code, 'AGENT_SESSION_NOT_FOUND');
  const foreignCheck = statementsMatching(
    otherPool,
    /FROM agent_sessions WHERE id = \? AND user_id = \?/,
  );
  assert.equal(foreignCheck.length, 1);
  assert.deepEqual(foreignCheck[0].params, [SESSION_ID, OTHER_USER_ID]);
  assert.equal(statementsMatching(otherPool, /^INSERT INTO agent_action_audit/).length, 0);
});

await test('recordAgentAction: an unknown session causes zero audit INSERTs', async () => {
  const pool = auditPool({ sessions: [] });
  const result = await recordAgentAction({
    db: pool,
    userId: USER_ID,
    sessionId: '777',
    toolName: 'read_care_plan',
    permissionClass: 'READ',
    resultStatus: 'succeeded',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AGENT_SESSION_NOT_FOUND');
  assert.equal(statementsMatching(pool, /^INSERT INTO agent_action_audit/).length, 0);
});

await test('recordAgentAction: a null sessionId stays allowed without any session lookup', async () => {
  const pool = auditPool();
  const result = await recordAgentAction({
    db: pool,
    userId: USER_ID,
    toolName: 'list_care_plans',
    permissionClass: 'READ',
    resultStatus: 'succeeded',
  });

  assert.equal(result.ok, true);
  assert.equal(statementsMatching(pool, /FROM agent_sessions/).length, 0);
  assert.equal(statementsMatching(pool, /^INSERT INTO agent_action_audit/).length, 1);
});

await test('recordAgentAction: permission classes are validated centrally', async () => {
  const pool = auditPool();
  const invalid = await recordAgentAction({
    db: pool,
    userId: USER_ID,
    toolName: 'read_care_plan',
    permissionClass: 'EXECUTE_ANYTHING',
    resultStatus: 'succeeded',
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID_AGENT_PERMISSION_CLASS');

  const lowercased = await recordAgentAction({
    db: pool,
    userId: USER_ID,
    toolName: 'read_care_plan',
    permissionClass: 'read',
    resultStatus: 'succeeded',
  });
  assert.equal(lowercased.ok, false);
  assert.equal(lowercased.code, 'INVALID_AGENT_PERMISSION_CLASS');

  assert.equal(pool.calls.length, 0);
  assert.ok(AGENT_PERMISSION_CLASSES.includes('FORBIDDEN_CLINICAL_ACTION'));
});

await test('recordAgentAction: FORBIDDEN_CLINICAL_ACTION must be audited as rejected and unconfirmed', async () => {
  const validPool = auditPool();
  const valid = await recordAgentAction({
    db: validPool,
    userId: USER_ID,
    sessionId: SESSION_ID,
    toolName: 'adjust_insulin_dose',
    permissionClass: 'FORBIDDEN_CLINICAL_ACTION',
    resultStatus: 'rejected',
    backendConfirmed: false,
    errorCode: 'FORBIDDEN_BY_POLICY',
  });
  assert.equal(valid.ok, true);
  assert.equal(statementsMatching(validPool, /^INSERT INTO agent_action_audit/).length, 1);

  const invalidCombos = [
    { resultStatus: 'succeeded', backendConfirmed: false },
    { resultStatus: 'failed', backendConfirmed: true },
    { resultStatus: 'rejected', backendConfirmed: true },
  ];
  for (const combo of invalidCombos) {
    const pool = auditPool();
    const result = await recordAgentAction({
      db: pool,
      userId: USER_ID,
      sessionId: SESSION_ID,
      toolName: 'adjust_insulin_dose',
      permissionClass: 'FORBIDDEN_CLINICAL_ACTION',
      resultStatus: combo.resultStatus,
      backendConfirmed: combo.backendConfirmed,
    });

    assert.equal(result.ok, false, `combo must fail: ${JSON.stringify(combo)}`);
    assert.equal(result.code, 'INVALID_AGENT_AUDIT_STATE');
    // Rejected before any database access at all.
    assert.equal(pool.calls.length, 0);
  }
});

await test('recordAgentAction: backend_confirmed is preserved exactly as 1/0', async () => {
  const pool = auditPool();
  await recordAgentAction({
    db: pool,
    userId: USER_ID,
    toolName: 'read_care_plan',
    permissionClass: 'READ',
    resultStatus: 'succeeded',
    backendConfirmed: true,
  });
  await recordAgentAction({
    db: pool,
    userId: USER_ID,
    toolName: 'read_care_plan',
    permissionClass: 'READ',
    resultStatus: 'failed',
    backendConfirmed: false,
  });

  const inserts = statementsMatching(pool, /^INSERT INTO agent_action_audit/);
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].params[6], 1);
  assert.equal(inserts[1].params[6], 0);
});

await test('recordAgentAction: arbitrary tool names and result statuses are rejected safely', async () => {
  const pool = auditPool();

  const injection = await recordAgentAction({
    db: pool,
    userId: USER_ID,
    toolName: 'DROP TABLE users; --',
    permissionClass: 'READ',
    resultStatus: 'succeeded',
  });
  assert.equal(injection.ok, false);
  assert.equal(injection.code, 'INVALID_AGENT_TOOL_NAME');

  const camelCase = await recordAgentAction({
    db: pool,
    userId: USER_ID,
    toolName: 'ReadCarePlan',
    permissionClass: 'READ',
    resultStatus: 'succeeded',
  });
  assert.equal(camelCase.ok, false);
  assert.equal(camelCase.code, 'INVALID_AGENT_TOOL_NAME');

  const badStatus = await recordAgentAction({
    db: pool,
    userId: USER_ID,
    toolName: 'read_care_plan',
    permissionClass: 'READ',
    resultStatus: 'deleted',
  });
  assert.equal(badStatus.ok, false);
  assert.equal(badStatus.code, 'INVALID_AGENT_ACTION_RESULT_STATUS');

  assert.equal(pool.calls.length, 0);
});

await test('recordAgentAction: secret-like input fields are stripped before persistence', async () => {
  const pool = auditPool();
  const result = await recordAgentAction({
    db: pool,
    userId: USER_ID,
    toolName: 'read_care_plan',
    permissionClass: 'READ',
    resultStatus: 'succeeded',
    input: {
      password: 'hunter2',
      api_key: 'sk-123',
      authorization: 'Bearer abc',
      note: 'visible payload',
      nested: { token: 'secret', ok: 'yes' },
    },
  });

  assert.equal(result.ok, true);
  const insert = statementsMatching(pool, /^INSERT INTO agent_action_audit/)[0];
  const stored = JSON.parse(insert.params[4]);
  assert.equal(stored.note, 'visible payload');
  assert.equal(stored.nested.ok, 'yes');
  assert.equal('password' in stored, false);
  assert.equal('api_key' in stored, false);
  assert.equal('authorization' in stored, false);
  assert.equal('token' in stored.nested, false);
  assert.ok(!insert.params[4].includes('hunter2'));
  assert.ok(!insert.params[4].includes('sk-123'));
});

// ---------------------------------------------------------------------------
// CONFIG: parsing, fallbacks, no secret exposure
// ---------------------------------------------------------------------------

await test('agentConfig: a valid session age is consumed from the environment', () => {
  const config = agentConfig({ AGENT_MAX_SESSION_AGE_MINUTES: '60' });
  assert.equal(config.maxSessionAgeMinutes, 60);
  assert.equal(config.enabled, false);
});

await test('agentConfig: invalid session-age values fall back to the safe default', () => {
  for (const bad of ['abc', '-3', '0', '2', '99999999', '  ', null, undefined]) {
    const config = agentConfig({ AGENT_MAX_SESSION_AGE_MINUTES: bad });
    assert.equal(
      config.maxSessionAgeMinutes,
      AGENT_CONFIG_DEFAULTS.maxSessionAgeMinutes,
      `fallback failed for ${JSON.stringify(bad)}`,
    );
  }
});

await test('agentRateLimits: window and limit parsing with safe defaults', () => {
  const configured = agentRateLimits({
    AGENT_RATE_LIMIT_WINDOW_MINUTES: '5',
    AGENT_RATE_LIMIT_MAX: '40',
  });
  assert.equal(configured.windowMs, 5 * 60 * 1000);
  assert.equal(configured.limit, 40);

  const fallback = agentRateLimits({
    AGENT_RATE_LIMIT_WINDOW_MINUTES: 'zero',
    AGENT_RATE_LIMIT_MAX: -1,
  });
  assert.equal(fallback.windowMs, AGENT_CONFIG_DEFAULTS.rateLimitWindowMinutes * 60 * 1000);
  assert.equal(fallback.limit, AGENT_CONFIG_DEFAULTS.rateLimitMax);
});

await test('agentConfig: serialization never exposes secret values', () => {
  const sentinel = 'super-secret-sentinel-value';
  const config = agentConfig({
    OPENROUTER_API_KEY: sentinel,
    JWT_SECRET: sentinel,
    DB_PASSWORD: sentinel,
    AGENT_MAX_SESSION_AGE_MINUTES: '30',
  });

  const serialized = JSON.stringify(config);
  assert.ok(!serialized.includes(sentinel));
  assert.deepEqual(
    Object.keys(config).sort(),
    [
      'enabled',
      'maxSessionAgeMinutes',
      'rateLimitMax',
      'rateLimitWindowMinutes',
      'sessionStateMaxBytes',
    ],
  );
});

// ---------------------------------------------------------------------------
// MIGRATION: structure, idempotency, ON DELETE behavior
// ---------------------------------------------------------------------------

await test('migration definition: both tables, columns, indexes and foreign keys are declared', () => {
  assert.match(AGENT_SESSIONS_DDL, /CREATE TABLE IF NOT EXISTS agent_sessions/);
  for (const column of [
    'id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT',
    'user_id BIGINT UNSIGNED NOT NULL',
    "language VARCHAR(20) NOT NULL DEFAULT 'en'",
    'state_json LONGTEXT NOT NULL',
    'created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
    'last_active_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
    'expires_at TIMESTAMP NOT NULL',
  ]) {
    assert.ok(AGENT_SESSIONS_DDL.includes(column), `agent_sessions missing: ${column}`);
  }
  assert.ok(AGENT_SESSIONS_DDL.includes('KEY agent_sessions_user_idx (user_id, expires_at)'));
  assert.ok(AGENT_SESSIONS_DDL.includes('KEY agent_sessions_expiry_idx (expires_at)'));
  // Canonical persisted language contract: default is 'en', never a display name.
  assert.ok(!AGENT_SESSIONS_DDL.includes("'English'"));
  assert.ok(!AGENT_ACTION_AUDIT_DDL.includes("'English'"));

  assert.match(AGENT_ACTION_AUDIT_DDL, /CREATE TABLE IF NOT EXISTS agent_action_audit/);
  for (const column of [
    'session_id BIGINT UNSIGNED NULL',
    'tool_name VARCHAR(60) NOT NULL',
    'permission_class VARCHAR(40) NOT NULL',
    'input_json LONGTEXT NULL',
    'result_status VARCHAR(20) NOT NULL',
    'backend_confirmed TINYINT(1) NOT NULL DEFAULT 0',
    'target_type VARCHAR(40) NULL',
    'target_id VARCHAR(191) NULL',
    'error_code VARCHAR(80) NULL',
  ]) {
    assert.ok(AGENT_ACTION_AUDIT_DDL.includes(column), `agent_action_audit missing: ${column}`);
  }
  assert.ok(AGENT_ACTION_AUDIT_DDL.includes('KEY agent_action_audit_user_idx (user_id, created_at)'));
  assert.ok(AGENT_ACTION_AUDIT_DDL.includes('KEY agent_action_audit_session_idx (session_id, created_at)'));

  const sqlFile = fs.readFileSync(new URL('./agent_foundation_migration.sql', import.meta.url), 'utf8');
  assert.match(sqlFile, /CREATE TABLE IF NOT EXISTS agent_sessions/);
  assert.match(sqlFile, /CREATE TABLE IF NOT EXISTS agent_action_audit/);
  assert.match(sqlFile, /language VARCHAR\(20\) NOT NULL DEFAULT 'en'/);
  assert.ok(!sqlFile.includes("DEFAULT 'English'"));
});

await test('migration definition: idempotent CREATE TABLE IF NOT EXISTS only', async () => {
  const pool = createFakePool();
  await ensureAgentFoundationSchema(pool);
  await ensureAgentFoundationSchema(pool);

  const creates = statementsMatching(pool, /^CREATE TABLE IF NOT EXISTS/);
  assert.equal(creates.length, 4);
  assert.equal(statementsMatching(pool, /DROP TABLE|ALTER TABLE|DELETE FROM|TRUNCATE/).length, 0);
});

await test('migration definition: ON DELETE behavior is deliberate', () => {
  assert.ok(
    AGENT_SESSIONS_DDL.includes(
      'FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE',
    ),
  );
  assert.ok(
    AGENT_ACTION_AUDIT_DDL.includes(
      'FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE',
    ),
  );
  // Audit records survive session deletion.
  assert.ok(
    AGENT_ACTION_AUDIT_DDL.includes(
      'FOREIGN KEY (session_id) REFERENCES agent_sessions (id) ON DELETE SET NULL',
    ),
  );
  assert.equal(
    (AGENT_SESSIONS_DDL.match(/ON DELETE/g) || []).length,
    1,
  );
});

await test('verifyAgentFoundationSchema: accepts a complete schema', async () => {
  const pool = schemaVerifyPool();
  const result = await verifyAgentFoundationSchema(pool);
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

await test('verifyAgentFoundationSchema: reports a missing audit table loudly', async () => {
  const pool = schemaVerifyPool({ includeAuditTable: false });
  const result = await verifyAgentFoundationSchema(pool);
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('missing table: agent_action_audit'));
  assert.ok(result.problems.includes('missing foreignKey: agent_action_audit.agent_action_audit_session_fk'));
});

await test('verifyAgentFoundationSchema: rejects a non-canonical language column default', async () => {
  const pool = schemaVerifyPool({ languageDefault: 'English' });
  const result = await verifyAgentFoundationSchema(pool);
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((problem) =>
      problem.includes('agent_sessions.language') && problem.includes("'en'"),
    ),
  );
});

function schemaVerifyPool({ includeAuditTable = true, languageDefault = 'en' } = {}) {
  const tables = [{ TABLE_NAME: 'agent_sessions' }];
  const columns = [
    'id', 'user_id', 'language', 'state_json', 'created_at',
    'last_active_at', 'expires_at',
  ].map((name) => ({
    TABLE_NAME: 'agent_sessions',
    COLUMN_NAME: name,
    ...(name === 'language' ? { COLUMN_DEFAULT: languageDefault } : {}),
  }));
  const statistics = [
    'PRIMARY', 'agent_sessions_user_idx', 'agent_sessions_expiry_idx',
  ].map((name) => ({ TABLE_NAME: 'agent_sessions', INDEX_NAME: name }));
  const constraints = [
    { TABLE_NAME: 'agent_sessions', CONSTRAINT_NAME: 'agent_sessions_user_fk' },
  ];

  if (includeAuditTable) {
    tables.push({ TABLE_NAME: 'agent_action_audit' });
    columns.push(
      ...[
        'id', 'user_id', 'session_id', 'tool_name', 'permission_class',
        'input_json', 'result_status', 'backend_confirmed', 'target_type',
        'target_id', 'error_code', 'created_at',
      ].map((name) => ({ TABLE_NAME: 'agent_action_audit', COLUMN_NAME: name })),
    );
    statistics.push(
      ...['PRIMARY', 'agent_action_audit_user_idx', 'agent_action_audit_session_idx']
        .map((name) => ({ TABLE_NAME: 'agent_action_audit', INDEX_NAME: name })),
    );
    constraints.push(
      { TABLE_NAME: 'agent_action_audit', CONSTRAINT_NAME: 'agent_action_audit_user_fk' },
      { TABLE_NAME: 'agent_action_audit', CONSTRAINT_NAME: 'agent_action_audit_session_fk' },
    );
  }

  return createFakePool((sql) => {
    if (/FROM information_schema\.TABLES\b/.test(sql)) return [tables];
    if (/FROM information_schema\.COLUMNS/.test(sql)) return [columns];
    if (/FROM information_schema\.STATISTICS/.test(sql)) return [statistics];
    if (/FROM information_schema\.TABLE_CONSTRAINTS/.test(sql)) return [constraints];
    return undefined;
  });
}

console.log(`Agent foundation tests passed (${passedCount} tests).`);
