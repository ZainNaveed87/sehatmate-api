/**
 * Agent Provider boundary (Phase B).
 *
 * The single seam between the Agent modules and the AI provider. All
 * provider access for planning and response generation goes through this
 * module, which REUSES the existing ai_service.js OpenRouter
 * infrastructure (API-key handling, model configuration, abort timeout,
 * JSON-mode parsing) so the codebase keeps exactly ONE provider
 * implementation and one API-key owner.
 *
 * Guarantees:
 *   - No secrets: OPENROUTER_API_KEY never crosses this boundary. Health
 *     reporting exposes only configured/provider/model and env var NAMES
 *     in messages, never values.
 *   - No stale model slug: the model comes from the existing
 *     environment-controlled OPENROUTER_MODEL configuration through
 *     aiConfiguration(); this module never names a model.
 *   - Bounded: exactly ONE attempt per turn (zero retries by design), the
 *     existing 45-second abort timeout of ai_service.js, deterministic
 *     temperature 0, and fixed per-purpose output-token caps that callers
 *     cannot raise.
 *   - No tool execution: the provider request carries no tool
 *     definitions and no recursion. The model may only PROPOSE names and
 *     arguments as JSON; every proposal is validated against the closed
 *     capability / navigation registries and the safety gateway before
 *     anything executes. The provider itself can never trigger backend
 *     execution, so no autonomous tool loop is possible.
 *   - Mockable: createAgentProvider({ generateJson }) injects a
 *     deterministic fake provider for tests; automated tests never
 *     consume real OpenRouter credits.
 *
 * Language handling: planning turns are deliberately language-neutral
 * (preferredLanguage stays null) because the planner output is machine
 * structure with canonical names, never user-facing text. Reply turns
 * pass preferredLanguage through so ai_service.js appends the existing
 * language instruction - there is no second language architecture.
 *
 * Failure contract (spec section 22): every failure is a structured
 * { ok: false, code, message } result - never a thrown error - so the
 * agent core can fail safely with the localized agentUnavailable
 * fallback. Stable codes:
 *   AGENT_PROVIDER_UNCONFIGURED  model/key configuration missing
 *   AGENT_PROMPT_TOO_LARGE       caller exceeded the prompt size bounds
 *   AGENT_PROVIDER_FAILED        timeout, invalid JSON, HTTP error,
 *                                non-object JSON, or unexpected failure
 */

import { aiConfiguration, generateAiJson } from '../ai_service.js';

/**
 * Hard bounds for agent prompts. Fixed per purpose; callers cannot raise
 * the token caps because bounded output is a safety property, not a
 * tuning knob.
 */
export const AGENT_PROVIDER_LIMITS = Object.freeze({
  systemPromptMaxChars: 4000,
  userPromptMaxChars: 16000,
  planningMaxTokens: 600,
  replyMaxTokens: 900,
});

const PASS_THROUGH_CONFIGURATION = () => ({
  configured: true,
  provider: 'injected',
  model: 'injected',
  message: null,
});

function providerFailure(code, message) {
  return { ok: false, code, message };
}

function boundedPrompt(value, maxChars, label) {
  const text = typeof value === 'string' ? value : '';
  if (!text.trim()) {
    return { error: `${label} must be a non-empty string.` };
  }
  if (text.length > maxChars) {
    return { error: `${label} exceeds the ${maxChars}-character bound.` };
  }
  return { text };
}

/**
 * Provider health for guards and diagnostics. Mirrors aiConfiguration()
 * without any secret material.
 */
export function agentProviderHealth() {
  const configuration = aiConfiguration();
  return {
    ok: configuration.configured,
    configured: configuration.configured,
    provider: configuration.provider,
    model: configuration.model,
    message: configuration.configured ? null : configuration.message,
  };
}

function isPlainObjectJson(json) {
  return json != null && typeof json === 'object' && !Array.isArray(json);
}

