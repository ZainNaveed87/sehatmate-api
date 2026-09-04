/**
 * Phase E deterministic conversation-reference resolver.
 *
 * This module resolves pointers only. It never executes an Agent capability,
 * never mutates user data, and never treats remembered facts as truth.
 */

import { cleanText } from '../services/shared_utils.js';
import { canonicalAgentLanguage } from './agent_session_store.js';

const CONFIRM_PHRASES = new Set([
  'yes', 'confirm', 'okay', 'ok', 'do it', 'haan', 'han', 'ji', 'theek hai',
  'ہاں', 'جی', 'ٹھیک ہے', 'تصدیق کریں',
]);
const CANCEL_PHRASES = new Set([
  'no', 'cancel', 'nahi', 'nahin', 'rehne do', 'leave it',
  'نہیں', 'نہی', 'رہنے دو', 'منسوخ', 'منسوخ کریں',
]);

const LATIN_ORDINALS = Object.freeze([
  { index: 0, patterns: [/\bfirst one\b/i, /\bfirst wala\b/i, /\bpehla wala\b/i, /\bpehli wali\b/i] },
  { index: 1, patterns: [/\bsecond one\b/i, /\bsecond wala\b/i, /\bdoosra wala\b/i, /\bdusra wala\b/i, /\bdoosri wali\b/i] },
]);
const URDU_ORDINALS = Object.freeze([
  { index: 0, phrases: ['پہلا والا', 'پہلی والی'] },
  { index: 1, phrases: ['دوسرا والا', 'دوسری والی'] },
]);

const LATIN_REFERENCE_PATTERNS = [
  /\biska\b/i, /\biski\b/i, /\biske\b/i, /\bus wala\b/i, /\bus wali\b/i,
  /\bye wala\b/i, /\byeh wala\b/i, /\bye wali\b/i, /\byeh wali\b/i,
  /\bunke\b/i, /\bunki\b/i, /\bunka\b/i, /\btheir\b/i,
  /\bthis one\b/i, /\bthat one\b/i, /\bsame plan\b/i, /\bsame gap\b/i,
  /\bthis plan\b/i, /\bthat plan\b/i, /\bthis gap\b/i, /\bthat gap\b/i,
];
const URDU_REFERENCE_PHRASES = [
  'اس کا', 'اس کی', 'اس کے', 'یہ والا', 'یہ والی', 'وہ والا', 'وہ والی',
  'ان کا', 'ان کی', 'ان کے',
  'اسی پلان', 'اسی منصوبے', 'اسی گیپ', 'اسی خلا',
];

