import assert from 'node:assert/strict';
import {test} from 'node:test';
import {handleAgentMessage} from './agent/agent_core.js';
import {createAgentProvider} from './agent/agent_provider.js';
import {validateAgentPlan, planAgentMessage} from './agent/agent_planner.js';
import {generateGroundedAgentReply} from './agent/agent_response_grounder.js';
import {emptyAgentSessionState} from './agent/agent_session_state.js';
process.env.AGENT_ENABLED='true';

function pool() {
  const queries=[];
  let row={id:501,user_id:42,language:'en',state_json:JSON.stringify(emptyAgentSessionState()),
    created_at:'2026-09-03 10:00:00',last_active_at:'2026-09-03 10:00:00',expires_at:'2099-01-01 00:00:00'};
  const execute=async(sql,params=[])=>{
    const s=String(sql).replace(/\s+/g,' ').trim(); queries.push(s);
    if(s.startsWith('SELECT preferred_language')) return [[{preferred_language:'en'}]];
    if(s.includes('FROM agent_sessions WHERE id = ? AND user_id = ? AND expires_at')) return [[row]];
    if(s.startsWith('SELECT id FROM agent_sessions')) return [[{id:501}]];
    if(s.startsWith('UPDATE agent_sessions SET state_json')) row={...row,state_json:params[0]};
    if(/^SELECT|^WITH|^SHOW|^DESCRIBE/.test(s)) return [[]];
    return [{affectedRows:1,insertId:501}];
  };
  return {execute,queries,get state(){return JSON.parse(row.state_json);},async getConnection(){return {
    execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}};}};
}
function provider(plan,reply='How can I help with your care?',fail=false) {
  const prompts=[];
  const p=createAgentProvider({generateJson:async(args)=>{
    prompts.push(args);
    if(args.systemPrompt.includes('planning stage')) return {json:plan,model:'mock'};
    if(fail) throw new Error('PRIVATE_PROVIDER_BODY');
    return {json:{messageTemplate:reply},model:'mock'};
  }});
  return {p,prompts};
}
function route(category,calls=[]) {return {category,intent:'arbitrary_descriptive_label',capabilityCalls:calls,navigationIntent:null,
  ...(category==='app_help'?{productFactIds:['product_identity','boundary_evidence','cap_get_care_plans']}:{})};}
const taskCall={name:'get_next_task',args:{}};
async function turn(message,plan,options={}) {
  const db=options.db??pool(); const {p,prompts}=provider(plan,options.reply,options.fail);
  const result=await handleAgentMessage({pool:db,userId:'42',sessionId:'501',message,provider:p,voiceReply:options.voiceReply??false});
  return {result,db,prompts};
}

for(const message of [
  'Tell me what SehatMate can help me with today',
  'Which kinds of support does this assistant offer?',
  'Can you walk me through your available features?',
]) test(`app help uses server catalog, not patient tools: ${message}`,async()=>{
  for(const voiceReply of [false,true]) {
    const {result,db,prompts}=await turn(message,route('app_help'),{voiceReply,
      reply:'I can help explain verified care plans and supported care tasks.'});
    assert.equal(result.ok,true); assert.equal(result.fallbackCode,undefined);
    assert.equal(result.reply,'I can help explain verified care plans and supported care tasks.');
    assert.equal(db.queries.some(s=>s.includes('occurrence_date')||s.includes('FROM care_plans')),false);
    assert.equal(prompts.length,2); // Plan and shared selected-fact generation.
    assert.equal(result.navigation,null);
  }
});

for(const message of ['How are you doing this afternoon?','I appreciate having someone to talk to','Explain why a daily routine can be useful'])
test(`conversation has zero care tool calls: ${message}`,async()=>{
  const {result,db}=await turn(message,route('conversation'),{reply:'A consistent routine can help you stay organized.'});
  assert.equal(result.reply,'A consistent routine can help you stay organized.');
  assert.equal(db.queries.some(s=>s.includes('occurrence_date')||s.includes('FROM care_plans')),false);
});

test('ambiguous current question does not inherit a previous task query',async()=>{
  const db=pool();
  const first=await turn('What is my next task today?',route('patient_read',[taskCall]),{db,fail:true});
  assert.match(first.result.reply,/no pending care task/i);
  const before=db.queries.length;
  const second=await turn("What's happening?",route('ambiguous'),{db,reply:'Do you mean your care plan, or something else?'});
  assert.equal(second.result.reply,'Do you mean your care plan, or something else?');
  assert.doesNotMatch(second.result.reply,/no pending/);
  assert.equal(db.queries.slice(before).some(s=>s.includes('occurrence_date')),false);
});

