import assert from 'node:assert/strict';

import {
  dynamicQuestionToDecisionTemplate,
  matchRealityAnswersToTemplates,
  riskPointsForRealityAnswer,
  targetTasksForRealityQuestion,
} from './reality_check_decision.js';

const tasks = [
  { id: 1, title: 'DemoMed Alpha 10 mg', task_kind: 'medicine' },
  { id: 2, title: 'DemoMed Beta 5 mg', task_kind: 'medicine' },
  { id: 3, title: 'DemoMed Gamma 20 mg', task_kind: 'medicine' },
  { id: 4, title: 'Demo Care Exercise', task_kind: 'care_task' },
  { id: 5, title: 'Follow-up Visit', task_kind: 'follow_up' },
];

const questions = [
  {
    key: 'rq_alpha',
    intent: 'meal_routine',
    category: 'Routine',
    question: 'Is your breakfast usually finished by 7:30 AM so you can take DemoMed Alpha 10 mg afterward?',
    responseProfile: 'routine_reliability',
    targetTaskIds: ['1'],
    period: 'morning',
  },
  {
    key: 'rq_beta',
    intent: 'routine_time',
    category: 'Routine',
    question: 'Can you reliably be available at exactly 2:00 PM each day to take DemoMed Beta 5 mg?',
    responseProfile: 'routine_reliability',
    targetTaskIds: ['2'],
    period: 'afternoon',
  },
  {
    key: 'rq_gamma',
    intent: 'sleep_routine',
    category: 'Routine',
    question: 'Do you typically go to bed around 10:30 PM so you can take DemoMed Gamma 20 mg at bedtime?',
    responseProfile: 'routine_reliability',
    targetTaskIds: ['3'],
    period: 'night',
  },
  {
    key: 'rq_exercise',
    intent: 'instruction_feasibility',
    category: 'Routine',
    question: 'Are you usually free and able to perform the 10-minute exercise around 6:30 PM each evening?',
    responseProfile: 'routine_reliability',
    targetTaskIds: ['4'],
    period: 'evening',
  },
  {
    key: 'rq_followup',
    intent: 'appointment_availability',
    category: 'Visits',
    question: 'Are you available to attend the follow-up visit on 02 September 2026 at 10:00 AM?',
    responseProfile: 'availability',
    targetTaskIds: ['5'],
    period: 'morning',
  },
];

const templates = questions.map(dynamicQuestionToDecisionTemplate);

const answers = [
  { question_key: 'rq_alpha', question_text: questions[0].question, selected_answer: 'Yes, reliably', risk_points: 0, note: '' },
  // Simulate an older/stale key while keeping the exact current question text.
  { question_key: 'old_beta_key', question_text: questions[1].question, selected_answer: 'This timing is usually difficult for me', risk_points: 15, note: '' },
  { question_key: 'rq_gamma', question_text: questions[2].question, selected_answer: 'Yes, reliably', risk_points: 0, note: '' },
  { question_key: 'rq_exercise', question_text: questions[3].question, selected_answer: 'Yes, reliably', risk_points: 0, note: '' },
  { question_key: 'rq_followup', question_text: questions[4].question, selected_answer: 'Yes, reliably', risk_points: 0, note: '' },
];

const resolved = matchRealityAnswersToTemplates(answers, templates);
assert.equal(resolved.matches.length, 5);
assert.equal(resolved.unansweredTemplates.length, 0);
assert.equal(resolved.matches.filter((item) => item.matchedBy === 'question_text').length, 1);

const beta = resolved.matches.find((item) => item.template.key === 'rq_beta');
assert.ok(beta);
assert.equal(
  riskPointsForRealityAnswer({
    selectedAnswer: beta.answer.selected_answer,
    note: beta.answer.note,
    template: beta.template,
    storedRiskPoints: beta.answer.risk_points,
  }),
  15,
);
assert.deepEqual(
  targetTasksForRealityQuestion(beta.template, tasks).map((task) => String(task.id)),
  ['2'],
);

console.log('Simulation Reality Check integration tests passed.');
