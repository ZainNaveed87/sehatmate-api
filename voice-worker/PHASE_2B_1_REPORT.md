# SehatMate Phase 2B-1 implementation report

Historical snapshot: the fixed-generic Fish limitation below is superseded by full authenticated Agent-reply speech, without an account allowlist. `README.md` documents the current integration, offline native preflight and remaining live-test prerequisites. Statements below describe the original phase only.

Date: 2026-10-04. Implemented in `C:/Users/Zain/OneDrive/Desktop/sehatmate_api/voice-worker/`. Phase 2B-1 implementation and mocked verification are complete. Native SDK startup and live-provider E2E remain unverified. Phase 2B-2 requires explicit approval.

## Components and files

Created `worker.py`, `sehatmate_voice/__init__.py`, `config.py`, `events.py`, `bridge.py`, `http_client.py`, `deepgram_adapter.py`, `fish_adapter.py`, `session.py`, `runtime.py`; `requirements.txt`, `requirements.lock.txt`, `.gitignore`, `.dockerignore`, `Dockerfile`, `README.md`, this report; and five test modules: `test_worker.py`, `test_bridge_providers.py`, `test_session.py`, `test_microphone.py`, `test_sdk_contracts.py`. The inline implementation plan is `docs/superpowers/plans/2026-10-04-voice-worker.md`.

Small compatibility changes extend the existing uncommitted Phase 2A files: `agent/agent_voice_config.js` exports the fixed phrase catalog; `services/voice_session_service.js` returns authorized participant/deadline/provider/catalog fields and revalidates Worker termination inside the operation transaction; `agent/agent_voice_routes.js` adds scoped internal DELETE; `services/livekit_voice_provider.js` permits room-scoped client data controls. Tests updated: `voice_backend_test.js`, `voice_storage_sdk_test.js`. Prior Phase 2A code remains present. No Flutter code was changed; its three pre-existing generated-file modifications remain.

## Pinned dependencies and design

Direct pins: Python 3.12.14, livekit-agents 1.8.4, livekit-plugins-deepgram 1.8.4, aiohttp 3.13.3, PyJWT 2.15.1. Entire resolved environment is pinned in `requirements.lock.txt`, including livekit 1.1.20, livekit-api 1.2.1, livekit-protocol 1.1.27 and av 19.0.1. The SDK brings transitive packages, but the Worker does not configure an LLM or invoke its planner APIs.

Official AgentServer registers `sehatmate-voice`; thread execution preserves shared concurrent-job accounting. Connection disables automatic subscription. Dispatch metadata is only an opaque session ID, recording disabled. Initial HTTPS claim authenticates a 60-second JWT signed by the existing separate Worker claim key; room/job/Worker identity is verified by the existing backend. The claim identifies the exact user microphone and response destination. Delegation renews every 25 seconds and before expiry. Every backend request verifies the backend-signed session/epoch/job delegation server-side; the Worker never receives its signing secret or a user JWT.

Streaming Deepgram Nova-3 handles 16 kHz mono, interim/final segments, VAD and end-of-speech. Only completed final turns execute the existing coordinator. English `en` and Urdu `ur` are supported configurations. There is no Roman Urdu locale or assurance of code-switch accuracy. No medication correction, numeral conversion, dictation or reasoning is added. Installed official plugin code was inspected and its actual WebSocket URL-building methods executed against a fake connection: `mip_opt_out=true` is transmitted. This is source-level integration evidence, not a native or live-provider test.

Automatic STT retries are disabled to discard partial words across gaps. Recognition failure stops cloud audio before requesting device STT; quota/rate/unavailable codes are sanitized. Local utterance and session limits apply. Silence uses the backend/local idle cap.

