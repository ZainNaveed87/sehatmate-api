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
console.log('Reality Check Layer 1 validation tests passed.');
