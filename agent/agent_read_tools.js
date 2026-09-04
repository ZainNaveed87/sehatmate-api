/**
 * Phase B READ capabilities: the only executable data tools of the AI
 * Copilot.
 *
 * Every capability registered here calls the SAME authoritative service
 * the REST API uses - there is no second implementation of any clinical,
 * scheduling, or statistics logic in this module:
 *
 *   get_today_tasks         services/performance_summary_service.js
 *   get_next_task           services/performance_summary_service.js
 *   get_performance_summary services/performance_summary_service.js
 *   compare_performance     services/performance_summary_service.js
 *   get_care_plans          services/plan_query_service.js
 *   get_care_plan           services/plan_query_service.js
 *   get_plan_progress       services/plan_query_service.js
 *   get_reality_check       services/reality_answer_service.js
 *   get_simulation          services/simulation_service.js
 *   get_care_gaps           services/care_gap_service.js
 *   get_care_gap_detail     services/care_gap_service.js
 *   get_routine_preferences routine_learning.js
 *
 * All of them are permissionClass READ. Appointments are deliberately NOT
 * registered: no authoritative appointment source exists in Phase B, and
 * the spec forbids inventing one. The planner surfaces that as an explicit
 * "not available" answer instead.
 *
 * Date semantics: capabilities that take no date argument always use the
 * server-side UTC date keys of the underlying services; the optional
 * `date` argument of get_today_tasks is a validated YYYY-MM-DD calendar
 * date. "today" for reconciliation is never model-supplied.
 *
 * Importing this module registers the capabilities as a side effect; the
 * registry stays the single lookup authority (agent_capability_registry.js).
 */

import { defineAgentCapability } from './agent_capability_registry.js';

import {
  listCarePlans,
  readCarePlanDetail,
  readPlanLifecycleEvents,
} from '../services/plan_query_service.js';

import {
  listCareGaps,
  readCareGapDetail,
} from '../services/care_gap_service.js';

import {
  readRealityCheckState,
} from '../services/reality_answer_service.js';

import {
  readSimulationState,
} from '../services/simulation_service.js';

import {
  nextTaskFromTodayState,
  readPerformanceComparison,
  readPerformanceSummary,
  readTodayTasksState,
} from '../services/performance_summary_service.js';

import {
  listFamilyHome,
  readFamilyCareGaps,
  readFamilyCarePlans,
  readFamilyMemberSummary,
  readFamilyPerformance,
  readFamilySimulation,
  readFamilyTodayTasks,
} from '../services/family_care_service.js';

import { readRoutineProfile } from '../routine_learning.js';

export const AGENT_READ_CAPABILITY_NAMES = Object.freeze([
  'get_today_tasks',
  'get_next_task',
  'get_performance_summary',
  'compare_performance',
  'get_care_plans',
  'get_care_plan',
  'get_plan_progress',
  'get_reality_check',
  'get_simulation',
  'get_care_gaps',
  'get_care_gap_detail',
  'get_routine_preferences',
  'family_members_list',
  'family_member_summary',
  'family_member_care_plans',
  'family_member_today_tasks',
  'family_member_care_gaps',
  'family_member_simulation',
  'family_member_performance',
]);

defineAgentCapability({
  name: 'get_today_tasks',
  permissionClass: 'READ',
  description:
    "Read the authenticated user's task occurrences for one day (default: the server's today), including task titles, scheduled times, statuses, plan titles, and the day summary counts.",
  inputSchema: {
    properties: {
      date: {
        type: 'date',
        description: 'Optional YYYY-MM-DD day to read; defaults to today.',
      },
    },
    required: [],
  },
  execute: ({ pool, userId, args }) =>
    readTodayTasksState({
      pool,
      userId,
      date: args.date ?? null,
      today: null,
    }),
  resultContract:
    '{ date, occurrences: [{ id, carePlanId, title, scheduledTime, status, ... }], summary: { total, completed, skipped, missed, pending, activePlans, openCareGaps, careReadiness } }',
});

defineAgentCapability({
  name: 'get_next_task',
  permissionClass: 'READ',
  description:
    "Read the authenticated user's next pending task for today: the earliest still-pending occurrence in today's schedule order, with the pending count for the day.",
  inputSchema: {
    properties: {},
    required: [],
  },
  execute: async ({ pool, userId }) => {
    const state = await readTodayTasksState({
      pool,
      userId,
      date: null,
      today: null,
    });
    if (!state.ok) return state;
    return {
      ok: true,
      data: {
        date: state.data.date,
        nextTask: nextTaskFromTodayState(state.data),
        pendingToday: state.data.summary.pending,
        totalToday: state.data.summary.total,
      },
    };
  },
  resultContract:
    '{ date, nextTask: { occurrenceId, carePlanId, planTitle, title, scheduledTime, status } | null, pendingToday, totalToday }',
});

