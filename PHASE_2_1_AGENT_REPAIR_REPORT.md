# SehatMate Phase 2.1 Agent Repair Report

Date: 2026-10-09. Native implementation resumed from existing work; Tasks 1–7 were preserved. Task 8 integration and three final-review repairs are implemented and focused-tested. Task 9 commands were executed; **full Flutter validation remains blocked by a Windows Dart native crash**. No real device/provider/MySQL success is claimed.

Flutter repository: `C:/Users/Zain/OneDrive/Desktop/sehatroute_flutter`.
Backend repository: `C:/Users/Zain/OneDrive/Desktop/sehatmate_api`.
Evidence directory: `C:/Users/Zain/Documents/Codex/2026-10-04/files-pasted-by-the-user-sehatmate`.
Plan: `docs/superpowers/plans/2026-10-09-phase-2-1-agent-repair.md`; ledger: `phase21_progress.md` in the evidence directory.

No stage, commit, push, deploy, reset, restore, stash, clean, production migration or production database mutation was performed. No Worker, LiveKit, Deepgram, Fish configuration/credential or transport-contract changes were made in Phase 2.1. Phase 3 was not started.

## Seven original failures: cause and implementation

| Failure | Cause | Repair and evidence |
|---|---|---|
| Global Agent access and unreliable navigation | Launcher was AppShell-local; document viewer lacked access. Route maps disagreed and navigation pushed duplicates. | Authenticated root CopilotHost; one semantic registry/coordinator/observer, typed destinations, exact readiness/entity checks, duplicate coalescing, guarded stack reuse and honest receipts. Actual document viewer zoom/global-entry widget test and Care Gap focused-question navigation pass. Invalid numeric entity routes now fail closed. |
| Bulky popup/composer loss | Boolean presentation, large modal, duplicate chrome, unmounting composer/scroll and unconditional history follow. | Persistent collapsed/compact/expanded/guided presentation, shared compact header, draggable 45% default sheet, retained history/composer/transport, explicit-send follow and no unrelated-notification auto-scroll. Keyboard-adjusted minimum height accounts for text scaling; embedded chat avoids double keyboard inset. |
| Roman Urdu language drift | Detected input/last-turn fallback overrode authenticated selected profile; continuations/errors/confirmation text used stale/default language. | Stored profile is the authority for text, voice and continuations; one existing preference synchronization barrier, localized errors/confirmations/task text, shared selector and safe existing voice rebind. Raw ASR remains original; no unsafe medical transliteration. |
| Duplicate memory/chip surfaces | Repeated memory taps launched unguarded sheets; chat obscured review; alternate handlers pushed duplicates. | Account-owned single-flight memory review, busy state and chat minimize, shared navigation coordinator; owned surface cleanup preserves unrelated routes. Memory invalidation tests pass. |
| Conversational care-plan creation failed | Existing drafts covered task outcomes/reminders, not a typed care-plan creation workflow. | Closed server workflow registry/reducer collects only the real required title (2–80 Unicode codepoints), source-bound updates/corrections, explicit confirmation, registered creation executor. Session row lock, ownership, expiry/revision/confirmation checks, insertion and completed receipt share one transaction. Replay/concurrency/rollback mocks pass; real MySQL remains unverified. Draft proceeds to typed Upload destination. |
| Generic explanations without real UI targets | Main-only catalogs and discarded UI metadata; overflow removed options; no walkthrough state. | Local real mounted catalogs for Settings/Care Plans/Reality Check and major screens; bounded deterministic context windows retain complete option groups. Metadata-grounded zero-tool help and read-only Next/Previous/Repeat/Stop/Open-chat/Continue walkthrough. No questionnaire answer or clinical mutation through walkthrough. |
| Chat obstructed guidance | Visual actions only minimized voice while text chat stayed visible. | Shared text/voice result gateway enters guided presentation before navigation/reveal/highlight; root guidance controls return to the same retained conversation. Integration tests exercise actual Settings controls and no duplicate navigation. |

## Three final-review defects

1. **Legacy confirmations shadowed by retained taskWorkflow.** Explicit legacy confirmation matching `pendingConfirmation.confirmationId` retains its existing route. Task confirmation handles its own matching ID or rejects stale requests against an active pending task; completed matching receipt replay remains supported. A late cancel cannot erase a completed creation receipt. Reminder and task/outcome confirmations after completed/cancelled workflows pass; mismatches, ownership and existing policy tests remain enforced.
2. **Voice gate recognized only pendingConfirmation.** Existing turn service now accepts either the unchanged current legacy confirmation or a strictly validated create-care-plan task snapshot with matching ID and unexpired awaiting-confirmation state. Completed matching confirm requests can recover the existing receipt; cancel/wrong ID/expired pending snapshots are rejected. Completed receipt ID must equal workflow confirmation ID. Existing voice idempotency/locking/epoch protections remain. Cross-modality tests cover voice start → text title → voice correction/confirmation and text start → voice title → confirmation/replay. Language switches preserve the workflow. The requested exact phrase `confirm karo` failed its new test, so it was added to the existing closed bare-confirmation classifier; unrelated affirmative input still cannot create without an active confirmation.
3. **Delayed old-account client work could send or apply after disposal.** Existing AgentController generation/disposal fence now guards session initialization, language preparation, sends, session-not-found retry, response application and post-store awaits, including confirmation/clarification. Disposal clears task/confirmation/clarification/conflict state. No second account system was introduced. Existing account-scoped store, registry invalidation, executor cancellation, navigation queue, service revision and walkthrough generation remain the authority. Added tests cover delayed preparation/init/retry/results and walkthrough reveal; existing tests cover queued navigation, confirmation callbacks, readiness, highlights and memory cleanup. Already-started authorized network requests cannot be undone, but stale completion cannot apply to a new account.

