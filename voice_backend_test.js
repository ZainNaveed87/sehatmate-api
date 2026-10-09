import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import express from 'express';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {mountVoiceRoutes} from './agent/agent_voice_routes.js';
import { voiceConfiguration } from './agent/agent_voice_config.js';
const services = await import('./services/voice_session_service.js').catch(() => ({}));
const turns = await import('./services/agent_turn_service.js').catch(() => ({}));
const env = {REALTIME_VOICE_ENABLED:'true', LIVEKIT_URL:'wss://example.livekit.cloud',
  LIVEKIT_API_KEY:'mock-key',LIVEKIT_API_SECRET:'s'.repeat(40),VOICE_WORKER_AUTH_KEY:'w'.repeat(40),
  VOICE_DELEGATION_SECRET:'d'.repeat(40),VOICE_RECEIPT_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')};
// Test-only durable-store double. Rebuilding services over this store models a restart.
class MemoryStore {
  sessions = new Map(); receipts = new Map(); locks = new Set();
  async transaction(userId, fn) { if(this.locks.has(`user:${userId}`)) throw Object.assign(new Error(),{code:'VOICE_BUSY',status:409});
    this.locks.add(`user:${userId}`); try { return await fn(this); } finally { this.locks.delete(`user:${userId}`); } }
  async getSession(id) { return structuredClone(this.sessions.get(id) || null); }
  async saveSession(s) { this.sessions.set(s.id,structuredClone(s)); }
  async listSessions(userId) { return [...this.sessions.values()].filter(s=>s.userId===userId).map(s=>structuredClone(s)); }
  async getReceipt(id,turnId) { return structuredClone(this.receipts.get(`${id}:${turnId}`) || null); }
  async findConfirmation(agentSessionId,confirmationId) { return [...this.receipts.values()].find(r=>r.agentSessionId===agentSessionId && r.confirmationId===confirmationId) || null; }
  async saveReceipt(r) { this.receipts.set(`${r.voiceSessionId}:${r.turnId}`,structuredClone(r)); }
  async acquireAgentLock(userId,agentId) { const key=`${userId}:${agentId}`; if(this.locks.has(key)) return null; this.locks.add(key); return async()=>this.locks.delete(key); }
  acquireSessionLock(userId,id) {return this.acquireAgentLock(userId,`voice-session:${id}`);}
}
function setup(overrides={}) {
  const store=overrides.store || new MemoryStore(); let now=Date.parse('2026-10-04T10:00:00Z');
  const agent={id:'9',userId:'1',expiresAt:new Date(now+240*60000),state:{pendingConfirmation:{confirmationId:'approve-1'}}};
  const provider={create:async s=>({dispatchId:'AD_mock'}), token:async()=> 'mock-participant-token',
    revoke:async()=>{}, binding:async(s,b)=>b.roomName===s.roomName && b.jobId==='AJ_mock' && b.workerIdentity==='worker-mock'};
  const config=voiceConfiguration({...env,...overrides.env});
  assert.equal(typeof services.createVoiceSessionService,'function');
  const sessions=services.createVoiceSessionService({store,config,secrets:{workerKey:env.VOICE_WORKER_AUTH_KEY,delegationSecret:env.VOICE_DELEGATION_SECRET},
    livekit:{...provider,...overrides.provider},now:()=>now,agentEnabled:()=>true,
    readAgent:async({userId,sessionId})=>userId==='1' && sessionId==='9' ? {ok:true,data:{session:agent}} : {ok:false}});
  return {store,sessions,config,agent,now:()=>now,advance:ms=>now+=ms};
}
const create = s=>s.sessions.create({userId:'1',input:{agentSessionId:'9'}});
const expectCode = (promise,code)=>assert.rejects(promise,e=>e.code===code);

test('voice-only reply policy is selected by the server and cannot be supplied in turn input',async()=>{
  let received;
  const s=await turnSetup(async args=>{received=args;return {ok:true,sessionId:'9',language:'en',reply:'Approved answer.'};});
  await s.service.submit({userId:'1',id:s.a.id,input:s.input});
  assert.equal(received.voiceReply,true);
  await expectCode(s.service.submit({userId:'1',id:s.a.id,
    input:{...s.input,turnId:'other-turn',voiceReply:false}}),'VOICE_INVALID_REQUEST');
});

test('worker claim selects speech language only from the owned Agent session',async t=>{
  for(const [language,expected] of [['en','en'],['ur','ur'],['roman_ur','ur']]) {
    await t.test(language,async()=>{
      const s=setup();s.agent.language=language;const a=await create(s);
      const args={id:a.id,serviceIdentity:'sehatmate-worker',
        input:{roomName:a.roomName,jobId:'AJ_mock',workerIdentity:'worker-mock'}};
      assert.equal((await s.sessions.claim(args)).sttLanguage,expected);
      await expectCode(s.sessions.claim({...args,input:{...args.input,sttLanguage:'multi'}}),'VOICE_INVALID_REQUEST');
      await expectCode(s.sessions.create({userId:'1',input:{agentSessionId:'9',sttLanguage:'ur'}}),'VOICE_INVALID_REQUEST');
      s.agent.language='en';
      assert.equal((await s.sessions.claim(args)).sttLanguage,'en');
    });
  }
});

test('claim binding diagnostics preserve security checks and never include binding values',async t=>{
  const cases=[
    ['TRANSPORT_OWNER',({row,input})=>{row.transportOwner='device';input.roomName='private-wrong-room';}],
    ['ROOM_NAME',({input})=>{input.roomName='private-wrong-room';}],
    ['PROVIDER_BINDING',f=>{f.binding=false;}],
    ['EXISTING_DB_BINDING',({row})=>{row.jobId='private-existing-job';row.workerIdentity='private-existing-worker';}],
    ['EXISTING_DB_BINDING',({row,input})=>{row.jobId=input.jobId;row.workerIdentity='private-existing-worker';}],
  ];
  for(const [reason,mutate] of cases) {
    await t.test(reason,async t=>{
      let calls=0;const f={binding:true};
      const s=setup({provider:{binding:async()=>{calls++;return f.binding;}}});
      const a=await create(s);
      f.row=await s.store.getSession(a.id);
      f.input={roomName:a.roomName,jobId:'AJ_mock',workerIdentity:'worker-mock'};
      mutate(f);await s.store.saveSession(f.row);
      const before=await s.store.getSession(a.id);
      const logs=[];t.mock.method(console,'warn',(...args)=>logs.push(args));
      await expectCode(s.sessions.claim({id:a.id,serviceIdentity:'sehatmate-worker',input:f.input}),'VOICE_WORKER_BINDING');
      assert.deepEqual(logs,[[`VOICE_BINDING_FAILED:${reason}`]]);
      assert.deepEqual(await s.store.getSession(a.id),before);
      assert.equal(calls,['TRANSPORT_OWNER','ROOM_NAME'].includes(reason)?0:1);
    });
  }
});

test('claim provider exception logs only a fixed binding marker and preserves unavailable error',async t=>{
  const s=setup({provider:{binding:async()=>{throw new Error('private-provider-body private-token');}}});
  const a=await create(s);
  const logs=[];t.mock.method(console,'warn',(...args)=>logs.push(args));
  await expectCode(s.sessions.claim({id:a.id,serviceIdentity:'sehatmate-worker',
    input:{roomName:a.roomName,jobId:'AJ_mock',workerIdentity:'worker-mock'}}),'VOICE_PROVIDER_UNAVAILABLE');
  assert.deepEqual(logs,[['VOICE_BINDING_FAILED:PROVIDER_BINDING']]);
});

test('successful repeated claims keep their database binding and emit no failure diagnostics',async t=>{
  const s=setup();const a=await create(s);
  const logs=[];t.mock.method(console,'warn',(...args)=>logs.push(args));
  const args={id:a.id,serviceIdentity:'sehatmate-worker',
    input:{roomName:a.roomName,jobId:'AJ_mock',workerIdentity:'worker-mock'}};
  const first=await s.sessions.claim(args);const second=await s.sessions.claim(args);
  assert.equal(first.epoch,second.epoch);
  const row=await s.store.getSession(a.id);
  assert.equal(row.jobId,args.input.jobId);assert.equal(row.workerIdentity,args.input.workerIdentity);
  assert.deepEqual(logs,[]);
});
test('creates opaque owned session, reuses eligible session without resetting expiry',async()=>{
  const s=setup();const first=await create(s);const next=await create(s);
  assert.equal(first.id,next.id);assert.equal(first.expiresAt,next.expiresAt);
  assert.match(first.roomName,/^smv-/);assert.doesNotMatch(first.roomName,/patient/); // id uses random UUID; no supplied identifier
  assert.equal(first.epoch,1);assert.equal(first.transportOwner,'worker');
  await expectCode(s.sessions.get({userId:'2',id:first.id}),'VOICE_SESSION_NOT_FOUND');
});
test('rejects unowned Agent and client selected room or user identity',async()=>{
  const s=setup();await expectCode(s.sessions.create({userId:'2',input:{agentSessionId:'9'}}),'AGENT_SESSION_NOT_FOUND');
  await expectCode(s.sessions.create({userId:'1',input:{agentSessionId:'9',roomName:'forged'}}),'VOICE_INVALID_REQUEST');
});
test('disabled configuration and failed LiveKit create never return success',async()=>{
  await expectCode(create(setup({env:{REALTIME_VOICE_ENABLED:'false'}})),'VOICE_DISABLED');
  const s=setup({provider:{create:async()=>{throw new Error('secret upstream text');}}});
  await expectCode(create(s),'VOICE_PROVIDER_UNAVAILABLE');
});
test('session duration, daily reservation and concurrent limits cannot be bypassed',async()=>{
  const s=setup();const a=await create(s);s.advance(601000);
  await expectCode(s.sessions.token({userId:'1',id:a.id}),'VOICE_SESSION_EXPIRED');
  const s2=setup({env:{VOICE_MAX_DAILY_SECONDS:'600'}});await create(s2);s2.advance(601000);
  await expectCode(create(s2),'VOICE_DAILY_LIMIT');
  const s3=setup();await create(s3);
  const row=[...s3.store.sessions.values()][0];row.agentSessionId='10';
  await expectCode(create(s3),'VOICE_CONCURRENT_LIMIT');
});
test('transport epochs invalidate worker delegation; termination is idempotent and provider failures visible',async()=>{
  const s=setup();const a=await create(s);
  const delegation=await s.sessions.claim({id:a.id,serviceIdentity:'sehatmate-worker',input:{roomName:a.roomName,jobId:'AJ_mock',workerIdentity:'worker-mock'}});
  assert.equal(delegation.participantIdentity,a.participantIdentity);
  assert.equal(delegation.sessionExpiresAt,a.expiresAt);
  assert.equal(delegation.genericPrompts.welcome,'Welcome to SehatMate.');
  const ownedBinding = await s.sessions.get({userId:'1',id:a.id});
  assert.equal(ownedBinding.workerIdentity,'worker-mock');
  const stored = await s.store.getSession(a.id);
  stored.activeTurnId = 'lost-processing-event';
  await s.store.saveSession(stored);
  assert.equal((await s.sessions.get({userId:'1',id:a.id})).activeTurnId,'lost-processing-event');
  stored.activeTurnId = null;
  await s.store.saveSession(stored);
  const auth=s.sessions.verifyDelegation(delegation.token,a.id);
  assert.equal(auth.epoch,1);
  await expectCode(s.sessions.claim({id:a.id,serviceIdentity:'sehatmate-worker',input:{roomName:'forged',jobId:'AJ_mock',workerIdentity:'worker-mock'}}),'VOICE_WORKER_BINDING');
  const switched=await s.sessions.transport({userId:'1',id:a.id,input:{epoch:1,mode:'device'}});
  assert.equal(switched.epoch,2);
  await expectCode(s.sessions.authorizeWorker(auth,a.id),'VOICE_STALE_EPOCH');
  await s.sessions.end({userId:'1',id:a.id});await s.sessions.end({userId:'1',id:a.id});
  await expectCode(s.sessions.token({userId:'1',id:a.id}),'VOICE_SESSION_EXPIRED');
  const failure=setup({provider:{revoke:async()=>{throw new Error('secret');}}});const f=await create(failure);
  await expectCode(failure.sessions.end({userId:'1',id:f.id}),'VOICE_REVOCATION_PENDING');
});
test('claim and delegation credentials are separate, expiring and session bound',async()=>{
  const s=setup();const a=await create(s);
  const bad=jwt.sign({sub:'forged',iat:Math.floor(s.now()/1000),exp:Math.floor(s.now()/1000)+60},env.VOICE_WORKER_AUTH_KEY,{issuer:'sehatmate-voice-worker',audience:'sehatmate-voice-claim'});
  assert.throws(()=>s.sessions.verifyService(bad),e=>e.code==='VOICE_WORKER_UNAUTHORIZED');
  const valid=jwt.sign({sub:'sehatmate-worker',iat:Math.floor(s.now()/1000),exp:Math.floor(s.now()/1000)+60},env.VOICE_WORKER_AUTH_KEY,{issuer:'sehatmate-voice-worker',audience:'sehatmate-voice-claim'});
  assert.equal(s.sessions.verifyService(valid),'sehatmate-worker');
  const d=await s.sessions.claim({id:a.id,serviceIdentity:'sehatmate-worker',input:{roomName:a.roomName,jobId:'AJ_mock',workerIdentity:'worker-mock'}});
  assert.throws(()=>s.sessions.verifyDelegation(d.token,'another'),e=>e.code==='VOICE_WORKER_UNAUTHORIZED');
  s.advance(61000);assert.throws(()=>s.sessions.verifyDelegation(d.token,a.id),e=>e.code==='VOICE_WORKER_UNAUTHORIZED');
});
async function turnSetup(handler,overrides={}) {
  const s=setup(overrides);const a=await create(s);
  assert.equal(typeof turns.createAgentTurnService,'function');
  const service=turns.createAgentTurnService({store:s.store,sessions:s.sessions,config:s.config,receiptKey:env.VOICE_RECEIPT_ENCRYPTION_KEY,
    handleAgent:handler,readAgent:async()=>({ok:true,data:{session:s.agent}}),now:s.now});
  return {...s,a,service,input:{epoch:1,turnId:'turn-1',message:'What is next?',today:'2026-10-04'}};
}
test('same finalized turn is executed once, encrypted, and recoverable after service restart',async()=>{
  let calls=0;const s=await turnSetup(async args=>{calls++;assert.equal(args.userId,'1');return {ok:true,sessionId:'9',reply:'Private reply',actionStatus:'none'};});
  const args={userId:'1',id:s.a.id,input:s.input};
  const a=await s.service.submit(args);const b=await s.service.submit(args);
  assert.equal(calls,1);assert.equal(a.result.reply,b.result.reply);
  assert.doesNotMatch(JSON.stringify([...s.store.receipts.values()]),/Private reply|What is next/);
  await expectCode(s.service.submit({...args,input:{...s.input,message:'Different'}}),'VOICE_TURN_CONFLICT');
  const rebuilt=turns.createAgentTurnService({store:s.store,sessions:s.sessions,config:s.config,receiptKey:env.VOICE_RECEIPT_ENCRYPTION_KEY,handleAgent:async()=>{throw new Error('must not execute');},now:s.now});
  assert.equal((await rebuilt.receipt({userId:'1',id:s.a.id,turnId:'turn-1'})).result.reply,'Private reply');
});
test('concurrent turns serialize and transport cannot move during active processing',async()=>{
  let resolve;const gate=new Promise(r=>resolve=r);const s=await turnSetup(async()=>{await gate;return {ok:true,reply:'done'};});
  const active=s.service.submit({userId:'1',id:s.a.id,input:s.input});await new Promise(r=>setTimeout(r,10));
  await expectCode(s.service.submit({userId:'1',id:s.a.id,input:{...s.input,turnId:'turn-2'}}),'VOICE_TURN_BUSY');
  await expectCode(s.sessions.transport({userId:'1',id:s.a.id,input:{epoch:1,mode:'device'}}),'VOICE_TURN_BUSY');
  resolve();await active;
});
test('rejects interim transcripts, forged identity, stale epoch and ambiguous confirmation',async()=>{
  const s=await turnSetup(async()=>({ok:true,reply:'done'}));const submit=input=>s.service.submit({userId:'1',id:s.a.id,input});
  await expectCode(submit({...s.input,final:false}),'VOICE_INVALID_REQUEST');
  await expectCode(submit({...s.input,userId:'2'}),'VOICE_INVALID_REQUEST');
  await expectCode(submit({...s.input,epoch:0}),'VOICE_STALE_EPOCH');
  await expectCode(submit({epoch:1,turnId:'c',confirmation:{confirmationId:'other',decision:'confirm'}}),'VOICE_CONFIRMATION_NOT_CURRENT');
});
for(const decision of ['confirm','cancel'])test(`voice ${decision} accepts the current care-plan workflow confirmation`,async()=>{
  let calls=0;const s=await turnSetup(async()=>{calls++;return {ok:true,reply:'Reviewed',actionStatus:decision==='confirm'?'confirmed':'cancelled',taskWorkflow:s.agent.state.taskWorkflow};});
  s.agent.state.pendingConfirmation=null;
  s.agent.state.taskWorkflow={workflowId:'workflow-1',kind:'create_care_plan',revision:2,status:'awaiting_confirmation',fields:{title:'Ali'},confirmationId:'task-confirm',expiresAt:'2999-01-01T00:00:00.000Z'};
  const input={epoch:1,turnId:`task-${decision}`,confirmation:{confirmationId:'task-confirm',decision}};
  const result=await s.service.submit({userId:'1',id:s.a.id,input});
  assert.equal(result.status,'completed');assert.equal(result.result.taskWorkflow.workflowId,'workflow-1');assert.equal(calls,1);
  await s.service.submit({userId:'1',id:s.a.id,input:{...input,turnId:`task-${decision}-retry`}});assert.equal(calls,1);
});
test('voice can replay a matching text-completed task receipt but rejects wrong/expired/cancel decisions',async()=>{
  let calls=0;const s=await turnSetup(async()=>{calls++;return {ok:true,reply:'Already created',taskWorkflow:s.agent.state.taskWorkflow};});
  s.agent.state.pendingConfirmation=null;
  const pending={workflowId:'workflow-1',kind:'create_care_plan',revision:2,status:'awaiting_confirmation',fields:{title:'Ali'},confirmationId:'task-confirm',expiresAt:'2999-01-01T00:00:00.000Z'};
  const submit=(confirmationId,decision='confirm')=>s.service.submit({userId:'1',id:s.a.id,input:{epoch:1,turnId:`try-${confirmationId}-${decision}`,confirmation:{confirmationId,decision}}});
  s.agent.state.taskWorkflow={...pending,expiresAt:'2000-01-01T00:00:00.000Z'};
  await expectCode(submit('task-confirm'),'VOICE_CONFIRMATION_NOT_CURRENT');
  s.agent.state.taskWorkflow={...pending,status:'completed',completedReceipt:{confirmationId:'task-confirm',planId:'17',title:'Ali'}};
  await expectCode(submit('foreign'),'VOICE_CONFIRMATION_NOT_CURRENT');
  await expectCode(submit('task-confirm','cancel'),'VOICE_CONFIRMATION_NOT_CURRENT');
  assert.equal((await submit('task-confirm')).status,'completed');assert.equal(calls,1);
});
test('duplicate confirmation with another turn ID cannot execute again',async()=>{
  let calls=0;const s=await turnSetup(async()=>{calls++;s.agent.state.pendingConfirmation=null;return {ok:true,reply:'Done',actionStatus:'confirmed'};});
  const input={epoch:1,turnId:'confirm-a',confirmation:{confirmationId:'approve-1',decision:'confirm'}};
  await s.service.submit({userId:'1',id:s.a.id,input});
  await s.service.submit({userId:'1',id:s.a.id,input:{...input,turnId:'confirm-b'}});
  assert.equal(calls,1);
});
test('unknown action failure is recoverable and never automatically replayed',async()=>{
  let calls=0;const s=await turnSetup(async()=>{calls++;throw new Error('database credentials must not leak');});
  const args={userId:'1',id:s.a.id,input:s.input};
  const a=await s.service.submit(args);const b=await s.service.submit(args);
  assert.equal(a.status,'recovery_required');assert.equal(b.status,'recovery_required');assert.equal(calls,1);
  await expectCode(s.service.submit({...args,input:{...s.input,turnId:'another'}}),'VOICE_RECOVERY_REQUIRED');
});
test('a late response after session termination is recorded but never presented as a current Agent reply',async()=>{
  let resolve;const gate=new Promise(r=>resolve=r);const s=await turnSetup(async()=>{await gate;return {ok:true,reply:'obsolete',navigation:{target:'home'}};});
  const active=s.service.submit({userId:'1',id:s.a.id,input:s.input});await new Promise(r=>setTimeout(r,10));
  await s.sessions.end({userId:'1',id:s.a.id});resolve();const result=await active;
  assert.equal(result.status,'stale');assert.equal(result.result,undefined);
});

test('timeout returns processing, preserves lock, and receipt lookup never replays the Agent',async()=>{
  let resolve,calls=0;const gate=new Promise(r=>resolve=r);
  const s=await turnSetup(async()=>{calls++;await gate;return {ok:true,reply:'settled'};},{env:{VOICE_TURN_TIMEOUT_SECONDS:'5'}});
  const first=await s.service.submit({userId:'1',id:s.a.id,input:s.input});assert.equal(first.status,'processing');
  s.advance(5100);
  assert.equal((await s.service.receipt({userId:'1',id:s.a.id,turnId:s.input.turnId})).status,'recovery_required');
  await expectCode(s.service.submit({userId:'1',id:s.a.id,input:{...s.input,turnId:'next'}}),'VOICE_TURN_BUSY');
  resolve();await new Promise(r=>setTimeout(r,25));
  assert.equal((await s.service.receipt({userId:'1',id:s.a.id,turnId:s.input.turnId})).status,'completed');assert.equal(calls,1);
});
test('Agent-reported partial mutation failure creates a durable recovery fence across service restarts and manual requests',async()=>{
  const s=await turnSetup(async()=>({ok:true,reply:'rejected',fallbackCode:'AGENT_CAPABILITY_FAILED'}));
  assert.equal((await s.service.submit({userId:'1',id:s.a.id,input:s.input})).status,'recovery_required');
  const rebuilt=turns.createAgentTurnService({store:s.store,sessions:s.sessions,config:s.config,receiptKey:env.VOICE_RECEIPT_ENCRYPTION_KEY,now:s.now});
  await expectCode(rebuilt.manual({userId:'1',sessionId:'9',run:()=>assert.fail('must not run')}),'VOICE_RECOVERY_REQUIRED');
  await s.sessions.end({userId:'1',id:s.a.id});
  const fresh=await create(s);
  await expectCode(rebuilt.submit({userId:'1',id:fresh.id,input:s.input}),'VOICE_RECOVERY_REQUIRED');
});
test('idle timeout and UTC midnight bound session eligibility and reservation',async()=>{
  const s=setup();const a=await create(s);s.advance(61000);
  await expectCode(s.sessions.token({userId:'1',id:a.id}),'VOICE_SESSION_EXPIRED');
  const late=setup();late.advance(14*3600000-10000);late.agent.expiresAt=new Date(late.now()+240*60000);const b=await create(late);
  assert.equal(b.expiresAt,'2026-10-05T00:00:00.000Z');
});
test('HTTP routes use the existing user JWT boundary and a separate Worker boundary',async t=>{
  // Evaluate the real existing middleware in isolation; never import/start the production server.
  const source=readFileSync(new URL('./server.js',import.meta.url),'utf8');
  const authSource=source.slice(source.indexOf('function authenticate('),source.indexOf("app.get('/health'"));
  const auth=vm.runInNewContext(`${authSource};authenticate`,{jwt,process:{env:{JWT_SECRET:'mock-user-secret'}}});
  const s=await turnSetup(async()=>({ok:true,sessionId:'9',reply:'approved',actionStatus:'none'}));
  const app=express();app.use(express.json({limit:'8kb'}));mountVoiceRoutes({app,authenticate:auth,sessions:s.sessions,turns:s.service});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${server.address().port}`;
  const userToken=(id='1',expiresIn=60)=>jwt.sign({sub:id},'mock-user-secret',{issuer:'sehatroute-api',audience:'sehatroute-app',expiresIn});
  const request=async(path,method='GET',token=null,body)=>{const r=await fetch(url+path,{method,headers:{'Content-Type':'application/json',...(token ? {Authorization:`Bearer ${token}`} : {})},...(body ? {body:JSON.stringify(body)} : {})});return {status:r.status,body:await r.json()};};
  const path=`/api/agent/voice-sessions/${s.a.id}`;
  assert.equal((await request(path)).status,401);
  assert.equal((await request(path,'GET',userToken('1',-1))).status,401);
  assert.equal((await request(path,'GET',userToken())).status,200);
  assert.equal((await request(path+'/token','POST',userToken('2'),{})).status,404);
  assert.equal((await request('/api/agent/voice-sessions','POST',userToken(),{agentSessionId:'9',roomName:'forged'})).status,422);
  assert.equal((await request(path+'/turns','POST',userToken(),s.input)).body.data.result.reply,'approved');
  const internal=`/internal/agent/voice-sessions/${s.a.id}`;
  assert.equal((await request(internal+'/claim','POST',userToken(),{roomName:s.a.roomName,jobId:'AJ_mock',workerIdentity:'worker-mock'})).status,401);
  const iat=Math.floor(s.now()/1000);
  const credential=jwt.sign({sub:'sehatmate-worker',iat,exp:iat+60},env.VOICE_WORKER_AUTH_KEY,{issuer:'sehatmate-voice-worker',audience:'sehatmate-voice-claim'});
  const d=await request(internal+'/claim','POST',credential,{roomName:s.a.roomName,jobId:'AJ_mock',workerIdentity:'worker-mock'});
  assert.equal(d.status,200);assert.equal((await request(internal+'/turns/turn-1','GET',d.body.data.token)).body.data.status,'completed');
  assert.equal((await request(internal+'/turns','POST',d.body.data.token,{...s.input,turnId:'worker',userId:'2'})).status,422);
  assert.equal((await request(internal,'DELETE',d.body.data.token,{})).status,200);
  assert.equal((await request(path+'/token','POST',userToken(),{})).status,410);
  s.advance(61000);assert.equal((await request(internal+'/turns/turn-1','GET',d.body.data.token)).status,401);
});
test('old Worker termination is fenced again inside lifecycle lock after transport transfer',async()=>{
  const s=setup();const a=await create(s);
  const d=await s.sessions.claim({id:a.id,serviceIdentity:'sehatmate-worker',input:{roomName:a.roomName,jobId:'AJ_mock',workerIdentity:'worker-mock'}});
  const auth=s.sessions.verifyDelegation(d.token,a.id);await s.sessions.authorizeWorker(auth,a.id);
  await s.sessions.transport({userId:'1',id:a.id,input:{epoch:1,mode:'device'}});
  await expectCode(s.sessions.end({userId:'1',id:a.id,workerAuth:auth}),'VOICE_STALE_EPOCH');
  assert.equal((await s.sessions.get({userId:'1',id:a.id})).transportOwner,'device');
});

test('transport and end cannot race into a resurrected session',async()=>{
  let resolve;const gate=new Promise(r=>resolve=r);
  const s=setup({provider:{revoke:async()=>gate}});const a=await create(s);
  const switching=s.sessions.transport({userId:'1',id:a.id,input:{epoch:1,mode:'device'}});await new Promise(r=>setTimeout(r,10));
  await expectCode(s.sessions.end({userId:'1',id:a.id}),'VOICE_SESSION_BUSY');
  resolve();await switching;await s.sessions.end({userId:'1',id:a.id});
  assert.equal((await s.sessions.get({userId:'1',id:a.id})).status,'ended');
});
test('failed replacement provisioning preserves room cleanup and outstanding concurrency',async()=>{
  let calls=0,revocationFails=false,replacement;
  const s=setup({provider:{create:async row=>{calls++;if(calls>1) {replacement=row.roomName;throw new Error('partial create');}return {dispatchId:'AD_mock'};},
    revoke:async()=>{if(revocationFails) throw new Error('not revoked');}}});
  const a=await create(s);await s.sessions.transport({userId:'1',id:a.id,input:{epoch:1,mode:'device'}});
  await expectCode(s.sessions.transport({userId:'1',id:a.id,input:{epoch:2,mode:'worker'}}),'VOICE_PROVIDER_UNAVAILABLE');
  assert.equal((await s.sessions.get({userId:'1',id:a.id})).roomName,replacement);
  revocationFails=true;s.advance(601000);
  await expectCode(create(s),'VOICE_CONCURRENT_LIMIT');
});
test('daily accounting survives Agent deletion and remains charged for expired unrevoked rooms',async()=>{
  const s=setup({env:{VOICE_MAX_DAILY_SECONDS:'600'}});await create(s);s.advance(601000);
  const old=[...s.store.sessions.values()][0];old.agentSessionId=null;
  await expectCode(create(s),'VOICE_DAILY_LIMIT');
});



test('claim and completed receipts carry normal bound Agent speech policy without account restrictions',async()=>{
  const configured={FISH_API_KEY:'mock',FISH_TTS_MODEL:'s2.1-pro-free'};
  const s=await turnSetup(async()=>({ok:true,reply:'Metformin 500 mg at 08:30.'}),{env:configured});
  const claim=await s.sessions.claim({id:s.a.id,serviceIdentity:'sehatmate-worker',input:{roomName:s.a.roomName,jobId:'AJ_mock',workerIdentity:'worker-mock'}});
  assert.deepEqual(claim.speechPolicy,{v:1,voiceSessionId:s.a.id,epoch:1,mode:'agent_reply',provider:'fish',model:'s2.1-pro-free'});
  const completed=await s.service.submit({userId:'1',id:s.a.id,input:s.input});
  assert.deepEqual(completed.speechPolicy,{...claim.speechPolicy,turnId:'turn-1'});
  await expectCode(s.service.receipt({userId:'2',id:s.a.id,turnId:'turn-1'}),'VOICE_SESSION_NOT_FOUND');
  await expectCode(s.service.submit({userId:'1',id:s.a.id,input:{...s.input,turnId:'forged',speechPolicy:{mode:'agent_reply'}}}),'VOICE_INVALID_REQUEST');
  const patient=await turnSetup(async()=>({ok:true,reply:'An existing record.'}),{env:configured});
  const receipt=await patient.service.submit({userId:'1',id:patient.a.id,input:patient.input});
  assert.equal(receipt.speechPolicy.mode,'agent_reply');
});
