# SehatMate Phase 2.1 Agent Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task after human review. Steps use checkbox (`- [ ]`) syntax for tracking. Native execution is recommended because the shared contracts and pre-existing dirty files require coordinated edits.

**Goal:** Repair the seven reproduced Agent accessibility, presentation, navigation, language, conversational creation, and guided-UI failures without starting Phase 3.

**Architecture:** Retain Node as the single Agent authority and Flutter as the deterministic semantic executor. Evolve the existing root account-scoped host, route observer, session JSON, registered actions, confirmations, and receipts. Add separate app-owned walkthrough state and server-owned conversational task state; neither bypasses the existing action safety policy.

**Tech Stack:** Existing Flutter/Dart, Provider, Navigator, LiveKit voice transport, Node.js, mysql2, existing Agent planner/grounder and care-plan service. No new routing, transliteration, ASR, or provider dependency.

**Spec:** User-authored request at [Pasted text.txt](C:/Users/Zain/.codex/attachments/c74cbe6f-ba0c-4368-be26-774d83dafe3e/Pasted%20text.txt). This plan implements that supplied written spec. Product implementation has not begun; plan review and execution-method selection remain pending.

## Global Constraints

- This is NOT Phase 3. Proactive care, autonomous check-ins, and background Agent work are out of scope.
- Flutter root (`F` below): `C:/Users/Zain/OneDrive/Desktop/sehatroute_flutter`.
- Backend root (`B` below): `C:/Users/Zain/OneDrive/Desktop/sehatmate_api`.
- Paths under each task are exact paths relative to the stated repository root.
- Do not stage, commit, push, deploy, reset, restore, checkout, clean, stash, or modify production DB.
- Preserve existing unrelated/local dirty changes. Baseline: 38 Flutter files and 26 backend files captured with contents and SHA256 in `C:/Users/Zain/Documents/Codex/2026-10-04/files-pasted-by-the-user-sehatmate/phase_21_preexisting_baseline.json`.
- Backend baseline HEAD: `d1c8d1f4b18c1395d1502368ee12eb079f35fa7d`; Flutter baseline HEAD: `f5a662770637da20c81816f10b0f283c5790f3b7`.
- Do not modify Python LiveKit Worker, Deepgram/Fish configuration, credentials, or existing voice transport contracts. No directly necessary Worker change has been identified.
- Consequential actions retain Agent plan → registered action → required confirmation → executor → receipt. No pixel clicking, OCR, autonomous clinical changes, or direct model UI mutation.
- Canonical selected language codes remain `en`, `ur`, `roman_ur`; Roman Urdu speech locale remains `ur-PK`.
- Keep existing bounded context: outer context ≤4096 UTF-8 bytes, ≤20 targets, ≤20 actions, ≤4 operations.
- One account-scoped Agent conversation/controller/host. Minimize must preserve conversation, composer, scroll, workflow, and active realtime transport.
- Care-plan creation collects only the actual required name/title: shared backend normalization and 2–80 Unicode codepoints. The existing real service creates `status='draft'`, `setup_step='upload'`. No invented clinical fields.
- Live providers, production DB, and Android acceptance are not validated by mocked tests. Existing lack of an authorized disposable MySQL/runtime environment remains a live-test limitation.

## Review Focus

1. Auth/logout changes while navigation, confirmation, or memory review is awaiting: reject stale work, close only owned surfaces, and leak no previous-account state (Tasks 2, 3, 7).
2. Existing destination below an unsaved form or same page with different entity/focused arguments: reuse only safely, never silently discard input or deduplicate distinct entities (Task 2).
3. Urdu labels, long names, large text, keyboard, small landscape: preserve byte bounds and complete option groups without losing the focused capability or overflowing chat (Tasks 3, 4).
4. Correction/concurrent confirmation/lost response during care-plan creation: invalidate old confirmation and return a committed receipt without a second insert (Task 6).
5. Walkthrough target removed or navigation redirected during reveal: pause/fail honestly, do not advance or claim success, and never save a questionnaire answer as a walkthrough step (Tasks 2, 5).

---

## Confirmed Causes and Design Decisions