Independent fresh final review was completed once. Its three Important findings received the narrow fix pass above. No additional implementer/reviewer agents were dispatched during this resume.

## Task 8 boundaries

Major authenticated identities include home, calendar, progress, notifications, documents/viewer, profile/settings/routine, Care Plans/new/upload/review/detail, family/new/detail/plan, Reality Check, Care Gaps/detail, simulation, Simple Care, Teach Back and Doctor Questions. Create/upload/review have distinct form identities; typed plan and focused-question arguments preserve entity context. Document viewer participates despite its plain Scaffold. Public/auth/onboarding routes have no authenticated Agent entry.

Actual mounted controls supply descriptors; controls without a safe registered executor expose explanation/reveal only. Settings preference writes and existing Reality Check answer actions retain confirmation policy. Care Plans tab callbacks are actual executors; card menu/selection/lifecycle, plan-name and form-submit controls are anchored for guidance, not automatically executed as consequential writes. Confirmed server care-plan creation uses the registered transaction executor. This is not arbitrary whole-app automation.

Diagnostics are debug-only closed enums, approved screen names/outcomes and canonical language codes. No account/entity/session identifiers, user text, titles, transcripts, tokens, credentials or provider bodies are emitted by the added Phase 2.1 diagnostics.

## Verification results

Commands use the existing cached Flutter CLI via `C:/flutter/bin/cache/dart-sdk/bin/dart.exe C:/flutter/bin/cache/flutter_tools.snapshot`, equivalent to `flutter`. TEMP/TMP were redirected to the evidence directory's `flutter-test-temp`, CI=true, tests serialized with `--concurrency=1`; no product/runtime security configuration was weakened.

| Verification | Result | Exit | Evidence log |
|---|---|---|---|
| Review regression Node subset | 52/52 runner tests; legacy Phase D 57 internal cases after reminder/outcome additions | 0 | task9_review_green_node_final.log |
| Cross-modality confirmation subset including Phase E | 49/49 runner tests | 0 | task9_confirmation_green_final.log |
| Review + Task 8 Flutter subset | 36/36 assertions passed; native crash after output | -1073741816 | task9_review_green_flutter.log |
| All affected Phase 2.1 Flutter, 36 explicit files | **267/267 passed, clean process** | **0** | task9_flutter_focused_final.log |
| Targeted route/presentation/walkthrough repairs | 6/6 passed | 0 | task9_flutter_targeted_green.log |
| flutter analyze --no-pub, final | **No issues found** | **0** | task9_flutter_analyze_final.log |
| flutter test --no-pub --concurrency=1, full | **Blocked at first test loading; 0 completed assertions**, no assertion failure reported | **-1073741816 (0xC0000008)** | task9_flutter_full.log |
| Explicit affected Node, 22 files | 188/188 runner tests | 0 | task9_node_focused.log |
| Targeted full-suite fixture updates | 26/26 runner tests; Phase B 61 internal cases | 0 | task9_node_full_repairs_final.log |
| Full root Node, all 43 *_test.js files | **302/302 runner tests** | **0** | task9_node_full_verified.log |
| git diff --check, both repositories | No whitespace errors; Git reports existing LF/CRLF conversion warnings | 0 each | Final check recorded in task9_git_checks.log |
| Additional Phase 2.1 untracked whitespace scan | 29 Flutter + 10 backend files including this report, 0 issues | 0 | task9_untracked_whitespace.json |

Node's 302 is the runner count, not a total of all nested custom assertion cases. Full log also reports foundation 41, Phase B 61, Phase D 57, Phase E 68, Phase F 24, turn-language 22, title 11, family 35, performance 12, Phase I 30, schedule duration 8/recurrence 6/reliability 12, boundaries 32 and Teach Back 28 internal cases. Do not add those to the runner count as if all counters had the same structure.

RED evidence: review Flutter 18 passed/5 failed; new account-fence tests failed before fixes. Confirmation phrase regression 47 passed/1 failed before the closed phrase addition. Initial affected Flutter 264 passed/3 failed plus native exit: malformed route accepted, obsolete finishGuidance expectation and missing binding initialization in the new unit test. Narrow route validation, corrected presentation expectation and test binding initialization produced the final clean 267 pass. Initial full Node 300 passed/2 failed: old capability catalog omitted newly registered creation; localized help fixture selected English while supplying Urdu. Phase B also had older detected/last-turn language assumptions behind its first failed assertion; fixtures now explicitly select their intended profile and assert shared selected-profile authority. No production behavior was reverted to satisfy old fixtures.

Windows native failures are independent of assertions: initial analysis printed one unused-import warning then crashed; that test-only import was removed and final analysis exited 0. Earlier Task 3 run passed 76 assertions then crashed; dedicated geometry/selector 15 passed with exit 0. Some previous startup attempts emitted no assertions. Full Flutter is **not** claimed passed and was not repeatedly brute-forced.

