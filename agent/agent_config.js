/**
 * Safe, non-secret configuration for the future SehatMate AI Copilot.
 *
 * Phase A2 only parses environment-controlled operational settings
 * (feature flag, session lifetime, state size, rate limits). This module
 * must never read, hold, or print secret values such as OPENROUTER_API_KEY
 * or JWT_SECRET; those stay in their existing owners (ai_service.js and
 * server.js) and are never duplicated here.
 *
 * Every value is optional: unset, malformed, or out-of-range values fall
 * back to the safe defaults below so the API keeps booting with a sane,
 * bounded configuration instead of crashing or running unbounded.
 */

export const AGENT_CONFIG_DEFAULTS = Object.freeze({
  enabled: false,
  maxSessionAgeMinutes: 240,
  sessionStateMaxBytes: 16384,
  rateLimitWindowMinutes: 15,
  rateLimitMax: 30,
});

export const AGENT_CONFIG_LIMITS = Object.freeze({
  maxSessionAgeMinutes: { min: 5, max: 43200 },
  sessionStateMaxBytes: { min: 1024, max: 65536 },
  rateLimitWindowMinutes: { min: 1, max: 1440 },
  rateLimitMax: { min: 1, max: 1000 },
});

function parseBoundedInteger(rawValue, { min, max, fallback }) {
  if (rawValue == null) return fallback;
  const trimmed = String(rawValue).trim();
  if (!/^-?\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(rawValue, fallback) {
  if (rawValue == null) return fallback;
  const normalized = String(rawValue).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
}

/**
 * Complete agent configuration. The result is frozen and contains only the
 * safe operational settings listed in AGENT_CONFIG_DEFAULTS - serializing it
 * (logs, tests) can never leak a secret.
 */
export function agentConfig(env = process.env) {
  return Object.freeze({
    enabled: parseBoolean(
      env.AGENT_ENABLED,
      AGENT_CONFIG_DEFAULTS.enabled,
    ),
    maxSessionAgeMinutes: parseBoundedInteger(
      env.AGENT_MAX_SESSION_AGE_MINUTES,
      { ...AGENT_CONFIG_LIMITS.maxSessionAgeMinutes, fallback: AGENT_CONFIG_DEFAULTS.maxSessionAgeMinutes },
    ),
    sessionStateMaxBytes: parseBoundedInteger(
      env.AGENT_SESSION_STATE_MAX_BYTES,
      { ...AGENT_CONFIG_LIMITS.sessionStateMaxBytes, fallback: AGENT_CONFIG_DEFAULTS.sessionStateMaxBytes },
    ),
    rateLimitWindowMinutes: parseBoundedInteger(
      env.AGENT_RATE_LIMIT_WINDOW_MINUTES,
      { ...AGENT_CONFIG_LIMITS.rateLimitWindowMinutes, fallback: AGENT_CONFIG_DEFAULTS.rateLimitWindowMinutes },
    ),
    rateLimitMax: parseBoundedInteger(
      env.AGENT_RATE_LIMIT_MAX,
      { ...AGENT_CONFIG_LIMITS.rateLimitMax, fallback: AGENT_CONFIG_DEFAULTS.rateLimitMax },
    ),
  });
}

/**
 * Values for the agent rate limiter in the shape express-rate-limit expects.
 * Kept separate from aiLimiter (heavier one-shot AI operations) so future
 * /api/agent/* conversational routes can be tuned independently.
 */
export function agentRateLimits(env = process.env) {
  const config = agentConfig(env);
  return Object.freeze({
    windowMs: config.rateLimitWindowMinutes * 60 * 1000,
    limit: config.rateLimitMax,
  });
}