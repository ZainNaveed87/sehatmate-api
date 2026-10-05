import {
  AccessToken,
  AgentDispatchClient,
  RoomServiceClient,
  TrackSource,
} from 'livekit-server-sdk';

const missing = error =>
  ['not_found', 'notfound'].includes(
    String(error?.code || '').toLowerCase(),
  );

function safeFailure(stage, error) {
  const code =
    typeof error?.code === 'string'
      ? error.code.slice(0, 80)
      : undefined;

  const status =
    Number.isInteger(error?.status)
      ? error.status
      : Number.isInteger(error?.statusCode)
        ? error.statusCode
        : undefined;

  const name =
    typeof error?.name === 'string'
      ? error.name.slice(0, 80)
      : 'Error';

  console.warn('VOICE_LIVEKIT_PROVISION_FAILED', {
    stage,
    name,
    code,
    status,
  });
}

export function createLiveKitVoiceProvider({
  config,
  secrets,
  rooms,
  dispatch,
  Token = AccessToken,
}) {
  const url = config.livekitUrl?.replace(/^wss:/, 'https:');

  rooms ||= new RoomServiceClient(
    url,
    secrets.livekitKey,
    secrets.livekitSecret,
    {
      requestTimeout: 10,
      failover: false,
    },
  );

  dispatch ||= new AgentDispatchClient(
    url,
    secrets.livekitKey,
    secrets.livekitSecret,
    {
      requestTimeout: 10,
      failover: false,
    },
  );

  return {
    async create(s) {
      try {
        await rooms.createRoom({
          name: s.roomName,
          maxParticipants: 2,
          emptyTimeout: config.idleSeconds,
          departureTimeout: 10,
        });
      } catch (error) {
        safeFailure('room_create', error);
        throw error;
      }

      try {
        const d = await dispatch.createDispatch(
          s.roomName,
          config.agentName,
          {
            metadata: JSON.stringify({
              voiceSessionId: s.id,
            }),
          },
        );

        return {
          dispatchId: d.id,
        };
      } catch (error) {
        safeFailure('dispatch_create', error);
        throw error;
      }
    },

    async token(s, ttl) {
      if (ttl < 1) {
        throw new Error('Expired token');
      }

      const token = new Token(
        secrets.livekitKey,
        secrets.livekitSecret,
        {
          identity: s.participantIdentity,
          ttl,
        },
      );

      token.addGrant({
        roomJoin: true,
        room: s.roomName,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canPublishSources: [
          TrackSource.MICROPHONE,
        ],
        canUpdateOwnMetadata: false,
      });

      return token.toJwt();
    },

    async binding(s, b) {
      if (!s.dispatchId) {
        return false;
      }

      const d = await dispatch.getDispatch(
        s.dispatchId,
        s.roomName,
      );

      return Boolean(
        d &&
          d.id === s.dispatchId &&
          d.room === s.roomName &&
          d.agentName === config.agentName &&
          d.state?.jobs.some(
            j =>
              j.id === b.jobId &&
              j.dispatchId === s.dispatchId &&
              j.room?.name === s.roomName &&
              j.state?.participantIdentity ===
                b.workerIdentity &&
              j.state?.workerId &&
              !Number(j.state?.endedAt),
          ),
      );
    },

    async revoke(s) {
      if (s.dispatchId) {
        try {
          await dispatch.deleteDispatch(
            s.dispatchId,
            s.roomName,
          );
        } catch (error) {
          if (!missing(error)) {
            throw error;
          }
        }
      }

      try {
        await rooms.removeParticipant(
          s.roomName,
          s.participantIdentity,
          {
            revokeTokenTs: BigInt(
              Math.floor(Date.now() / 1000) + 1,
            ),
          },
        );
      } catch (error) {
        if (!missing(error)) {
          throw error;
        }
      }

      try {
        await rooms.deleteRoom(s.roomName);
      } catch (error) {
        if (!missing(error)) {
          throw error;
        }
      }
    },
  };
}