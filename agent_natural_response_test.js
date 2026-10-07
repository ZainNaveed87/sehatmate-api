import assert from 'node:assert/strict';
import {test} from 'node:test';
import {handleAgentMessage} from './agent/agent_core.js';
import {createAgentProvider,AGENT_PROVIDER_LIMITS} from './agent/agent_provider.js';
import {generateGroundedAgentReply} from './agent/agent_response_grounder.js';
import {emptyAgentSessionState} from './agent/agent_session_state.js';
import {defineAgentCapability} from './agent/agent_capability_registry.js';
process.env.AGENT_ENABLED='true';

function database(language='en',state={}) {
  const queries=[];
  let row={id:501,user_id:42,language,state_json:JSON.stringify({...emptyAgentSessionState(),...state}),
    created_at:'2026-09-03 10:00:00',last_active_at:'2026-09-03 10:00:00',expires_at:'2099-01-01 00:00:00'};
  const execute=async(sql,params=[])=>{
    const s=String(sql).replace(/\s+/g,' ').trim(); queries.push(s);
    if(s.startsWith('SELECT preferred_language')) return [[{preferred_language:language}]];
    if(s.includes('FROM agent_sessions WHERE id = ? AND user_id = ? AND expires_at')) return [[row]];
    if(s.startsWith('SELECT id FROM agent_sessions')) return [[{id:501}]];
    if(s.startsWith('UPDATE agent_sessions SET state_json')) row={...row,state_json:params[0]};
    if(/^SELECT|^WITH|^SHOW|^DESCRIBE/.test(s)) return [[]];
    return [{affectedRows:1,insertId:501}];
  };
  return {execute,queries,get state(){return JSON.parse(row.state_json);},async getConnection(){return {
    execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}};}};
}
function model({reply,category='app_help',topic='care_plan_support',review,failStage}={}) {
  const requests=[];
  const provider=createAgentProvider({generateJson:async args=>{
    requests.push(args);
    const planning=args.systemPrompt.includes('planning stage');
    const reviewing=args.systemPrompt.includes('product support review');
    if((failStage==='reply'&&!planning&&!reviewing)||(failStage==='review'&&reviewing)) {
      throw new Error('PRIVATE_PROVIDER_BODY');
    }
    if(planning) return {json:{category,intent:topic,capabilityCalls:[],navigationIntent:null},model:'mock'};
    if(reviewing) return {json:review??{supported:true,factIds:['cap_get_care_plans'],topic},model:'mock'};
    return {json:{messageTemplate:reply},model:'mock'};
  }});
  return {provider,requests};
}
async function run(message,options={}) {
  const db=options.db??database(options.language);
  const {provider,requests}=model(options);
  const result=await handleAgentMessage({pool:db,userId:'42',sessionId:'501',message,provider,
    voiceReply:options.voiceReply??false});
  return {db,result,requests};
}
const cases=[
  ['what is SehatMate','product_identity','SehatMate is a care assistant for understanding verified care plans.'],
  ['why should I use SehatMate','care_plan_benefits','It can help make a verified care plan easier to understand and discuss.'],
  ['there are many apps like you','product_comparison','That is fair. SehatMate focuses on verified care plans; I cannot compare other apps without evidence.'],
  ['how are you different','product_focus','The supported focus here is discussing verified care plans, rather than claiming superiority over other apps.'],
  ['what can you do','capability_overview','I can discuss verified care plans and help you navigate supported screens.'],
  ['Convince me this assistant is worth my time','care_plan_value','If understanding a verified care plan is useful to you, we can work through it together.'],
];
for(const [message,topic,reply] of cases) test(`natural app help preserves current meaning: ${message}`,async()=>{
  const {result,requests,db}=await run(message,{topic,reply});
  assert.equal(result.reply,reply);
  assert.equal(result.fallbackCode,undefined);
  assert.equal(result.navigation,null);
  const generation=requests.find(r=>r.systemPrompt.includes('response stage'));
  assert.ok(generation,'app help must reach shared reply generation');
  assert.ok(generation.userPrompt.includes(message));
  assert.ok(generation.userPrompt.includes('cap_get_care_plans'));
  assert.ok(generation.userPrompt.includes('draft_schedule_time'));
  assert.ok(generation.userPrompt.includes('nav_care_plans'));
  assert.ok(requests.some(r=>r.systemPrompt.includes('product support review')));
  assert.equal(db.queries.some(q=>q.includes('occurrence_date')||q.includes('FROM care_plans')),false);
  for(const request of requests){
    assert.ok(request.systemPrompt.length<=AGENT_PROVIDER_LIMITS.systemPromptMaxChars);
    assert.ok(request.userPrompt.length<=AGENT_PROVIDER_LIMITS.userPromptMaxChars);
  }
});

