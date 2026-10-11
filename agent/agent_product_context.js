import {listAgentCapabilities} from './agent_capability_registry.js';
import {listAgentNavigationTargets} from './agent_navigation_registry.js';
import {AGENT_EXECUTABLE_PERMISSION_CLASSES,isExecutableAgentPermissionClass} from './agent_safety_gateway.js';
import {AGENT_STATE_LIMITS} from './agent_session_state.js';

const MAX_CONTEXT_CHARS=8200;
const MAX_FACTS=64;
const MAX_CONTINUITY_FACTS=4;
const TOPIC=/^[a-z][a-z0-9_]{0,79}$/;

// Facts and policy metadata, never finished conversational wording. No patient data.
export function buildAgentProductContext() {
  const facts=[
    {id:'product_identity',kind:'identity',description:'SehatMate is a care and app assistant whose supported operations are the registered entries in this context.'},
    {id:'boundary_permissions',kind:'boundary',description:`Ordinary turns may use only ${AGENT_EXECUTABLE_PERMISSION_CLASSES.join(', ')} permission classes; drafting is a preview, not a mutation.`},
    {id:'boundary_confirmation',kind:'boundary',description:'Only registered confirmed actions may change data, after owned explicit confirmation and existing safety guards. Help text never executes an action.'},
    {id:'boundary_clinical',kind:'boundary',description:'The assistant cannot prescribe, diagnose, change verified medicines/doses/instructions, bypass ownership, or act as a clinician.'},
    {id:'boundary_evidence',kind:'boundary',description:'Personal care facts require authoritative owned READ results. Product help has none. Other apps, superiority, clinical outcomes, pricing, integrations and certifications are not established by these registrations.'},
    {id:'feature_care_plan_name',kind:'feature',description:'New Care Plan title input/create_care_plan collects a title; owned draft creation requires confirmation. Backend rename exists; existing-plan rename UI/Agent action is not mounted or registered. No rename menu/external approval rule is established.'},
    {id:'boundary_global_context',kind:'boundary',description:'Global app catalog: route guides relevance/mounted UI, never limits global help/account memory. No provider/admin rule is established.'},
    {id:'boundary_navigation',kind:'boundary',description:'Navigation entries are supported screen targets only, not proof of additional features. Opening a screen requires server authorization, and help does not open it.'},
  ];
  const add=fact=>{
    if(facts.length>=MAX_FACTS) return;
    // Omit whole entries, never truncate a description's safety qualification.
    if(JSON.stringify({facts:[...facts,fact]}).length<=MAX_CONTEXT_CHARS) facts.push(fact);
  };
  for(const c of listAgentCapabilities()) {
    // Confirmation policy is described above; direct mutation tools are never
    // advertised in the ordinary planner's product catalog.
    if(!isExecutableAgentPermissionClass(c.permissionClass)) continue;
    add({id:`cap_${c.name}`,permissionClass:c.permissionClass,description:c.description,
      ...(c.permissionClass==='DRAFT'?{supportedChoices:Object.fromEntries(Object.entries(c.inputSchema.properties)
        .filter(([,spec])=>spec.type==='enum').map(([name,spec])=>[name,spec.values]))}:{})});
  }
  for(const navigation of listAgentNavigationTargets()) {
    // The planner already receives the complete parameter/authorization table.
    // Help needs destination existence only; duplicate schemas previously pushed
    // later real destinations outside this bounded catalog.
    add({id:`nav_${navigation.target}`});
  }
  return {facts};
}

// Use only the existing bounded summary slot. No raw user message, reply or model body.
export function productConversationContext(summary,productContext=buildAgentProductContext()) {
  if(typeof summary!=='string'||summary.length>AGENT_STATE_LIMITS.summaryMaxLength) return null;
  let parsed;
  try {parsed=JSON.parse(summary);} catch {return null;}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||
    Object.keys(parsed).sort().join(',')!=='category,factIds,topic'||
    !['app_help','conversation','ambiguous'].includes(parsed.category)||
    typeof parsed.topic!=='string'||!TOPIC.test(parsed.topic)||
    !Array.isArray(parsed.factIds)||parsed.factIds.length>MAX_CONTINUITY_FACTS) return null;
  const known=new Set(productContext.facts.map(f=>f.id));
  if(!parsed.factIds.every(id=>typeof id==='string')) return null;
  return {category:parsed.category,topic:parsed.topic,
    factIds:[...new Set(parsed.factIds.filter(id=>known.has(id)))]};
}

export function productConversationSummary({category,topic,factIds=[]}) {
  const value=JSON.stringify({category,topic,factIds:factIds.slice(0,MAX_CONTINUITY_FACTS)});
  const safe=productConversationContext(value);
  return safe?JSON.stringify(safe):null;
}

// Selection is checked against server registrations, never a client context slice.
export function selectAgentProductFacts(ids) {
  const catalog=buildAgentProductContext();
  if(!Array.isArray(ids)||ids.length<1||ids.length>6||
    !Array.from(ids).every(id=>typeof id==='string'&&catalog.facts.some(f=>f.id===id))) {
    return {ok:false,code:'AGENT_PRODUCT_FACT_SELECTION_INVALID',message:'Invalid product fact selection.'};
  }
  const productFactIds=[...new Set(ids)];
  return {ok:true,productFactIds,productContext:{facts:productFactIds.map(id=>catalog.facts.find(f=>f.id===id))}};
}

