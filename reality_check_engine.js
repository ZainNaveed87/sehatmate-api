import { generateRealityCheckQuestionCandidates } from './ai_service.js';
import {
  normalizePreferredLanguage,
} from './language_support.js';

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

function isSafetyCheckableCanonicalEnglish(question, reasonForAsking) {
  const combined = `${question} ${reasonForAsking}`;
  if (/[^\t\n\r -~]/.test(combined)) return false;
  return /^\s*(?:are|can|could|do|does|have|has|is|will|would|which)\b/i.test(question);
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

function asksForAlternativeTimingChoice(question) {
  const value = normalizedClinicalText(question);
  const patterns = [
    /\b(?:would|do)\s+you\s+prefer\b[^?]{0,80}\b(?:different|another|other)\s+time\b/,
    /\bwhat\s+time\s+would\s+you\s+prefer\b/,
    /\bchoose\b[^?]{0,50}\b(?:different|another|other)\s+time\b/,
    /\bmove\b[^?]{0,80}\b(?:reminder|task|medicine|medication|dose|appointment)\b[^?]{0,80}\bto\b/,
    /\b(?:different|another|other)\s+time\b[^?]{0,60}\b(?:better|prefer|work)\b/,
  ];
  return patterns.some((pattern) => pattern.test(value));
}

function normalizedClinicalText(value) {
  return cleanText(value, 1200).toLowerCase();
}

function instructionIdOf(task) {
  const raw = task?.instructionId ?? task?.instruction_id;
  return raw == null ? '' : String(raw).trim();
}

function instructionIdOfInstruction(item) {
  const raw = item?.id ?? item?.instructionId ?? item?.instruction_id;
  return raw == null ? '' : String(raw).trim();
}

function parseClockMinutes(value) {
  if (typeof value !== 'string') return [];
  const results = [];
  const seen = new Set();
  const pattern = /\b(1[0-2]|0?[1-9]):([0-5]\d)\s*(AM|PM)\b/gi;
  for (const match of value.matchAll(pattern)) {
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const meridiem = match[3].toUpperCase();
    if (meridiem === 'AM' && hour === 12) hour = 0;
    if (meridiem === 'PM' && hour !== 12) hour += 12;
    const total = hour * 60 + minute;
    if (!seen.has(total)) {
      seen.add(total);
      results.push(total);
    }
  }

  const twentyFourHour = /\b([01]\d|2[0-3]):([0-5]\d)\b/g;
  for (const match of value.matchAll(twentyFourHour)) {
    const total = Number(match[1]) * 60 + Number(match[2]);
    if (!seen.has(total)) {
      seen.add(total);
      results.push(total);
    }
  }
  return results;
}

function normalizedTitle(value) {
  return normalizedClinicalText(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function targetDetailsForQuestion({ targetTaskIds, tasks, instructions }) {
  const targetSet = new Set(targetTaskIds.map(String));
  const targetTasks = tasks.filter((task) => targetSet.has(taskIdOf(task)));
  const instructionIds = new Set(targetTasks.map(instructionIdOf).filter(Boolean));
  const taskTitles = targetTasks.map((task) => normalizedTitle(task?.title)).filter(Boolean);

  const targetInstructions = instructions.filter((item) => {
    if (instructionIds.has(instructionIdOfInstruction(item))) return true;
    const instructionTitle = normalizedTitle(item?.title);
    if (!instructionTitle) return false;
    return taskTitles.some((taskTitle) =>
      taskTitle === instructionTitle ||
      taskTitle.includes(instructionTitle) ||
      instructionTitle.includes(taskTitle));
  });

  const verifiedText = targetInstructions
    .map((item) => `${item?.title || ''} ${item?.instruction || ''} ${item?.timing || ''}`)
    .join(' ');
  const taskText = targetTasks
    .map((item) => `${item?.title || ''} ${item?.scheduleTime || item?.schedule_time || ''} ${item?.displayTime || item?.display_time || ''}`)
    .join(' ');

  return {
    targetTasks,
    targetInstructions,
    verifiedSourceText: cleanText(verifiedText, 1600),
    verifiedText: normalizedClinicalText(verifiedText),
    taskText: normalizedClinicalText(taskText),
  };
}

function displayClockTime(task) {
  const visible = cleanText(task?.displayTime ?? task?.display_time, 80);
  const visibleMatch = visible.match(/\b(1[0-2]|0?[1-9]):([0-5]\d)\s*(AM|PM)\b/i);
  if (visibleMatch) return `${Number(visibleMatch[1])}:${visibleMatch[2]} ${visibleMatch[3].toUpperCase()}`;

  const raw = cleanText(task?.scheduleTime ?? task?.schedule_time, 20);
  const match = raw.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return '';
  let hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${suffix}`;
}

function readableScheduleDate(task) {
  const raw = cleanText(task?.scheduleDate ?? task?.schedule_date, 20);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function verifiedMealRelation(verifiedText) {
  const relations = [
    'before breakfast', 'after breakfast',
    'before lunch', 'after lunch',
    'before dinner', 'after dinner',
    'before food', 'after food', 'with food', 'without food',
  ];
  return relations.find((value) => verifiedText.includes(value)) || '';
}

function verifiedMealRelationSource(sourceText) {
  const match = cleanText(sourceText, 1600).match(
    /\b(?:before|after|with|without)\s+(?:breakfast|lunch|dinner|food)\b/i,
  );
  return match ? match[0] : '';
}

function verifiedBedtimeSource(sourceText) {
  const match = cleanText(sourceText, 1600).match(/\bat bedtime\b|\bbedtime\b/i);
  return match ? match[0] : '';
}

function verifiedDateSource(sourceText) {
  const value = cleanText(sourceText, 1600);
  const month =
    '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}\b/,
    new RegExp(`\\b\\d{1,2}\\s+${month}\\s+\\d{4}\\b`, 'i'),
    new RegExp(`\\b${month}\\s+\\d{1,2},?\\s+\\d{4}\\b`, 'i'),
    /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[0];
  }

  return '';
}

function hasTemporalIntensifier(question) {
  return /\b(?:right|immediately|directly|straight|just)\s+(?:before|after)\b/i.test(question);
}

function isOpenEndedTimeQuestion(question) {
  return /^\s*(?:what\s+time|when)\b/i.test(question) ||
    /\bwhat\s+time\s+do\s+you\b/i.test(question);
}

function hasCompoundPracticalQuestion(question) {
  return /[,;]?\s+and\s+(?:can|could|do|does|are|is|will|would|have|has)\s+you\b/i.test(question);
}

function replaceGenericSingleTargetLabel(question, targetTasks) {
  if (targetTasks.length !== 1) return question;
  const title = cleanText(targetTasks[0]?.title, 180);
  if (!title) return question;
  return question.replace(
    /\bthe\s+(?:first|second|third|fourth|fifth|sixth)\s+(?:medication|medicine|task)\b/gi,
    title,
  );
}

function canonicalizeQuestionCandidate({
  intent,
  question,
  reasonForAsking,
  targetTaskIds,
  tasks,
  instructions,
}) {
  const details = targetDetailsForQuestion({ targetTaskIds, tasks, instructions });
  const singleTask = details.targetTasks.length === 1 ? details.targetTasks[0] : null;
  const title = cleanText(singleTask?.title, 180);
  const time = displayClockTime(singleTask);
  const date = readableScheduleDate(singleTask);
  const mealRelation = verifiedMealRelation(details.verifiedText);

  let safeQuestion = replaceGenericSingleTargetLabel(question, details.targetTasks);
  let safeReason = reasonForAsking;

  if (
    intent === 'meal_routine' &&
    singleTask &&
    mealRelation &&
    time &&
    (
      hasTemporalIntensifier(safeQuestion) ||
      asksForAlternativeTimingChoice(safeQuestion) ||
      isOpenEndedTimeQuestion(safeQuestion) ||
      /\b(?:a|any)\s+meal\b/i.test(safeQuestion)
    )
  ) {
    const meal = mealRelation.split(' ').at(-1);
    if (mealRelation.startsWith('after ')) {
      safeQuestion = `Is your ${meal} usually finished by ${time} so ${title} can be taken ${mealRelation}?`;
    } else if (mealRelation.startsWith('before ')) {
      safeQuestion = `Is ${time} usually before your ${meal} so ${title} can be taken ${mealRelation}?`;
    } else {
      safeQuestion = `Does your usual routine around ${time} allow ${title} to be taken ${mealRelation}?`;
    }
    safeReason = `The verified instruction says ${title} should be taken ${mealRelation}, and the reminder is set for ${time}; this checks whether the routine aligns with that instruction.`;
  }

  if (intent === 'sleep_routine' && singleTask && time && isOpenEndedTimeQuestion(safeQuestion)) {
    safeQuestion = `Is ${time} usually close to your bedtime?`;
    safeReason = `The verified instruction uses bedtime, and the reminder is set for ${time}; this checks whether that reminder matches your usual bedtime routine.`;
  }

  if (
    intent === 'appointment_availability' &&
    singleTask &&
    (hasCompoundPracticalQuestion(safeQuestion) || /\b(?:transport|transportation|travel|ride)\b/i.test(safeQuestion))
  ) {
    const when = [date, time].filter(Boolean).join(' at ');
    safeQuestion = when
      ? `Are you available for ${title} on ${when}?`
      : `Are you available for ${title} at its scheduled time?`;
    safeReason = `The follow-up has a stated schedule, so your availability for that appointment needs to be confirmed separately from transport or other access needs.`;
  }

  return {
    question: cleanText(safeQuestion, 240),
    reasonForAsking: cleanText(safeReason, 320),
  };
}

function hasVerifiedMeaningDrift({
  question,
  reasonForAsking,
  targetTaskIds,
  tasks,
  instructions,
}) {
  // Validate the patient-facing question itself against the verified wording.
  // The explanation may repeat the correct source phrase and must never be
  // allowed to mask broader wording inside the question.
  const candidate = normalizedClinicalText(question);
  const { verifiedText, taskText } = targetDetailsForQuestion({
    targetTaskIds,
    tasks,
    instructions,
  });

  if (!verifiedText) return false;

  // Do not let the model narrow a simple before/after instruction into an
  // "immediately/right/directly" requirement that was never verified.
  if (hasTemporalIntensifier(candidate)) return true;

  // Food / routine anchors are safety-critical. A model may omit the anchor,
  // but if it refers to it using a broader substitute, reject the question.
  const mealAnchors = ['breakfast', 'lunch', 'dinner'];
  for (const anchor of mealAnchors) {
    if (!verifiedText.includes(anchor)) continue;
    const mentionsGenericMeal = /\b(?:a|the|your|any)?\s*meal\b/.test(candidate);
    if (mentionsGenericMeal && !candidate.includes(anchor)) return true;
  }

  if (verifiedText.includes('bedtime')) {
    const usesBroaderNight = /\b(?:at|in|during)\s+(?:the\s+)?night\b/.test(candidate);
    if (usesBroaderNight && !candidate.includes('bedtime')) return true;
  }

  if (verifiedText.includes('fasting')) {
    const referencesFoodWithoutFasting = /\b(?:food|meal|eat|eating)\b/.test(candidate) &&
      !candidate.includes('fasting');
    if (referencesFoodWithoutFasting) return true;
  }

  const relationAnchors = [
    ['before', 'breakfast'],
    ['after', 'breakfast'],
    ['before', 'lunch'],
    ['after', 'lunch'],
    ['before', 'dinner'],
    ['after', 'dinner'],
    ['before', 'food'],
    ['after', 'food'],
    ['with', 'food'],
    ['without', 'food'],
  ];
  for (const [relation, anchor] of relationAnchors) {
    const verifiedPattern = new RegExp(`\\b${relation}\\s+(?:your\\s+|the\\s+)?${anchor}\\b`);
    if (!verifiedPattern.test(verifiedText)) continue;

    const candidateMentionsRelation = new RegExp(`\\b${relation}\\b`).test(candidate);
    if (!candidateMentionsRelation) continue;

    const candidatePreservesAnchor = new RegExp(
      `\\b${relation}\\s+(?:your\\s+|the\\s+)?${anchor}\\b`,
    ).test(candidate);
    if (!candidatePreservesAnchor) return true;
  }

  if (/\bempty\s+stomach\b/.test(verifiedText)) {
    const mentionsEmpty = /\bempty\b/.test(candidate);
    if (mentionsEmpty && !/\bempty\s+(?:your\s+|the\s+)?stomach\b/.test(candidate)) {
      return true;
    }
  }

  // A Reality Check may mention the user-selected reminder time or the exact
  // verified clock time, but it must not introduce a third medication time.
  const allowedTimes = new Set([
    ...parseClockMinutes(verifiedText),
    ...parseClockMinutes(taskText),
  ]);
  const candidateTimes = parseClockMinutes(candidate);
  if (allowedTimes.size > 0 && candidateTimes.some((time) => !allowedTimes.has(time))) {
    return true;
  }

  return false;
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

function periodName(period, language) {
  const normalized = allowedPeriods.has(period) ? period : 'any';
  const labels = {
    English: {
      morning: 'morning',
      afternoon: 'afternoon',
      evening: 'evening',
      night: 'night',
      any: 'daily',
    },
    Urdu: {
      morning: 'صبح',
      afternoon: 'دوپہر',
      evening: 'شام',
      night: 'رات',
      any: 'روزمرہ',
    },
    'Roman Urdu': {
      morning: 'subah',
      afternoon: 'dopahar',
      evening: 'shaam',
      night: 'raat',
      any: 'rozmarra',
    },
  };
  return labels[language][normalized];
}

function displayDateForQuestion(singleTask, details) {
  return verifiedDateSource(details.verifiedSourceText) ||
    cleanText(singleTask?.scheduleDate ?? singleTask?.schedule_date, 40);
}

function displayTargetForQuestion(details, language) {
  const singleTask =
    details.targetTasks.length === 1 ? details.targetTasks[0] : null;
  const title = cleanText(singleTask?.title, 180);
  if (title) return title;
  if (details.targetTasks.length > 1) {
    if (language === 'Urdu') return 'ان دیکھ بھال کے کاموں';
    if (language === 'Roman Urdu') return 'in care tasks';
    return 'these care tasks';
  }
  if (language === 'Urdu') return 'اس دیکھ بھال کے کام';
  if (language === 'Roman Urdu') return 'is care task';
  return 'this care task';
}

function realityQuestionContext(question, tasks, instructions, language) {
  const targetTaskIds = Array.isArray(question?.targetTaskIds)
    ? question.targetTaskIds.map(String)
    : [];
  const details = targetDetailsForQuestion({
    targetTaskIds,
    tasks,
    instructions,
  });
  const singleTask =
    details.targetTasks.length === 1 ? details.targetTasks[0] : null;
  const period = cleanText(question?.period, 20).toLowerCase();

  return {
    title: displayTargetForQuestion(details, language),
    time: singleTask ? displayClockTime(singleTask) : '',
    date: singleTask ? displayDateForQuestion(singleTask, details) : '',
    mealRelation: verifiedMealRelationSource(details.verifiedSourceText),
    bedtime: verifiedBedtimeSource(details.verifiedSourceText),
    period: allowedPeriods.has(period) ? period : 'any',
  };
}

function englishRealityDisplay(question, context) {
  const when = [context.date, context.time].filter(Boolean).join(' at ');
  const period = periodName(context.period, 'English');
  const target = context.title;

  switch (question.intent) {
    case 'meal_routine': {
      if (context.mealRelation && context.time) {
        const meal = context.mealRelation.split(' ').at(-1);
        const relation = context.mealRelation.toLowerCase();
        const prompt = relation.startsWith('after ')
          ? `Is your ${meal} usually finished by ${context.time} so ${target} can be taken ${context.mealRelation}?`
          : relation.startsWith('before ')
            ? `Is ${context.time} usually before your ${meal} so ${target} can be taken ${context.mealRelation}?`
            : `Does your usual routine around ${context.time} allow ${target} to be taken ${context.mealRelation}?`;
        return {
          question: prompt,
          reasonForAsking:
            `This checks whether the practical meal routine fits ${target} while preserving ${context.mealRelation}.`,
        };
      }
      return {
        question: `Does your usual meal routine make ${target} practical to follow as written?`,
        reasonForAsking:
          `This checks meal-routine fit without changing the verified instruction for ${target}.`,
      };
    }
    case 'medicine_access':
      return {
        question: `Do you have ${target} available when you need it?`,
        reasonForAsking:
          `This checks medicine access only and does not change ${target}.`,
      };
    case 'caregiver_availability':
    case 'task_support':
      return {
        question: `Is the required help available for ${target}?`,
        reasonForAsking:
          `This checks practical support for ${target}.`,
      };
    case 'travel_access':
      return {
        question: when
          ? `Can you reach the clinic or laboratory for ${target} on ${when}?`
          : `Can you reach the clinic or laboratory for ${target} at the stated time?`,
        reasonForAsking:
          `This checks travel access separately from any medical instruction for ${target}.`,
      };
    case 'location_access':
      return {
        question: `Can you access the required location for ${target}?`,
        reasonForAsking:
          `This checks practical location access for ${target}.`,
      };
    case 'school_or_work_conflict':
      return {
        question: context.time
          ? `Does ${target} at ${context.time} usually fit your school or work routine?`
          : `Does ${target} usually fit your school or work routine?`,
        reasonForAsking:
          `This checks practical routine fit for ${target}.`,
      };
    case 'sleep_routine':
      return {
        question: context.time && context.bedtime
          ? `Is ${context.time} usually close to your ${context.bedtime} for ${target}?`
          : `Does your usual sleep routine make ${target} practical to follow as written?`,
        reasonForAsking:
          `This checks sleep-routine fit without changing the verified instruction for ${target}.`,
      };
    case 'equipment_access':
      return {
        question: `Do you have the required equipment for ${target}?`,
        reasonForAsking:
          `This checks practical equipment access for ${target}.`,
      };
    case 'appointment_availability':
      return {
        question: when
          ? `Are you available for ${target} on ${when}?`
          : `Are you available for ${target} at its scheduled time?`,
        reasonForAsking:
          'This checks appointment availability separately from transport or medical changes.',
      };
    case 'instruction_feasibility':
      return {
        question: `Is ${target} practical for you to follow as written?`,
        reasonForAsking:
          'This checks practical feasibility without changing the verified instruction.',
      };
    case 'routine_time':
    default:
      return {
        question: context.time
          ? `Can you reliably be available at ${context.time} for ${target}?`
          : `Can you reliably fit ${target} into your ${period} routine?`,
        reasonForAsking:
          `This checks practical routine fit for ${target}.`,
      };
  }
}

function urduRealityDisplay(question, context) {
  const period = periodName(context.period, 'Urdu');
  const target = context.title;
  const atTime = context.time ? `${context.time} پر ` : '';
  const onWhen = [context.date, context.time].filter(Boolean).join('، ');

  switch (question.intent) {
    case 'meal_routine':
      return {
        question: context.mealRelation && context.time
          ? `کیا آپ کا معمول ${context.time} کے آس پاس ${target} کو ${context.mealRelation} لینے کی اجازت دیتا ہے؟`
          : `کیا آپ کے کھانے کا معمول ${target} کو لکھی ہوئی ہدایت کے مطابق لینا عملی بناتا ہے؟`,
        reasonForAsking:
          `یہ صرف کھانے کے معمول کو چیک کرتا ہے اور ${target} کی تصدیق شدہ ہدایت کو تبدیل نہیں کرتا۔`,
      };
    case 'medicine_access':
      return {
        question: `کیا ${target} ضرورت کے وقت آپ کے پاس دستیاب ہے؟`,
        reasonForAsking:
          `یہ صرف دوا تک رسائی چیک کرتا ہے اور ${target} کو تبدیل نہیں کرتا۔`,
      };
    case 'caregiver_availability':
    case 'task_support':
      return {
        question: `کیا ${target} کے لیے ضروری مدد دستیاب ہے؟`,
        reasonForAsking:
          `یہ ${target} کے لیے عملی مدد چیک کرتا ہے۔`,
      };
    case 'travel_access':
      return {
        question: onWhen
          ? `کیا آپ ${target} کے لیے ${onWhen} پر کلینک یا لیبارٹری پہنچ سکتے ہیں؟`
          : `کیا آپ ${target} کے لیے مقررہ وقت پر کلینک یا لیبارٹری پہنچ سکتے ہیں؟`,
        reasonForAsking:
          `یہ ${target} کے لیے سفر کی عملی رسائی الگ سے چیک کرتا ہے۔`,
      };
    case 'location_access':
      return {
        question: `کیا آپ ${target} کے لیے مطلوبہ جگہ تک رسائی حاصل کر سکتے ہیں؟`,
        reasonForAsking:
          `یہ ${target} کے لیے جگہ تک عملی رسائی چیک کرتا ہے۔`,
      };
    case 'school_or_work_conflict':
      return {
        question: `کیا ${atTime}${target} عموماً آپ کے اسکول یا کام کے معمول میں فٹ بیٹھتا ہے؟`,
        reasonForAsking:
          `یہ ${target} کے لیے عملی معمول کا فٹ چیک کرتا ہے۔`,
      };
    case 'sleep_routine':
      return {
        question: context.time && context.bedtime
          ? `کیا ${context.time} عموماً آپ کے ${context.bedtime} کے قریب ہوتا ہے تاکہ ${target} پر عمل ہو سکے؟`
          : `کیا آپ کا نیند کا معمول ${target} کو لکھی ہوئی ہدایت کے مطابق کرنا عملی بناتا ہے؟`,
        reasonForAsking:
          `یہ نیند کے معمول کو چیک کرتا ہے اور ${target} کی تصدیق شدہ ہدایت کو تبدیل نہیں کرتا۔`,
      };
    case 'equipment_access':
      return {
        question: `کیا ${target} کے لیے ضروری سامان آپ کے پاس ہے؟`,
        reasonForAsking:
          `یہ ${target} کے لیے سامان تک عملی رسائی چیک کرتا ہے۔`,
      };
    case 'appointment_availability':
      return {
        question: onWhen
          ? `کیا آپ ${target} کے لیے ${onWhen} پر دستیاب ہیں؟`
          : `کیا آپ ${target} کے مقررہ وقت پر دستیاب ہیں؟`,
        reasonForAsking:
          'یہ ملاقات کی دستیابی کو سفر یا طبی تبدیلیوں سے الگ چیک کرتا ہے۔',
      };
    case 'instruction_feasibility':
      return {
        question: `کیا ${target} کو لکھی ہوئی ہدایت کے مطابق کرنا آپ کے لیے عملی ہے؟`,
        reasonForAsking:
          'یہ تصدیق شدہ ہدایت کو تبدیل کیے بغیر عملی امکان چیک کرتا ہے۔',
      };
    case 'routine_time':
    default:
      return {
        question: context.time
          ? `کیا آپ ${context.time} پر ${target} کے لیے قابل اعتماد طور پر دستیاب ہوتے ہیں؟`
          : `کیا آپ ${target} کو اپنے ${period} کے معمول میں قابل اعتماد طور پر شامل کر سکتے ہیں؟`,
        reasonForAsking:
          `یہ ${target} کے لیے عملی معمول کا فٹ چیک کرتا ہے۔`,
      };
  }
}

function romanUrduRealityDisplay(question, context) {
  const period = periodName(context.period, 'Roman Urdu');
  const target = context.title;
  const atTime = context.time ? `${context.time} par ` : '';
  const onWhen = [context.date, context.time].filter(Boolean).join(', ');

  switch (question.intent) {
    case 'meal_routine':
      return {
        question: context.mealRelation && context.time
          ? `Kya aap ka routine ${context.time} ke aas paas ${target} ko ${context.mealRelation} lene deta hai?`
          : `Kya aap ka meal routine ${target} ko written instruction ke mutabiq follow karna practical banata hai?`,
        reasonForAsking:
          `Yeh sirf meal routine check karta hai aur ${target} ki verified instruction ko change nahi karta.`,
      };
    case 'medicine_access':
      return {
        question: `Kya ${target} zaroorat ke waqt aap ke paas available hota hai?`,
        reasonForAsking:
          `Yeh sirf medicine access check karta hai aur ${target} ko change nahi karta.`,
      };
    case 'caregiver_availability':
    case 'task_support':
      return {
        question: `Kya ${target} ke liye zaroori help available hai?`,
        reasonForAsking:
          `Yeh ${target} ke liye practical support check karta hai.`,
      };
    case 'travel_access':
      return {
        question: onWhen
          ? `Kya aap ${target} ke liye ${onWhen} par clinic ya laboratory pohanch sakte hain?`
          : `Kya aap ${target} ke liye stated time par clinic ya laboratory pohanch sakte hain?`,
        reasonForAsking:
          `Yeh ${target} ke liye travel access ko medical instruction se alag check karta hai.`,
      };
    case 'location_access':
      return {
        question: `Kya aap ${target} ke liye required location tak access kar sakte hain?`,
        reasonForAsking:
          `Yeh ${target} ke liye practical location access check karta hai.`,
      };
    case 'school_or_work_conflict':
      return {
        question: `Kya ${atTime}${target} aam tor par aap ke school ya work routine mein fit hota hai?`,
        reasonForAsking:
          `Yeh ${target} ke liye practical routine fit check karta hai.`,
      };
    case 'sleep_routine':
      return {
        question: context.time && context.bedtime
          ? `Kya ${context.time} aam tor par aap ke ${context.bedtime} ke qareeb hota hai taake ${target} follow ho sake?`
          : `Kya aap ka sleep routine ${target} ko written instruction ke mutabiq follow karna practical banata hai?`,
        reasonForAsking:
          `Yeh sleep routine check karta hai aur ${target} ki verified instruction ko change nahi karta.`,
      };
    case 'equipment_access':
      return {
        question: `Kya ${target} ke liye zaroori equipment aap ke paas hai?`,
        reasonForAsking:
          `Yeh ${target} ke liye practical equipment access check karta hai.`,
      };
    case 'appointment_availability':
      return {
        question: onWhen
          ? `Kya aap ${target} ke liye ${onWhen} par available hain?`
          : `Kya aap ${target} ke scheduled time par available hain?`,
        reasonForAsking:
          'Yeh appointment availability ko transport ya medical changes se alag check karta hai.',
      };
    case 'instruction_feasibility':
      return {
        question: `Kya ${target} ko written instruction ke mutabiq follow karna aap ke liye practical hai?`,
        reasonForAsking:
          'Yeh verified instruction ko change kiye baghair practical feasibility check karta hai.',
      };
    case 'routine_time':
    default:
      return {
        question: context.time
          ? `Kya aap ${context.time} par ${target} ke liye bharosemand taur par available hote hain?`
          : `Kya aap ${target} ko apne ${period} routine mein reliably fit kar sakte hain?`,
        reasonForAsking:
          `Yeh ${target} ke liye practical routine fit check karta hai.`,
      };
  }
}

function localizedRealityDisplay(question, context, language) {
  if (language === 'Urdu') return urduRealityDisplay(question, context);
  if (language === 'Roman Urdu') return romanUrduRealityDisplay(question, context);
  return englishRealityDisplay(question, context);
}

export function localizeRealityCheckQuestions({
  questions = [],
  tasks = [],
  instructions = [],
  preferredLanguage,
}) {
  const language = normalizePreferredLanguage(preferredLanguage);
  return questions.map((question) => {
    const context = realityQuestionContext(
      question,
      tasks,
      instructions,
      language,
    );
    const display = localizedRealityDisplay(question, context, language);

    return {
      ...question,
      question: cleanText(display.question, 500),
      reasonForAsking: cleanText(display.reasonForAsking, 500),
    };
  });
}

/**
 * Deterministically validate model-generated question candidates.
 * Unsafe, ungrounded, malformed and duplicate questions are dropped.
 */
export function normalizeRealityCheckQuestionCandidates({
  rawText,
  tasks = [],
  instructions = [],
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
    let question = cleanText(candidate?.question, 240);
    const period = cleanText(candidate?.period, 20).toLowerCase();
    let reasonForAsking = cleanText(candidate?.reasonForAsking, 320);

    if (!allowedIntents.has(intent)) continue;
    if (!allowedPeriods.has(period)) continue;

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

    const canonical = canonicalizeQuestionCandidate({
      intent,
      question,
      reasonForAsking,
      targetTaskIds,
      tasks,
      instructions,
    });
    question = canonical.question;
    reasonForAsking = canonical.reasonForAsking;

    if (!isSafetyCheckableCanonicalEnglish(question, reasonForAsking)) continue;
    if (question.length < 8 || !question.endsWith('?')) continue;
    if (!reasonForAsking) continue;
    if (hasUnsafeClinicalLanguage(`${question} ${reasonForAsking}`)) continue;
    if (hasUnnecessarySensitiveRequest(question)) continue;
    if (asksForAlternativeTimingChoice(question)) continue;
    if (isOpenEndedTimeQuestion(question)) continue;
    if (hasCompoundPracticalQuestion(question)) continue;

    if (hasVerifiedMeaningDrift({
      question,
      reasonForAsking,
      targetTaskIds,
      tasks,
      instructions,
    })) continue;

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
  preferredLanguage,
}) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];

  const safeTasks = sanitizeTasksForRealityCheck(tasks);
  const safeInstructions = sanitizeInstructionsForRealityCheck(instructions);
  const result = await generateRealityCheckQuestionCandidates({
    instructions: safeInstructions,
    tasks: safeTasks,
    routineProfile: sanitizeRoutineProfile(routineProfile),
    knownRealityFacts: sanitizeKnownRealityFacts(knownRealityFacts),
    maxQuestions,
  });

  const questions = normalizeRealityCheckQuestionCandidates({
    rawText: result.text,
    tasks: safeTasks,
    instructions: safeInstructions,
    maxQuestions,
  });

  return localizeRealityCheckQuestions({
    questions,
    tasks: safeTasks,
    instructions: safeInstructions,
    preferredLanguage,
  });
}
