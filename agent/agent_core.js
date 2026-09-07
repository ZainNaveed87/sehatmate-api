/**
 * Agent Core (Phase B) - single-turn orchestration of the text agent.
 *
 * One authenticated user message flows through the full Phase B pipeline:
 *
 *   authenticated userId (from the auth token, never the request body)
 *     -> server-side turn-language resolution (message, then bounded memory,
 *        then patient_profiles.preferred_language as the UI/default fallback)
 *     -> owned agent session (created when omitted, verified when given)
 *     -> bounded verified screen context (ownership BEFORE data load)
 *     -> bounded planning, with at most one repair attempt
 *     -> validated capability executions (registry + safety gateway, max 3)
 *     -> audited READ results from authoritative backend services
 *     -> navigation authorization (ownership BEFORE emit)
 *     -> ONE grounded reply turn (agent_response_grounder.js)
 *     -> bounded session state update (referenced entities + summary only)
 *
 * Safety properties (spec sections 8-22):
 *   - READ + NAVIGATION only, ever. Mutation requests are declined with the
 *     localized deterministic agentPermissionDenied text - both when the
 *     planner returns a decline_* plan (the instructed refusal shape) and
 *     when the safety gateway rejects a non-executable permission class
 *     outright. Nothing ever executes in either case.
 *   - The provider is called at most three times per message (up to two
 *     planning turns, one reply turn) through the injectable provider seam.
 *     Every unrepaired provider or model-output failure maps to the
 *     localized deterministic
 *     agentUnavailable fallback: the agent never claims an action happened,
 *     never invents stats, medication facts, care gaps, or navigation
 *     (spec 22).
 *   - Every actual capability execution is audited via recordAgentAction
 *     with the server-resolved permission class, minimal canonical input,
 *     honest result status, backendConfirmed true only after the
 *     authoritative read succeeds, and stable error codes. Planner-stage
 *     rejections of resolvable capabilities are audited as 'rejected';
 *     navigation emission and rejected navigation intents are audited under
 *     the NAVIGATION class. Audit writes are best-effort: a failing audit
 *     insert never breaks the user turn, and no prompts, provider
 *     responses, transcripts, or full backend results ever reach the audit
 *     trail.
 *   - Session state stays bounded (spec 10): canonical { type, id }
 *     referenced entities capped at AGENT_STATE_LIMITS plus a short
 *     deterministic lastActionSummary built from server-known facts
 *     (intent label, executed tool names, navigation target). No
 *     conversation transcripts are stored.
 *   - The request body can never set reply language authority. The user's
 *     stored profile language remains the app/UI/default language only.
 *     Each Agent turn resolves a closed canonical reply language from the
 *     current message, falling back to the last verified turn language and
 *     then the profile default.
 *
 * Failure contract: handleAgentMessage never throws. Transport-level input
 * problems (empty message, unknown/foreign/expired session id, disabled
 * agent, unexpected internal failure) return { ok: false, code, message }
 * with stable codes for the HTTP layer to map. Every other failure -
 * including all provider and model-output failures - still produces a safe
 * localized reply with { ok: true, fallbackCode } so the conversation
 * fails safely instead of erroring out.
 */

import { createHash, randomUUID } from 'crypto';
import { agentConfig } from './agent_config.js';
import './agent_read_tools.js';
import './agent_draft_tools.js';
import {
  buildAgentContextSlice,
  readAgentConversationStateContext,
  readAgentScreenContext,
  verifyAgentEntityOwnership,
} from './agent_context_engine.js';
import {
  deriveServerCapabilityNames,
  deriveServerNormalizedIntent,
  deriveVerifiedCurrentFocus,
  deriveVerifiedOrderedEntityList,
} from './agent_conversation_state.js';
import {
  classifyBareConfirmationDecision,
  localizedReferenceClarification,
  localizedReferenceClarificationQuestion,
  referenceResolutionContext,
  resolvedReferenceNavigationPlan,
  resolveAgentConversationReference,
  reviewPlanAgainstResolvedReference,
  structuredReferenceClarificationCandidates,
} from './agent_reference_resolver.js';
import { authorizeAgentNavigationIntent } from './agent_navigation_registry.js';
import {
  AGENT_PLANNER_LIMITS,
  planAgentMessage,
  validateAgentPlan,
} from './agent_planner.js';
import { defaultAgentProvider } from './agent_provider.js';
import {
  executeConfirmedAgentCapability,
  executeAgentCapability,
  resolveAgentCapability,
} from './agent_capability_registry.js';
import {
  reviewAgentCapabilityCall,
  reviewAgentConfirmedCapabilityCall,
  reviewAgentNavigationPermission,
} from './agent_safety_gateway.js';
import {
  agentReplyLanguageLabel,
  generateGroundedAgentReply,
} from './agent_response_grounder.js';
import {
  canonicalAgentLanguage,
  claimAgentPendingClarification,
  claimAgentPendingConfirmation,
  createAgentSession,
  readAgentSession,
  touchAgentSession,
  updateAgentSessionLanguage,
  updateAgentSessionState,
} from './agent_session_store.js';
import { AGENT_STATE_LIMITS } from './agent_session_state.js';
import { recordAgentAction } from './agent_action_audit.js';
import { nextTaskFromTodayState } from '../services/performance_summary_service.js';
import { resolveAgentTurnLanguage } from './agent_turn_language.js';
import { localizedAiFallbackText } from '../language_support.js';
import {
  cleanText,
  idPattern,
  taskOutcomeDate,
} from '../services/shared_utils.js';

/**
 * Localized deterministic agent fallback text in the canonical agent
 * language. localizedAiFallbackText speaks the display-name language
 * system (English / Urdu / Roman Urdu); agentReplyLanguageLabel is the one
 * canonical-code-to-display-name boundary, so no second mapping exists
 * here.
 */
function localizedAgentText(key, canonicalLanguage) {
  return localizedAiFallbackText(key, agentReplyLanguageLabel(canonicalLanguage));
}

