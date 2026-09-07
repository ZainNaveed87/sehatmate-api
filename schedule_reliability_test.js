import assert from 'node:assert/strict';

import './agent/agent_read_tools.js';
import {
  executeAgentCapability,
} from './agent/agent_capability_registry.js';
import {
  validatePlanDurationInput,
} from './services/plan_duration_service.js';
import {
  ensureOccurrencesForDate,
  restoreVerifiedScheduleRecurrenceForPlan,
  scheduleItemIsDaily,
} from './services/task_outcome_service.js';
import {
  strictDateKey,
  verifiedDailyRecurrence,
} from './services/shared_utils.js';

const USER = 'user-1';
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

function blank(value) {
  return value == null || String(value).trim() === '';
}

function createSchedulePool({
  plan,
  instructions = [],
  scheduleItems = [],
  gapCount = 0,
}) {
  const calls = [];
  const occurrences = [];
  let occurrenceId = 1000;

  const execute = async (sql, params = []) => {
    const text = normalizeSql(sql);
    calls.push({ sql: text, params });

    if (
      text.startsWith('SELECT id, user_id, title, duration_mode') &&
      text.includes("WHERE status = 'active'")
    ) {
      return [[]];
    }

    if (
      text.includes("o.status = 'pending'") &&
      text.includes('o.occurrence_date < ?')
    ) {
      return [[]];
    }

    if (text.startsWith('SELECT id, title, readiness_score FROM care_plans')) {
      if (!plan || plan.user_id !== params[0] || plan.status !== 'active') {
        return [[]];
      }
      return [[{
        id: plan.id,
        title: plan.title,
        readiness_score: plan.readiness_score ?? 80,
      }]];
    }

    if (
      text.startsWith('SELECT id, status, start_date, activated_at') &&
      text.includes('FROM care_plans')
    ) {
      const [planId, userId] = params;
      if (!plan || String(plan.id) !== String(planId) || plan.user_id !== userId) {
        return [[]];
      }
      return [[plan]];
    }

    if (
      text.includes('JOIN extracted_instructions i ON i.id = s.instruction_id') &&
      text.includes("i.review_status = 'verified'") &&
      text.includes('TRIM(s.recurrence_text)')
    ) {
      const [planId, userId] = params;
      const rows = scheduleItems
        .filter((item) =>
          String(item.care_plan_id) === String(planId) &&
          item.user_id === userId &&
          blank(item.recurrence_text))
        .map((item) => {
          const instruction = instructions.find((candidate) =>
            String(candidate.id) === String(item.instruction_id) &&
            String(candidate.care_plan_id) === String(item.care_plan_id) &&
            candidate.review_status === 'verified');
          if (!instruction) return null;
          return {
            id: item.id,
            instruction: instruction.instruction,
            timing: instruction.timing,
            original_instruction: instruction.original_instruction,
            original_timing: instruction.original_timing,
          };
        })
        .filter(Boolean);
      return [rows];
    }

    if (text.startsWith('UPDATE care_schedule_items SET recurrence_text = ?')) {
      const [recurrence, itemId, planId, userId] = params;
      const item = scheduleItems.find((candidate) =>
        String(candidate.id) === String(itemId) &&
        String(candidate.care_plan_id) === String(planId) &&
        candidate.user_id === userId &&
        blank(candidate.recurrence_text));
      if (!item) return [{ affectedRows: 0 }];
      item.recurrence_text = recurrence;
      return [{ affectedRows: 1 }];
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
      const [planId, userId] = params;
      return [scheduleItems.filter((item) =>
        String(item.care_plan_id) === String(planId) &&
        item.user_id === userId &&
        item.schedule_time != null)];
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

      const scheduleItem = scheduleItems.find((item) =>
        String(item.id) === String(scheduleItemId));
      occurrences.push({
        id: occurrenceId += 1,
        user_id: userId,
        care_plan_id: planId,
        schedule_item_id: scheduleItemId,
        occurrence_date: occurrenceDate,
        scheduled_at: scheduledAt,
        scheduled_time: String(scheduleItem?.schedule_time || '').slice(0, 5),
        status: 'pending',
        completed_at: null,
        completed_time: null,
        outcome_source: 'system',
        note: '',
      });
      return [{ affectedRows: 1, insertId: occurrenceId }];
    }

    if (text.includes('p.title AS plan_title')) {
      const [userId, dateKey] = params;
      const rows = occurrences
        .filter((item) => item.user_id === userId && item.occurrence_date === dateKey)
        .map((occurrence) => {
          const item = scheduleItems.find((candidate) =>
            String(candidate.id) === String(occurrence.schedule_item_id));
          return {
            ...occurrence,
            title: item?.title,
            task_kind: item?.task_kind,
            display_time: item?.display_time,
            recurrence_text: item?.recurrence_text,
            grounding: item?.grounding,
            plan_title: plan?.title,
          };
        })
        .sort((a, b) =>
          String(a.scheduled_at).localeCompare(String(b.scheduled_at)) ||
          Number(a.id) - Number(b.id));
      return [rows];
    }

    if (text.includes('COUNT(*) AS open_count')) {
      return [[{ open_count: gapCount }]];
    }

    if (/^SELECT|^WITH|^SHOW|^DESCRIBE/i.test(text)) return [[]];
    return [OK_PACKET];
  };

  return {
    execute,
    calls,
    occurrences,
    scheduleItems,
    async getConnection() {
      return {
        execute,
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
      };
    },
  };
}

