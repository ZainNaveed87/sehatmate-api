import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAgentMessage} from './agent/agent_core.js';
import {createAgentProvider} from './agent/agent_provider.js';
import {emptyAgentSessionState} from './agent/agent_session_state.js';
process.env.AGENT_ENABLED='true';

const ui=()=>({screenId:'reality_check',route:'reality_check',version:'screen:8',focusedSectionId:'question',entities:[],
  targets:[{id:'question',kind:'question',label:'Availability'},{id:'option.difficult',kind:'option',label:'This timing is difficult'}],
  actions:[{id:'show',kind:'highlight',targetId:'question'},{id:'choose',kind:'select_option',targetId:'option.difficult'}]});
function database({currentContext=null,failPlans=false}={}) {
  let row={id:501,user_id:42,language:'en',state_json:JSON.stringify(emptyAgentSessionState()),created_at:'2026-09-03 10:00:00',last_active_at:'2026-09-03 10:00:00',expires_at:'2099-01-01 00:00:00'};
  const queries=[];
  const execute=async(sql,params=[])=>{
    const s=String(sql).replace(/\s+/g,' ').trim();queries.push({sql:s,params});
    if(s.includes('SELECT c.context_json')) return [currentContext?[{context_json:JSON.stringify(currentContext)}]:[]];
    if(s.startsWith('INSERT INTO agent_copilot_plans')&&failPlans) throw Object.assign(new Error('PRIVATE_DB_DETAILS'),{code:'ER_NO_SUCH_TABLE'});
    if(s.startsWith('SELECT preferred_language')) return [[{preferred_language:'en'}]];
    if(s.includes('FROM agent_sessions WHERE id = ? AND user_id = ? AND expires_at')) return [[row]];
    if(s.startsWith('SELECT id FROM agent_sessions')) return [[{id:501}]];
    if(s.startsWith('UPDATE agent_sessions SET state_json')) row={...row,state_json:params[0]};
    if(/^SELECT|^WITH|^SHOW|^DESCRIBE/.test(s)) return [[]];
    return [{affectedRows:1,insertId:501}];
  };
  return {execute,queries,async getConnection(){return {execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}};}};
}
function provider(operations) {
  const prompts=[];
  return {prompts,p:createAgentProvider({generateJson:async args=>{
    prompts.push(args);
    return {model:'fixture',json:args.systemPrompt.includes('planning stage')?
      {category:'ui_guidance',intent:'guide_current_question',capabilityCalls:[],navigationIntent:null,uiOperations:operations}:
      {messageTemplate:'This question asks whether the routine fits your availability.'}};
  }})};
}
test('normal Agent emits a bound UI proposal through identical text and voice authority',async()=>{
  for(const voiceReply of [false,true]) {
    const db=database(),{p,prompts}=provider([{actionId:'choose',targetId:'option.difficult',args:{}}]);
    const result=await handleAgentMessage({pool:db,userId:'42',sessionId:'501',message:'This timing is difficult for me',provider:p,voiceReply,
      clientContext:{screenId:'reality_check',ui:ui()}});
    assert.equal(result.ok,true); assert.equal(result.uiPlan?.version,'screen:8');assert.equal(result.uiPlan.operations[0].riskTier,2);
    assert.equal(result.reply,'This question asks whether the routine fits your availability.');assert.equal(prompts.length,2);
    assert.ok(db.queries.some(q=>/INSERT INTO agent_copilot/.test(q.sql)),'plan binding must be persisted before client execution');
  }
});
test('unchanged Worker turn loads authenticated synced context and uses the same UI planner',async()=>{
  const db=database({currentContext:{screenId:'reality_check',ui:ui()}}),{p}=provider([{actionId:'show',targetId:'question',args:{}}]);
  const result=await handleAgentMessage({pool:db,userId:'42',sessionId:'501',message:'Explain the question',provider:p,voiceReply:true});
  assert.equal(result.uiPlan?.screenId,'reality_check');assert.equal(result.uiPlan?.operations[0].actionId,'show');
});
test('newer synced screen generation suppresses old pending UI actions',async()=>{
  const db=database({currentContext:{screenId:'reality_check',ui:{...ui(),version:'screen:9'}}}),{p}=provider([{actionId:'show',targetId:'question',args:{}}]);
  const result=await handleAgentMessage({pool:db,userId:'42',sessionId:'501',message:'Explain the question',provider:p,clientContext:{screenId:'reality_check',ui:ui()}});
  assert.equal(result.uiPlan,undefined);assert.equal(result.fallbackCode,'AGENT_UI_STALE_CONTEXT');
  assert.equal(db.queries.some(q=>q.sql.startsWith('INSERT INTO agent_copilot_plans')),false);
});
test('unavailable issued-plan storage never authorizes unauditable client execution',async()=>{
  const db=database({failPlans:true}),{p}=provider([{actionId:'show',targetId:'question',args:{}}]);
  const result=await handleAgentMessage({pool:db,userId:'42',sessionId:'501',message:'Explain the question',provider:p,clientContext:{screenId:'reality_check',ui:ui()}});
  assert.equal(result.uiPlan,undefined);assert.equal(result.fallbackCode,'AGENT_UI_PERSISTENCE_FAILED');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_DB/);
});
test('unknown option cannot become a client executable plan',async()=>{
  const db=database(),{p}=provider([{actionId:'choose',targetId:'invented',args:{}}]);
  const result=await handleAgentMessage({pool:db,userId:'42',sessionId:'501',message:'Select that',provider:p,clientContext:{screenId:'reality_check',ui:ui()}});
  assert.equal(result.uiPlan,undefined);assert.ok(result.fallbackCode);
});
test('invalid supplied UI context fails explicitly without running model planning',async()=>{
  const db=database(),{p,prompts}=provider([]);
  const result=await handleAgentMessage({pool:db,userId:'42',sessionId:'501',message:'Explain this',provider:p,
    clientContext:{screenId:'reality_check',ui:{...ui(),version:''}}});
  assert.equal(result.ok,false);assert.equal(result.code,'AGENT_UI_INVALID_CONTEXT');assert.equal(prompts.length,0);
});
