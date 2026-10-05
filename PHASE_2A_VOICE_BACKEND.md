# SehatMate Phase 2A implementation report

Historical snapshot: the generic-only Fish policy below is superseded by full authenticated Agent-reply speech on `s2.1-pro-free`, without an account allowlist. See `voice-worker/README.md` for current integration and runtime prerequisites. Statements below describe the original phase only.

Implemented locally on 4 October 2026 in `C:/Users/Zain/OneDrive/Desktop/sehatmate_api`. Changes are uncommitted. Phase 2A adds the backend foundation; realtime audio is not working or claimed to work yet.

## Implemented

- Dedicated, credential-free public voice configuration with strict budgets, feature switches, provider availability and a fixed generic-phrase Fish policy. Missing credentials, invalid limits or a paid Fish model fail closed. Existing OpenRouter configuration remains authoritative.
- Owned voice sessions referencing an existing owned Agent session, opaque room/participant/session IDs, fixed expiry, UTC daily reservations, concurrency accounting and short-lived microphone-only LiveKit participant tokens.
- Official `livekit-server-sdk` pinned to 2.19.1. Room creation, explicit named Agent dispatch, token signing, server-side dispatch/job/participant binding checks, and cleanup use supported SDK interfaces. Dispatch metadata contains only `voiceSessionId`.
- Separate Worker service credentials and session/epoch/job-bound delegations. Internal requests derive user identity from stored session ownership.
- Final text turns go through `handleAgentMessage`, its existing safety gateway and authoritative services. No planner, memory system, registry, database access for the Worker, or clinical capability was added.
- SQL storage, request HMACs, AES-256-GCM result receipts, per-Agent advisory locks, durable processing/recovery fences, confirmation deduplication and late-result rejection.
- Session-operation locks protect provisioning/switch/end races. Replacement room names persist before provisioning. Expired rooms awaiting revocation continue reserving concurrency. Agent deletion preserves voice accounting and cleanup records through nullable foreign keys.
- Separate two-connection pools for Agent locks and lifecycle locks prevent stalled turns from exhausting either the ordinary query pool or cleanup lock capacity. Four additional MySQL connections per API instance must be budgeted.
- Existing `/api/agent/message` request/response fields remain unchanged. Existing-session manual messages share the Agent lock and honor unresolved voice recovery fences even when realtime voice is disabled. On an unmigrated, voice-disabled database, a missing voice table allows ordinary manual operation.
- The inherited OpenRouter Fish synthesis path now rejects arbitrary reply text and paid Fish aliases before network access. Only fixed generic phrases can reach the free Fish model. Rejected speech uses the existing `speech.failed` response shape with `VOICE_PRIVACY_DEVICE_REQUIRED`; Phase 2B clients must use device speech for these replies. Other explicitly configured legacy providers keep their existing behavior.

## Files

Added:

```text
agent/agent_voice_config.js
agent/agent_voice_routes.js
services/voice_contract.js
services/voice_session_service.js
services/agent_turn_service.js
services/voice_store.js
services/livekit_voice_provider.js
migrations/20261004_phase_2a_voice.sql
voice_config_test.js
voice_backend_test.js
voice_storage_sdk_test.js
PHASE_2A_VOICE_BACKEND.md
```

Modified:

```text
server.js
agent/agent_voice_provider.js
agent_phase_f_test.js
package.json
package-lock.json
```

The Phase F test's provider-failure input now uses an allowed generic phrase, so it still exercises the provider failure rather than stopping at the new privacy guard. The SDK is the only new direct dependency. `test:voice-backend` runs the three new test files. No `.env` file was read for credentials or edited. No Flutter file, production database, Hostinger setting, deployment, commit or push was changed. The three pre-existing Flutter generated-file modifications remain present. Git could not create an isolated branch because `.git` writes were denied; edits remain in the original local checkout.

## REST contracts

