# Reality Check Layer 3 — Decision Compatibility

Layer 3 connects persisted AI-generated Reality Check questions to the existing deterministic decision chain without giving the AI control over risk scores, schedule changes, activation, or medical decisions.

## What changed

- Added `reality_check_decision.js` as the deterministic bridge between AI question metadata and app behavior.
- The live Reality Check GET endpoint now creates/reuses the persisted Layer 2 question set and returns it in the existing option-based API shape.
- Answer validation and risk scoring are deterministic from `responseProfile`; the AI cannot supply points.
- Schedule adaptations use explicit `targetTaskIds` instead of guessing from question wording or fixed question keys.
- Routine Learning receives `intent`, `responseProfile`, `targetTaskIds`, and `period` metadata.
- Simulation ignores stale answers from retired/legacy question sets when an active generated set exists.
- Care Gaps and activation completeness use the active persisted question set when present.
- Legacy fixed questions remain a compatibility fallback if no persisted generated set is available.

## No database migration in Layer 3

Layer 3 uses the Layer 2 tables already created by `reality_check_layer2_migration.sql`. No additional SQL import is required.

## Safety boundary

The AI generates practical questions only. The backend still owns:

- allowed answer profiles
- risk points
- downstream action type
- task targeting validation
- schedule adaptation rules
- Care Gap blocking
- activation eligibility

An explicit verified medical time is never moved automatically by this layer.

## Test

```bash
npm run test:reality-layer3
```

For regression checks, also run Layer 1 and Layer 2 tests.
