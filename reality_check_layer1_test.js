import assert from 'node:assert/strict';
import { normalizeRealityCheckQuestionCandidates } from './reality_check_engine.js';

const tasks = [
  { id: 101, task_kind: 'medicine', title: 'Medicine A', display_time: 'Afternoon' },
  { id: 102, task_kind: 'follow_up', title: 'Clinic follow-up', display_time: '10:00 AM' },
];

const safe = normalizeRealityCheckQuestionCandidates({
  tasks,
  rawText: JSON.stringify({
    questions: [
      {
        intent: 'school_or_work_conflict',
        question: 'Are you normally able to access this task during your school or work hours?',
        targetTaskIds: ['101'],
        period: 'afternoon',
        reasonForAsking: 'The task is scheduled during the daytime and access is not known.',
      },
      {
        intent: 'appointment_availability',
        question: 'Are you normally available to attend this follow-up at its stated time?',
        targetTaskIds: ['102'],
        period: 'any',
        reasonForAsking: 'Availability for the stated visit time is not known.',
      },
    ],
  }),
});

assert.equal(safe.length, 2);
assert.equal(safe[0].source, 'ai_generated');
assert.equal(safe[0].responseProfile, 'conflict_reliability');

const unsafe = normalizeRealityCheckQuestionCandidates({
  tasks,
  rawText: JSON.stringify({
    questions: [
      {
        intent: 'medicine_access',
        question: 'Should you change your medicine dose if school makes this difficult?',
        targetTaskIds: ['101'],
        period: 'afternoon',
        reasonForAsking: 'Unsafe clinical decision request.',
      },
      {
        intent: 'medicine_access',
        question: 'Do you have the medicine available when this reminder occurs?',
        targetTaskIds: ['999'],
        period: 'afternoon',
        reasonForAsking: 'Ungrounded task.',
      },
    ],
  }),
});

assert.equal(unsafe.length, 0);

const mealTasks = [
  {
    id: 201,
    instruction_id: '301',
    task_kind: 'medicine',
    title: 'DemoMed Alpha',
    schedule_time: '07:30',
    display_time: '7:30 AM',
  },
];
const mealInstructions = [
  {
    id: 301,
    category: 'medicine',
    title: 'DemoMed Alpha 10 mg',
    instruction: 'Take 1 tablet once daily after breakfast for 7 days.',
    timing: 'after breakfast',
  },
];

const broadenedFoodWording = normalizeRealityCheckQuestionCandidates({
  tasks: mealTasks,
  instructions: mealInstructions,
  rawText: JSON.stringify({
    questions: [
      {
        intent: 'meal_routine',
        question: 'Would you prefer a different time that still lets you take DemoMed Alpha after a meal?',
        targetTaskIds: ['201'],
        period: 'morning',
        reasonForAsking: 'The instruction is after breakfast but meal timing is not known.',
      },
    ],
  }),
});
assert.equal(broadenedFoodWording.length, 1);
assert.equal(broadenedFoodWording[0].question, 'Is your breakfast usually finished by 7:30 AM so DemoMed Alpha can be taken after breakfast?');

const replacementTimeQuestion = normalizeRealityCheckQuestionCandidates({
  tasks: mealTasks,
  instructions: mealInstructions,
  rawText: JSON.stringify({
    questions: [
      {
        intent: 'meal_routine',
        question: 'Do you eat breakfast around 7:30 AM, or would you prefer a different time?',
        targetTaskIds: ['201'],
        period: 'morning',
        reasonForAsking: 'Breakfast timing needs to be checked against the current reminder.',
      },
    ],
  }),
});
assert.equal(replacementTimeQuestion.length, 1);
assert.equal(replacementTimeQuestion[0].question, 'Is your breakfast usually finished by 7:30 AM so DemoMed Alpha can be taken after breakfast?');

const preservedFoodWording = normalizeRealityCheckQuestionCandidates({
  tasks: mealTasks,
  instructions: mealInstructions,
  rawText: JSON.stringify({
    questions: [
      {
        intent: 'meal_routine',
        question: 'Is 7:30 AM usually after your breakfast?',
        targetTaskIds: ['201'],
        period: 'morning',
        reasonForAsking: 'The instruction requires DemoMed Alpha after breakfast, and breakfast timing is not confirmed.',
      },
    ],
  }),
});
assert.equal(preservedFoodWording.length, 1);

const inventedClockTime = normalizeRealityCheckQuestionCandidates({
  tasks: [
    {
      id: 202,
      instruction_id: '302',
      task_kind: 'medicine',
      title: 'DemoMed Beta',
      schedule_time: '14:00',
      display_time: '2:00 PM',
    },
  ],
  instructions: [
    {
      id: 302,
      category: 'medicine',
      title: 'DemoMed Beta 5 mg',
      instruction: 'Take 1 tablet once daily at exactly 2:00 PM for 7 days.',
      timing: 'exactly 2:00 PM',
    },
  ],
  rawText: JSON.stringify({
    questions: [
      {
        intent: 'school_or_work_conflict',
        question: 'Would taking this at 4:00 PM fit your school day better?',
        targetTaskIds: ['202'],
        period: 'afternoon',
        reasonForAsking: 'The 2:00 PM task may conflict with school.',
      },
    ],
  }),
});
assert.equal(inventedClockTime.length, 0);


