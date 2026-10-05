import asyncio
import time
import jwt
from .events import ID

class BridgeError(Exception):
    def __init__(self, code): self.code=code; super().__init__(code)

class BackendBridge:
    def __init__(self, config, http, session_id, room, job, identity, *, clock=time.time):
        if not all(ID.fullmatch(v) for v in (session_id,job,identity)): raise ValueError('Invalid binding')
        self.config,self.http,self.session_id=config,http,session_id
        self.binding={'roomName':room,'jobId':job,'workerIdentity':identity}
        self.clock=clock; self.token=None; self.epoch=None; self.expires=0; self.claim_data=None
        self._renew_lock=asyncio.Lock()

    def service_token(self):
        now=int(self.clock())
        return jwt.encode({'sub':'sehatmate-worker','iss':'sehatmate-voice-worker','aud':'sehatmate-voice-claim','iat':now,'exp':now+60},self.config.worker_key,algorithm='HS256')

    async def _request(self, method, suffix, token, body=None):
        try:
            return await self.http.request(method,f'{self.config.backend_url}/internal/agent/voice-sessions/{self.session_id}{suffix}',token,body)
        except BridgeError: raise
        except (asyncio.TimeoutError,OSError): raise BridgeError('BACKEND_NETWORK_UNCERTAIN') from None

    async def claim(self):
        async with self._renew_lock:
            data=await self._request('POST','/claim',self.service_token(),self.binding)
            try:
                # This is NOT signature verification. Backend HTTPS is the trust boundary;
                # delegation signing secret is deliberately unavailable to this Worker.
                p=jwt.decode(data['token'],options={'verify_signature':False})
                if p['sub']!=self.session_id or p['iss']!='sehatmate-voice-backend' or p['aud']!='sehatmate-voice-turn' or p['scope']!='final-turn': raise ValueError()
                if p['jobId']!=self.binding['jobId'] or p['workerIdentity']!=self.binding['workerIdentity'] or p['epoch']!=data['epoch']: raise ValueError()
                if p['exp']<=self.clock() or p['exp']-p['iat']>60 or p['iat']>self.clock()+5: raise ValueError()
                if self.epoch is not None and self.epoch!=data['epoch']: raise BridgeError('VOICE_STALE_EPOCH')
                if not ID.fullmatch(data['participantIdentity']): raise ValueError()
            except (KeyError,ValueError,jwt.PyJWTError,TypeError): raise BridgeError('INVALID_DELEGATION') from None
            self.token,self.epoch,self.expires,self.claim_data=data['token'],data['epoch'],p['exp'],data
            return data

    async def authorized(self):
        if self.expires-self.clock()<20: await self.claim()
        return self.token

    async def receipt(self, turn_id):
        if not ID.fullmatch(turn_id): raise ValueError('Invalid turn ID')
        return await self._request('GET',f'/turns/{turn_id}',await self.authorized())

    async def turn(self, turn_id, text):
        if not ID.fullmatch(turn_id) or not isinstance(text,str) or not 0<len(text)<=4000: raise ValueError('Invalid turn')
        token=await self.authorized() # Claim failure occurs before any action POST.
        try: response=await self._request('POST','/turns',token,{'epoch':self.epoch,'turnId':turn_id,'message':text})
        except BridgeError as error:
            if error.code not in ('BACKEND_NETWORK_UNCERTAIN','VOICE_UNAVAILABLE','INVALID_BACKEND_RESPONSE'): raise
            response={'status':'processing','turnId':turn_id,'epoch':self.epoch}
        deadline=asyncio.get_running_loop().time()+self.config.poll_seconds
        failures=0
        while response.get('status')=='processing' and asyncio.get_running_loop().time()<deadline:
            await asyncio.sleep(1)
            try: response=await self.receipt(response.get('turnId',turn_id)); failures=0
            except BridgeError as error:
                if error.code not in ('BACKEND_NETWORK_UNCERTAIN','VOICE_UNAVAILABLE') or failures>=self.config.retries: raise
                failures+=1
        if response.get('epoch')!=self.epoch: raise BridgeError('VOICE_STALE_EPOCH')
        if response.get('status') not in ('processing','completed','recovery_required','stale','receipt_expired'): raise BridgeError('INVALID_RECEIPT')
        return response

    async def end(self):
        if self.token: return await self._request('DELETE','',await self.authorized(),{})
