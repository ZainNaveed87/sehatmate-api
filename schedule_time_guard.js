function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function to24Hour(hourText, minuteText, suffixText) {
  let hour = Number(hourText);
  const minute = Number(minuteText || 0);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }

  const suffix = String(suffixText || '')
    .toLowerCase()
    .replace(/[^apm]/g, '');

  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (suffix.startsWith('p') && hour !== 12) hour += 12;
    if (suffix.startsWith('a') && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

function displayClock(time) {
  const match = /^(\d{2}):(\d{2})/.exec(String(time || ''));
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function clockMatches(value) {
  const source = String(value || '');
  const matches = [];

  const twelveHour = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)\b/gi;
  let match;
  while ((match = twelveHour.exec(source)) !== null) {
    const time = to24Hour(match[1], match[2] || '00', match[3]);
    if (!time) continue;
    matches.push({
      time,
      displayTime: displayClock(time),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  const twentyFourHour = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
  while ((match = twentyFourHour.exec(source)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (matches.some((item) => start >= item.start && end <= item.end)) continue;
    const time = to24Hour(match[1], match[2], '');
    if (!time) continue;
    matches.push({
      time,
      displayTime: displayClock(time),
      start,
      end,
    });
  }

  return matches.sort((a, b) => a.start - b.start);
}

function looksLikeTimeRange(value) {
  const text = normalizeSpace(value).toLowerCase();
  return /\b(?:between|from)\b[^.]{0,50}\b(?:and|to|until|through)\b/.test(text);
}

/**
 * Return clock times that are safe to treat as explicit schedule facts.
 *
 * We are intentionally conservative: a clock time in the dedicated `timing`
 * field is accepted unless it looks like a range. In free instruction text,
 * the clock must be introduced by words such as "at" or "exactly". This
 * prevents a broad time window from being silently converted into a fixed
 * medical time.
 */
export function extractVerifiedExactClockTimes(instruction = {}) {
  const candidates = [];
  const seen = new Set();

  const add = (item) => {
    if (!item?.time || seen.has(item.time)) return;
    seen.add(item.time);
    candidates.push({ time: item.time, displayTime: item.displayTime });
  };

  const timingText = normalizeSpace(
    instruction.timing || instruction.original_timing || '',
  );
  if (timingText && !looksLikeTimeRange(timingText)) {
    for (const item of clockMatches(timingText)) add(item);
  }

  const instructionText = normalizeSpace(
    instruction.instruction || instruction.original_instruction || '',
  );
  if (instructionText && !looksLikeTimeRange(instructionText)) {
    for (const item of clockMatches(instructionText)) {
      const prefix = instructionText
        .slice(Math.max(0, item.start - 22), item.start)
        .toLowerCase();
      if (/\b(?:at|exactly)\s*$/.test(prefix) || /\bat\s+exactly\s*$/.test(prefix)) {
        add(item);
      }
    }
  }

  return candidates;
}


export function isVerifiedExactScheduleItemLocked(scheduleItem = {}) {
  const grounding = normalizeSpace(scheduleItem.grounding).toLowerCase();
  const storedTime = normalizeSpace(
    scheduleItem.schedule_time || scheduleItem.scheduleTime || scheduleItem.time,
  );
  if (grounding !== 'explicit' || !storedTime) return false;
  return extractVerifiedExactClockTimes(scheduleItem).length > 0;
}

/**
 * Reconcile AI schedule rows with exact times copied from a verified source.
 * Exact source facts always win over an organisational Morning/Afternoon label.
 */
export function applyVerifiedExactTimesToScheduleItems(
  items,
  instruction,
  expectedDailyCount = null,
) {
  const sourceItems = Array.isArray(items) ? items.map((item) => ({ ...item })) : [];
  if (sourceItems.length === 0) return sourceItems;

  const exactTimes = extractVerifiedExactClockTimes(instruction);
  if (exactTimes.length === 0) return sourceItems;

  const expected = Number(expectedDailyCount);
  const canMapAll = Number.isInteger(expected) && expected > 0 && exactTimes.length === expected;

  if (canMapAll && sourceItems.length < expected) {
    const base = sourceItems[0];
    while (sourceItems.length < expected) sourceItems.push({ ...base });
  }

  const mapCount = canMapAll
    ? expected
    : Math.min(sourceItems.length, exactTimes.length);

  for (let index = 0; index < mapCount; index += 1) {
    const exact = exactTimes[index];
    sourceItems[index] = {
      ...sourceItems[index],
      time: exact.time,
      displayTime: exact.displayTime,
      grounding: 'explicit',
      requiresConfirmation: false,
      reason: `Exact clock time ${exact.displayTime} was copied from the verified instruction and was not changed.`,
    };
  }

  return sourceItems;
}
