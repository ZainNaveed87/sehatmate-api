import json
import re

KINDS=frozenset(('ready','transcript_interim','transcript_final','processing','agent_result','speaking',
    'playback_complete','interrupted','fallback_required','recovering','disconnected','awaiting_confirmation','awaiting_clarification'))
CONTROLS=frozenset(('resume','mute','stop','interrupt','playback_complete','manual','cancel','receipt_ready'))
ID=re.compile(r'^[A-Za-z0-9_-]{1,80}$')

class Events:
    def __init__(self, session_id, epoch, send):
        if not ID.fullmatch(session_id) or type(epoch) is not int or epoch<1: raise ValueError('Invalid binding')
        self.session_id,self.epoch,self.send=session_id,epoch,send
        self.seq=0; self.control_seq=0

    async def emit(self, kind, *, turn_id=None, **payload):
        if kind not in KINDS or turn_id is not None and not ID.fullmatch(turn_id): raise ValueError('Invalid event')
        self.seq+=1
        value={'v':1,'type':kind,'voiceSessionId':self.session_id,'epoch':self.epoch,'seq':self.seq}
        if turn_id: value['turnId']=turn_id
        if set(payload)&set(value): raise ValueError('Reserved event field')
        value.update(payload)
        if len(json.dumps(value).encode())>12000: raise ValueError('Event too large')
        await self.send(value)

    def accept_control(self, value):
        if not isinstance(value,dict) or set(value)-{'v','type','voiceSessionId','epoch','seq','turnId','playbackId'}: return False
        if value.get('v')!=1 or value.get('voiceSessionId')!=self.session_id or value.get('epoch')!=self.epoch: return False
        if value.get('type') not in CONTROLS or type(value.get('seq')) is not int or value['seq']<=self.control_seq: return False
        if value.get('turnId') is not None and not ID.fullmatch(str(value['turnId'])): return False
        if value.get('type')=='receipt_ready' and (not isinstance(value.get('turnId'),str) or not ID.fullmatch(value['turnId'])): return False
        self.control_seq=value['seq']; return True