Historical focused evidence retained in ledger: Task 1 Flutter 35/Node 29, Task 2 Flutter 9/Node 19, Task 4 Flutter 14/Node 31, Task 5 Flutter 8/Node 54, Task 6 Node 9 runner tests plus legacy/title internal cases and voice 46 runner tests, Task 7 Flutter 80; all listed clean exits except explicitly noted Task 3 broad run. Current final affected suite supersedes earlier integration assertion failures.

## Exact affected Flutter command

```powershell
$phase21Focused = @(
  'test/agent_controller_test.dart',
  'test/agent_models_test.dart',
  'test/agent_localization_test.dart',
  'test/agent_navigation_test.dart',
  'test/agent_navigation_coordinator_test.dart',
  'test/agent_service_test.dart',
  'test/agent_language_selector_test.dart',
  'test/agent_task_workflow_test.dart',
  'test/agent_ui_test.dart',
  'test/agent_voice_service_test.dart',
  'test/language_controller_test.dart',
  'test/voice_companion_controller_test.dart',
  'test/voice_companion_ui_test.dart',
  'test/voice_language_switch_test.dart',
  'test/care_plan_creation_flow_test.dart',
  'test/settings_screen_test.dart',
  'test/documents_screen_test.dart',
  'test/teach_back_screen_test.dart',
  'test/copilot_care_gap_test.dart',
  'test/copilot_care_plans_adapter_test.dart',
  'test/copilot_conflict_test.dart',
  'test/copilot_context_window_test.dart',
  'test/copilot_global_host_test.dart',
  'test/copilot_lifecycle_test.dart',
  'test/copilot_major_screen_coverage_test.dart',
  'test/copilot_memory_test.dart',
  'test/copilot_phase21_integration_test.dart',
  'test/copilot_presentation_test.dart',
  'test/copilot_protocol_test.dart',
  'test/copilot_reality_check_test.dart',
  'test/copilot_service_test.dart',
  'test/copilot_settings_adapter_test.dart',
  'test/copilot_test.dart',
  'test/copilot_walkthrough_test.dart',
  'test/copilot_workflow_test.dart',
  'test/semantic_route_registry_test.dart'
)
flutter test --no-pub --concurrency=1 @phase21Focused
flutter analyze --no-pub
flutter test --no-pub --concurrency=1
```

## Exact affected backend command

```powershell
node --test agent_turn_language_test.js agent_profile_language_test.js agent_workflow_test.js language_support_test.js agent_selected_language_test.js care_context_navigation_test.js agent_navigation_phase21_test.js agent_ui_planner_test.js agent_ui_protocol_test.js agent_copilot_integration_test.js agent_screen_help_test.js agent_session_routes_test.js agent_phase_f_test.js agent_phase_d_test.js agent_phase_e_test.js agent_task_workflow_test.js agent_care_plan_creation_test.js care_plan_title_service_test.js agent_phase21_integration_test.js voice_backend_test.js voice_config_test.js voice_storage_sdk_test.js
$phase21Tests = @(Get-ChildItem -File -Filter '*_test.js' | Sort-Object Name | ForEach-Object { $_.Name })
node --test @phase21Tests
```

## Exact Phase 2.1 changed/new files

Paths below are relative to the stated repository, not blanket directory recommendations. Classification compares against the saved pre-Phase-2.1 baseline; untracked foundation files that already existed are identified separately.

### Flutter: 31 tracked modified files

- `lib/app.dart`
- `lib/core/app_router.dart`
- `lib/core/app_routes.dart`
- `lib/features/agent/agent_entry.dart`
- `lib/features/agent/controllers/agent_controller.dart`
- `lib/features/agent/models/agent_context.dart`
- `lib/features/agent/models/agent_message.dart`
- `lib/features/agent/models/agent_navigation.dart`
- `lib/features/agent/models/agent_response.dart`
- `lib/features/agent/navigation/agent_navigation_handler.dart`
- `lib/features/agent/screens/agent_screen.dart`
- `lib/features/agent/voice/voice_companion_scope.dart`
- `lib/features/agent/widgets/agent_language_selector.dart`
- `lib/localization/app_strings.dart`
- `lib/localization/language_controller.dart`
- `lib/screens/care_gap_screens.dart`
- `lib/screens/care_plan_detail_screen.dart`
- `lib/screens/care_plan_review_screen.dart`
- `lib/screens/care_plan_upload_screen.dart`
- `lib/screens/care_plans_screen.dart`
- `lib/screens/dashboard_screen.dart`
- `lib/screens/document_viewer_screen.dart`
- `lib/screens/family_screens.dart`
- `lib/screens/library_screens.dart`
- `lib/screens/reality_check_screen.dart`
- `lib/screens/routine_preferences_screen.dart`
- `lib/screens/simulation_screen.dart`
- `lib/screens/support_screens.dart`
- `lib/screens/task_outcome_screens.dart`
- `lib/widgets/app_shell.dart`
- `test/agent_controller_test.dart`

### Flutter: 19 newly introduced untracked files

