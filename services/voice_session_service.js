import {randomUUID} from 'node:crypto';
import jwt from 'jsonwebtoken';

import {
  genericSpeechCatalog,
  sessionSpeechPolicy,
} from '../agent/agent_voice_config.js';

import {
  voiceError,
  strictObject,
  opaqueId,
  ownedId,
  millis,
} from './voice_contract.js';


function safeVoiceCreateFailure(stage, error) {
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

  console.warn('VOICE_SESSION_CREATE_FAILED', {
    stage,
    name,
    code,
    status,
  });
}


// Database transactions protect budgets and state.
// No provider request holds a SQL transaction.
export function createVoiceSessionService({
  store,
  config,
  secrets,
  livekit,
  readAgent,
  agentEnabled,
  now = Date.now,
}) {
  const enabled = () => {
    if (!config.enabled || !agentEnabled()) {
      throw voiceError('VOICE_DISABLED', 503);
    }
  };

  async function operation(userId, id, run) {
    const unlock = await store.acquireSessionLock(
      String(userId),
      id,
    );

    if (!unlock) {
      throw voiceError('VOICE_SESSION_BUSY');
    }

    try {
      return await run();
    } finally {
      await unlock();
    }
  }

  const publicSession = s => ({
    id: s.id,
    agentSessionId: s.agentSessionId,
    roomName: s.roomName,
    participantIdentity: s.participantIdentity,
    workerIdentity: s.workerIdentity,
    activeTurnId: s.activeTurnId,
    epoch: s.epoch,
    transportOwner: s.transportOwner,

    status:
      s.status === 'active' &&
      (
        millis(s.expiresAt) <= now() ||
        millis(s.lastActiveAt) +
          config.idleSeconds * 1000 <= now() ||
        !s.agentSessionId
      )
        ? 'expired'
        : s.status,

    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    livekitUrl: config.livekitUrl,
    providers: config.providers,
    policy: config.policy,
  });

  async function owned(userId, id, db = store) {
    const s =
      opaqueId(id)
        ? await db.getSession(id)
        : null;

    if (!s || s.userId !== String(userId)) {
      throw voiceError(
        'VOICE_SESSION_NOT_FOUND',
        404,
      );
    }

    return s;
  }

  async function active(s, onAgent = null) {
    enabled();

    if (
      s.status !== 'active' ||
      millis(s.expiresAt) <= now() ||
      millis(s.lastActiveAt) +
        config.idleSeconds * 1000 <= now()
    ) {
      throw voiceError(
        'VOICE_SESSION_EXPIRED',
        410,
      );
    }

    const a = await readAgent({
      userId: s.userId,
      sessionId: s.agentSessionId,
    });

    if (!a.ok) {
      throw voiceError(
        'AGENT_SESSION_NOT_FOUND',
        404,
      );
    }

    if (onAgent) onAgent(a.data.session);
    return s;
  }

  async function token({userId, id}) {
    enabled();

    return store.transaction(
      String(userId),
      async db => {
        const s = await active(
          await owned(userId, id, db),
        );

        if (s.transportOwner !== 'worker') {
          throw voiceError(
            'VOICE_TRANSPORT_UNAVAILABLE',
          );
        }

        s.lastActiveAt =
          new Date(now()).toISOString();

        await db.saveSession(s);

        return {
          ...publicSession(s),

          token: await livekit.token(
            s,
            Math.min(
              config.tokenTtlSeconds,
              Math.floor(
                (
                  millis(s.expiresAt) -
                  now()
                ) / 1000,
              ),
            ),
          ),
        };
      },
    );
  }

  async function create({userId, input}) {
    enabled();

    strictObject(
      input,
      ['agentSessionId'],
    );

    if (!ownedId(input.agentSessionId)) {
      throw voiceError(
        'VOICE_INVALID_REQUEST',
        422,
      );
    }

    userId = String(userId);

    const agent = await readAgent({
      userId,
      sessionId: input.agentSessionId,
    });

    if (!agent.ok) {
      throw voiceError(
        'AGENT_SESSION_NOT_FOUND',
        404,
      );
    }

    for (
      const previous of
        await store.listSessions(userId)
    ) {
      if (
        ['creating', 'active', 'closing']
          .includes(previous.status) &&
        (
          previous.status === 'closing' ||
          millis(previous.expiresAt) <= now() ||
          millis(previous.lastActiveAt) +
            config.idleSeconds * 1000 <= now()
        )
      ) {
        try {
          await end({
            userId,
            id: previous.id,
          });
        } catch {
          // Unrevoked rows continue
          // reserving concurrency.
        }
      }
    }

    let reused = false;

    let s = await store.transaction(
      userId,
      async db => {
        const rows =
          await db.listSessions(userId);

        // Reservations remain charged until
        // an authenticated close/sweeper
        // accounts usage.
        const current = rows.filter(
          r =>
            [
              'creating',
              'active',
              'closing',
            ].includes(r.status),
        );

        const reuse = current.find(
          r =>
            r.status === 'active' &&
            millis(r.expiresAt) > now() &&
            r.agentSessionId ===
              input.agentSessionId &&
            millis(r.lastActiveAt) +
              config.idleSeconds * 1000 >
              now(),
        );

        if (reuse) {
          reused = true;
          return reuse;
        }

        if (
          current.length >=
          config.maxConcurrentSessions
        ) {
          throw voiceError(
            'VOICE_CONCURRENT_LIMIT',
            429,
          );
        }

        const day =
          new Date(now())
            .toISOString()
            .slice(0, 10);

        const used = rows
          .filter(
            r =>
              r.usageDay === day,
          )
          .reduce(
            (n, r) =>
              n + r.chargedSeconds,
            0,
          );

        const midnight =
          Date.parse(
            `${day}T00:00:00Z`,
          ) + 86400000;

        const seconds = Math.min(
          config.maxSessionSeconds,

          Math.floor(
            (
              millis(
                agent.data.session.expiresAt,
              ) -
              now()
            ) / 1000,
          ),

          Math.floor(
            (
              midnight -
              now()
            ) / 1000,
          ),
        );

        if (seconds < 1) {
          throw voiceError(
            'VOICE_SESSION_EXPIRED',
            410,
          );
        }

        if (
          used + seconds >
          config.maxDailySeconds
        ) {
          throw voiceError(
            'VOICE_DAILY_LIMIT',
            429,
          );
        }

        const id = randomUUID();

        const createdAt =
          new Date(now())
            .toISOString();

        const row = {
          id,
          userId,
          agentSessionId:
            input.agentSessionId,

          roomName:
            `smv-${randomUUID()}`,

          participantIdentity:
            `smu-${randomUUID()}`,

          epoch: 1,

          transportOwner: 'worker',

          status: 'creating',

          createdAt,

          lastActiveAt: createdAt,

          expiresAt:
            new Date(
              now() +
              seconds * 1000,
            ).toISOString(),

          usageDay: day,

          chargedSeconds: seconds,

          activeTurnId: null,

          dispatchId: null,

          jobId: null,

          workerIdentity: null,
        };

        await db.saveSession(row);

        return row;
      },
    );

    if (reused) {
      return token({
        userId,
        id: s.id,
      });
    }

    return operation(
      userId,
      s.id,
      async () => {
        let stage = 'provider_create';

        try {
          const provision =
            await livekit.create(s);

          stage = 'persist_dispatch';

          s = await store.transaction(
            userId,
            async db => {
              const row =
                await owned(
                  userId,
                  s.id,
                  db,
                );

              row.dispatchId =
                provision.dispatchId;

              if (
                row.status !==
                  'creating' ||
                millis(
                  row.expiresAt,
                ) <= now()
              ) {
                await db.saveSession(
                  row,
                );

                throw voiceError(
                  'VOICE_SESSION_EXPIRED',
                  410,
                );
              }

              row.status = 'active';

              await db.saveSession(row);

              return row;
            },
          );

          stage = 'participant_token';

          return await token({
            userId,
            id: s.id,
          });

        } catch (error) {
          safeVoiceCreateFailure(
            stage,
            error,
          );

          // Keep failed provisioning
          // revocable; never release a
          // reservation while a room
          // may exist.
          await store.transaction(
            userId,
            async db => {
              const row =
                await owned(
                  userId,
                  s.id,
                  db,
                );

              row.status = 'closing';

              row.epoch++;

              await db.saveSession(
                row,
              );
            },
          );

          try {
            await endUnlocked({
              userId,
              id: s.id,
            });
          } catch {
            // Existing lifecycle cleanup
            // will retry if necessary.
          }

          throw voiceError(
            'VOICE_PROVIDER_UNAVAILABLE',
            503,
          );
        }
      },
    );
  }

  async function get({userId, id}) {
    return publicSession(
      await owned(
        userId,
        id,
      ),
    );
  }

  async function transport({
    userId,
    id,
    input,
  }) {
    strictObject(
      input,
      ['epoch', 'mode'],
    );

    if (
      !Number.isInteger(input.epoch) ||
      ![
        'worker',
        'device',
        'manual',
      ].includes(input.mode)
    ) {
      throw voiceError(
        'VOICE_INVALID_REQUEST',
        422,
      );
    }

    return operation(
      userId,
      id,
      async () => {
        let row =
          await store.transaction(
            String(userId),
            async db => {
              const s =
                await active(
                  await owned(
                    userId,
                    id,
                    db,
                  ),
                );

              if (
                s.epoch !== input.epoch
              ) {
                throw voiceError(
                  'VOICE_STALE_EPOCH',
                );
              }

              if (s.activeTurnId) {
                throw voiceError(
                  'VOICE_TURN_BUSY',
                );
              }

              if (
                s.transportOwner ===
                input.mode
              ) {
                return s;
              }

              s.epoch++;

              s.transportOwner =
                input.mode;

              s.jobId = null;

              s.workerIdentity = null;

              // Revoke room before
              // exposing replacement epoch.
              s.status = 'closing';

              await db.saveSession(s);

              return s;
            },
          );

        if (
          row.status === 'closing'
        ) {
          try {
            await livekit.revoke(row);
          } catch {
            throw voiceError(
              'VOICE_REVOCATION_PENDING',
              503,
            );
          }

          if (
            input.mode === 'worker'
          ) {
            row =
              await store.transaction(
                String(userId),
                async db => {
                  const s =
                    await owned(
                      userId,
                      id,
                      db,
                    );

                  if (
                    s.status !==
                      'closing' ||
                    s.epoch !==
                      row.epoch
                  ) {
                    throw voiceError(
                      'VOICE_STALE_EPOCH',
                    );
                  }

                  s.roomName =
                    `smv-${randomUUID()}`;

                  s.participantIdentity =
                    `smu-${randomUUID()}`;

                  s.dispatchId = null;

                  await db.saveSession(
                    s,
                  );

                  return s;
                },
              );

            try {
              const p =
                await livekit.create(
                  row,
                );

              row.dispatchId =
                p.dispatchId;

            } catch {
              throw voiceError(
                'VOICE_PROVIDER_UNAVAILABLE',
                503,
              );
            }
          }

          row =
            await store.transaction(
              String(userId),
              async db => {
                const s =
                  await owned(
                    userId,
                    id,
                    db,
                  );

                if (
                  s.status !==
                    'closing' ||
                  s.epoch !==
                    row.epoch ||
                  s.transportOwner !==
                    input.mode
                ) {
                  throw voiceError(
                    'VOICE_STALE_EPOCH',
                  );
                }

                Object.assign(
                  s,
                  {
                    roomName:
                      row.roomName,

                    participantIdentity:
                      row.participantIdentity,

                    dispatchId:
                      row.dispatchId,

                    status: 'active',

                    lastActiveAt:
                      new Date(
                        now(),
                      ).toISOString(),
                  },
                );

                await db.saveSession(s);

                return s;
              },
            );
        }

        return publicSession(row);
      },
    );
  }

  async function end({
    userId,
    id,
    workerAuth = null,
  }) {
    return operation(
      userId,
      id,
      () =>
        endUnlocked({
          userId,
          id,
          workerAuth,
        }),
    );
  }

  async function endUnlocked({
    userId,
    id,
    workerAuth = null,
  }) {
    let s =
      await store.transaction(
        String(userId),
        async db => {
          const row =
            await owned(
              userId,
              id,
              db,
            );

          if (
            row.status === 'ended'
          ) {
            return row;
          }

          if (workerAuth) {
            await active(row);

            if (
              workerAuth.sub !== id ||
              workerAuth.epoch !==
                row.epoch ||
              row.transportOwner !==
                'worker' ||
              workerAuth.jobId !==
                row.jobId ||
              workerAuth.workerIdentity !==
                row.workerIdentity
            ) {
              throw voiceError(
                'VOICE_STALE_EPOCH',
              );
            }
          }

          row.epoch++;

          row.status = 'closing';

          await db.saveSession(row);

          return row;
        },
      );

    if (
      s.status === 'ended'
    ) {
      return publicSession(s);
    }

    try {
      await livekit.revoke(s);
    } catch {
      throw voiceError(
        'VOICE_REVOCATION_PENDING',
        503,
      );
    }

    s =
      await store.transaction(
        String(userId),
        async db => {
          const row =
            await owned(
              userId,
              id,
              db,
            );

          row.status = 'ended';

          row.chargedSeconds =
            Math.min(
              row.chargedSeconds,

              Math.max(
                0,

                Math.ceil(
                  (
                    now() -
                    millis(
                      row.createdAt,
                    )
                  ) / 1000,
                ),
              ),
            );

          await db.saveSession(row);

          return row;
        },
      );

    return publicSession(s);
  }

  function verifyService(token) {
    try {
      const p = jwt.verify(
        token,
        secrets.workerKey,
        {
          algorithms: ['HS256'],

          issuer:
            'sehatmate-voice-worker',

          audience:
            'sehatmate-voice-claim',

          clockTimestamp:
            Math.floor(
              now() / 1000,
            ),
        },
      );

      if (
        p.sub !==
          'sehatmate-worker' ||
        !Number.isInteger(p.iat) ||
        !Number.isInteger(p.exp) ||
        p.exp - p.iat > 60 ||
        p.exp <= p.iat ||
        p.iat >
          now() / 1000
      ) {
        throw new Error();
      }

      return p.sub;

    } catch {
      throw voiceError(
        'VOICE_WORKER_UNAUTHORIZED',
        401,
      );
    }
  }

  function verifyDelegation(
    token,
    id,
  ) {
    try {
      const p = jwt.verify(
        token,
        secrets.delegationSecret,
        {
          algorithms: ['HS256'],

          issuer:
            'sehatmate-voice-backend',

          audience:
            'sehatmate-voice-turn',

          clockTimestamp:
            Math.floor(
              now() / 1000,
            ),
        },
      );

      if (
        p.sub !== id ||
        p.scope !==
          'final-turn' ||
        !Number.isInteger(p.iat) ||
        !Number.isInteger(p.exp) ||
        p.exp - p.iat > 60 ||
        p.exp <= p.iat ||
        p.iat >
          now() / 1000
      ) {
        throw new Error();
      }

      return p;

    } catch {
      throw voiceError(
        'VOICE_WORKER_UNAUTHORIZED',
        401,
      );
    }
  }

  async function authorizeWorker(
    auth,
    id,
  ) {
    const s =
      await store.getSession(id);

    if (!s) {
      throw voiceError(
        'VOICE_SESSION_NOT_FOUND',
        404,
      );
    }

    await active(s);

    if (
      auth.sub !== id ||
      auth.epoch !== s.epoch ||
      s.transportOwner !==
        'worker' ||
      auth.jobId !== s.jobId ||
      auth.workerIdentity !==
        s.workerIdentity
    ) {
      throw voiceError(
        'VOICE_STALE_EPOCH',
      );
    }

    return s;
  }

  async function claim({
    id,
    serviceIdentity,
    input,
  }) {
    enabled();

    strictObject(
      input,
      [
        'roomName',
        'jobId',
        'workerIdentity',
      ],
    );

    if (
      serviceIdentity !==
        'sehatmate-worker' ||
      !opaqueId(input.jobId) ||
      !opaqueId(
        input.workerIdentity,
      ) ||
      typeof input.roomName !==
        'string'
    ) {
      throw voiceError(
        'VOICE_WORKER_UNAUTHORIZED',
        401,
      );
    }

    const initial =
      await store.getSession(id);

    if (!initial) {
      throw voiceError(
        'VOICE_SESSION_NOT_FOUND',
        404,
      );
    }

    await active(initial);

    if (initial.transportOwner !== 'worker') {
      console.warn('VOICE_BINDING_FAILED:TRANSPORT_OWNER');
      throw voiceError(
        'VOICE_WORKER_BINDING',
        403,
      );
    }

    if (input.roomName !== initial.roomName) {
      console.warn('VOICE_BINDING_FAILED:ROOM_NAME');
      throw voiceError(
        'VOICE_WORKER_BINDING',
        403,
      );
    }

    let binding;

    try {
      binding =
        await livekit.binding(
          initial,
          input,
        );
    } catch {
      console.warn('VOICE_BINDING_FAILED:PROVIDER_BINDING');
      throw voiceError(
        'VOICE_PROVIDER_UNAVAILABLE',
        503,
      );
    }

    if (!binding) {
      console.warn('VOICE_BINDING_FAILED:PROVIDER_BINDING');
      throw voiceError(
        'VOICE_WORKER_BINDING',
        403,
      );
    }

    let sttLanguage;
    const s =
      await store.transaction(
        initial.userId,
        async db => {
          const row =
            await active(
              await owned(
                initial.userId,
                id,
                db,
              ),
              agent => {
                // readAgent is scoped to the authenticated owner and normalizes
                // stored Agent languages. Roman Urdu is an output preference.
                sttLanguage = ['ur', 'roman_ur'].includes(agent.language) ? 'ur' : 'en';
              },
            );

          if (
            row.epoch !==
              initial.epoch ||
            row.transportOwner !==
              'worker'
          ) {
            throw voiceError(
              'VOICE_STALE_EPOCH',
            );
          }

          if (
            row.jobId &&
            (
              row.jobId !==
                input.jobId ||
              row.workerIdentity !==
                input.workerIdentity
            )
          ) {
            console.warn('VOICE_BINDING_FAILED:EXISTING_DB_BINDING');
            throw voiceError(
              'VOICE_WORKER_BINDING',
              403,
            );
          }

          row.jobId =
            input.jobId;

          row.workerIdentity =
            input.workerIdentity;

          row.lastActiveAt =
            new Date(
              now(),
            ).toISOString();

          await db.saveSession(row);

          return row;
        },
      );

    const iat =
      Math.floor(
        now() / 1000,
      );

    const exp =
      Math.min(
        iat + 60,

        Math.floor(
          millis(
            s.expiresAt,
          ) / 1000,
        ),
      );

    return {
      token: jwt.sign(
        {
          sub: id,

          scope:
            'final-turn',

          epoch: s.epoch,

          jobId:
            s.jobId,

          workerIdentity:
            s.workerIdentity,

          iat,

          exp,
        },

        secrets.delegationSecret,

        {
          algorithm: 'HS256',

          issuer:
            'sehatmate-voice-backend',

          audience:
            'sehatmate-voice-turn',
        },
      ),

      epoch: s.epoch,

      expiresAt:
        new Date(
          exp * 1000,
        ).toISOString(),

      sessionExpiresAt:
        s.expiresAt,

      participantIdentity:
        s.participantIdentity,

      idleTimeoutSeconds:
        config.idleSeconds,

      providers:
        config.providers,

      policy:
        config.policy,

      speechPolicy:
        sessionSpeechPolicy(
          config,
          s,
        ),

      genericPrompts:
        genericSpeechCatalog(),

      sttLanguage,
    };
  }

  return {
    create,
    get,
    token,
    transport,
    end,
    claim,
    verifyService,
    verifyDelegation,
    authorizeWorker,
    owned,
    active,
  };
}
