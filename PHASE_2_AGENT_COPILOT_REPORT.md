# Phase 2 Agent Copilot implementation report

Report date: 2026-10-08 (Asia/Karachi). Implementation status: **PARTIAL** until remaining acceptance and live validation described below are complete. Existing baselines: Flutter `f5a662770637da20c81816f10b0f283c5790f3b7`; backend `c55d7f7446075574c9c20b6b6c9ceb448f1c442e`.

## Preserved state and continuation

The continuation started with an existing global host, semantic registry/anchors/executor, Reality Check and Care Gap adapters, shared text/voice response hook, bounded protocol/planner integration, structured memory/conflicts, context sync, issued UI plans/receipts, and read-only workflow continuation. These were inspected and extended rather than rebuilt.

The original eight dirty Flutter items and 26 dirty backend items were recorded with contents and SHA-256 in the task workspace. Final comparison finds seven of eight Flutter files and 25 of 26 backend files byte-identical, no missing files, unchanged Git HEADs and empty staging indexes. The intended mixed files are `lib/widgets/app_shell.dart` and `services/agent_turn_service.js`; their baseline-to-current diffs were reviewed. All Python Worker work is pre-existing and byte-identical to the recorded baseline; no Worker source/config/tests were edited for Phase 2. No staging/reset/restore/stash/checkout/clean/commit/push/deployment occurred.

Continuation corrections include actual Flutter target kinds (`question`, `button`) and Care Gap `open_entity` callback compatibility, strict registered navigation including inherited-property rejection, scoped memory usage timestamps, real verified multi-day inferred-pattern persistence with deduplication, and binding Reality Check conflict navigation to its verified plan. Context generation ordering, actual unanswered Reality Check strings, medicine clinical flags, receipt metadata/rejections, memory envelope, same-Agent global host and safe read-only continuation were completed in the preceding coordinated work and retained.

Flutter continuation corrections clear inherited actionable context on PageRoute transitions while retaining it through confirmation PopupRoutes; restore the original mounted semantic anchor after stacked screens pop; enforce the synchronized outer-context size cap and reject prohibited risk tiers before confirmation/execution; distinguish actual numeric plan/relationship routes from create/upload/review routes; expose context-sync failure safely; limit automatic narration to executed step/navigation actions; and remove only owned account-scoped memory/confirmation modals after account invalidation. Care Gap navigation waits on real semantic publication for its exact plan's mounted Reality Check question, bounded to four seconds, without polling, provider retries, invented context or navigation replay.

## Architecture and trust boundaries

One existing Agent planning authority serves typing and the unchanged realtime Worker. Flutter sends a bounded `context.ui`; voice uses the same user's authenticated expiring context sync. The existing planner selects exact registered operations; backend validates them and derives risk. UI text is untrusted UI-only context. Patient/plan/task truth and business writes retain existing authenticated backend tool, ownership, draft/confirmation and receipt protections.

The application owns one account-scoped Agent controller and voice controller. A persistent, minimizable typing host is layered over the Navigator. Navigation preserves shared conversation/history; voice can minimize to reveal app content while retaining its transport and mute controls. Account changes invalidate the registry, services, executor and controllers. English, Urdu and Roman Urdu retain shared language authority/rebind behavior.

## Protocol and bounds

- Context: `{screenId, entity?, ui:{screenId,route,version,focusedSectionId?,entities,targets,actions}}`.
- Target: `{id,kind,label,selected?}`. Semantic IDs do not depend on translated labels.
- Action registration: `{id,kind,targetId}`. Actual Flutter callbacks close over loaded screen state; model cannot select a method, arbitrary route or backend payload.
- Plan: `{id,screenId,version,operations:[{actionId,targetId,args:{},riskTier}],continuationDepth?}`.
- Limits: 4096 UTF-8 bytes per UI snapshot / synchronized outer context; 20 targets, 20 actions, six entities; four operations; labels at most 480 characters; opaque tokens at most 160 characters.
- Real Flutter versions: `ui_<20-digit mount UTC microseconds>_<8-digit sequence>_<16 hex secure nonce>`. Atomic binary-ordered upsert prevents older canonical context overwrites/TTL renewal. Legacy opaque versions remain compatible until a session adopts canonical generations.
- Context/issued plans expire after five minutes. Foreground sync is serialized, debounced and renewed each minute while enabled; account/background/disposal invalidate queued publication.

