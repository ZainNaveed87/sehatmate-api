/**
 * Authoritative task-occurrence and care-plan lifecycle domain.
 *
 * Both the REST routes in server.js and any future agent tool must call
 * the exported functions here instead of duplicating this logic. The
 * functions were moved verbatim from server.js during the Phase A
 * service extraction.
 *
 * Safety properties preserved from the original route handlers:
 *   - every query is scoped by the authenticated userId parameter
 *   - operationKey idempotency through care_task_outcome_operations
 *   - baseStatus optimistic concurrency checks
 *   - pending/completed/skipped transition rules (including the rule that
 *     a past occurrence can never return to pending)
 *   - missed/completed correction behavior via reconcileMissedOccurrences
 */

import { recordRoutineLearningEvent } from '../routine_learning.js';

import {
  addDaysToDateKey,
  cleanText,
  dbDateKey,
  idPattern,
  schedulePeriodKey,
  serverDateKey,
  taskOutcomeDate,
} from './shared_utils.js';

function scheduleItemEffectiveStart(item, dateKey, plan) {
  const activatedDate = dbDateKey(plan?.activated_at);
  const scheduleDate = dbDateKey(item?.schedule_date);
  const planStartDate = dbDateKey(plan?.start_date);

  // Fixed medicine duration begins when the plan is actually activated.
  // schedule_date is an operational reminder date and must not silently
  // restart a "for N days" course on a later date.
  //
  // If a future version stores a clinician-specified medicine start date in
  // its own dedicated field, that explicit medical date should outrank this.
  if (activatedDate) return activatedDate;
  if (scheduleDate) return scheduleDate;
  if (planStartDate) return planStartDate;
  return dateKey;
}

function scheduleItemDurationEndDate(item, dateKey, plan) {
  const durationDays = Number(item?.instruction_duration_days || 0);
  if (!Number.isInteger(durationDays) || durationDays <= 0) return '';
  const effectiveStart = scheduleItemEffectiveStart(item, dateKey, plan);
  return effectiveStart ? addDaysToDateKey(effectiveStart, durationDays - 1) : '';
}

export function scheduleItemDurationExpired(item, dateKey, plan) {
  const durationDays = Number(item?.instruction_duration_days || 0);
  if (!Number.isInteger(durationDays) || durationDays <= 0) return false;

  // Before activation, do not silently age a fixed medicine course just because
  // the user spent time reviewing/setup. Once active, the course has a stable
  // effective start and can be hard-stopped.
  if (!['active', 'completed'].includes(String(plan?.status || ''))) return false;

  const endDate = scheduleItemDurationEndDate(item, dateKey, plan);
  return Boolean(endDate && dateKey > endDate);
}

function scheduleItemIsDaily(item) {
  const recurrence = String(item?.recurrence_text || '').toLowerCase();
  return /\b(?:daily|every\s+day|each\s+day|once\s+daily|twice\s+daily|times\s+daily|per\s+day)\b/.test(recurrence);
}

function scheduleItemAppliesOnDate(item, dateKey, plan) {
  if (!item?.schedule_time) return false;

  const daily = scheduleItemIsDaily(item);
  const scheduleDate = dbDateKey(item.schedule_date);
  const planStartDate = dbDateKey(plan?.start_date);
  const activatedDate = dbDateKey(plan?.activated_at);

  // Recurring reminder slots created from instructions such as "3 times daily"
  // intentionally may not have a schedule_date. In that case the care-plan
  // start/activation date is the effective beginning of the recurring series.
  // A one-off task still requires its own explicit schedule_date.
  if (!daily && !scheduleDate) return false;

  const effectiveStart = scheduleItemEffectiveStart(item, dateKey, plan);

  if (effectiveStart && dateKey < effectiveStart) return false;

  const instructionEnd = scheduleItemDurationEndDate(item, dateKey, plan);
  if (instructionEnd && dateKey > instructionEnd) return false;

  const plannedEnd = dbDateKey(plan?.planned_end_date);
  if (plan?.duration_mode !== 'ongoing' && plannedEnd && dateKey > plannedEnd) {
    return false;
  }

  const completedDate = dbDateKey(plan?.completed_at);
  if (plan?.status === 'completed' && completedDate && dateKey > completedDate) {
    return false;
  }

  if (daily) return true;
  return dateKey === scheduleDate;
}

