/**
 * Transport-independent audit service for future accountable agent actions
 * (Phase A2).
 *
 * This module only records and reads audit rows. It provides NO execution
 * path of any kind: FORBIDDEN_CLINICAL_ACTION is a policy classification
 * that exists so a rejected clinical request can be audited - there is and
 * will never be a code path here that treats it (or any other class) as
 * executable. Tool execution belongs to later phases.
 *
 * Privacy principle: audit only what is needed to prove what action was
 * requested/executed. Never stored here: authorization headers, raw JWTs,
 * provider API keys, full conversational transcripts, or database dumps.
 *
 * Ownership: when an audit record references a session, recordAgentAction
 * first verifies with a parameterized query that the session belongs to
 * the authenticated user. Missing and foreign sessions fail with the same
 * non-enumerating code, so nothing is revealed about other users'
 * sessions, and one user's audit rows can never be attached to another
 * user's session.
 *
 * Forbidden clinical invariant: FORBIDDEN_CLINICAL_ACTION rows may only
 * be audited as resultStatus 'rejected' with backendConfirmed false. Any
 * other combination would falsify the healthcare audit trail and is
 * rejected with INVALID_AGENT_AUDIT_STATE before any database access.
 *
 * The input payload is NOT a generic logging endpoint: it must be a plain,
 * shallow-bounded object whose secret-like keys (password/token/api key/
 * authorization/credential patterns) are stripped before persistence, and
 * whose serialized size must stay under the configured byte budget.
 *
 * Canonical permission classes and result statuses are defined ONLY here,
 * so every future caller shares one central definition.
 */

import { cleanText, idPattern } from '../services/shared_utils.js';
import { agentConfig } from './agent_config.js';

export const AGENT_PERMISSION_CLASSES = Object.freeze([
  'READ',
  'NAVIGATION',
  'DRAFT',
  'REVERSIBLE_USER_ACTION',
  'SENSITIVE_ACTION',
  'FORBIDDEN_CLINICAL_ACTION',
]);

export const AGENT_ACTION_RESULT_STATUSES = Object.freeze([
  'succeeded',
  'rejected',
  'failed',
]);

export function isAgentPermissionClass(value) {
  return AGENT_PERMISSION_CLASSES.includes(value);
}

export function isAgentActionResultStatus(value) {
  return AGENT_ACTION_RESULT_STATUSES.includes(value);
}

export const AGENT_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;

export const SECRET_LIKE_KEY_PATTERN =
  /passw|secret|token|api[-_]?key|authorization|bearer|jwt|credential|cookie/i;

export const AGENT_AUDIT_LIMITS = Object.freeze({
  inputMaxDepth: 4,
  inputMaxArrayItems: 50,
  inputMaxObjectEntries: 40,
  inputMaxStringLength: 500,
  targetTypeMaxLength: 40,
  targetIdMaxLength: 191,
  errorCodeMaxLength: 80,
  maxReadLimit: 200,
  defaultReadLimit: 50,
});

function invalidValueResult(code, message) {
  return { ok: false, code, message };
}

function sanitizeValue(value, depth) {
  if (value == null) return null;
  if (typeof value === 'string') {
    return cleanText(value, AGENT_AUDIT_LIMITS.inputMaxStringLength);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (depth >= AGENT_AUDIT_LIMITS.inputMaxDepth) {
    return null;
  }
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value.slice(0, AGENT_AUDIT_LIMITS.inputMaxArrayItems)) {
      const sanitized = sanitizeValue(item, depth + 1);
      if (sanitized !== null) items.push(sanitized);
    }
    return items;
  }
  if (typeof value === 'object') {
    const entries = {};
    let count = 0;
    for (const [rawKey, rawValue] of Object.entries(value)) {
      if (count >= AGENT_AUDIT_LIMITS.inputMaxObjectEntries) break;
      const key = cleanText(rawKey, AGENT_AUDIT_LIMITS.inputMaxStringLength);
      if (!key || SECRET_LIKE_KEY_PATTERN.test(key)) continue;
      const sanitized = sanitizeValue(rawValue, depth + 1);
      if (sanitized === null) continue;
      entries[key] = sanitized;
      count += 1;
    }
    return entries;
  }
  return null;
}

/**
 * Sanitize a caller-supplied audit input payload: plain bounded data only,
 * secret-like keys stripped recursively, unknown value types dropped.
 * Returns { ok: true, json } (json is null for a null/empty input) or
 * { ok: false, code, message }.
 */
export function sanitizeAgentActionInput(input, { maxStateBytes = 16384 } = {}) {
  if (input == null) return { ok: true, json: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return invalidValueResult(
      'INVALID_AGENT_ACTION_INPUT',
      'Agent action input must be a plain object.',
    );
  }
  const sanitized = sanitizeValue(input, 0);
  const json = Object.keys(sanitized).length > 0 ? JSON.stringify(sanitized) : null;
  // The budget counts real UTF-8 bytes, not JS characters: multibyte text
  // such as Urdu must not slip past a character-count limit.
  if (json != null && Buffer.byteLength(json, 'utf8') > maxStateBytes) {
    return invalidValueResult(
      'AGENT_ACTION_INPUT_TOO_LARGE',
      'Agent action input is too large.',
    );
  }
  return { ok: true, json };
}

