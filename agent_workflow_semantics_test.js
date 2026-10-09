import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAgentMessage} from './agent/agent_core.js';
import {buildAgentPlannerPrompts,planAgentMessage} from './agent/agent_planner.js';
import {createAgentProvider} from './agent/agent_provider.js';
import {emptyAgentSessionState} from './agent/agent_session_state.js';
import {reduceTaskWorkflow} from './agent/agent_task_workflow.js';
import {createAgentTurnService} from './services/agent_turn_service.js';
import {voiceConfiguration} from './agent/agent_voice_config.js';
process.env.AGENT_ENABLED='true';

function fixture(active=false,preferred='Roman Urdu') {
 let state={...emptyAgentSessionState(),...(active?{taskWorkflow:typeof active==='object'?active:reduceTaskWorkflow({command:{kind:'start',workflowKind:'create_care_plan'}}).workflow}:{})};
 const pool={async execute(sql,args) {
  if(sql.includes('SELECT preferred_language'))return [[{preferred_language:preferred}]];
  if(sql.includes('SELECT')&&sql.includes('FROM agent_sessions'))return [[{id:501,user_id:42,state_json:JSON.stringify(state),language:'roman_ur',expires_at:'2999-01-01'}]];
  if(sql.includes('UPDATE agent_sessions')){if(sql.includes('state_json = ?'))state=JSON.parse(args[0]);return [{affectedRows:1}];}
  if(sql.includes('agent_copilot_contexts')||sql.includes('agent_memory')||sql.includes('family_relationships'))return [[]];
  throw Error('Unexpected workflow regression query');
 }};
 return {pool,state:()=>state};
}
const task={category:'task_workflow',intent:'create_care_plan',capabilityCalls:[],taskCommand:{kind:'start',workflowKind:'create_care_plan'}};
for(const message of ['care plan banane main madad kro','create a care plan','help me create a care plan'])test(`planner system contract explicitly permits creation workflow: ${message}`,async()=>{
 const f=fixture();
 const provider=createAgentProvider({generateJson:async({systemPrompt,userPrompt})=>{
  assert.match(systemPrompt,/taskCommand/);
  assert.match(systemPrompt,/task_workflow/);
  assert.doesNotMatch(systemPrompt,/Output exactly this JSON shape/);
  assert.match(userPrompt,/creation.*app_help|app_help.*creation/i);
  return {json:task};
 }});
 const result=await handleAgentMessage({pool:f.pool,userId:'42',sessionId:'501',message,provider});
 assert.equal(result.taskWorkflow?.status,'collecting',result.fallbackCode);
 assert.equal(result.taskWorkflow?.awaitingField,'title');assert.equal(result.language,'roman_ur');
 assert.match(result.reply,/naam/i);assert.equal(result.confirmation,null);
});

test('English profile starts title collection with an English response',async()=>{
 const f=fixture(false,'English');
 const result=await handleAgentMessage({pool:f.pool,userId:'42',sessionId:'501',message:'help me create a care plan',
  provider:createAgentProvider({generateJson:async()=>({json:task})})});
 assert.equal(result.language,'en');assert.equal(result.taskWorkflow.awaitingField,'title');
 assert.equal(result.reply,'What name should I give the care plan?');
});

test('collection acknowledgement cannot consume an outstanding confirmation',async()=>{
 const current=reduceTaskWorkflow({current:reduceTaskWorkflow({command:{kind:'start',workflowKind:'create_care_plan'}}).workflow,
  command:{kind:'update',fieldSpans:{title:{start:0,end:7}}},message:'My Plan'}).workflow;
 const f=fixture(current);
 const result=await handleAgentMessage({pool:f.pool,userId:'42',sessionId:'501',message:'main batata jaunga tum likhte jao',
  provider:createAgentProvider({generateJson:async()=>({json:{category:'conversation',intent:'collection_acknowledgement',capabilityCalls:[]}})})});
 assert.equal(result.taskWorkflow.status,'awaiting_confirmation');
 assert.equal(result.confirmation.confirmationId,current.confirmationId);
 assert.equal(result.actionStatus,'awaiting_confirmation');assert.equal(result.navigation,null);
 assert.doesNotMatch(result.reply,/acknowledg|category|classif/i);
});

test('display rendering never replaces the original title span or grants confirmation',async()=>{
 const f=fixture(true),message='نام علی';
 const result=await handleAgentMessage({pool:f.pool,userId:'42',sessionId:'501',message,
  provider:createAgentProvider({generateJson:async()=>({json:{category:'task_workflow',intent:'set_title',capabilityCalls:[],
   taskCommand:{kind:'update',fieldSpans:{title:{start:4,end:7}}},displayTranscript:'Naam Ali'}})})});
 assert.equal(result.displayTranscript,'Naam Ali');assert.equal(result.taskWorkflow.fields.title,'علی');
 assert.equal(result.taskWorkflow.status,'awaiting_confirmation');assert.ok(result.confirmation);
 assert.equal(result.navigation,null);
});

