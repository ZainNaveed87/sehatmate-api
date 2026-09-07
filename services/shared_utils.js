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

const weekdayNames = Object.freeze([
  null,
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]);

const wordNumbers = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
});

export function scheduleItemIsMedicine(item) {
  const category = cleanText(item?.category, 40).toLowerCase();
  const taskKind = cleanText(item?.task_kind || item?.taskKind, 40).toLowerCase();
  return category === 'medicine' ||
    taskKind === 'medicine' ||
    taskKind === 'medication' ||
    taskKind.includes('medicine');
}

export function canonicalRecurrenceMode(value) {
  const mode = cleanText(value, 30).toLowerCase();
  if (mode === 'daily') return 'daily';
  if (mode === 'weekdays') return 'weekdays';
  if (mode === 'interval_days') return 'interval_days';
  if (mode === 'month_days') return 'month_days';
  if (mode === 'one_off') return 'one_off';
  return '';
}

export function normalizeIntegerList(value, minimum, maximum) {
  if (!Array.isArray(value)) return null;
  const output = [];
  const seen = new Set();
  for (const raw of value) {
    const number = Number(raw);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      return null;
    }
    if (!seen.has(number)) {
      seen.add(number);
      output.push(number);
    }
  }
  output.sort((left, right) => left - right);
  return output.length ? output : null;
}

function recurrenceSource(value) {
  return cleanText(value, 20).toLowerCase() === 'user'
    ? 'user'
    : 'verified';
}

function ordinalSuffix(value) {
  const number = Number(value);
  const moduloHundred = number % 100;
  if (moduloHundred >= 11 && moduloHundred <= 13) return 'th';
  switch (number % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

export function recurrenceDisplayText(definition) {
  const mode = canonicalRecurrenceMode(definition?.mode);
  if (mode === 'daily') return 'Every day';
  if (mode === 'weekdays') {
    const weekdays = normalizeIntegerList(definition?.weekdays, 1, 7);
    return weekdays ? weekdays.map((day) => weekdayNames[day]).join(', ') : '';
  }
  if (mode === 'interval_days') {
    const intervalDays = Number(definition?.intervalDays);
    if (!Number.isInteger(intervalDays) || intervalDays <= 0) return '';
    return intervalDays === 1 ? 'Every day' : `Every ${intervalDays} days`;
  }
  if (mode === 'month_days') {
    const monthDays = normalizeIntegerList(definition?.monthDays, 1, 31);
    if (!monthDays) return '';
    const labels = monthDays.map((day) => `${day}${ordinalSuffix(day)}`);
    if (labels.length === 1) return labels[0];
    return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
  }
  if (mode === 'one_off') {
    const date = taskOutcomeDate(definition?.scheduleDate);
    return date ? `Once on ${date}` : '';
  }
  return '';
}

function canonicalRecurrenceDefinition(definition) {
  const mode = canonicalRecurrenceMode(definition?.mode);
  const source = recurrenceSource(definition?.source);
  if (mode === 'daily') {
    return {
      mode,
      source,
      weekdays: [],
      intervalDays: null,
      monthDays: [],
      scheduleDate: null,
      text: cleanText(definition?.text, 160) || recurrenceDisplayText({ mode }),
    };
  }
  if (mode === 'weekdays') {
    const weekdays = normalizeIntegerList(definition?.weekdays, 1, 7);
    if (!weekdays) return null;
    return {
      mode,
      source,
      weekdays,
      intervalDays: null,
      monthDays: [],
      scheduleDate: null,
      text: recurrenceDisplayText({ mode, weekdays }),
    };
  }
  if (mode === 'interval_days') {
    const intervalDays = Number(definition?.intervalDays);
    if (!Number.isInteger(intervalDays) || intervalDays <= 0 || intervalDays > 3650) {
      return null;
    }
    return {
      mode,
      source,
      weekdays: [],
      intervalDays,
      monthDays: [],
      scheduleDate: null,
      text: recurrenceDisplayText({ mode, intervalDays }),
    };
  }
  if (mode === 'month_days') {
    const monthDays = normalizeIntegerList(definition?.monthDays, 1, 31);
    if (!monthDays) return null;
    return {
      mode,
      source,
      weekdays: [],
      intervalDays: null,
      monthDays,
      scheduleDate: null,
      text: recurrenceDisplayText({ mode, monthDays }),
    };
  }
  if (mode === 'one_off') {
    const scheduleDate = taskOutcomeDate(definition?.scheduleDate);
    if (!scheduleDate) return null;
    return {
      mode,
      source,
      weekdays: [],
      intervalDays: null,
      monthDays: [],
      scheduleDate,
      text: recurrenceDisplayText({ mode, scheduleDate }),
    };
  }
  return null;
}

function rowJsonList(value) {
  return parseStoredJson(value).map(Number);
}

export function recurrenceDefinitionFromRow(row) {
  const mode = canonicalRecurrenceMode(row?.recurrence_mode);
  if (mode) {
    const definition = canonicalRecurrenceDefinition({
      mode,
      source: row?.recurrence_source,
      weekdays: rowJsonList(row?.recurrence_weekdays_json),
      intervalDays: row?.recurrence_interval_days,
      monthDays: rowJsonList(row?.recurrence_month_days_json),
      scheduleDate: dbDateKey(row?.schedule_date),
    });
    if (definition) return definition;
  }

  const legacy = recurrenceDefinitionFromText(row?.recurrence_text, {
    source: row?.recurrence_source || 'verified',
  });
  if (legacy) return legacy;

  return null;
}

function normalizeInstructionText(value) {
  return cleanText(value, 4000)
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s+/g, ' ');
}

function weekdayListFromText(text) {
  if (/\bweekdays?\b/i.test(text)) return [1, 2, 3, 4, 5];
  if (/\bweekends?\b/i.test(text)) return [6, 7];

  const matches = [
    [1, /\b(?:mon|monday|mondays)\b/g],
    [2, /\b(?:tue|tues|tuesday|tuesdays)\b/g],
    [3, /\b(?:wed|wednesday|wednesdays)\b/g],
    [4, /\b(?:thu|thur|thurs|thursday|thursdays)\b/g],
    [5, /\b(?:fri|friday|fridays)\b/g],
    [6, /\b(?:sat|saturday|saturdays)\b/g],
    [7, /\b(?:sun|sunday|sundays)\b/g],
  ];
  const days = [];
  for (const [day, regex] of matches) {
    if (regex.test(text)) days.push(day);
  }
  return days.length ? days : null;
}

function numberWordValue(value) {
  const normalized = cleanText(value, 40).toLowerCase();
  if (/^\d+$/.test(normalized)) return Number.parseInt(normalized, 10);
  return wordNumbers[normalized] || null;
}

function intervalDaysFromText(text) {
  const numeric = text.match(/\bevery\s+([1-9]\d{0,3})\s+days?\b/i);
  if (numeric) return Number.parseInt(numeric[1], 10);

  const word = text.match(
    /\bevery\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty)\s+days?\b/i,
  );
  if (word) return numberWordValue(word[1]);

  if (/\bevery\s+other\s+day\b/i.test(text)) return 2;

  return null;
}

