import asyncio
import importlib.util
import pathlib
import sys
import types
import unittest
from unittest.mock import patch
from unittest.mock import AsyncMock
from test_session import session
from test_bridge_providers import config

def load_runtime():
    # Native SDK surfaces mocked explicitly; production module itself is executed.
    fake_agents=types.ModuleType('livekit.agents');fake_agents.AutoSubscribe=object()
    fake_agents.stt=types.SimpleNamespace(SpeechEventType=types.SimpleNamespace(START_OF_SPEECH='start',INTERIM_TRANSCRIPT='interim',FINAL_TRANSCRIPT='final',END_OF_SPEECH='end'))
    fake_lk=types.ModuleType('livekit');fake_lk.rtc=types.SimpleNamespace()
    adapter=types.ModuleType('sehatmate_voice.deepgram_adapter');adapter.create_recognizer=lambda *a:None;adapter.recognizer_stream=lambda r,c:r
    spec=importlib.util.spec_from_file_location('sehatmate_voice.mocked_worker_runtime',pathlib.Path('sehatmate_voice/runtime.py'));mod=importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules,{'livekit':fake_lk,'livekit.agents':fake_agents,'sehatmate_voice.deepgram_adapter':adapter}): spec.loader.exec_module(mod)
    return mod

class Pipe:
    def __init__(self,events=()): self.events=list(events);self.closed=asyncio.Event()
    def __aiter__(self): return self
    async def __anext__(self):
        if self.events: return self.events.pop(0)
        await self.closed.wait();raise StopAsyncIteration
    async def aclose(self): self.closed.set()
    def push_frame(self,_): pass

