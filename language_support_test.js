import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildCareInstructionVerificationPrompt,
  buildCareInstructionVerificationSystemPrompt,
  languageAwareSystemPrompt,
} from './ai_service.js';
import {
  fallbackAnalysis,
} from './care_context_engine.js';
import {
  aiLanguageInstruction,
  localizedAiFallbackText,
  normalizePreferredLanguage,
  preferredLanguageIdentity,
} from './language_support.js';
import {
  actionForRealityIntent,
  dynamicQuestionToDecisionTemplate,
} from './reality_check_decision.js';
import {
  localizeRealityCheckQuestions,
  normalizeRealityCheckQuestionCandidates,
} from './reality_check_engine.js';
import {
  buildRealityCheckContextHash,
  buildStableRealityQuestionKey,
} from './reality_check_store.js';
import {
  extractVerifiedExactClockTimes,
} from './schedule_time_guard.js';

assert.equal(normalizePreferredLanguage('English'), 'English');
assert.equal(normalizePreferredLanguage(' Urdu '), 'Urdu');
assert.equal(normalizePreferredLanguage('roman   urdu'), 'Roman Urdu');
assert.equal(preferredLanguageIdentity('Roman Urdu'), 'roman_urdu');
assert.equal(normalizePreferredLanguage(null), 'English');
assert.equal(normalizePreferredLanguage(''), 'English');
assert.equal(normalizePreferredLanguage('Punjabi'), 'English');

const englishInstruction = aiLanguageInstruction('English');
assert.match(englishInstruction, /clear, simple English/);

const urduInstruction = aiLanguageInstruction('Urdu');
assert.match(urduInstruction, /Urdu script/);

const romanUrduInstruction = aiLanguageInstruction('Roman Urdu');
assert.match(romanUrduInstruction, /Latin characters/);
assert.match(romanUrduInstruction, /Do not output Urdu script/);

for (const language of ['English', 'Urdu', 'Roman Urdu']) {
  const instruction = aiLanguageInstruction(language);
  assert.match(instruction, /medicine names/);
  assert.match(instruction, /numeric doses/);
  assert.match(instruction, /dates/);
  assert.match(instruction, /verified exact clock times/);
}

const secondPassPrompt = buildCareInstructionVerificationPrompt({
  firstPassText:
    '{"instructions":[{"category":"medicine","title":"DemoMed Beta 5 mg","instruction":"Take 1 tablet once daily","timing":"2:00 PM","reviewStatus":"unclear","requiresProfessionalConfirmation":true}]}',
  preferredLanguage: 'Urdu',
});
assert.match(secondPassPrompt, /Server-selected preferred language: Urdu/);
assert.match(secondPassPrompt, /ambiguityReason, possibleInterpretation, and safetyNote/);
assert.match(secondPassPrompt, /Do not translate title, instruction, or timing/);
assert.match(secondPassPrompt, /medicine names, doses, units, route, frequency, duration, dates, verified exact times, or source wording/);
assert.match(secondPassPrompt, /DemoMed Beta 5 mg/);
assert.match(secondPassPrompt, /2:00 PM/);

const secondPassSystemPrompt =
  buildCareInstructionVerificationSystemPrompt('Roman Urdu');
assert.match(secondPassSystemPrompt, /Server-selected preferred language: Roman Urdu/);
assert.match(secondPassSystemPrompt, /Latin characters/);
assert.match(secondPassSystemPrompt, /Keep title, instruction, timing and canonical JSON values unchanged/);

assert.equal(
  languageAwareSystemPrompt(
    'You are a connection test. Follow the user instruction exactly and add nothing else.',
    null,
  ),
  'You are a connection test. Follow the user instruction exactly and add nothing else.',
);