- `lib/features/agent/copilot/adapters/care_plans_copilot_adapter.dart`
- `lib/features/agent/copilot/adapters/settings_copilot_adapter.dart`
- `lib/features/agent/copilot/copilot_context_window.dart`
- `lib/features/agent/copilot/copilot_diagnostics.dart`
- `lib/features/agent/copilot/copilot_screen_catalog.dart`
- `lib/features/agent/copilot/copilot_walkthrough_controller.dart`
- `lib/features/agent/models/agent_task_workflow.dart`
- `lib/features/agent/navigation/agent_navigation_coordinator.dart`
- `lib/features/agent/navigation/semantic_route_registry.dart`
- `test/agent_navigation_coordinator_test.dart`
- `test/agent_task_workflow_test.dart`
- `test/copilot_care_plans_adapter_test.dart`
- `test/copilot_context_window_test.dart`
- `test/copilot_major_screen_coverage_test.dart`
- `test/copilot_phase21_integration_test.dart`
- `test/copilot_presentation_test.dart`
- `test/copilot_settings_adapter_test.dart`
- `test/copilot_walkthrough_test.dart`
- `test/semantic_route_registry_test.dart`

### Flutter: 10 pre-existing untracked foundation files extended

- `lib/features/agent/copilot/copilot.dart`
- `lib/features/agent/copilot/copilot_host.dart`
- `lib/features/agent/copilot/copilot_memory_review.dart`
- `lib/features/agent/copilot/copilot_navigation_observer.dart`
- `lib/features/agent/copilot/copilot_screen_adapter.dart`
- `lib/features/agent/copilot/copilot_strings.dart`
- `test/copilot_care_gap_test.dart`
- `test/copilot_global_host_test.dart`
- `test/copilot_lifecycle_test.dart`
- `test/copilot_memory_test.dart`

### Backend: 21 tracked modified files

- `agent/agent_capability_registry.js`
- `agent/agent_context_engine.js`
- `agent/agent_core.js`
- `agent/agent_navigation_registry.js`
- `agent/agent_planner.js`
- `agent/agent_reference_resolver.js`
- `agent/agent_response_grounder.js`
- `agent/agent_semantic_routes.js`
- `agent/agent_session_state.js`
- `agent/agent_turn_language.js`
- `agent/agent_ui_protocol.js`
- `agent/agent_workflow.js`
- `agent_phase_b_test.js`
- `agent_phase_d_test.js`
- `agent_phase_e_test.js`
- `agent_semantic_routing_test.js`
- `agent_turn_language_test.js`
- `agent_ui_protocol_test.js`
- `agent_workflow_test.js`
- `services/agent_turn_service.js`
- `voice_backend_test.js`

### Backend: 10 newly introduced untracked files

- `agent/agent_care_plan_tools.js`
- `agent/agent_task_workflow.js`
- `agent_care_plan_creation_test.js`
- `agent_navigation_phase21_test.js`
- `agent_phase21_integration_test.js`
- `agent_screen_help_test.js`
- `agent_selected_language_test.js`
- `agent_task_workflow_test.js`
- `docs/superpowers/plans/2026-10-09-phase-2-1-agent-repair.md`
- `PHASE_2_1_AGENT_REPAIR_REPORT.md`

## Preservation comparison

Baseline: `phase_21_preexisting_baseline.json`; results: `phase21_preservation.json`; content deltas for mixed files: `phase21_mixed_baseline.diff` (evidence directory).

- Flutter: all 38 baseline files remain; 15 untouched files byte-identical by SHA256; 23 mixed files intentionally extended. 37 other dirty files introduced by Phase 2.1.
- Backend: all 26 baseline files remain; 24 untouched files byte-identical; 2 mixed files intentionally extended. 28 other dirty files before adding this report (29 including this report).
- Both HEADs unchanged: Flutter `f5a662770637da20c81816f10b0f283c5790f3b7`; backend `d1c8d1f4b18c1395d1502368ee12eb079f35fa7d`.
- Both indexes empty of staged differences. No missing baseline file.
- All pre-existing Worker dirty/untracked files remain byte-identical. Their existing `git diff` entries are not Phase 2.1 changes.
- Mixed files were compared to baseline content, not only HEAD. AppShell's existing menu/route behavior remains in the working file while the local Agent FAB/context map changes intentionally; Agent/voice foundation survives the shared host/gateway changes. Backend prior timing/speech policy remains; turn-service Phase 2.1 delta is task snapshot encryption and current confirmation gating. Existing voice-backend test content is retained with appended task gate cases. AppShell original shell-route navigation and sidebar/header/language/mobile menu source compare equal after newline normalization; all original voice-backend test lines remain in order with insertions only.
- Byte identity is claimed only for untouched files. Mixed files are intentional adaptations listed below; unrelated original hunks must remain excluded from staging.

Untouched baseline files (exact SHA256 matches):

**Flutter**

- `.flutter-plugins-dependencies`
- `lib/features/agent/voice/voice_companion_controller.dart`
- `lib/widgets/language_switcher.dart`
- `UNATTENDED_E2E_REPORT.md`
- `lib/features/agent/copilot/copilot_conflict.dart`
- `lib/features/agent/copilot/copilot_service.dart`
- `lib/features/agent/copilot/copilot_workflow_store.dart`
- `lib/widgets/sehat_menu.dart`
- `test/assistant_polish_test.dart`
- `test/copilot_conflict_test.dart`
- `test/copilot_protocol_test.dart`
- `test/copilot_reality_check_test.dart`
- `test/copilot_service_test.dart`
- `test/copilot_test.dart`
- `test/copilot_workflow_test.dart`

