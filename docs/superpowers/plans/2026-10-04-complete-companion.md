# Complete companion implementation plan

> Use subagent-driven-development for scoped components. No commits, deployment, production credentials or database access.

Goal: Connect the existing Worker/backend to app-scoped Flutter voice, extend authoritative application capabilities and add state-based foreground check-ins/background reminders.
Spec: user attachment 267967ed-50c9-46bd-ad31-58493c851707/Pasted text.txt; reuse Phase 1, 2A and 2B-1.

- [x] A: Authenticated session/receipt-bound full Agent speech policy and native Fish text, available to every account. Tested exact text, binding, budgets and no paid fallback. Live provider validation remains pending.
- [ ] A: Flutter official pinned LiveKit SDK; app-scoped VoiceCompanionController, authenticated session API, targeted envelopes, continuous conversation, receipt reconciliation, shared Agent state, navigation, mute/manual/foreground teardown, device fallback. Unit/widget tests plus analyze.
- [ ] A: Integrate and verify all available mocked pipeline checks before extending capabilities. Live/native blockers do not prevent independent tested work.
- [ ] B: Map actual services/navigation; extend closed registry and confirmation drafts for supported features. Extract shared domain functions only where necessary; preserve ownership/clinical constraints. Verify each addition and existing Agent regressions.
- [ ] C: Authoritative upcoming/missed task monitoring, bounded foreground check-ins, reminder action context, local notification scheduling/permission fallback, explicit microphone consent and lifecycle controls. Test recurrence/follow-up/no-response behavior.
- [ ] D: Cross-component regressions/review, available disposable DB/container/native smoke checks, real-device/provider test inventory and honest readiness report.

Review focus: account logout/mid-request callbacks; stale epoch/sequence and duplicate playback; uncertain mutation during handoff; verified medical timing immutability; notification dismissal/no response never imply task completion; no background microphone or client-controlled speech policy.

Ownership: Flutter implementer owns lib/features/agent/voice, app.dart, relevant Agent screen integration/pubspec and tests. Worker implementer owns Python and Node speech policy only. Root integrates backend actions/proactive work after milestone A. Agents preserve all existing uncommitted work and coordinate overlapping files before editing.
