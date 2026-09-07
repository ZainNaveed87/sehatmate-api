import assert from 'node:assert/strict';

import {
  saveScheduleItemRecurrence,
} from './services/schedule_recurrence_service.js';

const USER_ID = 'user-1';
const OK_PACKET = { affectedRows: 1, insertId: 0 };

let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function medicineBaseRow(overrides = {}) {
  return {
    id: '10',
    care_plan_id: '5',
    user_id: USER_ID,
    instruction_id: '100',
    task_kind: 'medicine',
    category: 'medicine',
    schedule_date: '2026-09-07',
    schedule_time: '08:00:00',
    display_time: 'Morning',
    recurrence_text: '',
    recurrence_mode: null,
    recurrence_weekdays_json: null,
    recurrence_interval_days: null,
    recurrence_month_days_json: null,
    recurrence_source: null,
    instruction_duration_days: null,
    plan_status: 'reality_check',
    start_date: '2026-09-07',
    activated_at: null,
    duration_mode: 'ongoing',
    planned_end_date: null,
    completed_at: null,
    title: 'DemoMed',
    grounding: 'suggested',
    ...overrides,
  };
}

function medicineSlot(overrides = {}) {
  return {
    id: overrides.id || '10',
    care_plan_id: '5',
    user_id: USER_ID,
    instruction_id: '100',
    task_kind: 'medicine',
    schedule_date: '2026-09-07',
    schedule_time: '08:00:00',
    display_time: 'Morning',
    recurrence_text: '',
    recurrence_mode: null,
    recurrence_weekdays_json: null,
    recurrence_interval_days: null,
    recurrence_month_days_json: null,
    recurrence_source: null,
    instruction_duration_days: null,
    title: 'DemoMed',
    grounding: 'suggested',
    ...overrides,
  };
}

