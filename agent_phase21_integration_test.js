import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAgentMessage} from './agent/agent_core.js';
import {createAgentProvider} from './agent/agent_provider.js';
import {emptyAgentSessionState} from './agent/agent_session_state.js';
process.env.AGENT_ENABLED='true';

function fixture() {
 let preferred='Roman Urdu';let state=emptyAgentSessionState(),language='roman_ur',plans=[],inserts=0,tail=Promise.resolve();
 const row=()=>({id:501,user_id:42,state_json:JSON.stringify(state),language,expires_at:'2999-01-01',created_at:'2026-10-09',last_active_at:'2026-10-09'});
 const pool={async execute(sql,args){
  if(sql.includes('SELECT preferred_language'))return [[{preferred_language:preferred}]];
  if(sql.includes('SELECT')&&sql.includes('FROM agent_sessions'))return args[0]==='501'&&args[1]==='42'?[[row()]]:[[]];
  if(sql.includes('UPDATE agent_sessions')){
   if(sql.includes('state_json = ?')){if(args.length===4&&args[3]!==JSON.stringify(state))return [{affectedRows:0}];state=JSON.parse(args[0]);}
   if(sql.includes('language = ?'))language=args[0];return [{affectedRows:1}];
  }
  if(sql.includes('agent_copilot_contexts')||sql.includes('agent_memory')||sql.includes('family_relationships'))return [[]];
  throw Error('Unexpected integration mock query');
 },async getConnection(){let unlock;const before=tail;tail=new Promise(r=>unlock=r);let draftState,draftPlans;
  return {async beginTransaction(){await before;draftState=structuredClone(state);draftPlans=structuredClone(plans);},async execute(sql,args){
   if(sql.includes('FROM agent_sessions'))return args[0]==='501'&&args[1]==='42'?[[{state_json:JSON.stringify(draftState)}]]:[[]];
   if(sql.startsWith('SELECT')&&sql.includes('title_key'))return [[...draftPlans.filter(p=>p.title_key===args[1])]];
   if(sql.startsWith('INSERT INTO care_plans')){inserts++;draftPlans.push({id:inserts,user_id:args[0],title:args[1],title_key:args[2],status:'draft',setup_step:'upload'});return [{insertId:inserts}];}
   if(sql.includes('SELECT * FROM care_plans'))return [[...draftPlans.filter(p=>p.id===args[0])]];
   if(sql.includes('UPDATE agent_sessions')){draftState=JSON.parse(args[0]);return [{affectedRows:1}];}
   throw Error('Unexpected transaction query');},async commit(){state=draftState;plans=draftPlans;},async rollback(){},release(){unlock();}};
 }};
 return {pool,setLanguage:value=>{preferred=value;},plans:()=>plans,inserts:()=>inserts,state:()=>state};
}
function provider(command){return createAgentProvider({generateJson:async()=>({json:{category:'task_workflow',intent:'care_plan_workflow',capabilityCalls:[],taskCommand:command}})});}

test('actual Agent core shares title collection/correction/confirmation/replay across voice and text',async()=>{
 const f=fixture();const base={pool:f.pool,userId:'42',sessionId:'501'};
 const start=await handleAgentMessage({...base,message:'Care plan banao',voiceReply:true,provider:provider({kind:'start',workflowKind:'create_care_plan'})});
 assert.equal(start.ok,true,start.code);assert.equal(start.language,'roman_ur');assert.equal(start.taskWorkflow?.status,'collecting');assert.equal(f.inserts(),0);
 const named=await handleAgentMessage({...base,message:'Naam Zain',provider:provider({kind:'update',fieldSpans:{title:{start:5,end:9}}})});
 assert.equal(named.taskWorkflow?.fields.title,'Zain');assert.equal(f.inserts(),0);
 const corrected=await handleAgentMessage({...base,message:'Naam Ali',voiceReply:true,provider:provider({kind:'update',fieldSpans:{title:{start:5,end:8}}})});
 assert.equal(corrected.taskWorkflow?.fields.title,'Ali');assert.notEqual(corrected.confirmation.confirmationId,named.confirmation.confirmationId);
 const stale=await handleAgentMessage({...base,confirmation:{confirmationId:named.confirmation.confirmationId,decision:'confirm'}});assert.equal(stale.fallbackCode,'AGENT_TASK_STALE_CONFIRMATION');assert.equal(f.inserts(),0);
 const input={...base,voiceReply:true,confirmation:{confirmationId:corrected.confirmation.confirmationId,decision:'confirm'}};
 const created=await handleAgentMessage(input);assert.equal(created.actionStatus,'confirmed');assert.equal(created.navigation.target,'care_plan_upload');assert.equal(f.plans().length,1);
 const replay=await handleAgentMessage({...input,voiceReply:true});assert.equal(replay.navigation.params.carePlanId,created.navigation.params.carePlanId);assert.equal(f.inserts(),1);
 const lateCancel=await handleAgentMessage({...input,confirmation:{...input.confirmation,decision:'cancel'}});assert.equal(lateCancel.fallbackCode,'AGENT_TASK_STALE_CONFIRMATION');assert.equal(f.state().taskWorkflow.status,'completed');
 const repeated=await handleAgentMessage({...base,message:'haan'});assert.equal(repeated.fallbackCode,'AGENT_CONFIRMATION_NOT_FOUND');assert.equal(f.inserts(),1);
 const foreign=await handleAgentMessage({...input,userId:'77'});assert.equal(foreign.code,'AGENT_SESSION_NOT_FOUND');assert.equal(f.inserts(),1);
});

for(const phrase of ['haan','yes','confirm karo']) test(`text workflow -> voice title -> explicit ${phrase} confirms once across language switch`,async()=>{
 const f=fixture(),base={pool:f.pool,userId:'42',sessionId:'501'};
 const start=await handleAgentMessage({...base,message:'Create care plan',provider:provider({kind:'start',workflowKind:'create_care_plan'})});
 assert.equal(start.taskWorkflow.status,'collecting');
 const named=await handleAgentMessage({...base,message:'Naam Ali',voiceReply:true,provider:provider({kind:'update',fieldSpans:{title:{start:5,end:8}}})});
 const confirmationId=named.confirmation.confirmationId;f.setLanguage('English');
 const confirmed=await handleAgentMessage({...base,message:phrase});
 assert.equal(confirmed.actionStatus,'confirmed');assert.equal(confirmed.language,'en');assert.equal(confirmed.taskWorkflow.completedReceipt.confirmationId,confirmationId);assert.equal(f.inserts(),1);
 const replay=await handleAgentMessage({...base,voiceReply:true,confirmation:{confirmationId,decision:'confirm'}});
 assert.equal(replay.actionStatus,'confirmed');assert.equal(f.inserts(),1);
});