| Failure | Inspected cause | Repair |
|---|---|---|
| 1. Global access/navigation | Root host already exists, but launcher is AppShell-local; document viewer lacks it. Route/context/Agent maps disagree; navigation always pushes. | Root launcher plus one semantic destination registry and account-owned coordinator. |
| 2. Bulky popup | Boolean presentation, roughly 78% height, duplicate headers/cards; closing unmounts composer/scroll; every controller update scrolls to end. | Four modes, persistent embedded chat, 45% compact draggable sheet, single toolbar and controlled message scroll. |
| 3. Language drift | Turn language deliberately prefers detected input; continuation uses stale session language; English confirmation/errors bypass localization. | Authenticated stored preference chooses response language across all paths, with shared client persistence barrier. |
| 4. Chip duplicates | Chip is Review Agent Memory, opening an unguarded modal sheet; chat stays above it. Separate route handler also pushes duplicate pages. | Owned single-flight memory surface; disable while open and minimize actual chat first. |
| 5. Creation workflow | Only task-outcome/reminder drafts exist; no create-care-plan capability or typed workflow. | Closed reusable task registry/reducer; title collection, corrections, explicit confirmation, transaction-backed registered creation. |
| 6. Generic explanations | Settings/Care Plans have main-only adapters; zero-tool help discards UI metadata; overflow falls back to main-only; no walkthrough state. | Real anchors/catalogs, bounded focused windows, metadata-grounded help and deterministic walkthrough. |
| 7. Chat blocks guidance | Visual paths minimize voice presentation, leaving chat visible. | One shared visual gateway enters guided mode before navigation/reveal/explanation/highlight. |

Raw ASR remains unchanged as action input and displayed original transcript. Optional transliteration is deferred: the spec says normalization is preferable, and no verified meaning-preserving medical normalization exists here. Roman Urdu Agent replies remain mandatory. Do not relabel Urdu-script ASR as normalized Roman Urdu.

## Task 1: Selected-Language Authority and Shared Turn Barrier

**Files — B modify:**
`agent/agent_turn_language.js`, `agent/agent_core.js`, `agent/agent_workflow.js`, `agent/agent_profile_language.js`, `agent/agent_draft_tools.js`, `language_support.js`.

**Files — F modify:**
`lib/localization/language_controller.dart`, `lib/localization/app_strings.dart`, `lib/features/agent/controllers/agent_controller.dart`, `lib/features/agent/services/agent_service.dart`, `lib/features/agent/screens/agent_screen.dart`.

**Tests — B modify:** `agent_turn_language_test.js`, `agent_profile_language_test.js`, `agent_workflow_test.js`, `language_support_test.js`; **B create:** `agent_selected_language_test.js`.
**Tests — F modify:** `test/language_controller_test.dart`, `test/agent_controller_test.dart`, `test/agent_localization_test.dart`, `test/voice_language_switch_test.dart`.

**Interfaces:**
- Consumes existing authenticated profile reader and `LanguageController.prepareVoiceLanguage(AppLanguage)`.
- Produces `resolveAgentTurnLanguage({message,lastTurnLanguage,profileLanguage})` with the existing return type but authoritative normalized `profileLanguage`; detection remains non-authoritative metadata.
- Produces `Future<bool> LanguageController.prepareAgentLanguage(AppLanguage selected)`; existing voice preparation delegates to the same persistence/sync barrier.
- Shared controller receives an async preparation callback; no text or voice turn is sent before preference synchronization succeeds. A failed barrier is a localized failure, not an English/default-language turn.
- Service/controller expose safe structured failure codes for presentation; arbitrary exception messages are not user copy.

- [ ] Add failing tests: `roman_ur` + English-ish/Urdu-script ASR, English UI/tool labels, clarification, confirmation, fallback and continuation all select Roman Urdu; `en` and `ur` switches retain session/draft. Assert `prepareAgentLanguage` waits for the existing write and failed sync sends zero turns.
- [ ] Run `node --test agent_turn_language_test.js agent_profile_language_test.js agent_workflow_test.js language_support_test.js agent_selected_language_test.js`; run Flutter language/controller/localization focused tests with `--no-pub`. Confirm failures reproduce the old policy/barrier.
- [ ] Change selection precedence, reread selected profile for continuations, localize existing deterministic confirmation/error copy, and wire the shared preparation callback. Keep raw transcript and provider language safety validation unchanged.
- [ ] Rerun these tests plus `test/voice_language_switch_test.dart`; require test assertions to pass and record process exit independently.

