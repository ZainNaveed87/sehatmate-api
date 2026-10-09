import test from 'node:test';
import assert from 'node:assert/strict';
import {executeConfirmedTaskWorkflow} from './agent/agent_care_plan_tools.js';
import {reduceTaskWorkflow} from './agent/agent_task_workflow.js';
import {emptyAgentSessionState} from './agent/agent_session_state.js';
function fixture({failSave=false,failCommit=false}={}) {
 const workflow=reduceTaskWorkflow({command:{kind:'start',workflowKind:'create_care_plan',fieldSpans:{title:{start:0,end:3}}},message:'Ali'}).workflow;
 let state={...emptyAgentSessionState(),taskWorkflow:workflow},plans=[],tail=Promise.resolve(),inserts=0;
 const pool={async getConnection(){let releaseLock;const before=tail;tail=new Promise(r=>releaseLock=r);let draftState,draftPlans;
 return {async beginTransaction(){await before;draftState=structuredClone(state);draftPlans=structuredClone(plans);},async execute(sql,args){
 if(sql.includes('FROM agent_sessions'))return [[{state_json:JSON.stringify(draftState)}]];
 if(sql.includes('title_key')){if(sql.startsWith('SELECT'))return [[...draftPlans.filter(p=>p.title_key===args[1])]];inserts++;draftPlans.push({id:inserts,user_id:args[0],title:args[1],title_key:args[2],status:'draft',setup_step:'upload'});return [{insertId:inserts}];}
 if(sql.includes('SELECT * FROM care_plans'))return [[...draftPlans.filter(p=>p.id===args[0])]];
 if(sql.includes('UPDATE agent_sessions')){if(failSave)throw Error('not logged');draftState=JSON.parse(args[0]);return [{affectedRows:1}];}
 throw Error('unexpected mock query');},async commit(){if(failCommit)throw Error('not logged');state=draftState;plans=draftPlans;},async rollback(){},release(){releaseLock();}};}};
 return {pool,workflow,args:{pool,userId:'42',sessionId:'501',confirmationId:workflow.confirmationId,workflowId:workflow.workflowId,revision:workflow.revision},plans:()=>plans,state:()=>state,inserts:()=>inserts};
}
test('simultaneous text/voice confirmations and lost response replay one committed plan',async()=>{
 const f=fixture();const results=await Promise.all([executeConfirmedTaskWorkflow(f.args),executeConfirmedTaskWorkflow(f.args)]);
 assert.equal(results.every(r=>r.ok),true);assert.equal(f.plans().length,1);assert.equal(f.inserts(),1);assert.equal(results[0].workflow.completedReceipt.planId,results[1].workflow.completedReceipt.planId);
 assert.equal((await executeConfirmedTaskWorkflow(f.args)).replayed,true);assert.equal(f.inserts(),1);
});
for(const option of ['failSave','failCommit'])test(`${option} rolls back insertion and preserves pending confirmation`,async()=>{
 const f=fixture({[option]:true});await assert.rejects(executeConfirmedTaskWorkflow(f.args));assert.equal(f.plans().length,0);assert.equal(f.state().taskWorkflow.status,'awaiting_confirmation');
});
test('stale, expired and missing confirmation make no inserts',async()=>{
 const f=fixture();for(const args of [{confirmationId:'old'},{revision:1},{now:new Date('2999-01-01')}]){assert.equal((await executeConfirmedTaskWorkflow({...f.args,...args})).ok,false);assert.equal(f.inserts(),0);}
});