/**
 * Build an agent provider. Tests inject generateJson (and optionally
 * configuration) to mock the transport; production uses the defaults
 * bound to ai_service.js. Injecting generateJson switches the health
 * check to a pass-through so a mocked environment without real provider
 * credentials still exercises the success path.
 *
 * The returned provider is frozen and exposes exactly:
 *   health()                                  provider configuration state
 *   planAgentTurn({ systemPrompt, userPrompt })
 *   generateAgentReply({ systemPrompt, userPrompt, preferredLanguage })
 */
export function createAgentProvider(overrides = {}) {
  const usesInjectedProvider = typeof overrides.generateJson === 'function';
  const generateJson = usesInjectedProvider ? overrides.generateJson : generateAiJson;
  const configuration = typeof overrides.configuration === 'function'
    ? overrides.configuration
    : (usesInjectedProvider ? PASS_THROUGH_CONFIGURATION : aiConfiguration);

  async function structuredCompletion({
    systemPrompt,
    userPrompt,
    maxTokens,
    preferredLanguage = null,
  }) {
    const system = boundedPrompt(
      systemPrompt,
      AGENT_PROVIDER_LIMITS.systemPromptMaxChars,
      'systemPrompt',
    );
    if (system.error) return providerFailure('AGENT_PROMPT_TOO_LARGE', system.error);

    const user = boundedPrompt(
      userPrompt,
      AGENT_PROVIDER_LIMITS.userPromptMaxChars,
      'userPrompt',
    );
    if (user.error) return providerFailure('AGENT_PROMPT_TOO_LARGE', user.error);

    const health = configuration();
    if (!health.configured) {
      return providerFailure(
        'AGENT_PROVIDER_UNCONFIGURED',
        health.message || 'The AI provider is not configured.',
      );
    }

    try {
      const completion = await generateJson({
        systemPrompt: system.text,
        userPrompt: user.text,
        temperature: 0,
        maxTokens,
        preferredLanguage,
      });

      if (!isPlainObjectJson(completion?.json)) {
        return providerFailure(
          'AGENT_PROVIDER_FAILED',
          'The AI provider returned invalid JSON.',
        );
      }

      return {
        ok: true,
        data: {
          json: completion.json,
          model: completion.model,
          provider: completion.provider,
          inputTokens: Number(completion.inputTokens || 0),
          outputTokens: Number(completion.outputTokens || 0),
        },
      };
    } catch (error) {
      // AiServiceError messages are sanitized upstream, so they are safe
      // to surface; every other error is wrapped in a generic message so
      // internal details never leak.
      const sanitized = error?.name === 'AiServiceError' &&
        typeof error.message === 'string' && error.message.trim()
        ? error.message
        : 'The AI provider request failed.';
      return providerFailure('AGENT_PROVIDER_FAILED', sanitized);
    }
  }

  return Object.freeze({
    health: () => {
      const state = configuration();
      return {
        ok: Boolean(state.configured),
        configured: Boolean(state.configured),
        provider: state.provider,
        model: state.model,
        message: state.configured ? null : state.message,
      };
    },

    /**
     * One structured planning completion. Language-neutral and bounded to
     * the planning token cap; single attempt, no retries.
     */
    async planAgentTurn({ systemPrompt, userPrompt }) {
      return structuredCompletion({
        systemPrompt,
        userPrompt,
        maxTokens: AGENT_PROVIDER_LIMITS.planningMaxTokens,
        preferredLanguage: null,
      });
    },

    /**
     * One structured reply completion. preferredLanguage flows through to
     * ai_service.js so the existing language instruction applies to the
     * user-facing reply; bounded to the reply token cap; single attempt.
     */
    async generateAgentReply({ systemPrompt, userPrompt, preferredLanguage = null }) {
      return structuredCompletion({
        systemPrompt,
        userPrompt,
        maxTokens: AGENT_PROVIDER_LIMITS.replyMaxTokens,
        preferredLanguage,
      });
    },
  });
}

/**
 * The production provider. All Agent modules use this instance (or an
 * injected equivalent created by tests); nothing imports generateAiJson
 * directly outside this module.
 */
export const defaultAgentProvider = createAgentProvider();
