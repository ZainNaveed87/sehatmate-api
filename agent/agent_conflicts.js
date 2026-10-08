// Only deterministic operational rules. This module is never a model/tool API.
export const AGENT_CONFLICT_RESOLUTIONS = Object.freeze(['review_routine', 'keep_current_setup', 'review_caregiver', 'review_reminders', 'open_care_gap', 'open_reality_check', 'professional_review']);
const validRef = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,191}$/.test(value);
const safeId = value => /^[1-9]\d{0,19}$/.test(String(value ?? ''));
export function detectAgentConflicts({ verifiedFacts = [], memory = [], allowedResolutions = AGENT_CONFLICT_RESOLUTIONS, now = Date.now() } = {}) {
  const facts = verifiedFacts.filter(f => f?.verified === true && validRef(f.ref)).slice(0, 80);
  const confirmed = memory.filter(m => m?.confirmedByUser === true && m.status === 'active' && m.kind !== 'INFERRED_PATTERN' && (!m.expiresAt || Date.parse(m.expiresAt) > now) && validRef(m.evidenceRef));
  const results = [];
  const push = (type, factsUsed, targets, explainableFacts, resolutions, requiresProfessionalReview = false) => {
    const evidenceRefs = [...new Set(factsUsed.map(f => f.ref || f.evidenceRef))];
    const id = `${type}:${evidenceRefs.join('|')}`;
    if (!results.some(r => r.id === id)) results.push({ id, type, severity: requiresProfessionalReview ? 'review' : 'attention', evidenceRefs, affectedTargets: targets, explainableFacts, allowedResolutions: resolutions.filter(r => AGENT_CONFLICT_RESOLUTIONS.includes(r) && allowedResolutions.includes(r)), requiresProfessionalReview });
  };
  const tasks = facts.filter(f => f.type === 'scheduled_task' && safeId(f.id) && Number.isInteger(f.minute) && f.minute >= 0 && f.minute < 1440 && Number.isInteger(f.day) && f.day >= 0 && f.day <= 6);
  for (const task of tasks) {
    for (const item of confirmed.filter(m => m.key === 'availability.constraint')) {
      const v = item.value;
      if (v?.available === false && Array.isArray(v.days) && v.days.includes(task.day) && task.minute >= v.startMinute && task.minute < v.endMinute) push('timing_availability', [task, item], [`care_plan.task.${task.id}`], { scheduledMinute: task.minute, unavailableStartMinute: v.startMinute, unavailableEndMinute: v.endMinute, day: task.day }, ['review_routine', 'keep_current_setup', 'professional_review'], task.clinical === true);
    }
  }
  for (let a = 0; a < tasks.length; a++) for (let b = a + 1; b < tasks.length; b++) {
    if (tasks[a].day === tasks[b].day && tasks[a].minute === tasks[b].minute && tasks[a].id !== tasks[b].id) push('overlapping_schedule', [tasks[a], tasks[b]], [`care_plan.task.${tasks[a].id}`, `care_plan.task.${tasks[b].id}`], { minute: tasks[a].minute, day: tasks[a].day }, ['review_routine', 'keep_current_setup', 'professional_review'], tasks[a].clinical === true || tasks[b].clinical === true);
  }
  for (const fact of facts) {
    if (fact.type === 'missed_pattern' && Number.isInteger(fact.count) && fact.count >= 2 && Number.isInteger(fact.periodDays) && fact.periodDays >= 2 && fact.periodDays <= 90) push('repeated_missed_tasks', [fact], ['progress.missed_tasks'], { missedCount: fact.count, periodDays: fact.periodDays }, ['review_routine', 'review_reminders']);
    if (fact.type === 'care_gap' && safeId(fact.id) && ['open', 'in_progress'].includes(fact.status)) push('unresolved_care_gap', [fact], [`care_gaps.card.${fact.id}`], { gapId: String(fact.id), status: fact.status }, ['open_care_gap', 'professional_review'], fact.clinical === true);
    if (fact.type === 'reality_check' && Number.isInteger(fact.unanswered) && fact.unanswered > 0) push('incomplete_reality_check', [fact], ['reality_check.main'], { unansweredCount: fact.unanswered, ...(safeId(fact.planId)?{planId:String(fact.planId)}:{}) }, safeId(fact.planId)?['open_reality_check']:[]);
    if (fact.type === 'caregiver_state' && fact.enabled === false) {
      for (const item of confirmed.filter(m => m.key === 'caregiver.preference' && m.value?.enabled === true)) push('caregiver_preference_unmet', [fact, item], ['profile.caregiver'], { enabled: false, preferred: true }, ['review_caregiver', 'keep_current_setup']);
    }
    if (fact.type === 'follow_up' && safeId(fact.id) && fact.overdue === true) push('overdue_follow_up', [fact], [`care_plan.task.${fact.id}`], { followUpId: String(fact.id), overdue: true }, ['review_routine', 'professional_review'], fact.clinical === true);
  }
  const bounded = results.slice(0, 8);
  if (bounded.length) console.info('AGENT_CONFLICT:DETECTED');
  return bounded;
}
// Accept ONLY server execution envelopes from agent_core capabilityResults.
// Client context and planner prose must never be passed here as tool results.
export function conflictsFromToolResults({ toolResults = [], memory = [], allowedResolutions } = {}) {
  const facts = [];
  for (const tool of toolResults.slice(0, 12)) {
    if (tool?.result?.ok !== true || !tool.result.data) continue;
    const data = tool.result.data;
    if (tool.name === 'get_today_tasks') {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(data.date || '') ? new Date(`${data.date}T12:00:00Z`).getUTCDay() : null;
      for (const task of (Array.isArray(data.occurrences) ? data.occurrences : []).slice(0, 40)) {
        const time = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(task.scheduledTime || '');
        if (safeId(task.id) && safeId(task.scheduleItemId) && time && Number(time[1]) < 24 && Number(time[2]) < 60 && day !== null && task.status === 'pending') facts.push({ verified: true, type: 'scheduled_task', id: String(task.scheduleItemId), ref: `get_today_tasks:${data.date}:${task.id}`, day, minute: Number(time[1]) * 60 + Number(time[2]), clinical: ['medicine', 'medication'].includes(task.taskKind) });
      }
      // A single-day summary is not evidence of a recurring pattern.
    }
    if (tool.name === 'get_care_gaps') for (const gap of (Array.isArray(data.gaps) ? data.gaps : []).slice(0, 30)) if (safeId(gap.id)) facts.push({ verified: true, type: 'care_gap', id: String(gap.id), ref: `get_care_gaps:${gap.id}`, status: gap.lifecycle_status, clinical: gap.action_type === 'ask_doctor' || gap.requires_professional_review === true });
    if (tool.name === 'get_reality_check' && Array.isArray(data.questions)) {
      const answered = q => q && ((typeof q.selectedAnswer === 'string' && q.selectedAnswer.trim().length > 0) || (typeof q.note === 'string' && q.note.trim().length > 0));
      const unanswered = data.questions.filter(q => q && !answered(q)).length;
      facts.push({ verified: true, type: 'reality_check', ref: `get_reality_check:${tool.args?.planId || 'current'}`, ...(safeId(tool.args?.planId)?{planId:String(tool.args.planId)}:{}), unanswered });
    }
    if (['get_performance_summary', 'compare_performance'].includes(tool.name)) {
      const window = data.periods?.current;
      if (window && /^\d{4}-\d{2}-\d{2}$/.test(window.startDate || '') && /^\d{4}-\d{2}-\d{2}$/.test(window.endDate || '') && Number.isInteger(window.days) && Number.isInteger(window.summary?.missed)) facts.push({ verified: true, type: 'missed_pattern', ref: `${tool.name}:${window.startDate}:${window.endDate}`, count: window.summary.missed, periodDays: window.days });
    }
  }
  return detectAgentConflicts({ verifiedFacts: facts, memory, allowedResolutions });
}
