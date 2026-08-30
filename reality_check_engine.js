import { generateRealityCheckQuestionCandidates } from './ai_service.js';

export const REALITY_CHECK_MAX_QUESTIONS = 6;

export const REALITY_CHECK_INTENTS = Object.freeze([
  'routine_time',
  'meal_routine',
  'medicine_access',
  'caregiver_availability',
  'travel_access',
  'location_access',
  'school_or_work_conflict',
  'sleep_routine',
  'task_support',
  'equipment_access',
  'appointment_availability',
  'instruction_feasibility',
]);

const allowedIntents = new Set(REALITY_CHECK_INTENTS);
const allowedPeriods = new Set(['morning', 'afternoon', 'evening', 'night', 'any']);

// The model never controls these values. They are deterministic app metadata
// used by later layers to choose UI controls and safe downstream handling.
const intentProfiles = Object.freeze({
  routine_time: { category: 'Routine', responseProfile: 'routine_reliability' },
  meal_routine: { category: 'Routine', responseProfile: 'routine_reliability' },
  medicine_access: { category: 'Medicine access', responseProfile: 'availability' },
  caregiver_availability: { category: 'Support', responseProfile: 'availability' },
  travel_access: { category: 'Visits and tests', responseProfile: 'availability' },
  location_access: { category: 'Access', responseProfile: 'availability' },
  school_or_work_conflict: { category: 'Routine', responseProfile: 'conflict_reliability' },
  sleep_routine: { category: 'Routine', responseProfile: 'routine_reliability' },
  task_support: { category: 'Support', responseProfile: 'availability' },
  equipment_access: { category: 'Access', responseProfile: 'availability' },
  appointment_availability: { category: 'Visits and tests', responseProfile: 'availability' },
  instruction_feasibility: { category: 'Practical fit', responseProfile: 'feasibility' },
});

function cleanText(value, maxLength) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function taskIdOf(task) {
  const raw = task?.id ?? task?.taskId ?? task?.task_id;
  return raw == null ? '' : String(raw).trim();
}

function normalizedQuestionKey(question) {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an|your|you|do|does|can|are|is|this|that|usually|normally)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasUnsafeClinicalLanguage(question) {
  const value = question.toLowerCase();
  const unsafePatterns = [
    /\bdiagnos(?:e|ed|is|ing)\b/,
    /\bwhat (?:disease|condition|illness)\b/,
    /\bdo you (?:have|think you have) (?:a |an )?(?:disease|condition|illness)\b/,
    /\b(?:change|increase|decrease|reduce|raise|lower|adjust) (?:the |your )?(?:dose|dosage|medicine|medication|frequency)\b/,
    /\b(?:stop|skip|omit|double|repeat|replace|substitute|switch) (?:the |your |a )?(?:dose|medicine|medication|tablet|capsule|treatment)\b/,
    /\btake (?:an? )?(?:extra|double|additional) (?:dose|tablet|capsule)\b/,
    /\bmissed dose\b/,
    /\bside effects?\b/,
    /\bis (?:this|the) (?:medicine|medication|dose|treatment) (?:safe|right|correct|suitable)\b/,
    /\bshould (?:you|i) (?:take|stop|skip|change|use|continue)\b/,
  ];
  return unsafePatterns.some((pattern) => pattern.test(value));
}

function hasUnnecessarySensitiveRequest(question) {
  const value = question.toLowerCase();
  return /\b(?:exact|full) (?:home|house|work|school) address\b/.test(value) ||
    /\b(?:password|passcode|pin number|national id|cnic|passport number|bank account|credit card)\b/.test(value);
}

function parsePayload(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  try {
    const parsed = JSON.parse(rawText);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}


function sanitizeInstructionsForRealityCheck(instructions) {
  if (!Array.isArray(instructions)) return [];
  return instructions.slice(0, 80).map((item) => ({
    id: cleanText(item?.id ?? item?.instructionId ?? item?.instruction_id, 80),
    category: cleanText(item?.category, 40),
    title: cleanText(item?.title, 180),
    instruction: cleanText(item?.instruction, 700),
    timing: cleanText(item?.timing, 180),
    reviewStatus: cleanText(item?.reviewStatus ?? item?.review_status, 40),
    requiresProfessionalConfirmation: Boolean(
      item?.requiresProfessionalConfirmation ?? item?.requires_professional_confirmation,
    ),
  }));
}

function sanitizeTasksForRealityCheck(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.slice(0, 80).map((item) => ({
    id: taskIdOf(item),
    instructionId: cleanText(item?.instructionId ?? item?.instruction_id, 80),
    taskKind: cleanText(item?.taskKind ?? item?.task_kind, 40),
    title: cleanText(item?.title, 180),
    scheduleDate: cleanText(item?.scheduleDate ?? item?.schedule_date, 20),
    scheduleTime: cleanText(item?.scheduleTime ?? item?.schedule_time, 20),
    displayTime: cleanText(item?.displayTime ?? item?.display_time, 120),
    recurrenceText: cleanText(item?.recurrenceText ?? item?.recurrence_text, 180),
    grounding: cleanText(item?.grounding, 30),
    reason: cleanText(item?.reason, 320),
  }));
}

function sanitizeKnownRealityFacts(facts) {
  if (!Array.isArray(facts)) return [];
  return facts.slice(0, 60).map((item) => {
    if (typeof item === 'string') return cleanText(item, 400);
    return {
      intent: cleanText(item?.intent, 60),
      period: cleanText(item?.period, 20),
      fact: cleanText(item?.fact ?? item?.value ?? item?.signalValue, 400),
      confidence: cleanText(item?.confidence, 40),
    };
  });
}

function sanitizeRoutineProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const safePeriod = (period) => ({
    note: cleanText(profile?.notes?.[period], 500),
    preferredTime: cleanText(profile?.learned?.[period]?.preferredTime, 20),
    confidence: cleanText(profile?.learned?.[period]?.confidence, 40),
  });

  return {
    learningEnabled: profile.learningEnabled !== false,
    preferredReminderStyle: cleanText(profile.preferredReminderStyle, 40),
    morning: safePeriod('morning'),
    afternoon: safePeriod('afternoon'),
    evening: safePeriod('evening'),
    night: safePeriod('night'),
  };
}