## Task 2: Semantic Destinations and Honest Deduplicated Navigation

**Files — F create:**
`lib/features/agent/navigation/semantic_route_registry.dart`, `lib/features/agent/navigation/agent_navigation_coordinator.dart`.

**Files — F modify:**
`lib/core/app_routes.dart`, `lib/core/app_router.dart`, `lib/features/agent/models/agent_context.dart`, `lib/features/agent/models/agent_navigation.dart`, `lib/features/agent/navigation/agent_navigation_handler.dart`, `lib/features/agent/copilot/copilot_navigation_observer.dart`, `lib/screens/library_screens.dart`, `lib/screens/document_viewer_screen.dart`.

**Files — B modify:** `agent/agent_navigation_registry.js`, `agent/agent_planner.js`.
**Tests — F modify:** `test/agent_navigation_test.dart`; **F create:** `test/agent_navigation_coordinator_test.dart`, `test/semantic_route_registry_test.dart`.
**Tests — B modify:** `care_context_navigation_test.js`, `agent_ui_planner_test.js`.

**Interfaces:**
- Produces `SemanticDestination {id,routeName,arguments,identityKey,screenId}` and `SemanticRouteRegistry.resolve(AgentNavigation): SemanticDestination?`.
- Produces `NavigationOrigin {accountGeneration,agentSessionGeneration,screenVersion?}` and `Future<NavigationResult> AgentNavigationCoordinator.navigate(AgentNavigation,{required NavigationOrigin origin})`.
- `NavigationOutcome`: `opened`, `alreadyActive`, `reused`, `rejected`, `stale`, `redirected`, `unavailable`, `timedOut`, `unsavedConflict`; success only for the first three after observer/destination confirmation.
- Coordinator consumes injected `Future<void> beforeVisualAction()` and one observer; root Task 3 supplies guided mode. Existing handler delegates to the same root instance, not per-handler locks.
- Observer tracks PageRoutes and typed destination identities separately from PopupRoutes; exposes current destination/stack and resolution notification. Completion is destination readiness, not `pushNamed`'s eventual pop.

Registered destinations cover actual AppRouter pages: home; care_plans; care_plan_new/upload/review/detail; calendar (`today` legacy alias); family (`family_care` alias), family_member_new/detail/care_plans; progress; documents/document_viewer; care_gaps/detail; simulation; reality_check; doctor_questions; simple_care; teach_back; notifications; profile; settings; routine_settings. Preserve typed care-flow, focused-question, plan-detail, upload/review, calendar, family and document arguments. Reject unsupported invented family subpages, arbitrary route strings, malformed/missing identifiers, and unauthorized entity arguments. `/agent` becomes a compatibility entry to the existing root presentation; public/auth/onboarding routes expose no Agent entry.

- [ ] Add failing tests for full actual-route coverage/aliases, active-route no push, identical in-flight coalescing, serialized distinct commands, safe stack reuse and Back, entity/focused-argument differences, unsaved-form conflict, auth redirect, missing registration, timeout, stale account/session cancellation and released busy state.
- [ ] Run new navigation tests plus existing navigation/backend planner tests; confirm current unconditional pushes and false receipts fail assertions.
- [ ] Implement registry/coordinator/observer and compatibility handler. Give document viewer real route metadata. One push maximum per request, verify resolved screen/entity, and return honest outcomes. Guard navigation reuse across edited forms rather than discarding their input.
- [ ] Rerun tests; confirm the route Future completes at destination resolution without popping it.

## Task 3: Persistent Global Host, Compact Sheet, and Memory Single Flight

