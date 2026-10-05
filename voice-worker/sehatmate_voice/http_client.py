import asyncio
import json
import aiohttp
from .bridge import BridgeError

class HttpClient:
    def __init__(self, http, seconds): self.http,self.seconds=http,seconds

    async def request(self, method, url, token, body):
        try:
            async with self.http.request(method,url,headers={'Authorization':f'Bearer {token}'},json=body,
                    timeout=aiohttp.ClientTimeout(total=self.seconds),allow_redirects=False) as response:
                data=bytearray()
                async for chunk in response.content.iter_chunked(4096):
                    if len(data)+len(chunk)>131072: raise BridgeError('INVALID_BACKEND_RESPONSE')
                    data.extend(chunk)
                try: value=json.loads(data)
                except (ValueError,UnicodeDecodeError): raise BridgeError('INVALID_BACKEND_RESPONSE') from None
                if response.status!=200 or value.get('success') is not True:
                    code=value.get('code','VOICE_UNAVAILABLE')
                    raise BridgeError(code if isinstance(code,str) and code.startswith('VOICE_') else 'VOICE_UNAVAILABLE')
                if not isinstance(value.get('data'),dict): raise BridgeError('INVALID_BACKEND_RESPONSE')
                return value['data']
        except (aiohttp.ClientError,asyncio.TimeoutError,OSError): raise BridgeError('BACKEND_NETWORK_UNCERTAIN') from None
