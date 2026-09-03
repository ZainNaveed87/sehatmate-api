/**
 * Agent Safety Gateway (Phase B).
 *
 * The Safety Gateway is the FINAL authority on what the Phase B agent may
 * execute. Nothing reaches a backend service unless this module approves
 * it, and approval is re-checked at the last possible moment -
 * immediately before every capability execution - not only at planning
 * time, so a planner defect can never bypass the class allowlist.
 *
 * Phase B executable permission classes (closed allowlist):
 *   READ        verified data reads via agent_capability_registry.js
 *   NAVIGATION  semantic screen intents via agent_navigation_registry.js
 *
 * Rejected classes (fail closed with a stable error code):
 *   DRAFT, REVERSIBLE_USER_ACTION, SENSITIVE_ACTION,
 *   FORBIDDEN_CLINICAL_ACTION
 *
 * Requests such as "change my dose", "take this medicine twice instead",
 * "move my verified exact 2 PM medicine to 5 PM", or "remove my
 * prescribed medicine" can therefore never execute in Phase B: no such
 * capability is registered, and this gateway independently re-resolves
 * the permission class of every requested capability from the canonical
 * registry - the class is never accepted from the planner or provider -
 * so even a hallucinated or injected tool request fails closed.
 *
 * Division of labor with the registry: agent_capability_registry.js may
 * hold definitions of ANY canonical permission class (Phase D will add
 * DRAFT tools without a rebuild); THIS module alone decides which classes
 * are executable in the current phase.
 *
 * The denial is explainable, not silent: callers surface the stable
 * AGENT_PERMISSION_CLASS_NOT_EXECUTABLE code with the localized
 * agentPermissionDenied fallback text (language_support.js), so the agent
 * can tell the user it cannot make that clinical change without ever
 * implying the change happened.
 *
 * This module never overrides, weakens, or wraps schedule_time_guard.js
 * or any other authoritative safety logic; verified exact medical timing
 * remains governed by those existing rules. The gateway only adds one
 * more fail-closed layer on top. It performs no database access at all.
 */

import { resolveAgentCapability } from './agent_capability_registry.js';

/**
 * The only permission classes the Phase B agent may execute. Extending
 * this list is a deliberate phase decision (Phase D), never a runtime
 * configuration.
 */
export const AGENT_EXECUTABLE_PERMISSION_CLASSES = Object.freeze(['READ', 'NAVIGATION']);

/**
 * Phase B hard bound on planned capability calls per user message
 * (spec section 16: "maximum 3 capability calls per user message is
 * sufficient unless the existing architecture justifies a smaller
 * number"). A safety bound, not a tuning knob.
 */
export const AGENT_MAX_CAPABILITY_CALLS_PER_MESSAGE = 3;

export function isExecutableAgentPermissionClass(value) {
  return AGENT_EXECUTABLE_PERMISSION_CLASSES.includes(value);
}

function gatewayRejection(code, message) {
  return { ok: false, code, message };
}

/**
 * Stable denial result for a non-executable permission class. The
 * permissionClass is echoed for audit records; the message is the
 * canonical English denial (localized text lives in language_support.js
 * under the agentPermissionDenied key).
 */
export function agentPermissionDeniedResult(permissionClass) {
  return {
    ok: false,
    code: 'AGENT_PERMISSION_CLASS_NOT_EXECUTABLE',
    message: 'The SehatMate assistant cannot perform that change.',
    permissionClass,
  };
}

/**
 * Review ONE capability call against the Phase B execution policy. The
 * permission class is resolved from the canonical capability registry -
 * never supplied by the caller, the planner, or the provider - so this
 * review cannot be spoofed.
 *
 * Returns:
 *   { ok: true, capability }              the resolved registry definition
 *   { ok: false, code: 'UNKNOWN_CAPABILITY', message }
 *   { ok: false, code: 'AGENT_PERMISSION_CLASS_NOT_EXECUTABLE',
 *     message, permissionClass }
 */
export function reviewAgentCapabilityCall({ name }) {
  const capability = resolveAgentCapability(name);
  if (!capability) {
    return gatewayRejection('UNKNOWN_CAPABILITY', 'Unknown agent capability.');
  }
  if (!isExecutableAgentPermissionClass(capability.permissionClass)) {
    return agentPermissionDeniedResult(capability.permissionClass);
  }
  return { ok: true, capability };
}

/**
 * Review the full capability-call list of one planned agent message:
 * bounded count plus per-call permission review. Argument CONTENTS are
 * validated separately by the capability registry at execution time
 * (fail-closed, zero database access on invalid arguments); this gateway
 * owns the permission-class and call-count policy.
 *
 * Returns:
 *   { ok: true, calls: string[] }         the approved capability names
 *   { ok: false, code: 'INVALID_AGENT_CAPABILITY_CALLS', message }
 *   { ok: false, code: 'AGENT_TOO_MANY_CAPABILITY_CALLS', message, limit }
 *   ...or any per-call rejection, with toolName attached for audit
 */
export function reviewAgentCapabilityCalls(calls) {
  const list = calls == null ? [] : calls;
  if (!Array.isArray(list)) {
    return gatewayRejection(
      'INVALID_AGENT_CAPABILITY_CALLS',
      'Capability calls must be a list of { name, args } entries.',
    );
  }
  if (list.length === 0) {
    return { ok: true, calls: [] };
  }
  if (list.length > AGENT_MAX_CAPABILITY_CALLS_PER_MESSAGE) {
    return {
      ok: false,
      code: 'AGENT_TOO_MANY_CAPABILITY_CALLS',
      message: `At most ${AGENT_MAX_CAPABILITY_CALLS_PER_MESSAGE} capability calls are allowed per message.`,
      limit: AGENT_MAX_CAPABILITY_CALLS_PER_MESSAGE,
    };
  }

  const approved = [];
  for (const call of list) {
    if (!call || typeof call !== 'object' || Array.isArray(call)) {
      return gatewayRejection(
        'INVALID_AGENT_CAPABILITY_CALLS',
        'Each capability call must be an object with name and args.',
      );
    }
    const reviewed = reviewAgentCapabilityCall({ name: call.name });
    if (!reviewed.ok) {
      return {
        ...reviewed,
        toolName: typeof call.name === 'string' ? call.name : null,
      };
    }
    approved.push(call.name);
  }
  return { ok: true, calls: approved };
}

/**
 * Review whether a planned navigation intent may be emitted at all.
 * NAVIGATION is an executable class in Phase B, so the semantic intent
 * itself is validated and ownership-authorized by
 * agent_navigation_registry.js (authorizeAgentNavigationIntent); this
 * gateway confirms the class is executable so every execution path -
 * data reads AND navigation emissions - passes through the same final
 * authority. If a future phase withdraws navigation, this is the single
 * place that changes.
 *
 * Returns:
 *   { ok: true }
 *   { ok: false, code: 'AGENT_PERMISSION_CLASS_NOT_EXECUTABLE',
 *     message, permissionClass: 'NAVIGATION' }
 */
export function reviewAgentNavigationPermission() {
  if (isExecutableAgentPermissionClass('NAVIGATION')) {
    return { ok: true };
  }
  return agentPermissionDeniedResult('NAVIGATION');
}
