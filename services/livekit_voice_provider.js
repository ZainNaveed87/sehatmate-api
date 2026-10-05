import {AccessToken,AgentDispatchClient,RoomServiceClient,TrackSource} from 'livekit-server-sdk';
const missing=error=>['not_found','notfound'].includes(error?.code);
export function createLiveKitVoiceProvider({config,secrets,rooms,dispatch,Token=AccessToken}) {
  const url=config.livekitUrl?.replace(/^wss:/,'https:');
  rooms ||= new RoomServiceClient(url,secrets.livekitKey,secrets.livekitSecret,{requestTimeout:10,failover:false});
  dispatch ||= new AgentDispatchClient(url,secrets.livekitKey,secrets.livekitSecret,{requestTimeout:10,failover:false});
  return {
    async create(s) {
      await rooms.createRoom({name:s.roomName,maxParticipants:2,emptyTimeout:config.idleSeconds,departureTimeout:10});
      const d=await dispatch.createDispatch(s.roomName,config.agentName,{metadata:JSON.stringify({voiceSessionId:s.id})});
      return {dispatchId:d.id};
    },
    async token(s,ttl) {
      if(ttl<1) throw new Error('Expired token');
      const token=new Token(secrets.livekitKey,secrets.livekitSecret,{identity:s.participantIdentity,ttl});
      token.addGrant({roomJoin:true,room:s.roomName,canPublish:true,canSubscribe:true,canPublishData:true,
        canPublishSources:[TrackSource.MICROPHONE],canUpdateOwnMetadata:false});
      return token.toJwt();
    },
    async binding(s,b) {
      if(!s.dispatchId) return false;
      const d=await dispatch.getDispatch(s.dispatchId,s.roomName);
      return Boolean(d && d.id===s.dispatchId && d.room===s.roomName && d.agentName===config.agentName &&
        d.state?.jobs.some(j=>j.id===b.jobId && j.dispatchId===s.dispatchId && j.room?.name===s.roomName &&
          j.state?.participantIdentity===b.workerIdentity && j.state?.workerId && !Number(j.state?.endedAt)));
    },
    async revoke(s) {
      // Remove the explicit dispatch first, then room. Missing resources are already revoked.
      if(s.dispatchId) try {await dispatch.deleteDispatch(s.dispatchId,s.roomName);} catch(e) {if(!missing(e)) throw e;}
      try {await rooms.removeParticipant(s.roomName,s.participantIdentity,{revokeTokenTs:BigInt(Math.floor(Date.now()/1000)+1)});} catch(e) {if(!missing(e)) throw e;}
      try {await rooms.deleteRoom(s.roomName);} catch(e) {if(!missing(e)) throw e;}
    },
  };
}
