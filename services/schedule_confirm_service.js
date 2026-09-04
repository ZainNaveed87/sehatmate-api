/**
 * Authoritative schedule-item confirmation domain (safe reminder timing).
 *
 * Both the REST route in server.js and any future agent tool must call
 * confirmScheduleItem here instead of duplicating this logic. The
 * function was moved verbatim from the PATCH /api/schedule-items/:id/confirm
 * route handler during the Phase A service extraction.
 *
 * schedule_time_guard.js stays authoritative: there is no code path in
 * this service that can bypass the verified exact-clock-time lock, the
 * care-period windows, or the verified medical timing constraint.
 */

import {
  extractVerifiedExactClockTimes,
  isVerifiedExactScheduleItemLocked,
} from '../schedule_time_guard.js';

import {
  refreshCareGaps,
} from '../care_gap_engine.js';

import {
  recordRoutineLearningEvent,
} from '../routine_learning.js';

import {
  cleanText,
  idPattern,
  schedulePeriodKey,
  scheduleWindow,
  timeFitsScheduleWindow,
} from './shared_utils.js';

import {
  realityQuestionTemplates,
} from './reality_answer_service.js';

function verifiedTimingConstraint(row) {
  const currentText = [row?.instruction, row?.timing]
    .filter(Boolean)
    .join(' ')
    .trim();
  const fallbackText = [row?.original_instruction, row?.original_timing]
    .filter(Boolean)
    .join(' ')
    .trim();
  const text = (currentText || fallbackText).toLowerCase();

  const rules = [
    {
      regex: /\b(?:after|before|with)\s+breakfast\b|\bbreakfast\b/,
      period: 'morning',
      phrase: 'breakfast',
    },
    {
      regex: /\b(?:after|before|with)\s+lunch\b|\blunch\b/,
      period: 'afternoon',
      phrase: 'lunch',
    },
    {
      regex: /\b(?:after|before|with)\s+(?:dinner|supper)\b|\b(?:dinner|supper)\b/,
      period: 'evening',
      phrase: 'dinner',
    },
    {
      regex: /\b(?:at\s+)?bedtime\b/,
      period: 'night',
      phrase: 'bedtime',
    },
  ];

  for (const rule of rules) {
    if (rule.regex.test(text)) return rule;
  }

  const timingText = String(row?.original_timing || row?.timing || '').toLowerCase();
  for (const period of ['morning', 'afternoon', 'evening', 'night']) {
    if (new RegExp(`\\b${period}\\b`, 'i').test(timingText)) {
      return { period, phrase: period };
    }
  }
  return null;
}

/**
 * Validate an exact reminder time for one schedule item without mutating.
 *
 * Returns a structured domain result:
 *   { ok: false, code: 'INVALID_SCHEDULE_ITEM_ID', message }
 *   { ok: false, code: 'INVALID_SCHEDULE_TIME', message }
 *   { ok: false, code: 'SCHEDULE_ITEM_NOT_FOUND', message }
 *   { ok: false, code: 'EXACT_TIME_LOCKED', message, data }
 *   { ok: false, code: 'TIME_OUTSIDE_PERIOD_WINDOW', message }
 *   { ok: false, code: 'MEDICAL_TIMING_CONFLICT', message, data }
 *   { ok: false, code: 'DUPLICATE_REMINDER_TIME', message }
 *   { ok: false, code: 'DUPLICATE_REMINDER_PERIOD', message }
 *   { ok: true, message, data: { row, displayTime, scheduleTime, selectedPeriod } }
 */
