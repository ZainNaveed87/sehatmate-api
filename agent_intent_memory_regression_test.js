import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAgentMessage} from './agent/agent_core.js';
import {validateAgentPlan,planAgentMessage} from './agent/agent_planner.js';
import {createAgentProvider} from './agent/agent_provider.js';
import {emptyAgentSessionState} from './agent/agent_session_state.js';
import {CopilotTestDb} from './agent_copilot_test_db.js';
import {createAgentMemory} from './agent/agent_memory.js';
import {agentMemoryFailureReason,logAgentPlanOutput,logAgentPlanFailure,logAgentMemoryWriteFailure} from './agent/agent_diagnostics.js';
process.env.AGENT_ENABLED='true';

// Real orchestration and guards; only model/SQL boundaries are doubled. These
// tests do not claim that a live model classified the supplied utterances.
class Database extends CopilotTestDb {
 constructor(){super();this.state=emptyAgentSessionState();this.language='English';}
 async execute(sql,args=[]) {
  sql=sql.replace(/\s+/g,' ').trim();
  if(this.failure?.match(sql))throw Object.assign(new Error('PRIVATE_SQL_BODY'),{code:this.failure.code});
  if(sql.includes('SELECT preferred_language'))return [[{preferred_language:this.language}]];
  if(sql.startsWith('SELECT id, user_id')&&sql.includes('FROM agent_sessions'))return [[{id:11,user_id:1,language:'en',state_json:JSON.stringify(this.state),expires_at:'2099-01-01'}]];
  if(sql.startsWith('UPDATE agent_sessions')){if(sql.includes('state_json = ?'))this.state=JSON.parse(args[0]);return [{affectedRows:1}];}
  if(/agent_memory|agent_copilot_|SELECT id FROM users|SELECT id FROM agent_sessions/.test(sql))return super.execute(sql,args);
  if(sql.startsWith('SELECT'))return [[]];
  if(sql.startsWith('INSERT'))return [{insertId:1,affectedRows:1}];
  throw new Error('Unexpected regression test query');
 }
 async getConnection(){return {execute:this.execute.bind(this),beginTransaction:this.beginTransaction.bind(this),
  commit:async()=>{if(this.commitError)throw Object.assign(new Error('PRIVATE_COMMIT_BODY'),{code:this.commitError});await this.commit();},
  rollback:this.rollback.bind(this),release:()=>{}};}
}
const creation={category:'action',intent:'create_care_plan',capabilityCalls:[],navigationIntent:null};
function model(plan,reply='A supported explanation.') {
 const requests=[];
 return {requests,provider:createAgentProvider({generateJson:async args=>{requests.push(args);return {json:args.systemPrompt.includes('planning stage')?plan:{messageTemplate:reply}};}})};
}
async function run(plan,message,reply,db=new Database()) {
 const m=model(plan,reply);
 const result=await handleAgentMessage({pool:db,userId:'1',sessionId:'11',message,provider:m.provider,clientContext:{screenId:'care_plan_upload'}});
 return {result,db,...m};
}
async function capture(work) {
 const events=[];const original=console.info;console.info=(...args)=>events.push(args.join(' '));
 try{return {...await work(),events};}finally{console.info=original;}
}
for(const message of ["let's make a care plan",'create a care plan','create a new care plan','start a care plan','I want to make a new care plan','help me create a care plan']) {
 test(`canonical semantic creation collects title without write/receipt: ${message}`,async()=>{
  const {result,requests,db}=await capture(()=>run(creation,message));
  assert.equal(result.reply,'What name should I give the care plan?');
  assert.equal(result.taskWorkflow.awaitingField,'title');assert.equal(result.taskWorkflow.status,'collecting');
  assert.equal(result.confirmation,null);assert.equal(requests.length,1);
  assert.equal(db.calls.some(c=>/INSERT INTO (?:care_plans|agent_memory)/.test(c.sql)),false);
 });
}
test('receipt rejection remains honest and does not reclassify clear conversation as ambiguity',async()=>{
 const {result,events,requests}=await capture(()=>run({category:'conversation',intent:'care_plan_help',capabilityCalls:[]},'Tell me about supported care-plan creation','I have created your care plan.'));
 assert.equal(result.fallbackCode,'AGENT_ACTION_RECEIPT_REQUIRED');
 assert.notEqual(result.reply,'Could you clarify which part you mean?');
 assert.doesNotMatch(result.reply,/I have created/);assert.equal(requests.length,3);
 assert.ok(events.includes('AGENT_ROUTE:REPLY_REJECTED'));
 assert.ok(events.includes('AGENT_REPLY_FAILURE:ACTION_RECEIPT'));
});
test('invalid provider schema is a planning failure, not evidence that the request was ambiguous',async()=>{
 const {result,events,requests}=await capture(()=>run({...creation,PRIVATE_FIELD:'PRIVATE_VALUE'},"let's make a care plan"));
 assert.equal(result.fallbackCode,'AGENT_PLAN_INVALID');assert.equal(requests.length,2);
 assert.notEqual(result.reply,'Could you clarify which part you mean?');
 assert.ok(events.includes('AGENT_PLAN_REJECTED:UNKNOWN_FIELD'));
 assert.equal(events.some(e=>e.includes('PRIVATE_')),false);
 assert.equal(result.taskWorkflow,undefined);
});
test('genuine semantic ambiguity still asks a clarification',async()=>{
 const {result}=await run({category:'ambiguous',intent:'clarify',capabilityCalls:[]},'that thing','Could you clarify which part you mean?');
 assert.equal(result.reply,'Could you clarify which part you mean?');assert.equal(result.fallbackCode,undefined);
});
test('missing argument remains invalid without inventing it or calling the request ambiguous',async()=>{
 const {result,events}=await capture(()=>run({category:'patient_read',intent:'read_plan',capabilityCalls:[{name:'get_care_plan',args:{}}]},'Read my care plan'));
 assert.equal(result.fallbackCode,'INVALID_CAPABILITY_ARGS');assert.notEqual(result.reply,'Could you clarify which part you mean?');
 assert.ok(events.includes('AGENT_PLAN_REJECTED:CAPABILITY_ARGUMENTS'));
 assert.ok(events.includes('AGENT_PLAN_REJECTED:ARGUMENT_MISSING'));
});
test('unsupported capability is distinct from genuine ambiguity',async()=>{
 const {result}=await run({category:'unsupported',intent:'outside_product',capabilityCalls:[]},'Create a task using an unavailable action');
 assert.notEqual(result.reply,'Could you clarify which part you mean?');assert.match(result.reply,/supported SehatMate/);
 assert.equal(result.confirmation,null);
});
test('current clear rename help uses capability-state facts without claiming direct execution',async()=>{
 const reply='New Care Plan collects a title. Existing-plan rename has backend support, but no direct Agent action or mounted rename control is available.';
 const {result,events}=await capture(()=>run({category:'app_help',intent:'care_plan_name',capabilityCalls:[],productFactIds:['feature_care_plan_name']},'how can i change my care plan name',reply));
 assert.equal(result.reply,reply);assert.equal(result.fallbackCode,undefined);assert.equal(result.navigation,null);assert.equal(result.confirmation,null);
 assert.ok(events.includes('AGENT_ROUTE:APP_HELP'));
});
// Registry-supported paths stay separate from unavailable execution variants.
for(const [domain,plan] of [
 ['care-plan read',{category:'patient_read',capabilityCalls:[{name:'get_care_plans',args:{}}]}],
 ['task read',{category:'patient_read',capabilityCalls:[{name:'get_today_tasks',args:{}}]}],
 ['task outcome preview',{category:'action',capabilityCalls:[{name:'draft_task_outcome',args:{occurrenceId:'1',outcome:'completed'}}]}],
 ['reminder preview',{category:'action',capabilityCalls:[{name:'draft_schedule_time',args:{itemId:'1',scheduleTime:'10:00'}}]}],
 ['documents',{category:'navigation',capabilityCalls:[],navigationIntent:{target:'documents',params:{}}}],
 ['navigation',{category:'navigation',capabilityCalls:[],navigationIntent:{target:'care_plans',params:{}}}],
 ['language',{category:'conversation',capabilityCalls:[],languageCommand:{scope:'conversation',language:'roman_ur'}}],
 ['memory recall',{category:'memory',capabilityCalls:[],memoryCommand:{kind:'recall'}}],
 ['app help',{category:'app_help',capabilityCalls:[],productFactIds:['product_identity']}],
])test(`${domain}: valid recognized plan survives current capability/semantic guards`,async()=>{
 const raw={intent:'supported_request',...plan};const {provider,requests}=model(raw);
 const result=await planAgentMessage({provider,message:'A current request',contextSlice:{language:'en'}});
 assert.equal(result.ok,true,result.code);assert.equal(result.plan.category,plan.category);assert.equal(requests.length,1);
});
test('bare confirmation cannot create a plan without a pending server confirmation',async()=>{
 const {result,requests}=await run(creation,'yes');
 assert.equal(result.fallbackCode,'AGENT_CONFIRMATION_NOT_FOUND');assert.equal(result.taskWorkflow,undefined);assert.equal(requests.length,0);
});
for(const plan of [
 {...creation,capabilityCalls:[{name:'get_care_plans',args:{}}]},
 {...creation,navigationIntent:{target:'care_plans',params:{}}},
 {category:'patient_read',intent:'read',capabilityCalls:[{name:'get_care_plan',args:{planId:'1',userId:'2'}}]},
 {category:'action',intent:'rename',capabilityCalls:[{name:'rename_care_plan',args:{planId:'1'}}]},
])test('competing operations, account injection and unavailable executors still fail closed',()=>{
 assert.equal(validateAgentPlan(plan,{requireCategory:true}).ok,false);
});

