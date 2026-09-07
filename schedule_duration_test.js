import assert from 'node:assert/strict';

import {
  saveScheduleItemDuration,
} from './services/schedule_duration_service.js';

const OK_PACKET = {
  affectedRows: 1,
  insertId: 0,
};

function createFakePool(respond) {
  const calls = [];

  const execute = async (sql, params = []) => {
    const text = String(sql)
      .replace(/\s+/g, ' ')
      .trim();

    calls.push({
      sql: text,
      params,
    });

    const custom = respond
      ? respond(text, params)
      : undefined;

    if (custom !== undefined) {
      return custom;
    }

    return /^SELECT/i.test(text)
      ? [[]]
      : [OK_PACKET];
  };

  return {
    execute,
    calls,
  };
}

function matchingCalls(pool, pattern) {
  return pool.calls.filter(
    (call) => pattern.test(call.sql),
  );
}

const USER_ID = '42';

function medicineBaseRow(overrides = {}) {
  return {
    id: 10,
    care_plan_id: 5,
    instruction_id: 100,
    task_kind: 'medicine',
    schedule_date: '2026-09-07',
    plan_status: 'reality_check',
    start_date: '2026-09-07',
    activated_at: null,
    planned_end_date: '2026-09-12',
    category: 'medicine',
    ...overrides,
  };
}

function medicineSlots({
  days = null,
  source = null,
} = {}) {
  return [
    {
      id: 10,
      instruction_duration_days: days,
      instruction_duration_source: source,
    },
    {
      id: 11,
      instruction_duration_days: days,
      instruction_duration_source: source,
    },
    {
      id: 12,
      instruction_duration_days: days,
      instruction_duration_source: source,
    },
    {
      id: 13,
      instruction_duration_days: days,
      instruction_duration_source: source,
    },
  ];
}

let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