class MicrophoneTests(unittest.IsolatedAsyncioTestCase):
    async def test_resume_before_track_arrives_preserves_listening_intent(self):
        runtime=load_runtime();voice,_,_,_=session()
        mic=types.SimpleNamespace(track=None,start=AsyncMock())
        await runtime.resume_input(voice,mic,muted=True,recovering=False)
        self.assertTrue(voice.listening)
        mic.start.assert_not_awaited()
        mic.track=object()
        await runtime.resume_input(voice,mic,muted=False,recovering=False)
        mic.start.assert_awaited_once_with(mic.track)

    async def test_resume_cannot_start_input_during_reconnect_or_after_close(self):
        runtime=load_runtime();voice,_,_,_=session()
        mic=types.SimpleNamespace(track=object(),start=AsyncMock())
        await runtime.resume_input(voice,mic,muted=False,recovering=True)
        self.assertFalse(voice.listening);mic.start.assert_not_awaited()
        voice.closed=True
        await runtime.resume_input(voice,mic,muted=False,recovering=False)
        mic.start.assert_not_awaited()
    async def test_concurrent_cleanup_waits_for_original_backend_termination(self):
        runtime=load_runtime();voice,sent,b,p=session();started=asyncio.Event();release=asyncio.Event()
        async def end(): started.set();await release.wait()
        b.end=AsyncMock(side_effect=end)
        closing=asyncio.create_task(voice.close());await started.wait()
        source=types.SimpleNamespace(aclose=AsyncMock());room=types.SimpleNamespace(disconnect=AsyncMock())
        cleanup=asyncio.create_task(runtime.cleanup_resources(voice,None,{closing},source,room))
        await asyncio.sleep(0);self.assertFalse(cleanup.done());release.set()
        await asyncio.wait_for(cleanup,2);b.end.assert_awaited_once();self.assertTrue(voice.close_task.done())

    async def test_old_supervisor_retirement_preserves_new_reader_ownership(self):
        runtime=load_runtime();voice,sent,b,p=session()
        class SlowPipe(Pipe):
            async def __anext__(self):
                try: return await super().__anext__()
                except asyncio.CancelledError: await asyncio.sleep(.05);raise
        old=SlowPipe();new=Pipe();audio1=Pipe();audio2=Pipe();pipes=iter((audio1,audio2))
        runtime.rtc.AudioStream=lambda *a,**k:next(pipes)
        mic=runtime.Microphone(voice,old,config());voice.stop_input=mic.stop
        await mic.start(object());await asyncio.sleep(.01);mic.recognizer=new
        await mic.start(object());await asyncio.sleep(.1)
        self.assertEqual(len(mic.readers),2)
        await voice.pause();await asyncio.gather(*mic.retired,return_exceptions=True)

    async def test_disconnected_event_failure_does_not_skip_resource_cleanup(self):
        runtime=load_runtime();voice,sent,b,p=session()
        voice.events.send=AsyncMock(side_effect=ConnectionError('room disconnected'))
        mic=types.SimpleNamespace(stop=AsyncMock(),retired=set(),recognizer=types.SimpleNamespace(aclose=AsyncMock()))
        source=types.SimpleNamespace(aclose=AsyncMock());room=types.SimpleNamespace(disconnect=AsyncMock())
        pending=asyncio.create_task(asyncio.sleep(100))
        await runtime.cleanup_resources(voice,mic,{pending},source,room)
        mic.stop.assert_awaited_once();mic.recognizer.aclose.assert_awaited_once()
        source.aclose.assert_awaited_once();room.disconnect.assert_awaited_once()
        self.assertTrue(pending.cancelled());b.end.assert_awaited_once()

    async def test_empty_playback_ack_cannot_resume_manual_session(self):
        voice,sent,b,p=session();await voice.pause()
        control={'v':1,'type':'playback_complete','voiceSessionId':voice.events.session_id,'epoch':voice.events.epoch,'seq':1}
        self.assertFalse(await voice.control(control));self.assertFalse(voice.listening)

    async def test_provider_rate_limit_stops_audio_before_fallback(self):
        runtime=load_runtime();voice,sent,b,p=session();audio=Pipe()
        class RateLimited(Pipe):
            async def __anext__(self):
                error=RuntimeError('provider body must remain private');error.status_code=429;raise error
        recognizer=RateLimited();runtime.rtc.AudioStream=lambda *a,**k:audio
        mic=runtime.Microphone(voice,recognizer,config());voice.stop_input=mic.stop
        await mic.start(object());await asyncio.wait_for(mic.task,2)
        self.assertTrue(audio.closed.is_set());self.assertTrue(recognizer.closed.is_set())
        self.assertEqual(sent[-1]['code'],'DEEPGRAM_RATE_LIMIT');self.assertEqual(b.turn.await_count,0)

    async def test_oversized_final_stops_stream_without_cyclic_cancellation(self):
        runtime=load_runtime();voice,sent,b,p=session()
        final=types.SimpleNamespace(type='final',alternatives=[types.SimpleNamespace(text='x'*4001)])
        recognizer=Pipe([final]);audio=Pipe();runtime.rtc.AudioStream=lambda *a,**k:audio
        mic=runtime.Microphone(voice,recognizer,config());voice.stop_input=mic.stop
        await mic.start(object());task=mic.task
        await asyncio.wait_for(task,2)
        self.assertTrue(audio.closed.is_set());self.assertTrue(recognizer.closed.is_set())
        self.assertTrue(any(e['type']=='fallback_required' for e in sent));self.assertEqual(b.turn.await_count,0)

    async def test_cancellation_drains_supervisor_and_discards_partial_words(self):
        runtime=load_runtime();voice,sent,b,p=session();recognizer=Pipe();audio=Pipe();runtime.rtc.AudioStream=lambda *a,**k:audio
        mic=runtime.Microphone(voice,recognizer,config());voice.stop_input=mic.stop
        await mic.start(object());voice.transcript.feed('final','uncertain words');await asyncio.sleep(0)
        await voice.pause();await asyncio.wait_for(asyncio.gather(*mic.retired,return_exceptions=True),2)
        self.assertFalse(voice.transcript.parts);self.assertTrue(audio.closed.is_set());self.assertFalse(voice.listening)