## Global UI, highlights and executor

The reusable shell adapter publishes screen-level context and main anchor. Rich adapters publish the current Reality Check question/options and bounded actual Care Gap cards. PageRoute changes clear old capabilities; returning supported routes republish, and PopupRoute confirmation retains its originating context. Per-target anchor stacks select the mounted current-route instance and restore earlier instances after pop. Anchors reveal with scroll/focus and a temporary non-blocking outline; RTL, large text and reduced motion are tested. Disappearing targets fail safely.

The executor validates current account, screen/version, target/action pairing, empty argument schema and cancellation before execution and again after confirmation. It calls only registered callbacks, deduplicates issued operations, prevents concurrent workflows and never replays an uncertain action after receipt network failure. Pause/cancel invalidate pending work; resume permits fresh current-state plans.

Tier 0 covers read/highlight/focus/scroll. Tier 1 covers registered reversible navigation. Reality Check select/Next/Previous use explicit confirmation because actual callbacks persist answers. Existing backend meaningful writes keep existing draft/confirmation authority. Medication/prescription/diagnosis/treatment changes remain forbidden. No unsupported Undo is advertised.

## Workflow references

Reality Check exposes the real current question/choices to the existing semantic planner, which can explain/highlight, map natural answers to a closed choice, or clarify ambiguity. Confirmed selection invokes the actual UI/service callback; Next/Back/correction save current answers and update the screen. A seven-day account/plan bookmark stores only a step key, never answer/note text, and reloads authoritative answers on return.

Old-version plans stop after a state change. `POST /api/agent/copilot/continue` verifies active owned session, issued plan, persisted successful local transition receipt, exact latest context and a maximum of four continuation generations. Atomic plan JSON compare-and-swap plus cached success/failure prevents duplicate provider calls. Existing planner/grounder receive an explicitly labelled server workflow event, not an invented user message. Follow-up can only read/explain/highlight/focus/scroll; it cannot navigate, select, advance, call backend capabilities or save memory. Flutter appends assistant guidance only and suppresses stale/paused/account-changed responses.

Care Gaps reuses actual loaded gap action type and linked plan/question metadata to open the real related plan/schedule/Reality Check view. Exact registered cards can highlight. The reference fixture delays the actual destination question fetch and verifies navigation receipt completion waits for that plan's real mounted question. Four-second loading timeout preserves an honest completed navigation; it does not certify loaded content or retry navigation. Later changes still fence stale guidance, so a fresh user turn may be needed after a slow load. Account invalidation cancels the wait. No fake business operation is introduced.

## Receipts and verification

Issued plans are persisted before they are emitted. UI receipts bind authenticated user, active Agent session, issued plan/action/target, modality, observed before/after generations, safe fixed result code, empty sanitized arguments, optional client-claimed confirmation reference and workflow reference. Unique keys preserve original outcome/metadata on duplicate receipt submission. Successful receipts must match the issued starting version; stale rejections/cancellations remain auditable.

`backendConfirmed` is always false for these UI receipts. A client callback/receipt is never authoritative proof of persisted patient/business state. Existing service responses and backend action receipts retain their separate authority. Failure to persist a UI receipt does not replay a callback; continuation fails closed without its receipt. Navigation/review is not reported as conflict resolution.

## Structured memory

Memory kinds are `CONFIRMED_FACT`, `USER_PREFERENCE`, and `INFERRED_PATTERN`. Closed nonclinical schemas cover communication/explanation/voice/accessibility/workflow preferences, availability windows, routine barriers and caregiver preference. Model output may propose confirmed/preference memory but cannot persist it; the user reviews and confirms the structured value first. Same-key confirmed corrections supersede contradictory active facts/preferences with history retained.

Authenticated APIs provide create, explicit confirm, supersede, deactivate and bounded retrieval. User-row transaction locking serializes same-account corrections; every read/update is user scoped. Planner retrieval records `lastUsedAt`, excludes expired/unrelated/malformed records and returns at most eight items (review maximum 12). Review itself does not mark items as planner use.