export function taskOccurrenceJson(row) {
  const occurrenceDate = String(row.occurrence_date || '').slice(0, 10);
  const scheduledTime = String(row.scheduled_time || '').slice(0, 5);
  const completedTime = String(row.completed_time || '').slice(0, 5);
  return {
    id: String(row.id),
    carePlanId: String(row.care_plan_id),
    scheduleItemId: String(row.schedule_item_id),
    occurrenceDate,
    scheduledTime,
    title: row.title,
    taskKind: row.task_kind,
    period: schedulePeriodKey(`${row.display_time || ''} ${row.recurrence_text || ''}`),
    recurrenceText: row.recurrence_text || '',
    grounding: row.grounding || 'suggested',
    status: row.status || 'pending',
    completedAt: row.completed_at || null,
    completedTime: completedTime || null,
    outcomeSource: row.outcome_source || 'user',
    note: row.note || '',
  };
}

export async function reconcileExpiredFixedDurationOccurrences({
  db,
  userId,
  planId,
  dateKey,
}) {
  const [plans] = await db.execute(
    `SELECT id, status, start_date, activated_at
     FROM care_plans
     WHERE id = ? AND user_id = ?
     LIMIT 1`,
    [planId, userId],
  );
  const plan = plans[0];
  if (!plan || plan.status !== 'active') return;

  const [items] = await db.execute(
    `SELECT id, schedule_date, instruction_duration_days
     FROM care_schedule_items
     WHERE care_plan_id = ? AND user_id = ?
       AND instruction_duration_days IS NOT NULL`,
    [planId, userId],
  );

  for (const item of items) {
    const instructionEnd = scheduleItemDurationEndDate(item, dateKey, plan);
    if (!instructionEnd || dateKey <= instructionEnd) continue;

    await db.execute(
      `DELETE FROM care_task_occurrences
       WHERE user_id = ?
         AND care_plan_id = ?
         AND schedule_item_id = ?
         AND occurrence_date > ?
         AND status = 'pending'`,
      [userId, planId, item.id, instructionEnd],
    );
  }
}

export async function ensureOccurrencesForDate({ db, userId, planId, dateKey }) {
  const [plans] = await db.execute(
    `SELECT id, status, start_date, activated_at, completed_at,
      duration_mode, planned_end_date
     FROM care_plans
     WHERE id = ? AND user_id = ?
     LIMIT 1`,
    [planId, userId],
  );
  const plan = plans[0];
  if (!plan || plan.status !== 'active') return;

  const [items] = await db.execute(
    `SELECT id, care_plan_id, user_id, schedule_date, schedule_time,
      display_time, recurrence_text, grounding, title, task_kind,
      instruction_duration_days
     FROM care_schedule_items
     WHERE care_plan_id = ? AND user_id = ? AND schedule_time IS NOT NULL
     ORDER BY id`,
    [planId, userId],
  );

  for (const item of items) {
    const instructionEnd = scheduleItemDurationEndDate(item, dateKey, plan);

    // A fixed-duration medicine can already have pending occurrence rows that
    // were generated while its course was still active. Once the verified
    // medicine-specific end date has passed, remove only those future/pending
    // rows. Completed/skipped/missed history is intentionally preserved.
    if (instructionEnd && dateKey > instructionEnd) {
      await db.execute(
        `DELETE FROM care_task_occurrences
         WHERE user_id = ?
           AND care_plan_id = ?
           AND schedule_item_id = ?
           AND occurrence_date > ?
           AND status = 'pending'`,
        [userId, planId, item.id, instructionEnd],
      );
      continue;
    }

    if (!scheduleItemAppliesOnDate(item, dateKey, plan)) continue;
    const scheduledTime = String(item.schedule_time || '').slice(0, 5);
    if (!scheduledTime) continue;
    await db.execute(
      `INSERT IGNORE INTO care_task_occurrences (
        user_id, care_plan_id, schedule_item_id, occurrence_date,
        scheduled_at, status, outcome_source
       ) VALUES (?, ?, ?, ?, ?, 'pending', 'system')`,
      [
        userId,
        planId,
        item.id,
        dateKey,
        `${dateKey} ${scheduledTime}:00`,
      ],
    );
  }
}

