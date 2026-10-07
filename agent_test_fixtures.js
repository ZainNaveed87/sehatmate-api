import {resolveAgentCapability} from './agent/agent_capability_registry.js';

// Upgrade legacy provider fixtures to the required semantic-plan contract.
// Semantic-routing regressions supply explicit categories and never use this helper.
export function withSemanticTestCategory(plan) {
  if(!plan || Array.isArray(plan) || typeof plan!=='object' ||
    !Object.hasOwn(plan,'intent') || Object.hasOwn(plan,'category')) return plan;
  const calls=Array.isArray(plan.capabilityCalls)?plan.capabilityCalls:[];
  const category=calls.some(c=>resolveAgentCapability(c.name)?.permissionClass==='DRAFT')?'action':
    plan.navigationIntent?'navigation':calls.length?'patient_read':
    /declin|deni|forbid/.test(plan.intent)?'unsupported':'conversation';
  return {...plan,category};
}