for(const message of ['What is my next task today?','Do I have anything pending today?','Mera next task kia hai?'])
test(`true current task intent retains authoritative fallback: ${message}`,async()=>{
  const {result,db}=await turn(message,route('patient_read',[taskCall]),{fail:true});
  assert.match(result.reply,/no pending care task|pending care task nahi/i);
  assert.ok(db.queries.some(s=>s.includes('occurrence_date')));
  assert.ok(result.fallbackCode);
});

test('arbitrary planner task label and task result cannot authorize unrelated fallback',async()=>{
  const {result}=await turn('How are things going in general?',
    {...route('patient_read',[taskCall]),intent:'read_next_task'},{fail:true});
  assert.doesNotMatch(result.reply,/no pending care task/i);
  assert.ok(result.fallbackCode);
});

test('reproduces existing unrelated task fallback from a legacy model plan',async()=>{
  const {result}=await turn('What kinds of help are available?',
    {intent:'read_next_task',capabilityCalls:[taskCall],navigationIntent:null},{fail:true});
  assert.equal(result.ok,true);
  assert.doesNotMatch(result.reply,/no pending care task/i);
});

test('categories reject contradictory tool plans and unknown categories',()=>{
  for(const category of ['conversation','app_help','unsupported','ambiguous']) {
    const r=validateAgentPlan(route(category,[taskCall])); assert.equal(r.ok,false);
  }
  assert.equal(validateAgentPlan(route('invented_route')).ok,false);
  assert.equal(validateAgentPlan({...route('conversation'),navigationIntent:{target:'today',params:{}}}).ok,false);
  assert.equal(validateAgentPlan(route('action',[taskCall])).ok,false);
  assert.equal(validateAgentPlan(route('patient_read',[{name:'draft_next_task_outcome',args:{outcome:'completed'}}])).ok,false);
});

test('text and voice share conversation, clarification and patient-read routing',async()=>{
  for(const [message,category,calls,reply] of [
    ['How are things with you?','conversation',[],'I am here to help.'],
    ['What is going on?','ambiguous',[],'Do you mean your care or the app?'],
    ['Which task comes next today?','patient_read',[taskCall],'There are {{fact:c1_pendingToday}} pending tasks.'],
  ]) {
    const text=await turn(message,route(category,calls),{reply});
    const voice=await turn(message,route(category,calls),{reply,voiceReply:true});
    assert.equal(text.result.ok,true); assert.equal(voice.result.ok,true);
    assert.equal(text.result.reply,voice.result.reply);
    assert.equal(text.result.fallbackCode,undefined);
    assert.equal(voice.result.fallbackCode,undefined);
    assert.deepEqual(text.db.queries,voice.db.queries);
    assert.equal(text.prompts.length,2); assert.equal(voice.prompts.length,2);
  }
});

test('help/negated task questions cannot acquire fallback authority from a task plan',async()=>{
  for(const message of ['How can this app help me manage my next task today?',
    'Tell me about SehatMate support for pending tasks today',
    'Tell me how SehatMate can help with my next task today',
    'Aap aaj ke next task mein kya madad kar sakte hain?',
    'What is not my next task today?']) {
    const {result}=await turn(message,route('patient_read',[taskCall]),{fail:true});
    assert.doesNotMatch(result.reply,/no pending care task|pending care task nahi|زیرِ التوا/i);
  }
});

test('trivial conversation optimization is shared by text and voice',async()=>{
  for(const message of ['hello','thank you']) {
    const text=await turn(message,route('conversation'));
    const voice=await turn(message,route('conversation'),{voiceReply:true});
    assert.equal(text.result.reply,voice.result.reply);
    assert.equal(text.prompts.length,0); assert.equal(voice.prompts.length,0);
  }
});

