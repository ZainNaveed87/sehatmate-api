"""Offline startup checks. Never connect providers or serialize secret/error values."""
import importlib
import importlib.metadata
import sys

PINNED={'livekit-agents':'1.8.4','livekit-plugins-deepgram':'1.8.4','livekit':'1.1.20',
        'av':'19.0.1','aiohttp':'3.13.3','PyJWT':'2.15.1'}

def preflight(config,*,python_version=None,version_lookup=None,importer=None):
    version=python_version or sys.version_info
    if tuple(version[:2])!=(3,12): return {'ok':False,'code':'PYTHON_312_REQUIRED'}
    if not config.stt_enabled: return {'ok':False,'code':'DEEPGRAM_CONFIGURATION_REQUIRED'}
    if not config.fish_enabled or config.fish_model!='s2.1-pro-free':
        return {'ok':False,'code':'FISH_CONFIGURATION_REQUIRED'}
    lookup=version_lookup or importlib.metadata.version
    try:
        if any(lookup(name)!=expected for name,expected in PINNED.items()):
            return {'ok':False,'code':'PINNED_DEPENDENCIES_REQUIRED'}
    except Exception: return {'ok':False,'code':'PINNED_DEPENDENCIES_REQUIRED'}
    load=importer or importlib.import_module
    for module,code in [('av','NATIVE_AV_UNAVAILABLE'),('livekit.rtc','NATIVE_RTC_UNAVAILABLE'),
            ('livekit.agents','AGENTS_SDK_UNAVAILABLE'),('livekit.plugins.deepgram','DEEPGRAM_SDK_UNAVAILABLE')]:
        try: load(module)
        except Exception: return {'ok':False,'code':code}
    return {'ok':True,'code':'WORKER_PREFLIGHT_OK'}
