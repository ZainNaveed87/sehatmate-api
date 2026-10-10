import asyncio
import json
import unittest
from unittest.mock import patch
from test_response_delivery import harness,receipt

class TurnTraceTests(unittest.IsolatedAsyncioTestCase):
    def test_trace_rejects_arbitrary_values_and_matches_cross_runtime_correlation(self):
        from sehatmate_voice.turn_trace import trace,correlation
        with patch('builtins.print') as output:
            trace('private-stage','private-id')
            trace('FAILED','private-id',status='private body',error='private exception')
        records=self.records(output)
        self.assertEqual(len(records),1);self.assertNotIn('private',str(records))
        self.assertEqual(records[0]['error'],'OTHER');self.assertEqual(correlation('hello'),'4f9f2cab')

    async def test_real_bridge_preserves_canonical_envelope_with_one_post(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        from sehatmate_voice.bridge import BackendBridge
        from test_bridge_providers import config,delegation
        value=receipt('same','Exact authoritative text.',confirmation={'kind':'create_care_plan'},language='roman_ur')
        http=SimpleNamespace(request=AsyncMock(side_effect=[delegation(),value]))
        bridge=BackendBridge(config(),http,'voice','room','AJ_one','agent-AJ_one')
        await bridge.claim();response=await bridge.turn('same','private input')
        self.assertEqual(response,value)
        self.assertEqual(sum(c.args[0]=='POST' and c.args[1].endswith('/turns') for c in http.request.call_args_list),1)
    def records(self, output):
        values=[]
        for call in output.call_args_list:
            if not call.args[0].startswith('{'): continue
            self.assertEqual(call.kwargs,{'flush':True})
            record=json.loads(call.args[0])
            self.assertLessEqual(set(record),{'stage','correlation','status','error'})
            self.assertRegex(record['correlation'],r'^[a-f0-9]{8}$')
            values.append(record)
        return values

    async def test_completed_trace_orders_publication_before_audio_and_completion(self):
        s,sent,b,p,requests=harness(receipt('trace-private','private authoritative reply',navigation={'target':'tasks'}))
        async def answer(turn,_): return receipt(turn,'private authoritative reply',navigation={'target':'tasks'})
        b.turn.side_effect=answer
        with patch('builtins.print') as output:
            await s.speech_event('final','private transcript');await s.speech_event('end')
            await s.turn_task;await s.play_task
        records=self.records(output);stages=[r['stage'] for r in records]
        required=['VOICE_TURN_TRANSCRIPT_FINAL','VOICE_TURN_BACKEND_REQUEST','VOICE_TURN_BACKEND_RESPONSE',
            'VOICE_TURN_REPLY_EXTRACTED','VOICE_TURN_ACTIONS_EXTRACTED','VOICE_TURN_UI_EVENT_SENT',
            'VOICE_TURN_TTS_ENQUEUED','VOICE_TURN_TTS_STARTED','VOICE_TURN_TTS_AUDIO_READY',
            'VOICE_TURN_TTS_PUBLISHED','VOICE_TURN_COMPLETE']
        self.assertEqual(stages,required)
        self.assertNotIn('private',str(records));self.assertEqual(len({r['correlation'] for r in records}),1)
        self.assertIn('VOICE_TURN_ACTIONS_EXTRACTED',stages)

    async def test_failed_tts_and_stale_gate_do_not_claim_complete(self):
        from test_bridge_providers import Response
        s,_,_,_,_=harness(receipt('failure','private answer'))
        s.fish.http.post=lambda *a,**k:Response(status=429)
        with patch('builtins.print') as output:
            await s._turn('failure','private input');await s.play_task
        records=self.records(output)
        self.assertIn('VOICE_TURN_TTS_FAILED',[r['stage'] for r in records])
        self.assertNotIn('VOICE_TURN_COMPLETE',[r['stage'] for r in records])
        self.assertNotIn('private',str(records))
        s.listening=True
        with patch('builtins.print') as output:
            await s.apply_receipt(receipt('stale','private old answer'),s.audio_generation-1)
        self.assertTrue(any(r.get('status')=='GENERATION_CHANGED' for r in self.records(output)))
        self.assertNotIn('VOICE_TURN_COMPLETE',[r['stage'] for r in self.records(output)])

    async def test_control_interrupt_has_no_false_playback_completion(self):
        s,_,_,p,_=harness(receipt('active','private answer'))
        started=asyncio.Event()
        async def playing(_):started.set();await asyncio.Event().wait()
        p.play.side_effect=playing
        with patch('builtins.print') as output:
            await s._turn('active','private input');await asyncio.wait_for(started.wait(),1)
            await s.interrupt()
        records=self.records(output)
        self.assertIn('VOICE_TURN_TTS_INTERRUPTED',[r['stage'] for r in records])
        self.assertNotIn('VOICE_TURN_COMPLETE',[r['stage'] for r in records])
