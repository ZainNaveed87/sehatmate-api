import unittest
from sehatmate_voice.config import Config
from sehatmate_voice.events import Events
from sehatmate_voice.session import TranscriptTurn

class Boundaries(unittest.IsolatedAsyncioTestCase):
    def test_configuration_fails_closed(self):
        with self.assertRaises(ValueError): Config.from_env({})

    def test_worker_environment_rejects_backend_keys_and_invalid_language(self):
        env={'VOICE_WORKER_ENABLED':'true','VOICE_BACKEND_URL':'https://backend.example','LIVEKIT_URL':'wss://livekit.example',
            'LIVEKIT_API_KEY':'mock','LIVEKIT_API_SECRET':'s'*40,'VOICE_WORKER_AUTH_KEY':'w'*40}
        cfg=Config.from_env(env);self.assertFalse(cfg.fish_enabled);self.assertFalse(cfg.stt_enabled)
        self.assertNotIn('w'*40,repr(cfg))
        with self.assertRaises(ValueError): Config.from_env({**env,'OPENROUTER_API_KEY':'mock-forbidden'})
        with self.assertRaises(ValueError): Config.from_env({**env,'VOICE_STT_LANGUAGE':'multi'})

    def test_final_segments_wait_for_turn_completion(self):
        turn = TranscriptTurn()
        self.assertIsNone(turn.feed('interim', 'unsafe draft'))
        self.assertIsNone(turn.feed('final', 'exact words'))
        self.assertEqual(turn.feed('end', ''), 'exact words')
        self.assertIsNone(turn.feed('end', ''))

    async def test_targeted_versioned_events_and_stale_controls(self):
        sent=[]
        async def send(value): sent.append(value)
        events=Events('opaque',3,send)
        await events.emit('ready')
        self.assertEqual(sent[0]['v'],1)
        self.assertEqual(sent[0]['epoch'],3)
        self.assertFalse(events.accept_control({'v':1,'voiceSessionId':'opaque','epoch':2,'seq':1,'type':'resume'}))

if __name__ == '__main__': unittest.main()
