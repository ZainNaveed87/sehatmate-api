import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';
import {sessionSpeechPolicy} from '../agent/agent_voice_config.js';
import {voiceError,strictObject,opaqueId,millis} from './voice_contract.js';

const approvedFields=['sessionId','language','reply','navigation','confirmation','clarification','actionStatus','referencedEntities','fallbackCode','uiPlan','memoryProposal','conflicts'];
const canonical=value=>JSON.stringify(value && typeof value==='object' ? Array.isArray(value) ? value.map(v=>JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])) : value);
export function createAgentTurnService({store,sessions,config,receiptKey,handleAgent,readAgent,now=Date.now}) {
  const key=Buffer.from(receiptKey,'base64');
  const hash=value=>createHmac('sha256',key).update(canonical(value)).digest('hex');
  const aad=r=>Buffer.from(`${r.voiceSessionId}:${r.turnId}`);
  function encrypt(result,r) {
    const approved=Object.fromEntries(approvedFields.filter(k=>result[k]!==undefined).map(k=>[k,result[k]]));
    const text=JSON.stringify(approved);if(Buffer.byteLength(text)>65536) throw voiceError('VOICE_RESULT_TOO_LARGE');
    const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(aad(r));
    return Buffer.concat([iv,c.update(text),c.final(),c.getAuthTag()]).toString('base64');
  }
  function decrypt(r) {
    const b=Buffer.from(r.encryptedResult,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));
    d.setAAD(aad(r));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString());
  }
  function validate(input) {
    strictObject(input,['epoch','turnId','message','today','screenContext','confirmation','clarification']);
    if(!opaqueId(input.turnId)||!Number.isInteger(input.epoch)||input.epoch<0) throw voiceError('VOICE_INVALID_REQUEST',422);
    const count=[input.message!=null,input.confirmation!=null,input.clarification!=null].filter(Boolean).length;
    if(count!==1||input.message!=null && (typeof input.message!=='string'||!input.message.trim()||input.message.length>4000)) throw voiceError('VOICE_INVALID_REQUEST',422);
    if(input.today!=null && (typeof input.today!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input.today)||!Number.isFinite(Date.parse(input.today))||new Date(input.today).toISOString().slice(0,10)!==input.today)) throw voiceError('VOICE_INVALID_REQUEST',422);
    if(input.screenContext!=null && (typeof input.screenContext!=='object'||Array.isArray(input.screenContext)||Buffer.byteLength(JSON.stringify(input.screenContext))>4096)) throw voiceError('VOICE_INVALID_REQUEST',422);
    if(input.confirmation!=null) {
      strictObject(input.confirmation,['confirmationId','decision']);
      if(!opaqueId(input.confirmation.confirmationId)||!['confirm','cancel'].includes(input.confirmation.decision)) throw voiceError('VOICE_INVALID_REQUEST',422);
    }
    if(input.clarification!=null) {
      strictObject(input.clarification,['clarificationId','choiceId']);
      if(!opaqueId(input.clarification.clarificationId)||!opaqueId(input.clarification.choiceId)) throw voiceError('VOICE_INVALID_REQUEST',422);
    }
  }
  async function view(r,s) {
    if(!r) throw voiceError('VOICE_TURN_NOT_FOUND',404);
    let status=r.status;
    if(status==='processing' && millis(r.startedAt)+config.turnTimeoutSeconds*1000<=now()) status='recovery_required';
    // Fences are checked even for old receipts; an old navigation instruction is never current.
    if(status==='completed' && (!config.enabled||s.status!=='active'||s.epoch!==r.epoch||millis(s.expiresAt)<=now()||millis(s.lastActiveAt)+config.idleSeconds*1000<=now())) status='stale';
    const response={turnId:r.turnId,status,epoch:r.epoch};
    if(status==='completed' && r.encryptedResult && millis(r.resultExpiresAt)>now()) {
      try {response.result=decrypt(r);} catch {response.status='recovery_required';}
    } else if(status==='completed') response.status='receipt_expired';
    if(response.status==='completed' && response.result) response.speechPolicy=sessionSpeechPolicy(config,s,r.turnId);
    return response;
  }
  async function receipt({userId,id,turnId}) {
    if(!opaqueId(turnId)) throw voiceError('VOICE_INVALID_REQUEST',422);
    const s=await sessions.owned(userId,id);return view(await store.getReceipt(id,turnId),s);
  }
  async function submit({userId,id,input,workerAuth=null}) {
    validate(input);userId=String(userId);
    const initial=await sessions.owned(userId,id);
    if(workerAuth) await sessions.authorizeWorker(workerAuth,id);
    if(initial.epoch!==input.epoch) throw voiceError('VOICE_STALE_EPOCH');
    const requestHash=hash(input);
    const confirmationHash=input.confirmation ? hash({confirmation:input.confirmation}) : null;
    const prior=await store.getReceipt(id,input.turnId);
    if(prior) {if(prior.requestHash!==requestHash) throw voiceError('VOICE_TURN_CONFLICT');return view(prior,initial);}
    await sessions.active(initial);
    const unlock=await store.acquireAgentLock(userId,initial.agentSessionId);
    if(!unlock) throw voiceError('VOICE_TURN_BUSY');
    let r;
    try {
      const existing=await store.transaction(userId,async db=>{
        const s=await sessions.active(await sessions.owned(userId,id,db));
        if(s.epoch!==input.epoch) throw voiceError('VOICE_STALE_EPOCH');
        if(workerAuth && (s.transportOwner!=='worker'||workerAuth.jobId!==s.jobId||workerAuth.workerIdentity!==s.workerIdentity)) throw voiceError('VOICE_STALE_EPOCH');
        const previous=await db.getReceipt(id,input.turnId);
        if(previous) {if(previous.requestHash!==requestHash) throw voiceError('VOICE_TURN_CONFLICT');return previous;}
        if(input.confirmation) {
          const consumed=await db.findConfirmation(s.agentSessionId,input.confirmation.confirmationId);
          if(consumed) {if(consumed.confirmationHash!==confirmationHash) throw voiceError('VOICE_TURN_CONFLICT');return consumed;}
        }
        // Check every voice record for this Agent session, including ended sessions.
        const siblings=await db.listSessions(userId);
        const blocker=siblings.find(other=>other.agentSessionId===s.agentSessionId && other.activeTurnId);
        if(blocker) {
          const pending=await db.getReceipt(blocker.id,blocker.activeTurnId);
          throw voiceError(pending?.status==='recovery_required'||!pending||millis(pending.startedAt)+config.turnTimeoutSeconds*1000<=now() ? 'VOICE_RECOVERY_REQUIRED':'VOICE_TURN_BUSY');
        }
        if(input.confirmation) {
          const agent=await readAgent({userId,sessionId:s.agentSessionId});
          const pending=agent.ok && agent.data.session.state.pendingConfirmation;
          if(!pending||pending.confirmationId!==input.confirmation.confirmationId||pending.expiresAt && millis(pending.expiresAt)<=now()) throw voiceError('VOICE_CONFIRMATION_NOT_CURRENT');
        }
        r={voiceSessionId:id,userId,agentSessionId:s.agentSessionId,turnId:input.turnId,epoch:s.epoch,
          requestHash,confirmationId:input.confirmation?.confirmationId||null,confirmationHash,status:'processing',
          startedAt:new Date(now()).toISOString(),finishedAt:null,encryptedResult:null,resultExpiresAt:new Date(now()+config.receiptTtlSeconds*1000).toISOString()};
        await db.saveReceipt(r);s.activeTurnId=r.turnId;s.lastActiveAt=new Date(now()).toISOString();await db.saveSession(s);
        return null;
      });
      if(existing) {await unlock();return view(existing,await sessions.owned(userId,id));}
    } catch(error) {await unlock();throw error;}
    const execution=(async()=>{
      try {
        const result=await handleAgent({userId,sessionId:initial.agentSessionId,message:input.message,
          clientContext:input.screenContext||null,confirmation:input.confirmation||null,clarification:input.clarification||null,clientToday:input.today||null,
          voiceReply:true});
        // The core may report a mutation failure after a partial write; this is uncertain.
        if(!result?.ok||result.fallbackCode==='AGENT_CAPABILITY_FAILED') throw voiceError('VOICE_AGENT_UNCERTAIN');
        r.encryptedResult=encrypt(result,r);r.status='completed';
      } catch {r.status='recovery_required';r.encryptedResult=null;}
      r.finishedAt=new Date(now()).toISOString();
      try {
        await store.transaction(userId,async db=>{
          const s=await sessions.owned(userId,id,db);
          if(r.status==='completed' && (s.status!=='active'||s.epoch!==r.epoch||millis(s.expiresAt)<=now())) {r.status='stale';r.encryptedResult=null;}
          await db.saveReceipt(r);
          if(r.status!=='recovery_required' && s.activeTurnId===r.turnId) {s.activeTurnId=null;await db.saveSession(s);}
        });
        return await view(r,await sessions.owned(userId,id));
      } catch {return {turnId:r.turnId,status:'recovery_required',epoch:r.epoch};}
      finally {await unlock();}
    })();
    // Timeout does not cancel the Agent or release its lock. Poll the same receipt; never replay.
    let timer;
    const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve({turnId:r.turnId,status:'processing',epoch:r.epoch}),config.turnTimeoutSeconds*1000);});
    try {return await Promise.race([execution,timeout]);} finally {clearTimeout(timer);}
  }
  async function manual({userId,sessionId,run}) {
    // New Agent sessions have no prior shared state. Existing sessions share the voice fence.
    if(!sessionId) return run();
    const unlock=await store.acquireAgentLock(String(userId),String(sessionId));
    if(!unlock) throw voiceError('VOICE_TURN_BUSY');
    try {
      let rows;try {rows=await store.listSessions(String(userId));}
      catch(e) {if(!config.enabled && e.code==='ER_NO_SUCH_TABLE') return await run();throw e;}
      if(rows.some(s=>s.agentSessionId===String(sessionId)&&s.activeTurnId)) throw voiceError('VOICE_RECOVERY_REQUIRED');
      return await run();
    } finally {await unlock();}
  }
  return {submit,receipt,manual};
}
