import assert from 'node:assert/strict';
import { simulationNavigationForCareGap } from './services/simulation_service.js';

const baseGap = {
  id: 5,
  gap_type: 'practical_fit',
  source_kind: 'reality_check',
  source_id: 'morning_routine',
};

const baseJson = {
  action_type: 'reality_check',
  action_label: 'Review Reality Check',
  target: {
    care_plan_id: '10',
    source_kind: 'reality_check',
    source_id: 'morning_routine',
    care_plan_tab: null,
  },
};

{
  const navigation = simulationNavigationForCareGap({
    gap: baseGap,
    careGapJsonValue: baseJson,
    contextInsights: [
      {
        gapId: '5',
        sourceId: 'morning_routine',
        nextAction: 'review_schedule',
        requiresInstructionReview: false,
      },
    ],
    planId: '10',
  });
  assert.equal(navigation.action, 'review_schedule');
  assert.equal(navigation.actionSource, 'ai_context');
  assert.equal(navigation.target.care_plan_tab, 1);
}

{
  const navigation = simulationNavigationForCareGap({
    gap: { ...baseGap, gap_type: 'verification' },
    careGapJsonValue: {
      ...baseJson,
      action_type: 'review_instruction',
      action_label: 'Review & Verify Instruction',
    },
    contextInsights: [
      {
        gapId: '5',
        sourceId: 'morning_routine',
        nextAction: 'family_care',
        requiresInstructionReview: false,
      },
    ],
    planId: '10',
  });
  assert.equal(navigation.action, 'review_instruction');
  assert.equal(navigation.actionSource, 'gap_rule');
}

{
  const navigation = simulationNavigationForCareGap({
    gap: baseGap,
    careGapJsonValue: baseJson,
    contextInsights: [
      {
        gapId: '5',
        sourceId: 'morning_routine',
        nextAction: '/made/up/route',
        requiresInstructionReview: false,
      },
    ],
    planId: '10',
  });
  assert.equal(navigation.action, 'reality_check');
  assert.equal(navigation.actionSource, 'gap_rule');
}

{
  const navigation = simulationNavigationForCareGap({
    gap: baseGap,
    careGapJsonValue: baseJson,
    contextInsights: [
      {
        gapId: '5',
        sourceId: 'morning_routine',
        nextAction: 'review_schedule',
        requiresInstructionReview: true,
      },
    ],
    planId: '10',
  });
  assert.equal(navigation.action, 'review_instruction');
  assert.equal(navigation.actionSource, 'ai_context');
}

console.log('Simulation navigation service tests passed.');
