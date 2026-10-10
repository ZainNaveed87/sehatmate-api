import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAgentMessage} from './agent/agent_core.js';
import {createAgentProvider} from './agent/agent_provider.js';
import {emptyAgentSessionState,sanitizeAgentSessionState} from './agent/agent_session_state.js';
import {reduceTaskWorkflow} from './agent/agent_task_workflow.js';
import {validateAgentPlan} from './agent/agent_planner.js';
process.env.AGENT_ENABLED='true';
function fixture(active=false,preferred='Roman Urdu',ui=null) {
 let state={...emptyAgentSessionState(),...(active?{taskWorkflow:typeof active==='object'?active:reduceTaskWorkflow({command:{kind:'start',workflowKind:'create_care_plan'}}).workflow}:{})};
 const plans=[];const pool={async execute(sql,args) {
  if(sql.includes('SELECT preferred_language'))return [[{preferred_language:preferred}]];
  if(sql.includes('SELECT')&&sql.includes('FROM agent_sessions'))return [[{id:501,user_id:42,state_json:JSON.stringify(state),language:'roman_ur',expires_at:'2999-01-01'}]];
  if(sql.includes('UPDATE agent_sessions')){if(sql.includes('state_json = ?'))state=JSON.parse(args[0]);return [{affectedRows:1}];}
  if(sql.includes('SELECT c.context_json'))return [ui?[{context_json:JSON.stringify(ui)}]:[]];
  if(sql.includes('INSERT INTO agent_copilot_plans')){plans.push(JSON.parse(args[4]));return [{affectedRows:1}];}
  if(sql.includes('agent_copilot_contexts')||sql.includes('agent_memory')||sql.includes('family_relationships'))return [[]];
  throw Error('Unexpected workflow regression query');
 }};
 return {pool,state:()=>state,plans};
}

const start={category:'task_workflow',intent:'create_care_plan',capabilityCalls:[],taskCommand:{kind:'start',workflowKind:'create_care_plan'}};
const ambiguous={category:'ambiguous',intent:'clarify',capabilityCalls:[]};
const run=(f,message,plan=ambiguous)=>handleAgentMessage({pool:f.pool,userId:'42',sessionId:'501',message,provider:createAgentProvider({generateJson:async()=>({json:plan})})});
for(const message of ["let's make a new care plan",'care plan banane main madad kro'])test(`creation opens real care plan UI: ${message}`,async()=>{
 const f=fixture();const r=await run(f,message,start);
 assert.equal(r.taskWorkflow.awaitingField,'title');assert.equal(r.navigation.target,'care_plan_new');assert.equal(r.confirmation,null);
});
test('repeated start resumes the same workflow rather than claiming creation failed',async()=>{
 const f=fixture(true),id=f.state().taskWorkflow.workflowId;const r=await run(f,'create a new care plan',start);
 assert.equal(r.fallbackCode,undefined);assert.equal(r.taskWorkflow.workflowId,id);assert.equal(r.taskWorkflow.awaitingField,'title');
});
for(const [message,title] of [['naya pakistan','naya pakistan'],['my health plan','my health plan'],['diabetes routine','diabetes routine'],['the name is naya pakistan','naya pakistan'],['if the name of care plan is naya pakistan','naya pakistan']])test(`unique title slot beats generic clarification: ${message}`,async()=>{
 const f=fixture(true);const r=await run(f,message);
 assert.equal(r.taskWorkflow.status,'awaiting_confirmation');assert.equal(r.taskWorkflow.fields.title,title);assert.ok(r.confirmation);assert.equal(r.taskWorkflow.completedReceipt,undefined);assert.equal(r.navigation,null);
 assert.equal(f.state().taskWorkflow.fields.title,title);
});
test('continuation does not become a title or generic clarification',async()=>{
 const f=fixture(true);const r=await run(f,'main batata jaunga tum likhte jao',{category:'conversation',intent:'collection_acknowledgement',capabilityCalls:[],taskInput:'continuation'});
 assert.equal(r.taskWorkflow.status,'collecting');assert.match(r.reply,/naam/);assert.equal(r.fallbackCode,undefined);
});
test('explicit workflow cancellation retains safety',async()=>{
 const r=await run(fixture(true),'cancel',{category:'task_workflow',intent:'cancel',capabilityCalls:[],taskCommand:{kind:'cancel'}});assert.equal(r.taskWorkflow.status,'cancelled');assert.equal(r.confirmation,null);
});
test('title validation remains bounded',async()=>{
 const f=fixture(true);const r=await run(f,'a'.repeat(81));assert.equal(r.taskWorkflow.status,'collecting');assert.equal(r.confirmation,null);
});
for(const language of ['en','ur','roman_ur'])test(`closed conversation language command: ${language}`,async()=>{
 const f=fixture(false,'English');const r=await run(f,'switch conversational language',{category:'conversation',intent:'language_change',capabilityCalls:[],languageCommand:{scope:'conversation',language}});
 assert.equal(r.language,language);assert.equal(r.conversationLanguage,language);assert.equal(f.state().conversationLanguage.language,language);assert.equal(r.uiPlan,undefined);
 const next=await run(f,'naya pakistan',start);assert.equal(next.language,language);
});
test('closed language command rejects injected arguments and mixed actions',()=>{
 for(const languageCommand of [{scope:'app',language:'paid'},{scope:'conversation',language:'ur',userId:'42'},{scope:'app',language:null,options:['ur','ur']}])assert.equal(validateAgentPlan({category:'conversation',intent:'language_change',capabilityCalls:[],languageCommand}).ok,false);
});
test('language question survives sanitization and does not accept binary yes for two options',async()=>{
 const f=fixture(false,'English');const r=await run(f,'change the app language',{category:'conversation',intent:'language_choice',capabilityCalls:[],languageCommand:{scope:'app',language:null,options:['ur','roman_ur']}});
 assert.match(r.reply,/Urdu.*Roman Urdu/);assert.equal(f.state().languageQuestion.options.length,2);
 const next=await run(f,'yeah');assert.match(next.reply,/Urdu.*Roman Urdu/);assert.equal(next.fallbackCode,undefined);assert.equal(next.uiPlan,undefined);
 assert.ok(sanitizeAgentSessionState(f.state()).state.languageQuestion);
});
test('language question consumes a single selected option without generic reply',async()=>{
 const f=fixture(false,'English');await run(f,'speak another language',{category:'conversation',intent:'language_choice',capabilityCalls:[],languageCommand:{scope:'conversation',language:null,options:['ur','roman_ur']}});
 const r=await run(f,'Roman Urdu');assert.equal(r.language,'roman_ur');assert.equal(f.state().languageQuestion,undefined);
});
test('binary yes consumes a single language option',async()=>{
 const f=fixture(false,'English');await run(f,'speak Urdu?',{category:'conversation',intent:'language_choice',capabilityCalls:[],languageCommand:{scope:'conversation',language:null,options:['ur']}});
 const r=await run(f,'yeah');assert.equal(r.language,'ur');assert.equal(r.conversationLanguage,'ur');
});