**Files — F modify:**
`lib/app.dart`, `lib/widgets/app_shell.dart`, `lib/features/agent/agent_entry.dart`, `lib/features/agent/copilot/copilot.dart`, `lib/features/agent/copilot/copilot_host.dart`, `lib/features/agent/copilot/copilot_memory_review.dart`, `lib/features/agent/screens/agent_screen.dart`, `lib/features/agent/widgets/agent_header.dart`, `lib/features/agent/voice/voice_companion_scope.dart`.

**Tests — F modify:** `test/copilot_global_host_test.dart`, `test/copilot_lifecycle_test.dart`, `test/copilot_memory_test.dart`, `test/agent_ui_test.dart`, `test/voice_companion_ui_test.dart`;
**F create:** `test/copilot_presentation_test.dart`.

**Interfaces:**
- Produces `CopilotMode {collapsed,compact,expanded,guided}` on existing `CopilotPresentation` with `openChat()`, `expandChat()`, `minimizeChat()`, `enterGuided(GuidanceSummary)`, `finishGuidance()`, `memoryReviewBusy`, `sheetExtent`.
- `GuidanceSummary` contains only localized status and optional registered target, not private tool results.
- Root owns the single coordinator, presentation, Agent controller, walkthrough owner (Task 5), and realtime controller. Task 2 hook invokes `enterGuided`, unfocuses and waits for layout.
- Root memory opener owns one Future/route, sets busy until `finally`, minimizes chat and preserves existing account-surface cleanup.

- [ ] Add failing widget tests for one root pill on AppShell and document routes, guest/auth/onboarding exclusion, all four modes, retained composer/history/scroll and transport identity, repeated memory taps yielding one PopupRoute, account invalidation, and compact multiple-message visibility.
- [ ] Add geometry tests with keyboard, small landscape, large text, Urdu RTL and reduced motion; assert reachable composer and zero layout exceptions. Test older-history scrolling is not moved by unrelated controller notifications.
- [ ] Run presentation/global-host/memory/Agent/voice focused tests and confirm old 78%/unmount/modal behavior fails.
- [ ] Move launcher to root authenticated host; remove only redundant page launcher. Keep one embedded chat mounted (hidden state ignores pointer/focus), one header/compact language selector, and one DraggableScrollableSheet-controlled message scroll. Initial compact extent is 0.45 of keyboard-adjusted safe viewport; expanded is near-full within safe bounds; composer is outside message scroll. Follow new messages only when appropriate.
- [ ] Unify minimized realtime controls into root pill, preserve all mute/end/interruption/reconnect behavior, and guard memory review without replacing it with Settings navigation. Rerun focused tests.

## Task 4: Real Screen Catalogs and Bounded Context Windows

**Files — F create:**
`lib/features/agent/copilot/copilot_screen_catalog.dart`, `lib/features/agent/copilot/copilot_context_window.dart`, `lib/features/agent/copilot/adapters/settings_copilot_adapter.dart`, `lib/features/agent/copilot/adapters/care_plans_copilot_adapter.dart`.

**Files — F modify:**
`lib/features/agent/copilot/copilot.dart`, `lib/features/agent/copilot/copilot_screen_adapter.dart`, `lib/screens/support_screens.dart`, `lib/screens/care_plans_screen.dart`, `lib/screens/reality_check_screen.dart`, `lib/screens/care_gap_screens.dart`.
**Files — B modify:** `agent/agent_ui_protocol.js`.

**Tests — F create:** `test/copilot_settings_adapter_test.dart`, `test/copilot_care_plans_adapter_test.dart`, `test/copilot_context_window_test.dart`; **F modify:** `test/copilot_protocol_test.dart`, `test/copilot_reality_check_test.dart`, `test/copilot_care_gap_test.dart`, `test/settings_screen_test.dart`.
**Tests — B modify:** `agent_ui_protocol_test.js`.

