import assert from 'node:assert/strict';
import {
  enrichSimulationFindingsWithContext,
  fallbackAnalysis,
} from './care_context_engine.js';

function enrich(nextAction, extra = {}) {
  const [finding] = enrichSimulationFindingsWithContext(
    [
      {
        key: 'morning_routine',
        recommendation: 'Original recommendation',
        action: 'reality_check',
        canApply: true,
      },
    ],
    [
      {
        sourceId: 'morning_routine',
        signal: 'practical_support',
        summary: 'New practical context is available.',
        nextAction,
        followUpQuestion: '',
        requiresInstructionReview: false,
        ...extra,
      },
    ],
  );
  return finding;
}

assert.equal(enrich('review_schedule').action, 'review_schedule');
assert.equal(enrich('family_care').action, 'family_care');
assert.equal(enrich('documents').action, 'documents');
assert.equal(enrich('calendar').action, 'calendar');
assert.equal(enrich('care_plan').action, 'care_plan');
assert.equal(enrich('reality_check').action, 'reality_check');
assert.equal(enrich('recheck_reality').action, 'reality_check');
assert.equal(
  enrich('review_instruction', { requiresInstructionReview: true }).action,
  'review_instruction',
);

const fallback = fallbackAnalysis({
  note: 'I can manage this better now.',
  professionalAnswers: [],
  preferredLanguage: 'English',
});
assert.equal(fallback.nextAction, 'recheck_reality');

console.log('Care Context navigation tests passed.');
