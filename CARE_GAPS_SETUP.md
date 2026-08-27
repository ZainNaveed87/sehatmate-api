# Care Gaps backend setup

This package adds the Care Gap engine without replacing the existing care-plan, schedule, Reality Check, or simulation flow.

## 1. Install dependencies

```bash
npm install
```

## 2. Run the one-time Care Gap database migration

Use the same `.env` database settings as the API, then run:

```bash
npm run migrate:care-gaps
```

The migration is safe to run again. It adds Care Gap metadata such as type, severity, lifecycle state, source tracking, due date, and auto-managed status.

## 3. Start the API

```bash
npm start
```

## Added behavior

The engine automatically creates or resolves gaps for:

- missing source care documents
- pending or unclear instruction verification
- verified follow-up/lab instructions missing from the schedule
- schedule items that still need an exact time
- unanswered required Reality Check questions
- tasks that explicitly require caregiver/support when no caregiver is linked

Reality Check answers that are merely `At Risk` stay in Simulation; they are not duplicated as Care Gaps.

## Activation rule

Only unresolved Care Gaps with `severity = blocking` block activation. `attention` gaps remain visible but do not block activation by themselves. Existing Simulation/Reality Check activation checks still apply.

## Care Gap API

- `GET /api/care-plans/:id/care-gaps`
- `POST /api/care-plans/:id/care-gaps/refresh`
- `GET /api/care-gaps/:id`
- `PATCH /api/care-gaps/:id`
- `POST /api/care-gaps/:id/doctor-question`
- `PATCH /api/doctor-questions/:id`

Auto-managed gaps cannot be manually forced to Resolved while their underlying problem still exists. Fixing the source item and refreshing the plan resolves them automatically.