// Q1 regression: even without an instruction ID on the task, title fallback
// must connect the question to the verified instruction and remove "right after".
const rightAfterRepair = normalizeRealityCheckQuestionCandidates({
  tasks: [
    {
      id: 203,
      task_kind: 'medicine',
      title: 'DemoMed Alpha 10 mg',
      schedule_time: '07:30',
      display_time: '7:30 AM',
    },
  ],
  instructions: mealInstructions,
  rawText: JSON.stringify({
    questions: [
      {
        intent: 'meal_routine',
        question: 'Is your breakfast usually finished by 7:30 AM so the first medication can be taken right after?',
        targetTaskIds: ['203'],
        period: 'morning',
        reasonForAsking: 'The instruction is after breakfast and the reminder is 7:30 AM.',
      },
    ],
  }),
});
assert.equal(rightAfterRepair.length, 1);
assert.equal(
  rightAfterRepair[0].question,
  'Is your breakfast usually finished by 7:30 AM so DemoMed Alpha 10 mg can be taken after breakfast?',
);

// Q2 regression: ordinal medicine references are replaced with the actual
// single targeted task title.
const namedTargetQuestion = normalizeRealityCheckQuestionCandidates({
  tasks: [
    {
      id: 204,
      instruction_id: '304',
      task_kind: 'medicine',
      title: 'DemoMed Beta 5 mg',
      schedule_time: '14:00',
      display_time: '2:00 PM',
    },
  ],
  instructions: [
    {
      id: 304,
      category: 'medicine',
      title: 'DemoMed Beta 5 mg',
      instruction: 'Take 1 tablet once daily at exactly 2:00 PM for 7 days.',
      timing: 'exactly 2:00 PM',
    },
  ],
  rawText: JSON.stringify({
    questions: [
      {
        intent: 'school_or_work_conflict',
        question: 'Is your afternoon typically free at exactly 2:00 PM to take the second medication without interruption?',
        targetTaskIds: ['204'],
        period: 'afternoon',
        reasonForAsking: 'The exact 2:00 PM task may overlap with the daytime routine.',
      },
    ],
  }),
});
assert.equal(namedTargetQuestion.length, 1);
assert.match(namedTargetQuestion[0].question, /DemoMed Beta 5 mg/);
assert.doesNotMatch(namedTargetQuestion[0].question, /second medication/i);

// Q3 regression: an open-ended bedtime question is repaired to match the
// deterministic routine_reliability answer profile.
const bedtimeQuestion = normalizeRealityCheckQuestionCandidates({
  tasks: [
    {
      id: 205,
      instruction_id: '305',
      task_kind: 'medicine',
      title: 'DemoMed Gamma 20 mg',
      schedule_time: '22:30',
      display_time: '10:30 PM',
    },
  ],
  instructions: [
    {
      id: 305,
      category: 'medicine',
      title: 'DemoMed Gamma 20 mg',
      instruction: 'Take 1 tablet once daily at bedtime for 7 days.',
      timing: 'at bedtime',
    },
  ],
  rawText: JSON.stringify({
    questions: [
      {
        intent: 'sleep_routine',
        question: 'What time do you usually go to bed and fall asleep?',
        targetTaskIds: ['205'],
        period: 'night',
        reasonForAsking: 'The bedtime routine is needed to check the reminder.',
      },
    ],
  }),
});
assert.equal(bedtimeQuestion.length, 1);
assert.equal(bedtimeQuestion[0].question, 'Is 10:30 PM usually close to your bedtime?');
assert.equal(bedtimeQuestion[0].responseProfile, 'routine_reliability');

// Q5 regression: appointment availability and transport cannot be combined in
// one response. The patient-facing question is narrowed to availability only.
const appointmentQuestion = normalizeRealityCheckQuestionCandidates({
  tasks: [
    {
      id: 206,
      instruction_id: '306',
      task_kind: 'follow_up',
      title: 'Follow-up Visit',
      schedule_date: '2026-09-02',
      schedule_time: '10:00',
      display_time: '10:00 AM',
    },
  ],
  instructions: [
    {
      id: 306,
      category: 'follow_up',
      title: 'Follow-up Visit',
      instruction: '02 September 2026 at 10:00 AM.',
      timing: '10:00 AM',
    },
  ],
  rawText: JSON.stringify({
    questions: [
      {
        intent: 'appointment_availability',
        question: 'Are you available on September 2, 2026, at 10:00 AM for the follow-up visit, and can you arrange transportation if needed?',
        targetTaskIds: ['206'],
        period: 'morning',
        reasonForAsking: 'Appointment availability and transportation need to be checked.',
      },
    ],
  }),
});
assert.equal(appointmentQuestion.length, 1);
assert.equal(
  appointmentQuestion[0].question,
  'Are you available for Follow-up Visit on September 2, 2026 at 10:00 AM?',
);
assert.doesNotMatch(appointmentQuestion[0].question, /transport/i);


console.log('Reality Check Layer 1 validation tests passed.');
