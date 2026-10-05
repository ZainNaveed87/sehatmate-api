import asyncio
import dataclasses
import json
import time
import unittest
from unittest.mock import patch,AsyncMock
from types import SimpleNamespace
import jwt
from sehatmate_voice.config import Config
from sehatmate_voice.bridge import BackendBridge,BridgeError
from sehatmate_voice.fish_adapter import FishAudio,FishError,PHRASES
from sehatmate_voice.http_client import HttpClient

def config(**overrides):
    return dataclasses.replace(Config('https://backend.example','wss://livekit.example','mock','s'*40,'w'*40,
        'mock-deepgram','mock-fish',fish_enabled=True,stt_enabled=True,fish_voice='public-voice'),**overrides)

def delegation(epoch=1,**overrides):
    p={'sub':'voice','iss':'sehatmate-voice-backend','aud':'sehatmate-voice-turn','scope':'final-turn','jobId':'AJ_one',
        'workerIdentity':'agent-AJ_one','epoch':epoch,'iat':int(time.time()),'exp':int(time.time())+60};p.update(overrides)
    return {'token':jwt.encode(p,'m'*40,algorithm='HS256'),'epoch':epoch,'participantIdentity':'smu-owned',
        'sessionExpiresAt':'2099-01-01T00:00:00Z','idleTimeoutSeconds':60,'genericPrompts':PHRASES,'providers':{'fish':True,'deepgram':True}}

class Response:
    def __init__(self,status=200,chunks=(b'\x00\x00',)):
        self.status=status;self.chunks=chunks;self.content=self
    async def __aenter__(self): return self
    async def __aexit__(self,*args): return False
    async def iter_chunked(self,_):
        for chunk in self.chunks: yield chunk

class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_worker_service_token_and_claim_binding(self):
        http=SimpleNamespace(request=AsyncMock(return_value=delegation()))
        b=BackendBridge(config(),http,'voice','smv-room','AJ_one','agent-AJ_one')
        await b.claim()
        args=http.request.call_args.args
        token=jwt.decode(args[2],'w'*40,algorithms=['HS256'],audience='sehatmate-voice-claim',issuer='sehatmate-voice-worker')
        self.assertEqual(token['sub'],'sehatmate-worker');self.assertEqual(args[3]['roomName'],'smv-room')
        self.assertEqual(b.claim_data['participantIdentity'],'smu-owned')

    async def test_wrong_or_expired_delegations_rejected(self):
        for changes in ({'sub':'other'},{'jobId':'forged'},{'workerIdentity':'forged'},{'exp':int(time.time())-1}):
            b=BackendBridge(config(),SimpleNamespace(request=AsyncMock(return_value=delegation(**changes))),'voice','room','AJ_one','agent-AJ_one')
            with self.assertRaises(BridgeError): await b.claim()

    async def test_epoch_change_on_renewal_rejected(self):
        http=SimpleNamespace(request=AsyncMock(side_effect=[delegation(),delegation(epoch=2)]))
        b=BackendBridge(config(),http,'voice','room','AJ_one','agent-AJ_one');await b.claim()
        with self.assertRaisesRegex(BridgeError,'VOICE_STALE_EPOCH'): await b.claim()

    async def test_timeout_polls_same_turn_without_second_post(self):
        http=SimpleNamespace(request=AsyncMock(side_effect=[delegation(),asyncio.TimeoutError(),
            {'turnId':'stable','epoch':1,'status':'processing'}, {'turnId':'stable','epoch':1,'status':'completed','result':{'reply':'approved'}}]))
        b=BackendBridge(config(),http,'voice','room','AJ_one','agent-AJ_one');await b.claim()
        with patch('sehatmate_voice.bridge.asyncio.sleep',AsyncMock()): result=await b.turn('stable','exact words')
        self.assertEqual(result['status'],'completed')
        calls=[c.args for c in http.request.call_args_list]
        self.assertEqual(sum(c[0]=='POST' and c[1].endswith('/turns') for c in calls),1)
        self.assertTrue(all(c[1].endswith('/turns/stable') for c in calls if c[0]=='GET'))

    async def test_uncertain_terminal_statuses_never_replayed(self):
        for status in ('recovery_required','stale','receipt_expired'):
            http=SimpleNamespace(request=AsyncMock(side_effect=[delegation(),{'turnId':'t','epoch':1,'status':status}]))
            b=BackendBridge(config(),http,'voice','room','AJ_one','agent-AJ_one');await b.claim()
            self.assertEqual((await b.turn('t','text'))['status'],status);self.assertEqual(http.request.await_count,2)

    async def test_expired_token_renews_before_submit(self):
        http=SimpleNamespace(request=AsyncMock(side_effect=[delegation(),delegation(),{'turnId':'t','epoch':1,'status':'completed','result':{}}]))
        b=BackendBridge(config(),http,'voice','room','AJ_one','agent-AJ_one');await b.claim();b.expires=0
        await b.turn('t','words');self.assertEqual(http.request.call_args_list[1].args[1].split('/')[-1],'claim')

    async def test_http_fragmentation_accumulates_complete_bounded_json(self):
        value=json.dumps({'success':True,'data':{'status':'completed'}}).encode()
        http=SimpleNamespace(request=lambda *a,**k:Response(chunks=(value[:9],value[9:])))
        self.assertEqual((await HttpClient(http,10).request('GET','https://example','mock',None))['status'],'completed')
        http.request=lambda *a,**k:Response(chunks=(b'a'*65536,b'b'))
        with self.assertRaises(BridgeError): await HttpClient(http,10).request('GET','https://example','mock',None)