export async function ensureOccurrencesForRange({ db, userId, planId, startDate, endDate }) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return;
  let count = 0;
  for (let cursor = start; cursor <= end && count < 31; cursor = new Date(cursor.getTime() + 86400000)) {
    await ensureOccurrencesForDate({
      db,
      userId,
      planId,
      dateKey: cursor.toISOString().slice(0, 10),
    });
    count += 1;
  }
}

async function removeOccurrenceLearningSignals(db, userId, occurrenceId) {
  await db.execute(
    `DELETE FROM routine_learning_events
     WHERE user_id = ? AND source_key LIKE ?`,
    [userId, `task-occurrence:${occurrenceId}:%`],
  );
}

async function recordOccurrenceLearning({ db, row, userId, outcome }) {
  const period = schedulePeriodKey(`${row.display_time || ''} ${row.recurrence_text || ''}`);
  const scheduleTime = String(row.scheduled_time || '').slice(0, 5);
  if (!scheduleTime) return;
  const eventType = outcome === 'completed'
    ? 'task_completed'
    : outcome === 'missed'
      ? 'task_missed'
      : outcome === 'skipped'
        ? 'task_skipped'
        : null;
  if (!eventType) return;

  await recordRoutineLearningEvent({
    db,
    userId,
    carePlanId: String(row.care_plan_id),
    eventType,
    period,
    scheduleTime,
    signalValue: `${row.title || 'Care task'} · ${outcome}`,
    sourceKey: `task-occurrence:${row.id}:${outcome}`,
    metadata: {
      occurrenceId: String(row.id),
      taskId: String(row.schedule_item_id),
      outcome,
      occurrenceDate: String(row.occurrence_date || '').slice(0, 10),
    },
  });
}

export async function reconcileMissedOccurrences({ db, userId, beforeDate }) {
  const [rows] = await db.execute(
    `SELECT o.id, o.care_plan_id, o.schedule_item_id, o.occurrence_date,
      TIME_FORMAT(o.scheduled_at, '%H:%i') AS scheduled_time,
      s.title, s.task_kind, s.display_time, s.recurrence_text
     FROM care_task_occurrences o
     JOIN care_schedule_items s ON s.id = o.schedule_item_id
     WHERE o.user_id = ? AND o.status = 'pending' AND o.occurrence_date < ?
     ORDER BY o.occurrence_date, o.scheduled_at
     LIMIT 500`,
    [userId, beforeDate],
  );

  for (const row of rows) {
    const [result] = await db.execute(
      `UPDATE care_task_occurrences
       SET status = 'missed', outcome_source = 'system', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND status = 'pending'`,
      [row.id, userId],
    );
    if (!result.affectedRows) continue;
    await removeOccurrenceLearningSignals(db, userId, row.id);
    await recordOccurrenceLearning({ db, row, userId, outcome: 'missed' });
  }
}

export async function recordLifecycleEvent({ db, userId, planId, eventType, reason, metadata = null }) {
  await db.execute(
    `INSERT INTO care_plan_lifecycle_events (
      user_id, care_plan_id, event_type, reason, metadata_json
     ) VALUES (?, ?, ?, ?, ?)`,
    [
      userId,
      planId,
      cleanText(eventType, 60),
      cleanText(reason, 500) || null,
      metadata ? JSON.stringify(metadata).slice(0, 4000) : null,
    ],
  );
}

