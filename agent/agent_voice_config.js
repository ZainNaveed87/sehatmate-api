// Public configuration contains availability flags, never credentials.
const GENERIC_PROMPTS = Object.freeze({welcome:'Welcome to SehatMate.', waiting:'Please wait.', goodbye:'Goodbye.',confirmed:'Confirmed. The change was saved.'});
export const genericSpeechCatalog = () => ({...GENERIC_PROMPTS});
export function legacyFishSpeechAllowed(model,text) {
  if(!isFishSpeechModel(model)) return true;
  return ['s2.1-pro-free','fish-audio/s2.1-pro-free:free'].includes(model) && typeof text === 'string' && text.length > 0;
}
export const isFishSpeechModel = model => /fish|^s2[.-]/i.test(String(model));
const integer = (raw, fallback, min, max) => raw == null ? fallback :
  (/^\d+$/.test(String(raw)) && Number(raw) >= min && Number(raw) <= max ? Number(raw) : null);
const flag = (raw, fallback = false) => raw == null ? fallback : String(raw).toLowerCase() === 'true';
const present = (raw, min = 1) => typeof raw === 'string' && raw.trim().length >= min;
export function voiceSecrets(env = process.env) {
  return {livekitKey:env.LIVEKIT_API_KEY?.trim(), livekitSecret:env.LIVEKIT_API_SECRET?.trim(),
    workerKey:env.VOICE_WORKER_AUTH_KEY, delegationSecret:env.VOICE_DELEGATION_SECRET,
    receiptKey:env.VOICE_RECEIPT_ENCRYPTION_KEY};
}
// Authoritative reply speech is available to every authenticated owned session.
// Client flags and account attributes never select the policy.
export function sessionSpeechPolicy(config, session, turnId = undefined) {
  const policy={v:1,voiceSessionId:session.id,epoch:session.epoch,
    mode:config.providers.fish ? 'agent_reply':'device_only',
    provider:'fish',model:'s2.1-pro-free'};
  if(turnId!==undefined) policy.turnId=turnId;
  return policy;
}
export function voiceConfiguration(env = process.env) {
  let livekitUrl = null;
  try { const u = new URL(env.LIVEKIT_URL); if (u.protocol === 'wss:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash) livekitUrl = u.origin; } catch {}
  const maxSessionSeconds = integer(env.VOICE_MAX_SESSION_SECONDS,600,30,3600);
  const maxDailySeconds = integer(env.VOICE_MAX_DAILY_SECONDS,3600,30,86400);
  const maxConcurrentSessions = integer(env.VOICE_MAX_CONCURRENT_SESSIONS,1,1,5);
  const idleSeconds = integer(env.VOICE_IDLE_TIMEOUT_SECONDS,60,15,600);
  const turnTimeoutSeconds = integer(env.VOICE_TURN_TIMEOUT_SECONDS,120,5,180);
  const receiptTtlSeconds = integer(env.VOICE_RECEIPT_TTL_SECONDS,86400,600,86400);
  const receiptKeyValid = typeof env.VOICE_RECEIPT_ENCRYPTION_KEY === 'string' &&
    /^[A-Za-z0-9+/]{43}=$/.test(env.VOICE_RECEIPT_ENCRYPTION_KEY) && Buffer.from(env.VOICE_RECEIPT_ENCRYPTION_KEY,'base64').length === 32;
  const configured = Boolean(livekitUrl && present(env.LIVEKIT_API_KEY) && present(env.LIVEKIT_API_SECRET,32) &&
    present(env.VOICE_WORKER_AUTH_KEY,32) && present(env.VOICE_DELEGATION_SECRET,32) && receiptKeyValid &&
    env.VOICE_WORKER_AUTH_KEY !== env.VOICE_DELEGATION_SECRET);
  const valid = [maxSessionSeconds,maxDailySeconds,maxConcurrentSessions,idleSeconds,turnTimeoutSeconds,receiptTtlSeconds].every(Number.isInteger) && maxDailySeconds >= maxSessionSeconds;
  return Object.freeze({enabled:flag(env.REALTIME_VOICE_ENABLED) && configured && valid,
    configured, valid, livekitUrl, maxSessionSeconds,maxDailySeconds,maxConcurrentSessions,idleSeconds,turnTimeoutSeconds,receiptTtlSeconds,
    agentName:'sehatmate-voice', tokenTtlSeconds:60, delegationTtlSeconds:60,
    providers:{livekit:configured && valid, deepgram:present(env.DEEPGRAM_API_KEY) && !flag(env.DEEPGRAM_DISABLED),
      fish:present(env.FISH_API_KEY) && env.FISH_TTS_MODEL === 's2.1-pro-free' && !flag(env.FISH_DISABLED)},
    policy:{fishGenericOnly:false, fishModel:'s2.1-pro-free', deepgramMipOptOut:true, automaticPaidFallback:false},
  });
}
export function speechDisposition(config, {reply,genericPrompt} = {}) {
  if(config.providers.fish && typeof reply === 'string' && reply.trim() && Buffer.byteLength(reply,'utf8')<=65536) {
    return {provider:'fish',model:'s2.1-pro-free',text:reply};
  }
  if (config.providers.fish && Object.hasOwn(GENERIC_PROMPTS,genericPrompt || '')) {
    return {provider:'fish',model:'s2.1-pro-free',text:GENERIC_PROMPTS[genericPrompt]};
  }
  return {provider:'device'};
}
