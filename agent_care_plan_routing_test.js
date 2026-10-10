import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAgentMessage} from './agent/agent_core.js';
import {createAgentProvider} from './agent/agent_provider.js';
import {validateAgentPlan} from './agent/agent_planner.js';
import {emptyAgentSessionState} from './agent/agent_session_state.js';
import {reduceTaskWorkflow} from './agent/agent_task_workflow.js';
process.env.AGENT_ENABLED='true';

// Only the external model and database are doubled. Routing, validation, owned
// session handling and workflow/title reduction run through the real Agent.
function fixture(extra={},language='English') {
 let state={...emptyAgentSessionState(),...extra};const writes=[];
 const pool={async execute(sql,args) {
  if(sql.includes('SELECT preferred_language'))return [[{preferred_language:language}]];
  if(sql.includes('SELECT')&&sql.includes('FROM agent_sessions'))return [[{id:501,user_id:42,state_json:JSON.stringify(state),language:'en',expires_at:'2999-01-01'}]];
  if(sql.includes('UPDATE agent_sessions')){if(sql.includes('state_json = ?'))state=JSON.parse(args[0]);return [{affectedRows:1}];}
  if(sql.includes('FROM care_plans'))return [[{id:args[0],user_id:42,title:'Care',status:'draft',setup_step:'reality_check'}]];
  if(sql.includes('agent_copilot_contexts')||sql.includes('agent_memory')||sql.includes('family_relationships'))return [[]];
  if(sql.startsWith('INSERT')){writes.push(sql);return [{insertId:1}];}
  throw Error('Unexpected routing test query');
 }};
 return {pool,state:()=>state,writes};
}
const createIntent={category:'action',intent:'create_care_plan',capabilityCalls:[],navigationIntent:null};
const start={category:'task_workflow',intent:'create_care_plan',capabilityCalls:[],taskCommand:{kind:'start',workflowKind:'create_care_plan'}};
async function run(f,message,plan=createIntent) {
 let requests=0;
 const provider=createAgentProvider({generateJson:async()=>{requests++;return {json:plan};}});
 const result=await handleAgentMessage({pool:f.pool,userId:'42',sessionId:'501',message,voiceReply:true,provider});
 return {result,requests};
}

for(const category of ['task_workflow','conversation','ambiguous'])test(`current canonical creation normalizes ${category} without a second classifier`,async()=>{
 const {result,requests}=await run(fixture(),'help me put together a care plan',{...createIntent,category});
 assert.equal(result.taskWorkflow?.awaitingField,'title');assert.equal(requests,1);
});

for(const message of ["let's make a care plan",'i want to make a new care plan','create a care plan',
 'help me create a care plan','start a new care plan','make a care plan','create a new care plan',
 'help me make a care plan','Could we put together a fresh care plan?']) {
 test(`current semantic creation enters workflow and consumes title: ${message}`,async()=>{
  const f=fixture();const {result,requests}=await run(f,message);
  assert.equal(result.taskWorkflow?.status,'collecting',result.fallbackCode);
  assert.equal(result.taskWorkflow.awaitingField,'title');assert.equal(result.reply,'What name should I give the care plan?');
  assert.equal(result.confirmation,null);assert.equal(result.uiPlan,undefined);assert.equal(result.clarification,null);
  assert.equal(requests,1,'no generic reply or planning repair for a canonical creation intent');
  const next=await run(f,'Morning Routine',{category:'ambiguous',intent:'uncertain',capabilityCalls:[]});
  assert.equal(next.result.taskWorkflow.fields.title,'Morning Routine');
  assert.equal(next.result.taskWorkflow.status,'awaiting_confirmation');assert.equal(next.requests,1);
  assert.ok(next.result.confirmation);assert.equal(f.writes.length,0,'no business creation without confirmation');
 });
}

test('fresh creation outranks unrelated ambiguous entity context without losing session memory',async()=>{
 const f=fixture({lastReferencedEntities:[{type:'care_plan',id:'7'},{type:'care_plan',id:'8'}],lastActionSummary:'reality_check',lastIntent:'reality_check'});
 const {result}=await run(f,"let's make a care plan",start);
 assert.equal(result.taskWorkflow?.awaitingField,'title',result.fallbackCode);
 assert.equal(result.confirmation,null);assert.equal(result.uiPlan,undefined);
 assert.equal(f.state().lastIntent,'reality_check');assert.equal(f.state().lastReferencedEntities.length,2);
 assert.equal(f.state().pendingClarification,null);
});

test('explicit start keeps an already empty creation collection and preserves other memory',async()=>{
 const taskWorkflow=reduceTaskWorkflow({command:start.taskCommand}).workflow;
 const f=fixture({taskWorkflow,lastActionSummary:'earlier_reality_check'});
 const {result}=await run(f,'i want to make a new care plan',start);
 assert.equal(result.taskWorkflow.status,'collecting');assert.equal(result.taskWorkflow.workflowId,taskWorkflow.workflowId);
 assert.deepEqual(result.taskWorkflow.fields,{});assert.equal(f.state().lastActionSummary,'earlier_reality_check');
});