Actual successful multi-day performance results can produce a separate, unconfirmed `routine.missed_pattern`, with verified event reference, seven-day expiry, confidence and `timeOfDay:any` rather than invented time-of-day information. Identical evidence/value is not inserted again. Single-day summaries, UI context, model prose and unsupported/failed reads cannot produce this memory. Optional memory storage failure never changes a real Agent result.

## Verified conflicts and suggestions

The deterministic engine accepts only server tool execution results and active confirmed constraints. Production adapters cover pending task timing/overlap, unresolved gaps, unanswered Reality Check and multi-day missed patterns. Clinical `medicine`/`medication` timing/overlap flags require professional review. Normalized caregiver/follow-up rules exist, but need additional authoritative tool adapters before claiming all production coverage.

Only supplied verified conflicts enter grounding. Structured cards expose closed allowed resolutions and relevant current targets, using real registered navigation. No model-created conflict object or autonomous clinical resolution is accepted. Stable routine barriers are memory hints; they are not proof of a clinical conflict.

## Database migration and APIs

Operator-run migration: `node migrate_agent_copilot.js`. It creates/verifies `agent_memory`, `agent_copilot_contexts`, `agent_copilot_plans`, and `agent_copilot_receipts`, with unsigned BIGINT foreign IDs matching existing users/sessions, scoped indexes, cascade rules and receipt uniqueness. Context version uses ASCII binary collation. It checks foundation ID types before DDL and fails loudly for incompatible pre-existing tables. It does not silently ALTER an earlier development schema. **No migration or real MySQL test was executed.**

Required migration environment names: `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`; optional `DB_PORT` defaults to 3306. Never run using the current production Hostinger environment. Supply authorized disposable development credentials through the operator's secure environment, verify the destination, then migrate twice to validate repeatability. An older experimental Copilot schema requires a separately reviewed ALTER/recreation plan in that disposable database.

Authenticated, rate-limited, `Cache-Control:no-store` endpoints:

- `POST /api/agent/copilot/context`
- `POST /api/agent/copilot/receipts`
- `POST /api/agent/copilot/continue`
- `GET /api/agent/copilot/memory`
- `POST /api/agent/copilot/memory`
- `POST /api/agent/copilot/memory/:memoryId/confirm`
- `POST /api/agent/copilot/memory/:memoryId/supersede`
- `DELETE /api/agent/copilot/memory/:memoryId`

## Validation

Earlier runs are not added together. Final backend focused suite: **98/98**, exit 0. Latest complete backend run: **266/266** reported Node tests across **37** root test files, exit 0. Some legacy files are wrappers with their own assertion counts, so 266 is the runner's reported count rather than a fabricated sum of all legacy assertions. Full output is saved in the task workspace `phase_2_backend_full_tests.log`.

Final Flutter Copilot run: **28/28 reported assertions pass** across the ten new Copilot test files, including the delayed real-screen navigation fixture. The terminal runner prints `All tests passed!`, then exits 1; this is not a clean process success. Earlier fixture failures were fixed: memory tests needed the real LanguageScope, and the global-host fixture needed to register its actual dashboard destination and navigation observer. These four corrected tests also independently reported passing, followed by native Windows `0xC0000008`.

The final full `flutter test --no-pub` and existing Agent/voice/language regression attempt could not produce a final assertion count: Windows Dart exits before test output. A direct cached Flutter CLI subprocess records native exit **3221225480 (`0xC0000008`)**. `flutter analyze --no-pub` initially encountered analysis-server/native startup crashes; a later run completed analysis with **zero errors/warnings and 44 brace-style informational notices**, then exited with the same native code. All 44 notices were corrected in ten Phase 2 files with `dart fix --apply --code=curly_braces_in_flow_control_structures`, which reported all 44 fixes. Subsequent Flutter CLI full-test/analysis attempts again failed natively at startup (one analysis attempt also reported waiting for the shared startup lock). Final direct SDK `dart analyze` reported **`No issues found!`**, followed by terminal exit **1**. Thus static issue cleanup is verified, but no clean Flutter CLI process exit is claimed. Terminal and cached CLI invocations were attempted without changing SDK security, test expectations or provider configuration to suppress the failure. Brace-only cleanup happened after the 28-assertion run; broader post-cleanup runtime validation remains unconfirmed.

