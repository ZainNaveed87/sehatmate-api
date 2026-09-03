/**
 * Transport-independent storage service for agent sessions (Phase A2).
 *
 * Safe primitives only - no AI message processing, no LLM, no tool
 * execution. Nothing in this module may depend on Express request/response
 * objects, so both future REST routes and future agent tools call the same
 * authoritative implementation.
 *
 * Security invariants:
 *   - the authenticated userId is a mandatory parameter of every operation
 *   - every read/update/delete query is scoped by BOTH session id AND user
 *     id, so cross-user session access is impossible
 *   - expired sessions are never returned as active: every active-use query
 *     filters on expires_at > CURRENT_TIMESTAMP
 *   - state_json is parsed fail-safe (malformed stored JSON degrades to the
 *     canonical empty state instead of throwing)
 *   - state input is bounded and sanitized through agent_session_state.js
 *   - the persisted language is the canonical agent code (en / ur /
 *     roman_ur); input in the existing language_support.js representations
 *     (English / Urdu / Roman Urdu) is accepted and converted through one
 *     explicit boundary (canonicalAgentLanguage) before persistence -
 *     there is no second localization system
 *
 * Expiry design: FIXED expiry. expires_at is computed server-side at INSERT
 * time (created_at + AGENT_MAX_SESSION_AGE_MINUTES) and is never extended;
 * touchAgentSession only refreshes last_active_at. Fixed expiry was chosen
 * over sliding expiry because it gives a strictly bounded retention window
 * (healthcare data-minimization principle), is trivial to reason about and
 * test, and Phase A2 has no conversation logic that would justify keeping a
 * session alive longer. Expired rows are simply inactive and can be cleaned
 * lazily with deleteExpiredAgentSessions.
 */

import { normalizePreferredLanguage } from '../language_support.js';
import { cleanText, idPattern } from '../services/shared_utils.js';
import { agentConfig } from './agent_config.js';
import {
  parseAgentSessionState,
  sanitizeAgentSessionState,
  serializeAgentSessionState,
} from './agent_session_state.js';

/**
 * Canonical persisted language codes for agent sessions. The
 * application-wide language system (language_support.js) works with the
 * display names English / Urdu / Roman Urdu; the agent contract persists
 * the compact codes below. This module owns the single explicit
 * conversion boundary between the two representations - no second
 * localization system is introduced.
 */
const AGENT_LANGUAGE_CODES = Object.freeze(['en', 'ur', 'roman_ur']);

const AGENT_LANGUAGE_CODE_BY_DISPLAY_NAME = Object.freeze({
  English: 'en',
  Urdu: 'ur',
  'Roman Urdu': 'roman_ur',
});

/**
 * Normalize any accepted language input to the canonical persisted code.
 * Canonical codes pass through unchanged, display-name aliases are
 * converted, and unknown values follow the existing safe fallback policy
 * (the canonical 'en').
 */
export function canonicalAgentLanguage(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (AGENT_LANGUAGE_CODES.includes(raw)) return raw;
  const displayName = normalizePreferredLanguage(raw);
  return AGENT_LANGUAGE_CODE_BY_DISPLAY_NAME[displayName] || 'en';
}

const SESSION_COLUMNS = `id, user_id, language, state_json,
        created_at, last_active_at, expires_at`;

function sessionForRow(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    language: canonicalAgentLanguage(row.language),
    state: parseAgentSessionState(row.state_json, {
      maxStateBytes: agentConfig().sessionStateMaxBytes,
    }),
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    expiresAt: row.expires_at,
  };
}

async function readActiveSessionRow(db, sessionId, userId) {
  const [rows] = await db.execute(
    `SELECT ${SESSION_COLUMNS}
     FROM agent_sessions
     WHERE id = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP
     LIMIT 1`,
    [sessionId, userId],
  );
  return rows[0] || null;
}

function invalidSessionIdResult() {
  return {
    ok: false,
    code: 'INVALID_AGENT_SESSION_ID',
    message: 'Invalid agent session ID.',
  };
}