const NAVIGATION_TARGET_LABELS = Object.freeze({
  home: Object.freeze({ en: 'Home', ur: 'ہوم', roman_ur: 'Home' }),
  today: Object.freeze({ en: 'Today', ur: 'آج', roman_ur: 'Today' }),
  care_plans: Object.freeze({
    en: 'Care plans',
    ur: 'دیکھ بھال کے منصوبے',
    roman_ur: 'Care plans',
  }),
  care_plan_detail: Object.freeze({
    en: 'Care plan',
    ur: 'دیکھ بھال کا منصوبہ',
    roman_ur: 'Care plan',
  }),
  reality_check: Object.freeze({
    en: 'Reality Check',
    ur: 'ریئلٹی چیک',
    roman_ur: 'Reality Check',
  }),
  simulation: Object.freeze({
    en: 'Simulation',
    ur: 'سیمولیشن',
    roman_ur: 'Simulation',
  }),
  care_gaps: Object.freeze({
    en: 'Care gaps',
    ur: 'دیکھ بھال کے خلا',
    roman_ur: 'Care gaps',
  }),
  care_gap_detail: Object.freeze({
    en: 'Care gap',
    ur: 'دیکھ بھال کا خلا',
    roman_ur: 'Care gap',
  }),
  family_care: Object.freeze({
    en: 'Family Care',
    ur: 'فیملی کیئر',
    roman_ur: 'Family Care',
  }),
  family_member_detail: Object.freeze({
    en: 'Family member',
    ur: 'فیملی ممبر',
    roman_ur: 'Family member',
  }),
  family_member_care_plans: Object.freeze({
    en: 'family care plans',
    ur: 'فیملی care plans',
    roman_ur: 'family care plans',
  }),
  family_member_care_gaps: Object.freeze({
    en: 'family care gaps',
    ur: 'فیملی care gaps',
    roman_ur: 'family care gaps',
  }),
  family_member_simulation: Object.freeze({
    en: 'family simulation',
    ur: 'فیملی simulation',
    roman_ur: 'family simulation',
  }),
  routine_settings: Object.freeze({
    en: 'Routine settings',
    ur: 'روٹین سیٹنگز',
    roman_ur: 'Routine settings',
  }),
  profile: Object.freeze({ en: 'Profile', ur: 'پروفائل', roman_ur: 'Profile' }),
  documents: Object.freeze({
    en: 'Documents',
    ur: 'دستاویزات',
    roman_ur: 'Documents',
  }),
  notifications: Object.freeze({
    en: 'Notifications',
    ur: 'نوٹیفکیشنز',
    roman_ur: 'Notifications',
  }),
  settings: Object.freeze({ en: 'Settings', ur: 'سیٹنگز', roman_ur: 'Settings' }),
});

function navigationTargetLabel(target, canonicalLanguage) {
  const language = canonicalAgentLanguage(canonicalLanguage);
  return NAVIGATION_TARGET_LABELS[target]?.[language] ||
    NAVIGATION_TARGET_LABELS[target]?.en ||
    'that screen';
}

function navigationReadyText(target, canonicalLanguage) {
  const language = canonicalAgentLanguage(canonicalLanguage);
  const label = navigationTargetLabel(target, language);
  if (language === 'ur') {
    return `${label} کھولنے کے لیے نیچے کھولیں دبائیں۔`;
  }
  if (language === 'roman_ur') {
    return `${label} kholne ke liye neeche Kholein dabayein.`;
  }
  return `Use Open below to open ${label}.`;
}


const EXACT_AGENT_CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function safeNonNegativeCount(value) {
  if (value === null || value === undefined || value === '') return null;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;

  return parsed;
}

function deterministicNextTaskReply({
  capabilityResults,
  language,
}) {
  const canonicalLanguage = canonicalAgentLanguage(language);

  let nextTask = null;
  let pendingToday = null;

  const directNextTask = capabilityResults.find(
    (entry) =>
      entry?.name === 'get_next_task' &&
      entry?.result?.ok === true,
  );

  if (directNextTask) {
    const data = directNextTask.result?.data;

    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      !Object.prototype.hasOwnProperty.call(data, 'nextTask')
    ) {
      return null;
    }

    nextTask = data.nextTask;
    pendingToday = safeNonNegativeCount(data.pendingToday);
  } else {
    const todayTasks = capabilityResults.find(
      (entry) =>
        entry?.name === 'get_today_tasks' &&
        entry?.result?.ok === true,
    );

    if (!todayTasks) return null;

    const state = todayTasks.result?.data;

    if (
      !state ||
      typeof state !== 'object' ||
      !Array.isArray(state.occurrences) ||
      !state.summary
    ) {
      return null;
    }

    nextTask = nextTaskFromTodayState(state);
    pendingToday = safeNonNegativeCount(state.summary.pending);
  }

  if (!nextTask) {
    if (pendingToday !== 0) return null;

    if (canonicalLanguage === 'ur') {
      return 'آج آپ کا کوئی زیرِ التوا نگہداشت کا کام نہیں ہے۔';
    }

    if (canonicalLanguage === 'roman_ur') {
      return 'Aaj aap ka koi pending care task nahi hai.';
    }

    return 'You have no pending care task for today.';
  }

  if (
    !nextTask ||
    typeof nextTask !== 'object' ||
    Array.isArray(nextTask)
  ) {
    return null;
  }

  const title = cleanText(nextTask.title, 120);
  const scheduledTime = cleanText(nextTask.scheduledTime, 10);
  const status = cleanText(nextTask.status, 20);

  if (
    !title ||
    !EXACT_AGENT_CLOCK_PATTERN.test(scheduledTime) ||
    status !== 'pending'
  ) {
    return null;
  }

  if (canonicalLanguage === 'ur') {
    return `آپ کا اگلا زیرِ التوا کام ${title} ہے، وقت ${scheduledTime} ہے۔`;
  }

  if (canonicalLanguage === 'roman_ur') {
    return `Aap ka agla pending care task ${title} hai, time ${scheduledTime} hai.`;
  }

  return `Your next pending care task is ${title} at ${scheduledTime}.`;
}

function confirmationText(key, canonicalLanguage) {
  const language = canonicalAgentLanguage(canonicalLanguage);
  const text = {
    draftReady: {
      en: 'I prepared this change for your review. Nothing has been changed yet.',
      ur: 'میں نے یہ تبدیلی آپ کے جائزے کے لیے تیار کر دی ہے۔ ابھی کچھ تبدیل نہیں ہوا۔',
      roman_ur: 'Main ne yeh tabdeeli aap ke review ke liye tayyar kar di hai. Abhi kuch change nahi hua.',
    },
    alreadyAwaiting: {
      en: 'Please confirm or cancel the current pending action before creating another change.',
      ur: 'نئی تبدیلی بنانے سے پہلے موجودہ زیر التوا عمل کو confirm یا cancel کریں۔',
      roman_ur: 'Nayi tabdeeli banane se pehle current pending action ko confirm ya cancel karein.',
    },
    cancelled: {
      en: 'Cancelled. No change was made.',
      ur: 'منسوخ کر دیا گیا۔ کوئی تبدیلی نہیں ہوئی۔',
      roman_ur: 'Cancel kar diya gaya. Koi change nahi hua.',
    },
    expired: {
      en: 'That confirmation expired. No change was made. Please ask me to prepare it again.',
      ur: 'یہ confirmation expire ہو گئی۔ کوئی تبدیلی نہیں ہوئی۔ براہ کرم دوبارہ draft بنانے کو کہیں۔',
      roman_ur: 'Yeh confirmation expire ho gayi. Koi change nahi hua. Dobara draft banane ko kahe dein.',
    },
    noPending: {
      en: 'There is no pending action to confirm. No change was made.',
      ur: 'Confirm کرنے کے لیے کوئی زیر التوا عمل نہیں ہے۔ کوئی تبدیلی نہیں ہوئی۔',
      roman_ur: 'Confirm karne ke liye koi pending action nahi hai. Koi change nahi hua.',
    },
    mismatch: {
      en: 'That confirmation is no longer current. No change was made.',
      ur: 'یہ confirmation اب current نہیں ہے۔ کوئی تبدیلی نہیں ہوئی۔',
      roman_ur: 'Yeh confirmation ab current nahi hai. Koi change nahi hua.',
    },
    confirmed: {
      en: 'Confirmed. The change was saved.',
      ur: 'Confirm ہو گیا۔ تبدیلی محفوظ کر دی گئی۔',
      roman_ur: 'Confirm ho gaya. Tabdeeli save ho gayi.',
    },
    rejected: {
      en: 'That change was not saved because server safety checks rejected it.',
      ur: 'یہ تبدیلی محفوظ نہیں ہوئی کیونکہ server safety checks نے اسے reject کر دیا۔',
      roman_ur: 'Yeh tabdeeli save nahi hui kyun ke server safety checks ne ise reject kar diya.',
    },
  }[key];
  return text?.[language] || text?.en || '';
}