const message='my name is zen add it to your memory';
const command={kind:'remember',nameSpan:{start:11,end:14},requestSpan:{start:15,end:36}};
const memoryPlan={category:'memory',intent:'agent_memory',capabilityCalls:[],memoryCommand:command};
test('reported name request with valid evidence saves, deduplicates, and uses committed success only',async()=>{
 const db=new Database();const first=await run(memoryPlan,message,undefined,db);const second=await run(memoryPlan,message,undefined,db);
 assert.equal(first.result.memoryReceipt.status,'succeeded');assert.equal(second.result.memoryReceipt.status,'succeeded');
 assert.equal(db.memory.length,1);assert.deepEqual(JSON.parse(db.memory[0].value_json),{name:'zen'});
 assert.equal(db.snapshot,null);assert.match(first.result.reply,/has been saved in Agent Memory/);
});
for(const [name,match,code,stage,reason] of [
 ['missing table',s=>s.startsWith('SELECT * FROM agent_memory'),'ER_NO_SUCH_TABLE','DEDUP_READ','SCHEMA_TABLE'],
 ['missing column',s=>s.startsWith('INSERT INTO agent_memory'),'ER_BAD_FIELD_ERROR','INSERT','SCHEMA_COLUMN'],
 ['foreign key',s=>s.startsWith('INSERT INTO agent_memory'),'ER_NO_REFERENCED_ROW_2','INSERT','FOREIGN_KEY'],
 ['duplicate',s=>s.startsWith('INSERT INTO agent_memory'),'ER_DUP_ENTRY','INSERT','DUPLICATE'],
 ['query incompatibility',s=>s.startsWith('INSERT INTO agent_memory'),'ER_PARSE_ERROR','INSERT','QUERY'],
 ['timeout',s=>s.startsWith('INSERT INTO agent_memory'),'ETIMEDOUT','INSERT','CONNECTION_TIMEOUT'],
 ['unknown error',s=>s.startsWith('INSERT INTO agent_memory'),'PRIVATE_VALUE','INSERT','UNKNOWN'],
])test(`memory ${name}: safe reason and unchanged honest failure`,async()=>{
 const db=new Database();db.failure={match,code};const {result,events}=await capture(()=>run(memoryPlan,message,undefined,db));
 assert.equal(result.reply,'I could not save your name in Agent Memory. Please try again.');
 assert.equal(result.memoryReceipt.status,'failed');assert.equal(db.memory.length,0);
 assert.ok(events.includes(`AGENT_MEMORY_WRITE_FAILED:${stage}:${reason}`),events.join('\n'));
 assert.equal(events.some(e=>e.includes('PRIVATE_')||e.includes('zen')||e.includes(message)),false);
});
test('memory ambiguous commit remains failed with a fixed commit-stage reason',async()=>{
 const db=new Database();db.commitError='ETIMEDOUT';const {result,events}=await capture(()=>run(memoryPlan,message,undefined,db));
 assert.equal(result.memoryReceipt.status,'failed');assert.equal(db.memory.length,0);
 assert.ok(events.includes('AGENT_MEMORY_WRITE_FAILED:COMMIT_OR_RELEASE:CONNECTION_TIMEOUT'));
});
test('invalid memory source spans are distinguishable from a database failure',async()=>{
 const {result,events,db}=await capture(()=>run({...memoryPlan,memoryCommand:{...command,nameSpan:{start:999,end:1000}}},message));
 assert.equal(result.memoryReceipt.status,'failed');assert.equal(db.memory.length,0);
 assert.ok(events.includes('AGENT_MEMORY_WRITE_FAILED:SOURCE:EVIDENCE_INVALID'));
 assert.equal(events.some(e=>e.includes('AGENT_MEMORY_WRITE_STAGE:TRANSACTION')),false);
});
test('account-scope and serialization failures retain their original storage exceptions',async()=>{
 for(const [setup,stage,reason] of [
  [db=>db.users.clear(),'ACCOUNT_LOCK','ACCOUNT_NOT_FOUND'],
  [db=>db.memory.push({id:'1',user_id:'1',kind:'CONFIRMED_FACT',memory_key:'identity.name',value_json:'PRIVATE_BAD_JSON',status:'active',confirmed_by_user:true}),'DEDUP_READ','SERIALIZATION'],
 ]) {
  const db=new Database();setup(db);
  const {events}=await capture(async()=>{await assert.rejects(createAgentMemory({db,userId:'1',item:{kind:'CONFIRMED_FACT',key:'identity.name',value:{name:'Test'},source:'user_api',evidenceRef:'test:fixture',confirmedByUser:true},evidence:{explicitUser:true,ref:'test:fixture'}}));return {};});
  assert.ok(events.includes(`AGENT_MEMORY_WRITE_FAILED:${stage}:${reason}`));assert.equal(events.some(e=>e.includes('PRIVATE_')),false);
 }
});
test('diagnostic code/enum lookups cannot print arbitrary values or inherited properties',async()=>{
 for(const code of ['PRIVATE_TRANSCRIPT','constructor','toString','__proto__',{},null]) {
  assert.equal(agentMemoryFailureReason({code}),'UNKNOWN');
  const {events}=await capture(async()=>{logAgentPlanOutput({category:code,intent:code});logAgentPlanFailure({code});logAgentMemoryWriteFailure(code,{code});return {};});
  assert.deepEqual(events,['AGENT_PLAN_OUTPUT:UNKNOWN','AGENT_PLAN_CREATE_INTENT:OTHER','AGENT_PLAN_FAILED:UNKNOWN','AGENT_MEMORY_WRITE_FAILED:UNKNOWN:UNKNOWN']);
 }
});