function monthDaysFromText(text) {
  if (!/\b(?:monthly|month)\b/i.test(text)) return null;

  const days = [];
  for (const match of text.matchAll(/\b([1-9]|[12]\d|3[01])(?:st|nd|rd|th)\b/gi)) {
    days.push(Number.parseInt(match[1], 10));
  }
  for (const match of text.matchAll(/\bday\s+([1-9]|[12]\d|3[01])\b/gi)) {
    days.push(Number.parseInt(match[1], 10));
  }

  return normalizeIntegerList(days, 1, 31);
}

export function recurrenceDefinitionFromText(value, { source = 'verified' } = {}) {
  const text = normalizeInstructionText(value);
  if (!text) return null;

  const monthDays = monthDaysFromText(text);
  if (monthDays) {
    return canonicalRecurrenceDefinition({
      mode: 'month_days',
      source,
      monthDays,
    });
  }

  const intervalDays = intervalDaysFromText(text);
  if (intervalDays) {
    return canonicalRecurrenceDefinition({
      mode: 'interval_days',
      source,
      intervalDays,
    });
  }

  const weekdays = weekdayListFromText(text);
  if (weekdays) {
    return canonicalRecurrenceDefinition({
      mode: 'weekdays',
      source,
      weekdays,
    });
  }

  const daily = verifiedDailyRecurrence(text);
  if (daily) {
    return canonicalRecurrenceDefinition({
      mode: 'daily',
      source,
      text: daily.recurrence,
    });
  }

  return null;
}

export function recurrenceDefinitionFromInstruction(instruction) {
  return recurrenceDefinitionFromText([
    instruction?.instruction,
    instruction?.timing,
    instruction?.original_instruction,
    instruction?.original_timing,
  ].filter(Boolean).join(' '));
}

export function recurrenceDefinitionEquals(left, right) {
  const canonicalLeft = canonicalRecurrenceDefinition(left);
  const canonicalRight = canonicalRecurrenceDefinition(right);
  if (!canonicalLeft || !canonicalRight) return false;
  return canonicalLeft.mode === canonicalRight.mode &&
    JSON.stringify(canonicalLeft.weekdays) === JSON.stringify(canonicalRight.weekdays) &&
    canonicalLeft.intervalDays === canonicalRight.intervalDays &&
    JSON.stringify(canonicalLeft.monthDays) === JSON.stringify(canonicalRight.monthDays) &&
    canonicalLeft.scheduleDate === canonicalRight.scheduleDate;
}

export function scheduleItemRecurrenceResolved(item) {
  if (recurrenceDefinitionFromRow(item)) return true;
  if (scheduleItemIsMedicine(item)) return false;
  return Boolean(dbDateKey(item?.schedule_date));
}

export function dateKeyWeekday(dateKey) {
  const parsed = taskOutcomeDate(dateKey);
  if (!parsed) return null;
  const day = new Date(`${parsed}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function daysBetweenDateKeys(startDate, endDate) {
  const start = taskOutcomeDate(startDate);
  const end = taskOutcomeDate(endDate);
  if (!start || !end) return null;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  return Math.round((endMs - startMs) / 86400000);
}

export function recurrenceAppliesOnDate(item, dateKey, effectiveStart = '') {
  const date = taskOutcomeDate(dateKey);
  if (!date) return false;

  const definition = recurrenceDefinitionFromRow(item);
  const scheduleDate = dbDateKey(item?.schedule_date);

  if (!definition) {
    if (scheduleItemIsMedicine(item)) return false;
    return Boolean(scheduleDate && date === scheduleDate);
  }

  if (definition.mode === 'one_off') {
    return Boolean(definition.scheduleDate && date === definition.scheduleDate);
  }

  if (definition.mode === 'daily') return true;

  if (definition.mode === 'weekdays') {
    const weekday = dateKeyWeekday(date);
    return weekday != null && definition.weekdays.includes(weekday);
  }

  if (definition.mode === 'interval_days') {
    const anchor = taskOutcomeDate(effectiveStart);
    if (!anchor) return false;
    const distance = daysBetweenDateKeys(anchor, date);
    return distance != null &&
      distance >= 0 &&
      distance % definition.intervalDays === 0;
  }

  if (definition.mode === 'month_days') {
    const day = Number(date.slice(8, 10));
    return definition.monthDays.includes(day);
  }

  return false;
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