export async function reconcilePlanLifecycle({ db, userId = null, today = serverDateKey() }) {
  const params = [];
  let userFilter = '';
  if (userId != null) {
    userFilter = ' AND user_id = ?';
    params.push(userId);
  }
  params.push(today);

  const [plans] = await db.execute(
    `SELECT id, user_id, title, duration_mode, planned_end_date
     FROM care_plans
     WHERE status = 'active'
       AND duration_mode <> 'ongoing'
       AND planned_end_date IS NOT NULL
       ${userFilter}
       AND planned_end_date < ?
     ORDER BY id`,
    params,
  );

  for (const plan of plans) {
    const [result] = await db.execute(
      `UPDATE care_plans
       SET status = 'completed', setup_step = 'complete',
           completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
           completion_reason = 'plan_end_date', completed_by = 'system',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND status = 'active'`,
      [plan.id, plan.user_id],
    );
    if (!result.affectedRows) continue;

    await db.execute(
      `DELETE FROM care_task_occurrences
       WHERE care_plan_id = ? AND user_id = ?
         AND status = 'pending' AND occurrence_date > ?`,
      [plan.id, plan.user_id, dbDateKey(plan.planned_end_date)],
    );

    await recordLifecycleEvent({
      db,
      userId: plan.user_id,
      planId: plan.id,
      eventType: 'auto_completed',
      reason: 'The selected care-plan end date was reached.',
      metadata: { plannedEndDate: dbDateKey(plan.planned_end_date) },
    });
  }

  return plans.length;
}

/**
 * Record a user outcome for one task occurrence.
 *
 * Returns a structured domain result:
 *   { ok: false, code: 'INVALID_TASK_OUTCOME', message }
 *   { ok: false, code: 'INVALID_TASK_BASE_STATUS', message }
 *   { ok: false, code: 'TASK_OCCURRENCE_NOT_FOUND', message }
 *   { ok: false, code: 'PAST_OCCURRENCE_PENDING_CONFLICT', message, data }
 *   { ok: false, code: 'TASK_BASE_STATUS_CONFLICT', message, data }
 *   { ok: true, message, data: { occurrence } }
 *   { ok: true, message, data: { occurrence, idempotentReplay: true } }
 *
 * Unexpected database errors are re-thrown for the caller's error
 * middleware; the transaction is rolled back first, exactly like the
 * original route handler.
 */