Fish native HTTPS API uses Bearer authentication, explicit `model: s2.1-pro-free` header, public preset ID and PCM 16-bit mono/24 kHz. Only exact fixed phrases approved by both the backend and local catalog can reach Fish. Output is buffered within a configured byte/duration limit, then published as cancellable RTC audio. No patient-specific Agent reply, reference upload or clone is submitted. Missing/rejected/free-model failures never substitute a paid model. All other authorized replies request future client device TTS. Fish POST is never retried.

## Bridge, realtime and fallback contracts

Claim: `POST /internal/agent/voice-sessions/:id/claim`; finalized turn: `POST .../turns` with stable `{epoch, turnId, message}`; recovery: `GET .../turns/:turnId`; termination: scoped `DELETE /internal/agent/voice-sessions/:id`. An uncertain submission polls the receipt and never repeats the action POST. `processing`, `completed`, `recovery_required`, `stale`, `receipt_expired` are handled. The existing Node Agent remains the sole action authority.

Exact Agent results preserve reply, navigation, action status, language, confirmation and clarification. Oversized results emit the existing owned user receipt path rather than declaring a completed action uncertain. Flutter later fetches that receipt with its own authentication.

Version 1 targeted reliable event topic `sehatmate.voice.v1` supports ready, interim/final transcript, processing, agent_result, speaking, playback_complete, interrupted, fallback_required, recovering, disconnected and awaiting_confirmation/clarification. Envelope includes voiceSessionId, epoch, monotonic sequence, turnId where appropriate. It excludes credentials. Controls use `sehatmate.voice.control.v1`; allow only resume/mute/stop/interrupt/playback_complete/manual/cancel. The Worker checks participant identity, session, epoch, sequence, size and closed field set. Full protocol/examples and payload definitions are in README.

STT fallback includes component/code, `requiredTransport: device`, `requiresEpochTransfer: true`: Flutter must perform the existing authenticated transport switch before device turns. TTS fallback includes authorized `deviceTts: {text, playbackId}` and pauses STT until explicit valid acknowledgement/resume. Backend uncertainty requests manual recovery and blocks new turns. Reconnection pauses input and requires explicit resume. Unmuting alone does not restart recognition. Speech interruption cancels output without repeating backend calls or committed actions. Duplicate receipts do not replay speech.

Cleanup drains independent resources even if final event publication fails; shared close completion avoids canceling the original termination request. Tests cover overlapping recognition supervisor retirement, cancellation, disconnect send failure and malformed playback acknowledgement. Failed backend end still relies on the existing fixed expiry/cleanup as a final safeguard.

## Required environment names and limits

Required: `VOICE_WORKER_ENABLED`, `VOICE_BACKEND_URL`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `VOICE_WORKER_AUTH_KEY`.

Provider settings: `DEEPGRAM_API_KEY`, `DEEPGRAM_ENABLED`, `DEEPGRAM_DISABLED`, `VOICE_STT_LANGUAGE`; `FISH_API_KEY`, `FISH_ENABLED`, `FISH_DISABLED`, `FISH_TTS_MODEL`, `FISH_REFERENCE_ID`. Optional Agent override accepts only `LIVEKIT_AGENT_NAME_OVERRIDE=sehatmate-voice`.

Limit defaults: `VOICE_MAX_SESSION_SECONDS=600`, `VOICE_IDLE_TIMEOUT_SECONDS=60`, `VOICE_WORKER_MAX_CONCURRENT_JOBS=1`, `VOICE_PROVIDER_RETRIES=1`, `VOICE_PROVIDER_TIMEOUT_SECONDS=15`, `VOICE_RECEIPT_POLL_SECONDS=120`, `VOICE_MAX_AUDIO_SECONDS=30`, `VOICE_MAX_TTS_REQUESTS=8`, `VOICE_MAX_TTS_SECONDS=12`. README lists exact valid ranges. Backend deadline/usage/idle limits can shorten these ceilings. Retry setting governs safe registration/claim and receipt retrieval, never audio/action replay.