const serverText = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
const testRouteStart = serverText.indexOf("app.post('/api/ai/test'");
const nextRouteStart = serverText.indexOf("app.post('/api/auth/register'");
const aiTestRoute = serverText.slice(testRouteStart, nextRouteStart);
assert.match(aiTestRoute, /Reply with exactly: SEHATMATE_AI_OK/);
assert.doesNotMatch(aiTestRoute, /preferredLanguage/);

const tasks = [
  {
    id: 'task-2',
    instruction_id: 'instruction-2',
    task_kind: 'medicine',
    title: 'DemoMed Beta 5 mg',
    schedule_time: '14:00',
    display_time: '2:00 PM',
    recurrence_text: 'once daily',
    grounding: 'explicit',
  },
];

const instructions = [
  {
    id: 'instruction-2',
    category: 'medicine',
    title: 'DemoMed Beta 5 mg',
    instruction: 'Take 1 tablet once daily at exactly 2:00 PM for 7 days.',
    timing: 'exactly 2:00 PM',
    reviewStatus: 'verified',
  },
];

const unsafeLocalizedRawQuestion = normalizeRealityCheckQuestionCandidates({
  tasks,
  instructions,
  rawText: JSON.stringify({
    questions: [
      {
        intent: 'routine_time',
        question:
          'کیا آپ DemoMed Beta 5 mg کا dose تبدیل کرنا چاہتے ہیں؟',
        targetTaskIds: ['task-2'],
        period: 'afternoon',
        reasonForAsking:
          'یہ سوال علاج بدلنے کے بارے میں ہے۔',
      },
    ],
  }),
});

assert.equal(unsafeLocalizedRawQuestion.length, 0);

const validatedRealityQuestions = normalizeRealityCheckQuestionCandidates({
  tasks,
  instructions,
  rawText: JSON.stringify({
    questions: [
      {
        intent: 'routine_time',
        question:
          'Can you reliably be available at exactly 2:00 PM for DemoMed Beta 5 mg?',
        targetTaskIds: ['task-2'],
        period: 'afternoon',
        reasonForAsking:
          'This checks whether the practical routine fits the verified 2:00 PM schedule.',
      },
    ],
  }),
});

assert.equal(validatedRealityQuestions.length, 1);
const localizedRealityQuestion = localizeRealityCheckQuestions({
  questions: validatedRealityQuestions,
  tasks,
  instructions,
  preferredLanguage: 'Urdu',
});

assert.equal(localizedRealityQuestion.length, 1);
assert.equal(localizedRealityQuestion[0].intent, 'routine_time');
assert.equal(localizedRealityQuestion[0].category, 'Routine');
assert.equal(localizedRealityQuestion[0].responseProfile, 'routine_reliability');
assert.equal(localizedRealityQuestion[0].period, 'afternoon');
assert.deepEqual(localizedRealityQuestion[0].targetTaskIds, ['task-2']);
assert.match(localizedRealityQuestion[0].question, /[\u0600-\u06FF]/);
assert.match(localizedRealityQuestion[0].question, /؟$/);
assert.match(localizedRealityQuestion[0].question, /DemoMed Beta 5 mg/);
assert.match(localizedRealityQuestion[0].question, /2:00 PM/);

const romanRealityQuestion = localizeRealityCheckQuestions({
  questions: validatedRealityQuestions,
  tasks,
  instructions,
  preferredLanguage: 'Roman Urdu',
});
assert.doesNotMatch(romanRealityQuestion[0].question, /[\u0600-\u06FF]/);
assert.match(romanRealityQuestion[0].question, /DemoMed Beta 5 mg/);
assert.match(romanRealityQuestion[0].question, /2:00 PM/);

