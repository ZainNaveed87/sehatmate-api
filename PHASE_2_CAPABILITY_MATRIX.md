# Phase 2 capability matrix

This describes implemented capabilities, not deployment or real-device certification. Backend facts continue to come from the existing authenticated READ tools; client labels describe UI only. No screen coordinates, reflection or arbitrary methods/routes are executable.

**Scope:** the global host and shared shell adapter provide current-screen title/context and a main-content anchor. A main anchor is not per-control coverage. Only Reality Check and Care Gaps have detailed adapters in this pass. Tier 0 = read/highlight/focus/scroll; Tier 1 = registered navigation; Tier 2 = explicit confirmation before persistence; Tier 3 = forbidden autonomous clinical/destructive changes.

| Screen/workflow | Readable | Highlightable | Navigable | Actionable | Tier | Implemented coverage / limits |
|---|---|---|---|---|---|---|
| Dashboard (`home`) | Title; existing authoritative summaries when requested | Main content | Yes | Main read/reveal; closed screen navigation | 0/1 | Shared shell; launcher/history navigation widget test |
| Calendar / today (`today`) | Title; existing task READ tools | Main content | Yes | Read/reveal/navigation | 0/1 | Task completion remains existing authenticated draft/confirmation path, not arbitrary UI automation |
| Care Plans (`care_plans`) | Title; owned plan READ tools | Main content | Yes | Read/reveal/navigation | 0/1 | Individual plan cards not yet semantic anchors |
| Care Plan detail (`care_plan_detail`) | Title, owned entity reference; existing plan/task READ tools | Main content | Yes, ownership-authorized entity intent | Read/reveal/navigation | 0/1; existing write confirmation | Medication dose/timing, delete, arbitrary edit and task button automation not exposed |
| Reality Check (`reality_check`) | Actual current question, complete bounded choice set and selected state | Question, each registered choice, main content | Yes, optional verified plan; Care Gap can open exact linked question | Actual registered select / Next / Previous callbacks | 0; 2 for autosave/select/advance/back | Natural answer mapping uses existing planner + closed choices. Confirmed saves use actual service. Back/correction/bookmark tested. New step read-only narration uses receipted continuation |
| Care Gaps (`care_gaps`) | Actual first four visible gap titles; backend gaps READ for verified facts | Exact registered gap card + main | Yes | Read/highlight; actual gap's closed related-plan/schedule/Reality Check callback | 0/1 | Four-card context cap; no synthetic gap or invented resolution |
| Care Gap detail (`care_gap_detail`) | Exact loaded gap UI; existing owned gap READ | Exact gap card + main | Yes, owned gap intent | Same loaded gap's registered related workflow callback | 0/1 | Existing server-derived action type selects the real screen/linked question |
| Progress (`progress`) | Title; authoritative performance tools | Main content | Yes | Read/reveal/navigation | 0/1 | Per-metric `progress.adherence` / missed-task anchors not yet registered |
| Simulation (`simulation`) | Title; existing simulation READ | Main content | Yes | Read/reveal/navigation | 0/1 | Individual finding controls are not automated |
| Routine preferences (`routine_settings`) | Title; existing preference READ | Main content | Yes | Read/reveal/navigation | 0/1; existing writes confirmed | Agent does not change prescribed/fixed medicine times |
| Profile (`profile`) | Title; existing supported profile READ | Main content | Yes | Read/reveal/navigation | 0/1 | No arbitrary personal/clinical field writes |
| Settings (`settings`) | Title and registered context | Main content | Yes | Read/reveal/navigation | 0/1 | Sensitive settings/account deletion not automated |
| Family Care (`family_care`) | Title; verified family relationship tools | Main content | Yes | Read/reveal/navigation | 0/1; existing caregiver writes confirmed | No consent/relationship mutations from UI proposals |
| Family member detail | Title; relationship reference verified by existing services | Main content | Yes, relationship-authorized intent | Read/reveal/navigation | 0/1 | Relationship IDs stay distinct from patient/plan IDs |
| Family member plan / gap / simulation views | Relationship-scoped existing backend READ tools | Shared shell main where mounted | Existing semantic aliases open member surface | Read/reveal/navigation | 0/1 | No claim of separate detailed per-control adapters; family plan context must use relationship, not plan ID |
| Documents list (`documents`) | Title; existing owned plan/document summaries | Main content | Yes | Read/reveal/navigation | 0/1 | Upload, raw document content extraction, viewer controls and deletion are not UI-executable |
| Notifications (`notifications`) | Title / supported app context | Main content | Yes | Read/reveal/navigation | 0/1 | No bulk dismiss/delete or reminder scheduling automation |
| Agent memory review | Structured values, confirmed vs inferred status | Standard accessible review UI | Global Agent memory control | Explicit save, forget; same-key confirmed corrections supersede through API/proposal | Explicit user choice | Account-scoped; inferred confirmation/supersede APIs exist; no arbitrary JSON/medical memory |
| Care-plan create/upload/review; Family invite | Shared host where authenticated; no invented entity reference | At most parent/main context | Existing normal app routes | Manual existing UI only | No new automation | Special route words must never become entity IDs |
| Document viewer / onboarding / other unregistered routes | No actionable inherited context | No old-screen spotlight | Normal app only | None through Copilot registry | Unavailable | Page transition clears stale registry; PopupRoute confirmation retains current context |

## Workflow and safety coverage

- A plan contains at most four exact registered action/target pairs with empty model arguments. Every operation is fenced by account, screen, current generation and cancellation generation. Same issued plan/operation is deduplicated.
- Changing UI state ends execution of the old plan. A persisted successful transition receipt plus freshly synced context permits a read-only continuation, capped at four generations; cached results prevent duplicate provider calls. Continuation cannot select, advance, navigate, write backend data or save memory.
- Reality Check selection and Next are separate consequential operations because the existing UI persists answers. Each is confirmed against current state; a second action is never silently carried across a version change.
- Care Gap -> linked Reality Check -> confirmed answer/correction reuses real loaded gap metadata and actual screen callbacks. Navigation waits up to four seconds for that exact plan's mounted real question; timeout never replays navigation, and later stale guidance is rejected. Fixtures validate delayed navigation and separate actual Reality Check saves; live DB/provider/device validation remains pending.
- Verified conflicts expose only registered resolution choices: review routine/reminders/caregiver, open the relevant gap/Reality Check, keep current setup, or professional review. Navigation is not a claim that the conflict was resolved.
- Undo is not offered for persisted Reality Check answers or backend writes. Back/correction are new confirmed saves. Highlight expiry/minimization are reversible UI behavior.

## Validation limits

Focused mocked/unit/widget assertions validate protocol/executor, real screen callback integration, account separation, accessibility and shared text/voice response contracts. The final 28 Copilot assertions pass, followed by a nonzero runner exit. Direct `dart analyze` reports no issues after style cleanup, also followed by terminal exit 1; final full Flutter / existing voice regressions and clean Flutter CLI process exits are blocked by intermittent Windows Dart `0xC0000008`. There is no authorized disposable MySQL / provider backend / Android live environment available. No migration, production DB access, real LiveKit/OpenRouter/Deepgram/Fish call, deployment, commit, push or staging was performed.

See `PHASE_2_AGENT_COPILOT_REPORT.md` for exact final test counts, file inventory and remaining acceptance work.
