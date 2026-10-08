import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAgentPlan,buildAgentPlannerPrompts,planAgentMessage} from './agent/agent_planner.js';
import {createAgentProvider} from './agent/agent_provider.js';

const ui={screenId:'reality_check',route:'reality_check',version:'screen:8',focusedSectionId:'question',entities:[],
  targets:[{id:'question',kind:'section',label:'Availability'},{id:'option.difficult',kind:'option',label:'This timing is difficult'}],
  actions:[{id:'show',kind:'highlight',targetId:'question'},{id:'choose',kind:'select_option',targetId:'option.difficult'}]};
const plan={category:'ui_guidance',intent:'guide_current_question',capabilityCalls:[],navigationIntent:null,
  uiOperations:[{actionId:'choose',targetId:'option.difficult',args:{}}]};
test('planner accepts a semantic choice only against the supplied closed registry',()=>{
  const r=validateAgentPlan(plan,{uiContext:ui}); assert.equal(r.ok,true); assert.equal(r.plan.uiOperations[0].targetId,'option.difficult');
});
test('planner fails closed when an operation has no matching current context',()=>assert.equal(validateAgentPlan(plan).ok,false));
test('planner rejects hallucinated UI capability even alongside a valid conversation',()=>{
  assert.equal(validateAgentPlan({...plan,uiOperations:[{actionId:'delete_everything',targetId:'question',args:{}}]},{uiContext:ui}).ok,false);
});
test('UI guidance cannot disguise a clinical backend write',()=>{
  assert.equal(validateAgentPlan({...plan,capabilityCalls:[{name:'change_dose',args:{dose:20}}]},{uiContext:ui}).ok,false);
});
test('UI guide output requires at least one registered operation',()=>assert.equal(validateAgentPlan({...plan,uiOperations:[]},{uiContext:ui}).ok,false));
test('legacy conversation plan retains its previous shape',()=>assert.deepEqual(validateAgentPlan({category:'conversation',intent:'greeting'}).plan,
  {category:'conversation',intent:'greeting',capabilityCalls:[],navigationIntent:null}));
test('explicit stable non-clinical memory can only be proposed for user review',()=>{
  const memoryProposal={kind:'USER_PREFERENCE',key:'explanation.detail',value:{level:'step_by_step'}};
  const r=validateAgentPlan({category:'conversation',intent:'preference',memoryProposal});
  assert.equal(r.ok,true);assert.deepEqual(r.plan.memoryProposal,memoryProposal);
});
test('model speculation cannot become a memory proposal',()=>{
  for(const memoryProposal of [{kind:'INFERRED_PATTERN',key:'routine.missed_pattern',value:{periodDays:7,missedCount:5,timeOfDay:'morning'}},
    {kind:'CONFIRMED_FACT',key:'diagnosis',value:{condition:'invented'}}]) {
    assert.equal(validateAgentPlan({category:'conversation',intent:'preference',memoryProposal}).ok,false);
  }
});
test('provider semantic choice passes through the normal single planning call',async()=>{
  let calls=0; const provider=createAgentProvider({generateJson:async()=>{calls++;return {json:plan,model:'test'};}});
  const r=await planAgentMessage({provider,message:'This is difficult for me',contextSlice:{clientUi:ui}});
  assert.equal(r.ok,true);assert.equal(calls,1);
});
test('planning prompt separates untrusted UI labels from patient evidence and stays provider bounded',()=>{
  const prompts=buildAgentPlannerPrompts({message:'Explain this',contextSlice:{clientUi:ui}});
  assert.match(prompts.systemPrompt,/UI.*untrusted|untrusted.*UI/i);
  assert.ok(prompts.systemPrompt.length<=4000); assert.ok(prompts.userPrompt.length<=16000);
});
