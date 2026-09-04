/**
 * Canonical Agent Capability Registry (Phase B).
 *
 * One central, closed registry of every data capability the AI Copilot may
 * execute. A capability exists here or it does not exist at all: unknown
 * names fail closed and can never reach an execution path, so the model
 * cannot invent executable tool names.
 *
 * Every capability definition provides:
 *   name             lowercase snake_case identifier (AGENT_TOOL_NAME_PATTERN)
 *   permissionClass  canonical class from agent_action_audit.js
 *   description      short planner-facing description of what it does
 *   inputSchema      strict whitelist of the allowed argument fields
 *   execute          the only execution path (an authoritative service call)
 *   resultContract   short description of the successful result shape
 *
 * Security invariants enforced by this module:
 *   - The authenticated userId is INJECTED server-side into execute(); it
 *     is never accepted as a model-supplied argument. Any 'userId' or
 *     'user_id' argument key is rejected before any other validation runs.
 *   - inputSchema is a closed whitelist: undeclared argument keys are
 *     rejected, so arbitrary nested payloads, SQL, table names, column
 *     names, or URLs can never become executable arguments.
 *   - Argument values are validated per declared type (numeric ids, valid
 *     calendar dates, bounded integers, booleans, exact enums) and the
 *     whole argument payload is byte-bounded.
 *   - execute() receives ONLY ({ pool, userId, args }): no Express req/res,
 *     no authorization headers, no transport objects of any kind.
 *
 * This module contains no LLM provider code and never will. Navigation
 * intents are governed separately by agent_navigation_registry.js; this
 * registry covers data capabilities only.
 */

import {
  AGENT_TOOL_NAME_PATTERN,
  isAgentPermissionClass,
} from './agent_action_audit.js';
import {
  cleanText,
  idPattern,
  taskOutcomeDate,
} from '../services/shared_utils.js';

const MAX_ARGS_BYTES = 1024;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_RESULT_CONTRACT_LENGTH = 500;
const ARGUMENT_NAME_PATTERN = /^[a-z][a-zA-Z0-9]{0,39}$/;
const PROPERTY_TYPES = new Set([
  'id',
  'date',
  'string',
  'integer',
  'boolean',
  'enum',
]);

const capabilities = new Map();

function invalidArgs(message) {
  return {
    ok: false,
    code: 'INVALID_CAPABILITY_ARGS',
    message,
  };
}

function assertDefinitionValid(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('Agent capability definition must be a plain object.');
  }
  const {
    name,
    permissionClass,
    description,
    inputSchema,
    execute,
    resultContract,
  } = definition;

  if (typeof name !== 'string' || !AGENT_TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`Agent capability name is invalid: ${name}`);
  }
  if (!isAgentPermissionClass(permissionClass)) {
    throw new Error(`Agent capability ${name} has a non-canonical permission class.`);
  }
  if (
    typeof description !== 'string' ||
    !cleanText(description, MAX_DESCRIPTION_LENGTH)
  ) {
    throw new Error(`Agent capability ${name} needs a bounded description.`);
  }
  if (
    typeof resultContract !== 'string' ||
    !cleanText(resultContract, MAX_RESULT_CONTRACT_LENGTH)
  ) {
    throw new Error(`Agent capability ${name} needs a bounded result contract.`);
  }
  if (typeof execute !== 'function') {
    throw new Error(`Agent capability ${name} must define an execute function.`);
  }
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    throw new Error(`Agent capability ${name} needs an input schema object.`);
  }
  const properties = inputSchema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error(`Agent capability ${name} needs schema properties.`);
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (!ARGUMENT_NAME_PATTERN.test(key)) {
      throw new Error(`Agent capability ${name} has an invalid argument name: ${key}`);
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`Agent capability ${name} argument ${key} needs a spec object.`);
    }
    if (!PROPERTY_TYPES.has(spec.type)) {
      throw new Error(
        `Agent capability ${name} argument ${key} has an unsupported type: ${spec.type}`,
      );
    }
    if (spec.type === 'enum') {
      if (
        !Array.isArray(spec.values) ||
        spec.values.length === 0 ||
        !spec.values.every((value) => typeof value === 'string')
      ) {
        throw new Error(
          `Agent capability ${name} enum argument ${key} needs string values.`,
        );
      }
    }
    if (spec.type === 'string' && spec.maxLength != null &&
      (!Number.isInteger(spec.maxLength) || spec.maxLength < 1)) {
      throw new Error(`Agent capability ${name} argument ${key} has an invalid maxLength.`);
    }
    if (spec.type === 'integer') {
      for (const bound of [spec.min, spec.max]) {
        if (bound != null && !Number.isInteger(bound)) {
          throw new Error(`Agent capability ${name} argument ${key} has non-integer bounds.`);
        }
      }
    }
  }
  if (
    inputSchema.required != null &&
    (!Array.isArray(inputSchema.required) ||
      !inputSchema.required.every(
        (key) => typeof key === 'string' && key in properties,
      ))
  ) {
    throw new Error(
      `Agent capability ${name} required list must reference declared arguments.`,
    );
  }
}