**Interfaces:**
- Produces `CopilotScreenDefinition {screenId,routeId,revision,targets,walkthroughOrder,keyActions}`; full catalog is local only.
- `CopilotTarget` gains strict optional `sectionId`, bounded `help`, safe scalar `value`, `visible`, `enabled`; no account email/name, medical notes, arbitrary objects or callback names.
- Produces `CopilotScreenContext buildContextWindow(CopilotScreenDefinition,{String? focusedTargetId,WalkthroughSummary? walkthrough})`; atomically includes focused target/actions and complete option groups, then key controls within existing UTF-8/count limits.
- Adapter no longer appends redundant global route actions to every rich screen and no longer silently replaces all controls with main-only context on overflow.
- Settings persisted action IDs select explicit known values; immutable local and server policies require confirmation. Closures return verified outcomes instead of swallowing errors as success.

Actual Settings anchors: language, Simple Care switch, conditional Simple Care link, Calendar/reminders link, sign-out, Documents, Care Plans, Family, About and Safety explanations. No theme/biometrics/cloud-sync controls. Actual Care Plans anchors: create, active/draft/completed tabs, select/clear all, selected/section deletion, retry, bounded real card open/select/menu/complete/delete. Creation form name/back/Continue: Continue is consequential because it creates real data. Per-card capabilities reflect guest/permission/status/loading state.

- [ ] Add failing adapter tests for every actual meaningful control, conditional/loading/error/guest states and absent invented controls. Assert registered mutations require confirmation and failure produces failure receipt.
- [ ] Add byte-budget tests with long Urdu labels/dynamic cards: ≤4096 outer bytes, ≤20/20, complete Reality Check options, focused controls preserved and deterministic windows. Test removed/disabled anchors reject.
- [ ] Run new adapters/window and existing protocol/Reality Check/Care Gaps/Settings tests plus Node protocol tests.
- [ ] Implement catalogs/anchors/windows and strict protocol extension. Keep questionnaire mutation actions separate; enforce existing Previous-save confirmation on both authorities. Replace Care Gap destination success shortcut with Task 2 verified resolution.
- [ ] Rerun focused tests; verify main-only fallback and failed-destination false success regressions are covered.

## Task 5: Deterministic Walkthrough and Metadata-Grounded Help

**Files — F create:** `lib/features/agent/copilot/copilot_walkthrough_controller.dart`.
**Files — F modify:** `lib/app.dart`, `lib/features/agent/copilot/copilot.dart`, `lib/features/agent/copilot/copilot_screen_adapter.dart`, `lib/features/agent/copilot/copilot_conflict.dart`, `lib/features/agent/screens/agent_screen.dart`.
**Files — B modify:** `agent/agent_ui_protocol.js`, `agent/agent_planner.js`, `agent/agent_semantic_routes.js`, `agent/agent_response_grounder.js`, `agent/agent_workflow.js`, `agent/agent_copilot_routes.js`, `agent/agent_copilot_store.js` (only validation/receipt changes required by the closed extension).

**Tests — F create:** `test/copilot_walkthrough_test.dart`, `test/copilot_guided_mode_test.dart`;
**F modify:** `test/copilot_workflow_test.dart`, `test/copilot_conflict_test.dart`.
**Tests — B create:** `agent_walkthrough_test.js`, `agent_screen_help_test.js`; **B modify:** `agent_ui_planner_test.js`, `agent_semantic_routing_test.js`, `agent_workflow_test.js`, `agent_copilot_integration_test.js`.

**Interfaces:**
- Consumes Task 4 catalogs/context windows and Task 2 resolved destination.
- Produces `WalkthroughState {workflowId,screenId,catalogRevision,orderedTargetIds,currentIndex,status,startedAt}` and `CopilotWalkthroughController.start/next/previous/repeat/stop/openChat/continue/explainCurrent` returning a verified `CopilotActionResult`.
- Publish exact read-only registered action kinds `walkthrough_start`, `walkthrough_next`, `walkthrough_previous`, `walkthrough_repeat`, `walkthrough_stop`, `walkthrough_open_chat`, `walkthrough_continue`; args remain `{}` and IDs must exist in published context.
- Add explicit `clearHighlight()` and sticky walkthrough reveal to registry; normal transient highlights retain existing behavior.
- Shared `AgentController.onCopilotResult` routes text and voice visual plans/legacy navigation through one gateway. Remove duplicate `voice.onResult` navigation side effect; a result with UI navigation and legacy navigation executes once.
- Explanations use bounded registered metadata as UI evidence only. Read-only narration may have zero mutation operations; target explanation still enters guided mode and resolves the target. Existing clinical grounding remains strict.