const appContext={screenId:'home',ui:{screenId:'home',route:'home',version:'screen:1',entities:[],targets:[{id:'app.language',kind:'control',label:'App language',value:'en'}],actions:['en','ur','roman_ur'].map(code=>({id:`app.language.${code}`,kind:'set_language',targetId:'app.language'}))}};
for(const [message,code] of [['change app language to Roman Urdu','roman_ur'],['Roman Urdu kar do','roman_ur'],['switch to Urdu','ur'],['make the app English','en']])test(`app setting proposal uses a real closed confirmed callback: ${message}`,async()=>{
 const f=fixture(false,'English',appContext);const r=await run(f,message,{category:'conversation',intent:'language_change',capabilityCalls:[],languageCommand:{scope:'app',language:code}});
 assert.equal(r.uiPlan?.operations[0].actionId,`app.language.${code}`,r.code);assert.equal(r.uiPlan.operations[0].riskTier,2);assert.equal(f.plans.length,1);assert.equal(r.language,'en');assert.equal(f.state().conversationLanguage,undefined);
});
test('explicit app preference overrides an older session-scoped conversation selection',async()=>{
 const f=fixture(false,'English');await run(f,'speak Urdu',{category:'conversation',intent:'language_change',capabilityCalls:[],languageCommand:{scope:'conversation',language:'ur'}});
 const original=f.pool.execute;f.pool.execute=async(sql,args)=>sql.includes('SELECT preferred_language')?[[{preferred_language:'Roman Urdu'}]]:original(sql,args);
 const r=await run(f,'create a care plan',start);assert.equal(r.language,'roman_ur');
});
test('an active expected title takes priority over a previous language question',async()=>{
 const f=fixture(true);const r=await run(f,'naya pakistan');assert.equal(r.taskWorkflow.fields.title,'naya pakistan');assert.equal(r.fallbackCode,undefined);
});

test('conversation switch immediately validates visible transcript in the new Roman language',async()=>{
 const f=fixture(false,'English');const r=await run(f,'اب رومن اردو میں بات کرو',{category:'conversation',intent:'language_change',capabilityCalls:[],languageCommand:{scope:'conversation',language:'roman_ur'},displayTranscript:'Ab Roman Urdu mein baat karo'});
 assert.equal(r.language,'roman_ur');assert.equal(r.displayTranscript,'Ab Roman Urdu mein baat karo');assert.doesNotMatch(r.reply,/[\u0621-\u064a]/u);
});

test('conversation override survives ordinary replies and localized provider fallbacks',async()=>{
 const f=fixture(false,'English');await run(f,'speak Urdu',{category:'conversation',intent:'language_change',capabilityCalls:[],languageCommand:{scope:'conversation',language:'ur'}});
 const next=await run(f,'an unrelated question');assert.equal(next.language,'ur');assert.equal(f.state().conversationLanguage?.language,'ur');
 assert.equal((await run(f,'create a care plan',start)).language,'ur');
});

test('binary no cancels only the pending language question without changing settings',async()=>{
 const f=fixture(false,'English');await run(f,'speak Urdu?',{category:'conversation',intent:'language_choice',capabilityCalls:[],languageCommand:{scope:'conversation',language:null,options:['ur']}});
 const r=await run(f,'no');assert.equal(r.language,'en');assert.match(r.reply,/cancelled/);assert.equal(f.state().languageQuestion,undefined);assert.equal(f.state().conversationLanguage,undefined);
});
