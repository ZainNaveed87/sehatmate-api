import asyncio
import aiohttp
import re

PHRASES={'welcome':'Welcome to SehatMate.','waiting':'Please wait.','goodbye':'Goodbye.','confirmed':'Confirmed. The change was saved.'}

class FishError(Exception):
    def __init__(self,code): self.code=code;super().__init__(code)

class FishAudio:
    sample_rate=24000
    def __init__(self,config,http,catalog,claim_policy=None):
        self.config,self.http=config,http
        # Catalog is supplied only by authenticated backend HTTPS; never by room controls.
        self.catalog={k:v for k,v in catalog.items() if PHRASES.get(k)==v}
        self.requests=0
        self.claim_policy=dict(claim_policy) if isinstance(claim_policy,dict) else None

    def prompt_for(self,text):
        return next((k for k,v in self.catalog.items() if v==text),None)

    def permits_reply(self,policy,*,session_id,epoch,turn_id):
        # Policies originate only in authenticated backend claim/receipt responses.
        # Never accept policies or speech text from room data controls.
        fields={'v','voiceSessionId','epoch','mode','provider','model'}
        expected={'v':1,'voiceSessionId':session_id,'epoch':epoch,'mode':'agent_reply',
            'provider':'fish','model':'s2.1-pro-free'}
        return (isinstance(self.claim_policy,dict) and set(self.claim_policy)==fields and
            self.claim_policy==expected and type(self.claim_policy.get('epoch')) is int and
            type(self.claim_policy.get('v')) is int and isinstance(policy,dict) and
            set(policy)==fields|{'turnId'} and policy=={**expected,'turnId':turn_id} and
            type(policy.get('epoch')) is int and type(policy.get('v')) is int)

    def segments(self,text):
        if not isinstance(text,str) or not text or len(text.encode('utf-8'))>65536:
            raise FishError('FISH_TEXT_LIMIT')
        parts=[];start=0;limit=self.config.tts_segment_chars
        while len(text)-start>limit:
            # Preserve every character, including separators. Do not rewrite or split names.
            boundaries=[m.end() for m in re.finditer(r'\s+',text[start:start+limit])]
            if not boundaries: raise FishError('FISH_TEXT_SEGMENT_LIMIT')
            end=start+boundaries[-1];parts.append(text[start:end]);start=end
        if start<len(text): parts.append(text[start:])
        return parts

    async def audio_for_reply(self,text,policy,*,session_id,epoch,turn_id):
        prompt=self.prompt_for(text)
        if prompt is not None:
            yield await self.synthesize(prompt)
            return
        if not self.permits_reply(policy,session_id=session_id,epoch=epoch,turn_id=turn_id):
            raise FishError('DEVICE_TTS_REQUIRED')
        parts=self.segments(text)
        if len(parts)>self.config.tts_requests-self.requests: raise FishError('FISH_REQUEST_LIMIT')
        offset=0
        for part in parts:
            try: audio=await self._synthesize_text(part)
            except FishError as error:
                error.remaining_text=text[offset:]
                error.text_offset=len(text[:offset].encode('utf-16-le'))//2
                raise
            yield audio
            offset+=len(part)

    async def synthesize(self,prompt):
        if prompt not in self.catalog: raise FishError('FISH_PRIVACY_REJECTED')
        return await self._synthesize_text(self.catalog[prompt])

    async def _synthesize_text(self,text):
        if self.config.fish_model!='s2.1-pro-free': raise FishError('FISH_MODEL_REJECTED')
        if not self.config.fish_enabled: raise FishError('FISH_DISABLED')
        if self.requests>=self.config.tts_requests: raise FishError('FISH_REQUEST_LIMIT')
        self.requests+=1
        maximum=self.sample_rate*2*self.config.tts_seconds
        body={'text':text,'reference_id':self.config.fish_voice,'format':'pcm',
            'sample_rate':self.sample_rate,'latency':'normal','normalize':False}
        try:
            # One bounded HTTP request. No retries, cloning, references or paid fallback.
            async with self.http.post('https://api.fish.audio/v1/tts',headers={
                    'Authorization':f'Bearer {self.config.fish_key}','model':'s2.1-pro-free','Content-Type':'application/json'},
                    json=body,timeout=aiohttp.ClientTimeout(total=self.config.request_seconds),allow_redirects=False) as response:
                if response.status!=200:
                    raise FishError('FISH_QUOTA' if response.status==402 else 'FISH_RATE_LIMIT' if response.status==429 else 'FISH_UNAVAILABLE')
                audio=bytearray()
                async for chunk in response.content.iter_chunked(4096):
                    if len(audio)+len(chunk)>maximum: raise FishError('FISH_AUDIO_LIMIT')
                    audio.extend(chunk)
                if not audio or len(audio)%2: raise FishError('FISH_INVALID_AUDIO')
                return bytes(audio)
        except (aiohttp.ClientError,asyncio.TimeoutError,OSError): raise FishError('FISH_UNAVAILABLE') from None