/**
 * Register one capability. Definitions are validated up front and frozen;
 * duplicate names are a programming error and fail loudly at module load.
 */
export function defineAgentCapability(definition) {
  assertDefinitionValid(definition);
  if (capabilities.has(definition.name)) {
    throw new Error(`Agent capability already registered: ${definition.name}`);
  }
  const frozen = Object.freeze({
    ...definition,
    inputSchema: Object.freeze({
      properties: Object.freeze({ ...definition.inputSchema.properties }),
      required: Object.freeze([...(definition.inputSchema.required || [])]),
    }),
  });
  capabilities.set(frozen.name, frozen);
  return frozen;
}

/**
 * Exact-match capability lookup. Unknown or non-string names resolve to
 * null so callers fail closed.
 */
export function resolveAgentCapability(name) {
  if (typeof name !== 'string') return null;
  return capabilities.get(name) || null;
}

/**
 * Planner-facing capability metadata. Execution functions are never
 * exposed through this list.
 */
export function listAgentCapabilities() {
  return [...capabilities.values()].map((capability) => ({
    name: capability.name,
    permissionClass: capability.permissionClass,
    description: capability.description,
    inputSchema: {
      properties: Object.fromEntries(
        Object.entries(capability.inputSchema.properties).map(([key, spec]) => [
          key,
          { ...spec },
        ]),
      ),
      required: [...capability.inputSchema.required],
    },
  }));
}

function canonicalPropertyValue(spec, name, value) {
  switch (spec.type) {
    case 'id': {
      const canonical =
        typeof value === 'number' && Number.isInteger(value) && value > 0
          ? String(value)
          : typeof value === 'string'
            ? cleanText(value, 20)
            : null;
      if (!canonical || !idPattern.test(canonical)) {
        return { error: `${name} must be a valid numeric id.` };
      }
      return { value: canonical };
    }
    case 'date': {
      if (typeof value !== 'string') {
        return { error: `${name} must be a YYYY-MM-DD date string.` };
      }
      // Reject rather than silently truncate: anything that is not exactly
      // a YYYY-MM-DD string (including injection payloads with trailing
      // content) must fail validation, never be reinterpreted as a date.
      const trimmed = value.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return { error: `${name} must be a valid YYYY-MM-DD calendar date.` };
      }
      const canonical = taskOutcomeDate(trimmed);
      if (!canonical) {
        return { error: `${name} must be a valid YYYY-MM-DD calendar date.` };
      }
      return { value: canonical };
    }
    case 'string': {
      if (typeof value !== 'string') {
        return { error: `${name} must be a string.` };
      }
      const canonical = cleanText(value, spec.maxLength || 200);
      if (!canonical) {
        return { error: `${name} must not be empty.` };
      }
      return { value: canonical };
    }
    case 'integer': {
      let parsed;
      if (typeof value === 'number') {
        parsed = value;
      } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
        parsed = Number(value.trim());
      } else {
        return { error: `${name} must be an integer.` };
      }
      if (!Number.isInteger(parsed)) {
        return { error: `${name} must be an integer.` };
      }
      if (spec.min != null && parsed < spec.min) {
        return { error: `${name} must be at least ${spec.min}.` };
      }
      if (spec.max != null && parsed > spec.max) {
        return { error: `${name} must be at most ${spec.max}.` };
      }
      return { value: parsed };
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        return { error: `${name} must be a boolean.` };
      }
      return { value };
    }
    case 'enum': {
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        return { error: `${name} must be one of: ${spec.values.join(', ')}.` };
      }
      return { value };
    }
    default:
      return { error: `${name} has an unsupported type.` };
  }
}

