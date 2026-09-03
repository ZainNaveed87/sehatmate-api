/**
 * Canonical bounded state contract for agent sessions (Phase A2).
 *
 * The stored state is intentionally minimal conversational bookkeeping:
 *
 *   {
 *     version: 1,
 *     lastReferencedEntities: [{ type, id }],  // small canonical references
 *     currentFocus: { type, id } | null,        // verified entity pointer
 *     recentOrderedEntityList: {                // immediate ordinal context
 *       kind,
 *       entities: [{ type, id }]
 *     } | null,
 *     lastIntent: string | null,                // server-normalized only
 *     lastCapabilityNames: [string],            // server-known tool names
 *     pendingConfirmation: { confirmationId, kind, message, expiresAt } | null,
 *     pendingDraft: { [key]: string } | null,   // shallow, string-only draft
 *     lastActionSummary: string | null
 *   }
 *
 * Hard guarantees enforced by sanitizeAgentSessionState:
 *   - only the keys above are ever stored; unknown keys are dropped
 *   - every value is shallow and length-bounded (no nested documents,
 *     no full database records, no provider responses, no raw medical text)
 *   - entity ids stay small canonical identifiers
 *   - the version field is controlled by this module, never by callers
 *   - the serialized size must stay under the configured UTF-8 byte budget
 *     (Buffer.byteLength, not JS character count, so multibyte text such
 *     as Urdu cannot slip past the limit)
 *
 * The same guarantees apply to READS: parseAgentSessionState parses the
 * stored state_json and then runs it through sanitizeAgentSessionState, so
 * unknown keys, nested/unbounded values, oversized states, and unsupported
 * versions can never escape a stored row (they all fail safe to the empty
 * state).
 *
 * sanitizeAgentSessionState never throws: it returns a structured result so
 * callers (agent_session_store.js) can map failures to stable error codes.
 */

import { cleanText, idPattern } from '../services/shared_utils.js';

export const AGENT_SESSION_STATE_VERSION = 1;
const CONVERSATION_ENTITY_TYPES = new Set(['care_plan', 'care_gap']);
const MEMORY_LABEL_PATTERN = /^[a-z][a-z0-9_]*$/;

export const AGENT_STATE_LIMITS = Object.freeze({
  maxReferencedEntities: 20,
  maxOrderedEntities: 10,
  maxCapabilityNames: 5,
  entityTypeMaxLength: 40,
  entityIdMaxLength: 64,
  orderedListKindMaxLength: 40,
  intentMaxLength: 80,
  capabilityNameMaxLength: 60,
  confirmationKindMaxLength: 40,
  confirmationIdMaxLength: 80,
  confirmationExpiresAtMaxLength: 40,
  confirmationMessageMaxLength: 500,
  draftMaxEntries: 12,
  draftKeyMaxLength: 40,
  draftValueMaxLength: 200,
  summaryMaxLength: 500,
});

export function emptyAgentSessionState() {
  return {
    version: AGENT_SESSION_STATE_VERSION,
    lastReferencedEntities: [],
    currentFocus: null,
    recentOrderedEntityList: null,
    lastIntent: null,
    lastCapabilityNames: [],
    pendingConfirmation: null,
    pendingDraft: null,
    lastActionSummary: null,
  };
}

function sanitizeEntityReference(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const type = cleanText(value.type, AGENT_STATE_LIMITS.entityTypeMaxLength);
  const id = cleanText(value.id, AGENT_STATE_LIMITS.entityIdMaxLength);
  if (!type || !CONVERSATION_ENTITY_TYPES.has(type) || !id || !idPattern.test(id)) {
    return null;
  }
  return { type, id };
}

function sanitizeReferencedEntities(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const entities = [];
  for (const entry of value.slice(0, AGENT_STATE_LIMITS.maxReferencedEntities)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const type = cleanText(entry.type, AGENT_STATE_LIMITS.entityTypeMaxLength);
    const id = cleanText(entry.id, AGENT_STATE_LIMITS.entityIdMaxLength);
    if (type && id) entities.push({ type, id });
  }
  return entities;
}

function sanitizeOrderedEntityList(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = cleanText(value.kind, AGENT_STATE_LIMITS.orderedListKindMaxLength);
  if (!kind || !CONVERSATION_ENTITY_TYPES.has(kind) || !Array.isArray(value.entities)) {
    return null;
  }
  const entities = [];
  for (const entry of value.entities.slice(0, AGENT_STATE_LIMITS.maxOrderedEntities)) {
    const entity = sanitizeEntityReference(entry);
    if (entity) entities.push(entity);
  }
  return entities.length ? { kind, entities } : null;
}

function sanitizeCapabilityNames(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const names = [];
  for (const rawName of value.slice(0, AGENT_STATE_LIMITS.maxCapabilityNames)) {
    const name = cleanText(rawName, AGENT_STATE_LIMITS.capabilityNameMaxLength);
    if (name && MEMORY_LABEL_PATTERN.test(name)) names.push(name);
  }
  return names;
}

