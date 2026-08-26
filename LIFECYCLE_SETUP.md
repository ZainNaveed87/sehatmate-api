# Care-plan lifecycle setup

1. Import `care_plan_lifecycle_migration.sql` once in the same MySQL database used by the API.
2. Push `server.js`, `ai_service.js`, `package.json`, `package-lock.json`, and the migration to GitHub.
3. Redeploy the Hostinger Node.js app.
4. Confirm that `/health` returns `database: connected`.

The API now supports prescription-derived, custom, and ongoing plan durations; automatic completion after the planned end date; manual completion; and single/bulk deletion for every plan state.

Fixed medicine durations are never converted into lifetime instructions. Ongoing controls the care plan only.
