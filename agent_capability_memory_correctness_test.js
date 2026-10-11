import {mountAgentCopilotRoutes} from './agent/agent_copilot_routes.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {CopilotTestDb} from './agent_copilot_test_db.js';
import {handleAgentMessage} from './agent/agent_core.js';
import {createAgentProvider} from './agent/agent_provider.js';
import {reduceTaskWorkflow} from './agent/agent_task_workflow.js';
import {AGENT_PROVIDER_LIMITS} from './agent/agent_provider.js';
import {emptyAgentSessionState} from './agent/agent_session_state.js';
import {buildAgentProductContext} from './agent/agent_product_context.js';
import {buildAgentPlannerPrompts,validateAgentPlan} from './agent/agent_planner.js';
import {generateGroundedAgentReply,buildAgentReplyPrompts} from './agent/agent_response_grounder.js';
import {readRelevantAgentMemory,deactivateAgentMemory,validateAgentMemoryProposal,createAgentMemory} from './agent/agent_memory.js';
process.env.AGENT_ENABLED='true';

class Database extends CopilotTestDb {
 constructor({language='English',state={}}={}) {
  super();this.language=language;this.state={...emptyAgentSessionState(),...state};this.tail=Promise.resolve();
 }
 async execute(sql,args=[]) {
  sql=sql.replace(/\s+/g,' ').trim();
  if(sql.includes('SELECT preferred_language'))return [[{preferred_language:this.language}]];
  if(sql.includes('FROM agent_sessions')&&sql.startsWith('SELECT id, user_id'))return [[{id:11,user_id:1,language:'en',state_json:JSON.stringify(this.state),expires_at:'2099-01-01'}]];
  if(sql.startsWith('UPDATE agent_sessions')){if(sql.includes('state_json = ?'))this.state=JSON.parse(args[0]);return [{affectedRows:1}];}
  if(sql.startsWith('INSERT INTO agent_memory')&&this.writeError)throw Object.assign(new Error('not logged'),{code:this.writeError});
  if(/agent_memory|agent_copilot_|SELECT id FROM users|SELECT id FROM agent_sessions/.test(sql))return super.execute(sql,args);
  if(sql.startsWith('SELECT'))return [[]];
  return [{affectedRows:1,insertId:1}];
 }
 async getConnection() {
  let release;const prior=this.tail;this.tail=new Promise(r=>release=r);
  return {execute:this.execute.bind(this),beginTransaction:async()=>{await prior;await this.beginTransaction();},
   commit:async()=>{if(this.beforeCommit)await this.beforeCommit();if(this.commitError)throw Object.assign(new Error('not logged'),{code:this.commitError});await this.commit();},
   rollback:this.rollback.bind(this),release};
 }
}
const memoryPlan=command=>({category:'memory',intent:'agent_memory',capabilityCalls:[],navigationIntent:null,memoryCommand:command});
const nameMessage='My name is Zain. Add it to your memory.';
const nameCommand={kind:'remember',nameSpan:{start:11,end:15},requestSpan:{start:17,end:38}};
function model(plan,reply='A natural clarification.') {
 const requests=[];const provider=createAgentProvider({generateJson:async args=>{requests.push(args);return {json:args.systemPrompt.includes('planning stage')?plan:{messageTemplate:reply}};}});
 return {provider,requests};
}
async function run(db,plan,message=nameMessage,reply,context={screenId:'care_plan_upload'}) {
 const m=model(plan,reply);const result=await handleAgentMessage({pool:db,userId:'1',sessionId:'11',message,provider:m.provider,clientContext:context});
 return {result,...m};
}