function hasActivePendingDraft(state, now = Date.now()) {
  const draft = state?.pendingDraft;
  const confirmation = state?.pendingConfirmation;
  if (!draft || !confirmation) return false;
  const expiresAt = Date.parse(draft.expiresAt || confirmation.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function responseConfirmationFromDraft(draft) {
  if (!draft || !DRAFT_KINDS.has(draft.kind)) return null;
  return {
    confirmationId: draft.confirmationId,
    kind: draft.kind,
    message: draft.message,
    expiresAt: draft.expiresAt,
  };
}

function createPendingDraft(draftData) {
  if (!draftData || typeof draftData !== 'object' || Array.isArray(draftData)) {
    return null;
  }
  const toolName = cleanText(draftData.toolName, 60);
  const kind = cleanText(draftData.kind, 40);
  const message = cleanText(draftData.message, 500);
  if (!toolName || !DRAFT_KINDS.has(kind) || !message) return null;
  const confirmationId = randomUUID();
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString();
  const base = {
    confirmationId,
    toolName,
    kind,
    message,
    expiresAt,
  };
  if (kind === 'task_outcome') {
    if (
      !idPattern.test(String(draftData.occurrenceId || '')) ||
      !['completed', 'skipped'].includes(draftData.outcome) ||
      !['pending', 'completed', 'skipped', 'missed'].includes(draftData.baseStatus)
    ) {
      return null;
    }
    return {
      ...base,
      occurrenceId: String(draftData.occurrenceId),
      outcome: draftData.outcome,
      note: cleanText(draftData.note, 200) || '',
      baseStatus: draftData.baseStatus,
      targetLabel: cleanText(draftData.targetLabel, 120) || 'Care task',
    };
  }
  if (
    kind === 'schedule_time' &&
    idPattern.test(String(draftData.itemId || '')) &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(draftData.scheduleTime || '')
  ) {
    return {
      ...base,
      itemId: String(draftData.itemId),
      displayTime: cleanText(draftData.displayTime, 80) || `Reminder at ${draftData.scheduleTime}`,
      scheduleTime: draftData.scheduleTime,
      learningSource: 'ai_suggestion_accept',
      targetLabel: cleanText(draftData.targetLabel, 120) || 'Reminder',
    };
  }
  return null;
}

function confirmationRequestFromInput(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_AGENT_CONFIRMATION_REQUEST' };
  }
  const keys = Object.keys(input);
  if (
    keys.length !== 2 ||
    !keys.includes('confirmationId') ||
    !keys.includes('decision')
  ) {
    return { ok: false, code: 'INVALID_AGENT_CONFIRMATION_REQUEST' };
  }
  const confirmationId = cleanText(input.confirmationId, 80);
  const decision = cleanText(input.decision, 20);
  if (!confirmationId || !CONFIRMATION_DECISIONS.has(decision)) {
    return { ok: false, code: 'INVALID_AGENT_CONFIRMATION_REQUEST' };
  }
  return { ok: true, confirmationId, decision };
}

function clarificationRequestFromInput(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_AGENT_CLARIFICATION_REQUEST' };
  }
  const keys = Object.keys(input);
  if (
    keys.length !== 2 ||
    !keys.includes('clarificationId') ||
    !keys.includes('choiceId')
  ) {
    return { ok: false, code: 'INVALID_AGENT_CLARIFICATION_REQUEST' };
  }
  const clarificationId = cleanText(input.clarificationId, 80);
  const choiceId = cleanText(input.choiceId, 80);
  if (
    !OPAQUE_CLIENT_ID_PATTERN.test(clarificationId) ||
    !OPAQUE_CLIENT_ID_PATTERN.test(choiceId)
  ) {
    return { ok: false, code: 'INVALID_AGENT_CLARIFICATION_REQUEST' };
  }
  return { ok: true, clarificationId, choiceId };
}

function createPendingReferenceClarification({
  resolution,
  message,
  language,
  now = Date.now(),
}) {
  const candidateSet = structuredReferenceClarificationCandidates(resolution);
  if (!candidateSet) return null;
  const clarificationId = randomUUID();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + CLARIFICATION_TTL_MS).toISOString();
  return {
    clarificationId,
    kind: 'entity_reference',
    question: localizedReferenceClarificationQuestion(language),
    entityType: candidateSet.entityType,
    messageHash: messageHashForClarification(message),
    createdAt,
    expiresAt,
    choices: candidateSet.candidates.map((candidate) => ({
      choiceId: randomUUID(),
      label: candidate.title,
      entity: {
        type: candidate.type,
        id: candidate.id,
      },
    })),
  };
}

function responseClarificationFromPending(pendingClarification) {
  if (!pendingClarification) return null;
  return {
    clarificationId: pendingClarification.clarificationId,
    kind: pendingClarification.kind,
    question: pendingClarification.question,
    options: pendingClarification.choices.map((choice) => ({
      choiceId: choice.choiceId,
      label: choice.label,
    })),
    expiresAt: pendingClarification.expiresAt,
  };
}

function actionArgsFromPendingDraft(draft) {
  if (draft?.kind === 'task_outcome') {
    const args = {
      occurrenceId: draft.occurrenceId,
      outcome: draft.outcome,
      baseStatus: draft.baseStatus,
      operationKey: `agent-confirmation:${draft.confirmationId}`,
    };
    if (draft.note) args.note = draft.note;
    return args;
  }
  if (draft?.kind === 'schedule_time') {
    return {
      itemId: draft.itemId,
      scheduleTime: draft.scheduleTime,
      learningSource: 'ai_suggestion_accept',
    };
  }
  return null;
}

