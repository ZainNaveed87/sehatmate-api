import unittest
from dataclasses import replace
from test_bridge_providers import config
from sehatmate_voice.diagnostics import preflight, PINNED

class Diagnostics(unittest.TestCase):
    def check(self,cfg=None,**changes):
        return preflight(cfg or config(),python_version=(3,12),version_lookup=PINNED.__getitem__,importer=lambda _:None,**changes)

    def test_configured_native_preflight_requires_pinned_dependencies_without_network(self):
        self.assertEqual(self.check(),{'ok':True,'code':'WORKER_PREFLIGHT_OK'})

    def test_disabled_provider_cannot_pass_full_voice_preflight(self):
        self.assertEqual(self.check(replace(config(),fish_enabled=False))['code'],'FISH_CONFIGURATION_REQUIRED')
        self.assertEqual(self.check(replace(config(),stt_enabled=False))['code'],'DEEPGRAM_CONFIGURATION_REQUIRED')

    def test_native_import_failure_never_prints_exception_or_credentials(self):
        def blocked(_): raise ImportError('Bearer secret-value and provider-body')
        result=preflight(config(),python_version=(3,12),version_lookup=PINNED.__getitem__,importer=blocked)
        self.assertEqual(result,{'ok':False,'code':'NATIVE_AV_UNAVAILABLE'})
        self.assertNotIn('secret-value',str(result))

    def test_wrong_python_and_dependency_version_are_rejected(self):
        self.assertEqual(preflight(config(),python_version=(3,11))['code'],'PYTHON_312_REQUIRED')
        result=preflight(config(),python_version=(3,12),version_lookup=lambda _:'wrong')
        self.assertEqual(result['code'],'PINNED_DEPENDENCIES_REQUIRED')
