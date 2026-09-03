/**
 * Bounded Agent Context Engine (Phase B).
 *
 * The Context Engine never dumps the database into the LLM. It validates
 * the small semantic screen context the client may send, verifies entity
 * ownership BEFORE any plan/gap data is loaded, and assembles the bounded
 * verified context slice that planning and response generation may see.
 *
 * Security invariants enforced by this module:
 *   - screenId must be allowlisted. The allowlist is derived from
 *     AGENT_NAVIGATION_TARGETS in agent_navigation_registry.js, so "the
 *     screens the app can navigate to" and "the screens the agent can be
 *     invoked from" are one and the same closed vocabulary - there is no
 *     second screen list to drift out of sync.
 *   - entity type must be allowlisted (care_plan, care_gap - exactly the
 *     entity types the Phase B READ capabilities cover).
 *   - entity id must be validated (idPattern, numeric ids canonicalized
 *     to strings) and OWNERSHIP must be verified through the authoritative
 *     services (plan_query_service.js / care_gap_service.js) before the
 *     entity can enter any context slice.
 *   - Client-supplied medical facts can never become authoritative: the
 *     context contract accepts only { screenId, entity: { type, id } } -
 *     there is no free-text field through which a client could inject a
 *     clinical fact, and unknown context keys never enter any slice.
 *   - Malformed or unowned context is DROPPED (fail safe), never an
 *     error: the conversation continues without screen awareness and the
 *     agent asks a clarification question when an answer needs the
 *     missing context. A bounded notice token records what was dropped
 *     for diagnostics; notices are internal and never client-facing.
 *
 * Bounded provider-facing slice contents (buildAgentContextSlice):
 *   language            canonical agent language code (en / ur / roman_ur)
 *   screenId            current screen, when known and allowlisted
 *   currentEntity       verified currently-referenced entity reference
 *   recentEntities      tail of the session's canonical entity references
 *   lastActionSummary   bounded summary of the last agent action
 *
 * The authenticated userId is deliberately NOT part of the slice: identity
 * is enforced by scoping every ownership read, and the provider never
 * needs it. The slice contains no secrets, no raw database records, and
 * no conversation transcripts.
 */

import { AGENT_NAVIGATION_TARGETS } from './agent_navigation_registry.js';
import { verifyCarePlanOwnership } from '../services/plan_query_service.js';
import { verifyCareGapOwnership } from '../services/care_gap_service.js';
import { cleanText, idPattern } from '../services/shared_utils.js';
import { canonicalAgentLanguage } from './agent_session_store.js';

/**
 * Allowlisted screen ids - exactly the registered navigation targets.
 * The frozen derived array keeps the two vocabularies in lockstep.
 */
const AGENT_SCREEN_IDS = Object.freeze(Object.keys(AGENT_NAVIGATION_TARGETS));

/**
 * Allowlisted context entity types - exactly the entity types the Phase B
 * READ capabilities can resolve (care plans and care gaps). Appointments
 * are intentionally absent: there is no authoritative appointment source
 * yet, so no appointment context may exist either.
 */
const AGENT_CONTEXT_ENTITY_TYPES = Object.freeze(['care_plan', 'care_gap']);

/**
 * Session state may keep up to 20 references (agent_session_state.js),
 * but the provider-facing slice only ever exposes the most recent few.
 */
const MAX_RECENT_ENTITIES_IN_SLICE = 5;
const MAX_ORDERED_ENTITIES_IN_SLICE = 10;

const ENTITY_TITLE_MAX_LENGTH = 200;

export function listAgentScreenIds() {
  return AGENT_SCREEN_IDS;
}

export function isAgentScreenId(value) {
  return typeof value === 'string' && AGENT_SCREEN_IDS.includes(value);
}

export function listAgentContextEntityTypes() {
  return AGENT_CONTEXT_ENTITY_TYPES;
}

function invalidEntityReference(message) {
  return {
    ok: false,
    code: 'INVALID_ENTITY_REFERENCE',
    message,
  };
}

/**
 * Structurally validate an entity reference { type, id } without any
 * database access. The shape is closed (only type and id), the type must
 * be allowlisted, and the id is canonicalized to an id string exactly the
 * way agent_capability_registry.js and agent_navigation_registry.js do.
 *
 * Returns:
 *   { ok: true, entity: { type, id } }
 *   { ok: false, code: 'INVALID_ENTITY_REFERENCE', message }
 */
