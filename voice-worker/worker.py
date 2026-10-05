import asyncio
import json
import logging
import os
import sys
from sehatmate_voice.config import Config

def main():
    config=Config.from_env()
    if os.environ.get('LIVEKIT_AGENT_NAME_OVERRIDE') not in (None,'sehatmate-voice'): raise ValueError('Invalid Agent name override')
    os.environ['OTEL_SDK_DISABLED']='true'
    # SDK/provider logs may carry transcript/error bodies. Only sanitized protocol events are emitted.
    logging.disable(logging.CRITICAL)
    if len(sys.argv)>1 and sys.argv[1]=='check':
        from sehatmate_voice.diagnostics import preflight
        result=preflight(config)
        print(json.dumps(result))
        raise SystemExit(0 if result['ok'] else 1)
    from livekit.agents import AgentServer,JobExecutorType,cli
    from sehatmate_voice.runtime import run_job
    server=AgentServer(ws_url=config.livekit_url,api_key=config.livekit_key,api_secret=config.livekit_secret,
        job_executor_type=JobExecutorType.THREAD,
        host='0.0.0.0',port=8081,
        max_retry=config.retries,num_idle_processes=0,load_threshold=1,
        load_fnc=lambda _:len(slots)/config.concurrent_jobs,drain_timeout=20,shutdown_process_timeout=20)
    slots=set();lock=asyncio.Lock()
    async def request(job):
        async with lock:
            try:
                metadata=json.loads(job.job.metadata)
                valid=set(metadata)=={'voiceSessionId'} and isinstance(metadata['voiceSessionId'],str) and not job.job.enable_recording
            except (ValueError,TypeError,KeyError): valid=False
            if not valid or len(slots)>=config.concurrent_jobs: await job.reject();return
            slots.add(job.id)
        try: await job.accept(identity=f'agent-{job.id}')
        except Exception: slots.discard(job.id);raise
    async def ended(ctx): slots.discard(ctx.job.id)
    server.rtc_session(run_job,agent_name='sehatmate-voice',on_request=request,on_session_end=ended)
    cli.run_app(server)

if __name__=='__main__':
    try: main()
    except Exception:
        print('Worker startup failed; check configuration and supported SDK/native runtime. No credentials logged.')
        raise SystemExit(1) from None