/**
 * Validate model-supplied arguments against a capability's strict schema.
 * Returns { ok: true, args } with canonicalized arguments, or
 * { ok: false, code: 'INVALID_CAPABILITY_ARGS', message }. The result is
 * always a plain object containing only whitelisted keys.
 */
export function validateAgentCapabilityInput(capability, rawArgs) {
  if (!capability || !capability.inputSchema) {
    return invalidArgs('Capability is not registered.');
  }
  const args = rawArgs == null ? {} : rawArgs;
  if (typeof args !== 'object' || Array.isArray(args)) {
    return invalidArgs('Capability arguments must be a plain object.');
  }

  // The authenticated user is injected server-side; the model can never
  // supply identity (or anything identity-shaped) through arguments.
  if ('userId' in args || 'user_id' in args) {
    return invalidArgs('Capability arguments must not include a user id.');
  }

  const properties = capability.inputSchema.properties;
  const canonical = {};
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec) {
      return invalidArgs(`Unknown argument: ${key}.`);
    }
    if (value == null) {
      return invalidArgs(`Argument ${key} must not be null.`);
    }
    const result = canonicalPropertyValue(spec, key, value);
    if (result.error) {
      return invalidArgs(result.error);
    }
    canonical[key] = result.value;
  }

  for (const key of capability.inputSchema.required) {
    if (!(key in canonical)) {
      return invalidArgs(`Missing required argument: ${key}.`);
    }
  }

  const serialized = JSON.stringify(canonical);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ARGS_BYTES) {
    return invalidArgs('Capability arguments are too large.');
  }
  return { ok: true, args: canonical };
}

/**
 * Fail-closed single entry point for capability execution: resolve the
 * name, strictly validate the arguments, and only then hand the
 * server-injected identity to the capability's execute function. Unknown
 * capabilities return UNKNOWN_CAPABILITY without any database access.
 * Thrown service errors propagate to the caller (agent_core).
 */
function permissionDeniedExecution(capability) {
  return {
    ok: false,
    code: 'AGENT_PERMISSION_CLASS_NOT_EXECUTABLE',
    message: 'The SehatMate assistant cannot perform that change.',
    permissionClass: capability.permissionClass,
  };
}

async function executeRegisteredCapability({ capability, pool, userId, args }) {
  const validated = validateAgentCapabilityInput(capability, args);
  if (!validated.ok) {
    return validated;
  }
  return capability.execute({ pool, userId, args: validated.args });
}

export async function executeAgentCapability({ name, pool, userId, args }) {
  const capability = resolveAgentCapability(name);
  if (!capability) {
    return {
      ok: false,
      code: 'UNKNOWN_CAPABILITY',
      message: 'Unknown agent capability.',
    };
  }
  if (
    capability.permissionClass === 'SENSITIVE_ACTION' ||
    capability.permissionClass === 'FORBIDDEN_CLINICAL_ACTION' ||
    capability.permissionClass === 'REVERSIBLE_USER_ACTION'
  ) {
    return permissionDeniedExecution(capability);
  }
  return executeRegisteredCapability({ capability, pool, userId, args });
}

export async function executeConfirmedAgentCapability({ name, pool, userId, args }) {
  const capability = resolveAgentCapability(name);
  if (!capability) {
    return {
      ok: false,
      code: 'UNKNOWN_CAPABILITY',
      message: 'Unknown agent capability.',
    };
  }
  if (capability.permissionClass !== 'REVERSIBLE_USER_ACTION') {
    return permissionDeniedExecution(capability);
  }
  return executeRegisteredCapability({ capability, pool, userId, args });
}