function activePlan(overrides = {}) {
  return {
    id: '10',
    user_id: USER,
    title: 'Recovery Plan',
    status: 'active',
    start_date: '2026-09-07',
    activated_at: '2026-09-07 08:00:00',
    completed_at: null,
    duration_mode: 'ongoing',
    planned_end_date: null,
    readiness_score: 90,
    ...overrides,
  };
}

function verifiedInstruction(overrides = {}) {
  return {
    id: '501',
    care_plan_id: '10',
    review_status: 'verified',
    instruction: 'Take DemoMed one tablet four times daily for five days.',
    timing: '',
    original_instruction: '',
    original_timing: '',
    ...overrides,
  };
}

function scheduleItem(overrides = {}) {
  return {
    id: '701',
    care_plan_id: '10',
    user_id: USER,
    instruction_id: '501',
    schedule_date: null,
    schedule_time: '08:00:00',
    display_time: 'Morning',
    recurrence_text: '',
    grounding: 'suggested',
    title: 'DemoMed',
    task_kind: 'medication',
    instruction_duration_days: null,
    ...overrides,
  };
}

await test('verified daily recurrence parsing is explicit and exact-date parsing does not truncate', async () => {
  assert.deepEqual(verifiedDailyRecurrence('Take one tablet every day.'), {
    count: null,
    recurrence: 'daily',
  });
  assert.deepEqual(verifiedDailyRecurrence('Use 1 drop twice daily.'), {
    count: 2,
    recurrence: 'twice daily',
  });
  assert.deepEqual(verifiedDailyRecurrence('Take medicine four times daily.'), {
    count: 4,
    recurrence: 'four times daily',
  });
  assert.equal(verifiedDailyRecurrence('Take with breakfast and at bedtime.'), null);
  assert.equal(verifiedDailyRecurrence('Keep plan ongoing until follow-up.'), null);
  assert.equal(strictDateKey('2026-09-07'), '2026-09-07');
  assert.equal(strictDateKey('2026-09-07T00:00:00Z'), null);
  assert.equal(strictDateKey('2026-09-31'), null);
});

await test('blank generated recurrence is restored from verified four-times-daily text', async () => {
  const instruction = verifiedInstruction();
  const items = [
    scheduleItem({ id: '701', schedule_time: '08:00:00', display_time: 'Morning' }),
    scheduleItem({ id: '702', schedule_time: '13:00:00', display_time: 'Afternoon' }),
    scheduleItem({ id: '703', schedule_time: '18:00:00', display_time: 'Evening' }),
    scheduleItem({ id: '704', schedule_time: '22:00:00', display_time: 'Night' }),
  ];
  const pool = createSchedulePool({
    plan: activePlan(),
    instructions: [instruction],
    scheduleItems: items,
  });

  await ensureOccurrencesForDate({
    db: pool,
    userId: USER,
    planId: '10',
    dateKey: '2026-09-08',
  });

  assert.deepEqual(pool.scheduleItems.map((item) => item.recurrence_text), [
    'four times daily',
    'four times daily',
    'four times daily',
    'four times daily',
  ]);
  assert.equal(pool.occurrences.length, 4);
  assert.deepEqual(pool.occurrences.map((item) => item.scheduled_at), [
    '2026-09-08 08:00:00',
    '2026-09-08 13:00:00',
    '2026-09-08 18:00:00',
    '2026-09-08 22:00:00',
  ]);
});

await test('ongoing plans and period labels do not become daily recurrence', async () => {
  const items = [
    scheduleItem({
      id: '801',
      instruction_id: '601',
      schedule_date: '2026-09-07',
      schedule_time: '08:00:00',
      display_time: 'Morning',
    }),
    scheduleItem({
      id: '802',
      instruction_id: '601',
      schedule_date: '2026-09-07',
      schedule_time: '18:00:00',
      display_time: 'Evening',
    }),
  ];
  const pool = createSchedulePool({
    plan: activePlan({ duration_mode: 'ongoing' }),
    instructions: [
      verifiedInstruction({
        id: '601',
        instruction: 'Continue medicine until your follow-up visit.',
        timing: 'Morning and evening',
      }),
    ],
    scheduleItems: items,
  });

  const restored = await restoreVerifiedScheduleRecurrenceForPlan({
    db: pool,
    userId: USER,
    planId: '10',
  });
  await ensureOccurrencesForDate({
    db: pool,
    userId: USER,
    planId: '10',
    dateKey: '2026-09-08',
  });

  assert.equal(restored, 0);
  assert.deepEqual(pool.scheduleItems.map((item) => item.recurrence_text), ['', '']);
  assert.equal(pool.occurrences.length, 0);
});

