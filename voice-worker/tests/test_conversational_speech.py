
import unittest
from types import SimpleNamespace
from test_bridge_providers import config, Response
from sehatmate_voice.fish_adapter import FishAudio, FishError, PHRASES

def policy(**changes):
    value={'v':1,'voiceSessionId':'voice','epoch':1,'mode':'agent_reply','provider':'fish','model':'s2.1-pro-free'}
    value.update(changes)
    return value

class ConversationalSpeech(unittest.IsolatedAsyncioTestCase):
    async def collect(self,fish,text,permission):
        return [audio async for audio in fish.audio_for_reply(text,permission,session_id='voice',epoch=1,turn_id='turn')]

    async def test_authoritative_reply_preserves_exact_multilingual_text_in_bounded_segments(self):
        calls=[]
        def post(*args,**kwargs): calls.append(kwargs);return Response()
        fish=FishAudio(config(),SimpleNamespace(post=post),PHRASES,policy())
        text='Metformin 500 mg at 08:30. دوا کا نام تبدیل نہ کریں۔ Roman Urdu aur English. '*5
        audio=await self.collect(fish,text,policy(turnId='turn'))
        self.assertGreater(len(audio),1)
        self.assertEqual(''.join(call['json']['text'] for call in calls),text)
        self.assertTrue(all(len(call['json']['text'])<=120 for call in calls))
        self.assertTrue(all(call['headers']['model']=='s2.1-pro-free' and not call['json']['normalize'] for call in calls))

    async def test_disabled_and_forged_or_unbound_policies_never_transmit_arbitrary_text(self):
        for claim,permission in [(None,policy(turnId='turn')),(policy(mode='device_only'),policy(turnId='turn')),
                (policy(),policy(turnId='other')),(policy(),policy(turnId='turn',epoch=2)),
                (policy(),policy(turnId='turn',voiceSessionId='other')),(policy(),policy(turnId='turn',model='s2.1-pro')),
                (policy(),{'mode':'agent_reply'})]:
            fish=FishAudio(config(),SimpleNamespace(post=lambda *a,**k:self.fail('privacy failed')),PHRASES,claim)
            with self.assertRaises(FishError): await self.collect(fish,'Sensitive patient reply',permission)

    async def test_segment_quota_failure_preserves_exact_unspoken_suffix_without_post_retry(self):
        calls=[]
        def post(*args,**kwargs): calls.append(kwargs['json']['text']);return Response(status=200 if len(calls)==1 else 429)
        fish=FishAudio(config(),SimpleNamespace(post=post),PHRASES,policy())
        text='An unchanged fictional schedule. '*9
        with self.assertRaises(FishError) as failure: await self.collect(fish,text,policy(turnId='turn'))
        self.assertEqual(failure.exception.code,'FISH_RATE_LIMIT')
        self.assertEqual(calls[0]+failure.exception.remaining_text,text)
        self.assertEqual(len(calls),2)

    async def test_generator_interruption_stops_subsequent_requests(self):
        calls=[]
        def post(*args,**kwargs): calls.append(kwargs);return Response()
        fish=FishAudio(config(),SimpleNamespace(post=post),PHRASES,policy())
        stream=fish.audio_for_reply('Fictional reply. '*20,policy(turnId='turn'),session_id='voice',epoch=1,turn_id='turn')
        await anext(stream);await stream.aclose()
        self.assertEqual(len(calls),1)

    async def test_long_unbroken_word_falls_back_without_changing_pronunciation_or_partial_request(self):
        fish=FishAudio(config(),SimpleNamespace(post=lambda *a,**k:self.fail('do not split a clinical name')),PHRASES,policy())
        with self.assertRaisesRegex(FishError,'SEGMENT_LIMIT'): await self.collect(fish,'x'*200,policy(turnId='turn'))



from unittest.mock import AsyncMock
from sehatmate_voice.session import VoiceSession
from sehatmate_voice.events import Events
import asyncio

class SessionConversationalSpeech(unittest.IsolatedAsyncioTestCase):
    async def test_every_authoritative_reply_kind_uses_primary_fish_without_business_reexecution(self):
        for kind in ('conversation','care_plan','task','reality_check','simulation','care_gap','confirmation','clarification','navigation','progress'):
            with self.subTest(kind=kind):
                text=f'{kind}: Metformin 500 mg at 08:30.'
                voice,sent,calls,playback=self.setup_voice(text)
                receipt={'status':'completed','turnId':'turn','result':{'reply':text,'kind':kind},'speechPolicy':policy(turnId='turn')}
                await voice.apply_receipt(receipt,voice.audio_generation);await voice.play_task
                self.assertEqual(''.join(calls),text)
                voice.bridge.turn.assert_not_awaited()
                self.assertEqual(next(e['result'] for e in sent if e['type']=='agent_result'),receipt['result'])
    def setup_voice(self,text,permission=None):
        sent=[];calls=[]
        async def send(value): sent.append(value)
        def post(*args,**kwargs): calls.append(kwargs['json']['text']);return Response()
        fish=FishAudio(config(),SimpleNamespace(post=post),PHRASES,policy())
        bridge=SimpleNamespace(turn=AsyncMock(return_value={'status':'completed','turnId':'turn',
            'result':{'reply':text},'speechPolicy':permission or policy(turnId='turn')}),end=AsyncMock())
        playback=SimpleNamespace(play=AsyncMock(),stop=AsyncMock())
        voice=VoiceSession(config(),bridge,Events('voice',1,send),fish,playback)
        return voice,sent,calls,playback

    async def test_backend_permitted_reply_speaks_all_segments_once_and_keeps_listening(self):
        text='Fictional care plan. '*15
        voice,sent,calls,playback=self.setup_voice(text)
        await voice._turn('turn','question');await voice.play_task
        self.assertEqual(''.join(calls),text)
        self.assertGreater(playback.play.await_count,1)
        self.assertEqual(sum(e['type']=='speaking' for e in sent),1)
        self.assertEqual(sum(e['type']=='playback_complete' for e in sent),1)
        self.assertTrue(voice.listening)

    async def test_interruption_cancels_segments_without_new_provider_requests(self):
        voice,sent,calls,playback=self.setup_voice('Fictional care plan. '*15)
        entered=asyncio.Event()
        async def play(audio): entered.set();await asyncio.Event().wait()
        playback.play.side_effect=play
        await voice._turn('turn','question');await entered.wait();await voice.interrupt()
        self.assertEqual(len(calls),1)
        self.assertFalse(any(e['type']=='playback_complete' for e in sent))

    async def test_large_disabled_response_requires_owned_receipt_for_complete_device_fallback(self):
        voice,sent,calls,playback=self.setup_voice('Long reply. '*1000,policy(mode='device_only',turnId='turn'))
        await voice._turn('turn','question');await voice.play_task
        fallback=next(e for e in sent if e['type']=='fallback_required')
        self.assertTrue(fallback['deviceTts']['textViaUserApi'])
        self.assertEqual(fallback['deviceTts']['receiptPath'],'/api/agent/voice-sessions/voice/turns/turn')
        self.assertEqual(calls,[])
