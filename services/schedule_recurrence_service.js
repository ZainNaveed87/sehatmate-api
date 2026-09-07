import {
  addDaysToDateKey,
  cleanText,
  dbDateKey,
  idPattern,
  recurrenceDefinitionEquals,
  recurrenceDefinitionFromRow,
  recurrenceDisplayText,
  scheduleItemIsMedicine,
  serverDateKey,
  strictDateKey,
} from './shared_utils.js';

import {
  ensureOccurrencesForRange,
} from './task_outcome_service.js';

const allowedRecurrenceModes = new Set([
  'daily',
  'weekdays',
  'interval_days',
  'month_days',
  'one_off',
]);

function error(code, message, data = undefined) {
  return {
    ok: false,
    code,
    message,
    ...(data === undefined ? {} : { data }),
  };
}

function normalizeUniqueList(value, minimum, maximum, code, message) {
  if (!Array.isArray(value) || value.length === 0) {
    return error(code, message);
  }

  const seen = new Set();
  const output = [];
  for (const raw of value) {
    const number = Number(raw);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      return error(code, message);
    }
    if (seen.has(number)) {
      return error(code, message);
    }
    seen.add(number);
    output.push(number);
  }

  output.sort((left, right) => left - right);
  return { ok: true, data: output };
}

function normalizeRecurrenceRequest(body) {
  const mode = cleanText(body?.mode, 30).toLowerCase();
  if (!allowedRecurrenceModes.has(mode)) {
    return error(
      'INVALID_MEDICINE_RECURRENCE_MODE',
      'Select a valid medicine repeat pattern.',
    );
  }

  if (mode === 'daily') {
    return {
      ok: true,
      data: {
        mode,
        source: 'user',
        weekdays: [],
        intervalDays: null,
        monthDays: [],
        scheduleDate: null,
      },
    };
  }

  if (mode === 'weekdays') {
    const weekdays = normalizeUniqueList(
      body?.weekdays,
      1,
      7,
      'INVALID_MEDICINE_RECURRENCE_WEEKDAYS',
      'Choose one or more weekdays from Monday to Sunday.',
    );
    if (!weekdays.ok) return weekdays;
    return {
      ok: true,
      data: {
        mode,
        source: 'user',
        weekdays: weekdays.data,
        intervalDays: null,
        monthDays: [],
        scheduleDate: null,
      },
    };
  }

  if (mode === 'interval_days') {
    const raw = String(body?.intervalDays ?? '').trim();
    if (!/^\d{1,4}$/.test(raw)) {
      return error(
        'INVALID_MEDICINE_RECURRENCE_INTERVAL',
        'Enter an interval between 1 and 3650 days.',
      );
    }
    const intervalDays = Number.parseInt(raw, 10);
    if (intervalDays < 1 || intervalDays > 3650) {
      return error(
        'INVALID_MEDICINE_RECURRENCE_INTERVAL',
        'Enter an interval between 1 and 3650 days.',
      );
    }
    return {
      ok: true,
      data: {
        mode,
        source: 'user',
        weekdays: [],
        intervalDays,
        monthDays: [],
        scheduleDate: null,
      },
    };
  }

  if (mode === 'month_days') {
    const monthDays = normalizeUniqueList(
      body?.monthDays,
      1,
      31,
      'INVALID_MEDICINE_RECURRENCE_MONTH_DAYS',
      'Choose one or more days from 1 to 31.',
    );
    if (!monthDays.ok) return monthDays;
    return {
      ok: true,
      data: {
        mode,
        source: 'user',
        weekdays: [],
        intervalDays: null,
        monthDays: monthDays.data,
        scheduleDate: null,
      },
    };
  }

  const scheduleDate = strictDateKey(body?.scheduleDate);
  if (!scheduleDate) {
    return error(
      'INVALID_MEDICINE_RECURRENCE_DATE',
      'Choose a valid one-time local date.',
    );
  }
  return {
    ok: true,
    data: {
      mode,
      source: 'user',
      weekdays: [],
      intervalDays: null,
      monthDays: [],
      scheduleDate,
    },
  };
}

function activeReconciliationEndDate(row, today) {
  const candidates = [addDaysToDateKey(today, 30)].filter(Boolean);

  const plannedEnd = dbDateKey(row?.planned_end_date);
  if (row?.duration_mode !== 'ongoing' && plannedEnd && plannedEnd >= today) {
    candidates.push(plannedEnd);
  }

  const durationDays = Number(row?.instruction_duration_days || 0);
  if (Number.isInteger(durationDays) && durationDays > 0) {
    const effectiveStart =
      dbDateKey(row?.activated_at) ||
      dbDateKey(row?.schedule_date) ||
      dbDateKey(row?.start_date);
    const instructionEnd = effectiveStart
      ? addDaysToDateKey(effectiveStart, durationDays - 1)
      : '';
    if (instructionEnd && instructionEnd >= today) {
      candidates.push(instructionEnd);
    }
  }

  return candidates.sort()[0] || today;
}

async function reconcileFuturePendingOccurrences({
  db,
  userId,
  row,
  instructionId,
  today,
}) {
  if (row.plan_status !== 'active') return null;

  await db.execute(
    `DELETE o
     FROM care_task_occurrences o
     JOIN care_schedule_items s
       ON s.id = o.schedule_item_id
     WHERE o.user_id = ?
       AND o.care_plan_id = ?
       AND s.care_plan_id = ?
       AND s.user_id = ?
       AND s.instruction_id = ?
       AND o.occurrence_date >= ?
       AND o.status = 'pending'`,
    [
      userId,
      row.care_plan_id,
      row.care_plan_id,
      userId,
      instructionId,
      today,
    ],
  );

  const endDate = activeReconciliationEndDate(row, today);
  await ensureOccurrencesForRange({
    db,
    userId,
    planId: String(row.care_plan_id),
    startDate: today,
    endDate,
  });

  return { startDate: today, endDate };
}

