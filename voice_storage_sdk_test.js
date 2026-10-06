import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {readFileSync} from 'node:fs';
import {createVoiceStore} from './services/voice_store.js';
import {createLiveKitVoiceProvider} from './services/livekit_voice_provider.js';

test('binding diagnostics report only the first failed check without provider values',async t=>{
  const cases=[
    ['DISPATCH_MISSING',({row})=>{row.dispatchId=null;}],
    ['DISPATCH_MISSING',f=>{f.result=null;}],
    ['DISPATCH_ID',({d})=>{d.id='private-other-dispatch';}],
    ['DISPATCH_ROOM',({d})=>{d.room='private-other-room';}],
    ['AGENT_NAME',({d})=>{d.agentName='private-other-agent';}],
    ['JOB_MISSING',({job})=>{job.id='private-other-job';job.dispatchId=null;job.state=null;}],
    ['JOB_MISSING',({d})=>{d.state.jobs=[];}],
    ['JOB_MISSING',({d})=>{d.state=undefined;}],
    ['JOB_DISPATCH',({job})=>{job.dispatchId='private-other-dispatch';job.room=null;job.state=null;}],
    ['JOB_ROOM_MISMATCH',({job})=>{job.room={name:'private-other-room'};job.state=null;}],
    ['PARTICIPANT_IDENTITY',({job})=>{job.state.participantIdentity='private-other-identity';job.state.workerId='';job.state.endedAt=1n;}],
    ['PARTICIPANT_IDENTITY',({job})=>{job.state=undefined;}],
    ['WORKER_ID',({job})=>{job.state.workerId='';job.state.endedAt=1n;}],
    ['JOB_ENDED',({job})=>{job.state.endedAt=1n;}],
  ];
  for(const [reason,mutate] of cases) {
    await t.test(reason,async t=>{
      const row={dispatchId:'private-dispatch',roomName:'private-room'};
      const b={jobId:'private-job',workerIdentity:'private-identity'};
      const job={id:b.jobId,dispatchId:row.dispatchId,room:{name:row.roomName},
        state:{participantIdentity:b.workerIdentity,workerId:'private-worker',endedAt:0n}};
      const d={id:row.dispatchId,room:row.roomName,agentName:'sehatmate-voice',state:{jobs:[job]}};
      const f={row,b,job,d,result:d};mutate(f);
      const logs=[];t.mock.method(console,'warn',(...args)=>logs.push(args));
      const provider=createLiveKitVoiceProvider({config:{agentName:'sehatmate-voice'},secrets:{},rooms:{},
        dispatch:{getDispatch:async()=>f.result}});
      assert.equal(await provider.binding(row,b),false);
      assert.deepEqual(logs,[[`VOICE_LIVEKIT_BINDING_FAILED:${reason}`]]);
    });
  }
});

test('binding diagnostics preserve successful any-matching-job behavior and provider exceptions',async t=>{
  const logs=[];t.mock.method(console,'warn',(...args)=>logs.push(args));
  const row={dispatchId:'private-dispatch',roomName:'private-room'};
  const b={jobId:'private-job',workerIdentity:'private-identity'};
  const valid={id:b.jobId,dispatchId:row.dispatchId,room:{name:row.roomName},
    state:{participantIdentity:b.workerIdentity,workerId:'private-worker',endedAt:0n}};
  const jobs=[{...valid,dispatchId:'private-other-dispatch'},valid];
  const d={id:row.dispatchId,room:row.roomName,agentName:'sehatmate-voice',state:{jobs}};
  let error;
  const provider=createLiveKitVoiceProvider({config:{agentName:'sehatmate-voice'},secrets:{},rooms:{},
    dispatch:{getDispatch:async()=>{if(error) throw error;return d;}}});
  assert.equal(await provider.binding(row,b),true);assert.deepEqual(logs,[]);
  jobs.pop();
  assert.equal(await provider.binding(row,b),false);
  assert.deepEqual(logs,[['VOICE_LIVEKIT_BINDING_FAILED:JOB_DISPATCH']]);
  logs.length=0;error=new Error('private-provider-body private-token');
  await assert.rejects(provider.binding(row,b),e=>e===error);assert.deepEqual(logs,[]);
});