test('catalog distinguishes real rename backend support from absent mounted rename controls',()=>{
 const fact=buildAgentProductContext().facts.find(f=>f.id==='feature_care_plan_name');
 assert.ok(fact);assert.match(fact.description,/rename/i);assert.match(fact.description,/not.*(?:mounted|registered)/i);
 assert.doesNotMatch(fact.description,/provider|administrator/i);
});
test('global capability policy is explicit and survives Upload Documents context',()=>{
 const p=buildAgentPlannerPrompts({message:'How can I change my care-plan name?',contextSlice:{screenContext:{screenId:'upload_documents'}}});
 assert.match(p.userPrompt,/feature_care_plan_name/);assert.match(p.systemPrompt+p.userPrompt,/global.*(?:screen|route)|(?:screen|route).*global/i);
});
for(const reply of [
 'Please contact your care provider or administrator to rename your plan; that requires authorized access.',
 'I can only help read the Upload Documents screen.',
 "I've noted your name, Zain.", "I've saved your name.", "I'll remember your name.",
 'Maine aap ka naam yaad rakh liya hai.',
])test(`no-receipt reply rejects invented authority/limits or memory claim: ${reply}`,async()=>{
 const {provider}=model({},reply);
 const result=await generateGroundedAgentReply({provider,language:reply.startsWith('Maine')?'roman_ur':'en',message:'Help with my name',category:'app_help',productFactIds:['product_identity'],capabilityResults:[]});
 assert.equal(result.ok,false);assert.ok(['AGENT_PRODUCT_UNGROUNDED','AGENT_MEMORY_RECEIPT_REQUIRED'].includes(result.code),result.code);
});
test('safe product answer does not deny the real service or fabricate an unavailable UI',async()=>{
 const {result}=await run(new Database(),{category:'app_help',intent:'care_plan_name',capabilityCalls:[],productFactIds:['feature_care_plan_name']},'How can I change my care-plan name?',
  'You can enter a plan name on New Care Plan. Renaming an existing plan has no mounted control I can use here.');
 assert.equal(result.fallbackCode,undefined);assert.match(result.reply,/New Care Plan/);assert.equal(result.navigation,null);
});

for(const raw of ['Can you change my telephone name?','How can I change my help okay plan name?','Could that label be different?']) {
 test(`contextual clarification preserves raw input and makes no mutation: ${raw}`,async()=>{
  const db=new Database({state:{lastActionSummary:JSON.stringify({category:'app_help',topic:'care_plan_name',factIds:['feature_care_plan_name']})}});
  const {result,requests}=await run(db,{category:'ambiguous',intent:'clarify_app_entity',capabilityCalls:[],appHelpClarification:{featureId:'feature_care_plan_name'}},raw);
  assert.match(result.reply,/care.plan.*name|name.*care.plan/i);assert.equal(result.navigation,null);assert.equal(result.confirmation,null);
  assert.equal(db.memory.length,0);assert.ok(requests[0].userPrompt.includes(raw));assert.equal(requests.length,1);
 });
}
test('current route alone cannot force an ambiguous entity interpretation',async()=>{
 const {result}=await run(new Database(),{category:'ambiguous',intent:'clarify_app_entity',capabilityCalls:[],appHelpClarification:{featureId:'feature_care_plan_name'}},'Could you change that name?',undefined,{screenId:'care_plan_details'});
 assert.match(result.reply,/which|what.*name/i);assert.doesNotMatch(result.reply,/Do you mean.*care.plan/i);assert.equal(result.navigation,null);
});
test('genuinely unrelated unsupported request retains existing safe fallback',async()=>{
 const {result}=await run(new Database(),{category:'unsupported',intent:'outside_product',capabilityCalls:[]},'Repair my car');
 assert.match(result.reply,/supported SehatMate/);assert.equal(result.navigation,null);
});
test('specific clarification uses only a catalog feature and cannot carry an action',()=>{
 assert.equal(validateAgentPlan({category:'ambiguous',intent:'clarify',capabilityCalls:[],appHelpClarification:{featureId:'invented_rename'}}).ok,false);
 assert.equal(validateAgentPlan({category:'navigation',intent:'clarify',capabilityCalls:[],navigationIntent:{target:'care_plans',params:{}},appHelpClarification:{featureId:'feature_care_plan_name'}}).ok,false);
});
test('reply context retains bounded workflow/topic hints without raw conversation',()=>{
 const p=buildAgentReplyPrompts({category:'ambiguous',message:'Which name?',contextSlice:{conversationTopic:{category:'app_help',topic:'care_plan_name',factIds:['feature_care_plan_name']},taskWorkflow:{kind:'create_care_plan',status:'collecting'}}});
 assert.match(p.userPrompt,/care_plan_name/);assert.match(p.userPrompt,/create_care_plan/);
});

