/**
 * Phase D draft and confirmed-action capabilities.
 *
 * DRAFT tools create server-validated previews only. REVERSIBLE_USER_ACTION
 * tools are registered in the same closed registry but are never advertised
 * to the ordinary planner and can execute only through the confirmed path.
 */

import { defineAgentCapability } from './agent_capability_registry.js';
import {
  readTodayTasksState,
  nextTaskFromTodayState,
} from '../services/performance_summary_service.js';
import {
  applyTaskOutcome,
  taskOccurrenceJson,
} from '../services/task_outcome_service.js';
import {
  confirmScheduleItem,
  validateScheduleItemConfirmation,
} from '../services/schedule_confirm_service.js';
import {
  cleanText,
  idPattern,
} from '../services/shared_utils.js';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function failure(code, message, data = null) {
  return { ok: false, code, message, ...(data ? { data } : {}) };
}

function outcomeLabel(outcome) {
  return outcome === 'completed' ? 'completed' : 'skipped';
}

function taskDraft(row, outcome, note = '') {
  const occurrence = taskOccurrenceJson(row);
  const title = cleanText(occurrence.title || 'Care task', 120) || 'Care task';
  const label = outcomeLabel(outcome);
  return {
    toolName: 'set_task_outcome',
    kind: 'task_outcome',
    occurrenceId: occurrence.id,
    outcome: label,
    note: cleanText(note, 200) || '',
    baseStatus: occurrence.status || 'pending',
    targetLabel: title,
    message: `Mark "${title}" as ${label}.`,
  };
}

async function readTaskOccurrence({ pool, userId, occurrenceId }) {
  if (!idPattern.test(occurrenceId)) {
    return failure('INVALID_TASK_OCCURRENCE_ID', 'Invalid task occurrence ID.');
  }
  const [rows] = await pool.execute(
    `SELECT o.id, o.care_plan_id, o.schedule_item_id, o.occurrence_date,
      TIME_FORMAT(o.scheduled_at, '%H:%i') AS scheduled_time,
      o.status, o.completed_at,
      TIME_FORMAT(o.completed_at, '%H:%i') AS completed_time,
      o.outcome_source, o.note,
      s.title, s.task_kind, s.display_time, s.recurrence_text, s.grounding
     FROM care_task_occurrences o
     JOIN care_schedule_items s ON s.id = o.schedule_item_id
     WHERE o.id = ? AND o.user_id = ?
     LIMIT 1`,
    [occurrenceId, userId],
  );
  if (!rows.length) {
    return failure('TASK_OCCURRENCE_NOT_FOUND', 'Task occurrence not found.');
  }
  return { ok: true, row: rows[0] };
}

function scheduleDraft(row, scheduleTime) {
  const title = cleanText(row.title || 'Reminder', 120) || 'Reminder';
  const display =
    cleanText(row.display_time, 80) ||
    `Reminder at ${scheduleTime}`;
  return {
    toolName: 'confirm_schedule_item_time',
    kind: 'schedule_time',
    itemId: String(row.id),
    displayTime: display,
    scheduleTime,
    learningSource: 'ai_suggestion_accept',
    targetLabel: title,
    message: `Set "${title}" reminder to ${scheduleTime}.`,
  };
}

defineAgentCapability({
  name: 'draft_task_outcome',
  permissionClass: 'DRAFT',
  description:
    'Prepare a review-only draft to mark one owned task occurrence completed or skipped. It does not change data.',
  inputSchema: {
    properties: {
      occurrenceId: { type: 'id' },
      outcome: { type: 'enum', values: ['completed', 'skipped'] },
      note: { type: 'string', maxLength: 200 },
    },
    required: ['occurrenceId', 'outcome'],
  },
  resultContract: 'Returns { draft } for later explicit confirmation.',
  async execute({ pool, userId, args }) {
    const read = await readTaskOccurrence({
      pool,
      userId,
      occurrenceId: args.occurrenceId,
    });
    if (!read.ok) return read;
    return {
      ok: true,
      message: 'Task outcome draft prepared.',
      data: { draft: taskDraft(read.row, args.outcome, args.note || '') },
    };
  },
});