defineAgentCapability({
  name: 'get_performance_summary',
  permissionClass: 'READ',
  description:
    'Read the deterministic performance summary for the authenticated user: today counts and next task, two outcome windows ending today (default last 7 and last 30 days) with completion rates and comparison direction, the primary plan Reality Check completion state, and the primary plan Simulation score and blocked/at-risk/ready/unclear metrics.',
  inputSchema: {
    properties: {
      periodDays: {
        type: 'integer',
        min: 1,
        max: 31,
        description: 'Length in days of the current window; defaults to 7.',
      },
      baselineDays: {
        type: 'integer',
        min: 1,
        max: 31,
        description: 'Length in days of the baseline window; defaults to 30.',
      },
    },
    required: [],
  },
  execute: ({ pool, userId, args }) =>
    readPerformanceSummary({
      pool,
      userId,
      today: null,
      periodDays: args.periodDays,
      baselineDays: args.baselineDays,
    }),
  resultContract:
    '{ date, today: { summary, nextTask }, periods: { current, baseline, comparison }, primaryPlan, realityCheck, simulation } - all computed deterministically',
});

defineAgentCapability({
  name: 'compare_performance',
  permissionClass: 'READ',
  description:
    'Compare two deterministic outcome windows ending today (default: last 7 days vs last 30 days): scheduled/completed/on-time/late/skipped/missed/pending counts, completion rates, and the rate change with direction improved/declined/stable/insufficient_data.',
  inputSchema: {
    properties: {
      periodDays: {
        type: 'integer',
        min: 1,
        max: 31,
        description: 'Length in days of the current window; defaults to 7.',
      },
      baselineDays: {
        type: 'integer',
        min: 1,
        max: 31,
        description: 'Length in days of the baseline window; defaults to 30.',
      },
    },
    required: [],
  },
  execute: ({ pool, userId, args }) =>
    readPerformanceComparison({
      pool,
      userId,
      today: null,
      periodDays: args.periodDays,
      baselineDays: args.baselineDays,
    }),
  resultContract:
    '{ date, periods: { current: { label, startDate, endDate, days, summary, completionRate }, baseline: { ... }, comparison: { completionRateChange, direction } } }',
});

defineAgentCapability({
  name: 'get_care_plans',
  permissionClass: 'READ',
  description:
    "List the authenticated user's care plans with title, status, readiness score, task count, document count, and open care gap count.",
  inputSchema: {
    properties: {},
    required: [],
  },
  execute: ({ pool, userId }) => listCarePlans({ pool, userId }),
  resultContract: '{ plans: [carePlanJson...] }',
});

defineAgentCapability({
  name: 'get_care_plan',
  permissionClass: 'READ',
  description:
    'Read one care plan of the authenticated user in full detail: plan, documents, extracted and verified instructions, schedule tasks, care gaps with summary, caregivers, and doctor questions.',
  inputSchema: {
    properties: {
      planId: {
        type: 'id',
        description: 'The care plan id to read.',
      },
    },
    required: ['planId'],
  },
  execute: ({ pool, userId, args }) =>
    readCarePlanDetail({ pool, userId, planId: args.planId }),
  resultContract:
    '{ plan, documents, instructions, verifiedInstructions, tasks, gaps, gapSummary, caregivers, questions } or INVALID_PLAN_ID / PLAN_NOT_FOUND',
});

defineAgentCapability({
  name: 'get_plan_progress',
  permissionClass: 'READ',
  description:
    'Read the lifecycle event history of one care plan (activation, completion, pauses, and other recorded progress events).',
  inputSchema: {
    properties: {
      planId: {
        type: 'id',
        description: 'The care plan id to read progress for.',
      },
    },
    required: ['planId'],
  },
  execute: ({ pool, userId, args }) =>
    readPlanLifecycleEvents({ pool, userId, planId: args.planId }),
  resultContract: '{ events: [...] } or INVALID_PLAN_ID / PLAN_NOT_FOUND',
});