test('display rendering survives encrypted voice receipt restart and idempotent recovery',async()=>{
 const receipts=new Map();let calls=0;
 const session={id:'voice-test',userId:'42',agentSessionId:'501',status:'active',epoch:1,activeTurnId:null,
  expiresAt:new Date(Date.now()+3600000).toISOString(),lastActiveAt:new Date().toISOString()};
 const store={transaction:async(_user,fn)=>fn(store),getReceipt:async(_id,turn)=>receipts.get(turn),
  saveReceipt:async r=>receipts.set(r.turnId,structuredClone(r)),listSessions:async()=>[session],
  saveSession:async s=>Object.assign(session,s),acquireAgentLock:async()=>async()=>{}};
 const sessions={owned:async()=>session,active:async s=>s};
 const receiptKey=Buffer.alloc(32,7).toString('base64');
 const config={...voiceConfiguration({}),enabled:true,idleSeconds:3600,receiptTtlSeconds:3600,turnTimeoutSeconds:30};
 const create=()=>createAgentTurnService({store,sessions,config,receiptKey,handleAgent:async args=>{
  calls++;assert.equal(args.message,'کیئر پلان بنانے میں مدد کرو');
  return {ok:true,sessionId:'501',language:'roman_ur',reply:'Care plan ka naam kya rakhoon?',displayTranscript:'Care plan banane mein madad karo'};
 }});
 const args={userId:'42',id:session.id,input:{epoch:1,turnId:'transcript-test',message:'کیئر پلان بنانے میں مدد کرو'}};
 const first=await create().submit(args),replayed=await create().submit(args);
 const recovered=await create().receipt({userId:'42',id:session.id,turnId:args.input.turnId});
 assert.equal(calls,1);assert.equal(first.status,'completed');
 assert.deepEqual(replayed.result,first.result);assert.deepEqual(recovered.result,first.result);
 assert.equal(recovered.result.displayTranscript,'Care plan banane mein madad karo');
 assert.doesNotMatch(JSON.stringify([...receipts.values()]),/Care plan banane|کیئر/);
});
test('active workflow acknowledgement remains collecting and never calls generic reply generation',async()=>{
 const f=fixture(true),original=f.state().taskWorkflow;
 const message='main batata jaunga tum likhte jao';let calls=0;
 const provider=createAgentProvider({generateJson:async({userPrompt})=>{
  calls++;assert.equal(calls,1,'generic reply generation must not run for an active workflow acknowledgement');
  assert.ok(userPrompt.includes(JSON.stringify(original)));
  return {json:{category:'conversation',intent:'acknowledgement',capabilityCalls:[]}};
 }});
 const result=await handleAgentMessage({pool:f.pool,userId:'42',sessionId:'501',message,provider});
 assert.equal(result.fallbackCode,undefined);assert.equal(result.taskWorkflow.workflowId,original.workflowId);
 assert.equal(result.taskWorkflow.status,'collecting');assert.equal(result.taskWorkflow.awaitingField,'title');
 assert.match(result.reply,/Theek hai.*batate.*naam/i);assert.doesNotMatch(result.reply,/acknowledg|category|classif/i);
 assert.equal(result.language,'roman_ur');assert.equal(calls,1);
});
test('Roman Urdu presentation travels with the actual workflow response while raw Urdu remains field input',async()=>{
 const f=fixture(),message='کیئر پلان بنانے میں مدد کرو';
 const displayTranscript='Care plan banane mein madad karo';
 const provider=createAgentProvider({generateJson:async()=>({json:{...task,displayTranscript}})});
 const result=await handleAgentMessage({pool:f.pool,userId:'42',sessionId:'501',message,voiceReply:true,provider});
 assert.equal(result.taskWorkflow?.status,'collecting',result.fallbackCode);
 assert.equal(result.displayTranscript,displayTranscript);assert.equal(result.language,'roman_ur');
 assert.doesNotMatch(result.reply,/[\u0621-\u064a\u0671-\u06d3]/u);
});
test('display-only transliteration retains Latin medicine tokens and exact numeric timing',async()=>{
 const message='میں Panadol 500 mg صبح 08:30 لیتا ہوں';
 const displayTranscript='Main Panadol 500 mg subah 08:30 leta hoon';
 const result=await planAgentMessage({message,contextSlice:{language:'roman_ur'},provider:createAgentProvider({generateJson:async()=>({json:{category:'conversation',intent:'routine_explanation',capabilityCalls:[],displayTranscript}})})});
 assert.equal(result.ok,true,result.code);assert.equal(result.plan.displayTranscript,displayTranscript);
});
test('invalid presentation is discarded without modifying the validated action or raw message',async()=>{
 const message='میں Panadol 500 mg صبح 08:30 لیتا ہوں';
 for(const displayTranscript of ['Main Panadol 50 mg subah 08:30 leta hoon','Main OtherDrug 500 mg subah 08:30 leta hoon','میں Panadol 500 mg صبح 08:30 لیتا ہوں']) {
  const result=await planAgentMessage({message,contextSlice:{language:'roman_ur'},provider:createAgentProvider({generateJson:async()=>({json:{category:'conversation',intent:'routine_explanation',capabilityCalls:[],displayTranscript}})})});
  assert.equal(result.ok,true,result.code);assert.equal(result.plan.displayTranscript,undefined);
 }
});

test('a bounded planner prefix cannot be presented as the entire longer ASR message',async()=>{
 const f=fixture(),message='کیئر '.repeat(450);
 const result=await handleAgentMessage({pool:f.pool,userId:'42',sessionId:'501',message,
  provider:createAgentProvider({generateJson:async()=>({json:{...task,displayTranscript:'Care plan'}})})});
 assert.equal(result.ok,true);assert.equal(result.taskWorkflow.awaitingField,'title');
 assert.equal(result.displayTranscript,undefined);
});