test('optional job room compatibility retains all remaining binding checks',async t=>{
  const cases=[
    ['matching', {name:'private-room'}],
    ['absent', undefined],
    ['null', null],
    ['name absent', {}],
    ['empty', {name:''}],
    ['non-string name', {name:123}],
    ['mismatching', {name:'private-other-room'}, 'JOB_ROOM_MISMATCH'],
    ['whitespace is present', {name:' '}, 'JOB_ROOM_MISMATCH'],
  ];
  for(const room of [undefined,{name:''}]) {
    for(const reason of ['PARTICIPANT_IDENTITY','WORKER_ID','JOB_ENDED']) {
      cases.push([`optional room still enforces ${reason}`,room,reason]);
    }
  }
  for(const [label,room,reason] of cases) {
    await t.test(label,async t=>{
      const row={dispatchId:'private-dispatch',roomName:'private-room'};
      const b={jobId:'private-job',workerIdentity:'private-identity'};
      const job={id:b.jobId,dispatchId:row.dispatchId,room,
        state:{participantIdentity:b.workerIdentity,workerId:'private-worker',endedAt:0n}};
      if(reason==='PARTICIPANT_IDENTITY') job.state.participantIdentity='private-other-identity';
      if(reason==='WORKER_ID') job.state.workerId='';
      if(reason==='JOB_ENDED') job.state.endedAt=1n;
      const d={id:row.dispatchId,room:row.roomName,agentName:'sehatmate-voice',state:{jobs:[job]}};
      const logs=[];t.mock.method(console,'warn',(...args)=>logs.push(args));
      const provider=createLiveKitVoiceProvider({config:{agentName:'sehatmate-voice'},secrets:{},rooms:{},
        dispatch:{getDispatch:async()=>d}});
      assert.equal(await provider.binding(row,b),!reason);
      assert.deepEqual(logs,reason?[[`VOICE_LIVEKIT_BINDING_FAILED:${reason}`]]:[]);
    });
  }
});

