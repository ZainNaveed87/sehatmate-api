import assert from 'node:assert/strict';

import {
  buildRealityCheckContextHash,
  buildStableRealityQuestionKey,
} from './reality_check_store.js';

const base = {
  instructions: [
    { id: '10', category: 'medicine', title: 'Medicine A', instruction: 'Take after breakfast', timing: 'after breakfast' },
  ],
  tasks: [
    { id: '42', instructionId: '10', taskKind: 'medicine', title: 'Medicine A', scheduleTime: '08:30:00', displayTime: '8:30 AM' },
  ],
  routineProfile: { learningEnabled: true, notes: { morning: 'Usually up by 7 AM' }, learned: {} },
  knownRealityFacts: [],
};

const hash1 = buildRealityCheckContextHash(base);
const hash2 = buildRealityCheckContextHash({
  ...base,
  instructions: [{ ...base.instructions[0] }],
  tasks: [{ ...base.tasks[0] }],
});
assert.equal(hash1, hash2, 'Equivalent contexts must produce the same hash.');

const changedHash = buildRealityCheckContextHash({
  ...base,
  tasks: [{ ...base.tasks[0], scheduleTime: '10:30:00' }],
});
assert.notEqual(hash1, changedHash, 'A material schedule change must change the context hash.');

const questionA = {
  intent: 'medicine_access',
  responseProfile: 'availability',
  targetTaskIds: ['42'],
  period: 'afternoon',
  question: 'Can you keep this medicine with you during school?',
};
const questionB = {
  ...questionA,
  question: 'Is this medicine normally available to you while you are at school?',
};
assert.equal(
  buildStableRealityQuestionKey(questionA),
  buildStableRealityQuestionKey(questionB),
  'Wording changes must not change the stable practical-concern key.',
);

const differentConcern = {
  ...questionA,
  intent: 'school_or_work_conflict',
};
assert.notEqual(
  buildStableRealityQuestionKey(questionA),
  buildStableRealityQuestionKey(differentConcern),
  'Different practical intents must not share a key.',
);

console.log('Reality Check Layer 2 persistence/versioning tests passed.');

const storeModule = await import('./reality_check_store.js');
assert.equal(storeModule.REALITY_CHECK_GENERATOR_VERSION, 'reality-ai-v3-question-contract');
