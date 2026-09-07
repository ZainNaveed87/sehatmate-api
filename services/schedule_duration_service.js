import {
  addDaysToDateKey,
  cleanText,
  dbDateKey,
  idPattern,
  serverDateKey,
  strictDateKey,
} from './shared_utils.js';

const allowedMedicineDurationModes = new Set([
  'days',
  'plan_end',
]);

const userDurationSources = new Set([
  'user',
  'user_plan_end',
]);

function positiveDurationDays(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

export async function saveScheduleItemDuration({
  pool,
  userId,
  itemId,
  mode,
  durationDays,
  today = null,
}) {
  const canonicalItemId = String(itemId || '');
  const canonicalMode = cleanText(mode, 20).toLowerCase();

  if (!idPattern.test(canonicalItemId)) {
    return {
      ok: false,
      code: 'INVALID_SCHEDULE_ITEM_ID',
      message: 'Invalid schedule item ID.',
    };
  }

  if (!allowedMedicineDurationModes.has(canonicalMode)) {
    return {
      ok: false,
      code: 'INVALID_MEDICINE_DURATION_MODE',
      message: 'Select a valid medicine duration.',
    };
  }

  let localToday;

  if (today == null || today === '') {
    localToday = serverDateKey();
  } else {
    localToday = strictDateKey(today);

    if (!localToday) {
      return {
        ok: false,
        code: 'INVALID_MEDICINE_DURATION_DATE',
        message: 'Select a valid local date.',
      };
    }
  }

  let canonicalDays = null;

  if (canonicalMode === 'days') {
    const rawDays = String(durationDays ?? '').trim();

    if (!/^\d{1,4}$/.test(rawDays)) {
      return {
        ok: false,
        code: 'INVALID_MEDICINE_DURATION',
        message: 'Enter a medicine duration between 1 and 3650 days.',
      };
    }

    canonicalDays = Number.parseInt(rawDays, 10);

    if (
      !Number.isInteger(canonicalDays) ||
      canonicalDays < 1 ||
      canonicalDays > 3650
    ) {
      return {
        ok: false,
        code: 'INVALID_MEDICINE_DURATION',
        message: 'Enter a medicine duration between 1 and 3650 days.',
      };
    }
  }

  const [rows] = await pool.execute(
    `SELECT
      s.id,
      s.care_plan_id,
      s.instruction_id,
      s.task_kind,
      s.schedule_date,
      p.status AS plan_status,
      p.start_date,
      p.activated_at,
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
    return {
      ok: false,
      code: 'SCHEDULE_ITEM_NOT_FOUND',
      message: 'Schedule item not found.',
    };
  }

  const row = rows[0];

  const category = cleanText(row.category, 40).toLowerCase();
  const taskKind = cleanText(row.task_kind, 40).toLowerCase();
  const instructionId = String(row.instruction_id || '');

  if (
    (category !== 'medicine' && taskKind !== 'medicine') ||
    !idPattern.test(instructionId)
  ) {
    return {
      ok: false,
      code: 'MEDICINE_DURATION_NOT_APPLICABLE',
      message: 'Duration can only be set for medicine schedule items.',
    };
  }

  /*
   * One medicine can have several reminder slots, for example morning,
   * afternoon, evening and night. Duration belongs to the medicine
   * instruction, not to one individual reminder slot.
   */
  const [medicineItems] = await pool.execute(
    `SELECT
      id,
      instruction_duration_days,
      instruction_duration_source
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

  const verifiedDurations = medicineItems
    .map((item) => {
      const days = positiveDurationDays(
        item.instruction_duration_days,
      );

      const source = cleanText(
        item.instruction_duration_source,
        20,
      ).toLowerCase();

      if (
        days &&
        !userDurationSources.has(source)
      ) {
        return days;
      }

      return null;
    })
    .filter(Boolean);

  if (verifiedDurations.length > 0) {
    const uniqueVerifiedDurations = [
      ...new Set(verifiedDurations),
    ];

    if (
      uniqueVerifiedDurations.length === 1 &&
      canonicalMode === 'days' &&
      canonicalDays === uniqueVerifiedDurations[0]
    ) {
      return {
        ok: true,
        message: 'Verified medicine duration is unchanged.',
        data: {
          itemId: canonicalItemId,
          instructionId,
          mode: 'days',
          durationDays: uniqueVerifiedDurations[0],
          source: 'verified',
          updatedScheduleItemCount: 0,
        },
      };
    }

    return {
      ok: false,
      code: 'VERIFIED_MEDICINE_DURATION_LOCKED',
      message:
        'This medicine duration comes from the verified instruction and cannot be extended from the schedule screen.',
    };
  }

  const plannedEndDate = dbDateKey(row.planned_end_date);

  if (
    canonicalMode === 'plan_end' &&
    !plannedEndDate
  ) {
    return {
      ok: false,
      code: 'PLAN_END_REQUIRED',
      message:
        'Choose the care-plan end date before using it as this medicine duration.',
    };
  }

  const durationSource =
    canonicalMode === 'plan_end'
      ? 'user_plan_end'
      : 'user';

  const [updateResult] = await pool.execute(
    `UPDATE care_schedule_items
     SET instruction_duration_days = ?,
         instruction_duration_source = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE care_plan_id = ?
       AND user_id = ?
       AND instruction_id = ?`,
    [
      canonicalMode === 'days'
        ? canonicalDays
        : null,
      durationSource,
      row.care_plan_id,
      userId,
      instructionId,
    ],
  );

  let effectiveEndDate = null;

  if (row.plan_status === 'active') {
    if (canonicalMode === 'plan_end') {
      effectiveEndDate = plannedEndDate;
    } else {
      const effectiveStart =
        dbDateKey(row.activated_at) ||
        dbDateKey(row.schedule_date) ||
        dbDateKey(row.start_date) ||
        localToday;

      effectiveEndDate = addDaysToDateKey(
        effectiveStart,
        canonicalDays - 1,
      );
    }

    if (effectiveEndDate) {
      /*
       * Remove only future pending rows outside the newly selected
       * duration. Completed/skipped/missed history stays untouched.
       */
      await pool.execute(
        `DELETE o
         FROM care_task_occurrences o
         JOIN care_schedule_items s
           ON s.id = o.schedule_item_id
         WHERE o.user_id = ?
           AND o.care_plan_id = ?
           AND s.care_plan_id = ?
           AND s.user_id = ?
           AND s.instruction_id = ?
           AND o.occurrence_date > ?
           AND o.status = 'pending'`,
        [
          userId,
          row.care_plan_id,
          row.care_plan_id,
          userId,
          instructionId,
          effectiveEndDate,
        ],
      );
    }
  }

  return {
    ok: true,
    message:
      canonicalMode === 'plan_end'
        ? 'Medicine duration will follow the selected care-plan end date.'
        : 'Medicine duration saved.',
    data: {
      itemId: canonicalItemId,
      instructionId,
      mode: canonicalMode,
      durationDays:
        canonicalMode === 'days'
          ? canonicalDays
          : null,
      source: durationSource,
      effectiveEndDate,
      updatedScheduleItemCount:
        Number(updateResult?.affectedRows || 0),
    },
  };
}