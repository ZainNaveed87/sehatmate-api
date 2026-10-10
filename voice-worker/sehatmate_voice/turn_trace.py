"""Bounded stage-only diagnostics. Never accept payloads or arbitrary error text."""
import json

STAGES=frozenset(('TRANSCRIPT_FINAL','BACKEND_REQUEST','BACKEND_RESPONSE','REPLY_EXTRACTED',
    'ACTIONS_EXTRACTED','UI_EVENT_SENT','TTS_ENQUEUED','TTS_STARTED','TTS_AUDIO_READY',
    'TTS_PUBLISHED','COMPLETE','TTS_SUPPRESSED','TTS_FAILED','TTS_INTERRUPTED','FAILED'))
STATUSES=frozenset(('completed','processing','recovery_required','stale','receipt_expired',
    'NOT_LISTENING','GENERATION_CHANGED','NO_REPLY','STT_LANGUAGE_UPDATE_FAILED'))
ERRORS=frozenset(('BACKEND','RESULT','TTS','FISH_RATE_LIMIT','FISH_QUOTA','FISH_REQUEST_LIMIT',
    'FISH_DISABLED','FISH_UNAVAILABLE','FISH_INVALID_AUDIO','FISH_AUDIO_LIMIT','FISH_TEXT_LIMIT',
    'FISH_TEXT_SEGMENT_LIMIT','FISH_MODEL_REJECTED','DEVICE_TTS_REQUIRED','VOICE_PLAYBACK_FAILED'))

def correlation(turn_id):
    # Turn IDs are random opaque non-secret values. This is correlation, not auth.
    value=2166136261
    for byte in turn_id.encode('utf-8'): value=((value^byte)*16777619)&0xffffffff
    return f'{value:08x}'

def trace(stage,turn_id,*,status=None,error=None):
    if stage not in STAGES or not isinstance(turn_id,str) or not 0<len(turn_id)<=80: return
    record={'stage':'VOICE_TURN_'+stage,'correlation':correlation(turn_id)}
    if status in STATUSES: record['status']=status
    if error is not None: record['error']=error if error in ERRORS else 'OTHER'
    print(json.dumps(record,separators=(',',':')),flush=True)
