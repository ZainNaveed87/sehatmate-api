import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from test_bridge_providers import config
from sehatmate_voice.events import Events
from sehatmate_voice.session import VoiceSession
from sehatmate_voice.fish_adapter import FishError

def session(receipt=None):
    sent=[]
    async def send(value): sent.append(value)
    bridge=SimpleNamespace(turn=AsyncMock(return_value=receipt or {'status':'completed','turnId':'backend-turn','result':{'reply':'sensitive text','navigation':{'target':'home'},'confirmation':{'confirmationId':'pending'}}}),end=AsyncMock())
    fish=SimpleNamespace(prompt_for=lambda _:None,synthesize=AsyncMock())
    playback=SimpleNamespace(stop=AsyncMock(),play=AsyncMock())
    voice=VoiceSession(config(),bridge,Events('voice',1,send),fish,playback)
    return voice,sent,bridge,playback

class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_interim_never_executes_and_completed_turn_preserves_agent_contract(self):
        s,sent,b,p=session();await s.speech_event('interim','draft');self.assertEqual(b.turn.await_count,0)
        await s.speech_event('final','final words');self.assertEqual(b.turn.await_count,0)
        await s.speech_event('end');await s.turn_task;await s.play_task
        self.assertEqual(b.turn.await_count,1)
        result=next(e for e in sent if e['type']=='agent_result')['result'];self.assertEqual(result['navigation']['target'],'home')
        self.assertEqual(result['confirmation']['confirmationId'],'pending')
        self.assertEqual(next(e for e in sent if e['type']=='fallback_required')['deviceTts']['text'],'sensitive text')
        self.assertEqual(s.fish.synthesize.await_count,0);self.assertFalse(s.listening)

    async def test_duplicate_receipt_does_not_duplicate_playback(self):
        s,sent,b,p=session();await s._turn('one','x');await s.play_task
        await s._turn('two','x');self.assertEqual(sum(e['type']=='agent_result' for e in sent),1)

    async def test_muting_before_late_result_suppresses_speech(self):
        s,sent,b,p=session();gate=asyncio.Event()
        async def turn(*_): await gate.wait();return {'status':'completed','turnId':'t','result':{'reply':'private'}}
        b.turn.side_effect=turn;task=asyncio.create_task(s._turn('t','words'));await asyncio.sleep(0)
        await s.control({'v':1,'type':'mute','seq':1,'voiceSessionId':'voice','epoch':1});gate.set();await task
        self.assertIsNone(s.play_task);self.assertFalse(s.listening)

    async def test_interrupt_cancels_playback_not_backend_action(self):
        s,sent,b,p=session();gate=asyncio.Event();started=asyncio.Event()
        s.fish.prompt_for=lambda _:'welcome';s.fish.synthesize.return_value=b'\x00\x00'
        async def play(_): started.set();await gate.wait()
        p.play.side_effect=play
        s.play_task=asyncio.create_task(s.speak('generic'));await started.wait();await s.interrupt()
        self.assertTrue(s.play_task.cancelled());self.assertEqual(b.turn.await_count,0)
        self.assertTrue(any(e['type']=='interrupted' for e in sent));self.assertFalse(any(e['type']=='playback_complete' for e in sent))

    async def test_recovery_blocks_future_turns_and_resume(self):
        s,sent,b,p=session({'status':'recovery_required','turnId':'t'})
        await s._turn('t','words');await s.control({'v':1,'type':'resume','voiceSessionId':'voice','epoch':1,'seq':1})
        await s.speech_event('final','again');await s.speech_event('end');self.assertEqual(b.turn.await_count,1);self.assertFalse(s.listening)

    async def test_stt_failure_stops_recognizer_before_fallback(self):
        s,sent,b,p=session();s.stop_input=AsyncMock()
        await s.fallback('stt','DEEPGRAM_UNAVAILABLE');s.stop_input.assert_awaited_once();self.assertFalse(s.listening)
        self.assertTrue(sent[-1]['requiresEpochTransfer']);self.assertEqual(sent[-1]['requiredTransport'],'device')

    async def test_stale_and_repeated_control_rejected(self):
        s,sent,b,p=session()
        control={'v':1,'type':'mute','voiceSessionId':'voice','epoch':0,'seq':1}
        self.assertFalse(await s.control(control));self.assertTrue(s.listening)
        control['epoch']=1;self.assertTrue(await s.control(control));self.assertFalse(await s.control(control))

    async def test_shutdown_idempotently_ends_backend_and_stops_resources(self):
        s,sent,b,p=session();s.stop_input=AsyncMock()
        await s.close();await s.close();b.end.assert_awaited_once();p.stop.assert_awaited_once()
        self.assertEqual(sum(e['type']=='disconnected' for e in sent),1);self.assertFalse(s.listening)

    async def test_large_completed_result_uses_owned_receipt_instead_of_marking_action_uncertain(self):
        s,sent,b,p=session({'status':'completed','turnId':'large','result':{'reply':'x'*11000}})
        await s._turn('large','text')
        event=next(e for e in sent if e['type']=='agent_result')
        self.assertTrue(event['resultViaUserApi']);self.assertEqual(event['receiptPath'],'/api/agent/voice-sessions/voice/turns/large')
        await s.play_task
        self.assertFalse(s.blocked)
        self.assertTrue(next(e for e in sent if e['type']=='fallback_required')['deviceTts']['textViaUserApi'])