- [ ] Test deterministic order, one sticky highlight, next/previous/repeat/stop/open-chat/continue, completed stay-minimized, failed reveal/index rollback, target disappearance, route/account fences, and no questionnaire saves when saying walkthrough Next.
- [ ] Test shared voice/text gateway and auto-minimize before every navigation/highlight/focus/read/reveal/scroll, including message Open and conflict Show issue. Assert no duplicate navigation and no truthful-success receipt without resolved highlight.
- [ ] Test Node registered-screen explanations with real Settings controls, unknown/foreign action rejection, zero-tool UI grounding, selected Roman Urdu, and receipt-backed narration. A repeat at unchanged screen version is its own user action, not a forged continuation.
- [ ] Run new and affected focused tests; confirm old missing-state/minimize/grounding behavior fails.
- [ ] Implement controller and grounded routing. Reveal/scroll before highlight; advance only after verified rendered target. Manual route change pauses; stop/account change clears immediately. Persisted settings actions retain confirmation and local callbacks. Explain control use without executing it.
- [ ] Rerun focused tests; keep continuation depth/receipt validation and context bounds unchanged.

## Task 6: Server Conversational Care-Plan Workflow and Atomic Creation

**Files — B create:** `agent/agent_task_workflow.js`, `agent/agent_care_plan_tools.js`.
**Files — B modify:** `agent/agent_capability_registry.js`, `agent/agent_session_state.js`, `agent/agent_session_store.js`, `agent/agent_core.js`, `agent/agent_context_engine.js`, `agent/agent_planner.js`, `agent/agent_semantic_routes.js`, `language_support.js`, `services/agent_turn_service.js`.
**Existing service reused unchanged:** `services/care_plan_title_service.js`.
**Tests — B create:** `agent_task_workflow_test.js`, `agent_care_plan_creation_test.js`; **B modify:** `agent_session_routes_test.js`, `agent_phase_d_test.js`.

**Interfaces:**
- Produces closed `TaskWorkflow {workflowId,kind,revision,status,fields:{title?},awaitingField?,confirmationId?,expiresAt?,completedReceipt?}` under existing bounded session JSON. Kind initially `create_care_plan`; statuses `collecting`, `awaiting_confirmation`, `completed`, `cancelled`.
- `reduceTaskWorkflow({current,command,message,language,now})` validates registered `start/update/resume/cancel` and source spans; fields come from the actual utterance, never model-proposed fabricated text. Navigation/help preserves or pauses the draft, not sets title.
- Registered `create_care_plan` capability consumes `{title}` and existing authenticated `userId`; invokes `createCarePlan({db,userId,title})` with the execution transaction connection. Invalid length is rejected before registry string truncation.
- Produces `executeConfirmedTaskWorkflow({pool,userId,sessionId,confirmationId,workflowId,revision,now}): Promise<ConfirmedTaskResult>`; no client-supplied user/clinical values and no implicit confirmation.
- Atomic algorithm: lock owned active Agent session → validate pending current revision/confirmation → replay matching completed receipt if present → registered create on same DB connection → persist completed receipt/consume confirmation → commit. Any failure rolls back creation and pending-state mutation. Duplicate title is a precise failure, not fabricated success.
- Existing outcome/reminder confirmation path is preserved. Add `taskWorkflow` only to approved encrypted voice-result field allowlist; Worker already forwards full results and does not need edits.