function normalizeBarePhrase(message) {
  return String(message || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:،؟]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeEntities(entities) {
  const byKey = new Map();
  for (const entity of entities || []) {
    if (!entity?.type || !entity?.id) continue;
    byKey.set(`${entity.type}:${entity.id}`, entity);
  }
  return [...byKey.values()];
}

export function classifyBareConfirmationDecision(message) {
  const normalized = normalizeBarePhrase(message);
  if (!normalized) return null;
  if (CONFIRM_PHRASES.has(normalized)) return 'confirm';
  if (CANCEL_PHRASES.has(normalized)) return 'cancel';
  return null;
}

function ordinalIndex(message) {
  const raw = String(message || '');
  for (const entry of LATIN_ORDINALS) {
    if (entry.patterns.some((pattern) => pattern.test(raw))) return entry.index;
  }
  for (const entry of URDU_ORDINALS) {
    if (entry.phrases.some((phrase) => raw.includes(phrase))) return entry.index;
  }
  return null;
}

function hasPronounReference(message) {
  const raw = String(message || '');
  return LATIN_REFERENCE_PATTERNS.some((pattern) => pattern.test(raw)) ||
    URDU_REFERENCE_PHRASES.some((phrase) => raw.includes(phrase));
}

function referenceEntityTypeHint(message) {
  const normalized = normalizeSearchText(message);
  if (/\b(?:family|member|ammi|abu|ami|abba|mother|father|patient)\b/.test(normalized)) {
    return 'family_member';
  }
  if (/\b(?:same|this|that)\s+plan\b/.test(normalized) || normalized.includes('care plan')) {
    return 'care_plan';
  }
  if (/\b(?:same|this|that)\s+(?:gap|care gap)\b/.test(normalized) || normalized.includes('care gap')) {
    return 'care_gap';
  }
  if (String(message || '').includes('care gap') || String(message || '').includes('دیکھ بھال کے خلا')) {
    return 'care_gap';
  }
  return null;
}

function titleMatches(message, entity) {
  const title = normalizeSearchText(entity?.title);
  const haystack = normalizeSearchText(message);
  if (!title || title.length < 2) return false;
  if (title === 'plan' || title === 'care plan' || title === 'careplan') return false;
  return haystack.includes(title);
}

function explicitEntityMatches({ message, existingEntities }) {
  return dedupeEntities(existingEntities).filter(
    (entity) =>
      (entity.type === 'care_plan' || entity.type === 'family_member') &&
      titleMatches(message, entity),
  );
}

/**
 * Resolve explicit titles, ordinals, and pronouns from already ownership-
 * verified context. The returned entity is a pointer only.
 */
export async function resolveAgentConversationReference({
  pool,
  userId,
  message,
  screenEntity = null,
  currentFocus = null,
  recentEntities = [],
  recentOrderedEntityList = null,
  familyMembers = [],
}) {
  const orderedEntities = Array.isArray(recentOrderedEntityList?.entities)
    ? recentOrderedEntityList.entities
    : [];
  const allKnown = dedupeEntities([
    ...(screenEntity ? [screenEntity] : []),
    ...(currentFocus ? [currentFocus] : []),
    ...recentEntities,
    ...orderedEntities,
    ...familyMembers,
  ]);

  const explicitMatches = explicitEntityMatches({
    message,
    existingEntities: allKnown,
  });
  if (explicitMatches.length === 1) {
    return { status: 'resolved', source: 'explicit_current_turn', entity: explicitMatches[0], candidates: explicitMatches };
  }
  if (explicitMatches.length > 1) {
    return { status: 'ambiguous', source: 'explicit_current_turn', entity: null, candidates: explicitMatches };
  }

  const ordinal = ordinalIndex(message);
  if (ordinal !== null) {
    if (!orderedEntities.length || ordinal >= orderedEntities.length) {
      return { status: 'missing', source: 'ordinal', entity: null, candidates: orderedEntities, reason: 'ordinal_out_of_range' };
    }
    return { status: 'resolved', source: 'ordinal', entity: orderedEntities[ordinal], candidates: orderedEntities };
  }

  if (!hasPronounReference(message)) {
    return { status: 'none', source: null, entity: null, candidates: [] };
  }


  const typeHint = referenceEntityTypeHint(message);

  if (screenEntity && (!typeHint || screenEntity.type === typeHint)) {
    return { status: 'resolved', source: 'screen_entity', entity: screenEntity, candidates: [screenEntity] };
  }
  if (currentFocus && (!typeHint || currentFocus.type === typeHint)) {
    return { status: 'resolved', source: 'current_focus', entity: currentFocus, candidates: [currentFocus] };
  }

  const candidates = dedupeEntities(recentEntities.length ? recentEntities : orderedEntities)
    .filter((entity) => !typeHint || entity.type === typeHint);
  if (candidates.length === 1) {
    return { status: 'resolved', source: 'recent_entity', entity: candidates[0], candidates };
  }
  return {
    status: candidates.length > 1 ? 'ambiguous' : 'missing',
    source: 'pronoun',
    entity: null,
    candidates,
    reason: candidates.length > 1 ? 'multiple_candidates' : 'no_candidate',
  };
}

function plannedEntityReferences(plan) {
  const refs = [];
  for (const call of plan?.capabilityCalls || []) {
    if (call?.args?.planId !== undefined) {
      refs.push({ type: 'care_plan', id: String(call.args.planId), source: `capability:${call.name}` });
    }
    if (call?.args?.gapId !== undefined) {
      refs.push({ type: 'care_gap', id: String(call.args.gapId), source: `capability:${call.name}` });
    }
    if (call?.args?.relationshipId !== undefined) {
      refs.push({ type: 'family_member', id: String(call.args.relationshipId), source: `capability:${call.name}` });
    }
  }
  const params = plan?.navigationIntent?.params || {};
  if (params.carePlanId !== undefined) {
    refs.push({ type: 'care_plan', id: String(params.carePlanId), source: `navigation:${plan.navigationIntent.target}` });
  }
  if (params.careGapId !== undefined) {
    refs.push({ type: 'care_gap', id: String(params.careGapId), source: `navigation:${plan.navigationIntent.target}` });
  }
  if (params.relationshipId !== undefined) {
    refs.push({ type: 'family_member', id: String(params.relationshipId), source: `navigation:${plan.navigationIntent.target}` });
  }
  return refs;
}

/**
 * Defense in depth: when the current message used a conversational reference,
 * every entity-bearing planner action must bind to the exact resolved type/id.
 */
export function reviewPlanAgainstResolvedReference({ plan, resolution }) {
  if (!resolution || resolution.status !== 'resolved' || !resolution.entity) {
    return { ok: true };
  }
  const refs = plannedEntityReferences(plan);
  for (const ref of refs) {
    if (ref.type !== resolution.entity.type) {
      return {
        ok: false,
        code: 'AGENT_REFERENCE_TYPE_MISMATCH',
        expectedType: resolution.entity.type,
        actualType: ref.type,
      };
    }
    if (ref.id !== String(resolution.entity.id)) {
      return {
        ok: false,
        code: 'AGENT_REFERENCE_MISMATCH',
        expectedId: String(resolution.entity.id),
        actualId: ref.id,
      };
    }
  }
  return { ok: true };
}

export function referenceResolutionContext(resolution) {
  if (!resolution || resolution.status === 'none') return null;
  return {
    status: resolution.status,
    source: resolution.source || null,
    entity: resolution.entity
      ? { type: resolution.entity.type, id: String(resolution.entity.id) }
      : null,
  };
}

export function localizedReferenceClarification({ language, resolution, code = null }) {
  const lang = canonicalAgentLanguage(language);
  const titles = dedupeEntities(resolution?.candidates || [])
    .map((entity) => cleanText(entity.title, 80))
    .filter(Boolean)
    .slice(0, 3);

  if (code === 'AGENT_REFERENCE_TYPE_MISMATCH') {
    if (lang === 'ur') return 'یہ حوالہ اس درخواست کے لیے درست قسم کا نہیں ہے۔ براہ کرم متعلقہ family member، care plan یا care gap واضح کریں۔';
    if (lang === 'roman_ur') return 'Yeh reference is request ke liye sahi type ka nahi hai. Relevant family member, care plan ya care gap clear karein.';
    return 'That reference is not the right type for this request. Please specify the relevant family member, care plan, or care gap.';
  }

  if (resolution?.status === 'ambiguous') {
    const suffix = titles.length ? ` ${titles.join(' / ')}` : '';
    if (lang === 'ur') return `آپ کس والے کی بات کر رہے ہیں؟${suffix}`;
    if (lang === 'roman_ur') return `Aap kis wale ki baat kar rahe hain?${suffix}`;
    return `Which one do you mean?${suffix}`;
  }

  if (lang === 'ur') return 'براہ کرم واضح کریں کہ آپ کس family member، care plan یا care gap کی بات کر رہے ہیں۔';
  if (lang === 'roman_ur') return 'Please clear karein ke aap kis family member, care plan ya care gap ki baat kar rahe hain.';
  return 'Please specify which family member, care plan, or care gap you mean.';
}
