import express from 'express';
import rateLimit from 'express-rate-limit';
import {agentConfig} from './agent_config.js';
import {voiceConfiguration,voiceSecrets} from './agent_voice_config.js';
import {readAgentSession} from './agent_session_store.js';
import {handleAgentMessage} from './agent_core.js';
import {createVoiceStore} from '../services/voice_store.js';
import {createVoiceSessionService} from '../services/voice_session_service.js';
import {createAgentTurnService} from '../services/agent_turn_service.js';
import {createLiveKitVoiceProvider} from '../services/livekit_voice_provider.js';
import {voiceError,strictObject} from '../services/voice_contract.js';

export function voiceHttpError(error,res) {
  const safe=typeof error.code==='string' && /^(VOICE_|AGENT_SESSION_NOT_FOUND)/.test(error.code);
  res.status(safe ? error.status||409 : 503).json({success:false,code:safe ? error.code:'VOICE_UNAVAILABLE',
    message:'Voice request could not be completed.'});
}
export function mountVoiceRoutes({app,authenticate,sessions,turns,limiter}) {
  const user=express.Router(),worker=express.Router();
  const userLimit=limiter||rateLimit({windowMs:60000,limit:60,standardHeaders:'draft-8',legacyHeaders:false,
    keyGenerator:req=>String(req.auth.userId),message:{success:false,code:'VOICE_RATE_LIMIT'}});
  const workerLimit=rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false,message:{success:false,code:'VOICE_RATE_LIMIT'}});
  const bounded=(req,_res,next)=>{if(Buffer.byteLength(JSON.stringify(req.body??{}))>8192) return next(voiceError('VOICE_INVALID_REQUEST',413));next();};
  const respond=fn=>async(req,res)=>{try {const data=await fn(req);res.set('Cache-Control','no-store');res.json({success:true,data});} catch(e) {voiceHttpError(e,res);}};
  const bearer=req=>{const value=req.get('authorization')||'';if(!/^Bearer [^ ]+$/.test(value)) throw voiceError('VOICE_WORKER_UNAUTHORIZED',401);return value.slice(7);};
  user.use(authenticate,userLimit,bounded);
  user.post('/',respond(req=>sessions.create({userId:req.auth.userId,input:req.body})));
  user.post('/:id/token',respond(req=>{strictObject(req.body??{},[]);return sessions.token({userId:req.auth.userId,id:req.params.id});}));
  user.post('/:id/transport',respond(req=>sessions.transport({userId:req.auth.userId,id:req.params.id,input:req.body})));
  user.post('/:id/turns',respond(req=>turns.submit({userId:req.auth.userId,id:req.params.id,input:req.body})));
  user.get('/:id/turns/:turnId',respond(req=>turns.receipt({userId:req.auth.userId,id:req.params.id,turnId:req.params.turnId})));
  user.get('/:id',respond(req=>sessions.get({userId:req.auth.userId,id:req.params.id})));
  user.delete('/:id',respond(req=>{strictObject(req.body??{},[]);return sessions.end({userId:req.auth.userId,id:req.params.id});}));
  worker.use(workerLimit,bounded);
  worker.post('/:id/claim',respond(req=>sessions.claim({id:req.params.id,serviceIdentity:sessions.verifyService(bearer(req)),input:req.body})));
  worker.post('/:id/turns',respond(async req=>{
    const auth=sessions.verifyDelegation(bearer(req),req.params.id),s=await sessions.authorizeWorker(auth,req.params.id);
    return turns.submit({userId:s.userId,id:s.id,input:req.body,workerAuth:auth});
  }));
  worker.get('/:id/turns/:turnId',respond(async req=>{
    const auth=sessions.verifyDelegation(bearer(req),req.params.id),s=await sessions.authorizeWorker(auth,req.params.id);
    return turns.receipt({userId:s.userId,id:s.id,turnId:req.params.turnId});
  }));
  worker.delete('/:id',respond(async req=>{
    strictObject(req.body??{},[]);
    const auth=sessions.verifyDelegation(bearer(req),req.params.id),s=await sessions.authorizeWorker(auth,req.params.id);
    return sessions.end({userId:s.userId,id:s.id,workerAuth:auth});
  }));
  const errors=(error,_req,res,_next)=>voiceHttpError(error,res);
  user.use(errors);worker.use(errors);
  app.use('/api/agent/voice-sessions',user);app.use('/internal/agent/voice-sessions',worker);
}
export function installVoiceBackend({app,pool,lockPool,sessionLockPool,authenticate}) {
  const config=voiceConfiguration(),secrets=voiceSecrets(),store=createVoiceStore(pool,{lockPool,sessionLockPool});
  // A kill switch still permits cleanup when valid provider credentials remain available.
  const livekit=config.providers.livekit ? createLiveKitVoiceProvider({config,secrets}) : {
    create:async()=>{throw voiceError('VOICE_DISABLED',503);},token:async()=>{throw voiceError('VOICE_DISABLED',503);},
    binding:async()=>false,revoke:async()=>{throw voiceError('VOICE_DISABLED',503);},
  };
  const readAgent=({userId,sessionId})=>readAgentSession({db:pool,userId,sessionId});
  const sessions=createVoiceSessionService({store,config,secrets,livekit,readAgent,agentEnabled:()=>agentConfig().enabled});
  const turns=createAgentTurnService({store,sessions,config,receiptKey:secrets.receiptKey||Buffer.alloc(32).toString('base64'),
    readAgent,handleAgent:args=>handleAgentMessage({pool,...args})});
  mountVoiceRoutes({app,authenticate,sessions,turns});
  let sweeping=false;
  const sweep=async()=>{
    if(sweeping||!config.providers.livekit) return;sweeping=true;
    try {
      for(const s of await store.sweepCandidates(Date.now(),config.idleSeconds,!config.enabled||!agentConfig().enabled)) {
        try {await sessions.end({userId:s.userId,id:s.id});} catch { /* Persisted closing state retries next sweep. */ }
      }
      await store.prune(Date.now());
    } catch {console.warn('Voice maintenance unavailable; check migration and provider availability.');}
    finally {sweeping=false;}
  };
  if(config.providers.livekit) {const timer=setInterval(sweep,15000);timer.unref();}
  return {turns};
}
