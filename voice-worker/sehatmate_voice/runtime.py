"""LiveKit SDK transport primitives; no LLM, tools or conversation memory."""
import asyncio
import json
import time
from dataclasses import replace
from datetime import datetime
import aiohttp
from livekit import rtc
from livekit.agents import AutoSubscribe, stt
from .bridge import BackendBridge, BridgeError
from .config import Config
from .deepgram_adapter import create_recognizer, recognizer_stream
from .events import Events, ID
from .fish_adapter import FishAudio
from .http_client import HttpClient
from .session import VoiceSession

class Playback:
    def __init__(self,source): self.source=source
    async def play(self,audio):
        for start in range(0,len(audio),960):
            chunk=audio[start:start+960]
            await self.source.capture_frame(rtc.AudioFrame(chunk,24000,1,len(chunk)//2))
        await self.source.wait_for_playout()
    async def stop(self): self.source.clear_queue()

class Microphone:
    def __init__(self,session,recognizer,config):
        self.session,self.recognizer,self.config=session,recognizer,config
        self.audio=None;self.stream=None;self.task=None;self.track=None
        self.lock=asyncio.Lock()
        self.retired=set()
        self.readers=set()

    async def start(self,track):
        async with self.lock:
            await self._stop();self.track=track
            if not self.session.listening or self.session.closed: return
            self.audio=rtc.AudioStream(track,sample_rate=16000,num_channels=1,capacity=10,frame_size_ms=20)
            self.stream=recognizer_stream(self.recognizer,self.config)
            self.task=asyncio.create_task(self._run())

    async def stop(self):
        async with self.lock: await self._stop()

    async def _stop(self):
        task=self.task;self.task=None
        if task and task is not asyncio.current_task() and asyncio.current_task() not in self.readers:
            # Never await the supervisor here: its reader can be the caller of pause().
            task.cancel();self.retired.add(task)
            def done(t):
                self.retired.discard(t)
                if not t.cancelled(): t.exception()
            task.add_done_callback(done)
        if self.stream: await self.stream.aclose();self.stream=None
        if self.audio: await self.audio.aclose();self.audio=None
        self.session.transcript.clear()

    async def _run(self):
        audio,stream=self.audio,self.stream
        utterance_started=None
        async def feed():
            async for event in audio:
                if not self.session.listening or self.session.closed: break
                if utterance_started and time.monotonic()-utterance_started>self.config.audio_seconds:
                    raise ValueError('AUDIO_DURATION_LIMIT')
                stream.push_frame(event.frame)
        async def receive():
            nonlocal utterance_started
            async for event in stream:
                text=event.alternatives[0].text if event.alternatives else ''
                kind={stt.SpeechEventType.START_OF_SPEECH:'start',stt.SpeechEventType.INTERIM_TRANSCRIPT:'interim',
                    stt.SpeechEventType.FINAL_TRANSCRIPT:'final',stt.SpeechEventType.END_OF_SPEECH:'end'}.get(event.type)
                if kind=='start': utterance_started=time.monotonic()
                if kind=='end': utterance_started=None
                if kind: await self.session.speech_event(kind,text)
        feeding=asyncio.create_task(feed());receiving=asyncio.create_task(receive())
        self.readers.update((feeding,receiving))
        try:
            done,_=await asyncio.wait((feeding,receiving),return_when=asyncio.FIRST_COMPLETED)
            for task in done: task.result()
            if not self.session.listening and receiving not in done:
                await asyncio.wait_for(receiving,self.config.request_seconds)
            if not self.session.closed and self.session.listening: raise ValueError('STT_STREAM_ENDED')
        except asyncio.CancelledError: raise
        except Exception as error:
            # The stream is stopped before fallback. Never carry partial words across reconnects.
            self.session.listening=False
            await stream.aclose();await audio.aclose();self.session.transcript.clear()
            status=getattr(error,'status_code',None)
            code='DEEPGRAM_RATE_LIMIT' if status==429 else 'DEEPGRAM_QUOTA' if status==402 else 'DEEPGRAM_UNAVAILABLE'
            if not self.session.closed: await self.session.fallback('stt',code)
        finally:
            feeding.cancel();receiving.cancel();await asyncio.gather(feeding,receiving,return_exceptions=True)
            self.readers.difference_update((feeding,receiving))

async def cleanup_resources(session,microphone,tasks,source,room):
    # Every resource must close even when sending the final room event fails.
    if session: await asyncio.gather(session.close(),return_exceptions=True)
    if microphone:
        await asyncio.gather(microphone.stop(),return_exceptions=True)
        await asyncio.gather(*microphone.retired,return_exceptions=True)
        await asyncio.gather(microphone.recognizer.aclose(),return_exceptions=True)
    pending=list(tasks)
    for task in pending: task.cancel()
    await asyncio.gather(*pending,return_exceptions=True)
    await asyncio.gather(source.aclose(),return_exceptions=True)
    await asyncio.gather(room.disconnect(),return_exceptions=True)

async def resume_input(session,microphone,*,muted,recovering):
    if microphone is None or recovering or session.closed:
        session.listening=False
        return
    # Resume records intent even before publication/subscription/unmute arrives.
    # The corresponding track callback starts input only while this intent holds.
    if microphone.track and not muted:
        await microphone.start(microphone.track)

async def run_job(ctx):
    try: await _run_job(ctx)
    except Exception:
        # Includes startup/connection failures; never serialize exception/provider bodies.
        try: await ctx.room.disconnect()
        finally: ctx.shutdown('voice worker unavailable')

async def _run_job(ctx):
    config=Config.from_env()
    try:
        metadata=json.loads(ctx.job.metadata)
        if set(metadata)!={'voiceSessionId'} or not ID.fullmatch(metadata['voiceSessionId']) or ctx.job.enable_recording:
            raise ValueError('Unauthorized job metadata')
    except (ValueError,TypeError,KeyError): ctx.shutdown('invalid dispatch');return
    await asyncio.wait_for(ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE),config.request_seconds)
    source=rtc.AudioSource(24000,1,queue_size_ms=100)
    track=rtc.LocalAudioTrack.create_audio_track('sehatmate-agent-speech',source)
    try: await ctx.room.local_participant.publish_track(track,rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    except Exception:
        await source.aclose();raise
    callbacks=[]; tasks=set(); session=None;microphone=None;cleaned=False
    async def cleanup():
        nonlocal cleaned
        if cleaned: return
        cleaned=True
        for kind,fn in callbacks: ctx.room.off(kind,fn)
        await cleanup_resources(session,microphone,tasks,source,ctx.room)
    ctx.add_shutdown_callback(cleanup)
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=config.request_seconds),trust_env=False) as http:
        bridge=BackendBridge(config,HttpClient(http,config.request_seconds),metadata['voiceSessionId'],ctx.room.name,ctx.job.id,ctx.room.local_participant.identity)
        try:
            claimed=None
            for attempt in range(config.retries+1):
                try: claimed=await bridge.claim();break
                except BridgeError as error:
                    if error.code not in ('VOICE_WORKER_BINDING','VOICE_PROVIDER_UNAVAILABLE','BACKEND_NETWORK_UNCERTAIN') or attempt==config.retries: raise
                    await asyncio.sleep(1)
            expected=claimed['participantIdentity']
            async def send(value):
                await ctx.room.local_participant.publish_data(json.dumps(value).encode(),reliable=True,
                    destination_identities=[expected],topic='sehatmate.voice.v1')
            events=Events(metadata['voiceSessionId'],claimed['epoch'],send)
            fish=FishAudio(config,http,claimed['genericPrompts'],claimed.get('speechPolicy'))
            if not claimed['providers']['fish']: fish.config=replace(config,fish_enabled=False)
            session=VoiceSession(config,bridge,events,fish,Playback(source))
            if config.stt_enabled and claimed['providers']['deepgram']:
                microphone=Microphone(session,create_recognizer(config,http),config)
                session.stop_input=microphone.stop
            ended=asyncio.Event(); mic_muted=True;recovering=False
            def spawn(coro):
                task=asyncio.create_task(coro);tasks.add(task)
                def finished(t):
                    tasks.discard(t)
                    if not t.cancelled() and t.exception(): ended.set() # No exception/provider body logging.
                task.add_done_callback(finished)
                return task
            def bind(kind,fn): ctx.room.on(kind,fn);callbacks.append((kind,fn))
            def authorized(publication,participant):
                return participant.identity==expected and publication.source==rtc.TrackSource.SOURCE_MICROPHONE
            async def resume():
                await resume_input(session,microphone,muted=mic_muted,recovering=recovering)
            session.on_resume=resume
            def subscribed(remote_track,publication,participant):
                nonlocal mic_muted
                if authorized(publication,participant):
                    if microphone: microphone.track=remote_track
                    mic_muted=publication.muted
                    if not mic_muted and microphone and session.listening: spawn(microphone.start(remote_track))
            def published(publication,participant):
                if authorized(publication,participant): publication.set_subscribed(True)
            def unsubscribed(remote_track,publication,participant):
                nonlocal mic_muted
                if authorized(publication,participant) and microphone and microphone.track is remote_track:
                    microphone.track=None;mic_muted=True;spawn(session.pause())
            def muted(participant,publication):
                nonlocal mic_muted
                if authorized(publication,participant): mic_muted=True;spawn(session.pause())
            def unmuted(participant,publication):
                nonlocal mic_muted
                if authorized(publication,participant):
                    mic_muted=False
                    if session.listening and not recovering: spawn(resume())
            def participant_left(participant):
                if participant.identity==expected: ended.set()
            def data(packet):
                if not packet.participant or packet.participant.identity!=expected or packet.topic!='sehatmate.voice.control.v1' or len(packet.data)>1024: return
                try: value=json.loads(packet.data)
                except (ValueError,UnicodeDecodeError): return
                async def control():
                    if await session.control(value) and value['type']=='cancel': ended.set()
                spawn(control())
            def reconnecting():
                nonlocal recovering
                recovering=True;spawn(session.pause());spawn(session.interrupt());spawn(events.emit('recovering',code='LIVEKIT_RECONNECTING'))
            def reconnected():
                nonlocal recovering
                recovering=False;spawn(events.emit('ready',requiresResume=True)) # Never auto-rearm microphone.
            def disconnected(*_): ended.set()
            for name,fn in [('track_subscribed',subscribed),('track_unsubscribed',unsubscribed),('track_published',published),('track_muted',muted),('track_unmuted',unmuted),
                ('participant_disconnected',participant_left),('data_received',data),('reconnecting',reconnecting),('reconnected',reconnected),('disconnected',disconnected)]: bind(name,fn)
            participant=await asyncio.wait_for(ctx.wait_for_participant(identity=expected),config.idle_seconds)
            for publication in participant.track_publications.values():
                published(publication,participant)
                if publication.track: subscribed(publication.track,publication,participant)
            await events.emit('ready',language=config.language,participantIdentity=expected)
            if not microphone: await session.fallback('stt','DEEPGRAM_DISABLED')
            expires=min(time.time()+config.session_seconds,datetime.fromisoformat(claimed['sessionExpiresAt'].replace('Z','+00:00')).timestamp())
            renewal=time.monotonic()+25
            while not ended.is_set() and not session.closed:
                if time.time()>=expires or session.clock()-session.last_activity>=min(config.idle_seconds,claimed['idleTimeoutSeconds']): break
                if time.monotonic()>=renewal:
                    try: await bridge.claim()
                    except BridgeError:
                        await session.pause();await session.interrupt();await events.emit('recovering',code='SESSION_AUTHORIZATION_LOST');break
                    renewal=time.monotonic()+25
                try: await asyncio.wait_for(ended.wait(),1)
                except asyncio.TimeoutError: pass
        finally:
            await cleanup()
            ctx.shutdown('voice session ended')