await test(
  'custom duration updates every reminder slot for the same medicine instruction',
  async () => {
    const pool = createFakePool((sql) => {
      if (
        /FROM care_schedule_items s JOIN care_plans p/.test(sql)
      ) {
        return [[medicineBaseRow()]];
      }

      if (
        /FROM care_schedule_items WHERE care_plan_id = \? AND user_id = \? AND instruction_id = \?/.test(
          sql,
        )
      ) {
        return [medicineSlots()];
      }

      if (
        /^UPDATE care_schedule_items SET instruction_duration_days/.test(
          sql,
        )
      ) {
        return [{ affectedRows: 4 }];
      }

      return undefined;
    });

    const result = await saveScheduleItemDuration({
      pool,
      userId: USER_ID,
      itemId: '10',
      mode: 'days',
      durationDays: 5,
      today: '2026-09-07',
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.durationDays, 5);
    assert.equal(result.data.source, 'user');
    assert.equal(
      result.data.updatedScheduleItemCount,
      4,
    );

    const updates = matchingCalls(
      pool,
      /^UPDATE care_schedule_items SET instruction_duration_days/,
    );

    assert.equal(updates.length, 1);

    assert.deepEqual(
      updates[0].params,
      [
        5,
        'user',
        5,
        USER_ID,
        '100',
      ],
    );
  },
);

await test(
  'verified prescription duration cannot be replaced by a different user duration',
  async () => {
    const pool = createFakePool((sql) => {
      if (
        /FROM care_schedule_items s JOIN care_plans p/.test(sql)
      ) {
        return [[medicineBaseRow()]];
      }

      if (
        /FROM care_schedule_items WHERE care_plan_id = \? AND user_id = \? AND instruction_id = \?/.test(
          sql,
        )
      ) {
        return [
          medicineSlots({
            days: 7,
            source: 'verified',
          }),
        ];
      }

      return undefined;
    });

    const result = await saveScheduleItemDuration({
      pool,
      userId: USER_ID,
      itemId: '10',
      mode: 'days',
      durationDays: 10,
      today: '2026-09-07',
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.code,
      'VERIFIED_MEDICINE_DURATION_LOCKED',
    );

    assert.equal(
      matchingCalls(
        pool,
        /^UPDATE care_schedule_items/,
      ).length,
      0,
    );
  },
);

await test(
  'saving the same verified duration is an idempotent no-op',
  async () => {
    const pool = createFakePool((sql) => {
      if (
        /FROM care_schedule_items s JOIN care_plans p/.test(sql)
      ) {
        return [[medicineBaseRow()]];
      }

      if (
        /FROM care_schedule_items WHERE care_plan_id = \? AND user_id = \? AND instruction_id = \?/.test(
          sql,
        )
      ) {
        return [
          medicineSlots({
            days: 7,
            source: 'verified',
          }),
        ];
      }

      return undefined;
    });

    const result = await saveScheduleItemDuration({
      pool,
      userId: USER_ID,
      itemId: '10',
      mode: 'days',
      durationDays: 7,
      today: '2026-09-07',
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.source, 'verified');
    assert.equal(result.data.durationDays, 7);
    assert.equal(
      result.data.updatedScheduleItemCount,
      0,
    );

    assert.equal(
      matchingCalls(
        pool,
        /^UPDATE care_schedule_items/,
      ).length,
      0,
    );
  },
);

await test(
  'plan-end mode applies to all reminder slots for the medicine',
  async () => {
    const pool = createFakePool((sql) => {
      if (
        /FROM care_schedule_items s JOIN care_plans p/.test(sql)
      ) {
        return [[
          medicineBaseRow({
            planned_end_date: '2026-09-12',
          }),
        ]];
      }

      if (
        /FROM care_schedule_items WHERE care_plan_id = \? AND user_id = \? AND instruction_id = \?/.test(
          sql,
        )
      ) {
        return [medicineSlots()];
      }

      if (
        /^UPDATE care_schedule_items SET instruction_duration_days/.test(
          sql,
        )
      ) {
        return [{ affectedRows: 4 }];
      }

      return undefined;
    });

    const result = await saveScheduleItemDuration({
      pool,
      userId: USER_ID,
      itemId: '10',
      mode: 'plan_end',
      today: '2026-09-07',
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.mode, 'plan_end');
    assert.equal(result.data.durationDays, null);
    assert.equal(
      result.data.source,
      'user_plan_end',
    );
    assert.equal(
      result.data.updatedScheduleItemCount,
      4,
    );

    const updates = matchingCalls(
      pool,
      /^UPDATE care_schedule_items SET instruction_duration_days/,
    );

    assert.equal(updates.length, 1);

    assert.deepEqual(
      updates[0].params,
      [
        null,
        'user_plan_end',
        5,
        USER_ID,
        '100',
      ],
    );
  },
);

await test(
  'plan-end mode fails safely when the care plan has no end date',
  async () => {
    const pool = createFakePool((sql) => {
      if (
        /FROM care_schedule_items s JOIN care_plans p/.test(sql)
      ) {
        return [[
          medicineBaseRow({
            planned_end_date: null,
          }),
        ]];
      }

      if (
        /FROM care_schedule_items WHERE care_plan_id = \? AND user_id = \? AND instruction_id = \?/.test(
          sql,
        )
      ) {
        return [medicineSlots()];
      }

      return undefined;
    });

    const result = await saveScheduleItemDuration({
      pool,
      userId: USER_ID,
      itemId: '10',
      mode: 'plan_end',
      today: '2026-09-07',
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.code,
      'PLAN_END_REQUIRED',
    );

    assert.equal(
      matchingCalls(
        pool,
        /^UPDATE care_schedule_items/,
      ).length,
      0,
    );
  },
);

await test(
  'active-plan duration shortening removes only pending occurrences beyond medicine end date',
  async () => {
    const pool = createFakePool((sql) => {
      if (
        /FROM care_schedule_items s JOIN care_plans p/.test(sql)
      ) {
        return [[
          medicineBaseRow({
            plan_status: 'active',
            activated_at: '2026-09-07 08:00:00',
          }),
        ]];
      }

      if (
        /FROM care_schedule_items WHERE care_plan_id = \? AND user_id = \? AND instruction_id = \?/.test(
          sql,
        )
      ) {
        return [medicineSlots()];
      }

      if (
        /^UPDATE care_schedule_items SET instruction_duration_days/.test(
          sql,
        )
      ) {
        return [{ affectedRows: 4 }];
      }

      return undefined;
    });

    const result = await saveScheduleItemDuration({
      pool,
      userId: USER_ID,
      itemId: '10',
      mode: 'days',
      durationDays: 3,
      today: '2026-09-07',
    });

    assert.equal(result.ok, true);
    assert.equal(
      result.data.effectiveEndDate,
      '2026-09-09',
    );

    const deletes = matchingCalls(
      pool,
      /^DELETE o FROM care_task_occurrences o/,
    );

    assert.equal(deletes.length, 1);

    assert.deepEqual(
      deletes[0].params,
      [
        USER_ID,
        5,
        5,
        USER_ID,
        '100',
        '2026-09-09',
      ],
    );

    assert.match(
      deletes[0].sql,
      /o\.status = 'pending'/,
    );

    assert.match(
      deletes[0].sql,
      /o\.occurrence_date > \?/,
    );
  },
);

await test(
  'non-medicine schedule item cannot receive medicine duration',
  async () => {
    const pool = createFakePool((sql) => {
      if (
        /FROM care_schedule_items s JOIN care_plans p/.test(sql)
      ) {
        return [[
          medicineBaseRow({
            instruction_id: 200,
            category: 'lab_test',
            task_kind: 'lab_test',
          }),
        ]];
      }

      return undefined;
    });

    const result = await saveScheduleItemDuration({
      pool,
      userId: USER_ID,
      itemId: '10',
      mode: 'days',
      durationDays: 5,
      today: '2026-09-07',
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.code,
      'MEDICINE_DURATION_NOT_APPLICABLE',
    );
  },
);

await test(
  'malformed custom duration is rejected before database access',
  async () => {
    const pool = createFakePool();

    const result = await saveScheduleItemDuration({
      pool,
      userId: USER_ID,
      itemId: '10',
      mode: 'days',
      durationDays: 'abc',
      today: '2026-09-07',
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.code,
      'INVALID_MEDICINE_DURATION',
    );
    assert.equal(pool.calls.length, 0);
  },
);

console.log(
  `Schedule duration tests passed (${passed}).`,
);