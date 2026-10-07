import {resolveAgentCapability} from './agent_capability_registry.js';
import {canonicalAgentLanguage} from './agent_session_store.js';

export const AGENT_SEMANTIC_CATEGORIES=Object.freeze([
  'conversation','app_help','patient_read','navigation','action','unsupported','ambiguous',
]);

export function unsupportedAgentReply(language) {
  return {en:'I can help with supported SehatMate care and app questions. What would you like help with?',
    ur:'میں SehatMate کی اجازت یافتہ نگہداشت اور ایپ کے سوالات میں مدد کر سکتا ہوں۔ آپ کو کس چیز میں مدد چاہیے؟',
    roman_ur:'Main SehatMate ke supported care aur app sawalon mein madad kar sakta hoon. Aap ko kis cheez mein madad chahiye?'}[canonicalAgentLanguage(language)];
}

export function reviewSemanticRoute(category,calls,navigation) {
  if(!AGENT_SEMANTIC_CATEGORIES.includes(category)) return false;
  if(['conversation','app_help','unsupported','ambiguous'].includes(category)) return calls.length===0&&!navigation;
  if(category==='patient_read') return calls.length>0&&!navigation&&calls.every(c=>resolveAgentCapability(c.name)?.permissionClass==='READ');
  if(category==='navigation') return Boolean(navigation)&&calls.every(c=>resolveAgentCapability(c.name)?.permissionClass==='READ');
  return calls.some(c=>resolveAgentCapability(c.name)?.permissionClass==='DRAFT');
}

// This is NOT a semantic router or a phrase list. It is a conservative extra fence for
// a deterministic task-only fallback when the reply provider fails. The current turn
// must contain task/pending + query + next/today concepts. Ambiguous follow-ups cannot
// authorize this fallback from old state, a tool name or a model's free-form intent.
export function currentTaskFallbackAllowed({message,category}) {
  if(category!=='patient_read') return false;
  const text=String(message??'').normalize('NFKC').toLowerCase();
  const task=/\b(?:tasks?|pending|kaam|kam)\b|کام|زیرِ?\s*التوا/u.test(text);
  const timeframe=/\b(?:next|today|pending|agla|agli|aaj)\b|اگلا|اگلی|آج|التوا/u.test(text);
  const query=/\b(?:what|which|when|do|have|show|list|tell|check|any|kya|kia|kaunsa|batao|batayein|dikhao)\b|کیا|کون|بتا|دکھا/u.test(text);
  const help=/\b(?:help|madad|sehat\s*mate|can you|features?|capabilit\w*|able to|how to|how do|how can|support)\b|مدد|سہت\s*میٹ/u.test(text);
  const nonQuery=/\b(?:not|don't|do not|stop|cancel|mark|complete|skip|change|delete|remove|move)\b/u.test(text);
  return task&&timeframe&&query&&!help&&!nonQuery;
}