**Backend**

- `voice-worker/sehatmate_voice/bridge.py`
- `voice-worker/sehatmate_voice/config.py`
- `voice-worker/sehatmate_voice/deepgram_adapter.py`
- `voice-worker/sehatmate_voice/fish_adapter.py`
- `voice-worker/sehatmate_voice/runtime.py`
- `voice-worker/sehatmate_voice/session.py`
- `voice-worker/tests/test_bridge_providers.py`
- `voice-worker/tests/test_microphone.py`
- `voice-worker/tests/test_sdk_contracts.py`
- `voice-worker/tests/test_session.py`
- `voice-worker/worker.env.example`
- `voice-worker/worker.py`
- `AGENT_APP_HELP_RELIABILITY_REPORT.md`
- `AGENT_RESPONSE_NATURALIZATION_REPORT.md`
- `AGENT_SEMANTIC_ROUTING_REPORT.md`
- `FINAL_VOICE_QUALITY_REPORT.md`
- `VOICE_CUTOFF_LATENCY_REPORT.md`
- `voice-worker/VOICE_QUALITY_NOTES.md`
- `voice-worker/sehatmate_voice/turn_metrics.py`
- `voice-worker/tests/test_barge_in.py`
- `voice-worker/tests/test_final_voice_reliability.py`
- `voice-worker/tests/test_job_diagnostics.py`
- `voice-worker/tests/test_turn_diagnostics.py`
- `voice-worker/tests/test_voice_quality.py`

## Exact recommended staging manifest — recommendation only

Nothing below was executed. No whole directory staging. Build a coherent Agent/Copilot foundation plus Phase 2.1 set; the language selector cannot be staged by itself. All listed new/clean-before-Phase-2.1 files are required by the changed Agent types, root runtime paths or their tests. No new package/plugin dependency was added by Phase 2.1; existing pubspec/lock/native plugins already provide the voice stack.

### Whole safe files

**Flutter**

- `lib/core/app_router.dart`
- `lib/core/app_routes.dart`
- `lib/features/agent/copilot/adapters/care_plans_copilot_adapter.dart`
- `lib/features/agent/copilot/adapters/settings_copilot_adapter.dart`
- `lib/features/agent/copilot/copilot_conflict.dart`
- `lib/features/agent/copilot/copilot_context_window.dart`
- `lib/features/agent/copilot/copilot_diagnostics.dart`
- `lib/features/agent/copilot/copilot_screen_catalog.dart`
- `lib/features/agent/copilot/copilot_service.dart`
- `lib/features/agent/copilot/copilot_walkthrough_controller.dart`
- `lib/features/agent/copilot/copilot_workflow_store.dart`
- `lib/features/agent/models/agent_message.dart`
- `lib/features/agent/models/agent_navigation.dart`
- `lib/features/agent/models/agent_task_workflow.dart`
- `lib/features/agent/navigation/agent_navigation_coordinator.dart`
- `lib/features/agent/navigation/semantic_route_registry.dart`
- `lib/features/agent/voice/voice_companion_controller.dart`
- `lib/features/agent/widgets/agent_language_selector.dart`
- `lib/localization/language_controller.dart`
- `lib/screens/care_plan_detail_screen.dart`
- `lib/screens/care_plan_review_screen.dart`
- `lib/screens/care_plan_upload_screen.dart`
- `lib/screens/care_plans_screen.dart`
- `lib/screens/document_viewer_screen.dart`
- `lib/screens/family_screens.dart`
- `lib/screens/library_screens.dart`
- `lib/screens/routine_preferences_screen.dart`
- `lib/screens/simulation_screen.dart`
- `lib/screens/support_screens.dart`
- `lib/screens/task_outcome_screens.dart`
- `test/agent_controller_test.dart`
- `test/agent_navigation_coordinator_test.dart`
- `test/agent_task_workflow_test.dart`
- `test/copilot_care_plans_adapter_test.dart`
- `test/copilot_conflict_test.dart`
- `test/copilot_context_window_test.dart`
- `test/copilot_major_screen_coverage_test.dart`
- `test/copilot_phase21_integration_test.dart`
- `test/copilot_presentation_test.dart`
- `test/copilot_protocol_test.dart`
- `test/copilot_reality_check_test.dart`
- `test/copilot_service_test.dart`
- `test/copilot_settings_adapter_test.dart`
- `test/copilot_test.dart`
- `test/copilot_walkthrough_test.dart`
- `test/copilot_workflow_test.dart`
- `test/semantic_route_registry_test.dart`

Exact PowerShell command from that repository, for later authorized use:

```powershell
git add -- 'lib/core/app_router.dart' 'lib/core/app_routes.dart' 'lib/features/agent/copilot/adapters/care_plans_copilot_adapter.dart' 'lib/features/agent/copilot/adapters/settings_copilot_adapter.dart' 'lib/features/agent/copilot/copilot_conflict.dart' 'lib/features/agent/copilot/copilot_context_window.dart' 'lib/features/agent/copilot/copilot_diagnostics.dart' 'lib/features/agent/copilot/copilot_screen_catalog.dart' 'lib/features/agent/copilot/copilot_service.dart' 'lib/features/agent/copilot/copilot_walkthrough_controller.dart' 'lib/features/agent/copilot/copilot_workflow_store.dart' 'lib/features/agent/models/agent_message.dart' 'lib/features/agent/models/agent_navigation.dart' 'lib/features/agent/models/agent_task_workflow.dart' 'lib/features/agent/navigation/agent_navigation_coordinator.dart' 'lib/features/agent/navigation/semantic_route_registry.dart' 'lib/features/agent/voice/voice_companion_controller.dart' 'lib/features/agent/widgets/agent_language_selector.dart' 'lib/localization/language_controller.dart' 'lib/screens/care_plan_detail_screen.dart' 'lib/screens/care_plan_review_screen.dart' 'lib/screens/care_plan_upload_screen.dart' 'lib/screens/care_plans_screen.dart' 'lib/screens/document_viewer_screen.dart' 'lib/screens/family_screens.dart' 'lib/screens/library_screens.dart' 'lib/screens/routine_preferences_screen.dart' 'lib/screens/simulation_screen.dart' 'lib/screens/support_screens.dart' 'lib/screens/task_outcome_screens.dart' 'test/agent_controller_test.dart' 'test/agent_navigation_coordinator_test.dart' 'test/agent_task_workflow_test.dart' 'test/copilot_care_plans_adapter_test.dart' 'test/copilot_conflict_test.dart' 'test/copilot_context_window_test.dart' 'test/copilot_major_screen_coverage_test.dart' 'test/copilot_phase21_integration_test.dart' 'test/copilot_presentation_test.dart' 'test/copilot_protocol_test.dart' 'test/copilot_reality_check_test.dart' 'test/copilot_service_test.dart' 'test/copilot_settings_adapter_test.dart' 'test/copilot_test.dart' 'test/copilot_walkthrough_test.dart' 'test/copilot_workflow_test.dart' 'test/semantic_route_registry_test.dart'
```
**Backend**

- `PHASE_2_1_AGENT_REPAIR_REPORT.md`
- `agent/agent_capability_registry.js`
- `agent/agent_care_plan_tools.js`
- `agent/agent_context_engine.js`
- `agent/agent_core.js`
- `agent/agent_navigation_registry.js`
- `agent/agent_planner.js`
- `agent/agent_reference_resolver.js`
- `agent/agent_response_grounder.js`
- `agent/agent_semantic_routes.js`
- `agent/agent_session_state.js`
- `agent/agent_task_workflow.js`
- `agent/agent_turn_language.js`
- `agent/agent_ui_protocol.js`
- `agent/agent_workflow.js`
- `agent_care_plan_creation_test.js`
- `agent_navigation_phase21_test.js`
- `agent_phase21_integration_test.js`
- `agent_phase_b_test.js`
- `agent_phase_d_test.js`
- `agent_phase_e_test.js`
- `agent_screen_help_test.js`
- `agent_selected_language_test.js`
- `agent_semantic_routing_test.js`
- `agent_task_workflow_test.js`
- `agent_turn_language_test.js`
- `agent_ui_protocol_test.js`
- `agent_workflow_test.js`
- `docs/superpowers/plans/2026-10-09-phase-2-1-agent-repair.md`

Exact PowerShell command from that repository, for later authorized use:

```powershell
git add -- 'PHASE_2_1_AGENT_REPAIR_REPORT.md' 'agent/agent_capability_registry.js' 'agent/agent_care_plan_tools.js' 'agent/agent_context_engine.js' 'agent/agent_core.js' 'agent/agent_navigation_registry.js' 'agent/agent_planner.js' 'agent/agent_reference_resolver.js' 'agent/agent_response_grounder.js' 'agent/agent_semantic_routes.js' 'agent/agent_session_state.js' 'agent/agent_task_workflow.js' 'agent/agent_turn_language.js' 'agent/agent_ui_protocol.js' 'agent/agent_workflow.js' 'agent_care_plan_creation_test.js' 'agent_navigation_phase21_test.js' 'agent_phase21_integration_test.js' 'agent_phase_b_test.js' 'agent_phase_d_test.js' 'agent_phase_e_test.js' 'agent_screen_help_test.js' 'agent_selected_language_test.js' 'agent_semantic_routing_test.js' 'agent_task_workflow_test.js' 'agent_turn_language_test.js' 'agent_ui_protocol_test.js' 'agent_workflow_test.js' 'docs/superpowers/plans/2026-10-09-phase-2-1-agent-repair.md'
```

The unchanged pre-existing `voice_companion_controller.dart` presentation methods are required by AgentEntry, CopilotHost, adapter and scope imports/runtime; omitting them breaks compilation. Untracked conflict/service/workflow-store foundations and their relevant tests are required by AgentResponse/Copilot/root runtime. Preserve them in the conceptual commit. Existing title-validation service is already tracked and byte-unchanged in this phase.

### Mixed files: explicit partial staging features

For every path below use `git add -p -- '<path>'` later; accept Agent foundation required by the new imports plus the listed Phase 2.1 features, and keep unrelated hunks unstaged. These are instructions only.

