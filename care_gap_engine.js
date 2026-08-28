const CARE_GAP_COLUMNS = `id, care_plan_id, task_id, category, gap_type, title, status,
  severity, lifecycle_status, when_text, summary, instruction_snapshot,
  patient_reality, reason, next_step, resolution_note, resolved_at,
  source_key, source_kind, source_id, due_at, auto_managed, created_at, updated_at`;

function text(value, max = 1000) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g, '').trim().replace(/\s+/g, ' ').slice(0, max)
    : '';
}

function dueDate(task) {
  const date = text(task?.schedule_date, 10);
  const time = text(task?.schedule_time, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return `${date} ${/^\d{2}:\d{2}$/.test(time) ? `${time}:00` : '23:59:59'}`;
}

function scheduleLabel(task) {
  const date = text(task?.schedule_date, 10);
  const time = text(task?.schedule_time, 5);
  const display = text(task?.display_time, 160);
  return [date, time || display].filter(Boolean).join(' · ') || null;
}

function stableKeyPart(value, max = 60) {
  return text(value, 200)
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max);
}

function scheduleSlotKey(task) {
  const display = text(task?.display_time, 160).toLowerCase();
  const recurrence = text(task?.recurrence_text, 160).toLowerCase();
  const combined = `${display} ${recurrence}`;

  if (/\bmorning\b|\bbreakfast\b/.test(combined)) return 'morning';
  if (/\bafternoon\b|\blunch\b/.test(combined)) return 'afternoon';
  if (/\bevening\b|\bdinner\b/.test(combined)) return 'evening';
  if (/\bbedtime\b|\bnight\b/.test(combined)) return 'night';

  return stableKeyPart(display) ||
    stableKeyPart(recurrence) ||
    stableKeyPart(task?.title) ||
    'general';
}

function scheduleIssueKey(task, issue) {
  const instructionId = text(String(task?.instruction_id ?? ''), 40);
  const instructionPart = instructionId
    ? `instruction_${instructionId}`
    : `title_${stableKeyPart(task?.title) || 'task'}`;

  return `schedule:${instructionPart}:${scheduleSlotKey(task)}:${issue}`.slice(0, 160);
}

function addGap(list, gap) {
  if (!gap?.sourceKey || list.some((item) => item.sourceKey === gap.sourceKey)) return;
  list.push({
    category: gap.category || 'other',
    gapType: gap.gapType || 'missing_information',
    title: text(gap.title, 200) || 'Care-plan item needs attention',
    legacyStatus: gap.legacyStatus || (gap.severity === 'blocking' ? 'blocked' : 'at_risk'),
    severity: gap.severity === 'blocking' ? 'blocking' : 'attention',
    whenText: text(gap.whenText, 160) || null,
    summary: text(gap.summary, 4000) || 'This care-plan item needs attention.',
    instructionSnapshot: text(gap.instructionSnapshot, 4000) || null,
    patientReality: text(gap.patientReality, 4000) || null,
    reason: text(gap.reason, 4000) || null,
    nextStep: text(gap.nextStep, 4000) || null,
    sourceKey: text(gap.sourceKey, 160),
    sourceKind: text(gap.sourceKind, 40) || null,
    sourceId: text(String(gap.sourceId ?? ''), 191) || null,
    dueAt: gap.dueAt || null,
  });
}

export function careGapAction(gap) {
  const resolved = gap?.lifecycle_status === 'resolved';
  const sourceKind = text(gap?.source_kind, 40).toLowerCase();

  switch (gap?.gap_type) {
    case 'verification':
      return {
        type: 'review_instruction',
        label: resolved ? 'View resolved instruction' : 'Review & Verify Instruction',
        carePlanTab: 0,
      };
    case 'schedule_gap':
      if (sourceKind === 'schedule_item') {
        return {
          type: 'review_schedule',
          label: resolved ? 'View resolved schedule item' : 'Set Reminder Time',
          carePlanTab: 1,
        };
      }
      return {
        type: 'review_schedule',
        label: resolved ? 'View resolved schedule' : 'Review Schedule',
        carePlanTab: 1,
      };
    case 'missing_information':
      return {
        type: 'reality_check',
        label: resolved ? 'View Reality Check' : 'Answer Reality Check',
        carePlanTab: null,
      };
    case 'document_gap':
      return {
        type: 'documents',
        label: resolved ? 'View Documents' : 'Upload Care Document',
        carePlanTab: 4,
      };
    case 'care_coordination':
      return {
        type: 'family_care',
        label: resolved ? 'View Family Care' : 'Arrange Caregiver',
        carePlanTab: null,
      };
    case 'overdue':
      return {
        type: 'calendar',
        label: resolved ? 'View Calendar' : 'Review Overdue Task',
        carePlanTab: null,
      };
    default:
      return {
        type: 'care_plan',
        label: resolved ? 'View Care Plan' : 'Review Care Plan',
        carePlanTab: null,
      };
  }
}

