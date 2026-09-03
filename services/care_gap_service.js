/**
 * Authoritative care-gap read and lifecycle domain.
 *
 * Both the REST routes in server.js and any future agent tool must call
 * the exported functions here instead of duplicating this logic. The
 * functions were moved verbatim from server.js during the Phase A
 * service extraction.
 *
 * Protections preserved unchanged:
 *   - care_gap_engine.js stays authoritative for gap detection
 *   - readCareGapForUser ownership scoping (a gap is only reachable
 *     through a plan owned by the authenticated user)
 *   - auto-managed gaps cannot be manually resolved; the engine must
 *     resolve the underlying source first
 *   - reopening restores the severity-appropriate legacy status
 *   - doctor-question behavior stays outside this service boundary
 */

import {
  careGapJson,
  careGapSummary,
  readCareGapForUser,
  readCareGaps,
  refreshCareGaps,
} from '../care_gap_engine.js';

import {
  analyzeAndStoreCareGapContext,
} from '../care_context_engine.js';

import {
  generateAiText,
} from '../ai_service.js';

import {
  cleanText,
  idPattern,
} from './shared_utils.js';

import {
  realityQuestionTemplates,
} from './reality_answer_service.js';

/**
 * List the care gaps of one plan, optionally filtered.
 *
 * Returns:
 *   { ok: false, code: 'INVALID_PLAN_ID', message }
 *   { ok: false, code: 'PLAN_NOT_FOUND', message }
 *   { ok: true, data: { summary, gaps } }
 */
export async function listCareGaps({
  pool,
  userId,
  planId,
  lifecycle = '',
  severity = '',
  gapType = '',
}) {
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

  let gaps = await refreshCareGaps({
    db: pool,
    planId,
    userId,
    realityQuestionTemplates,
  });

  const canonicalLifecycle = cleanText(lifecycle, 20).toLowerCase();
  const canonicalSeverity = cleanText(severity, 20).toLowerCase();
  const canonicalGapType = cleanText(gapType, 40).toLowerCase();

  if (['open', 'in_progress', 'resolved'].includes(canonicalLifecycle)) {
    gaps = gaps.filter((item) => item.lifecycle_status === canonicalLifecycle);
  }
  if (['blocking', 'attention'].includes(canonicalSeverity)) {
    gaps = gaps.filter((item) => item.severity === canonicalSeverity);
  }
  if (canonicalGapType) {
    gaps = gaps.filter((item) => item.gap_type === canonicalGapType);
  }

  const allRows = await readCareGaps(pool, planId);

  return {
    ok: true,
    data: {
      summary: careGapSummary(allRows),
      gaps: gaps.map(careGapJson),
    },
  };
}

/**
 * Read one care gap with its doctor questions.
 *
 * Returns:
 *   { ok: false, code: 'INVALID_GAP_ID', message }
 *   { ok: false, code: 'GAP_NOT_FOUND', message }
 *   { ok: true, data: { gap, doctorQuestions } }
 */
export async function readCareGapDetail({ pool, userId, gapId }) {
  if (!idPattern.test(gapId)) {
    return {
      ok: false,
      code: 'INVALID_GAP_ID',
      message: 'Invalid care gap ID.',
    };
  }

  const gap = await readCareGapForUser(
    pool,
    gapId,
    userId,
  );

  if (!gap) {
    return {
      ok: false,
      code: 'GAP_NOT_FOUND',
      message: 'Care gap not found.',
    };
  }

  const [questions] = await pool.execute(
    `SELECT
       id,
       care_gap_id,
       group_name,
       title,
       question,
       answer,
       status,
       answered_at,
       created_at,
       updated_at
     FROM doctor_questions
     WHERE care_gap_id = ?
       AND care_plan_id = ?
     ORDER BY id`,
    [
      gapId,
      gap.care_plan_id,
    ],
  );

  return {
    ok: true,
    data: {
      gap: careGapJson(gap),

      doctorQuestions: questions.map(
        (item) => ({
          ...item,

          id: String(item.id),

          care_gap_id:
            item.care_gap_id == null
              ? null
              : String(item.care_gap_id),
        }),
      ),
    },
  };
}

/**
 * Verify that one care gap is reachable for the authenticated user
 * without loading doctor questions or the full gap payload. Ownership is
 * enforced by readCareGapForUser (a gap is only reachable through a plan
 * owned by the authenticated user); this is the authoritative lightweight
 * primitive for agent context validation and agent navigation
 * authorization.
 *
 * Returns:
 *   { ok: false, code: 'INVALID_GAP_ID', message }
 *   { ok: false, code: 'GAP_NOT_FOUND', message }
 *   { ok: true, data: { gapId, planId, title } }
 */