defineAgentCapability({
  name: 'get_reality_check',
  permissionClass: 'READ',
  description:
    'Read the Reality Check question set and saved answers of one care plan in the user stored profile language, including each question key, options, and the currently selected answer.',
  inputSchema: {
    properties: {
      planId: {
        type: 'id',
        description: 'The care plan id to read the Reality Check for.',
      },
    },
    required: ['planId'],
  },
  execute: ({ pool, userId, args }) =>
    readRealityCheckState({
      pool,
      userId,
      planId: args.planId,
      preferredLanguage: null,
    }),
  resultContract:
    '{ source, questionSetVersion, questions: [{ key, category, question, options, selectedAnswer, ... }] } or INVALID_PLAN_ID / PLAN_NOT_FOUND / SCHEDULE_NOT_GENERATED',
});

defineAgentCapability({
  name: 'get_simulation',
  permissionClass: 'READ',
  description:
    'Read the authoritative Simulation state of one care plan: readiness score, activation allowance, blocked/at-risk/ready/unclear task metrics, findings, adaptations, blockers, unanswered Reality Check questions, and care gaps.',
  inputSchema: {
    properties: {
      planId: {
        type: 'id',
        description: 'The care plan id to simulate.',
      },
    },
    required: ['planId'],
  },
  execute: ({ pool, userId, args }) =>
    readSimulationState({ pool, userId, planId: args.planId }),
  resultContract:
    '{ readiness, activationAllowed, hardBlockerCount, metrics: { blocked, atRisk, ready, unclear }, tasks, findings, adaptations, blockers, unanswered, careGaps } or INVALID_PLAN_ID / PLAN_NOT_FOUND',
});

defineAgentCapability({
  name: 'get_care_gaps',
  permissionClass: 'READ',
  description:
    "List the care gaps of one care plan of the authenticated user with an overall summary, optionally filtered by lifecycle status or severity.",
  inputSchema: {
    properties: {
      planId: {
        type: 'id',
        description: 'The care plan id to list gaps for.',
      },
      lifecycle: {
        type: 'enum',
        values: ['open', 'in_progress', 'resolved'],
        description: 'Optional lifecycle filter.',
      },
      severity: {
        type: 'enum',
        values: ['blocking', 'attention'],
        description: 'Optional severity filter.',
      },
    },
    required: ['planId'],
  },
  execute: ({ pool, userId, args }) =>
    listCareGaps({
      pool,
      userId,
      planId: args.planId,
      lifecycle: args.lifecycle ?? '',
      severity: args.severity ?? '',
    }),
  resultContract:
    '{ summary, gaps: [careGapJson...] } or INVALID_PLAN_ID / PLAN_NOT_FOUND',
});

defineAgentCapability({
  name: 'get_care_gap_detail',
  permissionClass: 'READ',
  description:
    'Read one care gap in detail, including its reason, next step, and doctor questions.',
  inputSchema: {
    properties: {
      gapId: {
        type: 'id',
        description: 'The care gap id to read.',
      },
    },
    required: ['gapId'],
  },
  execute: ({ pool, userId, args }) =>
    readCareGapDetail({ pool, userId, gapId: args.gapId }),
  resultContract:
    '{ gap, doctorQuestions } or INVALID_GAP_ID / GAP_NOT_FOUND',
});

defineAgentCapability({
  name: 'get_routine_preferences',
  permissionClass: 'READ',
  description:
    "Read the authenticated user's routine preferences: learning enabled flag, preferred reminder style, per-daypart notes, and the learned preferred times per daypart with confidence.",
  inputSchema: {
    properties: {},
    required: [],
  },
  execute: async ({ pool, userId }) => {
    const profile = await readRoutineProfile(pool, userId);
    return { ok: true, data: { routinePreferences: profile } };
  },
  resultContract:
    '{ routinePreferences: { learningEnabled, preferredReminderStyle, notes: { morning, afternoon, evening, night }, learned: { ... }, totalSignals } }',
});

defineAgentCapability({
  name: 'family_members_list',
  permissionClass: 'READ',
  description:
    'List active Family Care relationships and pending invitations for the authenticated user. Relationship ids are server-owned references for later family_member_* capabilities.',
  inputSchema: {
    properties: {},
    required: [],
  },
  execute: async ({ pool, userId }) => {
    const result = await listFamilyHome({ pool, actorUserId: userId });
    if (!result.ok) return result;
    return {
      ok: true,
      data: {
        familyMembers: result.data.relationships.map((relationship) => ({
          id: relationship.id,
          title: relationship.member.name,
          relationshipLabel: relationship.relationshipLabel,
          role: relationship.role,
          status: relationship.status,
          summary: relationship.summary || null,
        })),
        pendingInvitations: result.data.pendingInvitations,
      },
    };
  },
  resultContract:
    '{ familyMembers: [{ id, title, relationshipLabel, role, status, summary }], pendingInvitations }',
});

