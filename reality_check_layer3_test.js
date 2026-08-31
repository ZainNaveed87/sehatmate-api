import assert from 'node:assert/strict';

import {
  actionForRealityIntent,
  dynamicQuestionToDecisionTemplate,
  legacyTemplateToDecisionTemplate,
  riskPointsForRealityAnswer,
  targetTasksForRealityQuestion,
} from './reality_check_decision.js';

const tasks = [
  { id: 11, task_kind: 'medicine', display_time: 'Morning', title: 'Tablet A' },
  { id: 22, task_kind: 'medicine', display_time: 'Afternoon', title: 'Tablet B' },
  { id: 33, task_kind: 'follow_up', display_time: '10:00 AM', title: 'Clinic follow-up' },
];

const dynamic = dynamicQuestionToDecisionTemplate({
  key: 'rq_abc',
  intent: 'school_or_work_conflict',
  category: 'Routine',
  question: 'Your afternoon medicine falls during school hours. Does that usually conflict with your day?',
  responseProfile: 'conflict_reliability',
  targetTaskIds: ['22'],
  period: 'afternoon',
  reasonForAsking: 'The reminder occurs during the user\'s school period.',
});

assert.equal(dynamic.options.length, 3);
assert.equal(dynamic.options[2].points, 15);
assert.equal(dynamic.options[2].action, 'schedule');
assert.deepEqual(targetTasksForRealityQuestion(dynamic, tasks).map((item) => String(item.id)), ['22']);
assert.equal(actionForRealityIntent('medicine_access'), 'care_plan');
assert.equal(riskPointsForRealityAnswer({ selectedAnswer: dynamic.options[1].label, template: dynamic }), 8);
assert.equal(riskPointsForRealityAnswer({ selectedAnswer: '__custom__', note: 'It is usually difficult because of school', template: dynamic }), 15);
assert.equal(riskPointsForRealityAnswer({ selectedAnswer: '__custom__', note: 'I can\'t always access it', template: dynamic }), 15);

const legacy = legacyTemplateToDecisionTemplate({
  key: 'morning_routine',
  category: 'Routine',
  question: 'Morning?',
  options: [{ label: 'Yes', points: 0 }, { label: 'No', points: 15, action: 'schedule' }],
}, tasks);
assert.equal(legacy.intent, 'routine_time');
assert.equal(legacy.period, 'morning');
assert.deepEqual(legacy.targetTaskIds, ['11']);

console.log('Reality Check Layer 3 decision compatibility tests passed.');
