import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentTurnService} from './services/agent_turn_service.js';
import {traceVoiceTurn,voiceTurnCorrelation} from './services/voice_turn_trace.js';

function setup(response) {
  const now=Date.parse('2026-10-10T12:00:00Z');
  let row={id:'voice-private',userId:'owner-private',agentSessionId:'41',epoch:1,status:'active',
    transportOwner:'worker',expiresAt:new Date(now+600000).toISOString(),lastActiveAt:new Date(now).toISOString()};
  const receipts=new Map();let calls=0;const history=[];
  const store={transaction:async(_,run)=>run(store),getReceipt:async(_,id)=>structuredClone(receipts.get(id)||null),
    saveReceipt:async r=>receipts.set(r.turnId,structuredClone(r)),saveSession:async s=>{row=structuredClone(s);},
    listSessions:async()=>[structuredClone(row)],acquireAgentLock:async()=>async()=>{},findConfirmation:async()=>null};
  const sessions={owned:async()=>structuredClone(row),active:async s=>s,authorizeWorker:async()=>{}};
  const config={enabled:true,turnTimeoutSeconds:30,idleSeconds:60,receiptTtlSeconds:600,
    providers:{fish:true}};
  const service=createAgentTurnService({store,sessions,config,receiptKey:Buffer.alloc(32,7).toString('base64'),
    now:()=>now,readAgent:async()=>({ok:true}),handleAgent:async()=>{
      calls++;history.push(response.reply);return {ok:true,sessionId:'41',language:'en',referencedEntities:[],...response};
    }});
  return {service,history,calls:()=>calls,receipts};
}

for(const [name,response] of [
  ['normal',{reply:'Yes, I can hear you.'}],
  ['question',{reply:'What name should I give the care plan?',taskWorkflow:{status:'awaiting_input'}}],
  ['review',{reply:'Create a draft care plan named Test?',confirmation:{confirmationId:'review',kind:'create_care_plan'}}],
  ['cancel',{reply:'Care plan creation cancelled.'}],
  ['action',{reply:'Opening your tasks.',navigation:{target:'tasks',params:{}}}],
  ['language',{reply:'Ab hum Roman Urdu mein baat karein ge.',language:'roman_ur',conversationLanguage:'roman_ur'}],
]) test(`${name}: persisted and realtime receipts share one exact result without Agent replay`,async t=>{
  const logs=[];t.mock.method(console,'info',line=>logs.push(line));
  const s=setup(response);const args={userId:'owner-private',id:'voice-private',input:{epoch:1,turnId:'turn-private',message:'private transcript'}};
  const first=await s.service.submit(args);
  const read=await s.service.receipt({userId:args.userId,id:args.id,turnId:args.input.turnId});
  const replay=await s.service.submit(args);
  assert.equal(first.status,'completed');assert.deepEqual(first.result,read.result);assert.deepEqual(first,replay);
  assert.equal(first.result.reply,s.history[0]);assert.equal(s.calls(),1);
  for(const key of Object.keys(response)) assert.deepEqual(first.result[key],response[key]);
  assert.ok(!s.receipts.get(args.input.turnId).encryptedResult.includes(response.reply));
  const traces=logs.filter(line=>line.startsWith('{')).map(JSON.parse);
  assert.ok(traces.some(r=>r.stage==='VOICE_TURN_REPLY_EXTRACTED'));
  assert.ok(traces.some(r=>r.stage==='VOICE_TURN_BACKEND_RESPONSE'&&r.status==='completed'));
  assert.ok(traces.every(r=>r.correlation===voiceTurnCorrelation(args.input.turnId)));
  assert.ok(!JSON.stringify(traces).includes('private'));
});

test('diagnostics reject arbitrary stages and redact all unapproved values',t=>{
  const logs=[];t.mock.method(console,'info',line=>logs.push(line));
  traceVoiceTurn('private-stage','private-turn');
  traceVoiceTurn('FAILED','private-turn',{status:'private',error:'private provider body'});
  assert.equal(logs.length,1);assert.deepEqual(JSON.parse(logs[0]),{stage:'VOICE_TURN_FAILED',
    correlation:voiceTurnCorrelation('private-turn'),error:'OTHER'});
  assert.equal(voiceTurnCorrelation('hello'),'4f9f2cab');
});
