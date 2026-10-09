import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAgentMessage} from './agent/agent_core.js';
import {buildAgentPlannerPrompts, buildAgentPlannerRepairPrompt, planAgentMessage} from './agent/agent_planner.js';
import {AGENT_PROVIDER_LIMITS, createAgentProvider} from './agent/agent_provider.js';
import {emptyAgentSessionState} from './agent/agent_session_state.js';
import {validateCopilotClientContext} from './agent/agent_ui_protocol.js';
import {validateTaskWorkflow} from './agent/agent_task_workflow.js';
import {listAgentNavigationTargets} from './agent/agent_navigation_registry.js';
import {buildAgentProductContext} from './agent/agent_product_context.js';

process.env.AGENT_ENABLED='true';
function screenContext() {
  const context={screenId:'home',ui:{screenId:'home',route:'home',version:'mounted:1',entities:[],targets:[],actions:[]}};
  for(let i=0;i<8;i++) {
    context.ui.targets.push({id:`section.${i}`,kind:'section',label:'Screen section '.repeat(15),help:'Read this visible section only.'});
    context.ui.actions.push({id:`read.${i}`,kind:'read_section',targetId:`section.${i}`});
  }
  // Fill the last valid target to just below the transmitted 4096-byte bound.
  for(const target of context.ui.targets) while(Buffer.byteLength(JSON.stringify(context))<4080 && target.label.length<480) target.label+='x';
  assert.equal(validateCopilotClientContext(context).ok,true);
  assert.ok(Buffer.byteLength(JSON.stringify(context))>3900);
  return context;
}
function fixture() {
  let state=emptyAgentSessionState();
  const pool={async execute(sql,args) {
    if(sql.includes('SELECT preferred_language'))return [[{preferred_language:'English'}]];
    if(sql.includes('SELECT')&&sql.includes('FROM agent_sessions'))return [[{id:501,user_id:42,state_json:JSON.stringify(state),language:'en',expires_at:'2999-01-01'}]];
    if(sql.includes('UPDATE agent_sessions')) {
      if(sql.includes('state_json = ?'))state=JSON.parse(args[0]);
      return [{affectedRows:1}];
    }
    if(sql.includes('agent_copilot_contexts')||sql.includes('agent_memory')||sql.includes('family_relationships'))return [[]];
    throw Error('Unexpected prompt regression query');
  }};
  return {pool};
}
for(const message of ['care plan banane main madad kro','create a care plan','help me create a care plan']) {
  test(`mounted near-limit context starts authoritative workflow: ${message}`,async()=>{
    const f=fixture(),clientContext=screenContext();let calls=0;
    const provider=createAgentProvider({generateJson:async({systemPrompt,userPrompt})=>{
      calls++;assert.ok(systemPrompt.length<=4000);assert.ok(userPrompt.length<=16000);
      assert.ok(userPrompt.includes(message));
      return {json:{category:'task_workflow',intent:'create_care_plan',capabilityCalls:[],taskCommand:{kind:'start',workflowKind:'create_care_plan'}}};
    }});
    const base={pool:f.pool,userId:'42',sessionId:'501',clientContext};
    const result=await handleAgentMessage({...base,message,provider});
    assert.notEqual(result.fallbackCode,'AGENT_PROMPT_TOO_LARGE');
    assert.equal(result.ok,true);assert.equal(result.taskWorkflow?.status,'collecting');
    assert.equal(calls,1);assert.equal(result.confirmation,null);
    const named=await handleAgentMessage({...base,message:'Title My Plan',provider:createAgentProvider({generateJson:async()=>({json:{category:'task_workflow',intent:'name_plan',capabilityCalls:[],taskCommand:{kind:'update',fieldSpans:{title:{start:6,end:13}}}}})})});
    assert.notEqual(named.fallbackCode,'AGENT_PROMPT_TOO_LARGE');
    assert.equal(named.taskWorkflow?.status,'awaiting_confirmation');assert.equal(named.taskWorkflow?.fields.title,'My Plan');
    assert.ok(named.confirmation?.confirmationId);
  });
}
test('full user message, near-limit UI, workflow and bounded optional history fit unchanged provider limits',async()=>{
  const message='x'.repeat(2000), clientUi=screenContext().ui;
  const contextSlice={language:'en',clientUi,screenId:'home',currentEntity:null,
    taskWorkflow:{workflowId:'w'.repeat(80),kind:'create_care_plan',revision:10000,status:'awaiting_confirmation',fields:{title:'t'.repeat(80)},confirmationId:'c'.repeat(80),expiresAt:'2999-01-01T00:00:00.000Z'},
    currentFocus:{type:'care_plan',id:'12'},referenceResolution:{status:'resolved',entity:{type:'care_plan',id:'12'}},
    familyMembers:Array.from({length:10},(_,i)=>({type:'family_member',id:String(i+1),title:'x'.repeat(200)})),
    recentEntities:Array.from({length:5},(_,i)=>({type:'care_plan',id:String(i+1)})),
    lastActionSummary:'x'.repeat(500),relevantMemory:Array.from({length:8},()=>({id:'1',kind:'USER_PREFERENCE',key:'explanation.detail',value:{level:'brief'},evidenceRef:'x'.repeat(191),source:'user_confirmation',confirmedByUser:true}))};
  assert.ok(validateTaskWorkflow(contextSlice.taskWorkflow));
  const prompts=buildAgentPlannerPrompts({message,contextSlice});
  assert.ok(prompts.systemPrompt.length<=AGENT_PROVIDER_LIMITS.systemPromptMaxChars);
  assert.ok(prompts.userPrompt.length<=AGENT_PROVIDER_LIMITS.userPromptMaxChars,`${prompts.userPrompt.length}`);
  assert.ok(prompts.userPrompt.includes(message));assert.ok(prompts.userPrompt.includes(JSON.stringify(clientUi)));
  assert.ok(prompts.userPrompt.includes(JSON.stringify(contextSlice.taskWorkflow)));
  assert.ok(prompts.userPrompt.includes(JSON.stringify(contextSlice.referenceResolution)));
  const repaired=buildAgentPlannerRepairPrompt({message,contextSlice,failureCode:'AGENT_PLAN_INVALID'});
  assert.ok(repaired.includes(message),'repair must preserve the full original user message');
  assert.ok(repaired.includes(JSON.stringify(clientUi)));assert.ok(repaired.includes(JSON.stringify(contextSlice.taskWorkflow)));
  assert.ok(repaired.length<=16000);
  const result=await planAgentMessage({message,contextSlice,provider:createAgentProvider({generateJson:async()=>({json:{category:'task_workflow',intent:'create_care_plan',capabilityCalls:[],taskCommand:{kind:'start',workflowKind:'create_care_plan'}}})})});
  assert.equal(result.ok,true,result.code);
});
test('compact planner retains every grounding fact ID and every independent closed navigation target',()=>{
  const {userPrompt}=buildAgentPlannerPrompts({message:'Explain the app'});
  for(const fact of buildAgentProductContext().facts) assert.ok(userPrompt.includes(JSON.stringify(fact.id)),fact.id);
  for(const route of listAgentNavigationTargets()) assert.ok(userPrompt.includes(JSON.stringify([route.target,route.params])),route.target);
  for(const fact of buildAgentProductContext().facts.filter(f=>f.kind==='boundary')) assert.ok(userPrompt.includes(fact.description));
});