test('official SDK signs only microphone, room-scoped, short-lived participant grants',async()=>{
  const provider=createLiveKitVoiceProvider({config:{livekitUrl:'wss://example.livekit.cloud'},
    secrets:{livekitKey:'mock-key',livekitSecret:'s'.repeat(40)},rooms:{},dispatch:{}});
  const token=await provider.token({roomName:'smv-opaque',participantIdentity:'smu-opaque'},60);
  const claims=jwt.verify(token,'s'.repeat(40),{algorithms:['HS256']});
  assert.equal(claims.sub,'smu-opaque');assert.equal(claims.iss,'mock-key');assert.equal(claims.exp-claims.nbf,60);
  assert.deepEqual(claims.video,{roomJoin:true,room:'smv-opaque',canPublish:true,canSubscribe:true,
    canPublishData:true,canPublishSources:['microphone'],canUpdateOwnMetadata:false});
  assert.equal(claims.metadata,undefined);
});
test('SDK dispatch stores only opaque metadata and validates server-returned job identity',async()=>{
  let created;
  const row={id:'opaque',roomName:'smv-opaque',participantIdentity:'smu-opaque',dispatchId:'AD_one'};
  const jobs=[{id:'AJ_one',dispatchId:'AD_one',room:{name:row.roomName},state:{participantIdentity:'worker-one',workerId:'AW_one',endedAt:0n}}];
  const provider=createLiveKitVoiceProvider({config:{livekitUrl:'wss://example.livekit.cloud',agentName:'sehatmate-voice',idleSeconds:60},secrets:{},
    rooms:{createRoom:async options=>assert.equal(options.maxParticipants,2)},
    dispatch:{createDispatch:async(room,name,options)=>{created={room,name,options};return {id:'AD_one'};},
      getDispatch:async()=>({id:'AD_one',room:row.roomName,agentName:'sehatmate-voice',state:{jobs}})}});
  await provider.create(row);assert.deepEqual(JSON.parse(created.options.metadata),{voiceSessionId:'opaque'});
  assert.equal(await provider.binding(row,{jobId:'AJ_one',workerIdentity:'worker-one'}),true);
  assert.equal(await provider.binding(row,{jobId:'AJ_one',workerIdentity:'forged'}),false);
  jobs[0].state.endedAt=1n;assert.equal(await provider.binding(row,{jobId:'AJ_one',workerIdentity:'worker-one'}),false);
});
test('SDK revocation handles already missing resources and reports actual provider failure',async()=>{
  const calls=[];const missing=()=>{throw Object.assign(new Error(),{code:'not_found'});};
  const provider=createLiveKitVoiceProvider({config:{},secrets:{},
    rooms:{removeParticipant:async(room,id,options)=>{assert.equal(typeof options.revokeTokenTs,'bigint');calls.push('remove');missing();},deleteRoom:async()=>{calls.push('delete');missing();}},
    dispatch:{deleteDispatch:async()=>{calls.push('dispatch');missing();}}});
  await provider.revoke({roomName:'r',participantIdentity:'p',dispatchId:'d'});assert.deepEqual(calls,['dispatch','remove','delete']);
  const failed=createLiveKitVoiceProvider({config:{},secrets:{},rooms:{deleteRoom:async()=>assert.fail('must not report cleanup')},dispatch:{deleteDispatch:async()=>{throw new Error('unavailable');}}});
  await assert.rejects(failed.revoke({dispatchId:'d'}));
});
test('SQL store uses UTC raw dates and preserves nullable Agent reference for accounting',async()=>{
  const row={id:'voice',user_id:1,agent_session_id:null,usage_day:'2026-10-04',created_at:'2026-10-04 10:00:00.000',last_active_at:'2026-10-04 10:00:00.000',expires_at:'2026-10-04 10:10:00.000'};
  const store=createVoiceStore({query:async(options,values)=>{assert.equal(options.dateStrings,true);assert.deepEqual(values,['voice']);return [[row]];}});
  const decoded=await store.getSession('voice');assert.equal(decoded.createdAt,'2026-10-04T10:00:00.000Z');assert.equal(decoded.usageDay,'2026-10-04');assert.equal(decoded.agentSessionId,null);
  const ddl=readFileSync(new URL('./migrations/20261004_phase_2a_voice.sql',import.meta.url),'utf8');
  assert.match(ddl,/voice_agent_fk[^\n]+ON DELETE SET NULL/);
  assert.match(ddl,/UNIQUE KEY voice_confirmation_unique \(agent_session_id, confirmation_id\)/);
});
test('SQL transactions serialize on user row and roll back errors before releasing connection',async()=>{
  const events=[];
  const connection={beginTransaction:async()=>events.push('begin'),query:async(sql,args)=>{assert.match(sql,/FOR UPDATE/);assert.deepEqual(args,['7']);events.push('user lock');return [[{id:7}]];},
    commit:async()=>events.push('commit'),rollback:async()=>events.push('rollback'),release:()=>events.push('release')};
  const store=createVoiceStore({getConnection:async()=>connection});
  await assert.rejects(store.transaction('7',async()=>{throw new Error('abort');}));assert.deepEqual(events,['begin','user lock','rollback','release']);
  events.length=0;assert.equal(await store.transaction('7',async()=>42),42);assert.deepEqual(events,['begin','user lock','commit','release']);
});
test('advisory locks use separate pool, reject contention, and release exactly once',async()=>{
  let released=0,queries=0;
  const lockPool={getConnection:async()=>({query:async(sql,args)=>{queries++;assert.ok(args[0].length<=64);return [[{acquired:1}]];},release:()=>released++,destroy:()=>assert.fail('unexpected destroy')})};
  const store=createVoiceStore({getConnection:()=>assert.fail('must not pin Agent query pool')},{lockPool});
  const unlock=await store.acquireAgentLock('1','9');await unlock();await unlock();assert.equal(released,1);assert.equal(queries,2);
  const busy=createVoiceStore({},{lockPool:{getConnection:async()=>({query:async()=>[[{acquired:0}]],release:()=>released++})}});
  assert.equal(await busy.acquireAgentLock('1','9'),null);
});
test('expired-session cleanup retains lock capacity when all Agent-turn lock connections are occupied',async()=>{
  let released=false;
  const store=createVoiceStore({},{lockPool:{getConnection:async()=>{throw new Error('Agent slots exhausted');}},
    sessionLockPool:{getConnection:async()=>({query:async()=>[[{acquired:1}]],release:()=>released=true})}});
  assert.equal(await store.acquireAgentLock('1','9'),null);
  const cleanup=await store.acquireSessionLock('1','voice');assert.equal(typeof cleanup,'function');await cleanup();assert.equal(released,true);
});
