import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAgentMessage} from './agent/agent_core.js';
import {createAgentProvider} from './agent/agent_provider.js';
import {emptyAgentSessionState} from './agent/agent_session_state.js';
import {reduceTaskWorkflow} from './agent/agent_task_workflow.js';
process.env.AGENT_ENABLED='true';

// Agent routing/reduction/transaction code is real; only DB and model IO are doubled.
function fixture(language='English',pending=true) {
 const workflow=reduceTaskWorkflow({command:{kind:'start',workflowKind:'create_care_plan',fieldSpans:{title:{start:0,end:7}}},message:'My Plan'}).workflow;
 let state={...emptyAgentSessionState(),...(pending?{taskWorkflow:workflow}:{})},plans=[],inserts=0,tail=Promise.resolve();
 const pool={async execute(sql,args) {
  if(sql.includes('SELECT preferred_language'))return [[{preferred_language:language}]];
  if(sql.includes('SELECT')&&sql.includes('FROM agent_sessions'))return [[{id:501,user_id:42,state_json:JSON.stringify(state),language:'en',expires_at:'2999-01-01'}]];
  if(sql.includes('UPDATE agent_sessions')){if(sql.includes('state_json = ?'))state=JSON.parse(args[0]);return [{affectedRows:1}];}
  if(sql.includes('agent_copilot_contexts')||sql.includes('agent_memory')||sql.includes('family_relationships'))return [[]];
  if(sql.startsWith('INSERT'))return [{insertId:1}];
  throw Error('Unexpected guided confirmation query');
 },async getConnection(){
  let release;const before=tail;tail=new Promise(r=>release=r);let draftState,draftPlans;
  return {async beginTransaction(){await before;draftState=structuredClone(state);draftPlans=structuredClone(plans);},async execute(sql,args){
   if(sql.includes('FROM agent_sessions'))return [[{state_json:JSON.stringify(draftState)}]];
   if(sql.includes('title_key')){if(sql.startsWith('SELECT'))return [[...draftPlans.filter(p=>p.title_key===args[1])]];inserts++;draftPlans.push({id:inserts,user_id:args[0],title:args[1],title_key:args[2],status:'draft',setup_step:'upload'});return [{insertId:inserts}];}
   if(sql.includes('SELECT * FROM care_plans'))return [[...draftPlans.filter(p=>p.id===args[0])]];
   if(sql.includes('UPDATE agent_sessions')){draftState=JSON.parse(args[0]);return [{affectedRows:1}];}
   throw Error('Unexpected guided transaction query');
  },async commit(){state=draftState;plans=draftPlans;},async rollback(){},release(){release();}};
 }};
 return {pool,workflow,state:()=>state,inserts:()=>inserts};
}
for(const language of ['English','Roman Urdu'])for(const message of ['confirm','yes','create it','cancel','no']) {
 test(`${language}: pending guided voice ${message} bypasses general planning`,async()=>{
  const f=fixture(language);let calls=0;
  const provider=createAgentProvider({generateJson:async()=>{calls++;return {json:{category:'conversation',intent:'acknowledge',capabilityCalls:[]}};}});
  const r=await handleAgentMessage({pool:f.pool,userId:'42',sessionId:'501',message,voiceReply:true,provider});
  assert.equal(calls,0);assert.equal(r.ok,true);
  const cancelled=['cancel','no'].includes(message);
  assert.equal(r.actionStatus,cancelled?'cancelled':'confirmed');
  assert.equal(r.taskWorkflow.workflowId,f.workflow.workflowId);assert.equal(r.confirmation,null);
  assert.equal(f.inserts(),cancelled?0:1);assert.equal(r.language,language==='English'?'en':'roman_ur');
  if(language==='Roman Urdu')assert.doesNotMatch(r.reply,/[\u0600-\u06ff]/u);
 });
}
test('spoken and explicit button confirmations share one owned transaction and replay',async()=>{
 const f=fixture();const provider=createAgentProvider({generateJson:async()=>{throw Error('Planner must not run');}});
 const args={pool:f.pool,userId:'42',sessionId:'501',provider};
 const spoken=await handleAgentMessage({...args,message:'yes',voiceReply:true});
 const replayed=await handleAgentMessage({...args,confirmation:{confirmationId:f.workflow.confirmationId,decision:'confirm'}});
 assert.equal(spoken.actionStatus,'confirmed');assert.equal(replayed.actionStatus,'confirmed');
 assert.equal(spoken.taskWorkflow.planId,replayed.taskWorkflow.planId);
 assert.deepEqual(spoken.taskWorkflow.completedReceipt,replayed.taskWorkflow.completedReceipt);assert.equal(f.inserts(),1);
});
test('create it with no pending care-plan confirmation never grants a transaction',async()=>{
 const f=fixture('English',false);let calls=0;
 const r=await handleAgentMessage({pool:f.pool,userId:'42',sessionId:'501',message:'create it',voiceReply:true,
  provider:createAgentProvider({generateJson:async()=>{calls++;return {json:{category:'conversation',intent:'chat',capabilityCalls:[],reply:'Please specify what you mean.'}};}})});
 assert.equal(f.inserts(),0);assert.notEqual(r.actionStatus,'confirmed');assert.ok(calls>0);
});