All user routes use the existing `authenticate` middleware, its JWT issuer/audience and an authenticated-user rate limiter. Bodies are bounded to 8 KiB within these routes; unknown fields are rejected. Internal requests use a separate IP rate limiter and Worker authentication. Default route limits are 60 user requests/minute and 120 internal requests/minute per API instance. These are memory-based limiters, not a distributed abuse-control system.

Success envelope: `{ "success": true, "data": ... }`. Errors: `{ "success": false, "code": "VOICE_...", "message": "Voice request could not be completed." }`. Authentication retains the existing user middleware's error envelope. Sensitive provider/database exception text is not returned.

| Method/path | Body/authentication | Returned `data` |
|---|---|---|
| POST `/api/agent/voice-sessions` | User JWT; `{agentSessionId:"9"}`; ID must be a decimal string | Session plus participant `token`; eligible sessions are reused without extending expiry |
| POST `/api/agent/voice-sessions/:id/token` | User JWT; empty object/body | Authorized session plus renewed participant `token`; worker transport required |
| POST `/api/agent/voice-sessions/:id/transport` | User JWT; `{epoch:1,mode:"worker"}`; modes `worker`, `device`, `manual` | Updated session; a changed owner increments epoch, clears Worker binding and revokes the old room |
| POST `/api/agent/voice-sessions/:id/turns` | User JWT; finalized turn below | Turn receipt/status and current approved Agent result when completed |
| GET `/api/agent/voice-sessions/:id/turns/:turnId` | User JWT | Owned receipt/status, with current result when available |
| GET `/api/agent/voice-sessions/:id` | User JWT | Owned session/status; no token or secrets |
| DELETE `/api/agent/voice-sessions/:id` | User JWT; empty object/body | Ended session only after provider cleanup succeeds; repeat termination is idempotent |
| POST `/internal/agent/voice-sessions/:id/claim` | Worker service JWT; `{roomName,jobId,workerIdentity}` | `{token,epoch,expiresAt}` delegation after LiveKit verifies the stored dispatch/job binding |
| POST `/internal/agent/voice-sessions/:id/turns` | Session delegation JWT; finalized turn below | Same authoritative turn receipt/result contract |
| GET `/internal/agent/voice-sessions/:id/turns/:turnId` | Session delegation JWT | Status/result while delegation and session remain authorized |

The additional internal GET supports uncertain-result lookup without resubmission. No other new routes are needed.

Session fields: `id`, `agentSessionId`, `roomName`, `participantIdentity`, `epoch`, `transportOwner`, `status`, `createdAt`, `expiresAt`, `livekitUrl`, `providers`, `policy`. Effective expiry/idle expiry appears as `expired` while cleanup may still be pending. Operational stored states are `creating`, `active`, `closing`, `ended`.

Finalized text request:

```json
{"epoch":1,"turnId":"stable-client-turn-id","message":"What is my next task?","today":"2026-10-04","screenContext":{}}
```

Exactly one of `message`, `confirmation` or `clarification` is allowed. `today` and bounded `screenContext` are optional. Confirmation shape: `{confirmationId,decision:"confirm"|"cancel"}`. Clarification shape: `{clarificationId,choiceId}`. Both retain the existing Agent contracts. Interim flags, arbitrary user IDs, room names or permissions are not accepted on turns. Message length is bounded to 4,000 characters; screen context to 4 KiB. The Agent applies its own existing validation as well.

Receipt shape: `{turnId,status,epoch,result?}`. `result` contains only the existing approved fields: `sessionId`, `language`, `reply`, `navigation`, `confirmation`, `clarification`, `actionStatus`, `referencedEntities`, `fallbackCode`. No synthesized audio is added to these routes.

Statuses: `processing`, `completed`, `recovery_required`, `stale`, `receipt_expired`. A successful HTTP envelope with a processing/recovery status does not claim the domain action succeeded.