function careGapResolution(gap) {
  const sourceKind = text(gap?.source_kind, 40).toLowerCase();

  switch (gap?.gap_type) {
    case 'verification':
      return {
        title: 'How to resolve this gap',
        steps: [
          'Open the extracted instruction that triggered this gap.',
          'Compare the instruction with the original uploaded healthcare document.',
          'If the source itself is unclear, confirm the instruction with a qualified healthcare professional.',
          'Correct the extracted text if needed and mark the instruction verified only when it matches the source.',
          'Save the instruction. SehatRoute will automatically re-check this care gap.',
        ],
      };
    case 'schedule_gap':
      if (sourceKind === 'schedule_item') {
        return {
          title: 'How to resolve this gap',
          steps: [
            'Open the Schedule tab for this care plan.',
            'Find the scheduled item linked to this gap.',
            'Choose an exact reminder time inside the allowed period shown by the app.',
            'Confirm the time and save it.',
            'SehatRoute will automatically re-check this care gap.',
          ],
        };
      }
      return {
        title: 'How to resolve this gap',
        steps: [
          'Open the Schedule tab for this care plan.',
          'Regenerate or review the schedule so the verified instruction appears as a scheduled item.',
          'Do not change medical timing or treatment instructions yourself.',
          'Save the schedule changes. SehatRoute will automatically re-check this care gap.',
        ],
      };
    case 'missing_information':
      return {
        title: 'How to resolve this gap',
        steps: [
          'Open Reality Check for this care plan.',
          'Find and answer the missing practical question.',
          'Save the Reality Check answers.',
          'SehatRoute will automatically re-check this care gap using the saved answer.',
        ],
      };
    case 'document_gap':
      return {
        title: 'How to resolve this gap',
        steps: [
          'Open Documents for this care plan.',
          'Upload the relevant prescription, discharge summary, follow-up slip, or other care document.',
          'Complete instruction extraction and human verification for the uploaded document.',
          'SehatRoute will automatically re-check this care gap.',
        ],
      };
    case 'care_coordination':
      return {
        title: 'How to resolve this gap',
        steps: [
          'Open Family Care.',
          'Add or select a trusted caregiver who can help with the related task.',
          'Confirm that the helper is available for the task when required.',
          'Link the caregiver to the relevant care task, then return to Care Gaps and refresh.',
        ],
      };
    case 'overdue':
      return {
        title: 'How to resolve this gap',
        steps: [
          'Open the Calendar and review the overdue care task.',
          'Check the original care instruction before changing any date or timing.',
          'Record the completed or newly arranged care step as supported by the existing care plan.',
          'Return to Care Gaps and refresh the check.',
        ],
      };
    default:
      return {
        title: 'How to resolve this gap',
        steps: [
          'Open the related care plan item shown below.',
          'Review the reason and suggested next step for this gap.',
          'Update the underlying care-plan information rather than manually dismissing an auto-managed gap.',
          'Return to Care Gaps and refresh the check.',
        ],
      };
  }
}

export function careGapJson(row) {
  const action = careGapAction(row);
  const resolution = careGapResolution(row);
  const resolved = row.lifecycle_status === 'resolved';
  const sourceId = row.source_id == null ? null : String(row.source_id);

  return {
    ...row,
    id: String(row.id),
    care_plan_id: String(row.care_plan_id),
    task_id: row.task_id == null ? null : String(row.task_id),
    source_id: sourceId,
    blocking: row.severity === 'blocking' && !resolved,
    display_severity: resolved && row.severity === 'blocking'
      ? 'previously_blocking'
      : row.severity,
    action_type: action.type,
    action_label: action.label,
    target: {
      care_plan_id: String(row.care_plan_id),
      source_kind: row.source_kind || null,
      source_id: sourceId,
      care_plan_tab: action.carePlanTab,
    },
    resolution_title: resolution.title,
    resolution_steps: resolution.steps,
    auto_recheck: Boolean(row.auto_managed),
    can_mark_resolved: !Boolean(row.auto_managed),
  };
}