function capabilityAuditStatus(result) {
  if (result?.ok) return 'succeeded';
  return result?.unexpectedFailure ? 'failed' : 'rejected';
}

/**
 * Intent labels the planner produces for refused change requests (for
 * example decline_change_request). The label only routes the reply to the
 * deterministic localized denial text; it can never unlock execution -
 * capabilityCalls and navigationIntent are the only executable paths and
 * both are closed-registry validated regardless of the label.
 */
const DECLINE_INTENT_PATTERN = /^decline/;

/** Length bound for entity titles surfaced in referencedEntities. */
const ENTITY_TITLE_MAX_LENGTH = 200;

/** Server-side app/UI/default language source. */
const PROFILE_LANGUAGE_SQL =
  'SELECT preferred_language FROM patient_profiles WHERE user_id = ? LIMIT 1';

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const CLARIFICATION_TTL_MS = 5 * 60 * 1000;
const CONFIRMATION_DECISIONS = new Set(['confirm', 'cancel']);
const DRAFT_KINDS = new Set(['task_outcome', 'schedule_time']);
const OPAQUE_CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

async function readProfileLanguage(pool, userId) {
  const [rows] = await pool.execute(PROFILE_LANGUAGE_SQL, [userId]);
  return canonicalAgentLanguage(rows[0]?.preferred_language);
}

export function canonicalAgentClientToday(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return taskOutcomeDate(value);
}

function messageHashForClarification(message) {
  return createHash('sha256')
    .update(String(message || ''), 'utf8')
    .digest('hex');
}

function lastVerifiedTurnLanguage(session, profileLanguage) {
  return canonicalAgentLanguage(
    session?.state?.lastTurnLanguage ||
      session?.language ||
      profileLanguage,
  );
}

/**
 * Canonicalize an entity reference for state bookkeeping. Accepts the
 * verified references from the context/navigation engines as well as plain
 * capability-argument shapes; anything malformed is dropped (null).
 */
function canonicalEntityRef(entity) {
  if (!entity || typeof entity !== 'object') return null;
  const type = cleanText(entity.type, AGENT_STATE_LIMITS.entityTypeMaxLength);
  const id = cleanText(String(entity.id ?? ''), AGENT_STATE_LIMITS.entityIdMaxLength);
  if (!type || !id || !idPattern.test(id)) return null;
  return { type, id };
}

/**
 * Derive the entity a capability call targets from its canonicalized
 * arguments. Phase B READ capabilities address entities exclusively
 * through closed, schema-validated entity id fields, so this mapping
 * stays closed.
 */