const appointmentTasks = [
  {
    id: 'visit-1',
    instruction_id: 'visit-instruction-1',
    task_kind: 'follow_up',
    title: 'Follow-up Visit',
    schedule_date: '2026-09-02',
    schedule_time: '10:00',
    display_time: '10:00 AM',
    grounding: 'explicit',
  },
];
const appointmentInstructions = [
  {
    id: 'visit-instruction-1',
    category: 'follow_up',
    title: 'Follow-up Visit',
    instruction: 'Follow-up Visit 02 September 2026 at 10:00 AM.',
    timing: '10:00 AM',
    reviewStatus: 'verified',
  },
];
const validatedAppointmentQuestions = normalizeRealityCheckQuestionCandidates({
  tasks: appointmentTasks,
  instructions: appointmentInstructions,
  rawText: JSON.stringify({
    questions: [
      {
        intent: 'appointment_availability',
        question:
          'Are you available to attend Follow-up Visit on 02 September 2026 at 10:00 AM?',
        targetTaskIds: ['visit-1'],
        period: 'morning',
        reasonForAsking:
          'Availability for the stated appointment time is not known.',
      },
    ],
  }),
});
assert.equal(validatedAppointmentQuestions.length, 1);
for (const language of ['English', 'Urdu', 'Roman Urdu']) {
  const [question] = localizeRealityCheckQuestions({
    questions: validatedAppointmentQuestions,
    tasks: appointmentTasks,
    instructions: appointmentInstructions,
    preferredLanguage: language,
  });
  assert.match(question.question, /02 September 2026/);
  assert.match(question.question, /10:00 AM/);
  if (language === 'Urdu') {
    assert.match(question.question, /[\u0600-\u06FF]/);
    assert.match(question.question, /؟$/);
  }
  if (language === 'Roman Urdu') {
    assert.doesNotMatch(question.question, /[\u0600-\u06FF]/);
  }
}

const canonicalTemplate = dynamicQuestionToDecisionTemplate({
  key: 'rq_demo',
  intent: localizedRealityQuestion[0].intent,
  category: localizedRealityQuestion[0].category,
  question: localizedRealityQuestion[0].question,
  responseProfile: localizedRealityQuestion[0].responseProfile,
  targetTaskIds: localizedRealityQuestion[0].targetTaskIds,
  period: localizedRealityQuestion[0].period,
  reasonForAsking: localizedRealityQuestion[0].reasonForAsking,
});
assert.equal(canonicalTemplate.intent, 'routine_time');
assert.equal(canonicalTemplate.responseProfile, 'routine_reliability');
assert.equal(canonicalTemplate.options[0].label, 'Yes, reliably');
assert.equal(actionForRealityIntent(canonicalTemplate.intent), 'schedule');

const englishQuestionKey = buildStableRealityQuestionKey({
  intent: 'routine_time',
  responseProfile: 'routine_reliability',
  targetTaskIds: ['task-2'],
  period: 'afternoon',
  question:
    'Can you reliably be available at exactly 2:00 PM for DemoMed Beta 5 mg?',
});
const urduQuestionKey = buildStableRealityQuestionKey({
  intent: 'routine_time',
  responseProfile: 'routine_reliability',
  targetTaskIds: ['task-2'],
  period: 'afternoon',
  question:
    'کیا آپ 2:00 PM پر DemoMed Beta 5 mg کے لیے reliably available ہوتے ہیں؟',
});
const romanUrduQuestionKey = buildStableRealityQuestionKey({
  intent: 'routine_time',
  responseProfile: 'routine_reliability',
  targetTaskIds: ['task-2'],
  period: 'afternoon',
  question:
    'Kya aap 2:00 PM par DemoMed Beta 5 mg ke liye reliably available hote hain?',
});

assert.equal(englishQuestionKey, urduQuestionKey);
assert.equal(englishQuestionKey, romanUrduQuestionKey);

const englishContextHash = buildRealityCheckContextHash({
  instructions,
  tasks,
  routineProfile: null,
  knownRealityFacts: [],
  preferredLanguage: 'English',
});
const urduContextHash = buildRealityCheckContextHash({
  instructions,
  tasks,
  routineProfile: null,
  knownRealityFacts: [],
  preferredLanguage: 'Urdu',
});
const romanUrduContextHash = buildRealityCheckContextHash({
  instructions,
  tasks,
  routineProfile: null,
  knownRealityFacts: [],
  preferredLanguage: 'Roman Urdu',
});