export async function validateScheduleItemConfirmation({
  pool,
  userId,
  itemId,
  displayTime,
  scheduleTime,
}) {
  const canonicalDisplayTime = cleanText(displayTime, 160);
  const canonicalScheduleTime = cleanText(scheduleTime, 5);
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

  if (!idPattern.test(itemId)) {
    return {
      ok: false,
      code: 'INVALID_SCHEDULE_ITEM_ID',
      message: 'Invalid schedule item ID.',
    };
  }
  if (!timePattern.test(canonicalScheduleTime)) {
    return {
      ok: false,
      code: 'INVALID_SCHEDULE_TIME',
      message: 'Select an exact reminder time before confirming this schedule item.',
    };
  }

  const [rows] = await pool.execute(
    `SELECT s.id, s.care_plan_id, s.instruction_id, s.schedule_date,
      TIME_FORMAT(s.schedule_time, '%H:%i') AS schedule_time,
      s.display_time, s.grounding, s.title,
      i.instruction, i.timing, i.original_instruction, i.original_timing
     FROM care_schedule_items s
     LEFT JOIN extracted_instructions i ON i.id = s.instruction_id
     WHERE s.id = ? AND s.user_id = ?
     LIMIT 1`,
    [itemId, userId],
  );
  if (rows.length === 0) {
    return {
      ok: false,
      code: 'SCHEDULE_ITEM_NOT_FOUND',
      message: 'Schedule item not found.',
    };
  }

  const verifiedExactTimes = extractVerifiedExactClockTimes(rows[0]);
  if (isVerifiedExactScheduleItemLocked(rows[0]) && verifiedExactTimes.length > 0) {
    const allowedTimes = verifiedExactTimes.map((item) => item.time.slice(0, 5));
    const writtenTime = verifiedExactTimes
      .map((item) => item.displayTime)
      .join(' / ');
    return {
      ok: false,
      code: 'EXACT_TIME_LOCKED',
      message:
        `This reminder time is fixed by the verified instruction (${writtenTime}). ` +
        'It cannot be edited from the schedule screen.',
      data: {
        medicalTimingConflict: true,
        exactTimeLocked: true,
        allowedTimes,
        selectedTime: canonicalScheduleTime,
      },
    };
  }

  // Prefer the period the user is saving now. Falling back to the stored
  // display_time keeps older clients compatible, but does not let a stale
  // AI-generated "Evening" label override a user-edited "Night" period.
  const window = scheduleWindow(canonicalDisplayTime) || scheduleWindow(rows[0].display_time);
  if (window) {
    const [hour, minute] = canonicalScheduleTime.split(':').map(Number);
    const selectedMinutes = (hour * 60) + minute;
    if (!timeFitsScheduleWindow(selectedMinutes, window)) {
      return {
        ok: false,
        code: 'TIME_OUTSIDE_PERIOD_WINDOW',
        message: `Select a time within ${window.label} for this schedule item.`,
      };
    }
  }

  const selectedPeriod = schedulePeriodKey(canonicalDisplayTime) ||
    schedulePeriodKey(rows[0].display_time);

  const medicalConstraint = verifiedTimingConstraint(rows[0]);
  if (
    selectedPeriod &&
    medicalConstraint &&
    selectedPeriod !== medicalConstraint.period
  ) {
    const requiredLabel =
      medicalConstraint.period[0].toUpperCase() + medicalConstraint.period.slice(1);
    const selectedLabel = selectedPeriod[0].toUpperCase() + selectedPeriod.slice(1);
    return {
      ok: false,
      code: 'MEDICAL_TIMING_CONFLICT',
      message:
        `Medical timing conflict: ${selectedLabel} conflicts with the verified ` +
        `${medicalConstraint.phrase} instruction. SehatMate did not save this reminder.`,
      data: {
        medicalTimingConflict: true,
        requiredPeriod: medicalConstraint.period,
        selectedPeriod,
        selectedTime: canonicalScheduleTime,
        originalInstruction:
          cleanText(rows[0].original_instruction || rows[0].instruction, 4000),
        originalTiming:
          cleanText(rows[0].original_timing || rows[0].timing, 160),
        recommendation:
          `Keep this reminder in ${requiredLabel}, or confirm a different medical timing with the prescribing clinician or pharmacist before changing it.`,
      },
    };
  }

  // One instruction occurrence should not contain two reminder cards for
  // the same period or the same exact time. Keep the check scoped to the
  // same instruction and schedule date so repeating plans on other dates
  // are not incorrectly blocked.
  const [siblings] = await pool.execute(
    `SELECT id, TIME_FORMAT(schedule_time, '%H:%i') AS schedule_time, display_time
     FROM care_schedule_items
     WHERE care_plan_id = ?
       AND user_id = ?
       AND instruction_id <=> ?
       AND schedule_date <=> ?
       AND id <> ?`,
    [
      rows[0].care_plan_id,
      userId,
      rows[0].instruction_id,
      rows[0].schedule_date,
      itemId,
    ],
  );

  const sameTime = siblings.find(
    (item) => String(item.schedule_time || '').slice(0, 5) === canonicalScheduleTime,
  );
  if (sameTime) {
    return {
      ok: false,
      code: 'DUPLICATE_REMINDER_TIME',
      message: 'This exact reminder time is already used for another dose of this instruction. Choose a different time.',
    };
  }

  if (selectedPeriod) {
    const samePeriod = siblings.find(
      (item) => schedulePeriodKey(item.display_time) === selectedPeriod,
    );
    if (samePeriod) {
      const periodLabel = selectedPeriod[0].toUpperCase() + selectedPeriod.slice(1);
      return {
        ok: false,
        code: 'DUPLICATE_REMINDER_PERIOD',
        message: `${periodLabel} is already used for another reminder for this instruction. Choose a different period.`,
      };
    }
  }

  return {
    ok: true,
    message: 'Exact reminder time validated.',
    data: {
      row: rows[0],
      displayTime:
        canonicalDisplayTime ||
        cleanText(rows[0].display_time, 160) ||
        `Confirmed reminder at ${canonicalScheduleTime}`,
      scheduleTime: canonicalScheduleTime,
      selectedPeriod,
    },
  };
}

