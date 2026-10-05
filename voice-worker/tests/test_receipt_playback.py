import asyncio
import unittest
from unittest.mock import AsyncMock
from test_session import session

class ReceiptPlayback(unittest.IsolatedAsyncioTestCase):
    async def test_terminal_receipt_preserves_exact_recovery_status(self):
        voice,sent,bridge,playback=session()
        await voice.apply_receipt({'epoch':1,'status':'receipt_expired','turnId':'t'},voice.audio_generation)
        self.assertEqual(sent[-1]['code'],'receipt_expired')

    def control(self,seq=1,**extra):
        return {'v':1,'type':'receipt_ready','voiceSessionId':'voice','epoch':1,'seq':seq,'turnId':'t',**extra}

    async def test_manual_receipt_is_read_once_never_posted_and_played_once(self):
        voice,sent,bridge,playback=session()
        bridge.receipt=AsyncMock(return_value={'epoch':1,'status':'completed','turnId':'t','result':{'reply':'generic'}})
        voice.fish.prompt_for=lambda _:'welcome';voice.fish.synthesize.return_value=b'\0\0'
        self.assertTrue(await voice.control(self.control()))
        await asyncio.gather(*voice.receipt_tasks)
        await voice.play_task
        self.assertTrue(await voice.control(self.control(2)))
        await asyncio.gather(*voice.receipt_tasks)
        self.assertEqual(bridge.turn.await_count,0);self.assertEqual(bridge.receipt.await_count,1)
        self.assertEqual(playback.play.await_count,1)

    async def test_late_receipt_after_stop_preserves_result_without_speech(self):
        voice,sent,bridge,playback=session();release=asyncio.Event()
        async def receipt(_):
            await release.wait();return {'epoch':1,'status':'completed','turnId':'t','result':{'reply':'generic'}}
        bridge.receipt=AsyncMock(side_effect=receipt)
        await voice.control(self.control())
        await voice.control({'v':1,'type':'stop','voiceSessionId':'voice','epoch':1,'seq':2})
        release.set();await asyncio.gather(*voice.receipt_tasks)
        self.assertIsNone(voice.play_task);self.assertEqual(bridge.turn.await_count,0)
        self.assertEqual(sum(e['type']=='agent_result' for e in sent),1)

    async def test_stale_or_wrong_receipt_cannot_play_and_control_cannot_supply_text(self):
        voice,sent,bridge,playback=session();bridge.receipt=AsyncMock(return_value={'epoch':0,'status':'completed','turnId':'t','result':{'reply':'generic'}})
        self.assertFalse(await voice.control(self.control(message='injected')))
        await voice.control(self.control());await asyncio.gather(*voice.receipt_tasks)
        self.assertTrue(voice.blocked);self.assertIsNone(voice.play_task)
        self.assertEqual(bridge.turn.await_count,0)
