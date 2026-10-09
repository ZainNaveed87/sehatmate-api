import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAgentUiContext, validateAgentUiOperations, buildAgentUiPlan, uiActionRiskTier} from './agent/agent_ui_protocol.js';

test('screen metadata is closed and persisted settings and Previous require confirmation',()=>{
  const c={screenId:'settings',route:'settings',version:'test:1',entities:[],targets:[{id:'settings.language',kind:'control',label:'Language',sectionId:'language',help:'Choose the Agent reply language.',value:'roman_ur',visible:true,enabled:true}],actions:[{id:'settings.language.roman_ur',kind:'set_language',targetId:'settings.language'}]};
  assert.equal(validateAgentUiContext(c).ok,true);
  assert.equal(uiActionRiskTier('set_language','settings'),2);
  assert.equal(uiActionRiskTier('previous','reality_check'),2);
  assert.equal(validateAgentUiContext({...c,actions:[{...c.actions[0],id:'settings.language.invented'}]}).ok,false);
  assert.equal(validateAgentUiContext({...c,targets:[{...c.targets[0],value:{secret:'no'}}]}).ok,false);
});

export const context = () => ({screenId:'reality_check',route:'reality_check',version:'mount-1:8',focusedSectionId:'reality_check.question.current',entities:[],
  targets:[{id:'reality_check.question.current',kind:'section',label:'Morning availability'},
    {id:'reality_check.option.timing_difficult',kind:'option',label:'This timing is difficult',selected:false},
    {id:'reality_check.next',kind:'control',label:'Next'}],
  actions:[{id:'explain',kind:'highlight',targetId:'reality_check.question.current'},
    {id:'choose',kind:'select_option',targetId:'reality_check.option.timing_difficult'},
    {id:'advance',kind:'next',targetId:'reality_check.next'}]});
const operation = (actionId='choose',targetId='reality_check.option.timing_difficult') => ({actionId,targetId,args:{}});

test('bounded UI snapshot accepts registered choices without treating labels as patient facts',()=>{
  const result=validateAgentUiContext(context()); assert.equal(result.ok,true); assert.equal(result.context.version,'mount-1:8');
  assert.equal(result.context.targets[1].label,'This timing is difficult');
});
for(const [name,change] of [
  ['unknown snapshot field',c=>({...c,patientDiagnosis:'invented'})],
  ['invented route',c=>({...c,route:'/admin'})],
  ['unknown screen',c=>({...c,screenId:'admin'})],
  ['prototype route',c=>({...c,route:'constructor'})],
  ['missing version',c=>({...c,version:''})],
  ['duplicate target',c=>({...c,targets:[...c.targets,c.targets[0]]})],
  ['unknown action kind',c=>({...c,actions:[{id:'inject',kind:'invoke_method',targetId:c.targets[0].id}]})],
  ['unregistered action target',c=>({...c,actions:[{id:'inject',kind:'highlight',targetId:'missing'}]})],
  ['too many targets',c=>({...c,targets:Array.from({length:21},(_,i)=>({id:`target.${i}`,kind:'section',label:'Item'}))})],
  ['oversized UI context',c=>({...c,targets:Array.from({length:20},(_,i)=>({id:`target.${i}`,kind:'section',label:'a'.repeat(240)}))})],
  ['untrusted risk grant',c=>({...c,actions:[{...c.actions[1],riskTier:0}]})],
]) test(`snapshot rejects ${name}`,()=>assert.equal(validateAgentUiContext(change(context())).ok,false));

test('UI plan validates closed action and target together and derives persistence confirmation',()=>{
  const c=context(), result=validateAgentUiOperations([operation()],c); assert.equal(result.ok,true);
  const plan=buildAgentUiPlan({context:c,operations:result.operations});
  assert.equal(plan.screenId,'reality_check'); assert.equal(plan.version,'mount-1:8'); assert.equal(plan.operations[0].riskTier,2);
});
for(const [name,ops] of [
  ['unknown action',[operation('invented')]], ['unknown target',[operation('choose','absent')]],
  ['wrong registered target',[operation('choose','reality_check.next')]],
  ['arbitrary argument',[{...operation(),args:{dose:20}}]],
  ['unknown operation field',[{...operation(),script:'unsafe'}]],
  ['unbounded plan',Array.from({length:5},()=>operation())],
]) test(`operations reject ${name}`,()=>assert.equal(validateAgentUiOperations(ops,context()).ok,false));

test('no context cannot authorize a client operation',()=>assert.equal(validateAgentUiOperations([operation()],null).ok,false));
test('empty optional operations preserve legacy turns',()=>assert.deepEqual(validateAgentUiOperations([],null),{ok:true,operations:[]}));
test('safe reads and highlights do not require write confirmation',()=>assert.equal(uiActionRiskTier('highlight','reality_check'),0));
test('Reality Check advance retains confirmation because existing Next persists answers',()=>assert.equal(uiActionRiskTier('next','reality_check'),2));
test('medical UI mutation is never executable',()=>assert.equal(validateAgentUiContext({...context(),actions:[{id:'dose',kind:'change_medication',targetId:'reality_check.next'}]}).ok,false));
test('real shell navigation snapshot accepts only registered semantic routes',()=>{
  const c={...context(),targets:[...context().targets,{id:'navigation.home',kind:'navigation',label:'Home'}],
    actions:[...context().actions,{id:'navigation.home.open',kind:'navigate_to_registered_route',targetId:'navigation.home'}]};
  assert.equal(validateAgentUiContext(c).ok,true);
  assert.equal(validateAgentUiOperations([{actionId:'navigation.home.open',targetId:'navigation.home',args:{}}],c).ok,true);
  const p=buildAgentUiPlan({context:c,operations:[{actionId:'navigation.home.open',targetId:'navigation.home',args:{}}]});
  assert.equal(p.operations[0].riskTier,1);
});
for(const route of ['invented','care_plan_detail','constructor']) test(`UI navigation rejects unregistered or entity-parameter route ${route}`,()=>{
  const targetId=`navigation.${route}`;
  const c={...context(),targets:[{id:targetId,kind:'navigation',label:'Open'}],focusedSectionId:targetId,
    actions:[{id:'open',kind:'navigate_to_registered_route',targetId}]};
  assert.equal(validateAgentUiContext(c).ok,false);
});
test('actual Care Gap card can open only its registered entity callback',()=>{
  const c={screenId:'care_gaps',route:'care_gaps',version:'screen:9',entities:[{type:'care_plan',id:'9'}],
    targets:[{id:'care_gaps.card.17',kind:'section',label:'Review your routine'}],actions:[{id:'care_gaps.card.17.open',kind:'open_entity',targetId:'care_gaps.card.17'}]};
  assert.equal(validateAgentUiContext(c).ok,true);
  const plan=buildAgentUiPlan({context:c,operations:[{actionId:'care_gaps.card.17.open',targetId:'care_gaps.card.17',args:{}}]});
  assert.equal(plan.operations[0].riskTier,1);
  assert.equal(validateAgentUiContext({...c,screenId:'profile',route:'profile'}).ok,false);
});
test('actual Reality Check question and button target kinds round-trip to the planner',()=>{
  const c=context();c.targets[0].kind='question';c.targets[2].kind='button';
  assert.equal(validateAgentUiContext(c).ok,true);
  assert.equal(buildAgentUiPlan({context:c,operations:[operation()]}).operations[0].riskTier,2);
});
