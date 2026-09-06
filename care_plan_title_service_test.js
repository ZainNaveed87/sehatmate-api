import assert from 'node:assert/strict';

import {
  CARE_PLAN_TITLE_EXISTS,
  createCarePlan,
  ensureCarePlanTitleSchema,
  renameCarePlan,
  validateCarePlanTitle,
} from './services/care_plan_title_service.js';

const USER = '42';
const OTHER_USER = '99';

let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function duplicateError() {
  const error = new Error('Duplicate entry for care_plan_title_key_unique');
  error.code = 'ER_DUP_ENTRY';
  error.errno = 1062;
  error.sqlState = '23000';
  return error;
}

function baseRow(overrides) {
  return {
    id: overrides.id,
    user_id: overrides.user_id ?? USER,
    title: overrides.title,
    title_key: overrides.title_key ?? null,
    status: overrides.status ?? 'draft',
    start_date: null,
    readiness_score: 0,
    understanding_score: 0,
    activated_at: null,
    completed_at: null,
    completion_reason: null,
    completed_by: null,
    duration_mode: 'prescription',
    suggested_end_date: null,
    planned_end_date: null,
    document_count: 0,
    task_count: 0,
    open_gap_count: 0,
    setup_step: 'upload',
    created_at: null,
    updated_at: null,
  };
}

function createDb({
  plans = [],
  enforceUnique = true,
  hasTitleKeyColumn = true,
  hasUniqueIndex = true,
} = {}) {
  let titleKeyColumn = hasTitleKeyColumn;
  let uniqueIndex = hasUniqueIndex;
  const rows = plans.map((plan, index) => baseRow({ id: index + 1, ...plan }));
  const calls = [];
  let nextId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1;

  function duplicateFor({ userId, titleKey, excludePlanId = null }) {
    return rows.find((row) =>
      String(row.user_id) === String(userId) &&
      row.title_key === titleKey &&
      (excludePlanId == null || String(row.id) !== String(excludePlanId)));
  }

  return {
    calls,
    get plans() {
      return rows;
    },
    async execute(sql, params = []) {
      const text = normalizeSql(sql);
      calls.push({ sql: text, params });

      if (text.includes('FROM information_schema.COLUMNS')) {
        return [titleKeyColumn ? [{ COLUMN_NAME: 'title_key' }] : []];
      }

      if (text.startsWith('ALTER TABLE care_plans ADD COLUMN title_key')) {
        titleKeyColumn = true;
        return [{ affectedRows: 0 }];
      }

      if (text.startsWith('SELECT id, title, title_key FROM care_plans')) {
        return [rows.map((row) => ({
          id: row.id,
          title: row.title,
          title_key: row.title_key,
        }))];
      }

      if (text.startsWith('UPDATE care_plans SET title_key = ? WHERE id = ?')) {
        const row = rows.find((item) => String(item.id) === String(params[1]));
        if (row) row.title_key = params[0];
        return [{ affectedRows: row ? 1 : 0 }];
      }

      if (text.startsWith('SELECT user_id, title_key, COUNT(*) AS duplicate_count')) {
        const groups = new Map();
        for (const row of rows.filter((item) => item.title_key != null)) {
          const key = `${row.user_id}:${row.title_key}`;
          const group = groups.get(key) || {
            user_id: row.user_id,
            title_key: row.title_key,
            rows: [],
          };
          group.rows.push(row);
          groups.set(key, group);
        }
        return [[...groups.values()]
          .filter((group) => group.rows.length > 1)
          .map((group) => ({
            user_id: group.user_id,
            title_key: group.title_key,
            duplicate_count: group.rows.length,
            plans: group.rows.map((row) => `${row.id}:${row.title}`).join(' || '),
          }))];
      }

      if (text.includes('FROM information_schema.STATISTICS')) {
        return [uniqueIndex ? [{ INDEX_NAME: 'care_plan_title_key_unique' }] : []];
      }

      if (text.startsWith('ALTER TABLE care_plans ADD UNIQUE KEY care_plan_title_key_unique')) {
        uniqueIndex = true;
        return [{ affectedRows: 0 }];
      }

      if (
        text.startsWith('SELECT id FROM care_plans WHERE user_id = ? AND title_key = ?')
      ) {
        const duplicate = duplicateFor({
          userId: params[0],
          titleKey: params[1],
          excludePlanId: text.includes('AND id <> ?') ? params[2] : null,
        });
        return [duplicate ? [{ id: duplicate.id }] : []];
      }

      if (text.startsWith('INSERT INTO care_plans')) {
        if (
          enforceUnique &&
          duplicateFor({ userId: params[0], titleKey: params[2] })
        ) {
          throw duplicateError();
        }
        const id = nextId++;
        rows.push(baseRow({
          id,
          user_id: params[0],
          title: params[1],
          title_key: params[2],
          status: 'draft',
        }));
        return [{ affectedRows: 1, insertId: id }];
      }

      if (text.startsWith('SELECT * FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1')) {
        const row = rows.find((item) =>
          String(item.id) === String(params[0]) &&
          String(item.user_id) === String(params[1]));
        return [row ? [row] : []];
      }

      if (text.startsWith('SELECT id FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1')) {
        const row = rows.find((item) =>
          String(item.id) === String(params[0]) &&
          String(item.user_id) === String(params[1]));
        return [row ? [{ id: row.id }] : []];
      }

      if (text.startsWith('UPDATE care_plans SET title = ?')) {
        if (
          enforceUnique &&
          duplicateFor({
            userId: params[3],
            titleKey: params[1],
            excludePlanId: params[2],
          })
        ) {
          throw duplicateError();
        }
        const row = rows.find((item) =>
          String(item.id) === String(params[2]) &&
          String(item.user_id) === String(params[3]));
        if (row) {
          row.title = params[0];
          row.title_key = params[1];
        }
        return [{ affectedRows: row ? 1 : 0 }];
      }

      throw new Error(`Unexpected SQL: ${text}`);
    },
  };
}

