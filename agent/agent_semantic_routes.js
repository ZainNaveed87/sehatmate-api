import {listAgentCapabilities,resolveAgentCapability} from './agent_capability_registry.js';
import {listAgentNavigationTargets} from './agent_navigation_registry.js';
import {isExecutableAgentPermissionClass} from './agent_safety_gateway.js';
import {canonicalAgentLanguage} from './agent_session_store.js';

export const AGENT_SEMANTIC_CATEGORIES=Object.freeze([
  'conversation','app_help','patient_read','navigation','action','unsupported','ambiguous',
]);

// Server-owned product descriptions, enabled only when their registered implementation exists.
// These describe assistance, never a patient's state. No model-written feature claims are used.
const HELP_FEATURES=Object.freeze([
  {tools:['get_care_plans','get_care_plan'],text:{en:'discuss your verified care plans',ur:'آپ کے تصدیق شدہ نگہداشت کے منصوبے سمجھنے',roman_ur:'aap ke verified care plans samajhne'}},
  {tools:['get_next_task','get_today_tasks'],text:{en:'check your tasks and progress',ur:'آپ کے کام اور پیش رفت دیکھنے',roman_ur:'aap ke tasks aur progress dekhne'}},
  {tools:['get_reality_check','get_simulation','get_care_gaps'],text:{en:'explain Reality Check, Simulation and Care Gaps',ur:'Reality Check، Simulation اور Care Gaps سمجھنے',roman_ur:'Reality Check, Simulation aur Care Gaps samajhne'}},
  {tools:['get_routine_preferences'],text:{en:'review routine preferences',ur:'معمول کی ترجیحات دیکھنے',roman_ur:'routine preferences dekhne'}},
  {tools:['get_plan_progress','compare_performance'],text:{en:'explain verified progress and performance comparisons',ur:'تصدیق شدہ پیش رفت اور کارکردگی کا موازنہ سمجھنے',roman_ur:'verified progress aur performance comparison samajhne'}},
  {tools:['family_members_list','family_member_care_plans'],text:{en:'review Family Care within your granted access',ur:'آپ کی اجازت کے مطابق Family Care دیکھنے',roman_ur:'aap ki granted access ke mutabiq Family Care dekhne'}},
  {tools:['draft_task_outcome','draft_schedule_time'],text:{en:'prepare supported task or reminder changes for your confirmation',ur:'آپ کی تصدیق کے لیے اجازت یافتہ کام یا یاد دہانی کی تبدیلی کا مسودہ بنانے',roman_ur:'aap ki confirmation ke liye supported task ya reminder changes ka draft banane'}},
]);

export function assistantHelpCatalog() {
  const registered=new Set(listAgentCapabilities()
    .filter(c=>isExecutableAgentPermissionClass(c.permissionClass)).map(c=>c.name));
  return HELP_FEATURES.filter(f=>f.tools.every(name=>registered.has(name)));
}

export function assistantHelpReply(language) {
  const lang=canonicalAgentLanguage(language);
  const features=assistantHelpCatalog().map(f=>f.text[lang]);
  if(listAgentNavigationTargets().length) features.push({en:'open supported app screens',ur:'اجازت یافتہ ایپ اسکرین کھولنے',roman_ur:'supported app screens kholne'}[lang]);
  if(lang==='ur') return `میں ${features.join('، ')} میں مدد کر سکتا ہوں۔ آپ کہاں سے شروع کرنا چاہیں گے؟`;
  if(lang==='roman_ur') return `Main ${features.join(', ')} mein madad kar sakta hoon. Aap kahan se shuru karna chahenge?`;
  return `I can help you ${features.join(', ')}. Where would you like to start?`;
}

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