Common errors: 401 `VOICE_WORKER_UNAUTHORIZED`; 404 `VOICE_SESSION_NOT_FOUND`, `VOICE_TURN_NOT_FOUND`, `AGENT_SESSION_NOT_FOUND`; 409 `VOICE_STALE_EPOCH`, `VOICE_TURN_CONFLICT`, `VOICE_TURN_BUSY`, `VOICE_SESSION_BUSY`, `VOICE_RECOVERY_REQUIRED`, `VOICE_CONFIRMATION_NOT_CURRENT`; 410 `VOICE_SESSION_EXPIRED`; 422 `VOICE_INVALID_REQUEST`; 429 usage/concurrency/rate limits; 503 disabled/provider/unavailable/revocation-pending errors.

## Authentication and LiveKit details

User identity comes from the existing JWT middleware, never the submitted body. Participant tokens last at most 60 seconds, bounded further by session expiry. They grant joining only the generated room, publishing only microphone audio and subscribing. Data publication, own-metadata changes, video, administration, recording and arbitrary room selection are not granted.

Worker service JWTs use HS256 with `VOICE_WORKER_AUTH_KEY`, issuer `sehatmate-voice-worker`, audience `sehatmate-voice-claim`, subject `sehatmate-worker`, explicit `iat`/`exp`, and at most 60 seconds lifetime. Future Workers mint these locally using their own configured service key. They do not receive the user's JWT.

Delegations use a different `VOICE_DELEGATION_SECRET`, issuer `sehatmate-voice-backend`, audience `sehatmate-voice-turn`, subject equal to the opaque voice-session ID, scope `final-turn`, and signed epoch/job/Worker identity. They last at most 60 seconds and no longer than the session. Each internal turn rechecks stored ownership, active status, owner mode, binding and epoch. Claims must match server-returned dispatch ID, named Agent, room, live job, participant identity and Worker assignment. The Worker should connect with its expected participant identity before claiming, then renew its delegation while the session is eligible.

Transport switching removes the explicit dispatch and old room before exposing the next active epoch. Switching back to Worker mode provisions a fresh persisted room/participant identity. Provider failure leaves cleanup state visible instead of returning successful termination/switch. SDK failover replay is disabled and provider requests have a ten-second timeout. Maintenance retries closure every 15 seconds; an operator must resolve ongoing provider/database outages.

Invalid/expired user JWTs cannot renew tokens, submit turns or end another user's session. There is no existing server-side logout/revocation registry to extend: Phase 2B must call authenticated DELETE before logout and stop microphone/playback immediately on 401. If that request cannot arrive, fixed expiry/idle cleanup bounds backend eligibility. No Flutter logout changes were made.