function createFakePool({
  row = medicineBaseRow(),
  medicineItems = null,
  occurrences = [],
} = {}) {
  const calls = [];
  const scheduleItems = medicineItems || [
    medicineSlot({
      id: row.id,
      care_plan_id: row.care_plan_id,
      user_id: row.user_id,
      instruction_id: row.instruction_id,
      schedule_date: row.schedule_date,
      recurrence_text: row.recurrence_text,
      recurrence_mode: row.recurrence_mode,
      recurrence_weekdays_json: row.recurrence_weekdays_json,
      recurrence_interval_days: row.recurrence_interval_days,
      recurrence_month_days_json: row.recurrence_month_days_json,
      recurrence_source: row.recurrence_source,
    }),
  ];
  let occurrenceId = 2000;

  const execute = async (sql, params = []) => {
    const text = normalizeSql(sql);
    calls.push({ sql: text, params });

    if (
      text.includes('FROM care_schedule_items s JOIN care_plans p') &&
      text.includes('WHERE s.id = ?')
    ) {
      return String(params[0]) === String(row.id) && params[1] === USER_ID
        ? [[row]]
        : [[]];
    }

    if (
      text.startsWith('SELECT id, schedule_date, recurrence_text, recurrence_mode') &&
      text.includes('FROM care_schedule_items')
    ) {
      return [scheduleItems.filter((item) =>
        String(item.care_plan_id) === String(params[0]) &&
        item.user_id === params[1] &&
        String(item.instruction_id) === String(params[2]))];
    }

    if (text.startsWith('UPDATE care_schedule_items SET recurrence_text = ?')) {
      const [
        recurrenceText,
        recurrenceMode,
        weekdaysJson,
        intervalDays,
        monthDaysJson,
        scheduleDateCheck,
        scheduleDate,
        carePlanId,
        userId,
        instructionId,
      ] = params;
      let affectedRows = 0;
      for (const item of scheduleItems) {
        if (
          String(item.care_plan_id) !== String(carePlanId) ||
          item.user_id !== userId ||
          String(item.instruction_id) !== String(instructionId)
        ) {
          continue;
        }
        item.recurrence_text = recurrenceText;
        item.recurrence_mode = recurrenceMode;
        item.recurrence_weekdays_json = weekdaysJson;
        item.recurrence_interval_days = intervalDays;
        item.recurrence_month_days_json = monthDaysJson;
        item.recurrence_source = 'user';
        if (scheduleDateCheck != null) item.schedule_date = scheduleDate;
        affectedRows += 1;
      }
      return [{ affectedRows }];
    }

    if (
      text.startsWith('SELECT id, status, start_date, activated_at') &&
      text.includes('FROM care_plans')
    ) {
      return [[{
        id: row.care_plan_id,
        status: row.plan_status,
        start_date: row.start_date,
        activated_at: row.activated_at,
        completed_at: row.completed_at,
        duration_mode: row.duration_mode,
        planned_end_date: row.planned_end_date,
      }]];
    }

    if (
      text.includes('JOIN extracted_instructions i ON i.id = s.instruction_id') &&
      text.includes("i.review_status = 'verified'")
    ) {
      return [[]];
    }

    if (
      text.includes('FROM care_schedule_items') &&
      text.includes('instruction_duration_days IS NOT NULL')
    ) {
      return [[]];
    }

    if (
      text.includes('FROM care_schedule_items') &&
      text.includes('schedule_time IS NOT NULL')
    ) {
      return [scheduleItems.filter((item) =>
        String(item.care_plan_id) === String(params[0]) &&
        item.user_id === params[1] &&
        item.schedule_time != null)];
    }

    if (text.startsWith('DELETE o FROM care_task_occurrences o')) {
      return [OK_PACKET];
    }

    if (text.startsWith('DELETE FROM care_task_occurrences')) {
      return [OK_PACKET];
    }

    if (text.startsWith('INSERT IGNORE INTO care_task_occurrences')) {
      const [userId, planId, scheduleItemId, occurrenceDate, scheduledAt] = params;
      const duplicate = occurrences.some((item) =>
        String(item.schedule_item_id) === String(scheduleItemId) &&
        item.occurrence_date === occurrenceDate);
      if (duplicate) return [{ affectedRows: 0, insertId: 0 }];
      occurrences.push({
        id: occurrenceId += 1,
        user_id: userId,
        care_plan_id: planId,
        schedule_item_id: scheduleItemId,
        occurrence_date: occurrenceDate,
        scheduled_at: scheduledAt,
        status: 'pending',
      });
      return [{ affectedRows: 1, insertId: occurrenceId }];
    }

    if (/^SELECT|^WITH|^SHOW|^DESCRIBE/i.test(text)) return [[]];
    return [OK_PACKET];
  };

  return {
    calls,
    scheduleItems,
    occurrences,
    execute,
    async getConnection() {
      return {
        execute,
        beginTransaction: async () => calls.push({ sql: 'BEGIN', params: [] }),
        commit: async () => calls.push({ sql: 'COMMIT', params: [] }),
        rollback: async () => calls.push({ sql: 'ROLLBACK', params: [] }),
        release: () => {},
      };
    },
  };
}

function callsMatching(pool, pattern) {
  return pool.calls.filter((call) => pattern.test(call.sql));
}

