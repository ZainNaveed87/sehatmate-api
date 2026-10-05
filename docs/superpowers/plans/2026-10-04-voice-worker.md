# Phase 2B-1 Worker implementation plan

> Execute inline with executing-plans and test-driven-development. Do not commit or deploy.

**Goal:** Implement the separate Python audio Worker specified in the user's Phase 2B-1 attachment.
**Architecture:** Official LiveKit Agents job lifecycle plus RTC microphone/audio-source primitives and Deepgram SpeechStream endpointing events; no LLM/AgentSession conversation memory. Finalized turns call the existing Node bridge once, then recover only through receipts. Fish accepts only a backend-provided fixed phrase catalog; all other replies become authenticated, targeted device-TTS events.
**Spec:** User attachment `4aebbe8e-34d6-4c54-8392-bc9e8f10e329/Pasted text.txt`, Phase 1 audit and PHASE_2A_VOICE_BACKEND.md.

- [x] Verify pinned official Python SDK/plugin interfaces and install in isolated development venv under work/.
- [x] Write failing Python tests for configuration, JWT bridge, transcript finalization, recovery and provider privacy.
- [x] Implement voice-worker/sehatmate_voice/{config,bridge,events,deepgram_adapter,fish_adapter,session,runtime}.py and entry point.
- [x] Make only necessary Node compatibility additions: claim authorized participant/deadline/catalog, scoped Worker termination, data controls grant. Test existing contracts.
- [x] Validate SDK transmitted opt-out URL, native Fish request body/model, mute/interruption/reconnect/cleanup and targeted events using mocks.
- [x] Pin direct dependencies and resolved lock, add development/container instructions and event protocol.
- [x] Run Python tests, relevant Node regressions, syntax checks and independent review. Fix actionable issues.
- [x] Deliver implementation report with runtime/provider/DB gaps and Phase 2B-2 prerequisites, then stop.

Existing Phase 2A uncommitted files and all Flutter changes must remain intact. No real provider credentials, production database, Hostinger operations, patient data or audio persistence. Provider failures stop audio before device fallback; no mutation POST retry. SDK logging must not expose transcripts/provider response bodies. Limits and backend deadline apply to all job resources. Listening resumes only after an explicit current-epoch client control and user microphone availability.


Verification limitation: native SDK import is blocked by Windows application control (PyAV DLL). 36 mocked/source-contract Python tests and backend regressions passed; native RTC, provider E2E and Docker deployment remain unverified.
