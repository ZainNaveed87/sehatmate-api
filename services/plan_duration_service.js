import {
  cleanText,
  idPattern,
  serverDateKey,
  strictDateKey,
} from './shared_utils.js';

const allowedDurationModes = new Set(['prescription', 'custom', 'ongoing']);

export function validatePlanDurationInput({
  planId,
  mode,
  endDate,
  today = null,
  fallbackToday = serverDateKey(),
}) {
  const canonicalPlanId = String(planId || '');
  const canonicalMode = cleanText(mode, 20).toLowerCase();
  if (!idPattern.test(canonicalPlanId) || !allowedDurationModes.has(canonicalMode)) {
    return {
      ok: false,
      message: 'Select a valid plan duration.',
    };
  }

  let localToday;
  if (today == null || today === '') {
    localToday = strictDateKey(fallbackToday) || serverDateKey();
  } else {
    localToday = strictDateKey(today);
    if (!localToday) {
      return {
        ok: false,
        message: 'Select a valid local date.',
      };
    }
  }

  if (canonicalMode === 'ongoing') {
    return {
      ok: true,
      data: {
        planId: canonicalPlanId,
        mode: canonicalMode,
        endDate: null,
        today: localToday,
      },
    };
  }

  const canonicalEndDate = strictDateKey(endDate);
  if (!canonicalEndDate) {
    return {
      ok: false,
      message: 'Select a valid plan end date.',
    };
  }

  if (canonicalEndDate < localToday) {
    return {
      ok: false,
      message: 'Plan end date cannot be in the past.',
    };
  }

  return {
    ok: true,
    data: {
      planId: canonicalPlanId,
      mode: canonicalMode,
      endDate: canonicalEndDate,
      today: localToday,
    },
  };
}
