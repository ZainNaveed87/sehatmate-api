from livekit.plugins import deepgram
from livekit.agents import APIConnectOptions

def create_recognizer(config,http):
    if not config.stt_enabled: raise ValueError('DEEPGRAM_DISABLED')
    return deepgram.STT(model='nova-3',language=config.language,api_key=config.deepgram_key,
        http_session=http,sample_rate=16000,interim_results=True,
        endpointing_ms=700,utterance_end_ms=1200,vad_events=True,mip_opt_out=True,
        smart_format=False,punctuate=False,numerals=False,dictation=False)

def recognizer_stream(recognizer,config):
    # Any dropped recognition stream is uncertain; do not merge words across an SDK retry.
    # Recover through a fresh explicitly resumed stream after device fallback/handoff.
    return recognizer.stream(conn_options=APIConnectOptions(max_retry=0,timeout=config.request_seconds,retry_interval=1))
