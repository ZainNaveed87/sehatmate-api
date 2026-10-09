import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAgentNavigationIntent} from './agent/agent_navigation_registry.js';
for(const target of ['calendar','family','care_plan_new','family_member_new','doctor_questions','simple_care','teach_back']) {
  test(`registered actual destination ${target}`,()=>assert.equal(validateAgentNavigationIntent({target,params:{}}).ok,true));
}
test('upload/review require plan identity and reject arbitrary route strings',()=>{
  for(const target of ['care_plan_upload','care_plan_review']){
    assert.equal(validateAgentNavigationIntent({target,params:{}}).ok,false);
    assert.equal(validateAgentNavigationIntent({target,params:{carePlanId:'7'}}).ok,true);
  }
  assert.equal(validateAgentNavigationIntent({target:'/settings',params:{}}).ok,false);
});