defineAgentCapability({
  name: 'family_member_summary',
  permissionClass: 'READ',
  description:
    'Read the authorized Family Care summary for one verified family relationship, with each section filtered by explicit server-side permissions.',
  inputSchema: {
    properties: {
      relationshipId: { type: 'id' },
    },
    required: ['relationshipId'],
  },
  execute: ({ pool, userId, args }) =>
    readFamilyMemberSummary({
      pool,
      actorUserId: userId,
      relationshipId: args.relationshipId,
    }),
  resultContract:
    '{ relationship, summary: { statusText, carePlans?, today?, careGaps?, simulation?, performance? } } or FAMILY_PERMISSION_DENIED',
});

defineAgentCapability({
  name: 'family_member_care_plans',
  permissionClass: 'READ',
  description:
    'Read care plans for one verified family member through Family Care. Data comes from the care recipient’s existing care_plans records and requires care_plan.read.',
  inputSchema: {
    properties: {
      relationshipId: { type: 'id' },
    },
    required: ['relationshipId'],
  },
  execute: ({ pool, userId, args }) =>
    readFamilyCarePlans({
      pool,
      actorUserId: userId,
      relationshipId: args.relationshipId,
    }),
  resultContract: '{ plans: [carePlanJson...] } or FAMILY_PERMISSION_DENIED',
});

defineAgentCapability({
  name: 'family_member_today_tasks',
  permissionClass: 'READ',
  description:
    'Read today’s existing task occurrences for one verified family member. Requires task.read and never changes task ownership.',
  inputSchema: {
    properties: {
      relationshipId: { type: 'id' },
      date: {
        type: 'date',
        description: 'Optional YYYY-MM-DD day to read; defaults to today.',
      },
    },
    required: ['relationshipId'],
  },
  execute: ({ pool, userId, args }) =>
    readFamilyTodayTasks({
      pool,
      actorUserId: userId,
      relationshipId: args.relationshipId,
      date: args.date ?? null,
    }),
  resultContract:
    '{ date, occurrences, summary } from existing task occurrence service or FAMILY_PERMISSION_DENIED',
});

defineAgentCapability({
  name: 'family_member_care_gaps',
  permissionClass: 'READ',
  description:
    'Read authoritative open/in-progress/resolved care gaps across the verified family member’s existing care plans. Requires care_gap.read.',
  inputSchema: {
    properties: {
      relationshipId: { type: 'id' },
    },
    required: ['relationshipId'],
  },
  execute: ({ pool, userId, args }) =>
    readFamilyCareGaps({
      pool,
      actorUserId: userId,
      relationshipId: args.relationshipId,
    }),
  resultContract:
    '{ summary, gaps } from existing care-gap service or FAMILY_PERMISSION_DENIED',
});

defineAgentCapability({
  name: 'family_member_simulation',
  permissionClass: 'READ',
  description:
    'Read the authoritative Simulation state for one verified family member’s primary or specified care plan. Requires simulation.read.',
  inputSchema: {
    properties: {
      relationshipId: { type: 'id' },
      planId: { type: 'id' },
    },
    required: ['relationshipId'],
  },
  execute: ({ pool, userId, args }) =>
    readFamilySimulation({
      pool,
      actorUserId: userId,
      relationshipId: args.relationshipId,
      planId: args.planId ?? null,
    }),
  resultContract:
    '{ planId, simulation } from existing simulation service or FAMILY_PERMISSION_DENIED',
});

defineAgentCapability({
  name: 'family_member_performance',
  permissionClass: 'READ',
  description:
    'Read the deterministic performance summary for one verified family member using the existing performance summary service. Requires performance.read.',
  inputSchema: {
    properties: {
      relationshipId: { type: 'id' },
    },
    required: ['relationshipId'],
  },
  execute: ({ pool, userId, args }) =>
    readFamilyPerformance({
      pool,
      actorUserId: userId,
      relationshipId: args.relationshipId,
    }),
  resultContract:
    '{ date, today, periods, primaryPlan, realityCheck, simulation } or FAMILY_PERMISSION_DENIED',
});
