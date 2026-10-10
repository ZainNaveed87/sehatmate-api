import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from sehatmate_voice.session import VoiceSession
from sehatmate_voice.events import Events
from sehatmate_voice.fish_adapter import FishAudio
from test_bridge_providers import config,Response

POLICY={'v':1,'voiceSessionId':'voice','epoch':1,'mode':'agent_reply','provider':'fish','model':'s2.1-pro-free'}
def receipt(turn,reply,**fields):
    return {'status':'completed','turnId':turn,'epoch':1,'speechPolicy':{**POLICY,'turnId':turn},
        'result':{'sessionId':'41','language':'en','reply':reply,'referencedEntities':[],**fields}}

def harness(value):
    sent=[];requests=[]
    def post(*args,**kwargs):
        requests.append(kwargs['json']['text']);return Response(chunks=(b'\x00\x00',))
    async def send(event):sent.append(event)
    cfg=config(tts_segment_chars=500)
    bridge=SimpleNamespace(turn=AsyncMock(return_value=value),end=AsyncMock())
    playback=SimpleNamespace(play=AsyncMock(),stop=AsyncMock())
    fish=FishAudio(cfg,SimpleNamespace(post=post),{},POLICY)
    s=VoiceSession(cfg,bridge,Events('voice',1,send),fish,playback)
    return s,sent,bridge,playback,requests

class ResponseDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def finish(self,s):
        await s.turn_task
        if s.play_task:await s.play_task

    async def test_pending_reply_survives_speech_onset_without_active_playback(self):
        value=receipt('pending','What name should I give the care plan?')
        s,sent,bridge,playback,requests=harness(value)
        entered=asyncio.Event();release=asyncio.Event()
        async def delayed(*_):entered.set();await release.wait();return value
        bridge.turn.side_effect=delayed
        task=asyncio.create_task(s._turn('pending','create a care plan'))
        await asyncio.wait_for(entered.wait(),1);generation=s.audio_generation
        await s.speech_event('start')
        release.set();await task
        if s.play_task:await s.play_task
        self.assertEqual(s.audio_generation,generation)
        self.assertEqual(requests,[value['result']['reply']])
        self.assertEqual(next(e['result'] for e in sent if e['type']=='agent_result'),value['result'])

    async def test_normal_question_confirmation_cancel_and_next_chat_share_output_contract(self):
        cases=[receipt('question','What name should I give the care plan?',navigation={'target':'care_plan_new','params':{}}),
            receipt('review','Create a draft care plan named Test?',confirmation={'confirmationId':'confirm','kind':'create_care_plan'}),
            receipt('cancel','Care plan creation cancelled.'),
            receipt('chat','Yes, I can hear you. What would you like to do next?')]
        s,sent,b,p,requests=harness(cases[0]);b.turn.side_effect=cases
        for value in cases:
            await s.speech_event('final','spoken input');await s.speech_event('end');await self.finish(s)
        self.assertEqual(b.turn.await_count,4)
        self.assertEqual([e['result'] for e in sent if e['type']=='agent_result'],[v['result'] for v in cases])
        self.assertEqual(requests,[v['result']['reply'] for v in cases])
        self.assertEqual(p.play.await_count,4)
        self.assertEqual(sum(e['type']=='playback_complete' for e in sent),4)

    async def test_tts_failure_keeps_authoritative_text_event(self):
        value=receipt('failure','The exact authoritative reply.')
        s,sent,b,p,_=harness(value)
        s.fish.http.post=lambda *a,**k:Response(status=429)
        await s._turn('failure','spoken');await s.play_task
        self.assertEqual(next(e['result'] for e in sent if e['type']=='agent_result'),value['result'])
        self.assertTrue(any(e['type']=='fallback_required' for e in sent))
        self.assertEqual(b.turn.await_count,1)

    async def test_duplicate_completed_receipt_has_one_message_and_one_tts(self):
        value=receipt('stable','Only once.')
        s,sent,b,p,requests=harness(value)
        await s.apply_receipt(value,s.audio_generation);await s.play_task
        await s.apply_receipt(value,s.audio_generation)
        self.assertEqual(sum(e['type']=='agent_result' for e in sent),1)
        self.assertEqual(requests,['Only once.'])

    async def test_manual_interrupt_fences_old_audio_not_current_turn(self):
        old=receipt('old','Old reply.');s,sent,b,p,requests=harness(old)
        generation=s.audio_generation;await s.interrupt()
        await s.apply_receipt(old,generation);self.assertIsNone(s.play_task)
        new=receipt('new','Current reply.')
        await s.apply_receipt(new,s.audio_generation);await s.play_task
        self.assertEqual(requests,['Current reply.'])

    async def test_language_switch_keeps_text_and_speech_from_same_envelope(self):
        value=receipt('language','Ab hum Roman Urdu mein baat karein ge.',language='roman_ur',conversationLanguage='roman_ur')
        s,sent,b,p,requests=harness(value);s.on_language=AsyncMock()
        await s._turn('language','switch language');await s.play_task
        self.assertEqual(requests,[value['result']['reply']]);s.on_language.assert_awaited_once_with('roman_ur')
        self.assertEqual(next(e['result'] for e in sent if e['type']=='agent_result'),value['result'])

    async def test_true_barge_in_and_manual_mute_remain_effective(self):
        s,_,_,playback,_=harness(receipt('playing','Assistant words.'))
        started=asyncio.Event();release=asyncio.Event()
        async def play(_):started.set();await release.wait()
        playback.play.side_effect=play
        s.play_task=asyncio.create_task(s.speak('Assistant words.','playing',{**POLICY,'turnId':'playing'}))
        await started.wait();generation=s.audio_generation
        await s.speech_event('start');await s.speech_event('interim','please stop speaking')
        self.assertGreater(s.audio_generation,generation);self.assertTrue(s.play_task.cancelled())
        await s.pause();await s.apply_receipt(receipt('muted','Stay silent.'),s.audio_generation)
        self.assertIsNone(s.playback_id);self.assertFalse(s.listening)
