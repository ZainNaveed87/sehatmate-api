/**
 * Agent Core (Phase B) - single-turn orchestration of the text agent.
 *
 * One authenticated user message flows through the full Phase B pipeline:
 *
 *   authenticated userId (from the auth token, never the request body)
 *     -> server-side language authority (patient_profiles.preferred_language)
 *     -> owned agent session (created when omitted, verified when given)
 *     -> bounded verified screen context (ownership BEFORE data load)
 *     -> ONE bounded planning turn (agent_planner.js)
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
 *   - The provider is called at most twice per message (one planning turn,
 *     one reply turn) through the injectable provider seam. Every provider
 *     or model-output failure maps to the localized deterministic
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
 *   - The language authority is the user's stored profile language; the
 *     request body can never set it (spec 11). When the profile language
 *     changes between two messages of an existing session, the session
 *     follows through the smallest safe user-scoped update
 *     (updateAgentSessionLanguage) - there is no second language system.
 *
 * Failure contract: handleAgentMessage never throws. Transport-level input
 * problems (empty message, unknown/foreign/expired session id, disabled
 * agent, unexpected internal failure) return { ok: false, code, message }
 * with stable codes for the HTTP layer to map. Every other failure -
 * including all provider and model-output failures - still produces a safe
 * localized reply with { ok: true, fallbackCode } so the conversation
 * fails safely instead of erroring out.
 */

import { agentConfig } from './agent_config.js';
import './agent_read_tools.js';
import {
  buildAgentContextSlice,
  readAgentScreenContext,
} from './agent_context_engine.js';
import { authorizeAgentNavigationIntent } from './agent_navigation_registry.js';
import {
  AGENT_PLANNER_LIMITS,
  planAgentMessage,
} from './agent_planner.js';
import { defaultAgentProvider } from './agent_provider.js';
import {
  executeAgentCapability,
  resolveAgentCapability,
} from './agent_capability_registry.js';
import {
  reviewAgentCapabilityCall,
  reviewAgentNavigationPermission,
} from './agent_safety_gateway.js';
import {
  agentReplyLanguageLabel,
  generateGroundedAgentReply,
} from './agent_response_grounder.js';
import {
  canonicalAgentLanguage,
  createAgentSession,
  readAgentSession,
  touchAgentSession,
  updateAgentSessionLanguage,
  updateAgentSessionState,
} from './agent_session_store.js';
import { AGENT_STATE_LIMITS } from './agent_session_state.js';
import { recordAgentAction } from './agent_action_audit.js';
import { localizedAiFallbackText } from '../language_support.js';
import { cleanText, idPattern } from '../services/shared_utils.js';

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

/** Server-side language authority: the stored patient profile language. */
const PROFILE_LANGUAGE_SQL =
  'SELECT preferred_language FROM patient_profiles WHERE user_id = ? LIMIT 1';