const sessionNotFoundResult = () => ({
  ok: false,
  code: 'AGENT_SESSION_NOT_FOUND',
  message: 'Agent session not found or expired.',
});

function cloneSessionWithState(row, state) {
  return {
    ...sessionForRow(row),
    state,
  };
}

async function rereadActiveSessionOrFallback(db, sessionId, userId, fallbackSession) {
  const currentRow = await readActiveSessionRow(db, sessionId, userId);
  return currentRow ? sessionForRow(currentRow) : fallbackSession;
}

/**
 * Create a new agent session for the authenticated user. The language is
 * normalized to the canonical persisted code (en / ur / roman_ur) through
 * canonicalAgentLanguage; unknown values safely become the default 'en'.
 * Initial state is the canonical empty state unless a caller-supplied
 * state passes sanitization.
 */
export async function createAgentSession({ db, userId, language = null, state = null }) {
  const sanitized = sanitizeAgentSessionState(state, {
    maxStateBytes: agentConfig().sessionStateMaxBytes,
  });
  if (!sanitized.ok) {
    return {
      ok: false,
      code: sanitized.code,
      message: sanitized.message,
    };
  }

  const canonicalLanguage = canonicalAgentLanguage(language);
  const [result] = await db.execute(
    `INSERT INTO agent_sessions (user_id, language, state_json, expires_at)
     VALUES (?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? MINUTE))`,
    [
      userId,
      canonicalLanguage,
      serializeAgentSessionState(sanitized.state),
      agentConfig().maxSessionAgeMinutes,
    ],
  );

  const row = await readActiveSessionRow(db, String(result.insertId), userId);
  if (!row) return sessionNotFoundResult();

  return {
    ok: true,
    message: 'Agent session created.',
    data: { session: sessionForRow(row) },
  };
}

/**
 * Read an active session owned by the authenticated user. Expired, missing,
 * or foreign sessions are all reported the same way, so the result never
 * leaks whether a session id exists for someone else.
 */
export async function readAgentSession({ db, userId, sessionId }) {
  if (!idPattern.test(sessionId || '')) return invalidSessionIdResult();

  const row = await readActiveSessionRow(db, sessionId, userId);
  if (!row) return sessionNotFoundResult();

  return {
    ok: true,
    message: 'Agent session loaded.',
    data: { session: sessionForRow(row) },
  };
}

/**
 * Refresh last_active_at for an active session. Fixed expiry: this never
 * extends expires_at (see the module header for the rationale).
 */
export async function touchAgentSession({ db, userId, sessionId }) {
  if (!idPattern.test(sessionId || '')) return invalidSessionIdResult();

  const [result] = await db.execute(
    `UPDATE agent_sessions
     SET last_active_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP`,
    [sessionId, userId],
  );
  if (!result.affectedRows) return sessionNotFoundResult();

  const row = await readActiveSessionRow(db, sessionId, userId);
  if (!row) return sessionNotFoundResult();

  return {
    ok: true,
    message: 'Agent session activity recorded.',
    data: { session: sessionForRow(row) },
  };
}

/**
 * Replace the state of an active session owned by the authenticated user.
 * The state must pass the agent session state sanitizer first. Callers that
 * build state from a previously read session should pass expectedState so the
 * write cannot resurrect or erase a concurrent pending action.
 */
