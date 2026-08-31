const PROFILE_OPTIONS = Object.freeze({
  routine_reliability: Object.freeze([
    Object.freeze({ label: 'Yes, reliably', points: 0 }),
    Object.freeze({ label: 'My routine changes on some days', points: 8 }),
    Object.freeze({ label: 'This timing is usually difficult for me', points: 15 }),
  ]),
  conflict_reliability: Object.freeze([
    Object.freeze({ label: 'No, this usually fits my day', points: 0 }),
    Object.freeze({ label: 'It conflicts on some days', points: 8 }),
    Object.freeze({ label: 'It usually conflicts with my day', points: 15 }),
  ]),
  availability: Object.freeze([
    Object.freeze({ label: 'Yes, reliably', points: 0 }),
    Object.freeze({ label: 'Only sometimes', points: 10 }),
    Object.freeze({ label: 'Not currently', points: 20 }),
  ]),
  feasibility: Object.freeze([
    Object.freeze({ label: 'Yes, this is practical for me', points: 0 }),
    Object.freeze({ label: 'It is difficult on some days', points: 10 }),
    Object.freeze({ label: 'It is usually not practical for me', points: 20 }),
  ]),
});

const INTENT_ACTION = Object.freeze({
  routine_time: 'schedule',
  meal_routine: 'schedule',
  school_or_work_conflict: 'schedule',
  sleep_routine: 'schedule',
  medicine_access: 'care_plan',
  caregiver_availability: 'family_care',
  task_support: 'family_care',
  travel_access: 'calendar',
  appointment_availability: 'calendar',
  location_access: 'care_plan',
  equipment_access: 'care_plan',
  instruction_feasibility: 'care_plan',
});

const LEGACY_METADATA = Object.freeze({
  morning_routine: Object.freeze({ intent: 'routine_time', responseProfile: 'routine_reliability', period: 'morning' }),
  daytime_access: Object.freeze({ intent: 'routine_time', responseProfile: 'routine_reliability', period: 'afternoon' }),
  evening_routine: Object.freeze({ intent: 'routine_time', responseProfile: 'routine_reliability', period: 'evening' }),
  caregiver_support: Object.freeze({ intent: 'caregiver_availability', responseProfile: 'availability', period: 'any' }),
  travel_access: Object.freeze({ intent: 'travel_access', responseProfile: 'availability', period: 'any' }),
  medicine_access: Object.freeze({ intent: 'medicine_access', responseProfile: 'availability', period: 'any' }),
});

function clean(value, max = 500) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => clean(value, 80)).filter(Boolean))];
}

function taskId(task) {
  return clean(task?.id ?? task?.taskId ?? task?.task_id, 80);
}

function periodForTask(task) {
  const explicit = clean(task?.period, 20).toLowerCase();
  if (['morning', 'afternoon', 'evening', 'night'].includes(explicit)) return explicit;
  const text = `${task?.display_time || ''} ${task?.recurrence_text || ''}`.toLowerCase();
  if (/\bmorning\b|\bbreakfast\b/.test(text)) return 'morning';
  if (/\bafternoon\b|\bmidday\b|\blunch\b/.test(text)) return 'afternoon';
  if (/\bevening\b|\bdinner\b/.test(text)) return 'evening';
  if (/\bnight\b|\bbedtime\b/.test(text)) return 'night';
  return 'any';
}

function legacyTargetIds(key, tasks) {
  const rows = Array.isArray(tasks) ? tasks : [];
  if (key === 'morning_routine') return rows.filter((task) => periodForTask(task) === 'morning').map(taskId).filter(Boolean);
  if (key === 'daytime_access') return rows.filter((task) => periodForTask(task) === 'afternoon').map(taskId).filter(Boolean);
  if (key === 'evening_routine') return rows.filter((task) => ['evening', 'night'].includes(periodForTask(task))).map(taskId).filter(Boolean);
  if (key === 'caregiver_support') {
    return rows.filter((task) => /assist|caregiver|dressing|support|helper/i.test(`${task?.title || ''} ${task?.reason || ''}`)).map(taskId).filter(Boolean);
  }
  if (key === 'travel_access') {
    return rows.filter((task) => ['follow_up', 'lab_test'].includes(clean(task?.task_kind, 40).toLowerCase())).map(taskId).filter(Boolean);
  }
  if (key === 'medicine_access') {
    return rows.filter((task) => clean(task?.task_kind, 40).toLowerCase() === 'medicine').map(taskId).filter(Boolean);
  }
  return [];
}

export function actionForRealityIntent(intent) {
  return INTENT_ACTION[clean(intent, 60).toLowerCase()] || 'reality_check';
}