- [ ] Add failing conversation tests: “Care plan banao” asks only name with zero inserts; “Naam Zain” supplies exact title; “Naam Zain nahi Ali rakho” replaces title/revision/confirmation; 1/81-codepoint/normalized duplicate invalid inputs fail; fabricated spans and unregistered fields reject; route/modality/language changes preserve draft.
- [ ] Add transaction-aware mock tests for no confirmation zero writes, stale old confirmation, simultaneous voice/text confirmations one insert, rollback before commit, lost-response replay same receipt/plan ID, repeated “haan” no second workflow, account/session expiry rejection and precise localized errors.
- [ ] Run `node --test agent_task_workflow_test.js agent_care_plan_creation_test.js agent_session_routes_test.js agent_phase_d_test.js care_plan_title_service_test.js`; confirm current unsupported workflow fails.
- [ ] Implement registry/reducer/strict state, active-workflow planner context and atomic confirmation executor. Title-only summary/confirmation is localized; success is emitted only after commit and navigates to registered Upload using actual returned ID.
- [ ] Rerun tests and result-allowlist tests. Mark real MySQL concurrency/rollback execution unverified until an authorized disposable DB is available; never use Hostinger production to fill this gap.

## Task 7: Shared Flutter Task Snapshot and Confirmation Presentation

**Files — F create:** `lib/features/agent/models/agent_task_workflow.dart`.
**Files — F modify:** `lib/features/agent/models/agent_response.dart`, `lib/features/agent/controllers/agent_controller.dart`, `lib/features/agent/voice/voice_companion_controller.dart`, `lib/features/agent/screens/agent_screen.dart`, `lib/localization/app_strings.dart`.
**Tests — F create:** `test/agent_task_workflow_test.dart`;
**F modify:** `test/agent_models_test.dart`, `test/agent_controller_test.dart`, `test/voice_companion_controller_test.dart`, `test/copilot_lifecycle_test.dart`, `test/care_plan_creation_flow_test.dart`.

**Interfaces:**
- Consumes Task 6 `taskWorkflow` snapshot and `create_care_plan` confirmation kind; strict Dart parsing rejects malformed kinds/status/revision/field payloads.
- Shared `AgentController.taskWorkflow` is the only presented workflow snapshot; both voice and text accept through the same response application path.
- Confirmation button/control sends existing explicit confirmation semantics once while in flight. Corrections invalidate old presented confirmation. Task 2 coordinator handles actual Upload destination; Flutter does not locally create a second care plan.

- [ ] Add failing tests for strict parsing, voice-start/text-update/voice-confirm one workflow, minimize/route preservation, corrected summary replacing old confirmation, rapid duplicate confirm disabled, and language change preserving draft/session.
- [ ] Add logout/account-change tests clearing snapshot, confirmation, highlights and queued navigation without touching another account. Preserve manual mode, mute, interrupt, reconnect and transport identities.
- [ ] Run workflow/models/controller/voice/lifecycle/creation tests; confirm unsupported creation kind fails.
- [ ] Implement snapshot/presentation integration and localized structured errors. No second task store/recovery system, no direct client create, and no normalized-ASR substitution.
- [ ] Rerun focused tests and existing voice startup/language/manual-mode regressions.

## Task 8: Major-Screen Coverage, Integration, and Safe Diagnostics

**Files — F modify for real identity/key-action bindings only:**
`lib/screens/dashboard_screen.dart`, `lib/screens/task_outcome_screens.dart`, `lib/screens/library_screens.dart`, `lib/screens/support_screens.dart`, `lib/screens/family_screens.dart`, `lib/screens/routine_preferences_screen.dart`, `lib/screens/simulation_screen.dart`, `lib/screens/care_plan_detail_screen.dart`, `lib/screens/care_plan_upload_screen.dart`, `lib/screens/care_plan_review_screen.dart`, `lib/screens/document_viewer_screen.dart`, `lib/widgets/app_shell.dart`, `lib/app.dart`.
**Files — F create:** `lib/features/agent/copilot/copilot_diagnostics.dart`.
**Tests — F create:** `test/copilot_major_screen_coverage_test.dart`, `test/copilot_phase21_integration_test.dart`.
**Tests — B create:** `agent_phase21_integration_test.js`.

**Interfaces:**
- Each actual authenticated route emits registered identity, bounded key actions and entity-sensitive version via Tasks 2/4. Use actual callbacks/anchors only. Create/upload/review are distinct forms; document viewer participates despite plain Scaffold.
- `CopilotDiagnostics.emit(CopilotDiagnostic code,{registeredScreen?,registeredAction?,outcome?})` is debug-only, closed/bounded enum metadata. No user text, title, transcript, account/session/entity IDs, tokens, private data or provider bodies.
- Task/workflow and language diagnostics emit transitions/canonical language only; never arbitrary exception messages.