async function readProfileLanguage(pool, userId) {
  const [rows] = await pool.execute(PROFILE_LANGUAGE_SQL, [userId]);
  return canonicalAgentLanguage(rows[0]?.preferred_language);
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
 * through planId / gapId, so this mapping stays closed.
 */
function entityFromCallArgs(args) {
  if (!args || typeof args !== 'object') return null;
  if (args.planId !== undefined) {
    return canonicalEntityRef({ type: 'care_plan', id: args.planId });
  }
  if (args.gapId !== undefined) {
    return canonicalEntityRef({ type: 'care_gap', id: args.gapId });
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
  navigation,
  navigationEntity,
  screenEntity,
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

  return {
    lastReferencedEntities,
    pendingConfirmation: sessionState?.pendingConfirmation ?? null,
    pendingDraft: sessionState?.pendingDraft ?? null,
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
  navigation,
  navigationEntity,
  screenEntity,
}) {
  const nextState = buildNextSessionState({
    sessionState: session.state,
    intent,
    capabilityCalls,
    navigation,
    navigationEntity,
    screenEntity,
  });

  try {
    await updateAgentSessionState({
      db: pool,
      userId,
      sessionId: session.id,
      state: nextState,
    });
  } catch {
    // intentionally ignored - see docblock
  }

  return {
    ok: true,
    sessionId: session.id,
    language: session.language,
    reply,
    navigation,
    referencedEntities: buildReferencedEntities({
      screenEntity,
      navigationEntity,
      capabilityCalls,
    }),
    ...(fallbackCode ? { fallbackCode } : {}),
  };
}

/**
 * Handle one authenticated agent message end to end.
 *
 * Returns:
 *   { ok: true, sessionId, language, reply, navigation,
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
  provider = defaultAgentProvider,
}) {
  let language = 'en';
  try {
    // Cheapest validation first: an empty or whitespace-only message is
    // rejected before ANY database side effect (no session is created for
    // an unusable request).
    const boundedMessage = cleanText(
      message,
      AGENT_PLANNER_LIMITS.messageMaxChars,
    );
    if (!boundedMessage) {
      return {
        ok: false,
        code: 'AGENT_MESSAGE_EMPTY',
        message: 'The agent message is empty.',
      };
    }

    // Language authority is the stored profile, never the request body.
    language = await readProfileLanguage(pool, userId);

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
    if (sessionId == null) {
      const created = await createAgentSession({ db: pool, userId, language });
      if (!created.ok) return created;
      session = created.data.session;
      sessionCreated = true;
    } else {
      const read = await readAgentSession({ db: pool, userId, sessionId });
      if (!read.ok) return read;
      session = read.data.session;
    }

    if (!sessionCreated) {
      // Smallest safe user-scoped session-language update (spec 11).
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

    // --- bounded verified context (fail-safe drops, ownership first) ---
    const context = await readAgentScreenContext({
      pool,
      userId,
      clientContext,
    });
    const screenEntity = context.screenContext?.entity || null;

    const contextSlice = buildAgentContextSlice({
      language: session.language,
      screenContext: context.screenContext,
      sessionState: session.state,
    });

    // --- one bounded planning turn ---
    const planned = await planAgentMessage({
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
          session.language,
        ),
        fallbackCode: planned.code,
        intent: denied ? 'declined_by_safety_gateway' : 'unavailable',
        capabilityCalls: [],
        navigation: null,
        navigationEntity: null,
        screenEntity,
      });
    }

    const plan = planned.plan;
    const declined =
      plan.capabilityCalls.length === 0 && DECLINE_INTENT_PATTERN.test(plan.intent);

    // --- execute validated READ calls (bounded by the gateway) ---
    const capabilityResults = [];
    let capabilityFailureCode = null;
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
        });
      } catch {
        result = {
          ok: false,
          code: 'AGENT_CAPABILITY_FAILED',
          message: 'The capability call failed.',
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
        resultStatus: result.ok ? 'succeeded' : 'failed',
        backendConfirmed: result.ok === true,
        ...(target ? { targetType: target.type, targetId: target.id } : {}),
        errorCode: result.ok ? null : result.code || 'AGENT_CAPABILITY_FAILED',
      });
      if (result.ok) {
        capabilityResults.push({ name: call.name, result });
      } else {
        capabilityFailureCode = result.code || 'AGENT_CAPABILITY_FAILED';
      }
    }

    if (capabilityFailureCode) {
      return finishAgentTurn({
        pool,
        userId,
        session,
        reply: localizedAgentText('agentUnavailable', session.language),
        fallbackCode: capabilityFailureCode,
        intent: 'capability_unavailable',
        capabilityCalls: [],
        navigation: null,
        navigationEntity: null,
        screenEntity,
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
      reply = localizedAgentText('agentPermissionDenied', session.language);
      fallbackCode = 'AGENT_PERMISSION_DENIED';
    } else {
      const replyResult = await generateGroundedAgentReply({
        provider,
        language: session.language,
        message: boundedMessage,
        contextSlice,
        capabilityResults,
      });
      if (replyResult.ok) {
        reply = replyResult.reply;
      } else {
        reply = localizedAgentText('agentUnavailable', session.language);
        fallbackCode = replyResult.code || 'AGENT_REPLY_FAILED';
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
      navigation,
      navigationEntity,
      screenEntity,
    });
  } catch {
    return {
      ok: false,
      code: 'AGENT_INTERNAL_ERROR',
      message: localizedAgentText('agentUnavailable', language),
    };
  }
}
