import assert from 'node:assert/strict';
import {
  applyVerifiedExactTimesToScheduleItems,
  extractVerifiedExactClockTimes,
  isVerifiedExactScheduleItemLocked,
} from './schedule_time_guard.js';

const betaInstruction = {
  instruction: 'Take 1 tablet once daily at exactly 2:00 PM for 7 days.',
  timing: 'exactly 2:00 PM',
};

assert.deepEqual(extractVerifiedExactClockTimes(betaInstruction), [
  { time: '14:00:00', displayTime: '2:00 PM' },
]);

const corrected = applyVerifiedExactTimesToScheduleItems(
  [
    {
      instructionId: '2',
      title: 'DemoMed Beta 5 mg',
      time: null,
      displayTime: 'Morning',
      grounding: 'suggested',
      requiresConfirmation: true,
      reason: 'Reminder slot 1 of 1 was organized from once daily frequency.',
    },
  ],
  betaInstruction,
  1,
);

assert.equal(corrected.length, 1);
assert.equal(corrected[0].time, '14:00:00');
assert.equal(corrected[0].displayTime, '2:00 PM');
assert.equal(corrected[0].grounding, 'explicit');
assert.equal(corrected[0].requiresConfirmation, false);

const bedtime = extractVerifiedExactClockTimes({
  instruction: 'Take 1 tablet once daily at bedtime for 7 days.',
  timing: 'bedtime',
});
assert.deepEqual(bedtime, []);

const range = extractVerifiedExactClockTimes({
  instruction: 'Use between 2:00 PM and 4:00 PM.',
  timing: 'between 2:00 PM and 4:00 PM',
});
assert.deepEqual(range, []);

const appointment = extractVerifiedExactClockTimes({
  instruction: 'Follow-up Visit 02 September 2026 at 10:00 AM.',
  timing: '',
});
assert.deepEqual(appointment, [
  { time: '10:00:00', displayTime: '10:00 AM' },
]);


assert.equal(isVerifiedExactScheduleItemLocked({
  grounding: 'explicit',
  schedule_time: '14:00',
  instruction: betaInstruction.instruction,
  timing: betaInstruction.timing,
}), true);

assert.equal(isVerifiedExactScheduleItemLocked({
  grounding: 'suggested',
  schedule_time: '14:00',
  instruction: betaInstruction.instruction,
  timing: betaInstruction.timing,
}), false);

assert.equal(isVerifiedExactScheduleItemLocked({
  grounding: 'explicit',
  schedule_time: '22:30',
  instruction: 'Take 1 tablet once daily at bedtime.',
  timing: 'bedtime',
}), false);

console.log('Explicit schedule time guard tests passed.');
