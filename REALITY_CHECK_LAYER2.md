# Reality Check Layer 2 — Persistence and Versioning

Layer 2 stores validated AI-generated Reality Check questions without replacing the current live fixed-question flow yet.

## What this layer adds

- `care_reality_question_sets`: one versioned question set per care plan/user generation.
- `care_reality_questions`: the validated questions belonging to each set.
- Stable question keys based on practical concern metadata (`intent + target tasks + period + response profile`), not AI wording.
- A deterministic SHA-256 context hash covering verified instructions, generated schedule, routine profile, and known reality facts.
- Reuse of the active question set by default.
- Explicit refresh behavior for later layers when verified instructions or schedule materially change.
- Historical sets are retained as `retired` instead of being deleted.
- If regeneration fails or returns no safe questions, an existing active set is preserved.

## Safety behavior

Layer 2 persists only questions that already passed Layer 1 validation. It does not score answers, modify medical instructions, adapt reminders, affect Simulation, create Care Gaps, or change activation eligibility.

## Important refresh rule

A changed context hash does **not** automatically replace the active set. Later integration should call `getOrCreateRealityQuestionSet(..., refreshIfContextChanged: true)` only after a deliberate material change such as a verified instruction or schedule update. This avoids regeneration loops caused by routine-learning changes that originate from Reality Check answers themselves.

## Database setup

The API startup now runs `ensureRealityCheckPersistenceSchema(pool)`. The equivalent standalone SQL is in `reality_check_layer2_migration.sql`.

## Tests

Run:

```bash
npm run test:reality-layer2
```

Layer 1 can still be tested separately with:

```bash
npm run test:reality-layer1
```