// Defense in depth for explicit prohibited claim classes, NOT a semantic verifier.
// The primary grounding is the selected closed context and the response instructions.
export function hasDisallowedProductClaim(reply) {
  if (hasInventedCapabilityRestriction(reply)) return true;
  const clauses=String(reply).split(/[.!?;\n۔؟]+|\b(?:but|however|lekin|magar)\b|لیکن|مگر/iu);
  const risk=/\b(?:other apps?|competitors?|competing apps?|better than|best|superior|unmatched|unrivalled|outperforms?|most advanced|only app|guarantee[sd]?|cures?|costs?|prices?|free|paid|certifi(?:ed|cation)|FDA|ISO|approved by|integrat(?:es?|ion)|syncs? with|connects? (?:to|with)|diagnos(?:e[sd]?|is)|prescrib(?:e[sd]?|ing)|insurance payments?|automatically changes?|(?:have|has|already) (?:been )?(?:opened|changed|updated|saved|completed|scheduled)|I (?:opened|changed|updated|saved|completed|scheduled))\b|[$€£]|\b(?:USD|PKR|Rs)\s*\d|دوسر.{0,12}ایپ|سب سے بہتر|ضمانت|یقینی علاج|قیمت|مفت|تصدیق شدہ سند|انضمام|تشخیص|نسخہ|کھول دیا|تبدیل کر دیا|\b(?:doosr[ei]|dusri).{0,12}apps?|sab se behtar|guarantee|qeemat|muft|tashkhees|nuskha|khol diya|tabdeel kar diya\b/iu;
  const denial=/\b(?:(?:I|we|SehatMate) (?:cannot|can't|can not|do not|does not|don't|doesn't)|not verified|not established|no evidence|without evidence|without claiming|rather than claiming|not claim|(?:main|hum|SehatMate).{0,60}(?:nahi|nahin))\b|(?:میں|ہم|SehatMate).{0,80}نہیں|تصدیق نہیں/iu;
  // Catch explicit assertions about named outside products without a brand list.
  const outsideSubject=/\b(?!SehatMate\b)[A-Z][A-Za-z0-9]*(?: [A-Z][A-Za-z0-9]*)? (?:sells?|shares?|lacks?|offers?|supports?)\b/u;
  return clauses.some(clause=>(risk.test(clause)||outsideSubject.test(clause))&&!denial.test(clause));
}

// Defense in depth for invented restrictions. Selected facts remain the primary
// authority; these guards do not infer capabilities from user phrases.
export function hasInventedCapabilityRestriction(reply) {
 return String(reply).split(/[.!?;\n]+|\b(?:but|however)\b/iu).some(t=> {
 if (/SehatMate.{0,35}(?:cannot|can't|does not|doesn't).{0,35}(?:create|make).{0,25}care plans?/iu.test(t)) return true;
 if (/\b(?:no need to|do not need to|don't need to|not required|no (?:provider|admin).{0,20}(?:approval|permission))\b/iu.test(t)) return false;
 return /(?:contact|ask|requires?|need|only).{0,65}(?:care provider|administrator|admin\b)|(?:requires?|need).{0,45}(?:authorized access|admin permission)|(?:I|we).{0,15}(?:can only|only help|limited to).{0,45}(?:screen|page)|(?:provider|administrator).{0,35}(?:permission|required)|(?:provider|admin).{0,40}(?:ijazat|rabta|zaroor)|(?:اجازت|رابطہ).{0,40}(?:منتظم|معالج)/iu.test(t);
 });
}
export function hasUnreceiptedMemoryClaim(reply) {
 const clauses=String(reply).split(/[.!?;\n۔؟]+|\b(?:but|however|lekin|magar)\b/iu);
 return clauses.some(t => !/\b(?:not|never|cannot|can't|could not|couldn't|nahi|nahin)\b|نہیں/iu.test(t) &&
   /\bI(?:['’]ve| have|['’]ll| will)?\s+(?:(?:already|now)\s+)?(?:noted|saved|stored|remember(?:ed)?|added.{0,30}memory)\b|(?:name|preference|memory).{0,40}(?:has been|is now)\s+(?:saved|stored|noted)|\b(?:main|maine|mein ne|hum).{0,65}(?:yaad rakh|save kar|note kar)|(?:میں نے|میں).{0,60}(?:یاد رکھ|محفوظ کر|نوٹ کر)|(?:aap ka naam|memory|yaaddasht).{0,60}(?:save ho|yaad rakh liya|note ho)|(?:نام|یادداشت).{0,60}(?:محفوظ ہو|یاد رکھ لیا|نوٹ ہو)/iu.test(t));
}
export function agentAppNameClarification(language,specific=false) {
 const texts=specific
 ? {en:'Do you mean the name of your care plan?',roman_ur:'Kya aap apne care plan ka naam keh rahe hain?',ur:'کیا آپ اپنے کیئر پلان کا نام کہہ رہے ہیں؟'}
 : {en:'Which name or item in SehatMate do you mean?',roman_ur:'SehatMate mein aap kis naam ya cheez ki baat kar rahe hain?',ur:'SehatMate میں آپ کس نام یا چیز کی بات کر رہے ہیں؟'};
 return texts[language]||texts.en;
}