export function validateAgentEntityReference(entity) {
  if (entity == null) {
    return invalidEntityReference('Entity reference is required.');
  }
  if (typeof entity !== 'object' || Array.isArray(entity)) {
    return invalidEntityReference('Entity reference must be an object.');
  }
  for (const key of Object.keys(entity)) {
    if (key !== 'type' && key !== 'id') {
      return invalidEntityReference(`Entity reference has an unknown field: ${key}.`);
    }
  }

  const { type, id } = entity;
  if (typeof type !== 'string' || !AGENT_CONTEXT_ENTITY_TYPES.includes(type)) {
    return invalidEntityReference('Entity type is not allowlisted.');
  }

  let canonicalId = null;
  if (typeof id === 'string') {
    const trimmed = id.trim();
    if (idPattern.test(trimmed)) canonicalId = trimmed;
  } else if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
    canonicalId = String(id);
  }
  if (canonicalId === null) {
    return invalidEntityReference('Entity id must be a valid entity id.');
  }

  return { ok: true, entity: { type, id: canonicalId } };
}

/**
 * Verify entity ownership through the authoritative services. This is the
 * ownership gate required BEFORE any plan/gap data is loaded: a single
 * bounded ownership read per entity, never a full detail payload.
 *
 * Returns:
 *   { ok: true, entity: { type, id, title, planId? } }
 *     title is length-bounded because it may later surface in
 *     provider-visible context; planId is present for care_gap entities
 *     (the parent plan the gap was reached through).
 *   { ok: false, code: 'INVALID_ENTITY_REFERENCE' | 'ENTITY_NOT_FOUND',
 *     message }
 */
export async function verifyAgentEntityOwnership({ pool, userId, entity }) {
  const validated = validateAgentEntityReference(entity);
  if (!validated.ok) return validated;

  if (validated.entity.type === 'care_plan') {
    const owned = await verifyCarePlanOwnership({
      pool,
      userId,
      planId: validated.entity.id,
    });
    if (!owned.ok) {
      return {
        ok: false,
        code: 'ENTITY_NOT_FOUND',
        message: 'Referenced care plan is not available for this user.',
      };
    }
    return {
      ok: true,
      entity: {
        type: 'care_plan',
        id: validated.entity.id,
        title: cleanText(owned.data.title, ENTITY_TITLE_MAX_LENGTH),
      },
    };
  }

  const owned = await verifyCareGapOwnership({
    pool,
    userId,
    gapId: validated.entity.id,
  });
  if (!owned.ok) {
    return {
      ok: false,
      code: 'ENTITY_NOT_FOUND',
      message: 'Referenced care gap is not available for this user.',
    };
  }
  return {
    ok: true,
    entity: {
      type: 'care_gap',
      id: validated.entity.id,
      planId: owned.data.planId,
      title: cleanText(owned.data.title, ENTITY_TITLE_MAX_LENGTH),
    },
  };
}

/**
 * Validate the untrusted client screen context from the request body.
 * Every invalid or unowned piece is DROPPED (fail safe) with a bounded
 * notice token; the conversation itself continues.
 *
 * A non-object context drops entirely; a valid screenId and a valid owned
 * entity are kept independently (either may survive without the other).
 *
 * Returns { ok: true, screenContext: { screenId, entity } | null,
 * notices: string[] }. This function never returns ok: false - malformed
 * context is not an error, it is absent context.
 */
export async function readAgentScreenContext({ pool, userId, clientContext }) {
  const notices = [];
  if (clientContext == null) {
    return { ok: true, screenContext: null, notices };
  }
  if (typeof clientContext !== 'object' || Array.isArray(clientContext)) {
    return { ok: true, screenContext: null, notices: ['context_dropped'] };
  }
  for (const key of Object.keys(clientContext)) {
    if (key !== 'screenId' && key !== 'entity') {
      notices.push('unknown_context_key');
      break;
    }
  }

  let screenId = null;
  if (clientContext.screenId !== undefined && clientContext.screenId !== null) {
    if (isAgentScreenId(clientContext.screenId)) {
      screenId = clientContext.screenId;
    } else {
      notices.push('screen_id_dropped');
    }
  }

  let entity = null;
  if (clientContext.entity !== undefined && clientContext.entity !== null) {
    const owned = await verifyAgentEntityOwnership({
      pool,
      userId,
      entity: clientContext.entity,
    });
    if (owned.ok) {
      entity = owned.entity;
    } else {
      notices.push('entity_dropped');
    }
  }

  if (screenId === null && entity === null) {
    return { ok: true, screenContext: null, notices };
  }
  return { ok: true, screenContext: { screenId, entity }, notices };
}

/**
 * Revalidate every persisted conversation reference before Phase E uses it.
 * Session memory is a pointer cache, never an authorization cache.
 */