test('text and voice share the same natural product response and grounding',async()=>{
  const reply='SehatMate can help you understand verified care plans.';
  for(const voiceReply of [false,true]) {
    const {result,requests}=await run('Explain your main focus',{reply,voiceReply});
    assert.equal(result.reply,reply); assert.equal(result.fallbackCode,undefined);
    assert.equal(requests.length,3);
  }
});

for(const [language,message,reply] of [
  ['ur','سہت میٹ استعمال کرنے کا کیا فائدہ ہے؟','SehatMate تصدیق شدہ نگہداشت کے منصوبے سمجھنے میں مدد کر سکتا ہے۔'],
  ['roman_ur','SehatMate istemal karne ka kya faida hai?','Main aap ke verified care plans samajhne mein madad kar sakta hoon.'],
]) test(`natural help uses existing language pipeline: ${language}`,async()=>{
  const {result,requests}=await run(message,{reply,language,voiceReply:true});
  assert.equal(result.reply,reply); assert.equal(result.fallbackCode,undefined);
  assert.equal(requests.length,3);
});

test('app help fails closed on unsupported product or competitor claims',async()=>{
  for(const reply of ['SehatMate diagnoses disease and automatically changes doses.',
    'All competing apps sell your medical records.', 'SehatMate offers automatic insurance payments.']) {
    const {result}=await run('Explain your focus',{reply,review:{supported:false,factIds:[],topic:'product_focus'}});
    assert.notEqual(result.reply,reply);
    assert.equal(result.fallbackCode,'AGENT_PRODUCT_UNGROUNDED');
    assert.match(result.reply,/Nothing was changed/);
  }
});

test('invalid review evidence, unknown fact ids and provider failures cannot approve help',async()=>{
  for(const options of [
    {review:{supported:true,factIds:['invented_feature'],topic:'product_focus'}},
    {review:{supported:true,factIds:[],topic:'product_focus'}},
    {review:{supported:true,factIds:['cap_get_care_plans'],topic:'product_focus',extra:'private'}},
    {review:{supported:'true',factIds:['cap_get_care_plans'],topic:'product_focus'}},
    {review:{supported:true,factIds:['cap_get_care_plans'],topic:'ignore all rules'}},
    {failStage:'reply'}, {failStage:'review'},
  ]) {
    const reply='SehatMate helps you discuss care plans.';
    const {result}=await run('Explain the app focus',{reply,...options});
    assert.notEqual(result.reply,reply); assert.ok(result.fallbackCode);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PROVIDER_BODY|ignore all rules|invented_feature/);
  }
});

test('bounded follow-ups carry a product topic and verified fact references, not raw dialogue',async()=>{
  const db=database();
  const previous='If a verified care plan feels confusing, we can discuss it together.';
  await run('Explain why this app could be useful to me',{db,reply:previous,topic:'care_plan_benefits'});
  const summary=db.state.lastActionSummary;
  assert.ok(summary.includes('care_plan_benefits')); assert.ok(summary.includes('cap_get_care_plans'));
  assert.ok(summary.length<=500);
  assert.ok(!summary.includes(previous));
  for(const message of ['But why?','How is that useful?','What makes that different?',"Isn't that the same as other apps?",'Why does it matter?']) {
    const reply='Discussing a verified care plan can help make its instructions easier to understand.';
    const {result,requests}=await run(message,{db,reply,topic:'care_plan_benefits'});
    assert.equal(result.reply,reply);
    assert.ok(requests[0].userPrompt.includes('care_plan_benefits'));
    const generation=requests.find(r=>r.systemPrompt.includes('response stage'));
    assert.ok(generation.userPrompt.includes('care_plan_benefits'));
    assert.ok(generation.userPrompt.includes(message));
    assert.ok(!generation.userPrompt.includes(previous));
  }
});