test('localized help uses natural generation with server-owned product facts',async()=>{
  for(const [message,reply] of [['آپ کیا مدد کر سکتے ہیں؟','SehatMate تصدیق شدہ نگہداشت کے منصوبے سمجھنے میں مدد کر سکتا ہے۔'],
    ['Aap meri kis tarah madad kar sakte hain?','Main aap ke verified care plans samajhne mein madad kar sakta hoon.']]) {
    const {result,prompts}=await turn(message,route('app_help'),{reply});
    assert.equal(result.reply,reply); assert.equal(result.fallbackCode,undefined);
    assert.equal(prompts.length,2);
  }
});

test('provider plan must explicitly supply a valid semantic category',async()=>{
  const {p}=provider({intent:'read_next_task',capabilityCalls:[taskCall],navigationIntent:null});
  const r=await planAgentMessage({message:'Help me understand this app',provider:p});
  assert.equal(r.ok,false);
});

test('unsupported route cannot claim unsupported app features',async()=>{
  const {result,db}=await turn('Buy stock shares for me',route('unsupported'));
  assert.match(result.reply,/support|help|care/i);
  assert.equal(db.queries.some(s=>s.includes('occurrence_date')),false);
});

test('forbidden clinical changes retain the existing explicit safety denial',async()=>{
  const {result,db}=await turn('Increase my medicine dose',
    {...route('unsupported'),intent:'decline_change_request'});
  assert.equal(result.fallbackCode,'AGENT_PERMISSION_DENIED');
  assert.equal(db.queries.some(s=>s.includes('occurrence_date')),false);
});

test('zero-evidence conversation cannot invent patient facts',async()=>{
  const {result}=await turn('How are you?',route('conversation'),{reply:'You have no pending care task for today.'});
  assert.doesNotMatch(result.reply,/no pending care task/);
  assert.ok(result.fallbackCode);
});

test('zero-tool guard permits ordinary acknowledgements without patient claims',async()=>{
  const {result}=await turn('Can you explain routines?',route('conversation'),
    {reply:'You have asked a good question. A routine can make daily planning easier.'});
  assert.equal(result.reply,'You have asked a good question. A routine can make daily planning easier.');
  assert.equal(result.fallbackCode,undefined);
});

test('contradictory help plus patient-tool plans never reach capability execution',async()=>{
  const {result,db,prompts}=await turn('Explain the help available here',route('app_help',[taskCall]));
  assert.ok(result.fallbackCode);
  assert.equal(db.queries.some(s=>s.includes('occurrence_date')),false);
  assert.equal(prompts.length,2); // Existing one repair, then fail closed.
});

test('missing category can be repaired once without executing the rejected plan',async()=>{
  const db=pool(); let attempts=0;
  const p=createAgentProvider({generateJson:async({systemPrompt})=>{
    attempts++;
    if(systemPrompt.includes('planning stage')) return {json:attempts===1?
      {intent:'read_next_task',capabilityCalls:[taskCall],navigationIntent:null}:route('app_help')};
    return {json:{messageTemplate:'I can explain verified care plans.'}};
  }});
  const r=await handleAgentMessage({pool:db,userId:'42',sessionId:'501',message:'What help do you provide?',provider:p});
  assert.equal(r.ok,true); assert.equal(r.fallbackCode,undefined); assert.match(r.reply,/care plans/);
  assert.equal(attempts,3); assert.equal(db.queries.some(s=>s.includes('occurrence_date')),false);
});

test('reply diagnostics contain only fixed categories for all failure branches',async()=>{
  const cases=[
    [null,'PROVIDER'],[42,'INVALID_OUTPUT'],['آپ کی مدد کیسے کروں؟','LANGUAGE'],
    ['Your plan is {{fact:unknown}}.','FACT_UNKNOWN'],['Take 5 mg.','FACT_CONFLICT'],
    ['The backend failed; refresh required.','ZERO_EVIDENCE'],
  ];
  for(const [reply,marker] of cases) {
    const logs=[]; const original=console.info; console.info=(s)=>logs.push(s);
    try {
      const p={generateAgentReply:async()=>reply===null?{ok:false,code:'SECRET_ERROR',message:'PRIVATE_BODY'}:
        {ok:true,data:{json:typeof reply==='number'?{unexpected:reply}:{messageTemplate:reply}}}};
      const r=await generateGroundedAgentReply({provider:p,language:'en',message:'PRIVATE_USER_TEXT',category:'conversation'});
      assert.equal(r.ok,false); assert.deepEqual(logs,[`AGENT_REPLY_FAILURE:${marker}`]);
    } finally {console.info=original;}
  }
});