/**
 * Confirm an exact reminder time for one schedule item.
 */
export async function confirmScheduleItem({
  pool,
  userId,
  itemId,
  displayTime,
  scheduleTime,
  learningSource,
}) {
  const canonicalLearningSource = cleanText(learningSource, 60);
  const validated = await validateScheduleItemConfirmation({
    pool,
    userId,
    itemId,
    displayTime,
    scheduleTime,
  });
  if (!validated.ok) return validated;

  const { row, displayTime: canonicalDisplayTime, scheduleTime: canonicalScheduleTime, selectedPeriod } =
    validated.data;

  await pool.execute(
    `UPDATE care_schedule_items
     SET schedule_time = ?, display_time = ?, requires_confirmation = 0,
         confirmation_status = 'ready', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`,
    [canonicalScheduleTime, canonicalDisplayTime, itemId, userId],
  );

  await pool.execute(
    `UPDATE care_task_occurrences
     SET scheduled_at = CONCAT(occurrence_date, ' ', ?, ':00'),
         updated_at = CURRENT_TIMESTAMP
     WHERE schedule_item_id = ? AND user_id = ? AND status = 'pending'`,
    [canonicalScheduleTime, itemId, userId],
  );

  const oldTime = String(row.schedule_time || '').slice(0, 5);
  if (oldTime !== canonicalScheduleTime) {
    await recordRoutineLearningEvent({
      db: pool,
      userId,
      carePlanId: String(row.care_plan_id),
      eventType:
        canonicalLearningSource === 'ai_suggestion_accept'
          ? 'suggestion_accepted'
          : 'manual_schedule_edit',
      period: selectedPeriod,
      scheduleTime: canonicalScheduleTime,
      signalValue: row.title || canonicalDisplayTime,
      metadata: {
        taskId: String(itemId),
        previousTime: oldTime || null,
        grounding: row.grounding || null,
      },
    });
  }

  await refreshCareGaps({
    db: pool,
    planId: String(row.care_plan_id),
    userId,
    realityQuestionTemplates,
  });

  return {
    ok: true,
    message: 'Exact reminder time confirmed.',
    data: { scheduleTime: canonicalScheduleTime },
  };
}
