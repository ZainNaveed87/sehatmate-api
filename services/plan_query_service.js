/**
 * Authoritative read-only care-plan query domain.
 *
 * Both the REST routes in server.js and any future read-only agent tool
 * must call the exported functions here instead of duplicating these
 * queries. The functions were moved verbatim from server.js during the
 * Phase A service extraction.
 *
 * Every query is scoped by the authenticated userId parameter; write
 * operations (create/delete/update/status) intentionally remain in
 * server.js route handlers.
 */

import {
  careGapJson,
  careGapSummary,
  refreshCareGaps,
} from '../care_gap_engine.js';

import {
  cleanText,
  idPattern,
  parseStoredJson,
  parseStoredObject,
  serverDateKey,
} from './shared_utils.js';

import {
  realityQuestionTemplates,
} from './reality_answer_service.js';

import {
  reconcilePlanLifecycle,
  scheduleItemDurationExpired,
} from './task_outcome_service.js';

export function inferredSetupStep(status) {
  if (status === 'active' || status === 'completed') return 'complete';
  if (status === 'draft' || status === 'processing') return 'upload';
  if (status === 'needs_review') return 'review';
  return 'schedule';
}

export function carePlanJson(row) {
  return {
    id: String(row.id),
    title: row.title,
    status: row.status,
    startDate: row.start_date,
    readinessScore: Number(row.readiness_score || 0),
    understandingScore: Number(row.understanding_score || 0),
    activatedAt: row.activated_at,
    completedAt: row.completed_at,
    completionReason: row.completion_reason || null,
    completedBy: row.completed_by || null,
    durationMode: row.duration_mode || 'prescription',
    suggestedEndDate: row.suggested_end_date,
    plannedEndDate: row.planned_end_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    documentCount: Number(row.document_count || 0),
    taskCount: Number(row.task_count || 0),
    openGapCount: Number(row.open_gap_count || 0),
    setupStep: row.setup_step || inferredSetupStep(row.status),
  };
}

/**
 * List every care plan of one user.
 *
 * Returns { ok: true, data: { plans } }.
 */
export async function listCarePlans({ pool, userId }) {
  await reconcilePlanLifecycle({ db: pool, userId });
  const [rows] = await pool.execute(
    `SELECT care_plans.*,
      (SELECT COUNT(*) FROM care_documents
        WHERE care_documents.care_plan_id = care_plans.id) AS document_count,
      (SELECT COUNT(*) FROM care_schedule_items
        WHERE care_schedule_items.care_plan_id = care_plans.id) AS task_count,
      (SELECT COUNT(*) FROM care_gaps
        WHERE care_gaps.care_plan_id = care_plans.id
          AND care_gaps.status <> 'resolved') AS open_gap_count
     FROM care_plans
     WHERE care_plans.user_id = ?
     ORDER BY care_plans.updated_at DESC`,
    [userId],
  );

  return { ok: true, data: { plans: rows.map(carePlanJson) } };
}

/**
 * Read the full detail payload for one care plan.
 *
 * Returns:
 *   { ok: false, code: 'INVALID_PLAN_ID', message }
 *   { ok: false, code: 'PLAN_NOT_FOUND', message }
 *   { ok: true, data: { plan, documents, instructions,
 *     verifiedInstructions, tasks, gaps, gapSummary, caregivers, questions } }
 */