SDK interfaces were checked against installed official type declarations and official documentation: [AccessToken](https://docs.livekit.io/reference/server-sdk-js/classes/AccessToken.html), [RoomServiceClient](https://docs.livekit.io/reference/server-sdk-js/classes/RoomServiceClient.html), [AgentDispatchClient](https://docs.livekit.io/reference/server-sdk-js/classes/AgentDispatchClient.html).

## Storage, budgets and recovery

Manual migration `migrations/20261004_phase_2a_voice.sql` creates `agent_voice_sessions` and `agent_turn_receipts`, with owner/Agent references, unique room names, unique `(voice_session_id,turn_id)`, unique `(agent_session_id,confirmation_id)` and usage/expiry indexes. Agent references use `ON DELETE SET NULL`; user deletion cascades. Ordinary expiry cleanup never deletes usage records from the current UTC day. New-table date queries use raw date strings interpreted as UTC, independently of mysql2's host timezone. No migration runs on server startup.

Creation locks the user's database row and reserves the entire potential session duration. Default duration is ten minutes, daily allowance one hour, concurrency one, idle window one minute. Session expiry is also capped by the existing Agent expiry and UTC midnight. Successful closure charges rounded elapsed seconds up to the reservation; unused seconds are released. Unrevoked rooms retain reservations and count against concurrency even after expiry. This is conservative backend usage accounting, not provider billing measurement or a guarantee of free service.

Turns lock the Agent session across API instances using MySQL advisory locks. A committed processing receipt and `active_turn_id` fence precede any Agent call. Request hashes are keyed HMAC-SHA256, so stored hashes do not expose transcripts. Approved responses are bounded to 64 KiB and encrypted with AES-256-GCM using fresh IVs and session/turn-bound authenticated data. Results expire after at most 24 hours; maintenance removes expired encrypted payloads. No audio or transcript history is persisted. Ended resolved rows are pruned after two days beyond session expiry. Unresolved recovery tombstones remain until reviewed or removed with the owning user.

Same turn/hash returns its prior receipt without executing again; a different hash conflicts. A duplicate confirmation under a different turn ID returns the original confirmation receipt, so callers must follow the returned `turnId`. The existing Agent still checks/consumes the actual current pending confirmation and retains clinical/action restrictions. No ordinary "yes" gains new authorization outside the Agent's existing session-aware handling.

On response timeout, the caller receives `processing`; Agent execution and its lock continue. Poll the same receipt. A finished operation may subsequently settle. A crashed/stalled processing receipt ages to `recovery_required`; handler exceptions or the Agent's unexpected capability-failure result also produce recovery fences. The coordinator does not automatically rerun or clear uncertain actions. New voice turns and existing-session manual messages remain blocked for that Agent. Explicit domain/manual investigation is required; there is deliberately no endpoint that simply clears the fence.

Session termination or epoch changes suppress late replies, navigation and speech-facing results. An in-flight authorized domain write may still finish after termination; cancelling an HTTP wait does not roll back that write. Task outcomes retain their existing domain idempotency. Schedule confirmation remains a multi-write service without an atomic transaction shared with receipts: an abrupt crash can leave partial/committed work with an uncertain receipt. This implementation prevents automatic replay and reports uncertainty; it does not claim exactly-once distributed execution or automatic reconciliation.

## Environment variable names

No values or real credentials are included here.

Existing/common and proposed names:

```text
AGENT_ENABLED
AGENT_MAX_SESSION_AGE_MINUTES
JWT_SECRET
OPENROUTER_API_KEY
LIVEKIT_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
DEEPGRAM_API_KEY
FISH_API_KEY
FISH_TTS_MODEL
REALTIME_VOICE_ENABLED
VOICE_MAX_SESSION_SECONDS
VOICE_MAX_DAILY_SECONDS
VOICE_MAX_CONCURRENT_SESSIONS
FISH_GENERIC_SPEECH_ONLY
```

Additional names:

```text
VOICE_WORKER_AUTH_KEY
VOICE_DELEGATION_SECRET
VOICE_RECEIPT_ENCRYPTION_KEY
VOICE_IDLE_TIMEOUT_SECONDS
VOICE_TURN_TIMEOUT_SECONDS
VOICE_RECEIPT_TTL_SECONDS
DEEPGRAM_DISABLED
FISH_DISABLED
```

Existing legacy voice names remain in their current configuration owner:

```text
VOICE_AGENT_ENABLED
SEHATMATE_AUDIO_MODEL
SEHATMATE_TTS_MODEL
SEHATMATE_TTS_VOICE
```

The Worker/delegation keys must be distinct, independently generated secrets of at least 32 characters. The receipt key must be canonical base64 for 32 random bytes; protect it as an encryption key and retain it while receipts may need recovery. Backend realtime availability requires all LiveKit/session authentication/encryption settings and valid limits. Fish availability requires its explicitly permitted free model and generic-only policy. Deepgram policy exposes mandatory model-improvement opt-out for the future Worker; no Deepgram request is made in Phase 2A. Feature settings are read at API startup; restart/reload is needed for configuration changes. With valid credentials retained, disabling realtime also schedules existing-room cleanup.

## Executed verification

New command: `node --test voice_config_test.js voice_backend_test.js voice_storage_sdk_test.js` — **30 passed, 0 failed**, no skipped tests. This includes actual SDK token signing/decoded grants, mocked SDK dispatch/revocation, SQL transaction/UTC/lock tests, authenticated HTTP tests using the actual existing middleware extracted without starting the production server, lifecycle races, timeout recovery, conflicting duplicates, confirmation deduplication, and encrypted receipt recovery after rebuilding services over durable test storage.

Existing regressions executed successfully:

| Test file | Result |
|---|---|
| `agent_foundation_test.js` | 41 passed |
| `agent_phase_b_test.js` | 51 passed |
| `agent_phase_d_test.js` | 53 passed |
| `agent_phase_e_test.js` | 68 passed |
| `agent_phase_f_test.js` | 24 passed; rerun after privacy guard |
| `agent_turn_language_test.js` | 22 passed |
| `services_boundary_test.js` | 32 passed |
| `schedule_time_guard_test.js` | Passed; script reports no numeric count |
| `schedule_reliability_test.js` | 12 passed |
| `schedule_recurrence_test.js` | 6 passed |
| `schedule_duration_test.js` | 8 passed |
| `family_care_test.js` | 35 passed |
| `teach_back_test.js` | 28 passed |
| `phase_i_progress_documents_test.js` | 30 passed |

Syntax checks passed for server and all changed/new implementation modules. `git diff --check` passed; Git emitted ordinary LF/CRLF normalization warnings. Independent review identified lifecycle, accounting, lock-pool and privacy defects; they were corrected with focused regression coverage. No known failing executed test remains. These results do not represent every repository test or a production end-to-end run.

## Unverified limits and Phase 2B prerequisites

1. No safe disposable MySQL database was available. Actual migration execution, foreign-key compatibility, transaction isolation and advisory locks across real API replicas remain unverified. Apply and test this migration only in a separately confirmed disposable environment before enabling the feature; assess the four extra connections per instance.
2. No LiveKit/Deepgram/Fish/OpenRouter provider request was made using real credentials, and no audio pipeline exists. Test real dispatch/job state timing, token renewal, room cleanup and token-revocation behavior with an explicitly authorized non-production LiveKit project and a Phase 2B Worker. Removal token revocation depends on the server deployment; older/self-hosted deployments may allow an already issued token to rejoin until its short TTL. A token's expiry also does not itself disconnect an already connected participant. Cleanup can lag or fail during outages, so backend budgets are not a hard provider billing cap.
3. Future Python Worker hosting is separate from Hostinger. Configure its own LiveKit credentials, Deepgram key, optional Fish key, backend HTTPS base URL and `VOICE_WORKER_AUTH_KEY`. Register the exact Agent name `sehatmate-voice`. The Worker must NOT receive user JWTs, database credentials, backend JWT secret, delegation signing secret, receipt encryption key, or OpenRouter key. Reasoning remains in the Node backend.
4. Worker audio code must enforce Deepgram model-improvement opt-out, no audio/transcript logging, generic-only Fish synthesis using the backend's fixed policy, no paid fallback, and device TTS for medical/personal replies. Provider account privacy and free-tier eligibility are operational prerequisites, not proven by local flags.
5. Flutter integration must implement foreground consent, transport-epoch handoff before fallback STT, stable turn IDs, receipt polling instead of replay, confirmation/clarification cards, stopped audio on stale/401/logout, short-token/delegation renewal and bounded reconnect attempts. It must treat `processing`/`recovery_required` as uncertain and refresh authoritative domain state before offering a new action.
6. Exercise crash-after-confirmation, provider timeout, midnight, idle cleanup and reconnect scenarios in staging. Define an operator reconciliation procedure for partial schedule writes and unresolved receipts; there is no automatic fence-clearing endpoint.

No Python Worker, streaming STT, Fish synthesis, Flutter transport, background microphone, Smart Alarms, Phase 3/4 work or deployment was implemented. Phase 2B requires explicit approval; this implementation stops at Phase 2A.
