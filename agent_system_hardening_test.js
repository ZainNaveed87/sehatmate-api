import test from 'node:test';
import assert from 'node:assert/strict';
import './agent/agent_read_tools.js';
import './agent/agent_draft_tools.js';
import './agent/agent_care_plan_tools.js';
import {generateGroundedAgentReply} from './agent/agent_response_grounder.js';
import {createAgentProvider} from './agent/agent_provider.js';
import {listAgentCapabilities,resolveAgentCapability,validateAgentCapabilityInput,defineAgentCapability,executeConfirmedAgentCapability} from './agent/agent_capability_registry.js';
import {confirmScheduleItem} from './services/schedule_confirm_service.js';
import {listAgentNavigationTargets} from './agent/agent_navigation_registry.js';
import {buildAgentProductContext} from './agent/agent_product_context.js';
import {createAgentMemory,readRelevantAgentMemory,AGENT_MEMORY_KEYS} from './agent/agent_memory.js';
import {CopilotTestDb} from './agent_copilot_test_db.js';

const provider = reply => createAgentProvider({generateJson:async()=>({json:{messageTemplate:reply}})});
for (const verb of ['created','updated','renamed','deleted','removed','completed','cancelled','scheduled','rescheduled','uploaded','sent','submitted','confirmed']) {
 test(`READ evidence cannot authorize a ${verb} success claim`,async()=>{
  const result=await generateGroundedAgentReply({provider:provider(`I ${verb} your item.`),language:'en',message:'Tell me about this item',category:'patient_read',capabilityResults:[{name:'get_care_plans',result:{ok:true,data:{plans:[]}}}]});
  assert.equal(result.ok,false);assert.equal(result.code,'AGENT_ACTION_RECEIPT_REQUIRED');
 });
}
for(const reply of ['Your appointment has been scheduled.','Done, the document is now uploaded.','Maine aap ka plan bana diya hai.','آپ کا کام مکمل کر دیا ہے۔']) test(`no-tool reply cannot attest an unexecuted action: ${reply}`,async()=>{
 const language=reply.startsWith('Maine')?'roman_ur':reply.startsWith('آپ')?'ur':'en';
 const result=await generateGroundedAgentReply({provider:provider(reply),language,message:'Help me',category:'conversation'});
 assert.equal(result.ok,false);assert.equal(result.code,'AGENT_ACTION_RECEIPT_REQUIRED');
});
for(const reply of ['I can help you create an item after confirmation.','I did not delete anything.','You can inspect previous items.','Your task is {{fact:c1_status}}.']) test(`read/explanation does not become a write claim: ${reply}`,async()=>{
 const result=await generateGroundedAgentReply({provider:provider(reply),language:'en',message:'Explain',category:'patient_read',capabilityResults:[{name:'get_care_plan',result:{ok:true,data:{status:'completed'}}}]});
 assert.equal(result.ok,true,result.code);
});
test('catalog includes every ordinarily executable tool and navigation exactly once',()=>{
 const facts=buildAgentProductContext().facts;
 for(const c of listAgentCapabilities()){
  assert.equal(typeof resolveAgentCapability(c.name).execute,'function');
  assert.ok(resolveAgentCapability(c.name).resultContract);
  if(['READ','DRAFT'].includes(c.permissionClass))assert.equal(facts.filter(f=>f.id===`cap_${c.name}`).length,1,c.name);
  else assert.equal(facts.filter(f=>f.id===`cap_${c.name}`).length,0,c.name);
 }
 for(const n of listAgentNavigationTargets())assert.equal(facts.filter(f=>f.id===`nav_${n.target}`).length,1,n.target);
});
test('unmounted family-only pages are not advertised as executable destinations',()=>{
 const targets=listAgentNavigationTargets().map(n=>n.target);
 assert.equal(targets.includes('family_member_care_gaps'),false);
 assert.equal(targets.includes('family_member_simulation'),false);
 assert.ok(resolveAgentCapability('family_member_care_gaps'));
 assert.ok(resolveAgentCapability('family_member_simulation'));
});
for(const [key,value] of [['communication.language',{language:'en'}],['workflow.preference',{mode:'guided'}],['explanation.detail',{level:'brief'}]]) test(`memory API retries reuse the account receipt for ${key}`,async()=>{
 const db=new CopilotTestDb();
 const save=ref=>createAgentMemory({db,userId:'1',item:{kind:'USER_PREFERENCE',key,value,source:'user_api',evidenceRef:ref,confirmedByUser:true},evidence:{explicitUser:true,ref}});
 const first=await save('request:first'),second=await save('request:retry');
 assert.equal(second.memory.id,first.memory.id);assert.equal(db.memory.length,1);
 const shown=await readRelevantAgentMemory({db,userId:'1',review:true});assert.equal(shown[0].id,first.memory.id);
 assert.deepEqual(await readRelevantAgentMemory({db,userId:'2',review:true}),[]);
});
test('every allowed memory class has an explicit nonempty read scope and rejects arbitrary payload',()=>{
 for(const [key,definition] of Object.entries(AGENT_MEMORY_KEYS)){
  assert.ok(definition.screens.length,key);assert.equal(definition.validate({secret:'not permitted'}),false,key);
 }
});
test('bounded string arguments reject trailing content rather than silently changing consequential intent',()=>{
 assert.equal(validateAgentCapabilityInput(resolveAgentCapability('draft_schedule_time'),{itemId:'1',scheduleTime:'08:00'}).ok,true);
 assert.equal(validateAgentCapabilityInput(resolveAgentCapability('draft_schedule_time'),{itemId:'1',scheduleTime:'08:00 then skip'}).ok,false);
 assert.equal(validateAgentCapabilityInput(resolveAgentCapability('draft_task_outcome'),{occurrenceId:'1',outcome:'completed',note:'x'.repeat(201)}).ok,false);
});
test('reminder confirmation rolls back item time when occurrence update fails',async()=>{
 let time=null,snapshot,commits=0,rollbacks=0,releases=0;
 const connection={beginTransaction:async()=>{snapshot=time;},commit:async()=>{commits++;},rollback:async()=>{time=snapshot;rollbacks++;},release:()=>{releases++;},execute:async sql=>{
  const text=sql.replace(/\s+/g,' ');
  if(text.includes('SELECT s.id, s.care_plan_id'))return [[{id:1,care_plan_id:1,schedule_time:time,title:'Reminder',grounding:'suggested',instruction:'After breakfast',timing:'morning'}]];
  if(text.startsWith('UPDATE care_schedule_items')){time='08:00';return [{affectedRows:1}];}
  if(text.startsWith('UPDATE care_task_occurrences'))throw new Error('simulated storage failure');
  return [[]];
 }};
 const pool={execute:connection.execute,getConnection:async()=>connection};
 await assert.rejects(confirmScheduleItem({pool,userId:'1',itemId:'1',scheduleTime:'08:00',displayTime:'Morning',learningSource:'ai_suggestion_accept'}));
 assert.equal(time,null);assert.equal(commits,0);assert.equal(rollbacks,1);assert.equal(releases,1);
});
test('every confirmed executor declares confirmation, readback and executable receipt validation',()=>{
 for(const item of listAgentCapabilities().filter(c=>c.permissionClass==='REVERSIBLE_USER_ACTION')){
  const contract=resolveAgentCapability(item.name).effectContract;
  assert.ok(contract,item.name);assert.equal(typeof contract.validateResult,'function');
  assert.ok(resolveAgentCapability(contract.readTool),contract.readTool);
  assert.ok(['task_outcome','schedule_time','create_care_plan'].includes(contract.confirmationKind));
 }
});
test('new consequential registrations cannot omit their confirmation/result contract',()=>{
 assert.throws(()=>defineAgentCapability({name:'unreceipted_future_write',permissionClass:'REVERSIBLE_USER_ACTION',description:'A future write',inputSchema:{properties:{},required:[]},execute:async()=>({ok:true}),resultContract:'An unvalidated success'}));
});
for(const name of ['set_task_outcome','confirm_schedule_item_time','create_care_plan'])test(`a bare success packet is not a receipt for ${name}`,()=>{
 assert.equal(resolveAgentCapability(name).effectContract.validateResult({ok:true},{occurrenceId:'1',outcome:'completed',scheduleTime:'08:00',title:'Plan'},'1'),false);
});
test('confirmed execution rejects an unverified result before presenting success',async()=>{
 defineAgentCapability({name:'invalid_receipt_control',permissionClass:'REVERSIBLE_USER_ACTION',description:'Test receipt validation',inputSchema:{properties:{},required:[]},resultContract:'A verified result',effectContract:{confirmationKind:'task_outcome',readTool:'get_today_tasks',validateResult:()=>false},execute:async()=>({ok:true})});
 assert.deepEqual(await executeConfirmedAgentCapability({name:'invalid_receipt_control',pool:{},userId:'1',args:{}}),{ok:false,code:'AGENT_ACTION_RESULT_UNVERIFIED'});
});