await test('create "Morning Plan" succeeds with normalized title', async () => {
  const db = createDb();
  const result = await createCarePlan({
    db,
    userId: USER,
    title: '  Morning   Plan  ',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.plan.title, 'Morning Plan');
  assert.equal(result.data.plan.title_key, 'morning plan');
});

await test('duplicate same user returns stable 409 code', async () => {
  const db = createDb({
    plans: [{ title: 'Morning Plan', title_key: 'morning plan' }],
  });
  const result = await createCarePlan({ db, userId: USER, title: 'Morning Plan' });

  assert.equal(result.ok, false);
  assert.equal(result.code, CARE_PLAN_TITLE_EXISTS);
  assert.equal(result.message, 'A care plan with this name already exists.');
});

await test('"morning plan" is a duplicate for the same user', async () => {
  const db = createDb({
    plans: [{ title: 'Morning Plan', title_key: 'morning plan' }],
  });
  const result = await createCarePlan({ db, userId: USER, title: 'morning plan' });

  assert.equal(result.ok, false);
  assert.equal(result.code, CARE_PLAN_TITLE_EXISTS);
});

await test('"  Morning   Plan " is a whitespace-normalized duplicate', async () => {
  const db = createDb({
    plans: [{ title: 'Morning Plan', title_key: 'morning plan' }],
  });
  const result = await createCarePlan({
    db,
    userId: USER,
    title: '  Morning   Plan ',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CARE_PLAN_TITLE_EXISTS);
});

await test('different user may create the same normalized name', async () => {
  const db = createDb({
    plans: [{ title: 'Morning Plan', title_key: 'morning plan', user_id: USER }],
  });
  const result = await createCarePlan({
    db,
    userId: OTHER_USER,
    title: 'morning plan',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.plan.user_id, OTHER_USER);
});

await test('completed plan still blocks duplicate names', async () => {
  const db = createDb({
    plans: [{
      title: 'Morning Plan',
      title_key: 'morning plan',
      status: 'completed',
    }],
  });
  const result = await createCarePlan({ db, userId: USER, title: 'Morning Plan' });

  assert.equal(result.ok, false);
  assert.equal(result.code, CARE_PLAN_TITLE_EXISTS);
});

await test('empty, one-character, and oversized names are rejected', async () => {
  assert.equal(validateCarePlanTitle('   ').ok, false);
  assert.equal(validateCarePlanTitle('A').ok, false);
  assert.equal(validateCarePlanTitle('A'.repeat(81)).ok, false);

  const db = createDb();
  const result = await createCarePlan({ db, userId: USER, title: 'A'.repeat(81) });
  assert.equal(result.ok, false);
  assert.equal(db.plans.length, 0);
});

await test('concurrent duplicate create cannot insert two same-name plans', async () => {
  const db = createDb({ enforceUnique: true });
  const results = await Promise.all([
    createCarePlan({ db, userId: USER, title: 'Morning Plan' }),
    createCarePlan({ db, userId: USER, title: 'morning   plan' }),
  ]);

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(
    results.filter((result) => result.code === CARE_PLAN_TITLE_EXISTS).length,
    1,
  );
  assert.equal(
    db.plans.filter((plan) => plan.title_key === 'morning plan').length,
    1,
  );
});

await test('rename follows the same uniqueness rules', async () => {
  const db = createDb({
    plans: [
      { id: 1, title: 'Morning Plan', title_key: 'morning plan' },
      { id: 2, title: 'Evening Plan', title_key: 'evening plan' },
    ],
  });
  const duplicate = await renameCarePlan({
    db,
    userId: USER,
    planId: '2',
    title: '  morning   plan ',
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, CARE_PLAN_TITLE_EXISTS);

  const renamed = await renameCarePlan({
    db,
    userId: USER,
    planId: '2',
    title: 'Night Plan',
  });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.data.plan.title, 'Night Plan');
  assert.equal(renamed.data.plan.title_key, 'night plan');
});

await test('rename enforces ownership', async () => {
  const db = createDb({
    plans: [{ id: 1, title: 'Morning Plan', title_key: 'morning plan' }],
  });
  const result = await renameCarePlan({
    db,
    userId: OTHER_USER,
    planId: '1',
    title: 'Other User Name',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PLAN_NOT_FOUND');
  assert.equal(db.plans[0].title, 'Morning Plan');
});

await test('schema guard reports existing duplicates without changing visible titles', async () => {
  const db = createDb({
    hasTitleKeyColumn: false,
    hasUniqueIndex: false,
    plans: [
      { id: 1, user_id: USER, title: 'Morning Plan' },
      { id: 2, user_id: USER, title: '  morning   plan  ' },
    ],
  });

  const result = await ensureCarePlanTitleSchema({ db });

  assert.equal(result.ok, false);
  assert.equal(result.code, CARE_PLAN_TITLE_EXISTS);
  assert.equal(result.duplicateGroups.length, 1);
  assert.equal(db.plans[0].title, 'Morning Plan');
  assert.equal(db.plans[1].title, '  morning   plan  ');
  assert.ok(
    !db.calls.some((call) =>
      call.sql.startsWith('ALTER TABLE care_plans ADD UNIQUE KEY')),
  );
});

console.log(`Care plan title service tests passed: ${passed}`);