export async function verifyCareGapOwnership({ pool, userId, gapId }) {
  if (!idPattern.test(gapId)) {
    return {
      ok: false,
      code: 'INVALID_GAP_ID',
      message: 'Invalid care gap ID.',
    };
  }

  const gap = await readCareGapForUser(pool, gapId, userId);
  if (!gap) {
    return {
      ok: false,
      code: 'GAP_NOT_FOUND',
      message: 'Care gap not found.',
    };
  }

  return {
    ok: true,
    data: {
      gapId: String(gap.id),
      planId: String(gap.care_plan_id),
      title: gap.title || '',
    },
  };
}

/**
 * Update the lifecycle status of one care gap.
 *
 * Returns:
 *   { ok: false, code: 'INVALID_GAP_ID', message }
 *   { ok: false, code: 'INVALID_CARE_GAP_STATUS', message }
 *   { ok: false, code: 'GAP_NOT_FOUND', message }
 *   { ok: false, code: 'AUTO_MANAGED_GAP_NOT_RESOLVED', message, data }
 *   { ok: true, message: 'The underlying issue is already resolved.', data }
 *   { ok: true, message: 'Care gap updated.', data }
 */
export async function updateCareGapLifecycle({
  pool,
  userId,
  gapId,
  lifecycleStatus,
  resolutionNote = '',
  preferredLanguage = null,
}) {
  const canonicalLifecycleStatus = cleanText(lifecycleStatus, 20).toLowerCase();
  const canonicalResolutionNote = cleanText(resolutionNote, 2000);

  if (!idPattern.test(gapId)) {
    return {
      ok: false,
      code: 'INVALID_GAP_ID',
      message: 'Invalid care gap ID.',
    };
  }
  if (!['open', 'in_progress', 'resolved'].includes(canonicalLifecycleStatus)) {
    return {
      ok: false,
      code: 'INVALID_CARE_GAP_STATUS',
      message: 'Choose a valid care-gap status.',
    };
  }

  let gap = await readCareGapForUser(pool, gapId, userId);
  if (!gap) {
    return {
      ok: false,
      code: 'GAP_NOT_FOUND',
      message: 'Care gap not found.',
    };
  }

  if (Boolean(gap.auto_managed) && canonicalLifecycleStatus === 'resolved') {
    await refreshCareGaps({
      db: pool,
      planId: String(gap.care_plan_id),
      userId,
      realityQuestionTemplates,
    });
    gap = await readCareGapForUser(pool, gapId, userId);

    if (gap.lifecycle_status !== 'resolved') {
      return {
        ok: false,
        code: 'AUTO_MANAGED_GAP_NOT_RESOLVED',
        message: 'This care gap is managed automatically. Fix the underlying item first.',
        data: {
          gap: careGapJson(gap),
          nextStep: gap.next_step,
        },
      };
    }

    return {
      ok: true,
      message: 'The underlying issue is already resolved.',
      data: { gap: careGapJson(gap) },
    };
  }

  if (canonicalLifecycleStatus === 'resolved') {
    await pool.execute(
      `UPDATE care_gaps
       SET lifecycle_status = 'resolved', status = 'resolved',
         resolution_note = ?, resolved_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [canonicalResolutionNote || 'Resolved by the user.', gapId],
    );
  } else if (canonicalLifecycleStatus === 'in_progress') {
    await pool.execute(
      `UPDATE care_gaps
       SET lifecycle_status = 'in_progress',
         resolution_note = ?, resolved_at = NULL
       WHERE id = ?`,
      [canonicalResolutionNote || null, gapId],
    );
  } else {
    const reopenedStatus = gap.severity === 'blocking' ? 'blocked' : 'at_risk';
    await pool.execute(
      `UPDATE care_gaps
       SET lifecycle_status = 'open', status = ?,
         resolution_note = ?, resolved_at = NULL
       WHERE id = ?`,
      [reopenedStatus, canonicalResolutionNote || null, gapId],
    );
  }

  try {
    await analyzeAndStoreCareGapContext({
      db: pool,
      gapId,
      userId,
      generateAiText,
      preferredLanguage,
    });
  } catch (contextError) {
    /*
     * Saving the user's progress note is the primary
     * operation. Context analysis must not block it.
     */
    console.error(
      'Care-gap context analysis failed after progress note:',
      contextError,
    );
  }
  gap = await readCareGapForUser(pool, gapId, userId);

  return {
    ok: true,
    message: 'Care gap updated.',
    data: { gap: careGapJson(gap) },
  };
}