test('requested structured name is an allowed confirmed fact, clinical/transcript fields are not',()=>{
 assert.equal(validateAgentMemoryProposal({kind:'CONFIRMED_FACT',key:'identity.name',value:{name:'Zain'}}).ok,true);
 for(const value of [{name:'Zain',transcript:nameMessage},{name:'Zain',diagnosis:'x'},{name:'x\nsecret'}])assert.equal(validateAgentMemoryProposal({kind:'CONFIRMED_FACT',key:'identity.name',value}).ok,false);
});
for(const language of ['English','Roman Urdu','Urdu'])test(`${language}: canonical memory write/read uses account scope and one provider planning call`,async()=>{
 const db=new Database({language});const {result,requests}=await run(db,memoryPlan(nameCommand));
 assert.equal(result.memoryReceipt?.status,'succeeded');assert.equal(result.memoryReceipt.operation,'remember');assert.equal(db.memory.length,1);
 assert.deepEqual(JSON.parse(db.memory[0].value_json),{name:'Zain'});assert.equal(db.memory[0].user_id,'1');assert.equal(requests.length,1);
 assert.equal((await readRelevantAgentMemory({db,userId:'1',screenId:'upload_documents'})).length,1);
 assert.equal((await readRelevantAgentMemory({db,userId:'2',review:true})).length,0);
 if(language==='Roman Urdu')assert.doesNotMatch(result.reply,/[\u0600-\u06ff]/u);
 const later=await run(db,memoryPlan({kind:'recall'}),"What's my name?",undefined,{screenId:'settings'});
 assert.match(later.result.reply,/Zain/);assert.equal(later.requests.length,1);
});
test('duplicate/replayed and concurrent identical requests retain one memory row',async()=>{
 const db=new Database();await Promise.all([run(db,memoryPlan(nameCommand)),run(db,memoryPlan(nameCommand))]);
 await run(db,memoryPlan(nameCommand));assert.equal(db.memory.length,1);
 assert.equal(db.calls.filter(c=>c.sql.startsWith('INSERT INTO agent_memory')).length,1);
});
test('memory success waits for committed persistence rather than model intent',async()=>{
 const db=new Database();let release,entered;const ready=new Promise(r=>entered=r);db.beforeCommit=async()=>{entered();await new Promise(r=>release=r);};
 let delivered=false;const pending=run(db,memoryPlan(nameCommand)).then(r=>{delivered=true;return r;});
 await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('write never started')),1500))]);
 assert.equal(delivered,false);release();assert.equal((await pending).result.memoryReceipt.status,'succeeded');
});
for(const error of ['ER_NO_SUCH_TABLE','WRITE_FAILED','ETIMEDOUT'])test(`${error}: failed or ambiguous memory persistence never claims saved/noted`,async()=>{
 const db=new Database();db.writeError=error;const {result}=await run(db,memoryPlan(nameCommand));
 assert.notEqual(result.memoryReceipt?.status,'succeeded');assert.match(result.reply,/could not|couldn't|unable/i);
 assert.doesNotMatch(result.reply,/I(?:'ve| have) (?:noted|saved)|I'll remember/i);assert.equal(db.memory.length,0);
});
test('no receipt is a factual empty memory answer, never a screen-dependent access story',async()=>{
 const {result}=await run(new Database(),memoryPlan({kind:'recall'}),"What's my name?");
 assert.match(result.reply,/no.*name|not.*saved/i);assert.doesNotMatch(result.reply,/from this screen|access to your name/i);
});
test('invalid spans cannot write or fabricate a name from context',async()=>{
 const db=new Database();const {result}=await run(db,memoryPlan({...nameCommand,nameSpan:{start:999,end:1000}}));
 assert.equal(db.memory.length,0);assert.doesNotMatch(result.reply,/saved|noted|remembered/i);
});
test('forget remains authoritative and unrelated memory is not overwritten',async()=>{
 const db=new Database();await run(db,memoryPlan(nameCommand));
 assert.equal(db.memory.length,1);await deactivateAgentMemory({db,userId:'1',memoryId:String(db.memory[0].id)});
 assert.equal((await readRelevantAgentMemory({db,userId:'1',review:true})).length,0);
});

for (const category of ['conversation','app_help','ambiguous']) test(`no receipt cannot invent memory success in ${category}`,async()=>{
 const m=model({},"I've added your name to memory.");
 const result=await generateGroundedAgentReply({provider:m.provider,language:'en',message:'Remember my name',category,productFactIds:category==='app_help'?['product_identity']:null,capabilityResults:[]});
 assert.equal(result.code,'AGENT_MEMORY_RECEIPT_REQUIRED');
});
test('negative memory wording remains allowed and no name is saved by introduction alone',async()=>{
 const {result}=await run(new Database(),{category:'conversation',intent:'introduction',capabilityCalls:[]},'My name is Zain.',"I have not saved your name.");
 assert.equal(result.reply,"I have not saved your name.");assert.equal(result.memoryReceipt,undefined);
});
test('memory schema forbids inferred names and unrelated arbitrary keys',async()=>{
 const db=new Database();
 for(const key of ['identity.name','clinical.diagnosis']) {
  const item={kind:'INFERRED_PATTERN',key,value:{name:'Zain'},source:'verified_event',evidenceRef:'event:fixture',confirmedByUser:false,expiresAt:new Date(Date.now()+86400000).toISOString(),confidence:0.8};
  await assert.rejects(createAgentMemory({db,userId:'1',item,evidence:{verified:true,ref:item.evidenceRef}}));
 }
 assert.equal(db.memory.length,0);
});
for(const message of ['My name is Zain. Do not save it to memory.','My name is Zain. If I ask, remember it.','My name is Zain.'])test(`no explicit affirmative source cannot persist: ${message}`,async()=>{
 const db=new Database();const {result}=await run(db,memoryPlan({kind:'remember',nameSpan:{start:11,end:15},requestSpan:{start:0,end:message.length}}),message);
 assert.equal(db.memory.length,0);assert.equal(result.memoryReceipt.status,'failed');
});
test('commit failure returns failure receipt and rolls back memory',async()=>{
 const db=new Database();db.commitError='COMMIT_FAILED';const {result}=await run(db,memoryPlan(nameCommand));
 assert.equal(result.memoryReceipt.status,'failed');assert.match(result.reply,/could not save/i);assert.equal(db.memory.length,0);
});
test('saving a requested name preserves unrelated account preferences',async()=>{
 const db=new Database();await createAgentMemory({db,userId:'1',item:{kind:'USER_PREFERENCE',key:'explanation.detail',value:{level:'brief'},source:'user_api',evidenceRef:'preference:fixture',confirmedByUser:true},evidence:{explicitUser:true,ref:'preference:fixture'}});
 await run(db,memoryPlan(nameCommand));
 assert.equal(db.memory.filter(m=>m.memory_key==='explanation.detail'&&m.status==='active').length,1);
 assert.equal((await readRelevantAgentMemory({db,userId:'1',review:true})).length,2);
});
test('active server title workflow can clarify an uncertain app name without consuming it as a title',async()=>{
 const taskWorkflow=reduceTaskWorkflow({command:{kind:'start',workflowKind:'create_care_plan'},message:'Create a plan'}).workflow;
 const db=new Database({state:{taskWorkflow}});
 const {result}=await run(db,{category:'ambiguous',intent:'clarify_app_entity',capabilityCalls:[],appHelpClarification:{featureId:'feature_care_plan_name'}},'Can you change that name?');
 assert.match(result.reply,/name.*care plan/i);assert.equal(result.taskWorkflow.status,'collecting');assert.deepEqual(result.taskWorkflow.fields,{});
});
for(const language of ['en','ur','roman_ur'])test(`new policies preserve fixed ${language} text/voice prompt budgets`,()=>{
 for(const voiceReply of [false,true]) {
  const p=buildAgentReplyPrompts({language,message:'Name help',voiceReply,category:'app_help',productFactIds:['feature_care_plan_name']});
  assert.ok(p.systemPrompt.length<=AGENT_PROVIDER_LIMITS.systemPromptMaxChars);
 }
 assert.ok(buildAgentPlannerPrompts({message:'Name help'}).systemPrompt.length<=AGENT_PROVIDER_LIMITS.systemPromptMaxChars);
});
test('closed memory/clarification commands reject competing writes, UI and navigation',()=>{
 for(const extra of [{navigationIntent:{target:'care_plans',params:{}}},{taskCommand:{kind:'start',workflowKind:'create_care_plan'}},{memoryProposal:{kind:'USER_PREFERENCE',key:'explanation.detail',value:{level:'brief'}}},{languageCommand:{scope:'conversation',language:'en'}},{appHelpClarification:{featureId:'feature_care_plan_name'}}])assert.equal(validateAgentPlan({...memoryPlan(nameCommand),...extra}).ok,false);
});

test('canonical name write is read through the real authenticated Memory UI endpoint',async()=>{
 const db=new Database();await run(db,memoryPlan(nameCommand));
 const routes=new Map();const app={get:(p,...handlers)=>routes.set(p,handlers.at(-1)),post:()=>{},delete:()=>{}};
 mountAgentCopilotRoutes({app,pool:db,authenticate:()=>{}});
 async function review(userId) {
  let body;const res={set:()=>res,status:()=>res,json:value=>body=value};
  await routes.get('/api/agent/copilot/memory')({auth:{userId}},res);
  return body;
 }
 assert.equal((await review('1')).data[0].value.name,'Zain');
 assert.deepEqual((await review('2')).data,[]);
 assert.equal((await review('1')).data[0].value.name,'Zain');
});
test('known creation support cannot be replaced by false unsupported model wording',async()=>{
 const m=model({},'SehatMate cannot create care plans.');
 const result=await generateGroundedAgentReply({provider:m.provider,language:'en',message:'Can you help create a care plan?',category:'app_help',productFactIds:['feature_care_plan_name'],capabilityResults:[]});
 assert.equal(result.ok,false);assert.equal(result.code,'AGENT_PRODUCT_UNGROUNDED');
});
test('honest unsupported mounted rename guidance may explicitly deny invented approval rules',async()=>{
 const reply='Renaming an existing plan has no mounted control here. No provider approval is required by this catalog.';
 const {result}=await run(new Database(),{category:'app_help',intent:'care_plan_name',capabilityCalls:[],productFactIds:['feature_care_plan_name']},'How can I rename my plan?',reply);
 assert.equal(result.reply,reply);assert.equal(result.fallbackCode,undefined);
});

test('mere mention of memory without an affirmative write request cannot authorize a name write',async()=>{
 const db=new Database();const message='My name is Zain. Memory is useful.';
 const {result}=await run(db,memoryPlan({...nameCommand,requestSpan:{start:17,end:message.length}}),message);
 assert.equal(db.memory.length,0);assert.equal(result.memoryReceipt.status,'failed');
});
for(const [language,reply] of [['roman_ur','Aap ka naam memory mein save ho gaya hai.'],['ur','آپ کا نام یادداشت میں محفوظ ہو گیا ہے۔']])test(`unreceipted passive ${language} memory claim is rejected`,async()=>{
 const m=model({},reply);const result=await generateGroundedAgentReply({provider:m.provider,language,message:'Remember my name',category:'conversation',capabilityResults:[]});
 assert.equal(result.code,'AGENT_MEMORY_RECEIPT_REQUIRED');
});

for(const operation of ['remember','clarify'])test(`new ${operation} route preserves an existing care-plan confirmation envelope`,async()=>{
 const taskWorkflow=reduceTaskWorkflow({command:{kind:'start',workflowKind:'create_care_plan',fieldSpans:{title:{start:0,end:4}}},message:'Plan'}).workflow;
 const db=new Database({state:{taskWorkflow}});
 const plan=operation==='remember'?memoryPlan(nameCommand):{category:'ambiguous',intent:'clarify_app_entity',capabilityCalls:[],appHelpClarification:{featureId:'feature_care_plan_name'}};
 const {result}=await run(db,plan,operation==='remember'?nameMessage:'Which name do you mean?');
 assert.equal(result.taskWorkflow.status,'awaiting_confirmation');
 assert.equal(result.confirmation?.confirmationId,taskWorkflow.confirmationId);
 assert.equal(result.actionStatus,'awaiting_confirmation');
 assert.equal(result.taskWorkflow.fields.title,'Plan');
});
