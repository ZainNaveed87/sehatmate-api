const stages=new Set(['BACKEND_REQUEST','BACKEND_RESPONSE','REPLY_EXTRACTED','ACTIONS_EXTRACTED','FAILED']);
const statuses=new Set(['completed','processing','recovery_required','stale','receipt_expired']);
export function voiceTurnCorrelation(turnId) {
  let value=2166136261;
  for(const byte of Buffer.from(turnId,'utf8')) value=Math.imul(value^byte,16777619)>>>0;
  return value.toString(16).padStart(8,'0');
}
export function traceVoiceTurn(stage,turnId,{status,error}={}) {
  if(!stages.has(stage)||typeof turnId!=='string'||!turnId.length||turnId.length>80) return;
  const record={stage:`VOICE_TURN_${stage}`,correlation:voiceTurnCorrelation(turnId)};
  if(statuses.has(status)) record.status=status;
  if(error!=null) record.error=['AGENT','PERSIST'].includes(error)?error:'OTHER';
  console.info(JSON.stringify(record));
}