export function responseOptionsForProfile(profile, intent = '') {
  const normalized = clean(profile, 60).toLowerCase();
  const base = PROFILE_OPTIONS[normalized] || PROFILE_OPTIONS.feasibility;
  const action = actionForRealityIntent(intent);
  return base.map((option, index) => ({
    ...option,
    action: index === 0 ? '' : action,
    reason: index === 0
      ? ''
      : 'This answer shows a practical fit issue that should be considered before the plan is treated as fully reliable.',
    fix: index === 0
      ? ''
      : practicalFixForIntent(intent),
  }));
}

export function practicalFixForIntent(intent) {
  switch (clean(intent, 60).toLowerCase()) {
    case 'routine_time':
    case 'meal_routine':
    case 'school_or_work_conflict':
    case 'sleep_routine':
      return 'Review the reminder inside the verified allowed period. SehatMate may suggest a practical reminder time, but it must not change an explicit medical instruction.';
    case 'caregiver_availability':
    case 'task_support':
      return 'Arrange trusted caregiver or family support where possible. If the verified instruction requires assistance and support cannot be arranged, contact the care team for guidance.';
    case 'travel_access':
    case 'appointment_availability':
      return 'Arrange access or contact the clinic or laboratory to confirm a workable appointment. Do not change a medically required timing on your own.';
    case 'medicine_access':
      return 'Obtain the prescribed medicine through the usual pharmacy or care provider when possible. Do not substitute, stop, or change the medicine without professional confirmation.';
    case 'equipment_access':
    case 'location_access':
      return 'Arrange the required practical access where possible. If the verified instruction cannot be followed safely, contact the care team for guidance.';
    default:
      return 'Keep this honest answer and review the practical setup without changing the verified medical instruction.';
  }
}

export function dynamicQuestionToDecisionTemplate(question) {
  const intent = clean(question?.intent, 60).toLowerCase();
  const responseProfile = clean(question?.responseProfile ?? question?.response_profile, 60).toLowerCase() || 'feasibility';
  const key = clean(question?.key ?? question?.question_key, 80);
  return {
    key,
    intent,
    category: clean(question?.category, 80) || 'Practical fit',
    question: clean(question?.question ?? question?.question_text, 500),
    responseProfile,
    targetTaskIds: normalizeIds(question?.targetTaskIds ?? question?.target_task_ids),
    period: clean(question?.period, 20).toLowerCase() || 'any',
    reasonForAsking: clean(question?.reasonForAsking ?? question?.reason_for_asking, 500),
    source: clean(question?.source, 40) || 'ai_generated',
    options: responseOptionsForProfile(responseProfile, intent),
  };
}

export function legacyTemplateToDecisionTemplate(template, tasks = []) {
  const key = clean(template?.key, 80);
  const metadata = LEGACY_METADATA[key] || { intent: 'instruction_feasibility', responseProfile: 'feasibility', period: 'any' };
  return {
    ...template,
    key,
    intent: metadata.intent,
    responseProfile: metadata.responseProfile,
    targetTaskIds: legacyTargetIds(key, tasks),
    period: metadata.period,
    reasonForAsking: 'Legacy compatibility question for practical care-plan fit.',
    source: 'legacy_fallback',
  };
}

export function riskPointsForRealityAnswer({ selectedAnswer, note, template, storedRiskPoints = 0 }) {
  if (!template) return Number(storedRiskPoints || 0);
  const selected = clean(selectedAnswer, 240);
  if (selected && selected !== '__custom__') {
    const option = (template.options || []).find((candidate) => candidate.label === selected);
    if (option) return Number(option.points || 0);
  }

  if (selected !== '__custom__') return Number(storedRiskPoints || 0);

  const options = Array.isArray(template.options) ? template.options : [];
  if (!options.length) return Number(storedRiskPoints || 0);
  const value = clean(note, 500).toLowerCase();
  const first = Number(options[0]?.points || 0);
  const middle = Number(options[Math.min(1, options.length - 1)]?.points || 0);
  const last = Number(options[options.length - 1]?.points || middle);
  if (!value) return middle;

  if (/\b(no|never|cannot|can't|unable|difficult|hard|unavailable|missing|none|not available|not possible|conflict)\b/.test(value)) return last;
  if (/\b(sometimes|occasionally|depends|change|changes|changing|varies|vary|some days|not always|usually|maybe|partly)\b/.test(value)) return middle;
  if (/\b(yes|always|reliably|reliable|available|arranged|no problem|works well|can do|can follow|can access|have all|practical)\b/.test(value)) return first;
  return middle;
}

export function targetTasksForRealityQuestion(template, tasks = []) {
  const ids = new Set(normalizeIds(template?.targetTaskIds));
  if (ids.size > 0) return tasks.filter((task) => ids.has(taskId(task)));
  return tasks.filter((task) => legacyTargetIds(clean(template?.key, 80), [task]).length > 0);
}