class FishTests(unittest.IsolatedAsyncioTestCase):
    async def test_privacy_and_paid_model_before_network(self):
        http=SimpleNamespace(post=lambda *a,**kw:self.fail('must not call Fish'))
        fish=FishAudio(config(),http,{**PHRASES,'patient':'Patient takes medicine'})
        self.assertIsNone(fish.prompt_for('Patient takes medicine'))
        with self.assertRaises(FishError): await fish.synthesize('patient')
        fish=FishAudio(config(fish_model='s2.1-pro'),http,PHRASES)
        with self.assertRaisesRegex(FishError,'MODEL_REJECTED'): await fish.synthesize('welcome')

    async def test_native_request_exact_model_no_cloning_bounded_pcm(self):
        calls=[]
        def post(url,**kwargs): calls.append((url,kwargs));return Response(chunks=(b'\x00',b'\x00\x01\x00'))
        fish=FishAudio(config(),SimpleNamespace(post=post),PHRASES)
        self.assertEqual(len(await fish.synthesize('welcome')),4)
        url,opts=calls[0];self.assertEqual(url,'https://api.fish.audio/v1/tts');self.assertEqual(opts['headers']['model'],'s2.1-pro-free')
        self.assertEqual(opts['json']['text'],PHRASES['welcome']);self.assertNotIn('references',opts['json'])
        self.assertEqual(opts['json']['format'],'pcm');self.assertFalse(opts['allow_redirects'])

    async def test_provider_quota_failure_and_request_limits(self):
        calls=0
        def post(*a,**kw):
            nonlocal calls;calls+=1;return Response(status=402)
        fish=FishAudio(config(tts_requests=1),SimpleNamespace(post=post),PHRASES)
        with self.assertRaisesRegex(FishError,'FISH_QUOTA'): await fish.synthesize('welcome')
        with self.assertRaisesRegex(FishError,'REQUEST_LIMIT'): await fish.synthesize('welcome')
        self.assertEqual(calls,1)

    async def test_audio_limit_and_rate_limit(self):
        for response in (Response(chunks=(b'a'*600000,)),Response(status=429)):
            fish=FishAudio(config(),SimpleNamespace(post=lambda *a,**kw:response),PHRASES)
            with self.assertRaises(FishError): await fish.synthesize('welcome')

    async def test_synthesis_cancellation_closes_http_context(self):
        entered=asyncio.Event();exited=asyncio.Event()
        class Blocking(Response):
            async def iter_chunked(self,_):
                entered.set();await asyncio.Event().wait();yield b'\x00\x00'
            async def __aexit__(self,*args): exited.set()
        fish=FishAudio(config(),SimpleNamespace(post=lambda *a,**k:Blocking()),PHRASES)
        task=asyncio.create_task(fish.synthesize('welcome'));await entered.wait();task.cancel()
        await asyncio.gather(task,return_exceptions=True);self.assertTrue(exited.is_set())



class CompleteReceiptEnvelope(unittest.IsolatedAsyncioTestCase):
    async def test_backend_result_limit_leaves_room_for_authenticated_receipt_envelope(self):
        value=json.dumps({'success':True,'data':{'status':'completed','turnId':'turn','epoch':1,
            'result':{'reply':'x'*65500},'speechPolicy':{'voiceSessionId':'voice','turnId':'turn','mode':'agent_reply'}}}).encode()
        http=SimpleNamespace(request=lambda *a,**k:Response(chunks=(value[:60000],value[60000:])))
        result=await HttpClient(http,10).request('GET','https://example','mock',None)
        self.assertEqual(len(result['result']['reply']),65500)