test('unresolved consequential task confirmation is not superseded by a new creation request',async()=>{
 const taskWorkflow=reduceTaskWorkflow({command:{...start.taskCommand,fieldSpans:{title:{start:0,end:8}}},message:'Old Plan'}).workflow;
 const f=fixture({taskWorkflow});const {result}=await run(f,'make a new care plan',start);
 assert.equal(result.taskWorkflow.confirmationId,taskWorkflow.confirmationId);
 assert.equal(result.taskWorkflow.fields.title,'Old Plan');assert.equal(result.actionStatus,'awaiting_confirmation');
 assert.equal(result.navigation,null);assert.deepEqual(f.state().taskWorkflow,taskWorkflow);
 assert.equal(f.writes.length,0);
});

test('unresolved legacy draft confirmation blocks new creation and leaves both draft and session intact',async()=>{
 const expiresAt='2999-01-01T00:00:00Z';
 const pendingDraft={confirmationId:'old-confirm',kind:'task_outcome',toolName:'draft_task_outcome',message:'Mark care task completed?',expiresAt,
  occurrenceId:'11',outcome:'completed',note:'',baseStatus:'pending',targetLabel:'Care task'};
 const pendingConfirmation={confirmationId:'old-confirm',kind:'task_outcome',message:pendingDraft.message,expiresAt};
 const f=fixture({pendingDraft,pendingConfirmation});const {result}=await run(f,'make a new care plan',start);
 assert.equal(result.confirmation?.confirmationId,'old-confirm');assert.equal(result.actionStatus,'awaiting_confirmation');
 assert.equal(result.taskWorkflow,undefined);assert.deepEqual(f.state().pendingDraft,pendingDraft);assert.equal(f.writes.length,0);
});

test('creation stays in selected Roman Urdu with no Reality Check proposal',async()=>{
 const {result}=await run(fixture({},'Roman Urdu'),'care plan banana shuru karte hain');
 assert.equal(result.language,'roman_ur');assert.equal(result.reply,'Care plan ka naam kya rakhoon?');
 assert.equal(result.taskWorkflow.awaitingField,'title');assert.equal(result.uiPlan,undefined);
});

test('semantic normalization never drops competing operations or accepts unknown schema',()=>{
 assert.equal(validateAgentPlan(createIntent,{requireCategory:true}).ok,true);
 for(const raw of [{...createIntent,privateField:'bad'},
  {...createIntent,capabilityCalls:[{name:'get_care_plans',args:{}}]},
  {...createIntent,navigationIntent:{target:'reality_check',params:{carePlanId:'7'}}},
  {...createIntent,uiOperations:[{actionId:'next',targetId:'question',args:{}}]},
  {...createIntent,taskCommand:{kind:'cancel'}}])assert.equal(validateAgentPlan(raw,{requireCategory:true}).ok,false);
});

test('Reality Check screen context cannot replace explicit creation with saving or advancing',async()=>{
 const f=fixture();
 const clientContext={screenId:'reality_check',ui:{screenId:'reality_check',route:'reality_check',version:'screen:1',entities:[],
  targets:[{id:'question',kind:'question',label:'Current Reality Check question'},{id:'next',kind:'button',label:'Save answers and continue'}],
  actions:[{id:'reality.next',kind:'next',targetId:'next'}]}};
 const provider=createAgentProvider({generateJson:async()=>({json:start})});
 const result=await handleAgentMessage({pool:f.pool,userId:'42',sessionId:'501',message:'make a new care plan',clientContext,voiceReply:true,provider});
 assert.equal(result.taskWorkflow?.awaitingField,'title',result.code);
 assert.equal(result.confirmation,null);assert.equal(result.uiPlan,undefined);assert.equal(f.writes.length,0);
});

test('ordinary explanation and genuine ambiguity are not converted to creation by old state',()=>{
 for(const intent of ['explain_care_plan','clarify_care_plan','cancel_care_plan']) {
  const result=validateAgentPlan({category:'conversation',intent,capabilityCalls:[]},{requireCategory:true});
  assert.equal(result.ok,true);assert.equal(result.plan.taskCommand,undefined);
 }
});

test('invalid one/81-codepoint titles never cause creation after semantic start',async()=>{
 for(const title of ['A','x'.repeat(81)]) {
  const f=fixture();await run(f,'start a new care plan',start);
  const plan={category:'task_workflow',intent:'supply_title',capabilityCalls:[],taskCommand:{kind:'update',fieldSpans:{title:{start:0,end:title.length}}}};
  const {result}=await run(f,title,plan);assert.equal(result.taskWorkflow.status,'collecting');
  assert.equal(result.confirmation,null);assert.equal(f.writes.length,0);
 }
});