assert.notEqual(englishContextHash, urduContextHash);
assert.notEqual(englishContextHash, romanUrduContextHash);
assert.equal(
  englishContextHash,
  buildRealityCheckContextHash({
    instructions,
    tasks,
    routineProfile: null,
    knownRealityFacts: [],
    preferredLanguage: 'invalid value',
  }),
);

assert.deepEqual(extractVerifiedExactClockTimes(instructions[0]), [
  { time: '14:00:00', displayTime: '2:00 PM' },
]);

for (const language of ['English', 'Urdu', 'Roman Urdu']) {
  const guidance = fallbackAnalysis({
    note: '',
    professionalAnswers: [{ answer: 'Doctor confirmed caregiver support.' }],
    preferredLanguage: language,
  });
  assert.equal(guidance.signal, 'professional_guidance');
  assert.equal(guidance.nextAction, 'recheck_reality');
  assert.equal(guidance.requiresInstructionReview, false);

  const possibleChange = fallbackAnalysis({
    note: '',
    professionalAnswers: [{ answer: 'Doctor said change dose.' }],
    preferredLanguage: language,
  });
  assert.equal(possibleChange.signal, 'possible_instruction_change');
  assert.equal(possibleChange.nextAction, 'review_verified_instruction');
  assert.equal(possibleChange.requiresInstructionReview, true);
}

assert.doesNotMatch(
  localizedAiFallbackText('noActiveIngredientReadable', 'Roman Urdu'),
  /[\u0600-\u06FF]/,
);

const mojibakeCharacters = new RegExp(
  `[${[0x256a, 0x2518, 0x250c, 0x2588, 0x0192, 0xfffd]
    .map((codePoint) => String.fromCodePoint(codePoint))
    .join('')}]`,
);
for (const fileName of [
  'ai_service.js',
  'care_context_engine.js',
  'language_support.js',
  'language_support_test.js',
  'reality_check_engine.js',
  'server.js',
]) {
  const sourceText = fs.readFileSync(
    new URL(`./${fileName}`, import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(sourceText, mojibakeCharacters);
}

const urduSlashFallback = localizedAiFallbackText(
  'slashDoseFrequencyAmbiguity',
  'Urdu',
);
assert.match(urduSlashFallback, /[\u0600-\u06FF]/);
assert.doesNotMatch(urduSlashFallback, mojibakeCharacters);

const urduSafetyFallback = localizedAiFallbackText(
  'safetyConfirmExactInstruction',
  'Urdu',
);
assert.match(urduSafetyFallback, /[\u0600-\u06FF]/);
assert.doesNotMatch(urduSafetyFallback, /exact medicine|amount per dose|frequency|route|duration/i);

const urduScheduleReason = localizedAiFallbackText(
  'scheduleSlotReason',
  'Urdu',
  {
    index: 1,
    expectedCount: 3,
    frequency: '3 times daily',
    label: 'Morning',
  },
);
assert.match(urduScheduleReason, /[\u0600-\u06FF]/);
assert.match(urduScheduleReason, /3 times daily/);
assert.match(urduScheduleReason, /Morning/);

assert.match(
  localizedAiFallbackText('legacyMorningRoutineQuestion', 'Urdu'),
  /؟$/,
);

assert.doesNotMatch(
  localizedAiFallbackText('duplicateMedicineAmbiguity', 'Roman Urdu'),
  /[\u0600-\u06FF]/,
);
assert.doesNotMatch(
  localizedAiFallbackText('legacyMedicineAccessQuestion', 'Roman Urdu'),
  /[\u0600-\u06FF]/,
);

console.log('Backend AI language support tests passed.');
