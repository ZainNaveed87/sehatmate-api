import unittest
from unittest.mock import AsyncMock,Mock
from test_session import session
class RuntimeLanguageTests(unittest.IsolatedAsyncioTestCase):
 async def test_completed_reply_updates_language_before_speech_without_reconnecting_room(self):
  s,sent,bridge,playback=session();s.on_language=AsyncMock();s.listening=False
  for index,language in enumerate(('ur','roman_ur','en')):
   await s.apply_receipt({'status':'completed','turnId':f'turn-{index}','result':{'reply':'Reply','language':language}},s.audio_generation)
  self.assertEqual([c.args[0] for c in s.on_language.await_args_list],['ur','roman_ur','en'])
  self.assertEqual(sum(e['type']=='agent_result' for e in sent),3);self.assertIsNone(s.play_task)
 async def test_invalid_language_never_reconfigures_recognition(self):
  s,_,_,_=session();s.on_language=AsyncMock();s.listening=False
  await s.apply_receipt({'status':'completed','turnId':'turn','result':{'reply':'Reply','language':'injected'}},s.audio_generation)
  s.on_language.assert_not_awaited()
 async def test_duplicate_receipt_cannot_repeat_language_update(self):
  s,_,_,_=session();s.on_language=AsyncMock();s.listening=False
  receipt={'status':'completed','turnId':'turn','result':{'reply':'Reply','language':'ur'}}
  await s.apply_receipt(receipt,s.audio_generation);await s.apply_receipt(receipt,s.audio_generation)
  s.on_language.assert_awaited_once_with('ur')
 async def test_language_update_failure_keeps_completed_result_and_requires_stt_fallback(self):
  s,sent,_,_=session();s.on_language=AsyncMock(side_effect=RuntimeError('never log this'))
  await s.apply_receipt({'status':'completed','turnId':'turn','result':{'reply':'Reply','language':'ur'}},s.audio_generation)
  self.assertTrue(any(e['type']=='agent_result' for e in sent));self.assertFalse(s.listening)
  self.assertTrue(any(e['type']=='fallback_required' for e in sent));self.assertIsNone(s.play_task)

class MicrophoneLanguageTests(unittest.IsolatedAsyncioTestCase):
 async def test_sdk_options_update_language_only_preserving_rtc_and_live_stream(self):
  from test_microphone import load_runtime
  from test_bridge_providers import config
  runtime=load_runtime();s,_,_,_=session();recognizer=Mock()
  mic=runtime.Microphone(s,recognizer,config(language='en'));mic.stream=object();stream=mic.stream;mic.track=object();track=mic.track
  await mic.set_language('roman_ur');recognizer.update_options.assert_called_once_with(language='ur',endpointing_ms=700)
  self.assertIs(mic.track,track);self.assertIs(mic.stream,stream);self.assertEqual(mic.config.language,'ur')
  await mic.set_language('ur');self.assertEqual(recognizer.update_options.call_count,1)
  await mic.set_language('en');recognizer.update_options.assert_called_with(language='en',endpointing_ms=500)
 async def test_closed_or_invalid_language_cannot_update_microphone(self):
  from test_microphone import load_runtime
  from test_bridge_providers import config
  runtime=load_runtime();s,_,_,_=session();recognizer=Mock();mic=runtime.Microphone(s,recognizer,config(language='en'))
  with self.assertRaises(ValueError):await mic.set_language('injected')
  s.closed=True;await mic.set_language('ur');recognizer.update_options.assert_not_called()
