import test from 'node:test';
import assert from 'node:assert/strict';
import {reduceTaskWorkflow,validateTaskWorkflow} from './agent/agent_task_workflow.js';
test('title only workflow collects, corrects, invalidates confirmation and survives resume',()=>{
 const start=reduceTaskWorkflow({current:null,command:{kind:'start',workflowKind:'create_care_plan'},message:'Care plan banao',language:'roman_ur'});
 assert.equal(start.ok,true);assert.equal(start.workflow.status,'collecting');assert.match(start.reply,/naam/);
 const filled=reduceTaskWorkflow({current:start.workflow,command:{kind:'update',fieldSpans:{title:{start:5,end:9}}},message:'Naam Zain',language:'roman_ur'});
 assert.equal(filled.workflow.fields.title,'Zain');assert.equal(filled.workflow.status,'awaiting_confirmation');
 const corrected=reduceTaskWorkflow({current:filled.workflow,command:{kind:'update',fieldSpans:{title:{start:15,end:18}}},message:'Zain nahi naam Ali',language:'roman_ur'});
 assert.equal(corrected.workflow.fields.title,'Ali');assert.notEqual(corrected.workflow.confirmationId,filled.workflow.confirmationId);
 const resumed=reduceTaskWorkflow({current:corrected.workflow,command:{kind:'resume'},message:'resume',language:'ur'});assert.equal(resumed.workflow.workflowId,start.workflow.workflowId);
 assert.equal(validateTaskWorkflow({...corrected.workflow,patientData:'never'}),null);
});
test('fabricated spans, one/81 codepoint titles and invented fields never become confirmation',()=>{
 const current=reduceTaskWorkflow({command:{kind:'start',workflowKind:'create_care_plan'},message:'Create',language:'en'}).workflow;
 for(const message of ['A','x'.repeat(81)])assert.equal(reduceTaskWorkflow({current,command:{kind:'update',fieldSpans:{title:{start:0,end:message.length}}},message,language:'en'}).ok,false);
 assert.equal(reduceTaskWorkflow({current,command:{kind:'update',fieldSpans:{title:{start:0,end:100}}},message:'Ali',language:'en'}).ok,false);
 assert.equal(reduceTaskWorkflow({current,command:{kind:'update',fieldSpans:{dose:{start:0,end:3}}},message:'Ali',language:'en'}).ok,false);
});
test('completed workflow receipt must match its confirmation identity',()=>{
 const pending=reduceTaskWorkflow({command:{kind:'start',workflowKind:'create_care_plan',fieldSpans:{title:{start:0,end:3}}},message:'Ali'}).workflow;
 assert.equal(validateTaskWorkflow({...pending,status:'completed',completedReceipt:{confirmationId:'foreign',planId:'17',title:'Ali'}}),null);
});