function entityFromCallArgs(args) {
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
 * Best-effort audit write: a failing audit insert must never break the
 * user turn. The audit service itself returns structured failures instead
 * of throwing; this guard covers transport-level errors only.
 */
async function auditBestEffort(record) {
  try {
    await recordAgentAction(record);
  } catch {
    // intentionally ignored - the reply is already safe without it
  }
}

/**
 * Audit a planner-stage rejection (nothing executed). Only rejections of
 * capabilities that resolve in the registry are recorded - an unknown tool
 * name has no canonical permission class and no execution path, so there
 * is nothing accountable to persist.
 */
async function auditPlannerRejection({ pool, userId, sessionId, planned }) {
  if (typeof planned.toolName !== 'string' || !planned.toolName) return;
  const capability = resolveAgentCapability(planned.toolName);
  const permissionClass =
    planned.permissionClass || (capability ? capability.permissionClass : null);
  if (!permissionClass) return;

  await auditBestEffort({
    db: pool,
    userId,
    sessionId,
    toolName: planned.toolName,
    permissionClass,
    input: null,
    resultStatus: 'rejected',
    backendConfirmed: false,
    errorCode: planned.code,
  });
}

/**
 * Build the next bounded session state. The referenced-entity list keeps
 * the LAST occurrence of each { type, id } (most recent wins) and stays
 * capped at AGENT_STATE_LIMITS.maxReferencedEntities; the
 * lastActionSummary is assembled from server-known facts only.
 */
function buildNextSessionState({
  sessionState,
  intent,
  capabilityCalls,
  successfulCapabilityCalls = [],
  capabilityResults = [],
  navigation,
  navigationEntity,
  screenEntity,
  pendingConfirmation,
  pendingDraft,
  pendingClarification = null,
  language,
}) {
  const previous = Array.isArray(sessionState?.lastReferencedEntities)
    ? sessionState.lastReferencedEntities
        .map((entity) => canonicalEntityRef(entity))
        .filter(Boolean)
    : [];

  const appended = [];
  for (const call of capabilityCalls) {
    const entity = entityFromCallArgs(call?.args);
    if (entity) appended.push(entity);
  }
  for (const entity of [navigationEntity, screenEntity]) {
    const reference = canonicalEntityRef(entity);
    if (reference) appended.push(reference);
  }

  const byKey = new Map();
  for (const entity of [...previous, ...appended]) {
    byKey.set(`${entity.type}:${entity.id}`, entity);
  }
  const lastReferencedEntities = [...byKey.values()].slice(
    -AGENT_STATE_LIMITS.maxReferencedEntities,
  );

  const summary = cleanText(
    [
      `intent:${intent}`,
      `tools:${capabilityCalls.map((call) => call?.name).filter(Boolean).join('+') || 'none'}`,
      `nav:${navigation ? navigation.target : 'none'}`,
    ].join('|'),
    AGENT_STATE_LIMITS.summaryMaxLength,
  );

  const verifiedFocus = deriveVerifiedCurrentFocus({
    successfulCapabilityCalls,
    navigationEntity,
  });
  const verifiedOrderedList = deriveVerifiedOrderedEntityList(capabilityResults);
  // Only an authoritative list result replaces or clears ordinal context.
  // Detail reads and navigation keep the previous sanitized pointer list.
  const hasVerifiedOperation = successfulCapabilityCalls.length > 0 || Boolean(navigation);
  const normalizedIntent = deriveServerNormalizedIntent({
    successfulCapabilityCalls,
    navigation,
  });
  const capabilityNames = deriveServerCapabilityNames(successfulCapabilityCalls);

  return {
    lastReferencedEntities,
    currentFocus:
      verifiedFocus === undefined
        ? sessionState?.currentFocus ?? null
        : verifiedFocus,
    recentOrderedEntityList:
      verifiedOrderedList !== undefined
        ? verifiedOrderedList
        : sessionState?.recentOrderedEntityList ?? null,
    lastIntent:
      hasVerifiedOperation
        ? normalizedIntent
        : sessionState?.lastIntent ?? null,
    lastCapabilityNames:
      hasVerifiedOperation
        ? capabilityNames
        : sessionState?.lastCapabilityNames ?? [],
    pendingConfirmation:
      pendingConfirmation === undefined
        ? sessionState?.pendingConfirmation ?? null
        : pendingConfirmation,
    pendingDraft:
      pendingDraft === undefined ? sessionState?.pendingDraft ?? null : pendingDraft,
    pendingClarification:
      pendingClarification === undefined
        ? sessionState?.pendingClarification ?? null
        : pendingClarification,
    lastTurnLanguage: canonicalAgentLanguage(language),
    lastActionSummary: summary || null,
  };
}

/**
 * The turn-scoped referencedEntities for the response: the verified
 * current-screen entity, the verified navigation entity, then entities
 * addressed by capability arguments (type/id only). Bounded by
 * construction (at most 2 + 3 entries).
 */
function buildReferencedEntities({
  screenEntity,
  navigationEntity,
  capabilityCalls,
}) {
  const byKey = new Map();
  const add = (entity, includeTitle) => {
    const reference = canonicalEntityRef(entity);
    if (!reference) return;
    const key = `${reference.type}:${reference.id}`;
    if (byKey.has(key)) return;
    const title = includeTitle && entity.title
      ? cleanText(entity.title, ENTITY_TITLE_MAX_LENGTH)
      : null;
    byKey.set(key, title ? { ...reference, title } : reference);
  };

  add(screenEntity, true);
  add(navigationEntity, true);
  for (const call of capabilityCalls) {
    add(entityFromCallArgs(call?.args), false);
  }
  return [...byKey.values()];
}

/**
 * Persist the bounded next state (best effort) and assemble the final
 * turn result. A session that expired mid-turn or a store failure never
 * invalidates the already-safe reply.
 */
async function finishAgentTurn({
  pool,
  userId,
  session,
  reply,
  fallbackCode,
  intent,
  capabilityCalls,
  successfulCapabilityCalls = [],
  capabilityResults = [],
  navigation,
  navigationEntity,
  screenEntity,
  pendingConfirmation,
  pendingDraft,
  pendingClarification,
  confirmation = null,
  clarification = null,
  actionStatus = null,
  language = session.language,
}) {
  const nextState = buildNextSessionState({
    sessionState: session.state,
    intent,
    capabilityCalls,
    successfulCapabilityCalls,
    capabilityResults,
    navigation,
    navigationEntity,
    screenEntity,
    pendingConfirmation,
    pendingDraft,
    pendingClarification,
    language,
  });

  let stateUpdate = null;
  try {
    stateUpdate = await updateAgentSessionState({
      db: pool,
      userId,
      sessionId: session.id,
      state: nextState,
      expectedState: session.state,
    });
  } catch {
    // intentionally ignored - see docblock
  }

  if (actionStatus === 'awaiting_confirmation' && confirmation && stateUpdate?.ok !== true) {
    const currentSession = stateUpdate?.data?.session || session;
    const currentConfirmation = hasActivePendingDraft(currentSession.state)
      ? responseConfirmationFromDraft(currentSession.state?.pendingDraft)
      : null;
    return {
      ok: true,
      sessionId: session.id,
      language,
      reply: currentConfirmation
        ? confirmationText('alreadyAwaiting', language)
        : localizedAgentText('agentUnavailable', language),
      navigation: null,
      confirmation: currentConfirmation,
      actionStatus: currentConfirmation ? 'awaiting_confirmation' : 'rejected',
      referencedEntities: buildReferencedEntities({
        screenEntity,
        navigationEntity,
        capabilityCalls,
      }),
      fallbackCode: currentConfirmation
        ? 'AGENT_CONFIRMATION_ALREADY_PENDING'
        : stateUpdate?.code || 'AGENT_SESSION_STATE_CONFLICT',
    };
  }

  return {
    ok: true,
    sessionId: session.id,
    language,
    reply,
    navigation,
    confirmation,
    clarification: clarification && stateUpdate?.ok === true ? clarification : null,
    actionStatus,
    referencedEntities: buildReferencedEntities({
      screenEntity,
      navigationEntity,
      capabilityCalls,
    }),
    ...(fallbackCode ? { fallbackCode } : {}),
  };
}

function finishAgentConfirmationTurn({
  session,
  reply,
  fallbackCode,
  confirmation = null,
  actionStatus = null,
  language = session.language,
}) {
  return {
    ok: true,
    sessionId: session.id,
    language,
    reply,
    navigation: null,
    confirmation,
    actionStatus,
    referencedEntities: [],
    ...(fallbackCode ? { fallbackCode } : {}),
  };
}

async function handleAgentConfirmation({
  pool,
  userId,
  session,
  confirmationRequest,
  screenEntity = null,
  language = session.language,
}) {
  const deniedTurn = async ({
    finishSession = session,
    key,
    fallbackCode,
    errorCode,
    actionStatus = 'rejected',
    pendingDraft = null,
    clear = false,
  }) => {
    const toolName = pendingDraft?.toolName || 'agent_confirmation';
    const permissionClass =
      resolveAgentCapability(toolName)?.permissionClass || 'REVERSIBLE_USER_ACTION';
    await auditBestEffort({
      db: pool,
      userId,
      sessionId: session.id,
      toolName,
      permissionClass,
      input: pendingDraft
        ? {
            confirmationId: pendingDraft.confirmationId,
            kind: pendingDraft.kind,
            decision: confirmationRequest.decision,
          }
        : null,
      resultStatus: 'rejected',
      backendConfirmed: false,
      errorCode,
    });
    return finishAgentConfirmationTurn({
      session: finishSession,
      language,
      reply: confirmationText(key, language),
      fallbackCode,
      confirmation: clear ? null : responseConfirmationFromDraft(pendingDraft),
      actionStatus,
    });
  };

  if (!confirmationRequest?.ok) {
    return deniedTurn({
      key: 'noPending',
      fallbackCode: confirmationRequest?.code || 'INVALID_AGENT_CONFIRMATION_REQUEST',
      errorCode: confirmationRequest?.code || 'INVALID_AGENT_CONFIRMATION_REQUEST',
    });
  }

  const claimed = await claimAgentPendingConfirmation({
    db: pool,
    userId,
    sessionId: session.id,
    confirmationId: confirmationRequest.confirmationId,
  });
  if (!claimed.ok) {
    const finishSession = claimed.data?.session || session;
    const code = claimed.code || 'AGENT_CONFIRMATION_NOT_FOUND';
    const key =
      code === 'AGENT_CONFIRMATION_EXPIRED'
        ? 'expired'
        : code === 'AGENT_CONFIRMATION_MISMATCH'
          ? 'mismatch'
          : 'noPending';
    return deniedTurn({
      finishSession,
      key,
      fallbackCode: code,
      errorCode: code,
      pendingDraft: null,
      clear: code !== 'AGENT_CONFIRMATION_MISMATCH',
    });
  }

  const pendingDraft = claimed.data.pendingDraft;
  const claimedSession = claimed.data.session;

  if (confirmationRequest.decision === 'cancel') {
    return deniedTurn({
      finishSession: claimedSession,
      key: 'cancelled',
      fallbackCode: null,
      actionStatus: 'cancelled',
      pendingDraft,
      clear: true,
      errorCode: 'AGENT_CONFIRMATION_CANCELLED',
    });
  }

  const reviewed = reviewAgentConfirmedCapabilityCall({
    name: pendingDraft.toolName,
    pendingDraft,
  });
  if (!reviewed.ok) {
    return deniedTurn({
      finishSession: claimedSession,
      key: 'rejected',
      fallbackCode: reviewed.code || 'AGENT_CONFIRMED_ACTION_REJECTED',
      pendingDraft,
      clear: true,
      errorCode: reviewed.code || 'AGENT_CONFIRMED_ACTION_REJECTED',
    });
  }

  const args = actionArgsFromPendingDraft(pendingDraft);
  if (!args) {
    return deniedTurn({
      finishSession: claimedSession,
      key: 'rejected',
      fallbackCode: 'INVALID_AGENT_DRAFT',
      pendingDraft,
      clear: true,
      errorCode: 'INVALID_AGENT_DRAFT',
    });
  }

  let result;
  try {
    result = await executeConfirmedAgentCapability({
      name: pendingDraft.toolName,
      pool,
      userId,
      args,
    });
  } catch {
    result = {
      ok: false,
      code: 'AGENT_CAPABILITY_FAILED',
      message: 'The confirmed capability failed.',
      unexpectedFailure: true,
    };
  }

  await auditBestEffort({
    db: pool,
    userId,
    sessionId: session.id,
    toolName: pendingDraft.toolName,
    permissionClass: 'REVERSIBLE_USER_ACTION',
    input: {
      confirmationId: pendingDraft.confirmationId,
      kind: pendingDraft.kind,
      targetId: pendingDraft.occurrenceId || pendingDraft.itemId || null,
    },
    resultStatus: capabilityAuditStatus(result),
    backendConfirmed: result.ok === true,
    targetType: pendingDraft.kind === 'task_outcome' ? 'task_occurrence' : 'schedule_item',
    targetId: pendingDraft.occurrenceId || pendingDraft.itemId || null,
    errorCode: result.ok ? null : result.code || 'AGENT_CAPABILITY_FAILED',
  });

  return finishAgentConfirmationTurn({
    session: claimedSession,
    language,
    reply: result.ok
      ? confirmationText('confirmed', language)
      : confirmationText('rejected', language),
    fallbackCode: result.ok ? null : result.code || 'AGENT_CAPABILITY_FAILED',
    confirmation: null,
    actionStatus: result.ok ? 'confirmed' : 'rejected',
  });
}

/**
 * Handle one authenticated agent message end to end.
 *
 * Returns:
 *   { ok: true, sessionId, language, reply, navigation, clarification,
 *     referencedEntities, fallbackCode? }
 *   { ok: false, code: 'AGENT_DISABLED' | 'AGENT_MESSAGE_EMPTY' |
 *     'INVALID_AGENT_SESSION_ID' | 'AGENT_SESSION_NOT_FOUND' |
 *     session-store failure codes | 'AGENT_INTERNAL_ERROR', message }
 *
 * Never throws. `provider` is injectable so tests mock both planning and
 * reply turns without any real provider credentials.
 */
export async function handleAgentMessage({
  pool,
  userId,
  sessionId = null,
  message,
  clientContext = null,
  confirmation = null,
  clarification = null,
  clientToday = null,
  provider = defaultAgentProvider,
}) {
  let language = 'en';
  try {
    const canonicalClientToday = canonicalAgentClientToday(clientToday);
    if (clientToday != null && !canonicalClientToday) {
      return {
        ok: false,
        code: 'INVALID_AGENT_TODAY',
        message: 'Invalid local date.',
      };
    }
    const confirmationRequest = confirmationRequestFromInput(confirmation);
    const isConfirmationTurn = confirmation != null;
    const clarificationRequest = clarificationRequestFromInput(clarification);
    const isClarificationTurn = clarification != null;
    if (isConfirmationTurn && isClarificationTurn) {
      return {
        ok: false,
        code: 'INVALID_AGENT_CLARIFICATION_REQUEST',
        message: 'Agent clarification cannot be combined with confirmation.',
      };
    }

    const boundedMessage = isConfirmationTurn
      ? ''
      : cleanText(message, AGENT_PLANNER_LIMITS.messageMaxChars);

    if (isClarificationTurn && !boundedMessage) {
      return {
        ok: false,
        code: 'INVALID_AGENT_CLARIFICATION_REQUEST',
        message: 'Agent clarification request is invalid.',
      };
    }

    if (!isConfirmationTurn && !boundedMessage) {
      return {
        ok: false,
        code: 'AGENT_MESSAGE_EMPTY',
        message: 'The agent message is empty.',
      };
    }

    const profileLanguage = await readProfileLanguage(pool, userId);
    language = resolveAgentTurnLanguage({
      message: boundedMessage,
      profileLanguage,
    }).language;

    if (!agentConfig().enabled) {
      return {
        ok: false,
        code: 'AGENT_DISABLED',
        message: localizedAgentText('agentDisabled', language),
      };
    }

    // --- owned session: create when omitted, verify when given ---
    let session;
    let sessionCreated = false;
    if ((isConfirmationTurn || isClarificationTurn) && sessionId == null) {
      return {
        ok: false,
        code: 'INVALID_AGENT_SESSION_ID',
        message: 'Invalid agent session ID.',
      };
    }
    if (sessionId == null) {
      const created = await createAgentSession({ db: pool, userId, language });
      if (!created.ok) return created;
      session = created.data.session;
      sessionCreated = true;
    } else {
      const read = await readAgentSession({ db: pool, userId, sessionId });
      if (!read.ok) return read;
      session = read.data.session;
      language = resolveAgentTurnLanguage({
        message: boundedMessage,
        lastTurnLanguage: lastVerifiedTurnLanguage(session, profileLanguage),
        profileLanguage,
      }).language;
    }

    if (!sessionCreated) {
      // Session language is now the last verified Agent turn language, not
      // the patient profile/UI language.
      if (session.language !== language) {
        const updated = await updateAgentSessionLanguage({
          db: pool,
          userId,
          sessionId: session.id,
          language,
        });
        if (!updated.ok) return updated;
        session = updated.data.session;
      }
      const touched = await touchAgentSession({
        db: pool,
        userId,
        sessionId: session.id,
      });
      if (!touched.ok) return touched;
      session = touched.data.session;
    }

    if (isConfirmationTurn) {
      return handleAgentConfirmation({
        pool,
        userId,
        session,
        confirmationRequest,
        language,
      });
    }

    let selectedReferenceResolution = null;
    if (isClarificationTurn) {
      if (!clarificationRequest?.ok) {
        return {
          ok: false,
          code: clarificationRequest?.code || 'INVALID_AGENT_CLARIFICATION_REQUEST',
          message: 'Agent clarification request is invalid.',
        };
      }
      const claimed = await claimAgentPendingClarification({
        db: pool,
        userId,
        sessionId: session.id,
        clarificationId: clarificationRequest.clarificationId,
        choiceId: clarificationRequest.choiceId,
        messageHash: messageHashForClarification(boundedMessage),
      });
      if (!claimed.ok) {
        return {
          ok: false,
          code: claimed.code || 'AGENT_CLARIFICATION_REJECTED',
          message: claimed.message || 'Agent clarification was rejected.',
        };
      }

      session = claimed.data.session;
      const pendingClarification = claimed.data.pendingClarification;
      const choice = claimed.data.choice;
      if (
        pendingClarification.kind !== 'entity_reference' ||
        choice.entity?.type !== pendingClarification.entityType
      ) {
        return {
          ok: false,
          code: 'AGENT_CLARIFICATION_TYPE_MISMATCH',
          message: 'Agent clarification choice is not valid for this request.',
        };
      }

      const owned = await verifyAgentEntityOwnership({
        pool,
        userId,
        entity: choice.entity,
      });
      if (!owned.ok || owned.entity.type !== pendingClarification.entityType) {
        return {
          ok: false,
          code: 'AGENT_CLARIFICATION_ENTITY_NOT_FOUND',
          message: 'Agent clarification choice is no longer available.',
        };
      }

      selectedReferenceResolution = {
        status: 'resolved',
        source: 'clarification_choice',
        entity: owned.entity,
        candidates: [owned.entity],
      };
    }

    // Phase E conversational confirmation/cancellation is deterministic and
    // bypasses planner/provider completely. It can only consume the exact
    // server-stored Phase D pending confirmation in this owned session.
    const conversationalDecision = isClarificationTurn
      ? null
      : classifyBareConfirmationDecision(boundedMessage);
    if (conversationalDecision) {
      const pendingConfirmation = session.state?.pendingConfirmation;
      const confirmationId = pendingConfirmation?.confirmationId;
      if (!confirmationId) {
        return finishAgentTurn({
          pool,
          userId,
          session,
          language,
          reply: confirmationText('noPending', language),
          fallbackCode: 'AGENT_CONFIRMATION_NOT_FOUND',
          intent: 'confirmation_not_found',
          capabilityCalls: [],
          navigation: null,
          navigationEntity: null,
          screenEntity: null,
          confirmation: null,
          actionStatus: 'rejected',
          pendingClarification: null,
        });
      }
      return handleAgentConfirmation({
        pool,
        userId,
        session,
        confirmationRequest: {
          ok: true,
          confirmationId,
          decision: conversationalDecision,
        },
        language,
      });
    }

    // --- bounded verified context (fail-safe drops, ownership first) ---
    const context = await readAgentScreenContext({
      pool,
      userId,
      clientContext,
    });
    const screenEntity = context.screenContext?.entity || null;

    const conversationContext = await readAgentConversationStateContext({
      pool,
      userId,
      sessionState: session.state,
    });

    const referenceResolution = selectedReferenceResolution ||
      await resolveAgentConversationReference({
        pool,
        userId,
        message: boundedMessage,
        screenEntity,
        currentFocus: conversationContext.currentFocus,
        recentEntities: conversationContext.recentEntities,
        recentOrderedEntityList: conversationContext.recentOrderedEntityList,
        familyMembers: conversationContext.familyMembers,
      });

    if (
      referenceResolution.status === 'ambiguous' ||
      referenceResolution.status === 'missing'
    ) {
      const pendingClarification = createPendingReferenceClarification({
        resolution: referenceResolution,
        message: boundedMessage,
        language,
      });
      const structuredClarification =
        responseClarificationFromPending(pendingClarification);
      return finishAgentTurn({
        pool,
        userId,
        session,
        reply: structuredClarification?.question ||
          localizedReferenceClarification({
            language,
            resolution: referenceResolution,
          }),
        fallbackCode:
          referenceResolution.status === 'ambiguous'
            ? 'AGENT_REFERENCE_AMBIGUOUS'
            : 'AGENT_REFERENCE_NOT_FOUND',
        intent: 'clarify_entity_reference',
        capabilityCalls: [],
        navigation: null,
        navigationEntity: null,
        screenEntity,
        pendingClarification,
        clarification: structuredClarification,
        language,
      });
    }

    const contextSlice = buildAgentContextSlice({
      language,
      screenContext: context.screenContext,
      sessionState: session.state,
      conversationContext,
      referenceResolution: referenceResolutionContext(referenceResolution),
    });

    // --- deterministic resolved-reference navigation or bounded planning ---
    const fastNavigationPlan = resolvedReferenceNavigationPlan({
      message: boundedMessage,
      resolution: referenceResolution,
    });
    const planned = fastNavigationPlan
      ? validateAgentPlan(fastNavigationPlan)
      : await planAgentMessage({
          provider,
          message: boundedMessage,
          contextSlice,
        });
    if (!planned.ok) {
      if (planned.code === 'AGENT_MESSAGE_EMPTY') {
        return {
          ok: false,
          code: 'AGENT_MESSAGE_EMPTY',
          message: 'The agent message is empty.',
        };
      }
      await auditPlannerRejection({
        pool,
        userId,
        sessionId: session.id,
        planned,
      });
      const denied = planned.code === 'AGENT_PERMISSION_CLASS_NOT_EXECUTABLE';
      return finishAgentTurn({
        pool,
        userId,
        session,
        reply: localizedAgentText(
          denied ? 'agentPermissionDenied' : 'agentUnavailable',
          language,
        ),
        fallbackCode: planned.code,
        intent: denied ? 'declined_by_safety_gateway' : 'unavailable',
        capabilityCalls: [],
        navigation: null,
        navigationEntity: null,
        screenEntity,
        language,
      });
    }

    const plan = planned.plan;
    const referenceBinding = reviewPlanAgainstResolvedReference({
      plan,
      resolution: referenceResolution,
    });
    if (!referenceBinding.ok) {
      return finishAgentTurn({
        pool,
        userId,
        session,
        reply: localizedReferenceClarification({
          language,
          resolution: referenceResolution,
          code: referenceBinding.code,
        }),
        fallbackCode: referenceBinding.code,
        intent: 'clarify_entity_reference',
        capabilityCalls: [],
        navigation: null,
        navigationEntity: null,
        screenEntity,
        language,
      });
    }
    const declined =
      plan.capabilityCalls.length === 0 && DECLINE_INTENT_PATTERN.test(plan.intent);
    const plannedDraftCall = plan.capabilityCalls.find(
      (call) => resolveAgentCapability(call.name)?.permissionClass === 'DRAFT',
    );
    if (plannedDraftCall && hasActivePendingDraft(session.state)) {
      const pending = responseConfirmationFromDraft(session.state.pendingDraft);
      return finishAgentTurn({
        pool,
        userId,
        session,
        reply: confirmationText('alreadyAwaiting', language),
        fallbackCode: 'AGENT_CONFIRMATION_ALREADY_PENDING',
        intent: 'confirmation_already_pending',
        capabilityCalls: [],
        navigation: null,
        navigationEntity: null,
        screenEntity,
        confirmation: pending,
        actionStatus: 'awaiting_confirmation',
        language,
      });
    }

    // --- execute validated READ/DRAFT calls (bounded by the gateway) ---
    const capabilityResults = [];
    const successfulCapabilityCalls = [];
    let capabilityFailureCode = null;
    let pendingDraft = null;
    for (const call of plan.capabilityCalls) {
      const capability = resolveAgentCapability(call.name);
      const approved = reviewAgentCapabilityCall({ name: call.name });
      if (!approved.ok) {
        capabilityFailureCode =
          approved.code || 'AGENT_PERMISSION_CLASS_NOT_EXECUTABLE';
        await auditBestEffort({
          db: pool,
          userId,
          sessionId: session.id,
          toolName: call.name,
          permissionClass: approved.permissionClass || capability?.permissionClass || 'READ',
          input: call.args,
          resultStatus: 'rejected',
          backendConfirmed: false,
          errorCode: capabilityFailureCode,
        });
        continue;
      }
      let result;
      try {
        result = await executeAgentCapability({
          name: call.name,
          pool,
          userId,
          args: call.args,
          clientToday: canonicalClientToday,
        });
      } catch {
        result = {
          ok: false,
          code: 'AGENT_CAPABILITY_FAILED',
          message: 'The capability call failed.',
          unexpectedFailure: true,
        };
      }
      const target = entityFromCallArgs(call.args);
      await auditBestEffort({
        db: pool,
        userId,
        sessionId: session.id,
        toolName: call.name,
        permissionClass: capability ? capability.permissionClass : 'READ',
        input: call.args,
        resultStatus: capabilityAuditStatus(result),
        backendConfirmed:
          result.ok === true && capability?.permissionClass !== 'DRAFT',
        ...(target ? { targetType: target.type, targetId: target.id } : {}),
        errorCode: result.ok ? null : result.code || 'AGENT_CAPABILITY_FAILED',
      });
      if (result.ok) {
        successfulCapabilityCalls.push({ name: call.name, args: call.args });
        if (capability?.permissionClass === 'DRAFT') {
          if (pendingDraft) {
            capabilityFailureCode = 'AGENT_MULTIPLE_DRAFTS_NOT_ALLOWED';
          } else {
            pendingDraft = createPendingDraft(result.data?.draft);
            if (!pendingDraft) {
              capabilityFailureCode = 'INVALID_AGENT_DRAFT';
            }
          }
        } else {
          capabilityResults.push({ name: call.name, args: call.args, result });
        }
      } else {
        capabilityFailureCode = result.code || 'AGENT_CAPABILITY_FAILED';
      }
    }

    if (capabilityFailureCode) {
      return finishAgentTurn({
        pool,
        userId,
        session,
        reply: localizedAgentText('agentUnavailable', language),
        fallbackCode: capabilityFailureCode,
        intent: 'capability_unavailable',
        capabilityCalls: [],
        navigation: null,
        navigationEntity: null,
        screenEntity,
        language,
      });
    }

    if (pendingDraft) {
      return finishAgentTurn({
        pool,
        userId,
        session,
        reply: confirmationText('draftReady', language),
        fallbackCode: null,
        intent: 'draft_awaiting_confirmation',
        capabilityCalls: plan.capabilityCalls,
        successfulCapabilityCalls,
        capabilityResults,
        navigation: null,
        navigationEntity: null,
        screenEntity,
        pendingConfirmation: responseConfirmationFromDraft(pendingDraft),
        pendingDraft,
        confirmation: responseConfirmationFromDraft(pendingDraft),
        actionStatus: 'awaiting_confirmation',
        language,
      });
    }

    // --- navigation authorization (ownership BEFORE emit) ---
    let navigation = null;
    let navigationEntity = null;
    if (plan.navigationIntent) {
      const navigationAllowed = reviewAgentNavigationPermission();
      const authorized = navigationAllowed.ok
        ? await authorizeAgentNavigationIntent({
            intent: plan.navigationIntent,
            pool,
            userId,
          })
        : navigationAllowed;
      if (authorized.ok) {
        navigation = authorized.navigation;
        navigationEntity = authorized.entity;
        await auditBestEffort({
          db: pool,
          userId,
          sessionId: session.id,
          toolName: `navigate_${navigation.target}`,
          permissionClass: 'NAVIGATION',
          input: navigation.params,
          resultStatus: 'succeeded',
          backendConfirmed: true,
          ...(navigationEntity
            ? {
                targetType: navigationEntity.type,
                targetId: navigationEntity.id,
              }
            : {}),
        });
      } else {
        await auditBestEffort({
          db: pool,
          userId,
          sessionId: session.id,
          toolName: `navigate_${plan.navigationIntent.target}`,
          permissionClass: 'NAVIGATION',
          input: null,
          resultStatus: 'rejected',
          backendConfirmed: false,
          errorCode: authorized.code || 'AGENT_NAVIGATION_REJECTED',
        });
      }
    }

    // --- grounded reply (or the deterministic denial) ---
    let reply;
    let fallbackCode = null;
    if (declined) {
      reply = localizedAgentText('agentPermissionDenied', language);
      fallbackCode = 'AGENT_PERMISSION_DENIED';
    } else if (
      navigation &&
      capabilityResults.length === 0 &&
      plan.capabilityCalls.length === 0
    ) {
      reply = navigationReadyText(navigation.target, language);
    } else {
      const replyResult = await generateGroundedAgentReply({
        provider,
        language,
        message: boundedMessage,
        contextSlice,
        capabilityResults,
      });
      if (replyResult.ok) {
  reply = replyResult.reply;
} else {
  const deterministicReply = deterministicNextTaskReply({
    capabilityResults,
    language,
  });

  if (deterministicReply) {
    reply = deterministicReply;

    // Preserve the real reply-stage failure code for diagnostics while
    // still returning the already-verified authoritative task facts.
    fallbackCode = replyResult.code || 'AGENT_REPLY_FAILED';
  } else {
    reply = localizedAgentText('agentUnavailable', language);
    fallbackCode = replyResult.code || 'AGENT_REPLY_FAILED';
  }
}
    }

    return finishAgentTurn({
      pool,
      userId,
      session,
      reply,
      fallbackCode,
      intent: plan.intent,
      capabilityCalls: plan.capabilityCalls,
      successfulCapabilityCalls,
      capabilityResults,
      navigation,
      navigationEntity,
      screenEntity,
      language,
    });
  } catch {
    return {
      ok: false,
      code: 'AGENT_INTERNAL_ERROR',
      message: localizedAgentText('agentUnavailable', language),
    };
  }
}
