/**
 * Bounded per-turn language resolution for Agent replies.
 *
 * patient_profiles.preferred_language is the app/UI/default language. It is
 * not authoritative for every Agent turn because the current user message may
 * be English, Urdu script, or Roman Urdu regardless of the selected UI.
 *
 * This module is deterministic, closed to the three canonical Agent language
 * codes, and never accepts client-provided language authority.
 */

import { cleanText } from '../services/shared_utils.js';
import { canonicalAgentLanguage } from './agent_session_store.js';

export const AGENT_TURN_LANGUAGE_CODES = Object.freeze(['en', 'ur', 'roman_ur']);

const MESSAGE_MAX_CHARS = 2000;
const URDU_SCRIPT_LETTER_PATTERN = /[\u0621-\u063A\u0641-\u064A\u0671-\u06D3\u06FA-\u06FF]/gu;
const LATIN_WORD_PATTERN = /[a-z]+/gi;

const ROMAN_URDU_STRONG_MARKERS = Object.freeze(new Set([
  'mujhe',
  'mujhey',
  'mera',
  'meri',
  'mere',
  'ham',
  'hum',
  'aap',
  'dikhao',
  'dikhana',
  'batao',
  'batana',
  'karo',
  'karna',
  'chahiye',
  'chaheye',
  'khol',
  'kholo',
  'agla',
  'agli',
  'pehla',
  'pehli',
  'doosra',
  'doosri',
  'dusra',
  'dusri',
  'iska',
  'iski',
  'iske',
  'nahi',
  'nahin',
  'mila',
  'mili',
  'mile',
  'haan',
  'han',
  'kya',
  'kesi',
  'kaisi',
  'kyun',
  'kyunke',
  'kaunsa',
  'kaunsi',
  'karein',
  'karain',
  'le',
  'jao',
]));

const ROMAN_URDU_LIGHT_MARKERS = Object.freeze(new Set([
  'ap',
  'hai',
  'hain',
  'ka',
  'ki',
  'ke',
  'ko',
  'mein',
  'wala',
  'wali',
  'se',
  'us',
]));

const ENGLISH_MARKERS = Object.freeze(new Set([
  'show',
  'open',
  'list',
  'tell',
  'explain',
  'what',
  'why',
  'how',
  'when',
  'where',
  'my',
  'your',
  'me',
  'the',
  'care',
  'plan',
  'plans',
  'progress',
  'task',
  'tasks',
  'today',
  'next',
  'first',
  'second',
  'yes',
  'no',
  'cancel',
  'confirm',
  'performance',
  'simulation',
  'settings',
]));

const ROMAN_URDU_PHRASE_PATTERNS = Object.freeze([
  /\bkar\s+do\b/i,
  /\bkhol\s+do\b/i,
  /\bcare\s+plans?\s+dikhao\b/i,
  /\bmere\s+care\s+plans?\b/i,
  /\bmeri\s+performance\b/i,
  /\bmera\s+next\s+task\b/i,
]);

function countUrduScriptLetters(text) {
  return (String(text).match(URDU_SCRIPT_LETTER_PATTERN) || []).length;
}

function latinTokens(text) {
  return (String(text).toLowerCase().match(LATIN_WORD_PATTERN) || [])
    .filter(Boolean);
}

function canonicalFallbackLanguage(language) {
  const canonical = canonicalAgentLanguage(language);
  return AGENT_TURN_LANGUAGE_CODES.includes(canonical) ? canonical : 'en';
}

export function detectAgentTurnLanguage(message) {
  const text = cleanText(message, MESSAGE_MAX_CHARS).normalize('NFKC');
  if (!text) return { language: null, source: 'empty' };

  if (countUrduScriptLetters(text) >= 2) {
    return { language: 'ur', source: 'urdu_script' };
  }

  const tokens = latinTokens(text);
  if (!tokens.length) return { language: null, source: 'ambiguous' };

  let strongCount = 0;
  let lightCount = 0;
  let englishCount = 0;
  for (const token of tokens) {
    if (ROMAN_URDU_STRONG_MARKERS.has(token)) strongCount += 1;
    if (ROMAN_URDU_LIGHT_MARKERS.has(token)) lightCount += 1;
    if (ENGLISH_MARKERS.has(token)) englishCount += 1;
  }

  const phraseCount = ROMAN_URDU_PHRASE_PATTERNS
    .filter((pattern) => pattern.test(text))
    .length;
  const romanScore = (strongCount * 2) + lightCount + (phraseCount * 3);

  if (
    phraseCount > 0 ||
    strongCount >= 2 ||
    romanScore >= 4 ||
    (strongCount >= 1 && tokens.length <= 6 && romanScore >= 2)
  ) {
    return { language: 'roman_ur', source: 'roman_urdu_markers' };
  }

  if (
    englishCount >= 2 ||
    (englishCount >= 1 && tokens.length >= 2) ||
    (tokens.length >= 3 && strongCount === 0 && lightCount === 0)
  ) {
    return { language: 'en', source: 'english_markers' };
  }

  return { language: null, source: 'ambiguous' };
}

export function resolveAgentTurnLanguage({
  message,
  lastTurnLanguage = null,
  profileLanguage = null,
} = {}) {
  const detected = detectAgentTurnLanguage(message);
  if (detected.language) {
    return detected;
  }

  if (lastTurnLanguage) {
    return {
      language: canonicalFallbackLanguage(lastTurnLanguage),
      source: 'last_turn_fallback',
    };
  }

  return {
    language: canonicalFallbackLanguage(profileLanguage),
    source: 'profile_fallback',
  };
}
