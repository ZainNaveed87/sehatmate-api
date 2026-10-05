# SehatMate Python voice worker — integrated companion

Separate audio transport process. The existing Node Agent is the only reasoning, action, confirmation, language and memory authority. No database, domain tools, LLM or user JWT is supplied to this process. The complete companion integration uses the existing authorized Node Agent and versioned Worker protocol.

## Dependencies and local development

Python 3.12.14; direct dependencies: `livekit-agents==1.8.4`, `livekit-plugins-deepgram==1.8.4`, `aiohttp==3.13.3`, `PyJWT==2.15.1`. `requirements.lock.txt` pins the entire resolved environment, including LiveKit RTC 1.1.20 and PyAV 19.0.1. No Fish plugin is needed.

From this directory, create a separate virtual environment and install the lock:

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.lock.txt
.venv/Scripts/python -m unittest discover -s tests -v
```

Use `bin/python` on Linux. After an operator supplies the isolated Worker environment, run `python worker.py check`, then `python worker.py start`. Check validates Python 3.12, core dependency pins, enabled provider configuration and native SDK imports without contacting providers. It emits only a sanitized code and returns nonzero on failure. The Dockerfile is prepared for Linux amd64 but has not been built or deployed here; neither Docker nor Podman is available locally. PyPI wheel metadata was checked for all 70 exact lock entries: each has a compatible Python 3.12/Linux amd64 wheel. This does not prove Linux installation or native execution.

Windows previously blocked the PyAV import. The latest isolated offline `worker.py check` now passes Python/core pins and actual PyAV/RTC/Agents/Deepgram imports without any Windows security changes. That check does not register the Worker, connect providers or prove an RTC session. Linux remains the prepared container target; its build/start and real audio still need an authorized runtime.

## Configuration

Secret values are never included here. Required names:

| Variable | Requirement/default |
|---|---|
| VOICE_WORKER_ENABLED | Explicit `true` |
| VOICE_BACKEND_URL | HTTPS origin, no path, query or embedded credentials |
| LIVEKIT_URL | WSS origin |
| LIVEKIT_API_KEY, LIVEKIT_API_SECRET | Worker registration credentials; secret at least 32 characters |
| VOICE_WORKER_AUTH_KEY | Existing Phase 2A Worker claim key, at least 32 characters |
| DEEPGRAM_API_KEY | Provider credential, required when enabled |
| DEEPGRAM_ENABLED / DEEPGRAM_DISABLED | Explicit enable; disable takes precedence |
| VOICE_STT_LANGUAGE | `en` default or `ur`; independent of authoritative Agent reply language |
| FISH_API_KEY | Provider credential, required when enabled |
| FISH_ENABLED / FISH_DISABLED | Explicit enable; disable takes precedence |
| FISH_TTS_MODEL | Exactly `s2.1-pro-free`; omission or another model disables Fish |
| FISH_REFERENCE_ID | Approved public preset; no reference uploads or cloning |
| LIVEKIT_AGENT_NAME_OVERRIDE | Omit, or exactly `sehatmate-voice` |
| VOICE_MAX_SESSION_SECONDS | 600; range 30–600 |
| VOICE_IDLE_TIMEOUT_SECONDS | 60; range 15–60 |
| VOICE_WORKER_MAX_CONCURRENT_JOBS | 1; range 1–5 per Worker process |
| VOICE_PROVIDER_RETRIES | 1; range 0–2; registration/claim and failed receipt GET only |
| VOICE_PROVIDER_TIMEOUT_SECONDS | 15; range 3–30 |
| VOICE_RECEIPT_POLL_SECONDS | 120; range 5–180 |
| VOICE_MAX_AUDIO_SECONDS | 30 per active utterance; range 5–60 |
| VOICE_MAX_TTS_REQUESTS | 8 per session; range 0–20 |
| VOICE_MAX_TTS_SECONDS | 12 per bounded PCM segment; range 1–20 |
| VOICE_TTS_SEGMENT_CHARS | 120 per segment; range 80–500; no word/name splitting |

The environment must not contain `JWT_SECRET`, `DB_PASSWORD`, `OPENROUTER_API_KEY`, `VOICE_DELEGATION_SECRET` or `VOICE_RECEIPT_ENCRYPTION_KEY`. Configuration rejects these keys. Use a dedicated service environment, never the backend's complete environment. SDK logs and telemetry are suppressed to prevent transcript or provider-error logging; operations should monitor process health and sanitized protocol events.

Local caps are ceilings; the claimed backend deadline and idle limits can shorten them. Backend reservation, usage, ownership and transport epochs remain authoritative. No paid-model upgrade, credit purchase, synthesis POST retry or action POST retry exists. Deepgram model-improvement opt-out is mandatory; verify account eligibility and cost before any later live test.

## LiveKit and backend bridge

The official AgentServer registers exactly `sehatmate-voice`, uses thread jobs so slot accounting is shared, and connects with automatic subscriptions disabled. Dispatch metadata contains only `voiceSessionId`, with recording disabled. Worker identity is `agent-<jobId>`.

The initial service JWT uses the separate Worker authentication key, HS256, issuer `sehatmate-voice-worker`, audience `sehatmate-voice-claim`, subject `sehatmate-worker` and a 60-second expiry. `POST /internal/agent/voice-sessions/:id/claim` binds room name, server job ID and Worker identity. The claim returns a short-lived delegation, authorized participant identity, epoch, session deadline, idle cap, provider policy and generic phrase catalog. Renewal runs every 25 seconds and before delegation expiry; an epoch change stops the session.

The Worker checks delegation claims locally without possessing the signing secret. This is explicitly not local signature verification: the authenticated HTTPS claim response is trusted, and the backend verifies the signature and binding on every internal request.

Only the claimed user's microphone track is subscribed. Agent output and other participants are excluded. Reliable response data is targeted exclusively to that participant. Backend grants now allow that user to publish data controls while retaining microphone-only media permissions.

Final segments accumulate until Deepgram's end-of-speech event. Interim events never call the Agent. Each completed utterance gets one stable UUID. `POST /internal/agent/voice-sessions/:id/turns` sends `{epoch, turnId, message}` exactly once. An uncertain POST result is recovered through `GET .../turns/:turnId`; it is never replayed. `processing`, `completed`, `recovery_required`, `stale` and `receipt_expired` are handled. Recovery fences stop new turns.

Completed Agent objects are forwarded intact, including navigation, confirmation, clarification, action status and language. Results over the packet budget emit `resultViaUserApi: true` plus `receiptPath`; the client fetches the existing owned receipt with its own JWT. Scoped `DELETE /internal/agent/voice-sessions/:id` terminates the session. Worker epoch/job binding is revalidated inside the backend operation transaction to prevent an old Worker from ending a replacement transport.

## Providers and authoritative speech

Deepgram uses the official plugin, Nova-3, 16 kHz mono audio, interim transcripts, VAD and endpointing. `mip_opt_out=True` is verified in the actual installed plugin WebSocket URL builder. Smart formatting, numeral conversion and dictation are disabled; no medication correction or contextual hints are added. Provider transcription can still be wrong: the Worker does not reinterpret uncertain medical speech. English and Urdu are explicit single-language options; there is no Roman Urdu locale or promised English/Urdu code-switch accuracy. Backend turn-language handling remains unchanged.

The STT stream has automatic retries disabled. Failure closes cloud audio and drops partial words before structured device-STT fallback; rate/quota errors use sanitized codes. A new stream requires explicit recovery/resume, avoiding partial words across a connection gap.

Fish is the normal primary TTS path for all authenticated owned Voice Companion sessions in this hackathon application. There is no per-account speech allowlist, synthetic-account mode or separate Demo Mode. Every authoritative reply type uses the same path: conversation, care plans/tasks, Reality Check, Simulation, Care Gaps, confirmations, clarifications, navigation and progress explanations. Speech does not invent or execute business operations; existing Agent capabilities remain authoritative.

Fish uses native HTTPS `POST /v1/tts`, Bearer authentication, explicit model header `s2.1-pro-free`, a public preset ID and PCM signed 16-bit mono at 24 kHz. Output is streamed into a strictly bounded memory buffer, then played in 20 ms RTC frames with a 100 ms source queue. Global missing/disabled provider configuration still invokes device/text fallback.

Claims carry `speechPolicy={v:1,voiceSessionId,epoch,mode:'agent_reply',provider:'fish',model:'s2.1-pro-free'}` when backend Fish configuration is available; otherwise mode is `device_only`. Completed owned receipts add `turnId`. Matching authenticated claim and receipt bindings permit full replies without account attributes or client flags. Missing policy, wrong session/epoch/turn binding or paid model still falls back. No user IDs, records or credentials are placed in room metadata. Backend availability needs `FISH_API_KEY`, exact `FISH_TTS_MODEL=s2.1-pro-free` and no `FISH_DISABLED=true`, in addition to the existing Agent/voice configuration.

Permitted replies are segmented at existing whitespace without normalizing, translating, correcting doses, altering medicine names or dropping characters. Each segment uses one bounded native PCM request, sequential playback and the same playback ID. Request/audio caps and cancellation still apply. An over-budget reply falls back before sending; a later provider failure returns the exact remaining suffix for device speech while retaining the complete Agent result. Large results/device instructions point to the existing owned receipt API rather than exceeding LiveKit packet limits (`textStartOffset` is a Dart-compatible UTF-16 code-unit offset).

Fish's [official free-model announcement](https://fish.audio/blog/s2-1-pro-free-api/) currently states that requests may improve model quality, offers no SLA and extends access through November 30, 2026. Its [privacy policy](https://fish.audio/privacy/) covers user content collection and service improvement. This implementation provides no retention or real-patient privacy assurance. No approved agreement for actual patient information is configured. The hackathon configuration synthesizes complete authoritative Agent replies under the policy above, with device/text fallback on provider failure. There are no voice-reference uploads, cloning or paid fallback. English, Urdu, Roman Urdu and mixed text preservation are mocked; pronunciation, native audio, latency and live provider behavior remain unverified.

Provider HTTP calls disable redirects and environment proxies, apply timeouts, bound response sizes and do not expose raw error bodies. Fish quota, rate, model, timeout, disabled and audio-limit failures request device TTS. Active playback cancellation clears queued audio. Device TTS pauses cloud recognition until explicit acknowledgement/resume.

Official references: [LiveKit Deepgram plugin](https://docs.livekit.io/agents/models/stt/deepgram/), [Deepgram language/model support](https://developers.deepgram.com/docs/models-languages-overview), [Fish native TTS API](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech), [LiveKit sessions](https://docs.livekit.io/agents/logic/sessions/), [LiveKit audio nodes](https://docs.livekit.io/agents/logic/nodes/). Installed SDK source was also inspected for the exact pinned interfaces.

## Version 1 protocol and Flutter integration

Worker topic: `sehatmate.voice.v1`; client control topic: `sehatmate.voice.control.v1`. Envelopes contain `v: 1`, `type`, `voiceSessionId`, `epoch`, monotonically increasing `seq`, and `turnId` when applicable. Client sequence numbers are independent of Worker sequence numbers. Worker events are limited to 12,000 JSON bytes; incoming controls to 1,024 bytes. Reject stale epochs and repeated sequence numbers; deduplicate receipt/playback IDs on the client too.

| Event | Payload/purpose |
|---|---|
| ready | language; reconnection can include requiresResume |
| transcript_interim / transcript_final | text; only final completed turn has a turnId |
| processing | backend turn is underway |
| agent_result | exact result, or owned receipt-fetch instruction for a large result |
| awaiting_confirmation / awaiting_clarification | backend response requires existing authoritative flow |
| speaking / playback_complete | policy-authorized cloud playback and playbackId |
| interrupted | current playback canceled; committed actions are unaffected |
| recovering | sanitized code, explicit recovery required |
| fallback_required | component, code, requiredTransport, requiresEpochTransfer; TTS may include deviceTts `{text, playbackId}` |
| disconnected | session closed |

Controls allow only `resume`, `mute`, `stop`, `interrupt`, `playback_complete`, `manual`, `cancel`, `receipt_ready`; optional turnId/playbackId, no arbitrary action or transcript input. `receipt_ready` requires a turnId and reads the existing owned completed receipt through the delegated backend GET. It never submits a turn or accepts client reply text. Completed and pending reads are deduplicated; stop can cancel audio while preserving the authoritative result. Device playback completion requires a nonempty outstanding matching playbackId. Explicit mute, stop and manual controls interrupt output as well as pausing input; a physical microphone track mute pauses input only. Unmuting alone never rearms recognition. A current-epoch explicit resume still requires an available unmuted authorized track.

Flutter pins `livekit_client` 2.13.0. The authenticated application owns one companion and Agent session across route navigation. Start is explicit; backgrounding, logout and account replacement end audio and invalidate pending work. Worker identity and active turn ID come from the authenticated session binding. Audio subscriptions and reliable controls target only that Worker. Lost processing events are recovered by owned receipt GET before handoff or reconnect; uncertain actions are never automatically resubmitted. Completed manual turns request receipt-based Worker speech using the canonical backend turn ID. Optional device recognition transfers ownership to a new epoch; optional device speech keeps cloud recognition paused until the matching playback acknowledgement. UTF-16 suffix offsets preserve partial Fish playback without repeating the spoken prefix. Fish speech leaves the microphone available for VAD interruption with SDK echo cancellation configured; actual device echo cancellation remains unverified.

STT fallback requests `requiredTransport: device` and `requiresEpochTransfer: true`. Flutter must first use Phase 2A's authenticated transport switch, obtain the new epoch, then submit device-STT turns through the owned user API. Do not submit device turns using a stale Worker epoch. Backend failure requests manual recovery; never infer action success or repeat an ambiguous mutation.

Shutdown shares one close task across callers, drains in-flight control/recognition work, stops playback, ends the backend session, closes audio/HTTP resources and disconnects. Teardown remains independent when final data publication fails. If the scoped end request is unavailable, backend fixed expiry/cleanup remains the final release mechanism.

## Remaining live validation

Use a separate persistent Python 3.12 service or container with supported native RTC/PyAV libraries, CA roots, outbound HTTPS/WebSocket and LiveKit media connectivity. A PHP/shared-web hosting process is insufficient; confirm Hostinger plan supports a persistent Python process or use a separate Worker host. This phase makes no hosting changes. Existing Phase 2A schema/configuration must be verified on an authorized non-production database before staging integration; no migration was run here.

No authorized Linux/container runtime or disposable MySQL is currently available. Remaining validation needs native Worker startup, isolated schema migrations and transactional tests, staged LiveKit dispatch/claim/renew/end, and physical-device microphone, language, interruption and lifecycle checks. Fish account/free-model availability and Deepgram account eligibility must be checked without model substitution before live use. Real voice latency, mixed-language accuracy, account quotas and full E2E behavior remain unverified. No deployment, production credentials, production database, commit or push was changed. Later capabilities and proactive conversation milestones are outside the current integration scope.

## Authorized Linux launch (operator-run, not executed here)

Prerequisites: Linux amd64 with Docker Engine (or Python 3.12.14 and a venv); outbound HTTPS/WSS, DNS/CA trust and LiveKit media/TURN connectivity; a dedicated environment file outside the repository/image; the same LiveKit project and Worker auth key as an authorized non-production Node backend; that backend must expose its scoped user/internal voice routes with Agent/voice flags enabled and an isolated migrated MySQL database. Never use the Hostinger production database to validate this migration.

The image installs CA roots, PortAudio and C++ runtime support, installs only pinned binary wheels, runs `pip check` and imports PyAV/RTC/Agents/Deepgram at build time, then runs as UID 10001. `worker.env.example` is a names/defaults template, with no secrets. Set every blank required value before using it. The configuration table above gives all required and optional variable names; `LIVEKIT_AGENT_NAME_OVERRIDE` must be omitted or exactly `sehatmate-voice`. Do not inject backend database/JWT/LLM/delegation/encryption credentials.

From the backend checkout on the authorized host:

```sh
docker build --platform linux/amd64 -t sehatmate-voice-worker:local ./voice-worker
docker run --rm --env-file /secure/sehatmate-worker.env sehatmate-voice-worker:local python worker.py check
docker run --name sehatmate-voice-worker --init --stop-timeout 60 \
  --env-file /secure/sehatmate-worker.env -p 127.0.0.1:8081:8081 sehatmate-voice-worker:local