Pre-existing **untracked** mixed foundation files cannot be partial-staged by `git add -p` until a human deliberately sets intent-to-add (`git add -N -- '<exact path>'`); no such index mutation was performed here. Review the entire baseline foundation as well as new Phase 2.1 hunks rather than staging only a fragment that leaves missing classes/imports. For these Agent-only foundations, a whole reviewed coherent file may be safer after approval; do not automate that choice.

**Flutter mixed files**

- `lib/app.dart` — Account-scoped root presentation/coordinator/walkthrough ownership, shared text/voice gateway, guided visual transition and invalidation cleanup; preserve existing app/auth/router/error-boundary work.
- `lib/features/agent/agent_entry.dart` — Open/minimize the existing root Agent presentation rather than duplicate modal/screen entry.
- `lib/features/agent/controllers/agent_controller.dart` — Shared selected-language barrier, authoritative task snapshots, continuation state and existing generation/disposal fencing; retain prior session recovery/business semantics.
- `lib/features/agent/models/agent_context.dart` — Closed additional actual screen identities, bounded entity context; do not remove prior context fields.
- `lib/features/agent/models/agent_response.dart` — Strict taskWorkflow snapshot parsing and existing response/voice result support.
- `lib/features/agent/navigation/agent_navigation_handler.dart` — Delegate to shared semantic coordinator; retain standalone authorized compatibility.
- `lib/features/agent/screens/agent_screen.dart` — Embedded persistent chat, compact header/selector, scroll behavior, keyboard inset and localized task confirmation UI.
- `lib/features/agent/voice/voice_companion_scope.dart` — Shared root launch/minimize/pill controls; preserve transport/mute/end/reconnect and existing voice semantics.
- `lib/localization/app_strings.dart` — Localized Phase 2.1 guidance, errors and task-confirmation copy only; keep unrelated strings.
- `lib/screens/care_gap_screens.dart` — Mounted gap metadata and typed exact focused-question navigation with honest readiness; preserve existing clinical/business UI.
- `lib/screens/dashboard_screen.dart` — Real hero/tasks/progress/setup section anchors and descriptors only.
- `lib/screens/reality_check_screen.dart` — Complete actual answer catalogs/anchors, bounded windows, confirmed answer callbacks and focused question readiness; preserve clinical questionnaire.
- `lib/widgets/app_shell.dart` — Remove page-local Agent launcher, semantic route/form/entity context and scope binding. Leave unrelated pre-existing menu styling/navigation hunks unstaged; its working-tree behavior is preserved.
- `lib/features/agent/copilot/copilot.dart` — Retain foundation registry/executor/account surface support; add presentation/catalog windows/mounted metadata/read-only walkthrough hooks, visual barrier and honest fencing. **Pre-existing untracked foundation: intent-to-add needed before partial staging.**
- `lib/features/agent/copilot/copilot_host.dart` — Retain authenticated host foundation; persistent draggable modes, root voice/guidance controls and adaptive keyboard/text layout. **Pre-existing untracked foundation: intent-to-add needed before partial staging.**
- `lib/features/agent/copilot/copilot_memory_review.dart` — Retain foundation memory review/account surface; owned single-flight, busy and minimize behavior. **Pre-existing untracked foundation: intent-to-add needed before partial staging.**
- `lib/features/agent/copilot/copilot_navigation_observer.dart` — Retain foundation page-context lifecycle; add typed page stack identity/readiness and safe reuse. **Pre-existing untracked foundation: intent-to-add needed before partial staging.**
- `lib/features/agent/copilot/copilot_screen_adapter.dart` — Retain actual adapter foundation; catalog-before-publish, real mounted descriptors/callbacks, read/walkthrough windows and visual transition. **Pre-existing untracked foundation: intent-to-add needed before partial staging.**
- `lib/features/agent/copilot/copilot_strings.dart` — Existing localization foundation plus localized guided/presentation copy. **Pre-existing untracked foundation: intent-to-add needed before partial staging.**
- `test/copilot_care_gap_test.dart` — Existing real gap fixture plus shared coordinator/exact loaded-question readiness coverage; remove obsolete async assertion/test probe. **Pre-existing untracked foundation: intent-to-add needed before partial staging.**
- `test/copilot_global_host_test.dart` — Existing root access tests plus persistent presentation, keyboard/RTL/large text and small-landscape composer coverage. **Pre-existing untracked foundation: intent-to-add needed before partial staging.**
- `test/copilot_lifecycle_test.dart` — Existing route/account/risk tests, updated distinct upload identity and retained malformed entity rejection. **Pre-existing untracked foundation: intent-to-add needed before partial staging.**
- `test/copilot_memory_test.dart` — Existing memory tests plus repeated entry/account-owned single-flight behavior. **Pre-existing untracked foundation: intent-to-add needed before partial staging.**
**Backend mixed files**

- `services/agent_turn_service.js` — Accept taskWorkflow in approved encrypted result and current validated task/receipt confirmation. Leave prior voice latency instrumentation and unrelated speech/provider policy hunks unstaged.
- `voice_backend_test.js` — Append current task confirm/cancel, duplicate, completed replay, expired/wrong/cancel rejection cases only; preserve earlier unrelated Worker/provider/binding test additions unstaged.

### Must remain unstaged in this focused manifest