export async function updateAgentSessionState({
  db,
  userId,
  sessionId,
  state,
  expectedState,
}) {
  if (!idPattern.test(sessionId || '')) return invalidSessionIdResult();

  const sanitized = sanitizeAgentSessionState(state, {
    maxStateBytes: agentConfig().sessionStateMaxBytes,
  });
  if (!sanitized.ok) {
    return {
      ok: false,
      code: sanitized.code,
      message: sanitized.message,
    };
  }

  const hasExpectedState = expectedState !== undefined;
  let expectedStateJson = null;
  if (hasExpectedState) {
    const expectedSanitized = sanitizeAgentSessionState(expectedState, {
      maxStateBytes: agentConfig().sessionStateMaxBytes,
    });
    if (!expectedSanitized.ok) {
      return {
        ok: false,
        code: expectedSanitized.code,
        message: expectedSanitized.message,
      };
    }
    expectedStateJson = serializeAgentSessionState(expectedSanitized.state);
  }

  const nextStateJson = serializeAgentSessionState(sanitized.state);
  if (hasExpectedState) {
    const [result] = await db.execute(
      `UPDATE agent_sessions
       SET state_json = ?, last_active_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP
         AND BINARY state_json = BINARY ?`,
      [nextStateJson, sessionId, userId, expectedStateJson],
    );

    if (!result.affectedRows) {
      const currentRow = await readActiveSessionRow(db, sessionId, userId);
      if (!currentRow) return sessionNotFoundResult();
      return {
        ok: false,
        code: 'AGENT_SESSION_STATE_CONFLICT',
        message: 'Agent session state changed concurrently.',
        data: { session: sessionForRow(currentRow) },
      };
    }

    const row = await readActiveSessionRow(db, sessionId, userId);
    if (!row) return sessionNotFoundResult();

    return {
      ok: true,
      message: 'Agent session state updated.',
      data: { session: sessionForRow(row) },
    };
  }

  const [result] = await db.execute(
    `UPDATE agent_sessions
     SET state_json = ?, last_active_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP`,
    [nextStateJson, sessionId, userId],
  );
  if (!result.affectedRows) return sessionNotFoundResult();

  const row = await readActiveSessionRow(db, sessionId, userId);
  if (!row) return sessionNotFoundResult();

  return {
    ok: true,
    message: 'Agent session state updated.',
    data: { session: sessionForRow(row) },
  };
}

/**
 * Update the persisted language of an active session owned by the
 * authenticated user. This is the smallest safe user-scoped
 * session-language update: when the user changes their profile language
 * between two agent messages, the session follows the profile instead of
 * answering in a stale language. Only the language column (and
 * last_active_at) is touched; the session state is preserved.
 */
export async function updateAgentSessionLanguage({ db, userId, sessionId, language }) {
  if (!idPattern.test(sessionId || '')) return invalidSessionIdResult();

  const canonicalLanguage = canonicalAgentLanguage(language);
  const [result] = await db.execute(
    `UPDATE agent_sessions
     SET language = ?, last_active_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP`,
    [canonicalLanguage, sessionId, userId],
  );
  if (!result.affectedRows) return sessionNotFoundResult();

  const row = await readActiveSessionRow(db, sessionId, userId);
  if (!row) return sessionNotFoundResult();

  return {
    ok: true,
    message: 'Agent session language updated.',
    data: { session: sessionForRow(row) },
  };
}

/**
 * Explicitly delete a session owned by the authenticated user. Related
 * audit records survive via ON DELETE SET NULL.
 */
export async function deleteAgentSession({ db, userId, sessionId }) {
  if (!idPattern.test(sessionId || '')) return invalidSessionIdResult();

  const [result] = await db.execute(
    `DELETE FROM agent_sessions
     WHERE id = ? AND user_id = ?`,
    [sessionId, userId],
  );
  if (!result.affectedRows) return sessionNotFoundResult();

  return {
    ok: true,
    message: 'Agent session deleted.',
    data: { sessionId },
  };
}

/**
 * Lazily delete already-expired sessions (bounded batch). This is a plain
 * primitive for future housekeeping - Phase A2 adds no background worker;
 * callers may invoke it opportunistically whenever convenient.
 */
export async function deleteExpiredAgentSessions({ db, maxRows = 500 }) {
  const boundedMaxRows = Math.max(1, Math.min(1000, Number(maxRows) || 500));
  const [result] = await db.execute(
    `DELETE FROM agent_sessions
     WHERE expires_at <= CURRENT_TIMESTAMP
     LIMIT ${boundedMaxRows}`,
  );
  return {
    ok: true,
    message: 'Expired agent sessions deleted.',
    data: { deletedCount: Number(result.affectedRows || 0) },
  };
}

