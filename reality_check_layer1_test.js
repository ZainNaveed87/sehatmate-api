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
assert.equal(broadenedFoodWording.length, 0);

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
assert.equal(replacementTimeQuestion.length, 0);

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

console.log('Reality Check Layer 1 validation tests passed.');