Commands used for the final focused Flutter assertions:

```powershell
flutter test --no-pub test/copilot_test.dart test/copilot_protocol_test.dart test/copilot_service_test.dart test/copilot_workflow_test.dart test/copilot_reality_check_test.dart test/copilot_care_gap_test.dart test/copilot_global_host_test.dart test/copilot_conflict_test.dart test/copilot_lifecycle_test.dart test/copilot_memory_test.dart
```

The additional existing Flutter regressions were selected from `test/*_test.dart` whose basename matches `^(copilot|agent_|voice_|language_controller)` and invoked with the same `flutter test --no-pub` command. They remain unconfirmed in the final run because the Dart process exited before assertions. The full suite was also invoked with `--reporter expanded` for diagnostics. Cached CLI equivalent: `C:\flutter\bin\cache\dart-sdk\bin\dart.exe --packages=C:\flutter\packages\flutter_tools\.dart_tool\package_config.json C:\flutter\bin\cache\flutter_tools.snapshot test --no-pub --reporter expanded`.

Both repositories' final `git diff --check` pass with only existing CRLF normalization warnings. Baseline SHA-256 comparison, HEAD verification and empty-index checks pass as described above. An earlier backend broad run had two `fetch` failures caused by sandbox `EACCES 127.0.0.1`; the same tests passed after granting localhost network permission. No production provider/DB calls were used.

## Remaining acceptance / limits

- No authorized disposable MySQL, development provider backend or live Android environment is available. Migration execution/repeatability, real-provider semantic mapping and full Android -> LiveKit -> Worker -> Agent -> UI/TTS E2E remain unverified.
- Most app areas have main-section coverage, not individual task/profile/document/Simulation/Progress controls. See the capability matrix; unsupported controls are deliberately not actionable.
- Selection/Next are separate confirmed operations across screen generations. There is no autonomous chain of consequential writes; user turns supply new choice/advance intent.
- Continuation narration is returned to shared text history/UI. No new Worker TTS path was added for this extra narration; actual realtime response speech remains the existing Worker path. Automatic continuation spoken narration is not claimed.
- Memory review/revocation and correction APIs exist; a full dedicated structured-edit form is not added. Correction proposals supersede after explicit confirmation.
- Initial voice startup may precede the debounced first semantic-context publication. Missing/stale UI capabilities fail closed; real first-turn voice context timing needs Android validation.
- Clean final Flutter validation is blocked by intermittent Windows Dart `0xC0000008`. The 44 style notices were corrected and direct `dart analyze` reports no issues, but tool processes still exit nonzero. Test assertion results and process exit codes are reported separately above.
- No Undo for persisted answers/business writes; correction is a confirmed new save.
- Conflict review navigation does not close/resolve a gap. Actual supported resolution/save must succeed through existing services, and current data must be re-read before claiming resolution.

## Commands and real validation prerequisites

Do not execute production commands until explicitly authorized. No Worker redeploy/provider/credential change is needed for these client/backend protocol additions.

Local mocked verification:

```powershell
Set-Location 'C:\Users\Zain\OneDrive\Desktop\sehatmate_api'
node --test agent_ui_protocol_test.js agent_ui_planner_test.js agent_copilot_integration_test.js agent_phase2_memory_test.js agent_workflow_test.js
$testFiles = Get-ChildItem -File -Filter '*_test.js' | Select-Object -ExpandProperty Name
node --test @testFiles
git diff --check

Set-Location 'C:\Users\Zain\OneDrive\Desktop\sehatroute_flutter'
flutter analyze --no-pub
flutter test --no-pub
git diff --check
```

Authorized development setup, **only after destination/environment review**:

```powershell
Set-Location 'C:\Users\Zain\OneDrive\Desktop\sehatmate_api'
# Supply DB_HOST / DB_NAME / DB_USER / DB_PASSWORD for disposable development MySQL.
# Verify these override any production .env before executing either command.
node migrate_agent_copilot.js
node migrate_agent_copilot.js
npm start

Set-Location 'C:\Users\Zain\OneDrive\Desktop\sehatroute_flutter'
flutter devices
flutter run -d <authorized-android-device-id>
```