function sanitizePendingConfirmation(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const confirmationId = cleanText(
    value.confirmationId,
    AGENT_STATE_LIMITS.confirmationIdMaxLength,
  );
  const kind = cleanText(value.kind, AGENT_STATE_LIMITS.confirmationKindMaxLength);
  const message = cleanText(value.message, AGENT_STATE_LIMITS.confirmationMessageMaxLength);
  const expiresAt = cleanText(
    value.expiresAt,
    AGENT_STATE_LIMITS.confirmationExpiresAtMaxLength,
  );
  if (!confirmationId || !kind || !message || !expiresAt) return null;
  return { confirmationId, kind, message, expiresAt };
}

function sanitizePendingDraft(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (count >= AGENT_STATE_LIMITS.draftMaxEntries) break;
    const key = cleanText(rawKey, AGENT_STATE_LIMITS.draftKeyMaxLength);
    if (!key || typeof rawValue !== 'string') continue;
    const stored = cleanText(rawValue, AGENT_STATE_LIMITS.draftValueMaxLength);
    if (!stored) continue;
    draft[key] = stored;
    count += 1;
  }
  return count > 0 ? draft : null;
}

/**
 * Validate and normalize caller-supplied session state.
 *
 * Returns { ok: true, state } with a fully sanitized, version-stamped state,
 * or { ok: false, code, message } for structurally invalid input:
 *   - INVALID_AGENT_STATE        input is not a plain object
 *   - UNSUPPORTED_AGENT_STATE_VERSION  input declares a future/unknown version
 *   - AGENT_STATE_TOO_LARGE      sanitized state exceeds the byte budget
 */
export function sanitizeAgentSessionState(input, { maxStateBytes = 16384 } = {}) {
  if (input == null) {
    return { ok: true, state: emptyAgentSessionState() };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      code: 'INVALID_AGENT_STATE',
      message: 'Agent session state must be a plain object.',
    };
  }

  if (
    input.version != null &&
    input.version !== AGENT_SESSION_STATE_VERSION
  ) {
    return {
      ok: false,
      code: 'UNSUPPORTED_AGENT_STATE_VERSION',
      message: 'Agent session state version is not supported.',
    };
  }

  const entities = sanitizeReferencedEntities(input.lastReferencedEntities);
  if (entities === null) {
    return {
      ok: false,
      code: 'INVALID_AGENT_STATE',
      message: 'lastReferencedEntities must be a list of { type, id } references.',
    };
  }

  const capabilityNames = sanitizeCapabilityNames(input.lastCapabilityNames);
  if (capabilityNames === null) {
    return {
      ok: false,
      code: 'INVALID_AGENT_STATE',
      message: 'lastCapabilityNames must be a bounded list of strings.',
    };
  }

  const state = {
    version: AGENT_SESSION_STATE_VERSION,
    lastReferencedEntities: entities,
    currentFocus: sanitizeEntityReference(input.currentFocus),
    recentOrderedEntityList: sanitizeOrderedEntityList(input.recentOrderedEntityList),
    lastIntent: (() => {
      const value = cleanText(input.lastIntent, AGENT_STATE_LIMITS.intentMaxLength);
      return value && MEMORY_LABEL_PATTERN.test(value) ? value : null;
    })(),
    lastCapabilityNames: capabilityNames,
    pendingConfirmation: sanitizePendingConfirmation(input.pendingConfirmation),
    pendingDraft: sanitizePendingDraft(input.pendingDraft),
    lastActionSummary: cleanText(input.lastActionSummary, AGENT_STATE_LIMITS.summaryMaxLength) || null,
  };

  const serialized = JSON.stringify(state);
  // The budget counts real UTF-8 bytes, not JS characters: multibyte text
  // such as Urdu must not slip past a character-count limit.
  if (Buffer.byteLength(serialized, 'utf8') > maxStateBytes) {
    return {
      ok: false,
      code: 'AGENT_STATE_TOO_LARGE',
      message: 'Agent session state is too large.',
    };
  }

  return { ok: true, state };
}

/**
 * Serialize a sanitized state for storage. Returns the canonical empty-state
 * JSON for null/undefined input so state_json never stores NULL or garbage.
 */
export function serializeAgentSessionState(state) {
  return JSON.stringify(state ?? emptyAgentSessionState());
}

/**
 * Parse stored state_json safely: JSON parse, then the exact same
 * sanitizer that guards writes. Stored JSON is never trusted, even when
 * well formed: unknown keys, nested/unbounded structures, oversized
 * states, and unsupported versions all fail safe to the canonical empty
 * state, so a stored row can never break reads and can never leak
 * non-canonical data.
 */
export function parseAgentSessionState(value, { maxStateBytes = 16384 } = {}) {
  let parsed = null;
  if (value != null && value !== '') {
    if (typeof value === 'object' && !Array.isArray(value)) {
      parsed = value;
    } else if (typeof value === 'string') {
      try {
        const candidate = JSON.parse(value);
        if (
          candidate &&
          typeof candidate === 'object' &&
          !Array.isArray(candidate)
        ) {
          parsed = candidate;
        }
      } catch {
        // fall through: malformed stored JSON fails safe below
      }
    }
  }

  if (parsed == null) return emptyAgentSessionState();

  const sanitized = sanitizeAgentSessionState(parsed, { maxStateBytes });
  return sanitized.ok ? sanitized.state : emptyAgentSessionState();
}