function actionForRow(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    sessionId: row.session_id == null ? null : String(row.session_id),
    toolName: row.tool_name,
    permissionClass: row.permission_class,
    input: row.input_json == null ? null : safeParseInput(row.input_json),
    resultStatus: row.result_status,
    backendConfirmed: Number(row.backend_confirmed) === 1,
    targetType: row.target_type || null,
    targetId: row.target_id || null,
    errorCode: row.error_code || null,
    createdAt: row.created_at,
  };
}

function safeParseInput(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Record one agent action audit row. Every write receives the authenticated
 * userId explicitly and all canonical values are validated here, so callers
 * can never persist arbitrary permission classes, tool names, or unbounded
 * payloads. A non-null sessionId is verified to belong to the authenticated
 * user immediately before the insert, and FORBIDDEN_CLINICAL_ACTION rows
 * must be rejected-and-unconfirmed (INVALID_AGENT_AUDIT_STATE).
 */
export async function recordAgentAction({
  db,
  userId,
  sessionId = null,
  toolName,
  permissionClass,
  input = null,
  resultStatus,
  backendConfirmed = false,
  targetType = null,
  targetId = null,
  errorCode = null,
}) {
  if (!idPattern.test(sessionId || '') && sessionId != null) {
    return invalidValueResult(
      'INVALID_AGENT_SESSION_ID',
      'Invalid agent session ID.',
    );
  }

  const canonicalToolName = cleanText(toolName, 60);
  if (!AGENT_TOOL_NAME_PATTERN.test(canonicalToolName)) {
    return invalidValueResult(
      'INVALID_AGENT_TOOL_NAME',
      'Agent tool name must be a lowercase snake_case identifier.',
    );
  }

  if (!isAgentPermissionClass(permissionClass)) {
    return invalidValueResult(
      'INVALID_AGENT_PERMISSION_CLASS',
      'Agent permission class is not a canonical class.',
    );
  }

  if (!isAgentActionResultStatus(resultStatus)) {
    return invalidValueResult(
      'INVALID_AGENT_ACTION_RESULT_STATUS',
      'Agent action result status is not a canonical status.',
    );
  }

  if (
    permissionClass === 'FORBIDDEN_CLINICAL_ACTION' &&
    (resultStatus !== 'rejected' || backendConfirmed)
  ) {
    return invalidValueResult(
      'INVALID_AGENT_AUDIT_STATE',
      'Forbidden clinical actions can only be audited as rejected and unconfirmed.',
    );
  }

  const sanitizedInput = sanitizeAgentActionInput(input, {
    maxStateBytes: agentConfig().sessionStateMaxBytes,
  });
  if (!sanitizedInput.ok) {
    return {
      ok: false,
      code: sanitizedInput.code,
      message: sanitizedInput.message,
    };
  }

  if (sessionId != null) {
    const [sessionRows] = await db.execute(
      `SELECT id
       FROM agent_sessions
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
      [sessionId, userId],
    );
    if (!sessionRows.length) {
      return {
        ok: false,
        code: 'AGENT_SESSION_NOT_FOUND',
        message: 'Agent session not found.',
      };
    }
  }

  const [result] = await db.execute(
    `INSERT INTO agent_action_audit
      (user_id, session_id, tool_name, permission_class, input_json,
       result_status, backend_confirmed, target_type, target_id, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      sessionId == null ? null : sessionId,
      canonicalToolName,
      permissionClass,
      sanitizedInput.json,
      resultStatus,
      backendConfirmed ? 1 : 0,
      cleanText(targetType, AGENT_AUDIT_LIMITS.targetTypeMaxLength) || null,
      cleanText(targetId, AGENT_AUDIT_LIMITS.targetIdMaxLength) || null,
      cleanText(errorCode, AGENT_AUDIT_LIMITS.errorCodeMaxLength) || null,
    ],
  );

  return {
    ok: true,
    message: 'Agent action recorded.',
    data: { actionId: String(result.insertId) },
  };
}

/**
 * Read the authenticated user's audit trail (newest first), optionally
 * narrowed to one session. Queries always bind the user id, so cross-user
 * audit reads are impossible through this API.
 */
export async function readAgentActionsForUser({
  db,
  userId,
  sessionId = null,
  limit = AGENT_AUDIT_LIMITS.defaultReadLimit,
}) {
  if (sessionId != null && !idPattern.test(sessionId)) {
    return invalidValueResult(
      'INVALID_AGENT_SESSION_ID',
      'Invalid agent session ID.',
    );
  }

  const boundedLimit = Math.max(
    1,
    Math.min(AGENT_AUDIT_LIMITS.maxReadLimit, Number(limit) || AGENT_AUDIT_LIMITS.defaultReadLimit),
  );

  const [rows] = await db.execute(
    `SELECT id, user_id, session_id, tool_name, permission_class, input_json,
            result_status, backend_confirmed, target_type, target_id,
            error_code, created_at
     FROM agent_action_audit
     WHERE user_id = ?${sessionId != null ? ' AND session_id = ?' : ''}
     ORDER BY id DESC
     LIMIT ${boundedLimit}`,
    sessionId != null ? [userId, sessionId] : [userId],
  );

  return {
    ok: true,
    message: 'Agent actions loaded.',
    data: { actions: rows.map(actionForRow) },
  };
}