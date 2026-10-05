"""Source-level pinned SDK checks when local native DLL policy prevents SDK imports.

These are not native runtime or end-to-end provider tests.
"""
import ast
import asyncio
import importlib.metadata
import pathlib
import time
import types
import unittest
import urllib.parse
from unittest.mock import AsyncMock,Mock

def sdk_path(package,path):
    return pathlib.Path(importlib.metadata.distribution(package).locate_file(path))

class SDKSourceTests(unittest.IsolatedAsyncioTestCase):
    def test_pinned_plugin_accepts_every_configured_constructor_parameter(self):
        sdk=ast.parse(sdk_path('livekit-plugins-deepgram','livekit/plugins/deepgram/stt.py').read_text())
        cls=next(n for n in sdk.body if isinstance(n,ast.ClassDef) and n.name=='STT')
        init=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='__init__')
        accepted={a.arg for a in init.args.kwonlyargs}
        adapter=ast.parse(pathlib.Path('sehatmate_voice/deepgram_adapter.py').read_text())
        call=next(n for n in ast.walk(adapter) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='STT')
        self.assertTrue({k.arg for k in call.keywords}<=accepted)
        values={k.arg:ast.literal_eval(k.value) for k in call.keywords if isinstance(k.value,ast.Constant)}
        self.assertTrue(values['mip_opt_out']);self.assertFalse(values['smart_format']);self.assertFalse(values['numerals'])

    async def test_actual_plugin_websocket_request_transmits_opt_out_to_mock_connection(self):
        # Execute these installed Python methods directly, with provider/network mocks.
        # Native AV/RTC modules are not imported or bypassed.
        tree=ast.parse(sdk_path('livekit-plugins-deepgram','livekit/plugins/deepgram/_utils.py').read_text())
        urlfn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_to_deepgram_url')
        tree=ast.parse(sdk_path('livekit-plugins-deepgram','livekit/plugins/deepgram/stt.py').read_text())
        cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='SpeechStream')
        method=next(n for n in cls.body if isinstance(n,ast.AsyncFunctionDef) and n.name=='_connect_ws')
        for n in (urlfn,method):
            n.returns=None
            for a in n.args.args+n.args.kwonlyargs: a.annotation=None
        env={'asyncio':asyncio,'time':time,'urlencode':urllib.parse.urlencode,'logger':Mock(),
            'aiohttp':types.SimpleNamespace(ClientResponseError=Exception),'APIConnectionError':RuntimeError,'APIStatusError':RuntimeError}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[urlfn,method],type_ignores=[])),'pinned SDK methods','exec'),env)
        defaults={'model':'nova-3','punctuate':False,'smart_format':False,'no_delay':True,'interim_results':True,
            'vad_events':True,'sample_rate':16000,'num_channels':1,'endpointing_ms':700,'filler_words':True,'profanity_filter':False,
            'numerals':False,'mip_opt_out':True,'enable_diarization':False,'keywords':None,'keyterm':None,'utterance_end_ms':1200,
            'dictation':False,'replace':None,'search':None,'language':'ur','redact':None,'tags':[],
            'endpoint_url':'https://api.deepgram.com/v1/listen'}
        ws=types.SimpleNamespace(_response=types.SimpleNamespace(headers={}))
        fake=types.SimpleNamespace(_opts=types.SimpleNamespace(**defaults),_api_key='mock-only',
            _conn_options=types.SimpleNamespace(timeout=3),_session=types.SimpleNamespace(ws_connect=AsyncMock(return_value=ws)),
            _report_connection_acquired=Mock())
        await env['_connect_ws'](fake)
        url=fake._session.ws_connect.call_args.args[0]
        query=urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        self.assertEqual(query['mip_opt_out'],['true']);self.assertEqual(query['language'],['ur']);self.assertEqual(query['model'],['nova-3'])

    def test_stream_retries_cannot_merge_uncertain_audio(self):
        tree=ast.parse(pathlib.Path('sehatmate_voice/deepgram_adapter.py').read_text())
        opts=next(n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='APIConnectOptions')
        self.assertEqual(ast.literal_eval(next(k.value for k in opts.keywords if k.arg=='max_retry')),0)

    def test_sdk_mute_callback_order_and_named_agent_registration(self):
        runtime=ast.parse(pathlib.Path('sehatmate_voice/runtime.py').read_text())
        for name in ('muted','unmuted'):
            callback=next(n for n in ast.walk(runtime) if isinstance(n,ast.FunctionDef) and n.name==name)
            self.assertEqual([a.arg for a in callback.args.args],['participant','publication'])
        main=ast.parse(pathlib.Path('worker.py').read_text())
        registration=next(n for n in ast.walk(main) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='rtc_session')
        self.assertEqual(ast.literal_eval(next(k.value for k in registration.keywords if k.arg=='agent_name')),'sehatmate-voice')