await test('one-off dated tasks remain one-off', async () => {
  const pool = createSchedulePool({
    plan: activePlan(),
    instructions: [
      verifiedInstruction({
        id: '602',
        instruction: 'Follow up with the doctor on 2026-09-08.',
        timing: '10:00 AM',
      }),
    ],
    scheduleItems: [
      scheduleItem({
        id: '803',
        instruction_id: '602',
        schedule_date: '2026-09-08',
        schedule_time: '10:00:00',
        display_time: '10:00 AM',
      }),
    ],
  });

  await ensureOccurrencesForDate({
    db: pool,
    userId: USER,
    planId: '10',
    dateKey: '2026-09-08',
  });
  await ensureOccurrencesForDate({
    db: pool,
    userId: USER,
    planId: '10',
    dateKey: '2026-09-09',
  });

  assert.deepEqual(pool.occurrences.map((item) => item.occurrence_date), [
    '2026-09-08',
  ]);
  assert.equal(scheduleItemIsDaily(pool.scheduleItems[0]), false);
});

await test('confirmed exact times are not changed by recurrence repair', async () => {
  const pool = createSchedulePool({
    plan: activePlan(),
    instructions: [
      verifiedInstruction({
        id: '603',
        instruction: 'Take DemoMed once daily at exactly 2:00 PM for 7 days.',
        timing: 'exactly 2:00 PM',
      }),
    ],
    scheduleItems: [
      scheduleItem({
        id: '804',
        instruction_id: '603',
        schedule_time: '14:00:00',
        display_time: '2:00 PM',
        grounding: 'explicit',
      }),
    ],
  });

  await ensureOccurrencesForDate({
    db: pool,
    userId: USER,
    planId: '10',
    dateKey: '2026-09-08',
  });

  assert.equal(pool.scheduleItems[0].schedule_time, '14:00:00');
  assert.equal(pool.scheduleItems[0].display_time, '2:00 PM');
  assert.equal(pool.scheduleItems[0].recurrence_text, 'once daily');
  assert.deepEqual(pool.occurrences.map((item) => item.scheduled_at), [
    '2026-09-08 14:00:00',
  ]);
});

await test('Agent next task reads authoritative restored future occurrences', async () => {
  const pool = createSchedulePool({
    plan: activePlan(),
    instructions: [
      verifiedInstruction({
        id: '604',
        instruction: 'Take DemoMed twice daily.',
      }),
    ],
    scheduleItems: [
      scheduleItem({
        id: '805',
        instruction_id: '604',
        title: 'DemoMed morning',
        schedule_time: '09:00:00',
        display_time: 'Morning',
      }),
      scheduleItem({
        id: '806',
        instruction_id: '604',
        title: 'DemoMed evening',
        schedule_time: '20:00:00',
        display_time: 'Evening',
      }),
    ],
  });

  const result = await executeAgentCapability({
    name: 'get_next_task',
    pool,
    userId: USER,
    args: {},
    clientToday: '2026-09-08',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.date, '2026-09-08');
  assert.equal(result.data.totalToday, 2);
  assert.equal(result.data.pendingToday, 2);
  assert.equal(result.data.nextTask.title, 'DemoMed morning');
  assert.equal(result.data.nextTask.scheduledTime, '09:00');
});

await test('plan duration validation uses trusted local today and rejects malformed dates', async () => {
  assert.equal(validatePlanDurationInput({
    planId: '10',
    mode: 'custom',
    endDate: '2026-09-07',
    today: '2026-09-07',
    fallbackToday: '2026-09-06',
  }).ok, true);

  assert.deepEqual(validatePlanDurationInput({
    planId: '10',
    mode: 'custom',
    endDate: '2026-09-06',
    today: '2026-09-07',
  }), {
    ok: false,
    message: 'Plan end date cannot be in the past.',
  });

  assert.deepEqual(validatePlanDurationInput({
    planId: '10',
    mode: 'custom',
    endDate: '2026-09-07T00:00:00Z',
    today: '2026-09-07',
  }), {
    ok: false,
    message: 'Select a valid plan end date.',
  });

  assert.deepEqual(validatePlanDurationInput({
    planId: '10',
    mode: 'custom',
    endDate: '2026-09-07',
    today: '2026-09-07T00:00:00Z',
  }), {
    ok: false,
    message: 'Select a valid local date.',
  });

  assert.deepEqual(validatePlanDurationInput({
    planId: '10',
    mode: 'ongoing',
    endDate: 'not-a-date',
    today: '2026-09-07',
  }), {
    ok: true,
    data: {
      planId: '10',
      mode: 'ongoing',
      endDate: null,
      today: '2026-09-07',
    },
  });
});

console.log(`Schedule reliability tests passed (${passed}).`);