- Backend: every `voice-worker/**` dirty/untracked entry listed above and existing voice/app-help/semantic-routing quality reports. All are untouched baseline work outside this phase.
- Flutter: `.flutter-plugins-dependencies` (generated and unchanged from dirty baseline), `UNATTENDED_E2E_REPORT.md`, `lib/widgets/language_switcher.dart`, `lib/widgets/sehat_menu.dart`, `test/assistant_polish_test.dart`, and unrelated pre-existing AppShell menu/style hunks. If a later broader UI-foundation commit intentionally accepts those menu hunks, include the `sehat_menu.dart` dependency with that broader set; do not stage its importer alone.
- No pubspec.yaml/pubspec.lock/AndroidManifest/native generated plugin changes are introduced by this phase. No credential/environment file or DB migration is part of the manifest.

Dependency omissions that would break the conceptual tree: new semantic route registry/coordinator with observer and root binding; typed taskWorkflow model with AgentResponse/controller/screens; copilot catalog/window/walkthrough/diagnostics with adapters/registry/host; required pre-existing conflict/service/workflow foundations; existing voice presentation methods; localized string additions; backend task registry/reducer/care-plan executor with core/planner/session-state imports; mixed turn-service task result/gate hunks. All corresponding new tests are listed.

Conceptual set includes typing Agent, realtime voice UI, shared language selector, safe existing language rebind, existing voice dependencies/plugins, navigation/guide/creation/account-fence tests. It does not add a second session/route/confirmation system.

Recommended commit message (when separately approved): `feat(agent): complete Phase 2.1 shared copilot navigation, language and confirmed care-plan workflows`.

## Pending limits / Android manual acceptance

- Full Flutter test suite did not complete because of Windows native 0xC0000008; rerun on a reliable authorized Flutter runtime before claiming full-suite success. No Windows security policy was changed.
- Disposable MySQL validation of session-row locks/transaction rollback/insert+receipt atomicity remains pending. Do not use production Hostinger DB for tests or migrations.
- Real LiveKit/Deepgram/Fish audio, Android lifecycle/keyboard/accessibility, spoken confirmations and device audio require actual authorized execution. Mock results do not establish them.
- Raw Urdu-script ASR stays original. Roman Urdu selected-language replies, confirmations, errors/fallbacks and continuations are enforced; no invented transliteration.
- Read-only guidance is available for mounted control catalogs; unsupported actions/oversized required option groups fail honestly rather than silently discarding constraints or automating clinical writes.

Device: **ET422L020921**. API: **https://sehatmate-api.secretstechies.com/api**. Checklist is prepared only, not executed. Production write scenarios require separate explicit authorization and a deliberately disposable plan; do not automatically run them against this API.

1. Install the authorized current build; authenticate using an authorized account. Confirm no Agent entry on signed-out/auth/onboarding screens.
2. Check one root Agent pill on Dashboard, Calendar, Progress, Notifications, Documents/viewer, Profile, Settings/Routine, Care Plans and family/clinical flows. Back/dialog transitions must not duplicate it.
3. Open compact chat; send multiple messages; type an unsent draft, scroll older history, minimize/reopen/expand. Composer/history/scroll stay intact; keyboard/large font/Urdu RTL/small landscape remain usable.
4. Select Roman Urdu in typed Agent; restart app and confirm persistence. English and Urdu-script input must produce Roman Urdu replies, localized confirmation/errors/help/continuations. Switch from voice header and verify safe rebind to existing session; raw ASR may remain Urdu script.
5. Ask text and voice to open Settings repeatedly; verify one shared navigation, no duplicate push, correct Back, no false success on missing/redirected destinations or edited forms. Reuse only matching entities/arguments.
6. Explain Settings, Language/Simple Care, Care Plans tabs/cards and Reality Check choices. Verify highlight is an actual visible control, complete choices are available and no preference/question answer is saved just by explanation.
7. Start walkthrough; Next/Previous/Repeat/Stop/Open-chat/Continue use actual anchors. Chat minimizes for visual guidance, reopens same conversation; unavailable/changed targets stop or pause honestly.
8. Review Agent Memory repeatedly; verify one owned sheet and busy state. Cancel, logout or switch account during pending review; no old surface or save appears in the new account.
9. Open a document viewer; verify global Agent access and actual zoom/reset/rotate/page anchors. Navigate back without orphaned overlay.
10. On a separately authorized disposable environment/write scope: voice asks to create plan → text supplies title → voice corrects → review confirmation → explicit approve. Confirm exactly one draft, corrected title and Upload destination. Never create before approval; stale old correction/confirmation is rejected.
11. Repeat opposite text-start/voice-title/text-confirm path; switch selected language mid-workflow. Repeated/lost-response approval recovers same receipt/plan and produces no duplicate navigation/insert. Existing reminder/task outcome confirm/cancel remains intact.
12. While AI processing/navigation/reveal/confirmation/continuation is delayed, logout or switch account. Verify no old reply, resend, navigation, highlight, task/clarification, memory surface or reopened chat in new account. Test return to existing account as well.
13. Verify normal voice listen → processing → speaking → playback complete → listening, manual mute/unmute, true barge-in, end, reconnect and fallback remain unchanged. Record actual device/provider results separately.

Stop point: Phase 2.1 code/focused checks and report prepared. No Phase 3, deployment, staging or production write followed.