- [ ] Add failing coverage tests against AppRouter's actual major destinations, stable aliases, real key callbacks, screen/entity updates, public exclusions, and no arbitrary route/action IDs.
- [ ] Add end-to-end mocked integration: root compact chat → typed/voice Settings navigation → guided actual highlight → Next/Previous/Stop → same conversation → care-plan collection/correction/confirmation → committed server result → Upload → repeat confirmation no duplicate; account change cancels everything.
- [ ] Run new integration/coverage tests and Node Phase 2.1 integration tests.
- [ ] Bind actual major-screen controls and closed diagnostics. Preserve unrelated screen behavior and avoid duplicate server/client workflow execution.
- [ ] Rerun integration tests and compare pre-existing dirty files against baseline. Mixed files may contain intentional narrow deltas; untouched dirty files must retain exact SHA256.

## Task 9: Full Validation, Preservation Report, and Android Checklist

**Files — B create:** `PHASE_2_1_AGENT_REPAIR_REPORT.md`.
**Files — F/B modify:** only Phase 2.1 code/tests from Tasks 1–8 if a relevant failure requires repair; do not fix unrelated dirty work.

**Interfaces:**
- Report consumes command logs, baseline comparison and final per-repo diff; produces exact changed/new paths, mixed-file preservation, test assertions/counts and exit codes, limitations, acceptance checklist and staging recommendation.

- [ ] Run all new/affected Flutter focused tests first using `C:/flutter/bin/flutter.bat test --no-pub <explicit paths from Tasks 1–8>`; fix relevant failures then run once `C:/flutter/bin/flutter.bat analyze --no-pub` and `C:/flutter/bin/flutter.bat test --no-pub`.
- [ ] Run explicit new/affected Node tests from Tasks 1–8. Then in backend PowerShell run `$phase21Tests = @(Get-ChildItem -File -Filter '*_test.js' | Sort-Object Name | ForEach-Object { $_.Name }); node --test @phase21Tests`. Require all root files and exact results, including pre-existing voice regressions.
- [ ] Run `git diff --check` in both repositories and compare baseline SHA256/content. Record new untracked files separately because `git diff --check` does not inspect untracked content.
- [ ] If Windows Dart crashes with existing native `0xC0000008`, report it separately from assertions; no security changes or false full-pass claim. Retry only a justified runtime invocation; do not repeat broad tests indefinitely.
- [ ] Write final report with seven RCAs, actual architecture/files, mixed hunks, new tests/counts, unresolved runtime/live-DB/provider/device limitations and exact safe staging list. Recommend whole files only for coherent Agent changes; mixed pre-existing files require `git add -p` features described explicitly. Stage nothing.
- [ ] Prepare manual acceptance checklist for device `ET422L020921`, API `https://sehatmate-api.secretstechies.com/api`: global access; Settings navigation; duplicate prevention; Care Plans; Roman Urdu persistence; collapsed/compact/expanded; guided minimize; Settings highlights; Next/Previous/Stop; real voice creation with approval; cross-modality continuity; repeated-confirmation dedupe; logout/account cleanup. Use an authorized account and deliberately disposable plan name, request no secrets, and do not execute production creation or deploy automatically.

## Self-Review and Execution Handoff

- All seven failures map to tasks in the cause table. Global account cleanup, receipt truthfulness, safe confirmed creation, shared text/voice and selected-language requirements are included.
- Each new shared type/function is defined in an Interfaces block before consumers; screen catalogs and task workflows stay distinct from the existing post-UI continuation/bookmark mechanism.
- No bound widening, provider/config/Worker edits, new DB migration, staging or commit step is planned.
- Transcript transliteration is deliberately deferred and must be disclosed; raw ASR and authoritative Roman Urdu response are tested separately.
- Real-device/provider/MySQL success remains pending actual authorized execution, regardless of unit-test count.
- Approval requested: does this implementation plan capture the supplied spec, and should execution be Native (recommended) or Subagent-driven? Product code/tests begin only after that review.
