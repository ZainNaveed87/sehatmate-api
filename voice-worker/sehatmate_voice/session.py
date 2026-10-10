import asyncio
import time
import json
from uuid import uuid4
from .bridge import BridgeError
from .fish_adapter import FishError

class TranscriptTurn:
    def __init__(self): self.parts=[]
    def clear(self): self.parts.clear()
    def feed(self,kind,text):
        if kind=='final' and text:
            if sum(map(len,self.parts))+len(text)>4000: self.clear();raise ValueError('TRANSCRIPT_LIMIT')
            self.parts.append(text)
        if kind=='end':
            text=' '.join(self.parts);self.clear();return text or None
        return None

class VoiceSession:
    def __init__(self,config,bridge,events,fish,playback,*,clock=time.monotonic):
        self.config,self.bridge,self.events,self.fish,self.playback=config,bridge,events,fish,playback
        self.clock=clock;self.last_activity=clock();self.started=clock()
        self.state='listening';self.listening=True;self.closed=False;self.blocked=False
        self.transcript=TranscriptTurn();self.turn_task=None;self.play_task=None
        self.playback_id=None;self.completed=set();self.stop_input=None;self.on_resume=None;self.on_language=None
        self.audio_generation=0;self.control_lock=asyncio.Lock()
        self.close_task=None
        self.receipt_tasks=set();self.receipt_pending=set();self.result_lock=asyncio.Lock()

    async def interrupt(self):
        self.audio_generation+=1
        had_playback=self.play_task and not self.play_task.done() or self.playback_id is not None
        if self.play_task and not self.play_task.done():
            self.play_task.cancel();await asyncio.gather(self.play_task,return_exceptions=True)
        await self.playback.stop()
        self.playback_id=None
        if had_playback: await self.events.emit('interrupted')

    async def pause(self):
        self.audio_generation+=1
        self.listening=False;self.transcript.clear()
        if self.stop_input: await self.stop_input()

    async def fallback(self,component,code,*,turn_id=None,text=None,text_offset=0):
        if component in ('stt','transport','backend'): await self.pause()
        self.state='recovering'
        payload={'component':component,'code':code,'requiredTransport':'device' if component=='stt' else 'manual' if component=='backend' else 'worker',
            'requiresEpochTransfer':component=='stt'}
        if text is not None:
            payload['deviceTts']={'playbackId':self.playback_id}
            if len(json.dumps(text).encode())>9000 and turn_id:
                payload['deviceTts'].update(textViaUserApi=True,textStartOffset=text_offset,
                    receiptPath=f'/api/agent/voice-sessions/{self.events.session_id}/turns/{turn_id}')
            else: payload['deviceTts']['text']=text
        await self.events.emit('fallback_required',turn_id=turn_id,**payload)

    async def speech_event(self,kind,text=''):
        if self.closed or not self.listening or self.blocked: return
        if kind=='start':
            self.last_activity=self.clock();await self.interrupt();return
        if kind=='interim':
            self.last_activity=self.clock();self.state='transcribing'
            await self.events.emit('transcript_interim',text=text[:4000]);return
        if kind=='final': self.last_activity=self.clock()
        try: final=self.transcript.feed(kind,text)
        except ValueError: await self.fallback('stt','TRANSCRIPT_LIMIT');return
        if final:
            if self.turn_task and not self.turn_task.done():
                # Do not queue potentially ambiguous confirmations behind another turn.
                await self.events.emit('recovering',code='TURN_BUSY');return
            turn_id=str(uuid4())
            await self.events.emit('transcript_final',turn_id=turn_id,text=final)
            self.turn_task=asyncio.create_task(self._turn(turn_id,final))

    async def _turn(self,turn_id,text):
        generation=self.audio_generation
        self.state='processing';await self.events.emit('processing',turn_id=turn_id)
        try:
            receipt=await self.bridge.turn(turn_id,text)
            await self.apply_receipt(receipt,generation)
        except BridgeError as error:
            if not self.closed:
                self.blocked=True;await self.fallback('backend',error.code,turn_id=turn_id)
        except asyncio.CancelledError: raise
        except Exception:
            if not self.closed:
                self.blocked=True;await self.fallback('backend','WORKER_TURN_UNCERTAIN',turn_id=turn_id)

    async def read_receipt(self,turn_id,generation):
        try:
            receipt=await asyncio.wait_for(self.bridge.receipt(turn_id),self.config.request_seconds)
            if receipt.get('epoch')!=self.events.epoch or receipt.get('turnId')!=turn_id:
                raise BridgeError('VOICE_STALE_RECEIPT')
            await self.apply_receipt(receipt,generation)
        except asyncio.CancelledError: raise
        except Exception:
            if not self.closed:
                self.blocked=True;await self.fallback('backend','VOICE_RECEIPT_RECOVERY_REQUIRED',turn_id=turn_id)
        finally: self.receipt_pending.discard(turn_id)

    async def apply_receipt(self,receipt,generation):
        async with self.result_lock:
            if self.closed: return
            status=receipt['status']
            if status!='completed':
                self.blocked=True;await self.fallback('backend',status,turn_id=receipt.get('turnId'));return
            actual_id=receipt['turnId']
            if actual_id in self.completed: return
            result=receipt.get('result')
            if not isinstance(result,dict): raise BridgeError('INVALID_RECEIPT')
            self.completed.add(actual_id)
            if len(self.completed)>100: raise BridgeError('TURN_LIMIT')
            if len(json.dumps(result).encode())>10000:
                await self.events.emit('agent_result',turn_id=actual_id,resultViaUserApi=True,
                    receiptPath=f'/api/agent/voice-sessions/{self.events.session_id}/turns/{actual_id}')
            else: await self.events.emit('agent_result',turn_id=actual_id,result=result)
            if self.on_language and result.get('language') in ('en','ur','roman_ur'):
                try: await self.on_language(result['language'])
                except Exception:
                    # Keep the completed Agent result authoritative. Recognition
                    # cannot continue with an unconfirmed language configuration.
                    await self.fallback('stt','STT_LANGUAGE_UPDATE_FAILED')
                    return
            self.state='awaiting_confirmation' if result.get('confirmation') else 'awaiting_clarification' if result.get('clarification') else 'listening'
            if self.state.startswith('awaiting_'): await self.events.emit(self.state,turn_id=actual_id)
            if self.listening and generation==self.audio_generation and isinstance(result.get('reply'),str) and result['reply']:
                self.play_task=asyncio.create_task(self.speak(result['reply'],actual_id,receipt.get('speechPolicy')))

    async def speak(self,text,turn_id=None,speech_policy=None):
        self.playback_id=str(uuid4());generation=self.playback_id
        try:
            async def audio_chunks():
                if hasattr(self.fish,'audio_for_reply'):
                    async for audio in self.fish.audio_for_reply(text,speech_policy,
                            session_id=self.events.session_id,epoch=self.events.epoch,turn_id=turn_id):
                        yield audio
                else:
                    prompt=self.fish.prompt_for(text)
                    if prompt is None: raise FishError('DEVICE_TTS_REQUIRED')
                    yield await self.fish.synthesize(prompt)
            started=False
            async for audio in audio_chunks():
                if self.closed or generation!=self.playback_id: return
                if not started:
                    await self.events.emit('speaking',turn_id=turn_id,provider='fish',playbackId=generation)
                    started=True
                await self.playback.play(audio)
                self.last_activity=self.clock()
            if not self.closed and generation==self.playback_id:
                self.playback_id=None;await self.events.emit('playback_complete',turn_id=turn_id,playbackId=generation)
        except FishError as error:
            await self.playback.stop()
            if not self.closed and generation==self.playback_id:
                # Half duplex for device TTS; explicit ack/resume is required.
                await self.pause();await self.fallback('tts',error.code,turn_id=turn_id,
                    text=getattr(error,'remaining_text',text),text_offset=getattr(error,'text_offset',0))
        finally:
            if generation==self.playback_id and self.closed: self.playback_id=None

    async def control(self,value):
        async with self.control_lock: return await self._control(value)

    async def _control(self,value):
        if self.closed or not self.events.accept_control(value): return False
        kind=value['type']
        if kind=='receipt_ready':
            turn=value['turnId']
            if turn in self.completed or turn in self.receipt_pending: return True
            if self.blocked or self.receipt_tasks: return False
            self.receipt_pending.add(turn)
            task=asyncio.create_task(self.read_receipt(turn,self.audio_generation));self.receipt_tasks.add(task)
            task.add_done_callback(self.receipt_tasks.discard)
        elif kind in ('mute','stop','manual'): await self.pause();await self.interrupt()
        elif kind=='interrupt': await self.interrupt()
        elif kind=='cancel': await self.close()
        elif kind in ('resume','playback_complete'):
            if kind=='playback_complete' and (not self.playback_id or value.get('playbackId')!=self.playback_id): return False
            if not self.blocked:
                self.playback_id=None;self.listening=True;self.last_activity=self.clock()
                if self.on_resume: await self.on_resume()
        return True

    async def close(self):
        if self.close_task is None:
            self.close_task=asyncio.create_task(self._close())
        await asyncio.shield(self.close_task)

    async def _close(self):
        self.closed=True;self.state='disconnected';await self.pause();await self.interrupt()
        receipts=list(self.receipt_tasks)
        for task in receipts: task.cancel()
        await asyncio.gather(*receipts,return_exceptions=True)
        if self.turn_task and not self.turn_task.done():
            self.turn_task.cancel();await asyncio.gather(self.turn_task,return_exceptions=True)
        try: await self.events.emit('disconnected')
        finally:
            try: await asyncio.wait_for(self.bridge.end(),self.config.request_seconds)
            except Exception: pass # Backend fixed expiry/cleanup remains authoritative.