export function careGapSummary(rows) {
  const open = rows.filter((item) => item.lifecycle_status !== 'resolved');
  return {
    total: rows.length,
    open: open.length,
    blocking: open.filter((item) => item.severity === 'blocking').length,
    attention: open.filter((item) => item.severity !== 'blocking').length,
    inProgress: open.filter((item) => item.lifecycle_status === 'in_progress').length,
    resolved: rows.filter((item) => item.lifecycle_status === 'resolved').length,
  };
}

export async function refreshCareGaps({ db, planId, userId, realityQuestionTemplates }) {
  const [documents] = await db.execute(
    `SELECT id, document_type, processing_status
     FROM care_documents WHERE care_plan_id = ? AND user_id = ?`,
    [planId, userId],
  );
  const [instructions] = await db.execute(
    `SELECT id, document_id, category, title, instruction, timing, review_status,
      requires_professional_confirmation, ambiguity_reason, safety_question
     FROM extracted_instructions WHERE care_plan_id = ? ORDER BY id`,
    [planId],
  );
  const [tasks] = await db.execute(
    `SELECT id, instruction_id, title, task_kind,
      DATE_FORMAT(schedule_date, '%Y-%m-%d') AS schedule_date,
      TIME_FORMAT(schedule_time, '%H:%i') AS schedule_time,
      display_time, recurrence_text, reason, requires_confirmation
     FROM care_schedule_items
     WHERE care_plan_id = ? AND user_id = ? ORDER BY id`,
    [planId, userId],
  );
  const [answers] = await db.execute(
    `SELECT question_key, selected_answer, risk_points, note
     FROM care_reality_answers WHERE care_plan_id = ? AND user_id = ?`,
    [planId, userId],
  );
  const [caregivers] = await db.execute(
    `SELECT id, availability, helps_with
     FROM caregivers
     WHERE user_id = ? AND (care_plan_id = ? OR care_plan_id IS NULL)`,
    [userId, planId],
  );

  const desired = [];

  if (documents.length === 0) {
    addGap(desired, {
      category: 'Documents',
      gapType: 'document_gap',
      title: 'No care document is linked to this plan',
      severity: 'blocking',
      legacyStatus: 'blocked',
      summary: 'The plan does not currently have a source document that can be used to verify its care instructions.',
      reason: 'SehatRoute should keep treatment instructions grounded in a user-provided healthcare document rather than inventing missing medical details.',
      nextStep: 'Upload or link the relevant prescription, discharge summary, follow-up slip, or other care document and complete instruction verification.',
      sourceKey: 'plan:document:missing',
      sourceKind: 'care_plan',
      sourceId: planId,
    });
  }

  const scheduledInstructionIds = new Set(
    tasks.map((item) => String(item.instruction_id || '')).filter(Boolean),
  );

  for (const instruction of instructions) {
    const instructionId = String(instruction.id);
    const title = text(instruction.title, 160) || 'Care instruction';
    const instructionText = text(instruction.instruction, 4000);
    const timing = text(instruction.timing, 160);
    const reviewStatus = text(instruction.review_status, 20).toLowerCase();
    const needsProfessional = Boolean(instruction.requires_professional_confirmation);

    if (reviewStatus === 'unclear' || needsProfessional) {
      addGap(desired, {
        category: 'Verification',
        gapType: 'verification',
        title: `${title} needs clarification`,
        severity: 'blocking',
        legacyStatus: 'unclear',
        summary: 'This instruction is not yet clear enough to treat as a verified care-plan instruction.',
        instructionSnapshot: [instructionText, timing].filter(Boolean).join(' · '),
        reason: text(instruction.ambiguity_reason, 4000) || text(instruction.safety_question, 4000) || 'The uploaded source or AI extraction still contains an unresolved ambiguity.',
        nextStep: 'Review the original document. If the source itself is unclear, confirm the instruction with a qualified healthcare professional before marking it verified.',
        sourceKey: `instruction:${instructionId}:verification`,
        sourceKind: 'instruction',
        sourceId: instructionId,
      });
    } else if (reviewStatus === 'pending') {
      addGap(desired, {
        category: 'Verification',
        gapType: 'verification',
        title: `${title} still needs verification`,
        severity: 'blocking',
        legacyStatus: 'unclear',
        summary: 'This extracted instruction has not yet completed human verification.',
        instructionSnapshot: [instructionText, timing].filter(Boolean).join(' · '),
        reason: 'AI-extracted care instructions should be checked against the original document before they become active.',
        nextStep: 'Open Instructions, compare this item with its source document, and mark it verified only when it matches the source.',
        sourceKey: `instruction:${instructionId}:pending`,
        sourceKind: 'instruction',
        sourceId: instructionId,
      });
    }

    if (
      reviewStatus === 'verified' &&
      ['follow_up', 'lab_test'].includes(text(instruction.category, 40).toLowerCase()) &&
      !scheduledInstructionIds.has(instructionId)
    ) {
      const label = instruction.category === 'follow_up' ? 'follow-up' : 'test';
      addGap(desired, {
        category: 'Schedule',
        gapType: 'schedule_gap',
        title: `${title} is not on the schedule`,
        severity: 'attention',
        legacyStatus: 'at_risk',
        summary: `A verified ${label} instruction exists, but no matching scheduled item is currently linked to it.`,
        instructionSnapshot: [instructionText, timing].filter(Boolean).join(' · '),
        reason: `Without a scheduled ${label} item, this step can be easier to overlook in day-to-day care.`,
        nextStep: 'Regenerate or review the care schedule so this verified instruction appears in the calendar. Do not change the medical timing yourself.',
        sourceKey: `instruction:${instructionId}:schedule_missing`,
        sourceKind: 'instruction',
        sourceId: instructionId,
      });
    }
  }

  for (const task of tasks) {
    const taskId = String(task.id);
    const title = text(task.title, 160) || 'Scheduled care task';
    if (!task.schedule_time || Boolean(task.requires_confirmation)) {
      addGap(desired, {
        category: 'Schedule',
        gapType: 'schedule_gap',
        title: `${title} still needs an exact time`,
        severity: 'blocking',
        legacyStatus: 'unclear',
        whenText: scheduleLabel(task),
        summary: 'This scheduled item has not yet been confirmed with an exact reminder time.',
        instructionSnapshot: text(task.recurrence_text, 4000) || text(task.display_time, 4000),
        reason: text(task.reason, 4000) || 'The schedule item is still marked as requiring confirmation.',
        nextStep: 'Open Schedule, choose an exact time within the allowed period, and confirm the schedule item.',
        sourceKey: scheduleIssueKey(task, 'time_confirmation'),
        sourceKind: 'schedule_item',
        sourceId: taskId,
        dueAt: dueDate(task),
      });
    }

    const supportText = `${task.title || ''} ${task.display_time || ''} ${task.recurrence_text || ''} ${task.reason || ''}`.toLowerCase();
    if (/caregiver|assistance|assist with|helper|family support/.test(supportText) && caregivers.length === 0) {
      addGap(desired, {
        category: 'Care coordination',
        gapType: 'care_coordination',
        title: `Support is not arranged for ${title}`,
        severity: 'attention',
        legacyStatus: 'at_risk',
        whenText: scheduleLabel(task),
        summary: 'This task explicitly mentions assistance, but no caregiver is currently linked to the plan.',
        patientReality: 'No caregiver record is currently available for this care plan.',
        reason: 'A task that explicitly requires help may be harder to complete if support has not been arranged.',
        nextStep: 'Arrange a trusted caregiver or family helper for this task. If the required support cannot be arranged, contact the care team for guidance.',
        sourceKey: scheduleIssueKey(task, 'caregiver_missing'),
        sourceKind: 'schedule_item',
        sourceId: taskId,
        dueAt: dueDate(task),
      });
    }
  }

  const templates = typeof realityQuestionTemplates === 'function'
    ? realityQuestionTemplates(tasks)
    : [];
  const answeredKeys = new Set(answers.map((item) => item.question_key));
  for (const template of templates) {
    if (answeredKeys.has(template.key)) continue;
    addGap(desired, {
      category: 'Missing information',
      gapType: 'missing_information',
      title: 'A Reality Check answer is still missing',
      severity: 'blocking',
      legacyStatus: 'blocked',
      summary: template.question,
      patientReality: 'No answer has been saved for this required practical question yet.',
      reason: 'The plan cannot confirm practical fit without this user-provided information.',
      nextStep: 'Open Reality Check, answer this question, save the answer, and refresh the care plan.',
      sourceKey: `reality:${template.key}:unanswered`,
      sourceKind: 'reality_question',
      sourceId: template.key,
    });
  }

  for (const gap of desired) {
    await db.execute(
      `INSERT INTO care_gaps (
        care_plan_id, task_id, category, gap_type, title, status,
        severity, lifecycle_status, when_text, summary,
        instruction_snapshot, patient_reality, reason, next_step,
        source_key, source_kind, source_id, due_at, auto_managed
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE
        category = VALUES(category),
        gap_type = VALUES(gap_type),
        title = VALUES(title),
        status = VALUES(status),
        severity = VALUES(severity),
        lifecycle_status = IF(lifecycle_status = 'in_progress', 'in_progress', 'open'),
        when_text = VALUES(when_text),
        summary = VALUES(summary),
        instruction_snapshot = VALUES(instruction_snapshot),
        patient_reality = VALUES(patient_reality),
        reason = VALUES(reason),
        next_step = VALUES(next_step),
        source_kind = VALUES(source_kind),
        source_id = VALUES(source_id),
        due_at = VALUES(due_at),
        auto_managed = 1,
        resolved_at = NULL,
        resolution_note = NULL`,
      [
        planId,
        gap.category,
        gap.gapType,
        gap.title,
        gap.legacyStatus,
        gap.severity,
        gap.whenText,
        gap.summary,
        gap.instructionSnapshot,
        gap.patientReality,
        gap.reason,
        gap.nextStep,
        gap.sourceKey,
        gap.sourceKind,
        gap.sourceId,
        gap.dueAt,
      ],
    );
  }

  const desiredKeys = desired.map((item) => item.sourceKey);
  if (desiredKeys.length === 0) {
    await db.execute(
      `UPDATE care_gaps
       SET status = 'resolved', lifecycle_status = 'resolved',
         resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP),
         resolution_note = COALESCE(NULLIF(resolution_note, ''), 'Automatically resolved after the underlying care-plan information was updated.')
       WHERE care_plan_id = ? AND auto_managed = 1 AND lifecycle_status <> 'resolved'`,
      [planId],
    );
  } else {
    const placeholders = desiredKeys.map(() => '?').join(', ');
    await db.execute(
      `UPDATE care_gaps
       SET status = 'resolved', lifecycle_status = 'resolved',
         resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP),
         resolution_note = COALESCE(NULLIF(resolution_note, ''), 'Automatically resolved after the underlying care-plan information was updated.')
       WHERE care_plan_id = ? AND auto_managed = 1
         AND lifecycle_status <> 'resolved'
         AND source_key NOT IN (${placeholders})`,
      [planId, ...desiredKeys],
    );
  }

  const [rows] = await db.execute(
    `SELECT ${CARE_GAP_COLUMNS}
     FROM care_gaps WHERE care_plan_id = ?
     ORDER BY lifecycle_status = 'resolved', severity <> 'blocking', due_at IS NULL, due_at, id`,
    [planId],
  );
  return rows;
}

export async function readCareGaps(db, planId) {
  const [rows] = await db.execute(
    `SELECT ${CARE_GAP_COLUMNS}
     FROM care_gaps WHERE care_plan_id = ?
     ORDER BY lifecycle_status = 'resolved', severity <> 'blocking', due_at IS NULL, due_at, id`,
    [planId],
  );
  return rows;
}

export async function readCareGapForUser(db, gapId, userId) {
  const [rows] = await db.execute(
    `SELECT ${CARE_GAP_COLUMNS}
     FROM care_gaps
     WHERE id = ?
       AND care_plan_id IN (SELECT id FROM care_plans WHERE user_id = ?)
     LIMIT 1`,
    [gapId, userId],
  );
  return rows[0] || null;
}
