/**
 * Canonical Agent Navigation Registry (Phase B).
 *
 * The backend never performs Flutter navigation itself. This module is the
 * single closed registry of SEMANTIC navigation targets the Agent may
 * emit; Phase C Flutter maps the validated { target, params } intent onto
 * real screens (lib/core/app_routes.dart is the current mapping surface).
 *
 * Security invariants enforced by this module:
 *   - The target whitelist is closed: a target exists here or it does not
 *     exist at all. Every registered target maps to a real screen of the
 *     current app architecture (dashboard home and its today section, care
 *     plans, care plan detail, reality check, simulation, care gaps, care
 *     gap detail, routine preferences, patient profile, documents,
 *     notifications, settings).
 *   - A validated navigation intent can structurally NEVER carry a route,
 *     URL, Dart code, JavaScript, or a shell command: this module stores
 *     no route strings at all, intents are a closed { target, params }
 *     shape, and the only accepted parameter values are canonical entity
 *     id strings validated by idPattern.
 *   - Entity ownership is verified through the authoritative services
 *     (plan_query_service.js / care_gap_service.js) BEFORE a navigation
 *     intent referencing a user-owned resource is emitted.
 *   - Structural validation performs no database access; authorization
 *     performs exactly one bounded ownership read per referenced entity.
 *
 * Parameter naming note: navigation params use camelCase entity keys
 * (carePlanId, careGapId) per the agent navigation contract, while data
 * capability arguments use snake_case (planId, gapId). The two
 * vocabularies are intentionally separate layers and must not be merged.
 *
 * Target/parameter requirements mirror the real Flutter screens:
 *   - CarePlanDetailScreen requires a plan id (route /care-plan/:id).
 *   - CareGapDetailScreen requires a gap id (route /care-gaps/:id).
 *   - RealityCheckScreen, SimulationScreen and CareGapsScreen accept an
 *     optional plan id (each screen falls back to its own default plan
 *     selection when the id is absent).
 *   - All remaining targets are plain screens without parameters.
 */

import { verifyCarePlanOwnership } from '../services/plan_query_service.js';
import { verifyCareGapOwnership } from '../services/care_gap_service.js';
import { cleanText, idPattern } from '../services/shared_utils.js';

const ENTITY_TITLE_MAX_LENGTH = 200;

/**
 * Frozen navigation target definitions. Each definition declares only the
 * structured params it accepts and whether each param is required. There
 * are no route strings, no URLs, and no executable content of any kind.
 */
export const AGENT_NAVIGATION_TARGETS = Object.freeze({
  home: Object.freeze({ params: Object.freeze({}) }),
  today: Object.freeze({ params: Object.freeze({}) }),
  care_plans: Object.freeze({ params: Object.freeze({}) }),
  care_plan_detail: Object.freeze({
    params: Object.freeze({ carePlanId: 'required' }),
  }),
  reality_check: Object.freeze({
    params: Object.freeze({ carePlanId: 'optional' }),
  }),
  simulation: Object.freeze({
    params: Object.freeze({ carePlanId: 'optional' }),
  }),
  care_gaps: Object.freeze({
    params: Object.freeze({ carePlanId: 'optional' }),
  }),
  care_gap_detail: Object.freeze({
    params: Object.freeze({ careGapId: 'required' }),
  }),
  routine_settings: Object.freeze({ params: Object.freeze({}) }),
  profile: Object.freeze({ params: Object.freeze({}) }),
  documents: Object.freeze({ params: Object.freeze({}) }),
  notifications: Object.freeze({ params: Object.freeze({}) }),
  settings: Object.freeze({ params: Object.freeze({}) }),
});

function invalidIntent(message) {
  return {
    ok: false,
    code: 'INVALID_NAVIGATION_INTENT',
    message,
  };
}

/**
 * Canonicalize a navigation parameter value to an entity id string.
 * Accepts either a canonical id string or a safe positive integer
 * (mirroring the id canonicalization of agent_capability_registry.js);
 * everything else is rejected.
 */
function canonicalEntityIdParam(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return idPattern.test(trimmed) ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  return null;
}

function boundedEntityTitle(title) {
  return cleanText(title, ENTITY_TITLE_MAX_LENGTH);
}

/**
 * Metadata listing of every registered navigation target. Introspection
 * only: no executable content is exposed.
 */
export function listAgentNavigationTargets() {
  return Object.entries(AGENT_NAVIGATION_TARGETS).map(([target, definition]) => ({
    target,
    params: Object.entries(definition.params).map(([name, requirement]) => ({
      name,
      required: requirement === 'required',
    })),
  }));
}