/**
 * Deterministically validate model-generated question candidates.
 * Unsafe, ungrounded, malformed and duplicate questions are dropped.
 */
export function normalizeRealityCheckQuestionCandidates({
  rawText,
  tasks = [],
  maxQuestions = REALITY_CHECK_MAX_QUESTIONS,
}) {
  const payload = parsePayload(rawText);
  const candidates = Array.isArray(payload?.questions) ? payload.questions : [];
  const validTaskIds = new Set(tasks.map(taskIdOf).filter(Boolean));
  const safeLimit = Math.max(1, Math.min(Number(maxQuestions) || REALITY_CHECK_MAX_QUESTIONS, REALITY_CHECK_MAX_QUESTIONS));

  const questions = [];
  const seenSemanticQuestions = new Set();
  const seenIntentTargets = new Set();

  for (const candidate of candidates) {
    if (questions.length >= safeLimit) break;

    const intent = cleanText(candidate?.intent, 60).toLowerCase();
    const question = cleanText(candidate?.question, 240);
    const period = cleanText(candidate?.period, 20).toLowerCase();
    const reasonForAsking = cleanText(candidate?.reasonForAsking, 320);

    if (!allowedIntents.has(intent)) continue;
    if (!allowedPeriods.has(period)) continue;
    if (question.length < 8 || !question.endsWith('?')) continue;
    if (!reasonForAsking) continue;
    if (hasUnsafeClinicalLanguage(`${question} ${reasonForAsking}`)) continue;
    if (hasUnnecessarySensitiveRequest(question)) continue;

    const rawTargets = Array.isArray(candidate?.targetTaskIds)
      ? candidate.targetTaskIds
      : [];
    const targetTaskIds = [...new Set(rawTargets
      .map((value) => String(value ?? '').trim())
      .filter((value) => value && validTaskIds.has(value)))]
      .slice(0, 12);

    // Grounding is mandatory. The model cannot create a general lifestyle
    // interview question that is unrelated to this verified care plan.
    if (targetTaskIds.length === 0) continue;

    const semanticKey = normalizedQuestionKey(question);
    if (!semanticKey || seenSemanticQuestions.has(semanticKey)) continue;

    // Prevent the model from asking multiple near-equivalent questions for the
    // exact same practical concern and exact same task set in one generation.
    const intentTargetKey = `${intent}|${[...targetTaskIds].sort().join(',')}`;
    if (seenIntentTargets.has(intentTargetKey)) continue;

    const profile = intentProfiles[intent];
    questions.push({
      intent,
      category: profile.category,
      question,
      responseProfile: profile.responseProfile,
      targetTaskIds,
      period,
      reasonForAsking,
      source: 'ai_generated',
    });
    seenSemanticQuestions.add(semanticKey);
    seenIntentTargets.add(intentTargetKey);
  }

  return questions;
}

/**
 * Layer 1 public entry point.
 *
 * It deliberately returns question candidates only. It does not persist them,
 * assign question IDs, score answers, adapt schedules, or influence activation.
 * Those responsibilities belong to later Reality Check layers.
 */
export async function generatePersonalizedRealityCheckQuestions({
  instructions = [],
  tasks = [],
  routineProfile = null,
  knownRealityFacts = [],
  maxQuestions = REALITY_CHECK_MAX_QUESTIONS,
}) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];

  const safeTasks = sanitizeTasksForRealityCheck(tasks);
  const result = await generateRealityCheckQuestionCandidates({
    instructions: sanitizeInstructionsForRealityCheck(instructions),
    tasks: safeTasks,
    routineProfile: sanitizeRoutineProfile(routineProfile),
    knownRealityFacts: sanitizeKnownRealityFacts(knownRealityFacts),
    maxQuestions,
  });

  return normalizeRealityCheckQuestionCandidates({
    rawText: result.text,
    tasks: safeTasks,
    maxQuestions,
  });
}
