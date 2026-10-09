import test from 'node:test';
import assert from 'node:assert/strict';
import {continueAgentWorkflow} from './agent/agent_workflow.js';
import {createAgentProvider} from './agent/agent_provider.js';
import {emptyAgentSessionState} from './agent/agent_session_state.js';
process.env.AGENT_ENABLED='true';

const context=()=>({screenId:'reality_check',ui:{screenId:'reality_check',route:'reality_check',version:'screen:9',entities:[],focusedSectionId:'question',
  targets:[{id:'question',kind:'section',label:'Your next question'},{id:'next',kind:'control',label:'Next'}],
  actions:[{id:'show',kind:'highlight',targetId:'question'},{id:'next',kind:'next',targetId:'next'}]}});
function fixture({receipt=true,depth=0,foreign=false,current=context(),operations=[{actionId:'show',targetId:'question',args:{}}],calls=[],navigation=null}={}) {
  let stored={id:'issued-plan',screenId:'reality_check',version:'screen:8',continuationDepth:depth,
    operations:[{actionId:'advance',targetId:'old-next',args:{},riskTier:2}]};
  const queries=[],prompts=[];
  const execute=async(sql,params=[])=>{
    const s=String(sql).replace(/\s+/g,' ');queries.push({sql:s,params});
    if(s.startsWith('SELECT preferred_language')) return [[{preferred_language:'Roman Urdu'}]];
    if(s.startsWith('SELECT plan_json')) return [foreign?[]:[{plan_json:JSON.stringify(stored),screen_version:'screen:8'}]];
    if(s.startsWith('SELECT result_status')) return [receipt?[{result_status:'succeeded',screen_version_before:'screen:8',screen_version_after:'screen:9'}]:[]];
    if(s.includes('SELECT c.context_json')) return [current?[{context_json:JSON.stringify(current)}]:[]];
    if(s.startsWith('SELECT id, user_id')) return [[{id:501,user_id:42,language:'roman_ur',state_json:JSON.stringify(emptyAgentSessionState()),created_at:'2026-09-03 10:00:00',last_active_at:'2026-09-03 10:00:00',expires_at:'2099-01-01 00:00:00'}]];
    if(s.startsWith('UPDATE agent_copilot_plans SET plan_json')) {
      if(params.length===5&&params[4]!==JSON.stringify(stored)) return [{affectedRows:0}];
      stored=JSON.parse(params[0]);return [{affectedRows:1}];
    }
    if(s.startsWith('SELECT id FROM agent_sessions')) return [[{id:501}]];
    return /^SELECT/.test(s)?[[]]:[{affectedRows:1}];
  };
  const provider=createAgentProvider({generateJson:async args=>{
    prompts.push(args);
    return {model:'fixture',json:args.systemPrompt.includes('planning stage')?
      {category:'ui_guidance',intent:'explain_next_step',capabilityCalls:calls,navigationIntent:navigation,uiOperations:operations}:
      {messageTemplate:'Yeh agla sawal aap ki routine ko samajhne ke liye hai.'}};
  }});
  return {db:{execute},provider,queries,prompts,get stored(){return stored;}};
}
const run=f=>continueAgentWorkflow({db:f.db,userId:'42',sessionId:'501',planId:'issued-plan',context:context(),source:'voice',provider:f.provider});
test('successful local transition gets bounded read guidance through the existing planner',async()=>{
  const f=fixture(),r=await run(f);assert.equal(r.ok,true);assert.equal(r.language,'roman_ur');assert.equal(r.uiPlan?.version,'screen:9');
  assert.equal(r.uiPlan.continuationDepth,1);assert.equal(r.uiPlan.operations[0].riskTier,0);assert.equal(f.prompts.length,2);
  assert.match(f.prompts[0].userPrompt,/Server workflow event/);assert.doesNotMatch(f.prompts[0].userPrompt,/User message \(untrusted text\):/);
});
test('continuation replay reuses the persisted result rather than another provider call',async()=>{
  const f=fixture(),a=await run(f),b=await run(f);assert.deepEqual(b,a);assert.equal(f.prompts.length,2);
});
for(const [name,options,code] of [
  ['foreign issued plan',{foreign:true},'AGENT_WORKFLOW_NOT_FOUND'],
  ['unacknowledged transition',{receipt:false},'AGENT_WORKFLOW_RECEIPT_REQUIRED'],
  ['bounded maximum depth',{depth:4},'AGENT_WORKFLOW_LIMIT'],
  ['stale current context',{current:{...context(),ui:{...context().ui,version:'screen:10'}}},'AGENT_UI_STALE_CONTEXT'],
  ['expired context',{current:null},'AGENT_UI_STALE_CONTEXT'],
]) test(`workflow rejects ${name} before planning`,async()=>{
  const f=fixture(options);await assert.rejects(run(f),e=>e.code===code);assert.equal(f.prompts.length,0);
});
test('automatic continuation cannot select or persist another answer',async()=>{
  const f=fixture({operations:[{actionId:'next',targetId:'next',args:{}}]});
  await assert.rejects(run(f),e=>e.code==='AGENT_WORKFLOW_ACTION_NOT_ALLOWED');
  assert.equal(f.prompts.length,1);assert.equal(f.queries.some(q=>q.sql.startsWith('INSERT INTO agent_copilot_plans')),false);
});
test('a user-driven next turn is required for new backend actions or navigation',async()=>{
  const f=fixture({navigation:{target:'home',params:{}}});
  await assert.rejects(run(f),e=>e.code==='AGENT_WORKFLOW_ACTION_NOT_ALLOWED');assert.ok(f.prompts.length<=2);
  assert.ok(f.prompts.every(p=>p.systemPrompt.includes('planning stage')));
});
test('failed or missing receipt cannot be presented as a backend business confirmation',async()=>{
  const f=fixture();const r=await run(f);
  assert.equal(r.confirmation,null);assert.equal(r.actionStatus,null);
  assert.match(f.prompts[0].userPrompt,/client-claimed UI transition/);
  assert.doesNotMatch(f.prompts[0].userPrompt,/backendConfirmed":true/);
});
test('concurrent continuation requests claim the issued plan once',async()=>{
  const f=fixture(),results=await Promise.allSettled([run(f),run(f)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'AGENT_WORKFLOW_ALREADY_RUNNING');
  assert.equal(f.prompts.length,2);
});
test('invalid supplied registry is rejected without provider calls',async()=>{
  const f=fixture();
  await assert.rejects(continueAgentWorkflow({db:f.db,userId:'42',sessionId:'501',planId:'issued-plan',context:{...context(),ui:{...context().ui,actions:[{id:'fake',kind:'invoke_method',targetId:'question'}]}},provider:f.provider}),e=>e.code==='AGENT_UI_INVALID_CONTEXT');
  assert.equal(f.prompts.length,0);
});
