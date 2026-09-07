/**
 * Pure helpers shared by server.js route handlers and the extracted
 * backend services. These functions were moved verbatim from server.js
 * during the Phase A service extraction so that REST routes and future
 * agent tools share one implementation.
 *
 * Nothing in this module may depend on Express request/response objects
 * or on a database connection.
 */

export const idPattern = /^[1-9]\d*$/;

export function cleanText(value, maxLength) {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, maxLength)
    : '';
}

export function parseStoredJson(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseStoredObject(value) {
  if (value == null || value === '') return {};
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function taskOutcomeDate(value) {
  const text = cleanText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return text;
}

export function strictDateKey(value) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return taskOutcomeDate(text);
}

export function serverDateKey(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function canonicalDailyRecurrence(count) {
  switch (Number(count)) {
    case 1:
      return 'once daily';
    case 2:
      return 'twice daily';
    case 3:
      return 'three times daily';
    case 4:
      return 'four times daily';
    default:
      return `${count} times daily`;
  }
}

export function verifiedDailyRecurrence(value) {
  const text = cleanText(value, 4000)
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!text) return null;

  const numeric = text.match(
    /\b([1-9])\s*(?:x|times?)\s*(?:a|per)?\s*(?:day|daily)\b/i,
  ) || text.match(/\b([1-9])\s*\/\s*day\b/i);
  if (numeric) {
    const count = Number(numeric[1]);
    return { count, recurrence: canonicalDailyRecurrence(count) };
  }

  const wordCounts = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
  };
  const word = text.match(
    /\b(one|two|three|four|five|six|seven|eight|nine)\s+times?\s*(?:a|per)?\s*(?:day|daily)\b/i,
  );
  if (word) {
    const count = wordCounts[word[1].toLowerCase()];
    return { count, recurrence: canonicalDailyRecurrence(count) };
  }

  if (/\bonce\s+(?:(?:a|per)\s+)?(?:day|daily)\b/i.test(text)) {
    return { count: 1, recurrence: 'once daily' };
  }
  if (/\btwice\s+(?:(?:a|per)\s+)?(?:day|daily)\b/i.test(text)) {
    return { count: 2, recurrence: 'twice daily' };
  }
  if (/\bthrice\s+(?:(?:a|per)\s+)?(?:day|daily)\b/i.test(text)) {
    return { count: 3, recurrence: 'three times daily' };
  }

  if (/\b(?:daily|every\s+day|each\s+day|per\s+day)\b/i.test(text)) {
    return { count: null, recurrence: 'daily' };
  }

  return null;
}

export function verifiedDailyRecurrenceText(value) {
  return verifiedDailyRecurrence(value)?.recurrence || '';
}

export function dbDateKey(value) {
  if (!value) return '';

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  const direct = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

export function addDaysToDateKey(dateKey, days) {
  const parsed = taskOutcomeDate(dateKey);
  if (!parsed || !Number.isFinite(Number(days))) return '';
  const date = new Date(`${parsed}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

export function scheduleWindow(displayTime) {
  const label = String(displayTime || '').toLowerCase();
  if (/\bmorning\b/.test(label)) {
    return { start: 4 * 60, end: 11 * 60 + 59, label: 'morning (4:00 AM–11:59 AM)' };
  }
  if (/\bafternoon\b/.test(label)) {
    return { start: 12 * 60, end: 16 * 60 + 59, label: 'afternoon (12:00 PM–4:59 PM)' };
  }
  if (/\b(bedtime|night)\b/.test(label)) {
    return { start: 21 * 60, end: 3 * 60 + 59, label: 'night (9:00 PM–3:59 AM)' };
  }
  if (/\bevening\b/.test(label)) {
    return { start: 17 * 60, end: 20 * 60 + 59, label: 'evening (5:00 PM–8:59 PM)' };
  }
  return null;
}

export function timeFitsScheduleWindow(totalMinutes, window) {
  if (!window) return true;
  if (window.start <= window.end) {
    return totalMinutes >= window.start && totalMinutes <= window.end;
  }
  // Overnight window, e.g. Night 21:00 -> 03:59.
  return totalMinutes >= window.start || totalMinutes <= window.end;
}

export function schedulePeriodKey(displayTime) {
  const label = String(displayTime || '').toLowerCase();
  if (/\b(bedtime|night)\b/.test(label)) return 'night';
  if (/\bmorning\b/.test(label)) return 'morning';
  if (/\bafternoon\b/.test(label)) return 'afternoon';
  if (/\bevening\b/.test(label)) return 'evening';
  return null;
}

export function routineNoteTime(note) {
  const value = String(note || '').trim();
  if (!value) return null;

  const twelveHour = value.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i);
  if (twelveHour) {
    let hour = Number(twelveHour[1]) % 12;
    const minute = Number(twelveHour[2] || 0);
    if (twelveHour[3].toLowerCase() === 'pm') hour += 12;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  const twentyFourHour = value.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (twentyFourHour) {
    return `${String(Number(twentyFourHour[1])).padStart(2, '0')}:${twentyFourHour[2]}`;
  }

  return null;
}