export async function readCarePlanDetail({ pool, userId, planId }) {
  if (!idPattern.test(planId)) {
    return {
      ok: false,
      code: 'INVALID_PLAN_ID',
      message: 'Invalid care plan ID.',
    };
  }

  await reconcilePlanLifecycle({ db: pool, userId });
  const [plans] = await pool.execute(
    'SELECT * FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
    [planId, userId],
  );
  if (plans.length === 0) {
    return {
      ok: false,
      code: 'PLAN_NOT_FOUND',
      message: 'Care plan not found.',
    };
  }

  const [documents] = await pool.execute(
    `SELECT id, document_type, original_name, mime_type, file_size_bytes,
      page_count, processing_status, processing_error, created_at
     FROM care_documents
     WHERE care_plan_id = ? AND user_id = ? ORDER BY created_at DESC`,
    [planId, userId],
  );
  const [instructions] = await pool.execute(
    `SELECT id, document_id, category, title, instruction, timing,
      original_title, original_instruction, original_timing,
      duplicate_of_instruction_id, duplicate_reason,
      source_page, confidence_score, review_status,
      requires_professional_confirmation, ambiguity_reason,
      possible_interpretation, safety_note, safety_check_status,
      safety_check_summary, safety_possible_interpretation,
      safety_question, safety_sources,
      safety_checked_at, verified_at
     FROM extracted_instructions
     WHERE care_plan_id = ? ORDER BY id`,
    [planId],
  );
  const [tasks] = await pool.execute(
    `SELECT id, instruction_id, NULL AS caregiver_id,
      schedule_date AS task_date, schedule_date, schedule_time,
      COALESCE(TIME_FORMAT(schedule_time, '%H:%i'), NULLIF(display_time, ''), 'Review timing') AS task_time,
      title,
      CONCAT_WS(
        ' · ',
        NULLIF(recurrence_text, ''),
        NULLIF(display_time, ''),
        NULLIF(reason, ''),
        CASE
          WHEN instruction_duration_days IS NOT NULL
          THEN CONCAT('Fixed medicine course: ', instruction_duration_days, ' day', IF(instruction_duration_days = 1, '', 's'), '; stops automatically')
          ELSE NULL
        END
      ) AS note,
      task_kind, display_time, recurrence_text, grounding,
      CASE
        WHEN grounding = 'explicit' AND schedule_time IS NOT NULL THEN 1
        ELSE 0
      END AS time_locked,
      instruction_duration_days,
      CASE WHEN requires_confirmation = 1 THEN 'at_risk' ELSE 'ready' END AS status,
      NULL AS completed_at
     FROM care_schedule_items
     WHERE care_plan_id = ? AND user_id = ?
     ORDER BY schedule_date, schedule_time, id`,
    [planId, userId],
  );
  const visibleTasks = tasks.filter(
    (item) => !scheduleItemDurationExpired(item, serverDateKey(), plans[0]),
  );

  const gaps = await refreshCareGaps({
    db: pool,
    planId,
    userId,
    realityQuestionTemplates,
  });
  const [caregivers] = await pool.execute(
    `SELECT id, name, relationship, phone, availability, helps_with,
      access_permissions
     FROM caregivers
     WHERE user_id = ? AND (care_plan_id = ? OR care_plan_id IS NULL)
     ORDER BY name`,
    [userId, planId],
  );
  const [questions] = await pool.execute(
    `SELECT id, care_gap_id, group_name, title, question, answer,
      status, answered_at
     FROM doctor_questions WHERE care_plan_id = ? ORDER BY id`,
    [planId],
  );

  return {
    ok: true,
    data: {
      plan: carePlanJson(plans[0]),
      documents: documents.map((item) => ({ ...item, id: String(item.id) })),
      instructions: instructions
        .filter((item) => cleanText(item.title, 160) && cleanText(item.instruction, 4000))
        .map((item) => ({
          ...item,
          id: String(item.id),
          title: cleanText(item.title, 160),
          instruction: cleanText(item.instruction, 4000),
          timing: cleanText(item.timing, 160) || null,
          document_id: item.document_id == null ? null : String(item.document_id),
          duplicate_of_instruction_id:
            item.duplicate_of_instruction_id == null
              ? null
              : String(item.duplicate_of_instruction_id),
          safety_sources: parseStoredJson(item.safety_sources),
        })),
      verifiedInstructions: instructions
        .filter((item) =>
          item.review_status === 'verified' &&
          cleanText(item.title, 160) &&
          cleanText(item.instruction, 4000))
        .map((item) => ({
          ...item,
          id: String(item.id),
          title: cleanText(item.title, 160),
          instruction: cleanText(item.instruction, 4000),
          timing: cleanText(item.timing, 160) || null,
          document_id: item.document_id == null ? null : String(item.document_id),
          duplicate_of_instruction_id:
            item.duplicate_of_instruction_id == null
              ? null
              : String(item.duplicate_of_instruction_id),
          safety_sources: parseStoredJson(item.safety_sources),
        })),
      tasks: visibleTasks.map((item) => ({
        ...item,
        id: String(item.id),
        instruction_id: item.instruction_id == null ? null : String(item.instruction_id),
        caregiver_id: item.caregiver_id == null ? null : String(item.caregiver_id),
      })),
      gaps: gaps.map(careGapJson),
      gapSummary: careGapSummary(gaps),
      caregivers: caregivers.map((item) => ({
        ...item,
        id: String(item.id),
        helps_with: parseStoredJson(item.helps_with),
        access_permissions: parseStoredJson(item.access_permissions),
      })),
      questions: questions.map((item) => ({
        ...item,
        id: String(item.id),
        care_gap_id: item.care_gap_id == null ? null : String(item.care_gap_id),
      })),
    },
  };
}

/**
 * Read the lifecycle event history of one care plan.
 *
 * Returns:
 *   { ok: false, code: 'INVALID_PLAN_ID', message }
 *   { ok: false, code: 'PLAN_NOT_FOUND', message }
 *   { ok: true, data: { events } }
 */
export async function readPlanLifecycleEvents({ pool, userId, planId }) {
  if (!idPattern.test(planId)) {
    return {
      ok: false,
      code: 'INVALID_PLAN_ID',
      message: 'Invalid care plan ID.',
    };
  }

  const [plans] = await pool.execute(
    'SELECT id FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
    [planId, userId],
  );
  if (!plans.length) {
    return {
      ok: false,
      code: 'PLAN_NOT_FOUND',
      message: 'Care plan not found.',
    };
  }

  const [events] = await pool.execute(
    `SELECT id, event_type, reason, metadata_json, created_at
     FROM care_plan_lifecycle_events
     WHERE care_plan_id = ? AND user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 100`,
    [planId, userId],
  );

  return {
    ok: true,
    data: {
      events: events.map((event) => ({
        id: String(event.id),
        eventType: event.event_type,
        reason: event.reason || '',
        metadata: parseStoredObject(event.metadata_json),
        createdAt: event.created_at,
      })),
    },
  };
}
