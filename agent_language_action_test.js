import test from 'node:test';
import assert from 'node:assert/strict';
import {continueAgentWorkflow} from './agent/agent_workflow.js';
import {createAgentProvider} from './agent/agent_provider.js';
import {emptyAgentSessionState} from './agent/agent_session_state.js';
process.env.AGENT_ENABLED='true';
const context=()=>({screenId:'home',ui:{screenId:'home',route:'home',version:'screen:9',entities:[],targets:[{id:'app.language',kind:'control',label:'App language',value:'roman_ur'}],actions:[{id:'app.language.roman_ur',kind:'set_language',targetId:'app.language'}]}});
function fixture({receipt=true,depth=0,foreign=false,current=context(),operations=[{actionId:'show',targetId:'question',args:{}}],calls=[],navigation=null}={}) {
  let stored={id:'issued-plan',screenId:'reality_check',version:'screen:8',continuationDepth:depth,
    operations:[{actionId:'app.language.roman_ur',targetId:'app.language',args:{},riskTier:2}]};
  const queries=[],prompts=[];
  const execute=async(sql,params=[])=>{
    const s=String(sql).replace(/\s+/g,' ');queries.push({sql:s,params});
    if(s.startsWith('SELECT preferred_language')) return [[{preferred_language:'Roman Urdu'}]];
    if(s.startsWith('SELECT plan_json')) return [foreign?[]:[{plan_json:JSON.stringify(stored),screen_version:'screen:8'}]];
    if(s.startsWith('SELECT result_status')) return [receipt?[{result_status:'succeeded',screen_version_before:'screen:8',screen_version_after:'screen:9',action_id:'app.language.roman_ur',target_id:'app.language',client_confirmation_ref:'client-confirm'}]:[]];
    if(s.includes('SELECT c.context_json')) return [current?[{context_json:JSON.stringify(current)}]:[]];
    if(s.startsWith('SELECT id, user_id')) return [[{id:501,user_id:42,language:'roman_ur',state_json:JSON.stringify(emptyAgentSessionState()),created_at:'2026-09-03 10:00:00',last_active_at:'2026-09-03 10:00:00',expires_at:'2099-01-01 00:00:00'}]];
    if(s.startsWith('UPDATE agent_copilot_plans SET plan_json')) {
      if(params.length===5&&params[4]!==JSON.stringify(stored)) return [{affectedRows:0}];
      stored=JSON.parse(params[0]);return [{affectedRows:1}];
    }
    if(s.startsWith('UPDATE agent_sessions'))return [{affectedRows:1}];
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

const run=f=>continueAgentWorkflow({db:f.db,userId:'42',sessionId:'501',planId:'issued-plan',context:context(),provider:f.provider});
test('app language success is profile-verified, confirmed and replayable without a provider call',async()=>{
 const f=fixture(),r=await run(f);assert.equal(r.language,'roman_ur');assert.match(r.reply,/App ki language ab Roman Urdu/);assert.equal(f.prompts.length,0);assert.deepEqual(await run(f),r);
});
test('language success cannot be claimed while authenticated profile differs',async()=>{
 const f=fixture(),execute=f.db.execute;f.db.execute=async(sql,args)=>sql.startsWith('SELECT preferred_language')?[[{preferred_language:'English'}]]:execute(sql,args);
 await assert.rejects(run(f),e=>e.code==='AGENT_LANGUAGE_NOT_APPLIED');assert.equal(f.prompts.length,0);
});
test('language completion requires an exact action receipt and explicit confirmation reference',async()=>{
 const f=fixture(),execute=f.db.execute;f.db.execute=async(sql,args)=>sql.startsWith('SELECT result_status')?[[{result_status:'succeeded',screen_version_before:'screen:8',screen_version_after:'screen:9',action_id:'app.language.roman_ur',target_id:'app.language',client_confirmation_ref:null}]]:execute(sql,args);
 await assert.rejects(run(f),e=>e.code==='AGENT_LANGUAGE_NOT_APPLIED');
});
test('language completion rejects missing receipt',async()=>{
 const f=fixture({receipt:false});await assert.rejects(run(f),e=>e.code==='AGENT_WORKFLOW_RECEIPT_REQUIRED');
});
test('foreign plan and concurrent completion remain fenced',async()=>{
 await assert.rejects(run(fixture({foreign:true})),e=>e.code==='AGENT_WORKFLOW_NOT_FOUND');const f=fixture();const results=await Promise.allSettled([run(f),run(f)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