export async function applyTaskOutcome({
  pool,
  userId,
  occurrenceId,
  outcome,
  note = '',
  operationKey = '',
  baseStatus = '',
  today = null,
}) {
  const canonicalOutcome = cleanText(outcome, 20).toLowerCase();
  const canonicalNote = cleanText(note, 500);
  const canonicalOperationKey = cleanText(operationKey, 120);
  const canonicalBaseStatus = cleanText(baseStatus, 20).toLowerCase();

  if (!idPattern.test(occurrenceId) || !['pending', 'completed', 'skipped'].includes(canonicalOutcome)) {
    return {
      ok: false,
      code: 'INVALID_TASK_OUTCOME',
      message: 'Select a valid task outcome.',
    };
  }
  if (canonicalBaseStatus && !['pending', 'completed', 'skipped', 'missed'].includes(canonicalBaseStatus)) {
    return {
      ok: false,
      code: 'INVALID_TASK_BASE_STATUS',
      message: 'Invalid task base status.',
    };
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT o.id, o.care_plan_id, o.schedule_item_id, o.occurrence_date,
        TIME_FORMAT(o.scheduled_at, '%H:%i') AS scheduled_time,
        o.status, o.completed_at,
        TIME_FORMAT(o.completed_at, '%H:%i') AS completed_time,
        o.outcome_source, o.note,
        s.title, s.task_kind, s.display_time, s.recurrence_text, s.grounding
       FROM care_task_occurrences o
       JOIN care_schedule_items s ON s.id = o.schedule_item_id
       WHERE o.id = ? AND o.user_id = ?
       LIMIT 1 FOR UPDATE`,
      [occurrenceId, userId],
    );
    const row = rows[0];
    if (!row) {
      await connection.rollback();
      return {
        ok: false,
        code: 'TASK_OCCURRENCE_NOT_FOUND',
        message: 'Task occurrence not found.',
      };
    }

    if (canonicalOperationKey) {
      const [operations] = await connection.execute(
        `SELECT id
         FROM care_task_outcome_operations
         WHERE user_id = ? AND operation_key = ?
         LIMIT 1`,
        [userId, canonicalOperationKey],
      );
      if (operations.length) {
        await connection.commit();
        return {
          ok: true,
          message: 'Task outcome was already synchronized.',
          data: { occurrence: taskOccurrenceJson(row), idempotentReplay: true },
        };
      }
    }

    const clientToday = taskOutcomeDate(today) || serverDateKey();
    if (canonicalOutcome === 'pending' && String(row.occurrence_date).slice(0, 10) < clientToday) {
      await connection.rollback();
      return {
        ok: false,
        code: 'PAST_OCCURRENCE_PENDING_CONFLICT',
        message: 'A past occurrence cannot be returned to pending. Record what actually happened instead.',
        data: { occurrence: taskOccurrenceJson(row), conflict: true },
      };
    }

    if (canonicalBaseStatus && row.status !== canonicalBaseStatus && row.status !== canonicalOutcome) {
      await connection.rollback();
      return {
        ok: false,
        code: 'TASK_BASE_STATUS_CONFLICT',
        message: 'This task changed on another device. The latest server outcome was kept.',
        data: { occurrence: taskOccurrenceJson(row), conflict: true },
      };
    }

    if (row.status !== canonicalOutcome || (canonicalNote || '') !== (row.note || '')) {
      await connection.execute(
        `UPDATE care_task_occurrences
         SET status = ?,
             completed_at = CASE
               WHEN ? = 1 AND status <> 'completed' THEN CURRENT_TIMESTAMP
               WHEN ? = 1 THEN completed_at
               ELSE NULL
             END,
             outcome_source = 'user', note = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`,
        [
          canonicalOutcome,
          canonicalOutcome === 'completed' ? 1 : 0,
          canonicalOutcome === 'completed' ? 1 : 0,
          canonicalNote || null,
          occurrenceId,
          userId,
        ],
      );

      await removeOccurrenceLearningSignals(connection, userId, occurrenceId);
      if (canonicalOutcome === 'completed' || canonicalOutcome === 'skipped') {
        await recordOccurrenceLearning({
          db: connection,
          row,
          userId,
          outcome: canonicalOutcome,
        });
      }
    }

    if (canonicalOperationKey) {
      await connection.execute(
        `INSERT IGNORE INTO care_task_outcome_operations
          (user_id, occurrence_id, operation_key, outcome)
         VALUES (?, ?, ?, ?)`,
        [userId, occurrenceId, canonicalOperationKey, canonicalOutcome],
      );
    }

    await connection.commit();

    const [updated] = await pool.execute(
      `SELECT o.id, o.care_plan_id, o.schedule_item_id, o.occurrence_date,
        TIME_FORMAT(o.scheduled_at, '%H:%i') AS scheduled_time,
        o.status, o.completed_at,
        TIME_FORMAT(o.completed_at, '%H:%i') AS completed_time,
        o.outcome_source, o.note,
        s.title, s.task_kind, s.display_time, s.recurrence_text, s.grounding
       FROM care_task_occurrences o
       JOIN care_schedule_items s ON s.id = o.schedule_item_id
       WHERE o.id = ? AND o.user_id = ? LIMIT 1`,
      [occurrenceId, userId],
    );

    return {
      ok: true,
      message: canonicalOutcome === 'completed'
        ? 'Task marked completed.'
        : canonicalOutcome === 'skipped'
          ? 'Task recorded as skipped.'
          : 'Task outcome cleared.',
      data: { occurrence: taskOccurrenceJson(updated[0]) },
    };
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    throw error;
  } finally {
    connection.release();
  }
}