export async function saveScheduleItemRecurrence({
  pool,
  userId,
  itemId,
  body,
  today = null,
}) {
  const canonicalItemId = String(itemId || '');
  if (!idPattern.test(canonicalItemId)) {
    return error('INVALID_SCHEDULE_ITEM_ID', 'Invalid schedule item ID.');
  }

  const normalized = normalizeRecurrenceRequest(body || {});
  if (!normalized.ok) return normalized;

  let localToday;
  if (today == null || today === '') {
    localToday = serverDateKey();
  } else {
    localToday = strictDateKey(today);
    if (!localToday) {
      return error(
        'INVALID_MEDICINE_RECURRENCE_DATE',
        'Choose a valid local date.',
      );
    }
  }

  const requested = {
    ...normalized.data,
    text: recurrenceDisplayText(normalized.data),
  };

  const [rows] = await pool.execute(
    `SELECT
      s.id,
      s.care_plan_id,
      s.instruction_id,
      s.task_kind,
      s.schedule_date,
      s.recurrence_text,
      s.recurrence_mode,
      s.recurrence_weekdays_json,
      s.recurrence_interval_days,
      s.recurrence_month_days_json,
      s.recurrence_source,
      s.instruction_duration_days,
      p.status AS plan_status,
      p.start_date,
      p.activated_at,
      p.duration_mode,
      p.planned_end_date,
      i.category
     FROM care_schedule_items s
     JOIN care_plans p
       ON p.id = s.care_plan_id
      AND p.user_id = s.user_id
     LEFT JOIN extracted_instructions i
       ON i.id = s.instruction_id
      AND i.care_plan_id = s.care_plan_id
     WHERE s.id = ?
       AND s.user_id = ?
     LIMIT 1`,
    [canonicalItemId, userId],
  );

  if (rows.length === 0) {
    return error('SCHEDULE_ITEM_NOT_FOUND', 'Schedule item not found.');
  }

  const row = rows[0];
  const instructionId = String(row.instruction_id || '');

  if (!scheduleItemIsMedicine(row) || !idPattern.test(instructionId)) {
    return error(
      'MEDICINE_RECURRENCE_NOT_APPLICABLE',
      'Repeat pattern can only be set for medicine schedule items.',
    );
  }

  const [medicineItems] = await pool.execute(
    `SELECT id, schedule_date, recurrence_text, recurrence_mode,
      recurrence_weekdays_json, recurrence_interval_days,
      recurrence_month_days_json, recurrence_source
     FROM care_schedule_items
     WHERE care_plan_id = ?
       AND user_id = ?
       AND instruction_id = ?
     ORDER BY id`,
    [
      row.care_plan_id,
      userId,
      instructionId,
    ],
  );

  const verifiedRecurrences = medicineItems
    .map(recurrenceDefinitionFromRow)
    .filter((definition) => definition && definition.source !== 'user');

  if (verifiedRecurrences.length > 0) {
    const sameValue = verifiedRecurrences.every((definition) =>
      recurrenceDefinitionEquals(definition, requested));

    if (sameValue) {
      return {
        ok: true,
        message: 'Verified medicine repeat pattern is unchanged.',
        data: {
          itemId: canonicalItemId,
          instructionId,
          recurrence: { ...verifiedRecurrences[0], source: 'verified' },
          updatedScheduleItemCount: 0,
          futureReconciliation: null,
        },
      };
    }

    return error(
      'VERIFIED_MEDICINE_RECURRENCE_LOCKED',
      'This medicine repeat pattern comes from the verified instruction and cannot be changed from the schedule screen.',
    );
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [updateResult] = await connection.execute(
      `UPDATE care_schedule_items
       SET recurrence_text = ?,
           recurrence_mode = ?,
           recurrence_weekdays_json = ?,
           recurrence_interval_days = ?,
           recurrence_month_days_json = ?,
           recurrence_source = 'user',
           schedule_date = CASE WHEN ? IS NULL THEN schedule_date ELSE ? END,
           updated_at = CURRENT_TIMESTAMP
       WHERE care_plan_id = ?
         AND user_id = ?
         AND instruction_id = ?`,
      [
        requested.text,
        requested.mode,
        requested.weekdays.length ? JSON.stringify(requested.weekdays) : null,
        requested.intervalDays,
        requested.monthDays.length ? JSON.stringify(requested.monthDays) : null,
        requested.scheduleDate,
        requested.scheduleDate,
        row.care_plan_id,
        userId,
        instructionId,
      ],
    );

    const futureReconciliation = await reconcileFuturePendingOccurrences({
      db: connection,
      userId,
      row: {
        ...row,
        schedule_date: requested.scheduleDate || row.schedule_date,
      },
      instructionId,
      today: localToday,
    });

    await connection.commit();

    return {
      ok: true,
      message: 'Medicine repeat pattern saved.',
      data: {
        itemId: canonicalItemId,
        instructionId,
        recurrence: requested,
        updatedScheduleItemCount: Number(updateResult?.affectedRows || 0),
        futureReconciliation,
      },
    };
  } catch (err) {
    try { await connection.rollback(); } catch (_) {}
    throw err;
  } finally {
    connection.release();
  }
}