```

The start command is `python worker.py start`. AgentServer serves a health endpoint on port 8081; the image checks it every 15 seconds. Check `docker inspect --format '{{.State.Health.Status}}' sehatmate-voice-worker`, `curl --fail http://127.0.0.1:8081/`, and sanitized startup output. Health does not prove provider speech or a completed Agent turn. Keep this port local/private. Graceful operator shutdown is `docker stop --time 60 sehatmate-voice-worker`: SDK drain/process deadlines are 20 seconds each, job cleanup drains pending receipts/turns and closes backend/audio/HTTP/room resources. SIGTERM delivery and actual Linux shutdown remain untested until this runtime is available.

Official references: [LiveKit server health/options](https://docs.livekit.io/agents/server/options/), [self-hosted deployment](https://docs.livekit.io/deploy/custom/deployments/). The installed 1.8.4 source was also checked for the health route and constructor options.

## Android test prerequisites and sequence

Use a physical Android device, USB debugging and an authorized executable ADB, Java 17, Flutter/Dart matching the resolved project, Android SDK/platform 37 (the existing `compileSdk`), build tools, accepted SDK licenses and the project-required NDK. The local SDK platform/build-tool directories could not be verified and ADB execution returned Access denied; no Android APK/device run is claimed. The main manifest now explicitly includes INTERNET and microphone/audio/network permissions. SDK microphone permission is requested at explicit Start; transient inactive state from a permission dialog no longer ends the session, while actual hidden/paused/detached backgrounding does.

Configure `API_BASE_URL` to the authorized HTTPS backend ending in `/api`; sign in with an existing authenticated account. Do not rely on the project's default production API URL for a test. Example operator commands in the Flutter checkout (replace placeholders):

```sh
flutter pub get
flutter devices
flutter run -d <android-device-id> --dart-define=API_BASE_URL=https://<authorized-backend>/api
```

Start Voice Mode and grant microphone access. Verify the exact claimed Worker joins, microphone publishes, interim text does not execute, final Deepgram utterance makes one stable turn, receipt/result is recovered and Fish audio plays on the device. Check conversation plus existing supported Agent responses, confirmation/clarification/navigation, automatic listening after playback, speaking interruption, mute/unmute and end. Test a network gap and late response without repeated mutations. Test logout and actual background shutdown. Resume arriving before track subscription/unmute is now remembered; unmuting alone does not resume a paused session. Use headphones first, then speaker to validate echo cancellation/interruption. No real-provider behavior, latency or pronunciation is asserted by the unit tests. [LiveKit Flutter setup](https://docs.livekit.io/transport/sdk-platforms/flutter/), [Flutter lifecycle states](https://api.flutter.dev/flutter/dart-ui/AppLifecycleState.html).