/**
 * Atomically consume one exact pending confirmation by comparing the stored
 * state_json value and clearing pending action state before any mutation can
 * execute. Concurrent requests racing on the same confirmation id can read
 * the same state, but only one UPDATE can match the original state_json.
 */
export async function claimAgentPendingConfirmation({
  db,
  userId,
  sessionId,
  confirmationId,
  now = Date.now(),
}) {
  if (!idPattern.test(sessionId || '')) return invalidSessionIdResult();
  const canonicalConfirmationId = cleanText(confirmationId, 80);
  if (!canonicalConfirmationId) {
    return {
      ok: false,
      code: 'INVALID_AGENT_CONFIRMATION_REQUEST',
      message: 'Invalid agent confirmation request.',
    };
  }

  const row = await readActiveSessionRow(db, sessionId, userId);
  if (!row) return sessionNotFoundResult();

  const session = sessionForRow(row);
  const pendingDraft = session.state.pendingDraft;
  const pendingConfirmation = session.state.pendingConfirmation;
  if (!pendingDraft || !pendingConfirmation) {
    return {
      ok: false,
      code: 'AGENT_CONFIRMATION_NOT_FOUND',
      message: 'Agent confirmation not found.',
      data: { session },
    };
  }
  if (
    pendingDraft.confirmationId !== canonicalConfirmationId ||
    pendingConfirmation.confirmationId !== canonicalConfirmationId
  ) {
    return {
      ok: false,
      code: 'AGENT_CONFIRMATION_MISMATCH',
      message: 'Agent confirmation is no longer current.',
      data: { session },
    };
  }

  const expiresAt = Date.parse(pendingDraft.expiresAt || pendingConfirmation.expiresAt || '');
  const consumedState = {
    ...session.state,
    pendingConfirmation: null,
    pendingDraft: null,
  };
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    const [result] = await db.execute(
      `UPDATE agent_sessions
       SET state_json = ?, last_active_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP
         AND state_json = ?`,
      [
        serializeAgentSessionState(consumedState),
        sessionId,
        userId,
        row.state_json,
      ],
    );
    if (!result.affectedRows) {
      return {
        ok: false,
        code: 'AGENT_CONFIRMATION_ALREADY_CLAIMED',
        message: 'Agent confirmation was already handled.',
        data: {
          session: await rereadActiveSessionOrFallback(db, sessionId, userId, session),
        },
      };
    }
    return {
      ok: false,
      code: 'AGENT_CONFIRMATION_EXPIRED',
      message: 'Agent confirmation expired.',
      data: { session: cloneSessionWithState(row, consumedState) },
    };
  }

  const sanitized = sanitizeAgentSessionState(consumedState, {
    maxStateBytes: agentConfig().sessionStateMaxBytes,
  });
  if (!sanitized.ok) {
    return {
      ok: false,
      code: sanitized.code,
      message: sanitized.message,
      data: { session },
    };
  }

  const [result] = await db.execute(
    `UPDATE agent_sessions
     SET state_json = ?, last_active_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP
       AND state_json = ?`,
    [
      serializeAgentSessionState(sanitized.state),
      sessionId,
      userId,
      row.state_json,
    ],
  );

  if (!result.affectedRows) {
    return {
      ok: false,
      code: 'AGENT_CONFIRMATION_ALREADY_CLAIMED',
      message: 'Agent confirmation was already handled.',
      data: {
        session: await rereadActiveSessionOrFallback(db, sessionId, userId, session),
      },
    };
  }

  return {
    ok: true,
    message: 'Agent confirmation claimed.',
    data: {
      session: cloneSessionWithState(row, sanitized.state),
      pendingDraft,
      pendingConfirmation,
    },
  };
}