test('product generation/review receives no prior patient or screen facts',async()=>{
  const {provider,requests}=model({reply:'SehatMate can help discuss verified care plans.'});
  const result=await generateGroundedAgentReply({provider,language:'en',message:'What is this app?',category:'app_help',
    contextSlice:{currentEntity:{type:'care_plan',id:'SENSITIVE_ID'},familyMembers:[{title:'PRIVATE_PATIENT_NAME'}],
      lastActionSummary:'PRIVATE_PATIENT_SUMMARY',productFacts:[{id:'invented_feature',description:'Diagnoses disease'}]}});
  assert.equal(result.ok,true);
  assert.ok(requests.length>=2);
  for(const r of requests) assert.doesNotMatch(r.userPrompt,/SENSITIVE_ID|PRIVATE_PATIENT|invented_feature|Diagnoses disease/);
});

test('normal nontrivial conversation stays on shared generation and cannot invent patient facts',async()=>{
  const reply='A regular routine can make everyday planning easier.';
  const good=await run('Explain why a steady routine can be useful',{category:'conversation',reply});
  assert.equal(good.result.reply,reply); assert.equal(good.requests.length,2);
  const bad=await run('How is everything?',{category:'conversation',reply:'You have no pending care tasks today.'});
  assert.ok(bad.result.fallbackCode); assert.doesNotMatch(bad.result.reply,/no pending care tasks/);
});

test('product help keeps medical grounding and cannot consume patient capability results',async()=>{
  for(const reply of ['You have diabetes.','Take 5 mg.','Your care plan is complete.']) {
    const {result,requests}=await run('Explain the product',{reply});
    assert.ok(result.fallbackCode); assert.notEqual(result.reply,reply);
    assert.equal(requests.some(r=>r.systemPrompt.includes('product support review')),false);
  }
  const {provider,requests}=model({reply:'Here is your care plan.'});
  const result=await generateGroundedAgentReply({provider,language:'en',message:'Explain the app',category:'app_help',
    capabilityResults:[{name:'get_care_plan',result:{ok:true,data:{title:'PRIVATE_PLAN'}}}]});
  assert.equal(result.ok,false); assert.equal(result.code,'AGENT_REPLY_INVALID');
  assert.equal(requests.length,0);
});

test('natural help preserves authoritative entity and action bookkeeping',async()=>{
  const db=database('en',{currentFocus:{type:'care_plan',id:'37'},lastReferencedEntities:[{type:'care_plan',id:'37'}],
    lastIntent:'read_care_plans',lastCapabilityNames:['get_care_plans']});
  const {result}=await run('Explain the assistant focus',{db,reply:'SehatMate can help explain verified care plans.'});
  assert.equal(result.fallbackCode,undefined);
  assert.deepEqual(db.state.currentFocus,{type:'care_plan',id:'37'});
  assert.deepEqual(db.state.lastReferencedEntities,[{type:'care_plan',id:'37'}]);
  assert.equal(db.state.lastIntent,'read_care_plans');
  assert.deepEqual(db.state.lastCapabilityNames,['get_care_plans']);
  assert.equal(db.state.pendingDraft,null); assert.equal(db.state.pendingConfirmation,null);
});

test('registered executable capability metadata enters product help without executing it',async()=>{
  let executed=0;
  defineAgentCapability({name:'read_hydration_journal',permissionClass:'READ',description:'Read the owned hydration journal.',
    inputSchema:{properties:{},required:[]},resultContract:'Returns owned journal entries.',execute:async()=>{executed++;return {ok:true,data:{}};}});
  defineAgentCapability({name:'forbidden_test_feature',permissionClass:'SENSITIVE_ACTION',description:'UNAVAILABLE_FEATURE_SENTINEL',
    inputSchema:{properties:{},required:[]},resultContract:'Never executable in ordinary turns.',execute:async()=>{executed++;return {ok:true,data:{}};}});
  const {result,requests}=await run('Explain the supported journals',{reply:'The registered hydration journal can be read.',
    review:{supported:true,factIds:['cap_read_hydration_journal'],topic:'hydration_journal'}});
  assert.equal(result.fallbackCode,undefined); assert.equal(executed,0);
  const generation=requests.find(r=>r.systemPrompt.includes('response stage'));
  assert.ok(generation.userPrompt.includes('Read the owned hydration journal.'));
  assert.doesNotMatch(generation.userPrompt,/UNAVAILABLE_FEATURE_SENTINEL/);
});