defineAgentCapability({
  name: 'draft_next_task_outcome',
  permissionClass: 'DRAFT',
  description:
    'Resolve the authenticated user’s next pending task server-side and prepare a completed/skipped draft. It does not change data.',
  inputSchema: {
    properties: {
      outcome: { type: 'enum', values: ['completed', 'skipped'] },
      note: { type: 'string', maxLength: 200 },
    },
    required: ['outcome'],
  },
  resultContract: 'Returns { draft } for later explicit confirmation.',
  async execute({ pool, userId, args }) {
    const state = await readTodayTasksState({
      pool,
      userId,
    });
    if (!state.ok) return state;
    const next = nextTaskFromTodayState(state.data);
    if (!next) {
      return failure(
        'NEXT_TASK_NOT_FOUND',
        'No pending task is available to draft.',
      );
    }
    return {
      ok: true,
      message: 'Next task outcome draft prepared.',
      data: {
        draft: taskDraft(
          {
            id: next.occurrenceId,
            care_plan_id: next.carePlanId,
            schedule_item_id: '',
            occurrence_date: '',
            scheduled_time: next.scheduledTime,
            status: next.status,
            completed_at: null,
            completed_time: null,
            outcome_source: 'system',
            note: '',
            title: next.title,
            task_kind: 'care_task',
            display_time: '',
            recurrence_text: '',
            grounding: 'suggested',
          },
          args.outcome,
          args.note || '',
        ),
      },
    };
  },
});

defineAgentCapability({
  name: 'draft_schedule_time',
  permissionClass: 'DRAFT',
  description:
    'Prepare a review-only draft for an owned editable reminder exact time. It does not change data.',
  inputSchema: {
    properties: {
      itemId: { type: 'id' },
      scheduleTime: { type: 'string', maxLength: 5 },
    },
    required: ['itemId', 'scheduleTime'],
  },
  resultContract: 'Returns { draft } for later explicit confirmation.',
  async execute({ pool, userId, args }) {
    if (!TIME_PATTERN.test(args.scheduleTime)) {
      return failure(
        'INVALID_SCHEDULE_TIME',
        'Select an exact reminder time before drafting this change.',
      );
    }
    const validation = await validateScheduleItemConfirmation({
      pool,
      userId,
      itemId: args.itemId,
      displayTime: '',
      scheduleTime: args.scheduleTime,
    });
    if (!validation.ok) return validation;
    return {
      ok: true,
      message: 'Reminder time draft prepared.',
      data: {
        draft: scheduleDraft(validation.data.row, validation.data.scheduleTime),
      },
    };
  },
});

defineAgentCapability({
  name: 'set_task_outcome',
  permissionClass: 'REVERSIBLE_USER_ACTION',
  description:
    'Confirmed-only action to mark one owned task occurrence completed or skipped.',
  inputSchema: {
    properties: {
      occurrenceId: { type: 'id' },
      outcome: { type: 'enum', values: ['completed', 'skipped'] },
      note: { type: 'string', maxLength: 200 },
      baseStatus: { type: 'enum', values: ['pending', 'completed', 'skipped', 'missed'] },
      operationKey: { type: 'string', maxLength: 120 },
    },
    required: ['occurrenceId', 'outcome', 'baseStatus', 'operationKey'],
  },
  resultContract: 'Returns the authoritative updated occurrence.',
  execute({ pool, userId, args }) {
    return applyTaskOutcome({
      pool,
      userId,
      occurrenceId: args.occurrenceId,
      outcome: args.outcome,
      note: args.note || '',
      baseStatus: args.baseStatus,
      operationKey: args.operationKey,
    });
  },
});

defineAgentCapability({
  name: 'confirm_schedule_item_time',
  permissionClass: 'REVERSIBLE_USER_ACTION',
  description:
    'Confirmed-only action to save an owned reminder exact time through schedule safety guards.',
  inputSchema: {
    properties: {
      itemId: { type: 'id' },
      scheduleTime: { type: 'string', maxLength: 5 },
      learningSource: { type: 'enum', values: ['ai_suggestion_accept'] },
    },
    required: ['itemId', 'scheduleTime', 'learningSource'],
  },
  resultContract: 'Returns the authoritative confirmed schedule time.',
  execute({ pool, userId, args }) {
    return confirmScheduleItem({
      pool,
      userId,
      itemId: args.itemId,
      displayTime: '',
      scheduleTime: args.scheduleTime,
      learningSource: args.learningSource,
    });
  },
});