Android checklist: approved development API URL/auth account and current development provider environment; grant microphone permission; confirm shared text/voice language switch, mute/manual/reconnect/barge-in; open Agent from Dashboard/Progress/Reality Check/Care Gaps; verify history through navigation and minimization; explain/highlight actual question and choices; test ambiguous answer; approve/decline selection; inspect actual answer persistence; Next/read-only narration/Back/correction; navigate away/return; mutate screen while awaiting plan/confirmation; pause/cancel/resume; open real gap-linked question, save and re-read actual gap state; save/correct/revoke memory then switch accounts; verify no stale actions/old account context. Confirm receipt data distinguishes client completion from authoritative service outcomes. Do not claim live success from fixture tests.

## Final file inventory and preservation

Backend Phase 2 files (relative to `C:\Users\Zain\OneDrive\Desktop\sehatmate_api`):

```text
agent/agent_core.js
agent/agent_navigation_registry.js
agent/agent_planner.js
agent/agent_response_grounder.js
agent/agent_semantic_routes.js
server.js
services/agent_turn_service.js
agent/agent_conflicts.js
agent/agent_copilot_routes.js
agent/agent_copilot_schema.js
agent/agent_copilot_store.js
agent/agent_memory.js
agent/agent_ui_protocol.js
agent/agent_workflow.js
agent_copilot_integration_test.js
agent_copilot_test_db.js
agent_phase2_memory_test.js
agent_ui_planner_test.js
agent_ui_protocol_test.js
agent_workflow_test.js
migrate_agent_copilot.js
PHASE_2_IMPLEMENTATION_PLAN.md
PHASE_2_CAPABILITY_MATRIX.md
PHASE_2_AGENT_COPILOT_REPORT.md
```

`services/agent_turn_service.js` was already dirty: Phase 2 adds only `uiPlan`, `memoryProposal` and `conflicts` to the existing encrypted result allowlist. All prior latency/reliability changes remain. Pre-existing `voice_backend_test.js`, earlier reports and every `voice-worker/` item remain unchanged relative to the initial local baseline and are not Phase 2 changes.

Flutter Phase 2 files (relative to `C:\Users\Zain\OneDrive\Desktop\sehatroute_flutter`; 12 existing files, nine new implementation files and ten new test files):

```text
lib/app.dart
lib/features/agent/agent_entry.dart
lib/features/agent/controllers/agent_controller.dart
lib/features/agent/models/agent_context.dart
lib/features/agent/models/agent_response.dart
lib/features/agent/navigation/agent_navigation_handler.dart
lib/features/agent/screens/agent_screen.dart
lib/features/agent/voice/voice_companion_controller.dart
lib/features/agent/voice/voice_companion_scope.dart
lib/screens/care_gap_screens.dart
lib/screens/reality_check_screen.dart
lib/widgets/app_shell.dart
lib/features/agent/copilot/copilot.dart
lib/features/agent/copilot/copilot_conflict.dart
lib/features/agent/copilot/copilot_host.dart
lib/features/agent/copilot/copilot_memory_review.dart
lib/features/agent/copilot/copilot_navigation_observer.dart
lib/features/agent/copilot/copilot_screen_adapter.dart
lib/features/agent/copilot/copilot_service.dart
lib/features/agent/copilot/copilot_strings.dart
lib/features/agent/copilot/copilot_workflow_store.dart
test/copilot_care_gap_test.dart
test/copilot_conflict_test.dart
test/copilot_global_host_test.dart
test/copilot_lifecycle_test.dart
test/copilot_memory_test.dart
test/copilot_protocol_test.dart
test/copilot_reality_check_test.dart
test/copilot_service_test.dart
test/copilot_test.dart
test/copilot_workflow_test.dart
```

`lib/widgets/app_shell.dart` retains its pre-existing launcher/navigation/polish changes; Phase 2 adds the semantic wrapper, adapter input and precise context route mapping. The other seven pre-existing dirty Flutter files remain byte-identical, including language strings/selector work and `.flutter-plugins-dependencies`. No dependency/plugin/lockfile update was required by Phase 2. Nothing is staged; both HEADs remain at the original baseline commits.