export async function readAgentConversationStateContext({
  pool,
  userId,
  sessionState = null,
}) {
  const state = sessionState || {};
  const verifiedByKey = new Map();

  const verify = async (rawEntity) => {
    const validated = validateAgentEntityReference(rawEntity);
    if (!validated.ok) return null;
    const key = `${validated.entity.type}:${validated.entity.id}`;
    if (verifiedByKey.has(key)) return verifiedByKey.get(key);
    const owned = await verifyAgentEntityOwnership({
      pool,
      userId,
      entity: validated.entity,
    });
    const entity = owned.ok ? owned.entity : null;
    verifiedByKey.set(key, entity);
    return entity;
  };

  const currentFocus = await verify(state.currentFocus);

  const recentEntities = [];
  for (const rawEntity of (Array.isArray(state.lastReferencedEntities)
    ? state.lastReferencedEntities.slice(-MAX_RECENT_ENTITIES_IN_SLICE)
    : [])) {
    const entity = await verify(rawEntity);
    if (entity) recentEntities.push(entity);
  }

  let recentOrderedEntityList = null;
  if (
    state.recentOrderedEntityList &&
    Array.isArray(state.recentOrderedEntityList.entities)
  ) {
    const entities = [];
    for (const rawEntity of state.recentOrderedEntityList.entities.slice(
      0,
      MAX_ORDERED_ENTITIES_IN_SLICE,
    )) {
      const entity = await verify(rawEntity);
      if (entity) entities.push(entity);
    }
    if (entities.length) {
      recentOrderedEntityList = {
        kind: cleanText(state.recentOrderedEntityList.kind, 40),
        entities,
      };
    }
  }

  return {
    ok: true,
    currentFocus,
    recentEntities,
    recentOrderedEntityList,
    lastIntent:
      typeof state.lastIntent === 'string' ? cleanText(state.lastIntent, 80) || null : null,
    lastCapabilityNames: Array.isArray(state.lastCapabilityNames)
      ? state.lastCapabilityNames
          .map((name) => cleanText(name, 60))
          .filter(Boolean)
          .slice(0, 5)
      : [],
  };
}

/**
 * Assemble the bounded, provider-safe context slice from validated parts.
 * Pure function: no database access, no transport objects.
 *
 *   language            normalized canonical agent language code
 *   screenId            allowlisted current screen or null
 *   currentEntity       verified entity reference or null
 *   recentEntities      tail of the session's canonical references
 *                       (bounded to MAX_RECENT_ENTITIES_IN_SLICE, most
 *                       recent last, each re-validated so only canonical
 *                       references can ever reach the provider)
 *   lastActionSummary   bounded string or null
 *
 * pendingConfirmation / pendingDraft from the session state are
 * intentionally excluded from the Phase B slice: they belong to the
 * future DRAFT phases and are always null until those phases exist.
 */
export function buildAgentContextSlice({
  language,
  screenContext = null,
  sessionState = null,
  conversationContext = null,
  referenceResolution = null,
}) {
  const state = sessionState || {};

  const recentEntities = conversationContext
    ? (conversationContext.recentEntities || []).slice(-MAX_RECENT_ENTITIES_IN_SLICE)
    : (Array.isArray(state.lastReferencedEntities)
        ? state.lastReferencedEntities
        : [])
        .slice(-MAX_RECENT_ENTITIES_IN_SLICE)
        .map((item) => validateAgentEntityReference(item))
        .filter((result) => result.ok)
        .map((result) => result.entity);

  const currentFocus = conversationContext?.currentFocus || null;
  const ordered = conversationContext?.recentOrderedEntityList || null;

  return Object.freeze({
    language: canonicalAgentLanguage(language),
    screenId: screenContext?.screenId || null,
    currentEntity: screenContext?.entity || null,
    currentFocus: currentFocus
      ? Object.freeze({ type: currentFocus.type, id: currentFocus.id })
      : null,
    recentEntities: Object.freeze(
      recentEntities.map((item) => Object.freeze({ type: item.type, id: item.id })),
    ),
    recentOrderedEntityList: ordered
      ? Object.freeze({
          kind: ordered.kind,
          entities: Object.freeze(
            ordered.entities.map((item) => Object.freeze({ type: item.type, id: item.id })),
          ),
        })
      : null,
    lastIntent: conversationContext?.lastIntent || null,
    lastCapabilityNames: Object.freeze([
      ...(conversationContext?.lastCapabilityNames || []),
    ]),
    referenceResolution: referenceResolution || null,
    lastActionSummary:
      typeof state.lastActionSummary === 'string' ? state.lastActionSummary : null,
  });
}