/**
 * Resolve a raw value to a registered navigation target definition.
 * Unknown, non-string, and injection-shaped values all return null.
 */
export function resolveAgentNavigationTarget(target) {
  if (typeof target !== 'string') return null;
  return AGENT_NAVIGATION_TARGETS[target] || null;
}

/**
 * Structurally validate a raw navigation intent (typically planner output)
 * WITHOUT any database access.
 *
 * A valid intent is exactly { target, params } where:
 *   - target is a registered navigation target
 *   - params (optional) is a plain object whose keys are exactly the
 *     params declared for that target, with values that canonicalize to
 *     entity id strings (explicit null param values are treated as
 *     absent, so an optional param can never smuggle content through)
 *
 * Returns:
 *   { ok: true, intent: { target, params } }  params always a plain object
 *   { ok: false, code: 'INVALID_NAVIGATION_INTENT', message }
 *   { ok: true, intent: null }                 for null/undefined input
 */
export function validateAgentNavigationIntent(intent) {
  if (intent == null) {
    return { ok: true, intent: null };
  }
  if (typeof intent !== 'object' || Array.isArray(intent)) {
    return invalidIntent('Navigation intent must be an object or null.');
  }
  for (const key of Object.keys(intent)) {
    if (key !== 'target' && key !== 'params') {
      return invalidIntent(`Navigation intent has an unknown field: ${key}.`);
    }
  }

  const definition = resolveAgentNavigationTarget(intent.target);
  if (!definition) {
    return invalidIntent('Navigation target is not registered.');
  }

  let rawParams = intent.params;
  if (rawParams === undefined || rawParams === null) rawParams = {};
  if (typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return invalidIntent('Navigation params must be an object.');
  }

  const canonicalParams = {};
  for (const [name, value] of Object.entries(rawParams)) {
    const requirement = definition.params[name];
    if (requirement === undefined) {
      return invalidIntent(
        `Navigation target ${intent.target} does not accept param ${name}.`,
      );
    }
    if (value === null || value === undefined) continue;
    const canonical = canonicalEntityIdParam(value);
    if (canonical === null) {
      return invalidIntent(`Navigation param ${name} must be a valid entity id.`);
    }
    canonicalParams[name] = canonical;
  }
  for (const [name, requirement] of Object.entries(definition.params)) {
    if (requirement === 'required' && canonicalParams[name] === undefined) {
      return invalidIntent(`Navigation target ${intent.target} requires param ${name}.`);
    }
  }

  return { ok: true, intent: { target: intent.target, params: canonicalParams } };
}

/**
 * Validate AND authorize a navigation intent for the authenticated user.
 * This registry is the single authority for the NAVIGATION permission
 * class: an intent is emitted only when its target is registered, its
 * params are structurally valid, and every referenced entity is owned by
 * the authenticated user.
 *
 * Returns:
 *   { ok: true, navigation: { target, params } | null,
 *     entity: { type, id, title, planId? } | null }
 *     navigation is null when the input intent is null (no navigation).
 *     entity describes the verified referenced entity, when any, so the
 *     caller (agent_core) can record it in the session's bounded
 *     lastReferencedEntities state; titles are length-bounded because
 *     they may later surface in provider-visible context.
 *   { ok: false, code: 'INVALID_NAVIGATION_INTENT' | 'PLAN_NOT_FOUND' |
 *     'GAP_NOT_FOUND' | 'INVALID_PLAN_ID' | 'INVALID_GAP_ID', message }
 *
 * Structural failure performs no database access at all.
 */
export async function authorizeAgentNavigationIntent({ intent, pool, userId }) {
  const validated = validateAgentNavigationIntent(intent);
  if (!validated.ok) return validated;
  if (validated.intent === null) {
    return { ok: true, navigation: null, entity: null };
  }

  const { target, params } = validated.intent;
  let entity = null;

  if (params.carePlanId !== undefined) {
    const owned = await verifyCarePlanOwnership({
      pool,
      userId,
      planId: params.carePlanId,
    });
    if (!owned.ok) return owned;
    entity = {
      type: 'care_plan',
      id: params.carePlanId,
      title: boundedEntityTitle(owned.data.title),
    };
  }

  if (params.careGapId !== undefined) {
    const owned = await verifyCareGapOwnership({
      pool,
      userId,
      gapId: params.careGapId,
    });
    if (!owned.ok) return owned;
    // readCareGapForUser already scopes the gap through a plan owned by
    // the authenticated user, so the parent plan reference is safe.
    entity = {
      type: 'care_gap',
      id: params.careGapId,
      planId: owned.data.planId,
      title: boundedEntityTitle(owned.data.title),
    };
  }

  return { ok: true, navigation: { target, params }, entity };
}