await test('invalid recurrence request is rejected before database access', async () => {
  const pool = createFakePool();

  const result = await saveScheduleItemRecurrence({
    pool,
    userId: USER_ID,
    itemId: '10',
    body: { mode: 'interval_days', intervalDays: 0 },
    today: '2026-09-07',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_MEDICINE_RECURRENCE_INTERVAL');
  assert.equal(pool.calls.length, 0);
});

await test('user recurrence is saved across every reminder slot for one medicine instruction', async () => {
  const pool = createFakePool({
    medicineItems: [
      medicineSlot({ id: '10' }),
      medicineSlot({ id: '11', schedule_time: '20:00:00', display_time: 'Evening' }),
    ],
  });

  const result = await saveScheduleItemRecurrence({
    pool,
    userId: USER_ID,
    itemId: '10',
    body: { mode: 'weekdays', weekdays: [5, 1] },
    today: '2026-09-07',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.updatedScheduleItemCount, 2);
  assert.deepEqual(pool.scheduleItems.map((item) => item.recurrence_mode), [
    'weekdays',
    'weekdays',
  ]);
  assert.deepEqual(pool.scheduleItems.map((item) => item.recurrence_weekdays_json), [
    '[1,5]',
    '[1,5]',
  ]);
  assert.deepEqual(pool.scheduleItems.map((item) => item.recurrence_source), [
    'user',
    'user',
  ]);
});

await test('verified recurrence cannot be changed from the schedule screen', async () => {
  const pool = createFakePool({
    row: medicineBaseRow({ recurrence_mode: 'daily', recurrence_source: 'verified' }),
    medicineItems: [
      medicineSlot({
        recurrence_text: 'once daily',
        recurrence_mode: 'daily',
        recurrence_source: 'verified',
      }),
    ],
  });

  const result = await saveScheduleItemRecurrence({
    pool,
    userId: USER_ID,
    itemId: '10',
    body: { mode: 'weekdays', weekdays: [1] },
    today: '2026-09-07',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'VERIFIED_MEDICINE_RECURRENCE_LOCKED');
  assert.equal(callsMatching(pool, /^UPDATE care_schedule_items SET recurrence_text/).length, 0);
});

await test('same verified recurrence returns a no-op success', async () => {
  const pool = createFakePool({
    row: medicineBaseRow({ recurrence_mode: 'daily', recurrence_source: 'verified' }),
    medicineItems: [
      medicineSlot({
        recurrence_text: 'once daily',
        recurrence_mode: 'daily',
        recurrence_source: 'verified',
      }),
    ],
  });

  const result = await saveScheduleItemRecurrence({
    pool,
    userId: USER_ID,
    itemId: '10',
    body: { mode: 'daily' },
    today: '2026-09-07',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.updatedScheduleItemCount, 0);
  assert.equal(result.data.recurrence.source, 'verified');
});

await test('active recurrence changes delete only future pending rows and regenerate valid future occurrences', async () => {
  const historical = {
    id: 99,
    schedule_item_id: '10',
    occurrence_date: '2026-09-06',
    status: 'completed',
  };
  const pool = createFakePool({
    row: medicineBaseRow({
      plan_status: 'active',
      activated_at: '2026-09-07 08:00:00',
    }),
    occurrences: [historical],
  });

  const result = await saveScheduleItemRecurrence({
    pool,
    userId: USER_ID,
    itemId: '10',
    body: { mode: 'interval_days', intervalDays: 2 },
    today: '2026-09-07',
  });

  assert.equal(result.ok, true);
  const deletes = callsMatching(pool, /^DELETE o FROM care_task_occurrences o/);
  assert.equal(deletes.length, 1);
  assert.match(deletes[0].sql, /o\.status = 'pending'/);
  assert.match(deletes[0].sql, /o\.occurrence_date >= \?/);
  assert.deepEqual(deletes[0].params, [
    USER_ID,
    '5',
    '5',
    USER_ID,
    '100',
    '2026-09-07',
  ]);
  assert.equal(pool.occurrences.includes(historical), true);
  assert.deepEqual(
    pool.occurrences
      .filter((item) => item.status === 'pending')
      .slice(0, 3)
      .map((item) => item.occurrence_date),
    ['2026-09-07', '2026-09-09', '2026-09-11'],
  );
});

await test('one-off recurrence stores the explicit local schedule date', async () => {
  const pool = createFakePool();

  const result = await saveScheduleItemRecurrence({
    pool,
    userId: USER_ID,
    itemId: '10',
    body: { mode: 'one_off', scheduleDate: '2026-09-12' },
    today: '2026-09-07',
  });

  assert.equal(result.ok, true);
  assert.equal(pool.scheduleItems[0].recurrence_mode, 'one_off');
  assert.equal(pool.scheduleItems[0].schedule_date, '2026-09-12');
  assert.equal(result.data.recurrence.scheduleDate, '2026-09-12');
});

console.log(`Schedule recurrence tests passed (${passed}).`);
