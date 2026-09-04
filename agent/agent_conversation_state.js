/**
 * Phase E structured conversation bookkeeping.
 *
 * This module stores references only. It never stores transcript text,
 * capability payloads, medical facts, or model-written summaries.
 */

import { AGENT_STATE_LIMITS } from './agent_session_state.js';
import { cleanText, idPattern } from '../services/shared_utils.js';

const SUPPORTED_ENTITY_TYPES = new Set(['care_plan', 'care_gap', 'family_member']);
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;

function canonicalEntityRef(entity) {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return null;
  const type = cleanText(entity.type, AGENT_STATE_LIMITS.entityTypeMaxLength);
  const id = cleanText(String(entity.id ?? ''), AGENT_STATE_LIMITS.entityIdMaxLength);
  if (!type || !SUPPORTED_ENTITY_TYPES.has(type) || !id || !idPattern.test(id)) return null;
  return { type, id };
}

function entityFromArgs(args) {
  if (!args || typeof args !== 'object') return null;
  if (args.planId !== undefined) {
    return canonicalEntityRef({ type: 'care_plan', id: args.planId });
  }
  if (args.gapId !== undefined) {
    return canonicalEntityRef({ type: 'care_gap', id: args.gapId });
  }
  if (args.relationshipId !== undefined) {
    return canonicalEntityRef({ type: 'family_member', id: args.relationshipId });
  }
  return null;
}

/**
 * Derive focus only from a server-verified successful capability target or
 * an ownership-authorized navigation entity. Raw planner/model text is not
 * accepted here.
 */
export function deriveVerifiedCurrentFocus({ successfulCapabilityCalls = [], navigationEntity = null }) {
  const navigationRef = canonicalEntityRef(navigationEntity);
  if (navigationRef) return navigationRef;

  for (let index = successfulCapabilityCalls.length - 1; index >= 0; index -= 1) {
    const ref = entityFromArgs(successfulCapabilityCalls[index]?.args);
    if (ref) return ref;
  }
  return undefined;
}

/**
 * Build minimal ordinal-reference metadata only from successful authoritative
 * list results. Full rows/titles/facts are deliberately discarded.
 */
export function deriveVerifiedOrderedEntityList(capabilityResults = []) {
  for (let index = capabilityResults.length - 1; index >= 0; index -= 1) {
    const entry = capabilityResults[index];
    const result = entry?.result;
    if (!result?.ok) continue;

    let kind = null;
    let type = null;
    let rows = null;
    if (entry.name === 'get_care_plans' && Array.isArray(result.data?.plans)) {
      kind = 'care_plan';
      type = 'care_plan';
      rows = result.data.plans;
    } else if (entry.name === 'get_care_gaps' && Array.isArray(result.data?.gaps)) {
      kind = 'care_gap';
      type = 'care_gap';
      rows = result.data.gaps;
    } else if (entry.name === 'family_members_list' && Array.isArray(result.data?.familyMembers)) {
      kind = 'family_member';
      type = 'family_member';
      rows = result.data.familyMembers;
    }
    if (!rows) continue;

    const entities = [];
    for (const row of rows.slice(0, AGENT_STATE_LIMITS.maxOrderedEntities)) {
      const ref = canonicalEntityRef({ type, id: row?.id });
      if (ref) entities.push(ref);
    }
    return entities.length ? { kind, entities } : null;
  }
  return undefined;
}

/**
 * Server-normalized intent metadata. The model's free-form intent label is
 * never persisted. We remember only known successful capability/navigation
 * names, or null when the turn had no such verified operation.
 */
export function deriveServerNormalizedIntent({ successfulCapabilityCalls = [], navigation = null }) {
  const lastCall = successfulCapabilityCalls.at(-1);
  if (lastCall?.name && TOOL_NAME_PATTERN.test(lastCall.name)) {
    return cleanText(lastCall.name, AGENT_STATE_LIMITS.intentMaxLength) || null;
  }
  if (navigation?.target) {
    const value = `navigate_${navigation.target}`;
    return cleanText(value, AGENT_STATE_LIMITS.intentMaxLength) || null;
  }
  return null;
}

export function deriveServerCapabilityNames(successfulCapabilityCalls = []) {
  return successfulCapabilityCalls
    .map((call) => cleanText(call?.name, AGENT_STATE_LIMITS.capabilityNameMaxLength))
    .filter((name) => name && TOOL_NAME_PATTERN.test(name))
    .slice(-AGENT_STATE_LIMITS.maxCapabilityNames);
}

export function canonicalConversationEntityReference(entity) {
  return canonicalEntityRef(entity);
}