Forbidden environment: backend JWT secret, database password, OpenRouter key, delegation signing secret and receipt encryption key. Secret values are absent from source/docs; no production credentials were read or modified. SDK logging/telemetry is suppressed to avoid transcript/provider-body disclosure. No audio persistence is added.

## Executed verification

- Isolated Python 3.12 virtual environment dependency install succeeded; `python -m pip check`: no broken requirements.
- `python -m unittest discover -s tests -q`: **36 passed**, zero failures. Includes mocked provider/backend/RTC lifecycle, JWT/bindings/delegation expiry and epochs, fragmented HTTP, uncertainty receipts, privacy/free model, bounded PCM, cancellation, no interim actions, duplicate turns/playback, mute-before-late-result, shutdown and installed-SDK source contracts.
- `python -m compileall -q worker.py sehatmate_voice tests`: passed.
- `node --test voice_config_test.js voice_backend_test.js voice_storage_sdk_test.js`: **31 passed**, zero failures/skips. Includes new claim/control/scoped-end behavior and stale Worker termination race.
- Eight additional executed suites passed: Agent foundation (41), Phase B (51), Phase D (53), Phase E (68), Phase F (24), turn language (22), services boundary (32), and language support (suite does not report count). Together with voice tests, **322 individually counted backend assertions/tests**, plus language support.
- Independent reviewer findings were corrected and regression-tested. `git diff --check` passed; Git emitted only existing LF/CRLF conversion notices. Git status checked for both repositories; no commits or pushes.

## Unverified behavior and hosting

Full `livekit.agents` import fails on this Windows machine: **application control blocks a PyAV native DLL**. No policy bypass was attempted. SDK constructor/source inspection and fake transport tests cannot prove native Worker startup, real registration/RTC audio, or OS/thread lifecycle behavior. Those require an authorized supported runtime.

No real LiveKit, Deepgram or Fish session was run; no live API credits or patient data used. Free-model account availability, provider quotas/billing/opt-out account conditions, network latency, transcription accuracy and actual interruption E2E are unverified. No production database inspection/migration, Hostinger setting change, deployment, container build or Flutter implementation occurred. Phase 2A schema readiness remains a staging prerequisite.

Hosting requires a persistent Python 3.12 process or Linux container, supported native RTC/PyAV dependencies, CA certificates, outbound HTTPS/WebSocket and LiveKit media connectivity, an isolated service environment, process health monitoring and graceful shutdown. Confirm the Hostinger plan supports this process; use a separate host if needed. Dockerfile is provided for future validation, not deployed.

## Exact prerequisites for Phase 2B-2

1. Explicit owner approval to begin Phase 2B-2.
2. Authorized staging runtime passes full SDK import/startup and synthetic LiveKit room/dispatch/claim/renew/end tests; existing Phase 2A schema and feature configuration verified on non-production infrastructure.
3. Isolated Worker environment receives only permitted credentials; provider opt-out/account cost and exact Fish free-model/public-preset availability verified.
4. Flutter implements the documented topics/envelopes, destination/session/epoch/sequence checks, turn/playback deduplication, mute/stop/manual/cancel and explicit resume, plus oversized receipt retrieval.
5. Device STT fallback uses the existing backend transport switch/new epoch; device TTS acknowledges the exact outstanding playback ID and respects muted/manual/disconnected state.
6. Synthetic staged tests verify English/Urdu limitations, authoritative Agent navigation/confirmation/clarification, microphone filtering, interruption, disconnect, provider failures and no duplicate actions/playback before any wider rollout.

Primary references: [LiveKit Deepgram](https://docs.livekit.io/agents/models/stt/deepgram/), [Deepgram models/languages](https://developers.deepgram.com/docs/models-languages-overview), [Fish native TTS](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech), [LiveKit nodes](https://docs.livekit.io/agents/logic/nodes/). Exact interface checks used the installed pinned SDK source. Implementation remains uncommitted; stop here awaiting explicit approval for the next phase.
