import 'dotenv/config';

import bcrypt from 'bcryptjs';
import cors from 'cors';
import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';

import {
  AiServiceError,
  analyzeMedicineLabel,
  aiConfiguration,
  checkIngredientPurpose,
  extractCareInstructions,
  generateGroundedCareSchedule,
  generateAiText,
} from './ai_service.js';

import {
  localizedAiFallbackText,
  readPreferredLanguageForUser,
} from './language_support.js';

import {
  agentRateLimits,
} from './agent/agent_config.js';

import {
  handleAgentMessage,
} from './agent/agent_core.js';

import {
  careGapJson,
  careGapSummary,
  refreshCareGaps,
} from './care_gap_engine.js';

import {
  ensureRoutineLearningSchema,
  readRoutineProfile,
  recordRoutineLearningEvent,
  resetRoutineLearning,
  updateRoutineProfile,
} from './routine_learning.js';

import {
  ensureRealityCheckPersistenceSchema,
} from './reality_check_store.js';

import {
  applyVerifiedExactTimesToScheduleItems,
} from './schedule_time_guard.js';

import {
  analyzeAndStoreCareGapContext,
  ensureCareContextSchema,
} from './care_context_engine.js';

import {
  cleanText,
  dbDateKey,
  idPattern,
  schedulePeriodKey,
  scheduleWindow,
  serverDateKey,
  taskOutcomeDate,
  timeFitsScheduleWindow,
} from './services/shared_utils.js';

import {
  applyTaskOutcome,
  ensureOccurrencesForDate,
  ensureOccurrencesForRange,
  reconcileExpiredFixedDurationOccurrences,
  reconcileMissedOccurrences,
  reconcilePlanLifecycle,
  recordLifecycleEvent,
  taskOccurrenceJson,
} from './services/task_outcome_service.js';

import {
  readRealityCheckState,
  realityDecisionTemplatesForPlan,
  realityQuestionTemplates,
  saveRealityAnswers,
} from './services/reality_answer_service.js';

import {
  confirmScheduleItem,
} from './services/schedule_confirm_service.js';

import {
  carePlanJson,
  inferredSetupStep,
  listCarePlans,
  readCarePlanDetail,
  readPlanLifecycleEvents,
} from './services/plan_query_service.js';

import {
  listCareGaps,
  readCareGapDetail,
  updateCareGapLifecycle,
} from './services/care_gap_service.js';

import {
  formatScheduleTime,
  hasPracticalScheduleConflict,
  readSimulationState,
  scheduleTimeToMinutes,
} from './services/simulation_service.js';

import {
  readTaskOutcomeSummary,
  readTodayTasksState,
} from './services/performance_summary_service.js';

/*
 * HTTP status mapping for structured service results. The services return
 * stable domain error codes; this table (and only this table) decides which
 * HTTP status each code produces, so REST behavior stays identical to the
 * original inline handlers while the services remain transport-agnostic for
 * future agent tools.
 */
const serviceErrorStatusByCode = {
  INVALID_TASK_OUTCOME: 422,
  INVALID_TASK_BASE_STATUS: 422,
  INVALID_REALITY_ANSWERS: 422,
  INVALID_REALITY_ANSWER: 422,
  INVALID_SCHEDULE_ITEM_ID: 422,
  INVALID_SCHEDULE_TIME: 422,
  INVALID_PLAN_ID: 422,
  INVALID_GAP_ID: 422,
  INVALID_CARE_GAP_STATUS: 422,
  TIME_OUTSIDE_PERIOD_WINDOW: 422,
  TASK_OCCURRENCE_NOT_FOUND: 404,
  PLAN_NOT_FOUND: 404,
  SCHEDULE_ITEM_NOT_FOUND: 404,
  GAP_NOT_FOUND: 404,
  PAST_OCCURRENCE_PENDING_CONFLICT: 409,
  TASK_BASE_STATUS_CONFLICT: 409,
  QUESTION_SET_VERSION_CONFLICT: 409,
  SCHEDULE_NOT_GENERATED: 409,
  EXACT_TIME_LOCKED: 409,
  MEDICAL_TIMING_CONFLICT: 409,
  DUPLICATE_REMINDER_TIME: 409,
  DUPLICATE_REMINDER_PERIOD: 409,
  AUTO_MANAGED_GAP_NOT_RESOLVED: 409,
};

function sendServiceError(res, result) {
  const status = serviceErrorStatusByCode[result.code] || 422;
  res.status(status).json({
    success: false,
    message: result.message,
    ...(result.data === undefined ? {} : { data: result.data }),
  });
}

const requiredEnvironment = [
  'DB_HOST',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'JWT_SECRET',
  'GOOGLE_CLIENT_ID',
];

const missingEnvironment = requiredEnvironment.filter(
  (key) => !process.env[key]?.trim(),
);

if (missingEnvironment.length > 0) {
  console.error(
    `Missing environment variables: ${missingEnvironment.join(', ')}`,
  );
  process.exit(1);
}

if (process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must contain at least 32 characters.');
  process.exit(1);
}

const app = express();
const port = Number(process.env.PORT || 3000);

const allowedOrigins = (process.env.CLIENT_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  charset: 'utf8mb4',
  enableKeepAlive: true,
});

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet());

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Origin is not allowed by CORS.'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.use(express.json({ limit: '28mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many attempts. Please try again later.',
  },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many document uploads. Please try again later.',
  },
});

const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many AI requests. Please try again later.',
  },
});

/*
 * Conversational Agent rate limiter, separate from aiLimiter (which guards
 * heavier one-shot AI operations). Values come from agent/agent_config.js so
 * they stay environment-tunable with safe defaults; the existing authLimiter,
 * uploadLimiter and aiLimiter are not weakened or changed.
 */
const agentRateLimitSettings = agentRateLimits();
const agentLimiter = rateLimit({
  windowMs: agentRateLimitSettings.windowMs,
  limit: agentRateLimitSettings.limit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many agent requests. Please try again later.',
  },
});

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ageGroups = new Set([
  'Under 18',
  '18 – 30',
  '31 – 45',
  '46 – 59',
  '60 – 70',
  '71 – 80',
  '81+',
]);
const languages = new Set(['English', 'Urdu', 'Roman Urdu']);
const accessibilityModes = new Set([
  'Standard',
  'Large Text',
  'Voice Guidance',
  'Simple Care Mode',
]);
const carePlanStatuses = new Set([
  'draft',
  'processing',
  'needs_review',
  'reality_check',
  'needs_attention',
  'active',
  'completed',
]);
const careSetupSteps = new Set([
  'upload',
  'review',
  'schedule',
  'reality_check',
  'simulation',
  'care_gaps',
  'activate',
  'complete',
]);

const documentTypes = new Set([
  'prescription',
  'discharge',
  'followup',
  'lab',
  'other',
]);
const allowedDocumentMimeTypes = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);
const maximumDocumentBytes = 20 * 1024 * 1024;
const instructionCategories = new Set([
  'medicine',
  'follow_up',
  'lab_test',
  'care_task',
  'other',
]);
const allowedStatusTransitions = {
  draft: new Set(['processing']),
  processing: new Set(['needs_review']),
  needs_review: new Set(['reality_check']),
  reality_check: new Set(['needs_attention', 'active']),
  needs_attention: new Set(['active']),
  active: new Set(['completed']),
  completed: new Set(['active']),
};

function publicUser(row) {
  return {
    id: String(row.id),
    name: row.name,
    email: row.email,
  };
}

function createToken(user) {
  return jwt.sign(
    {
      email: user.email,
    },
    process.env.JWT_SECRET,
    {
      subject: String(user.id),
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
      issuer: 'sehatroute-api',
      audience: 'sehatroute-app',
    },
  );
}

function validateRegistration(body) {
  const name =
    typeof body.name === 'string'
      ? body.name.trim().replace(/\s+/g, ' ')
      : '';

  const email =
    typeof body.email === 'string'
      ? body.email.trim().toLowerCase()
      : '';

  const password = typeof body.password === 'string' ? body.password : '';

  if (name.length < 2 || name.length > 80) {
    return {
      error: 'Name must contain 2 to 80 characters.',
    };
  }

  if (!emailPattern.test(email) || email.length > 191) {
    return {
      error: 'Enter a valid email address.',
    };
  }

  if (password.length < 8 || password.length > 72) {
    return {
      error: 'Password must contain 8 to 72 characters.',
    };
  }

  return {
    value: {
      name,
      email,
      password,
    },
  };
}

function validateLogin(body) {
  const email =
    typeof body.email === 'string'
      ? body.email.trim().toLowerCase()
      : '';

  const password = typeof body.password === 'string' ? body.password : '';

  if (!emailPattern.test(email) || password.length === 0) {
    return {
      error: 'Enter a valid email and password.',
    };
  }

  return {
    value: {
      email,
      password,
    },
  };
}

function validateGoogleName(name, email) {
  const cleanedName =
    typeof name === 'string'
      ? name.trim().replace(/\s+/g, ' ').slice(0, 80)
      : '';

  if (cleanedName.length >= 2) {
    return cleanedName;
  }

  const emailName = email
    .split('@')[0]
    .replace(/[._-]+/g, ' ')
    .trim()
    .slice(0, 80);

  if (emailName.length >= 2) {
    return emailName;
  }

  return 'Google User';
}

function validateProfile(body) {
  const usingFor = cleanText(body.usingFor, 40);
  const patientName = cleanText(body.patientName, 80);
  const ageGroup = cleanText(body.ageGroup, 20);
  const city = cleanText(body.city, 100);
  const preferredLanguage = cleanText(body.preferredLanguage, 30);
  const accessibilityMode = cleanText(body.accessibilityMode, 40);
  const caregiverSupport = body.caregiverSupport === true;

  if (!['Myself', 'Someone I care for'].includes(usingFor)) {
    return { error: 'Select who this care plan is for.' };
  }
  if (patientName.length < 2) {
    return { error: 'Patient name must contain at least 2 characters.' };
  }
  if (!ageGroups.has(ageGroup)) {
    return { error: 'Select a valid age group.' };
  }
  if (city.length < 2) {
    return { error: 'City must contain at least 2 characters.' };
  }
  if (!languages.has(preferredLanguage)) {
    return { error: 'Select a valid preferred language.' };
  }
  if (!accessibilityModes.has(accessibilityMode)) {
    return { error: 'Select a valid accessibility mode.' };
  }

  return {
    value: {
      usingFor,
      patientName,
      ageGroup,
      city,
      preferredLanguage,
      accessibilityMode,
      caregiverSupport,
    },
  };
}

function profileJson(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    usingFor: row.using_for,
    patientName: row.patient_name,
    ageGroup: row.age_group,
    city: row.city,
    preferredLanguage: row.preferred_language,
    accessibilityMode: row.accessibility_mode,
    caregiverSupport: Boolean(row.caregiver_support),
    onboardingCompleted: Boolean(row.onboarding_completed),
  };
}

function instructionDurationDays(value) {
  const text = String(value || '');
  const candidates = [];
  for (const match of text.matchAll(/\b(\d{1,3})\s*days?\b/gi)) {
    candidates.push(Number(match[1]));
  }
  for (const match of text.matchAll(/\b(\d{1,2})\s*weeks?\b/gi)) {
    candidates.push(Number(match[1]) * 7);
  }
  const valid = candidates.filter((days) => Number.isInteger(days) && days > 0 && days <= 3650);
  return valid.length ? Math.max(...valid) : null;
}

function medicineFingerprint(title, instruction, timing) {
  const normalize = (value) => String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [normalize(title), normalize(instruction), normalize(timing)].join('|');
}

function safeDocumentName(value) {
  const cleaned = typeof value === 'string'
    ? value.replace(/\\/g, '/').split('/').pop().trim()
    : '';
  return cleaned.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255);
}

function validDocumentSignature(buffer, mimeType) {
  if (mimeType === 'application/pdf') {
    return buffer.length >= 5 && buffer.subarray(0, 5).toString() === '%PDF-';
  }
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 &&
      buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(pngSignature);
  }
  return false;
}

function parseAiInstructions(text, preferredLanguage) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let value;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw new AiServiceError('AI could not return readable structured instructions. Please retry.', 502);
  }

  if (!value || !Array.isArray(value.instructions)) {
    throw new AiServiceError('AI returned an invalid instruction list. Please retry.', 502);
  }

  const instructions = value.instructions.slice(0, 40).map((item) => {
    const category = cleanText(item?.category, 40).toLowerCase();
    const title = cleanText(item?.title, 160);
    const instruction = cleanText(item?.instruction, 4000);
    const timing = cleanText(item?.timing, 160);
    const sourcePage = cleanText(item?.sourcePage, 80);
    const confidence = Number(item?.confidenceScore);
    const requestedStatus = cleanText(item?.reviewStatus, 20).toLowerCase();
    const requiresProfessionalConfirmation = Boolean(item?.requiresProfessionalConfirmation);
    const ambiguityReason = cleanText(item?.ambiguityReason, 2000);
    const possibleInterpretation = cleanText(item?.possibleInterpretation, 2000);
    const safetyNote = cleanText(item?.safetyNote, 1000);

    if (!title || !instruction) return null;
    const confidenceScore = Number.isFinite(confidence)
      ? Math.max(0, Math.min(100, Math.round(confidence)))
      : null;
    const reviewStatus = requestedStatus === 'unclear' ||
      requiresProfessionalConfirmation ||
      !timing || confidenceScore == null || confidenceScore < 70
      ? 'unclear'
      : 'pending';

    const parsed = {
      category: instructionCategories.has(category) ? category : 'other',
      title,
      instruction,
      timing: timing || null,
      sourcePage: sourcePage || null,
      confidenceScore,
      reviewStatus,
      requiresProfessionalConfirmation: reviewStatus === 'unclear' || requiresProfessionalConfirmation,
      ambiguityReason: ambiguityReason || null,
      possibleInterpretation: possibleInterpretation || null,
      safetyNote: safetyNote || null,
    };

    // Deterministic guardrail for common prescription notation ambiguity.
    // The rule only flags the text; it never calculates or changes a dose.
    const slashDoseFrequency = /\b\d+(?:\.\d+)?\s*(?:mcg|mg|g|ml|iu|units?)\s*\/\s*\d+\s*(?:x|times?|daily|day)\b/i;
    if (parsed.category === 'medicine' && slashDoseFrequency.test(`${parsed.instruction} ${parsed.timing || ''}`)) {
      parsed.reviewStatus = 'unclear';
      parsed.requiresProfessionalConfirmation = true;
      parsed.ambiguityReason = parsed.ambiguityReason ||
        localizedAiFallbackText(
          'slashDoseFrequencyAmbiguity',
          preferredLanguage,
        );
      parsed.possibleInterpretation = parsed.possibleInterpretation ||
        localizedAiFallbackText(
          'slashDoseFrequencyInterpretation',
          preferredLanguage,
        );
      parsed.safetyNote = parsed.safetyNote ||
        localizedAiFallbackText(
          'slashDoseFrequencySafety',
          preferredLanguage,
        );
    }

    return parsed;
  }).filter(Boolean);

  const merged = [];
  const genericDurationTitle = /^(duration(?:\s+of\s+(?:treatment|course))?|treatment\s+duration|course\s+duration|treatment\s+period|how\s+long)$/i;

  for (const current of instructions) {
    const durationOnly = genericDurationTitle.test(current.title.trim()) &&
      (current.category === 'medicine' || current.category === 'other');

    if (durationOnly) {
      const medicineCandidates = instructions.filter((candidate) =>
        candidate !== current &&
        candidate.category === 'medicine' &&
        (!current.sourcePage || !candidate.sourcePage || candidate.sourcePage === current.sourcePage),
      );

      // Only merge when the document makes the parent medicine unambiguous.
      if (medicineCandidates.length === 1) {
        const medicine = medicineCandidates[0];
        const durationText = [current.instruction, current.timing]
          .filter(Boolean)
          .join(' · ')
          .replace(/^duration\s*:\s*/i, '')
          .trim();
        if (durationText && !medicine.instruction.toLowerCase().includes(durationText.toLowerCase())) {
          medicine.instruction = `${medicine.instruction} · Duration: ${durationText}`;
        }
        medicine.confidenceScore = medicine.confidenceScore == null
          ? current.confidenceScore
          : current.confidenceScore == null
            ? medicine.confidenceScore
            : Math.min(medicine.confidenceScore, current.confidenceScore);
        const durationIsActuallyAmbiguous = Boolean(
          current.ambiguityReason ||
          current.possibleInterpretation ||
          current.safetyNote,
        );
        if (medicine.reviewStatus === 'unclear' || durationIsActuallyAmbiguous) {
          medicine.reviewStatus = 'unclear';
          medicine.requiresProfessionalConfirmation = true;
        }
        medicine.ambiguityReason = [medicine.ambiguityReason, current.ambiguityReason]
          .filter(Boolean)
          .join(' ')
          .slice(0, 2000) || null;
        medicine.possibleInterpretation = [medicine.possibleInterpretation, current.possibleInterpretation]
          .filter(Boolean)
          .join(' ')
          .slice(0, 2000) || null;
        medicine.safetyNote = [medicine.safetyNote, current.safetyNote]
          .filter(Boolean)
          .join(' ')
          .slice(0, 1000) || null;
        continue;
      }
    }

    merged.push(current);
  }

  return merged;
}

function parseSafetyCheck(text, citations, preferredLanguage) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let value;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw new AiServiceError('AI could not return a readable safety check. Please retry.', 502);
  }

  const sources = Array.isArray(citations) ? citations.slice(0, 5) : [];
  const requestedStatus = cleanText(value?.status, 30).toLowerCase();
  const allowedStatuses = new Set(['no_issue_found', 'needs_confirmation', 'source_not_found']);
  const hasSources = sources.length > 0;
  const status = hasSources && allowedStatuses.has(requestedStatus)
    ? requestedStatus
    : 'source_not_found';

  return {
    status,
    summary: hasSources
      ? cleanText(value?.summary, 2500)
      : localizedAiFallbackText(
          'safetyNoTrustedSource',
          preferredLanguage,
        ),
    possibleInterpretation: hasSources
      ? cleanText(value?.possibleInterpretation, 2000)
      : null,
    questionForProfessional: cleanText(value?.questionForProfessional, 1000) ||
      localizedAiFallbackText(
        'safetyConfirmExactInstruction',
        preferredLanguage,
      ),
    sources,
  };
}

function parseJsonObject(text, errorMessage) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const value = JSON.parse(cleaned);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // The public error below intentionally hides provider output.
  }
  throw new AiServiceError(errorMessage, 502);
}

function parseCareSchedule(text, allowedInstructionIds) {
  const value = parseJsonObject(text, 'AI could not return a valid care schedule. Please retry.');
  const allowedKinds = new Set(['medicine', 'lab_test', 'follow_up', 'care_task', 'other']);
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  const items = Array.isArray(value.items) ? value.items : [];
  return items.slice(0, 40).map((item) => {
    const instructionId = cleanText(item?.instructionId, 30);
    if (!allowedInstructionIds.has(instructionId)) return null;
    const title = cleanText(item?.title, 160);
    if (!title) return null;
    const taskKind = cleanText(item?.taskKind, 30).toLowerCase();
    const grounding = cleanText(item?.grounding, 20).toLowerCase() === 'explicit'
      ? 'explicit'
      : 'suggested';
    const date = cleanText(item?.date, 10);
    const time = cleanText(item?.time, 5);
    const requiresConfirmation = grounding !== 'explicit' || Boolean(item?.requiresConfirmation);
    return {
      instructionId,
      title,
      taskKind: allowedKinds.has(taskKind) ? taskKind : 'other',
      date: datePattern.test(date) ? date : null,
      time: grounding === 'explicit' && timePattern.test(time) ? `${time}:00` : null,
      displayTime: cleanText(item?.displayTime, 160) || null,
      recurrence: cleanText(item?.recurrence, 160) || null,
      grounding,
      requiresConfirmation,
      reason: cleanText(item?.reason, 500) || null,
    };
  }).filter(Boolean);
}


function normalizedInstructionScheduleKey(instruction) {
  const normalize = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  return [
    normalize(instruction?.category),
    normalize(instruction?.title),
    normalize(instruction?.instruction),
    normalize(instruction?.timing),
  ].join('|');
}

function explicitDailyFrequencyCount(instruction) {
  const value = `${instruction?.instruction || ''} ${instruction?.timing || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ');

  const numeric = value.match(
    /\b([1-9])\s*(?:x|times?)\s*(?:a|per)?\s*(?:day|daily)\b/i,
  );
  if (numeric) return Number(numeric[1]);

  if (/\bonce\s+(?:a\s+)?(?:day|daily)\b/i.test(value)) return 1;
  if (/\btwice\s+(?:a\s+)?(?:day|daily)\b/i.test(value)) return 2;
  if (/\bthrice\s+(?:a\s+)?(?:day|daily)\b/i.test(value)) return 3;

  return null;
}


function defaultFrequencyPeriods(count) {
  switch (Number(count)) {
    case 1:
      return ['morning'];
    case 2:
      return ['morning', 'evening'];
    case 3:
      return ['morning', 'afternoon', 'evening'];
    case 4:
      return ['morning', 'afternoon', 'evening', 'night'];
    default:
      return [];
  }
}

function periodDisplayLabel(period) {
  switch (period) {
    case 'morning':
      return 'Morning';
    case 'afternoon':
      return 'Afternoon';
    case 'evening':
      return 'Evening';
    case 'night':
      return 'Night';
    default:
      return '';
  }
}

function explicitPeriodsFromInstruction(instruction) {
  const value = `${instruction?.instruction || ''} ${instruction?.timing || ''}`
    .toLowerCase();

  const periods = [];
  for (const period of ['morning', 'afternoon', 'evening', 'night']) {
    if (new RegExp(`\\b${period}\\b`, 'i').test(value)) {
      periods.push(period);
    }
  }
  return periods;
}

function normalizeCareScheduleForInstructions(
  schedule,
  instructions,
  preferredLanguage,
) {
  const instructionById = new Map(
    instructions.map((instruction) => [String(instruction.id), instruction]),
  );

  // Exact duplicate verified instructions can otherwise make the AI build the
  // same reminder set twice. Keep the first verified instruction as canonical
  // for scheduling only; the review/source records themselves are untouched.
  const canonicalByInstructionId = new Map();
  const canonicalByContent = new Map();
  for (const instruction of instructions) {
    const id = String(instruction.id);
    const key = normalizedInstructionScheduleKey(instruction);
    if (key && canonicalByContent.has(key)) {
      canonicalByInstructionId.set(id, canonicalByContent.get(key));
    } else {
      canonicalByContent.set(key, id);
      canonicalByInstructionId.set(id, id);
    }
  }

  const rewritten = schedule.map((item) => ({
    ...item,
    instructionId:
      canonicalByInstructionId.get(String(item.instructionId)) ||
      String(item.instructionId),
  }));

  // First remove literal/logical duplicate reminder slots.
  const deduped = [];
  const seen = new Set();
  for (const item of rewritten) {
    const period =
      schedulePeriodKey(`${item.displayTime || ''} ${item.recurrence || ''}`) ||
      '';
    const exactTime = String(item.time || '').slice(0, 5);
    const logicalSlot = period || exactTime || String(item.displayTime || '').toLowerCase();
    const key = [
      item.instructionId,
      item.date || '',
      logicalSlot,
      exactTime,
    ].join('|');

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  // Then enforce an explicit plain-language daily frequency such as
  // "3 times daily". AI is not allowed to turn that into 6 reminder slots.
  const grouped = new Map();
  for (const item of deduped) {
    if (!grouped.has(item.instructionId)) grouped.set(item.instructionId, []);
    grouped.get(item.instructionId).push(item);
  }

  const output = [];
  for (const [instructionId, items] of grouped.entries()) {
    const instruction = instructionById.get(instructionId);
    const expectedCount = explicitDailyFrequencyCount(instruction);
    const guardedItems = applyVerifiedExactTimesToScheduleItems(
      items,
      instruction,
      expectedCount,
    );

    if (!expectedCount) {
      output.push(...guardedItems);
      continue;
    }

    const hasVerifiedExactTime = guardedItems.some(
      (item) => item.grounding === 'explicit' && Boolean(item.time),
    );

    const currentPeriods = guardedItems
      .map((item) =>
        schedulePeriodKey(`${item.displayTime || ''} ${item.recurrence || ''}`),
      )
      .filter(Boolean);
    const distinctCurrentPeriods = [...new Set(currentPeriods)];
    const explicitPeriods = explicitPeriodsFromInstruction(instruction);
    const defaultPeriods = defaultFrequencyPeriods(expectedCount);

    // When the verified instruction clearly gives only a frequency such as
    // "3 times daily", period labels returned by AI are organizational
    // suggestions, not medical facts. If AI repeats one period (e.g. three
    // Afternoons), normalize the reminder slots to distinct periods so the
    // user can confirm one exact time for each slot.
    const shouldNormalizePeriods =
      !hasVerifiedExactTime &&
      defaultPeriods.length === expectedCount &&
      distinctCurrentPeriods.length < expectedCount;

    if (shouldNormalizePeriods) {
      const desiredPeriods = [];
      for (const period of explicitPeriods) {
        if (!desiredPeriods.includes(period)) desiredPeriods.push(period);
        if (desiredPeriods.length === expectedCount) break;
      }
      for (const period of defaultPeriods) {
        if (!desiredPeriods.includes(period)) desiredPeriods.push(period);
        if (desiredPeriods.length === expectedCount) break;
      }

      const base = guardedItems[0];
      if (!base) continue;

      for (let index = 0; index < expectedCount; index += 1) {
        const source = guardedItems[index] || base;
        const period = desiredPeriods[index] || defaultPeriods[index];
        const label = periodDisplayLabel(period);
        const frequency =
          source.recurrence ||
          base.recurrence ||
          `${expectedCount} times daily`;

        output.push({
          ...source,
          instructionId,
          date: base.date || source.date || null,
          time: null,
          displayTime: label,
          recurrence: frequency,
          grounding: 'suggested',
          requiresConfirmation: true,
          reason: localizedAiFallbackText(
            'scheduleSlotReason',
            preferredLanguage,
            {
              index: index + 1,
              expectedCount,
              frequency,
              label,
            },
          ),
        });
      }
      continue;
    }

    // If AI returned too many rows but the periods are already sensible, keep
    // only the number required by the verified daily frequency.
    if (guardedItems.length > expectedCount) {
      output.push(...guardedItems.slice(0, expectedCount));
      continue;
    }

    // If AI returned too few rows for a plain verified frequency, create the
    // missing reminder slots as confirmable organizational periods.
    if (
      guardedItems.length < expectedCount &&
      defaultPeriods.length === expectedCount
    ) {
      const base = guardedItems[0];
      if (!base) continue;

      for (let index = 0; index < expectedCount; index += 1) {
        const source = guardedItems[index] || base;
        const period = defaultPeriods[index];
        const label = periodDisplayLabel(period);
        const frequency =
          source.recurrence ||
          base.recurrence ||
          `${expectedCount} times daily`;

        output.push({
          ...source,
          instructionId,
          date: base.date || source.date || null,
          time: null,
          displayTime: label,
          recurrence: frequency,
          grounding: 'suggested',
          requiresConfirmation: true,
          reason: localizedAiFallbackText(
            'scheduleSlotReason',
            preferredLanguage,
            {
              index: index + 1,
              expectedCount,
              frequency,
              label,
            },
          ),
        });
      }
      continue;
    }

    output.push(...guardedItems);
  }

  return output;
}

function minutesToScheduleTime(totalMinutes) {
  const normalized = ((Number(totalMinutes) % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function taskMatchesRealityQuestion(task, questionKey) {
  const period = schedulePeriodKey(`${task.display_time || ''} ${task.recurrence_text || ''}`);
  if (questionKey === 'morning_routine') return period === 'morning';
  if (questionKey === 'daytime_access') return period === 'afternoon';
  if (questionKey === 'evening_routine') return period === 'evening' || period === 'night';
  return false;
}

function parseIngredientLabel(text, preferredLanguage) {
  const value = parseJsonObject(
    text,
    'AI could not read a structured ingredient label. Please use a clearer photo.',
  );
  const activeIngredients = Array.isArray(value.activeIngredients)
    ? value.activeIngredients
        .slice(0, 8)
        .map((item) => ({
          name: cleanText(item?.name, 160),
          strength: cleanText(item?.strength, 80),
        }))
        .filter((item) => item.name)
    : [];
  const confidence = Number(value.confidenceScore);
  return {
    brandName: cleanText(value.brandName, 160) || null,
    activeIngredients,
    dosageForm: cleanText(value.dosageForm, 80) || null,
    manufacturer: cleanText(value.manufacturer, 160) || null,
    confidenceScore: Number.isFinite(confidence)
      ? Math.max(0, Math.min(100, Math.round(confidence)))
      : null,
    labelNeedsConfirmation: Boolean(value.labelNeedsConfirmation) || activeIngredients.length === 0,
    labelNote: cleanText(value.labelNote, 800) ||
      (activeIngredients.length === 0
        ? localizedAiFallbackText(
            'noActiveIngredientReadable',
            preferredLanguage,
          )
        : localizedAiFallbackText(
            'confirmLabelAgainstPackage',
            preferredLanguage,
          )),
  };
}

function parsePurposeCheck(text, citations, preferredLanguage) {
  const value = parseJsonObject(
    text,
    'AI could not complete the ingredient-purpose comparison.',
  );
  const requestedStatus = cleanText(value.status, 40).toLowerCase();
  const allowedStatuses = new Set([
    'broadly_consistent',
    'purpose_not_stated',
    'needs_confirmation',
  ]);
  const sources = Array.isArray(citations) ? citations.slice(0, 6) : [];
  const status = allowedStatuses.has(requestedStatus)
    ? requestedStatus
    : 'needs_confirmation';
  return {
    status: status === 'broadly_consistent' && sources.length === 0
      ? 'needs_confirmation'
      : status,
    summary: cleanText(value.summary, 1000) ||
      localizedAiFallbackText(
        'ingredientPurposeUnreliable',
        preferredLanguage,
      ),
    questionForProfessional: cleanText(value.questionForProfessional, 800) ||
      localizedAiFallbackText(
        'confirmIntendedMedicine',
        preferredLanguage,
      ),
    sources,
  };
}

function trustedSourceFallback(instruction, reason = 'automatic lookup unavailable') {
  const title = cleanText(instruction?.title, 160) || 'care instruction';
  const category = cleanText(instruction?.category, 40).toLowerCase();

  const sources = category === 'medicine'
    // Do not show generic medicine sites as if they were evidence for a
    // handwritten name. Medicine links must point to a returned, real record.
    ? []
    : category === 'lab_test'
      ? [
          {
            title: 'MedlinePlus Medical Tests',
            url: 'https://medlineplus.gov/lab-tests/',
          },
          {
            title: 'NHS Health A to Z',
            url: 'https://www.nhs.uk/conditions/',
          },
        ]
      : [
          {
            title: 'MedlinePlus Health Topics',
            url: 'https://medlineplus.gov/healthtopics.html',
          },
          {
            title: 'NHS Health A to Z',
            url: 'https://www.nhs.uk/conditions/',
          },
        ];

  return {
    status: 'source_not_found',
    summary:
      `Trusted databases could not verify ${title} because ${reason}. This result does not confirm or reject the instruction.`,
    possibleInterpretation: null,
    questionForProfessional:
      `Please confirm the exact name, amount, timing, frequency, route and duration for ${title}.`,
    sources,
  };
}

function medicineLookupTerm(value) {
  return cleanText(value, 160)
    .replace(/\b\d+(?:\.\d+)?\s*(?:mcg|micrograms?|mg|milligrams?|g|grams?|ml|millilit(?:er|re)s?|iu|units?)\b/gi, ' ')
    .replace(/\b(?:tablets?|capsules?|syrups?|suspensions?|injections?|drops?|cream|ointment)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceTitle(value, limit = 180) {
  return cleanText(value, limit).replace(/[\r\n]+/g, ' ').trim();
}

function rxNormRecordUrl(rxcui) {
  return `https://rxnav.nlm.nih.gov/REST/rxcui/${encodeURIComponent(rxcui)}/properties.json`;
}

function dailyMedLabelUrl(setId) {
  return `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${encodeURIComponent(setId)}`;
}

function openFdaRecordUrl(setId) {
  const query = encodeURIComponent(`openfda.spl_set_id:"${setId}"`);
  return `https://api.fda.gov/drug/label.json?search=${query}&limit=1`;
}

async function fetchTrustedJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Trusted source returned HTTP ${response.status}.`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function trustedSourceCheck(instruction) {
  const category = cleanText(instruction?.category, 40).toLowerCase();
  if (category !== 'medicine') {
    return trustedSourceFallback(
      instruction,
      'this instruction type cannot be safely verified by a medicine-name database',
    );
  }

  const originalTitle = cleanText(instruction?.title, 160) || 'medicine';
  const lookupTerm = medicineLookupTerm(originalTitle) || originalTitle;
  const encodedTerm = encodeURIComponent(lookupTerm);
  const rxNormApiUrl = `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodedTerm}&search=2`;
  const approximateApiUrl = `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodedTerm}&maxEntries=6&option=1`;
  const dailyMedApiUrl = `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?drug_name=${encodedTerm}&pagesize=5&page=1`;
  const openFdaSearch = encodeURIComponent(`openfda.brand_name:"${lookupTerm}" OR openfda.generic_name:"${lookupTerm}"`);
  const openFdaApiUrl = `https://api.fda.gov/drug/label.json?search=${openFdaSearch}&limit=3`;

  const [rxNormResult, dailyMedResult, openFdaResult] = await Promise.allSettled([
    fetchTrustedJson(rxNormApiUrl),
    fetchTrustedJson(dailyMedApiUrl),
    fetchTrustedJson(openFdaApiUrl),
  ]);

  const rxNormIds = rxNormResult.status === 'fulfilled' && Array.isArray(rxNormResult.value?.idGroup?.rxnormId)
    ? rxNormResult.value.idGroup.rxnormId.map((id) => cleanText(id, 40)).filter(Boolean).slice(0, 3)
    : [];
  const dailyMedLabels = dailyMedResult.status === 'fulfilled' && Array.isArray(dailyMedResult.value?.data)
    ? dailyMedResult.value.data
        .map((item) => ({
          name: sourceTitle(item?.title || item?.drug_name || item?.name, 200),
          setId: cleanText(item?.setid || item?.set_id, 100),
        }))
        .filter((item) => item.name && item.setId)
        .slice(0, 3)
    : [];
  const openFdaLabels = openFdaResult.status === 'fulfilled' && Array.isArray(openFdaResult.value?.results)
    ? openFdaResult.value.results
        .map((item) => ({
          name: sourceTitle(
            item?.openfda?.brand_name?.[0] ||
            item?.openfda?.generic_name?.[0] ||
            item?.openfda?.substance_name?.[0],
            200,
          ),
          setId: cleanText(item?.openfda?.spl_set_id?.[0] || item?.set_id, 100),
        }))
        .filter((item) => item.name && item.setId)
        .filter((item, index, all) => all.findIndex((candidate) => candidate.setId === item.setId) === index)
        .slice(0, 3)
    : [];
  const sourceReached = rxNormResult.status === 'fulfilled' ||
    dailyMedResult.status === 'fulfilled' ||
    openFdaResult.status === 'fulfilled';
  if (!sourceReached) {
    return trustedSourceFallback(instruction, 'the official medicine databases could not be reached');
  }

  // An exact/normalised RxNorm ID still needs its official display name before
  // it can be shown to the user. Never manufacture a name from handwriting.
  const exactProperties = await Promise.allSettled(
    rxNormIds.map(async (rxcui) => {
      const record = await fetchTrustedJson(rxNormRecordUrl(rxcui));
      return { rxcui, name: sourceTitle(record?.properties?.name, 200) };
    }),
  );
  const exactMatches = exactProperties
    .filter((result) => result.status === 'fulfilled' && result.value.name)
    .map((result) => result.value)
    .slice(0, 3);

  let similarMatches = [];
  if (exactMatches.length === 0 && dailyMedLabels.length === 0 && openFdaLabels.length === 0) {
    const approximateResult = await Promise.allSettled([fetchTrustedJson(approximateApiUrl)]);
    const candidates = approximateResult[0].status === 'fulfilled' && Array.isArray(approximateResult[0].value?.approximateGroup?.candidate)
      ? approximateResult[0].value.approximateGroup.candidate
      : [];
    // Score is supplied by RxNorm. A conservative threshold avoids displaying
    // unrelated medicines merely because the handwriting was difficult.
    similarMatches = candidates
      .map((candidate) => ({
        rxcui: cleanText(candidate?.rxcui, 40),
        name: sourceTitle(candidate?.name, 200),
        score: Number(candidate?.score || 0),
      }))
      .filter((candidate) => candidate.rxcui && candidate.name && candidate.score >= 80)
      .filter((candidate, index, all) => all.findIndex((item) => item.rxcui === candidate.rxcui) === index)
      .slice(0, 3);
  }

  const sources = [
    ...exactMatches.map((match) => ({
      title: `RxNorm official record: ${match.name}`,
      url: rxNormRecordUrl(match.rxcui),
    })),
    ...dailyMedLabels.map((label) => ({
      title: `DailyMed label: ${label.name}`,
      url: dailyMedLabelUrl(label.setId),
    })),
    ...openFdaLabels.map((label) => ({
      title: `openFDA official label record: ${label.name}`,
      url: openFdaRecordUrl(label.setId),
    })),
    ...similarMatches.map((match) => ({
      title: `Similar RxNorm name — not confirmed: ${match.name}`,
      url: rxNormRecordUrl(match.rxcui),
    })),
  ];

  if (sources.length === 0) {
    return {
      status: 'source_not_found',
      summary:
        `No sufficiently close official medicine record was found for ${lookupTerm}. It may be a regional brand, a supplement or unclear handwriting.`,
      possibleInterpretation: null,
      questionForProfessional:
        `Please confirm the exact spelling and active ingredients of ${originalTitle}, plus the amount per dose, frequency, route and duration.`,
      sources: [],
    };
  }

  const exactNames = [
    ...exactMatches.map((match) => match.name),
    ...dailyMedLabels.map((label) => label.name),
    ...openFdaLabels.map((label) => label.name),
  ].filter((name, index, all) => all.indexOf(name) === index);
  const similarNames = similarMatches.map((match) => match.name);
  const candidateText = similarNames.length > 0
    ? `RxNorm found these real but unconfirmed similar names: ${similarNames.join(', ')}.`
    : `Official records were found for ${exactNames.join(', ')}.`;
  return {
    status: 'needs_confirmation',
    summary:
      `${candidateText} The records identify database names only. They do not confirm unclear handwriting or a patient-specific instruction.`,
    possibleInterpretation: null,
    questionForProfessional:
      'Please compare the original writing with these records and confirm the medicine, active ingredients, amount, frequency, route and duration.',
    sources,
  };
}

async function storeInstructionSafetyCheck(instructionId, check) {
  await pool.execute(
    `UPDATE extracted_instructions SET
      safety_check_status = ?, safety_check_summary = ?,
      safety_possible_interpretation = ?, safety_question = ?,
      safety_sources = ?, safety_checked_at = CURRENT_TIMESTAMP,
      requires_professional_confirmation = CASE
        WHEN ? = 1 THEN 1
        ELSE requires_professional_confirmation
      END
     WHERE id = ?`,
    [
      check.status,
      check.summary || null,
      check.possibleInterpretation || null,
      check.questionForProfessional,
      JSON.stringify(check.sources),
      check.status === 'needs_confirmation' || check.status === 'source_not_found' ? 1 : 0,
      instructionId,
    ],
  );
}

async function logAiUsage({
  userId,
  carePlanId,
  result,
  status,
  errorCode = null,
  featureName = 'document_extraction',
}) {
  const configuration = aiConfiguration();
  try {
    await pool.execute(
      `INSERT INTO ai_usage_logs (
        user_id, care_plan_id, feature_name, provider_name, model_name,
        input_tokens, output_tokens, request_status, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        carePlanId,
        featureName,
        result?.provider || configuration.provider || 'openrouter',
        result?.model || configuration.model || 'unknown',
        Number(result?.inputTokens || 0),
        Number(result?.outputTokens || 0),
        status,
        errorCode,
      ],
    );
  } catch (error) {
    console.error('Could not save AI usage log:', error?.message || error);
  }
}

async function preferredLanguageForRequest(req, db = pool) {
  if (!req?.auth?.userId) return 'English';
  if (req.auth.preferredLanguage) return req.auth.preferredLanguage;
  req.auth.preferredLanguage = await readPreferredLanguageForUser(
    db,
    req.auth.userId,
  );
  return req.auth.preferredLanguage;
}

async function saveProfile(userId, profile, onboardingCompleted) {
  await pool.execute(
    `INSERT INTO patient_profiles (
      user_id,
      using_for,
      patient_name,
      age_group,
      city,
      preferred_language,
      accessibility_mode,
      caregiver_support,
      onboarding_completed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      using_for = VALUES(using_for),
      patient_name = VALUES(patient_name),
      age_group = VALUES(age_group),
      city = VALUES(city),
      preferred_language = VALUES(preferred_language),
      accessibility_mode = VALUES(accessibility_mode),
      caregiver_support = VALUES(caregiver_support),
      onboarding_completed = IF(
        VALUES(onboarding_completed) = 1,
        1,
        onboarding_completed
      )`,
    [
      userId,
      profile.usingFor,
      profile.patientName,
      profile.ageGroup,
      profile.city,
      profile.preferredLanguage,
      profile.accessibilityMode,
      profile.caregiverSupport ? 1 : 0,
      onboardingCompleted ? 1 : 0,
    ],
  );

  const [rows] = await pool.execute(
    `SELECT id, using_for, patient_name, age_group, city,
      preferred_language, accessibility_mode, caregiver_support,
      onboarding_completed
     FROM patient_profiles WHERE user_id = ? LIMIT 1`,
    [userId],
  );

  return profileJson(rows[0]);
}

function authenticate(req, res, next) {
  const authorization = req.get('authorization') || '';
  const [scheme, token] = authorization.split(' ');

  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({
      success: false,
      message: 'Authentication is required.',
    });
    return;
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'sehatroute-api',
      audience: 'sehatroute-app',
    });

    req.auth = {
      userId: payload.sub,
    };

    next();
  } catch {
    res.status(401).json({
      success: false,
      message: 'Your session is invalid or has expired.',
    });
  }
}

app.get('/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      success: true,
      service: 'sehatroute-auth-api',
      database: 'connected',
      build: 'medical-safety-fixed-duration-v7',
      ai: aiConfiguration(),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/ai/test', authenticate, aiLimiter, async (_req, res, next) => {
  try {
    const result = await generateAiText({
      systemPrompt:
        'You are a connection test. Follow the user instruction exactly and add nothing else.',
      userPrompt: 'Reply with exactly: SEHATMATE_AI_OK',
      temperature: 0,
      maxTokens: 300,
    });

    res.json({
      success: true,
      message: 'AI provider connected successfully.',
      data: result,
    });
  } catch (error) {
    if (error instanceof AiServiceError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
});

const agentErrorStatusByCode = {
  AGENT_DISABLED: 503,
  AGENT_MESSAGE_EMPTY: 422,
  INVALID_AGENT_SESSION_ID: 422,
  AGENT_SESSION_NOT_FOUND: 404,
  AGENT_SESSION_STATE_TOO_LARGE: 422,
  AGENT_INTERNAL_ERROR: 500,
};

app.post('/api/agent/message', authenticate, agentLimiter, async (req, res, next) => {
  try {
    const result = await handleAgentMessage({
      pool,
      userId: req.auth.userId,
      sessionId: req.body?.sessionId ?? null,
      message: req.body?.message,
      clientContext: req.body?.screenContext ?? req.body?.clientContext ?? null,
      confirmation: req.body?.confirmation ?? null,
    });

    if (!result.ok) {
      res.status(agentErrorStatusByCode[result.code] || 422).json({
        success: false,
        code: result.code,
        message: result.message,
      });
      return;
    }

    res.json({
      success: true,
      data: {
        sessionId: result.sessionId,
        language: result.language,
        reply: result.reply,
        navigation: result.navigation,
        confirmation: result.confirmation,
        actionStatus: result.actionStatus,
        referencedEntities: result.referencedEntities,
        ...(result.fallbackCode ? { fallbackCode: result.fallbackCode } : {}),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  const validation = validateRegistration(req.body || {});

  if (validation.error) {
    res.status(422).json({
      success: false,
      message: validation.error,
    });
    return;
  }

  const { name, email, password } = validation.value;

  try {
    const [existing] = await pool.execute(
      'SELECT id FROM users WHERE email = ? LIMIT 1',
      [email],
    );

    if (existing.length > 0) {
      res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
      });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const [result] = await pool.execute(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name, email, passwordHash],
    );

    const user = {
      id: result.insertId,
      name,
      email,
    };

    res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      data: {
        token: createToken(user),
        user: publicUser(user),
        onboardingCompleted: false,
      },
    });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
      });
      return;
    }

    next(error);
  }
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  const validation = validateLogin(req.body || {});

  if (validation.error) {
    res.status(422).json({
      success: false,
      message: validation.error,
    });
    return;
  }

  const { email, password } = validation.value;

  try {
    const [rows] = await pool.execute(
      `SELECT id, name, email, password_hash,
        EXISTS(
          SELECT 1 FROM patient_profiles
          WHERE patient_profiles.user_id = users.id
            AND patient_profiles.onboarding_completed = 1
        ) AS onboarding_completed
       FROM users WHERE email = ? LIMIT 1`,
      [email],
    );

    const user = rows[0];

    const passwordMatches = user?.password_hash
      ? await bcrypt.compare(password, user.password_hash)
      : false;

    if (!user || !passwordMatches) {
      res.status(401).json({
        success: false,
        message: 'Incorrect email or password.',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Signed in successfully.',
      data: {
        token: createToken(user),
        user: publicUser(user),
        onboardingCompleted: Boolean(user.onboarding_completed),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/google', authLimiter, async (req, res, next) => {
  const idToken =
    typeof req.body?.idToken === 'string'
      ? req.body.idToken.trim()
      : '';

  if (!idToken || idToken.length > 10000) {
    res.status(422).json({
      success: false,
      message: 'A valid Google ID token is required.',
    });
    return;
  }

  let googlePayload;

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    googlePayload = ticket.getPayload();
  } catch (error) {
    console.error('Google token verification failed:', error?.message);

    res.status(401).json({
      success: false,
      message: 'Google authentication could not be verified.',
    });
    return;
  }

  const googleSub =
    typeof googlePayload?.sub === 'string'
      ? googlePayload.sub.trim()
      : '';

  const email =
    typeof googlePayload?.email === 'string'
      ? googlePayload.email.trim().toLowerCase()
      : '';

  const emailVerified = googlePayload?.email_verified === true;

  if (
    !googleSub ||
    !emailVerified ||
    !emailPattern.test(email) ||
    email.length > 191
  ) {
    res.status(401).json({
      success: false,
      message: 'Google did not return a verified email account.',
    });
    return;
  }

  const name = validateGoogleName(googlePayload?.name, email);

  try {
    const [googleUsers] = await pool.execute(
      `SELECT id, name, email, google_sub,
        EXISTS(
          SELECT 1 FROM patient_profiles
          WHERE patient_profiles.user_id = users.id
            AND patient_profiles.onboarding_completed = 1
        ) AS onboarding_completed
       FROM users WHERE google_sub = ? LIMIT 1`,
      [googleSub],
    );

    if (googleUsers.length > 0) {
      const user = googleUsers[0];

      res.json({
        success: true,
        message: 'Signed in with Google successfully.',
        data: {
          token: createToken(user),
          user: publicUser(user),
          isNewUser: false,
          onboardingCompleted: Boolean(user.onboarding_completed),
        },
      });
      return;
    }

    const [emailUsers] = await pool.execute(
      'SELECT id, name, email, google_sub FROM users WHERE email = ? LIMIT 1',
      [email],
    );

    if (emailUsers.length > 0) {
      res.status(409).json({
        success: false,
        message:
          'An account with this email already exists. Please sign in using your password.',
      });
      return;
    }

    const [result] = await pool.execute(
      `INSERT INTO users (
        name,
        email,
        password_hash,
        google_sub
      ) VALUES (?, ?, ?, ?)`,
      [name, email, null, googleSub],
    );

    const user = {
      id: result.insertId,
      name,
      email,
    };

    res.status(201).json({
      success: true,
      message: 'Google account created successfully.',
      data: {
        token: createToken(user),
        user: publicUser(user),
        isNewUser: true,
        onboardingCompleted: false,
      },
    });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      res.status(409).json({
        success: false,
        message: 'An account with this Google account or email already exists.',
      });
      return;
    }

    next(error);
  }
});

app.get('/api/auth/me', authenticate, async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, email,
        EXISTS(
          SELECT 1 FROM patient_profiles
          WHERE patient_profiles.user_id = users.id
            AND patient_profiles.onboarding_completed = 1
        ) AS onboarding_completed
       FROM users WHERE id = ? LIMIT 1`,
      [req.auth.userId],
    );

    if (rows.length === 0) {
      res.status(404).json({
        success: false,
        message: 'User account was not found.',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        user: publicUser(rows[0]),
        onboardingCompleted: Boolean(rows[0].onboarding_completed),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/profile', authenticate, async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, using_for, patient_name, age_group, city,
        preferred_language, accessibility_mode, caregiver_support,
        onboarding_completed
       FROM patient_profiles WHERE user_id = ? LIMIT 1`,
      [req.auth.userId],
    );

    res.json({
      success: true,
      data: { profile: profileJson(rows[0]) },
    });
  } catch (error) {
    next(error);
  }
});

app.put('/api/profile', authenticate, async (req, res, next) => {
  const validation = validateProfile(req.body || {});
  if (validation.error) {
    res.status(422).json({ success: false, message: validation.error });
    return;
  }

  try {
    const profile = await saveProfile(
      req.auth.userId,
      validation.value,
      false,
    );
    res.json({
      success: true,
      message: 'Patient profile updated successfully.',
      data: { profile },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/onboarding/complete', authenticate, async (req, res, next) => {
  const validation = validateProfile(req.body || {});
  if (validation.error) {
    res.status(422).json({ success: false, message: validation.error });
    return;
  }

  try {
    const profile = await saveProfile(
      req.auth.userId,
      validation.value,
      true,
    );
    res.json({
      success: true,
      message: 'Onboarding completed successfully.',
      data: { profile, onboardingCompleted: true },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/care-plans', authenticate, async (req, res, next) => {
  try {
    const result = await listCarePlans({ pool, userId: req.auth.userId });
    if (!result.ok) {
      sendServiceError(res, result);
      return;
    }

    res.json({ success: true, data: result.data });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/care-plans/:id', authenticate, async (req, res, next) => {
  const planId = req.params.id;
  if (!idPattern.test(planId)) {
    res.status(422).json({ success: false, message: 'Invalid care plan ID.' });
    return;
  }

  try {
    const [plans] = await pool.execute(
      'SELECT id, status, duration_mode FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
      [planId, req.auth.userId],
    );
    const plan = plans[0];
    if (!plan) {
      res.status(404).json({ success: false, message: 'Care plan not found.' });
      return;
    }
    await pool.execute(
      'DELETE FROM care_plans WHERE id = ? AND user_id = ?',
      [planId, req.auth.userId],
    );
    res.json({
      success: true,
      message: 'Care plan deleted.',
      data: { planId: String(planId) },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/care-plans/bulk-delete', authenticate, async (req, res, next) => {
  const ids = [...new Set((Array.isArray(req.body?.planIds) ? req.body.planIds : [])
    .map((value) => String(value))
    .filter((value) => idPattern.test(value)))].slice(0, 100);
  if (!ids.length) return res.status(422).json({ success: false, message: 'Select at least one care plan.' });
  try {
    const placeholders = ids.map(() => '?').join(',');
    const [result] = await pool.execute(
      `DELETE FROM care_plans WHERE user_id = ? AND id IN (${placeholders})`,
      [req.auth.userId, ...ids],
    );
    res.json({ success: true, message: 'Selected care plans deleted.', data: { deletedCount: Number(result.affectedRows || 0) } });
  } catch (error) { next(error); }
});

app.patch('/api/care-plans/:id/duration', authenticate, async (req, res, next) => {
  const planId = req.params.id;
  const mode = cleanText(req.body?.mode, 20);
  const allowedModes = new Set(['prescription', 'custom', 'ongoing']);
  const endDate = cleanText(req.body?.endDate, 10);
  if (!idPattern.test(planId) || !allowedModes.has(mode)) {
    return res.status(422).json({ success: false, message: 'Select a valid plan duration.' });
  }
  if (mode !== 'ongoing' && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(422).json({ success: false, message: 'Select a valid plan end date.' });
  }
  if (mode !== 'ongoing' && endDate < new Date().toISOString().slice(0, 10)) {
    return res.status(422).json({ success: false, message: 'Plan end date cannot be in the past.' });
  }
  try {
    const [result] = await pool.execute(
      `UPDATE care_plans SET duration_mode = ?, planned_end_date = ?
       WHERE id = ? AND user_id = ?`,
      [mode, mode === 'ongoing' ? null : endDate, planId, req.auth.userId],
    );
    if (!result.affectedRows) return res.status(404).json({ success: false, message: 'Care plan not found.' });
    await recordLifecycleEvent({
      db: pool,
      userId: req.auth.userId,
      planId,
      eventType: 'duration_changed',
      reason: mode === 'ongoing'
        ? 'Care plan changed to ongoing.'
        : `Care plan end date set to ${endDate}.`,
      metadata: { mode, endDate: mode === 'ongoing' ? null : endDate },
    });
    res.json({ success: true, message: 'Plan duration saved.', data: { mode, endDate: mode === 'ongoing' ? null : endDate } });
  } catch (error) { next(error); }
});

app.post('/api/care-plans', authenticate, async (req, res, next) => {
  const title = cleanText(req.body?.title, 120);
  if (title.length < 2) {
    res.status(422).json({
      success: false,
      message: 'Care plan title must contain at least 2 characters.',
    });
    return;
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO care_plans (user_id, title, status, setup_step)
       VALUES (?, ?, 'draft', 'upload')`,
      [req.auth.userId, title],
    );
    const [rows] = await pool.execute(
      'SELECT * FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
      [result.insertId, req.auth.userId],
    );

    res.status(201).json({
      success: true,
      message: 'Care plan created successfully.',
      data: { plan: carePlanJson(rows[0]) },
    });
  } catch (error) {
    next(error);
  }
});


app.get('/api/care-plans/:id/setup-progress', authenticate, async (req, res, next) => {
  const planId = req.params.id;
  if (!idPattern.test(planId)) {
    res.status(422).json({ success: false, message: 'Invalid care plan ID.' });
    return;
  }

  try {
    const [rows] = await pool.execute(
      `SELECT status, setup_step
       FROM care_plans
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
      [planId, req.auth.userId],
    );
    if (!rows.length) {
      res.status(404).json({ success: false, message: 'Care plan not found.' });
      return;
    }

    let step = rows[0].setup_step;
    if (!step) {
      step = inferredSetupStep(rows[0].status);

      if (['reality_check', 'needs_attention'].includes(rows[0].status)) {
        const [tasks] = await pool.execute(
          `SELECT id, task_kind, title, display_time, recurrence_text, reason,
            requires_confirmation
           FROM care_schedule_items
           WHERE care_plan_id = ? AND user_id = ?`,
          [planId, req.auth.userId],
        );

        if (!tasks.length || tasks.some((task) => Boolean(task.requires_confirmation))) {
          step = 'schedule';
        } else {
          const reality = await realityDecisionTemplatesForPlan({
            db: pool,
            planId,
            userId: req.auth.userId,
            tasks,
            createIfMissing: false,
          });
          const templates = reality.templates;
          const [answers] = await pool.execute(
            `SELECT question_key
             FROM care_reality_answers
             WHERE care_plan_id = ? AND user_id = ?`,
            [planId, req.auth.userId],
          );
          const answeredKeys = new Set(answers.map((item) => item.question_key));
          step = templates.some((item) => !answeredKeys.has(item.key))
            ? 'reality_check'
            : 'simulation';
        }
      }

      await pool.execute(
        `UPDATE care_plans
         SET setup_step = ?
         WHERE id = ? AND user_id = ? AND setup_step IS NULL`,
        [step, planId, req.auth.userId],
      );
    }

    res.json({ success: true, data: { step } });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/care-plans/:id/setup-progress', authenticate, async (req, res, next) => {
  const planId = req.params.id;
  const step = cleanText(req.body?.step, 40).toLowerCase();
  if (!idPattern.test(planId) || !careSetupSteps.has(step)) {
    res.status(422).json({ success: false, message: 'Invalid care-plan setup step.' });
    return;
  }

  try {
    const [plans] = await pool.execute(
      'SELECT status FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
      [planId, req.auth.userId],
    );
    if (!plans.length) {
      res.status(404).json({ success: false, message: 'Care plan not found.' });
      return;
    }

    const effectiveStep = ['active', 'completed'].includes(plans[0].status)
      ? 'complete'
      : step;
    await pool.execute(
      `UPDATE care_plans
       SET setup_step = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [effectiveStep, planId, req.auth.userId],
    );
    res.json({ success: true, data: { step: effectiveStep } });
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/care-plans/:id/documents',
  authenticate,
  uploadLimiter,
  async (req, res, next) => {
    const planId = req.params.id;
    const documentType = cleanText(req.body?.documentType, 40);
    const originalName = safeDocumentName(req.body?.originalName);
    const mimeType = cleanText(req.body?.mimeType, 100).toLowerCase();
    const contentBase64 = typeof req.body?.contentBase64 === 'string'
      ? req.body.contentBase64.trim()
      : '';

    if (!idPattern.test(planId)) {
      res.status(422).json({ success: false, message: 'Invalid care plan ID.' });
      return;
    }
    if (!documentTypes.has(documentType)) {
      res.status(422).json({ success: false, message: 'Select a valid document type.' });
      return;
    }
    if (originalName.length < 1 || !allowedDocumentMimeTypes.has(mimeType)) {
      res.status(422).json({
        success: false,
        message: 'Only PDF, JPG and PNG documents are supported.',
      });
      return;
    }
    if (
      contentBase64.length === 0 ||
      contentBase64.length > Math.ceil(maximumDocumentBytes * 4 / 3) + 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)
    ) {
      res.status(422).json({ success: false, message: 'The document data is invalid.' });
      return;
    }

    const fileBuffer = Buffer.from(contentBase64, 'base64');
    if (
      fileBuffer.length === 0 ||
      fileBuffer.length > maximumDocumentBytes ||
      !validDocumentSignature(fileBuffer, mimeType)
    ) {
      res.status(422).json({
        success: false,
        message: 'The document is invalid or exceeds the 20 MB limit.',
      });
      return;
    }

    try {
      const [plans] = await pool.execute(
        'SELECT id FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
        [planId, req.auth.userId],
      );
      if (plans.length === 0) {
        res.status(404).json({ success: false, message: 'Care plan not found.' });
        return;
      }

      const extension = mimeType === 'application/pdf'
        ? 'pdf'
        : mimeType === 'image/png'
          ? 'png'
          : 'jpg';
      const storedName = `${crypto.randomUUID()}.${extension}`;
      const storagePath = `mysql://care_documents/${storedName}`;
      const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const [result] = await pool.execute(
        `INSERT INTO care_documents (
          care_plan_id, user_id, document_type, original_name, stored_name,
          mime_type, file_size_bytes, storage_path, file_data, file_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          planId,
          req.auth.userId,
          documentType,
          originalName,
          storedName,
          mimeType,
          fileBuffer.length,
          storagePath,
          fileBuffer,
          sha256,
        ],
      );

      await pool.execute(
        `UPDATE care_plans SET status = CASE
          WHEN status = 'draft' THEN 'processing'
          ELSE status
         END WHERE id = ? AND user_id = ?`,
        [planId, req.auth.userId],
      );

      const [documents] = await pool.execute(
        `SELECT id, document_type, original_name, mime_type, file_size_bytes,
          page_count, processing_status, processing_error, created_at
         FROM care_documents WHERE id = ? AND user_id = ? LIMIT 1`,
        [result.insertId, req.auth.userId],
      );

      await refreshCareGaps({
        db: pool,
        planId,
        userId: req.auth.userId,
        realityQuestionTemplates,
      });

      res.status(201).json({
        success: true,
        message: 'Document uploaded successfully.',
        data: {
          document: {
            ...documents[0],
            id: String(documents[0].id),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get('/api/documents/:id/file', authenticate, async (req, res, next) => {
  const documentId = req.params.id;
  if (!idPattern.test(documentId)) {
    res.status(422).json({ success: false, message: 'Invalid document ID.' });
    return;
  }

  try {
    const [rows] = await pool.execute(
      `SELECT original_name, mime_type, file_size_bytes, file_data
       FROM care_documents WHERE id = ? AND user_id = ? LIMIT 1`,
      [documentId, req.auth.userId],
    );
    const document = rows[0];
    if (!document || !document.file_data) {
      res.status(404).json({ success: false, message: 'Document file not found.' });
      return;
    }

    const fallbackName = safeDocumentName(document.original_name)
      .replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', document.mime_type);
    res.setHeader('Content-Length', String(document.file_size_bytes));
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(document.original_name)}`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(document.file_data);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/documents/:id', authenticate, async (req, res, next) => {
  const documentId = req.params.id;
  if (!idPattern.test(documentId)) {
    res.status(422).json({ success: false, message: 'Invalid document ID.' });
    return;
  }

  try {
    const [documents] = await pool.execute(
      `SELECT id, care_plan_id FROM care_documents
       WHERE id = ? AND user_id = ? LIMIT 1`,
      [documentId, req.auth.userId],
    );
    const document = documents[0];
    if (!document) {
      res.status(404).json({ success: false, message: 'Document not found.' });
      return;
    }

    await pool.execute(
      'DELETE FROM care_documents WHERE id = ? AND user_id = ?',
      [documentId, req.auth.userId],
    );
    const [[counts]] = await pool.execute(
      'SELECT COUNT(*) AS document_count FROM care_documents WHERE care_plan_id = ?',
      [document.care_plan_id],
    );
    if (Number(counts.document_count || 0) === 0) {
      await pool.execute(
        `UPDATE care_plans SET status = 'draft'
         WHERE id = ? AND user_id = ? AND status = 'processing'`,
        [document.care_plan_id, req.auth.userId],
      );
    }

    await refreshCareGaps({
      db: pool,
      planId: String(document.care_plan_id),
      userId: req.auth.userId,
      realityQuestionTemplates,
    });

    res.json({ success: true, message: 'Document removed successfully.', data: {} });
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/care-plans/:id/extract',
  authenticate,
  aiLimiter,
  async (req, res, next) => {
    const planId = req.params.id;
    if (!idPattern.test(planId)) {
      res.status(422).json({ success: false, message: 'Invalid care plan ID.' });
      return;
    }

    try {
      const [plans] = await pool.execute(
        'SELECT id FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
        [planId, req.auth.userId],
      );
      if (plans.length === 0) {
        res.status(404).json({ success: false, message: 'Care plan not found.' });
        return;
      }

      const [documents] = await pool.execute(
        `SELECT id, document_type, original_name, mime_type, file_data
         FROM care_documents
         WHERE care_plan_id = ? AND user_id = ?
           AND processing_status IN ('uploaded', 'failed')
         ORDER BY id`,
        [planId, req.auth.userId],
      );
      if (documents.length === 0) {
        const [[existing]] = await pool.execute(
          'SELECT COUNT(*) AS instruction_count FROM extracted_instructions WHERE care_plan_id = ?',
          [planId],
        );
        if (Number(existing.instruction_count || 0) > 0) {
          res.json({
            success: true,
            message: 'Documents were already processed.',
            data: { instructionCount: Number(existing.instruction_count), failedDocuments: [] },
          });
          return;
        }
        res.status(409).json({ success: false, message: 'Upload a document before extraction.' });
        return;
      }

      const preferredLanguage = await preferredLanguageForRequest(req);
      let instructionCount = 0;
      const failedDocuments = [];
      for (const document of documents) {
        await pool.execute(
          `UPDATE care_documents
           SET processing_status = 'processing', processing_error = NULL
           WHERE id = ? AND user_id = ?`,
          [document.id, req.auth.userId],
        );

        let aiResult;
        try {
          if (!document.file_data) {
            throw new AiServiceError('Stored document data was not found.', 404);
          }
          aiResult = await extractCareInstructions({
            fileBuffer: Buffer.from(document.file_data),
            fileName: document.original_name,
            mimeType: document.mime_type,
            documentType: document.document_type,
            preferredLanguage,
          });
          const instructions = parseAiInstructions(
            aiResult.text,
            preferredLanguage,
          );
          if (instructions.length === 0) {
            throw new AiServiceError('No clear care instructions were found in this document.', 422);
          }

          const connection = await pool.getConnection();
          try {
            await connection.beginTransaction();
            await connection.execute(
              `DELETE FROM extracted_instructions
               WHERE document_id = ? AND review_status IN ('pending', 'unclear')`,
              [document.id],
            );

            const [existingMedicineRows] = await connection.execute(
              `SELECT id, title, instruction, timing
               FROM extracted_instructions
               WHERE care_plan_id = ? AND category = 'medicine'
               ORDER BY id`,
              [planId],
            );
            const medicineFingerprints = new Map(
              existingMedicineRows.map((item) => [
                medicineFingerprint(item.title, item.instruction, item.timing),
                String(item.id),
              ]),
            );

            for (const instruction of instructions) {
              let duplicateOfInstructionId = null;
              let duplicateReason = null;
              if (instruction.category === 'medicine') {
                const fingerprint = medicineFingerprint(
                  instruction.title,
                  instruction.instruction,
                  instruction.timing,
                );
                duplicateOfInstructionId = medicineFingerprints.get(fingerprint) || null;
                if (duplicateOfInstructionId) {
                  duplicateReason = localizedAiFallbackText(
                    'duplicateMedicineAmbiguity',
                    preferredLanguage,
                  );
                  instruction.reviewStatus = 'unclear';
                  instruction.requiresProfessionalConfirmation = true;
                  instruction.ambiguityReason = [
                    duplicateReason,
                    instruction.ambiguityReason,
                  ].filter(Boolean).join(' ').slice(0, 2000);
                }
              }

              const [inserted] = await connection.execute(
                `INSERT INTO extracted_instructions (
                  care_plan_id, document_id, category, title, instruction,
                  timing, original_title, original_instruction, original_timing,
                  source_page, confidence_score, review_status,
                  requires_professional_confirmation, ambiguity_reason,
                  possible_interpretation, safety_note,
                  duplicate_of_instruction_id, duplicate_reason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  planId,
                  document.id,
                  instruction.category,
                  instruction.title,
                  instruction.instruction,
                  instruction.timing,
                  instruction.title,
                  instruction.instruction,
                  instruction.timing,
                  instruction.sourcePage,
                  instruction.confidenceScore,
                  instruction.reviewStatus,
                  instruction.requiresProfessionalConfirmation ? 1 : 0,
                  instruction.ambiguityReason,
                  instruction.possibleInterpretation,
                  instruction.safetyNote,
                  duplicateOfInstructionId,
                  duplicateReason,
                ],
              );

              if (instruction.category === 'medicine') {
                const fingerprint = medicineFingerprint(
                  instruction.title,
                  instruction.instruction,
                  instruction.timing,
                );
                if (!medicineFingerprints.has(fingerprint)) {
                  medicineFingerprints.set(fingerprint, String(inserted.insertId));
                }
              }
            }
            await connection.execute(
              `UPDATE care_documents
               SET processing_status = 'processed', processing_error = NULL
               WHERE id = ? AND user_id = ?`,
              [document.id, req.auth.userId],
            );
            await connection.commit();
            instructionCount += instructions.length;
          } catch (error) {
            await connection.rollback();
            throw error;
          } finally {
            connection.release();
          }
          await logAiUsage({
            userId: req.auth.userId,
            carePlanId: planId,
            result: aiResult,
            status: 'success',
          });
        } catch (error) {
          const safeMessage = error instanceof AiServiceError
            ? error.message
            : 'Document extraction failed.';
          console.error('AI document extraction failed', {
            documentId: String(document.id),
            carePlanId: String(planId),
            mimeType: document.mime_type,
            statusCode: error?.statusCode || 500,
            upstreamStatus: error?.upstreamStatus || null,
            providerCode: error?.providerCode || null,
            providerName: error?.providerName || null,
            message: safeMessage,
          });
          failedDocuments.push({ id: String(document.id), message: safeMessage });
          await pool.execute(
            `UPDATE care_documents
             SET processing_status = 'failed', processing_error = ?
             WHERE id = ? AND user_id = ?`,
            [safeMessage.slice(0, 500), document.id, req.auth.userId],
          );
          await logAiUsage({
            userId: req.auth.userId,
            carePlanId: planId,
            result: aiResult,
            status: 'failed',
            errorCode: error?.providerCode ||
              (error?.upstreamStatus ? `upstream_${error.upstreamStatus}` : null) ||
              (error?.statusCode ? String(error.statusCode) : 'extraction_failed'),
          });
        }
      }

      const [[totals]] = await pool.execute(
        'SELECT COUNT(*) AS instruction_count FROM extracted_instructions WHERE care_plan_id = ?',
        [planId],
      );
      const totalInstructions = Number(totals.instruction_count || 0);
      await pool.execute(
        `UPDATE care_plans
         SET status = ?,
             setup_step = CASE WHEN ? > 0 THEN 'review' ELSE setup_step END
         WHERE id = ? AND user_id = ?`,
        [
          totalInstructions > 0 ? 'needs_review' : 'processing',
          totalInstructions,
          planId,
          req.auth.userId,
        ],
      );

      if (totalInstructions === 0) {
        res.status(422).json({
          success: false,
          message: failedDocuments[0]?.message || 'No care instructions could be extracted.',
          data: { instructionCount: 0, failedDocuments },
        });
        return;
      }

      res.json({
        success: true,
        message: failedDocuments.length === 0
          ? 'Instructions extracted. Please verify every item against the original document.'
          : 'Some documents were processed. Review the failed documents and retry them.',
        data: { instructionCount: totalInstructions, failedDocuments },
      });
    } catch (error) {
      next(error);
    }
  },
);

app.post('/api/instructions/:id/safety-check', authenticate, authLimiter, async (req, res, next) => {
  const instructionId = req.params.id;
  if (!idPattern.test(instructionId)) {
    res.status(422).json({ success: false, message: 'Invalid instruction ID.' });
    return;
  }

  try {
    const [rows] = await pool.execute(
      `SELECT extracted_instructions.id, extracted_instructions.care_plan_id,
        extracted_instructions.category, extracted_instructions.title,
        extracted_instructions.instruction, extracted_instructions.timing
       FROM extracted_instructions
       JOIN care_plans ON care_plans.id = extracted_instructions.care_plan_id
       WHERE extracted_instructions.id = ? AND care_plans.user_id = ? LIMIT 1`,
      [instructionId, req.auth.userId],
    );
    const instruction = rows[0];
    if (!instruction) {
      res.status(404).json({ success: false, message: 'Instruction not found.' });
      return;
    }

    // Use official NLM medicine databases directly, so this does not consume
    // AI tokens and does not depend on a free model supporting web search.
    const check = await trustedSourceCheck(instruction);
    try {
      await storeInstructionSafetyCheck(instructionId, check);
    } catch (storageError) {
      // The user can still see the trusted references even if an older
      // database has not received the optional safety-check columns yet.
      console.error('Could not persist safety check:', storageError?.message || storageError);
    }
    res.json({
      success: true,
      message: check.status === 'source_not_found'
        ? 'Trusted-source lookup completed, but no reliable match was found.'
        : 'Trusted-source lookup completed. Professional confirmation is still required.',
      data: { safetyCheck: check },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/instructions/:id/ingredient-evidence', authenticate, aiLimiter, async (req, res, next) => {
  const instructionId = req.params.id;
  const mimeType = cleanText(req.body?.mimeType, 100).toLowerCase();
  const originalName = safeDocumentName(cleanText(req.body?.originalName, 255)) || 'medicine-label.jpg';
  const contentBase64 = typeof req.body?.contentBase64 === 'string'
    ? req.body.contentBase64.trim()
    : '';

  if (!idPattern.test(instructionId)) {
    res.status(422).json({ success: false, message: 'Invalid instruction ID.' });
    return;
  }
  if (!['image/jpeg', 'image/png'].includes(mimeType)) {
    res.status(422).json({ success: false, message: 'Upload a JPG or PNG image of the ingredient label.' });
    return;
  }

  let imageBuffer;
  try {
    imageBuffer = Buffer.from(contentBase64, 'base64');
  } catch {
    imageBuffer = Buffer.alloc(0);
  }
  if (!imageBuffer.length || imageBuffer.length > 10 * 1024 * 1024 || !hasValidFileSignature(imageBuffer, mimeType)) {
    res.status(422).json({ success: false, message: 'The label image is invalid or exceeds the 10 MB limit.' });
    return;
  }

  try {
    const [rows] = await pool.execute(
      `SELECT extracted_instructions.id, extracted_instructions.care_plan_id,
        extracted_instructions.category, extracted_instructions.title,
        extracted_instructions.instruction, extracted_instructions.timing
       FROM extracted_instructions
       JOIN care_plans ON care_plans.id = extracted_instructions.care_plan_id
       WHERE extracted_instructions.id = ? AND care_plans.user_id = ? LIMIT 1`,
      [instructionId, req.auth.userId],
    );
    const instruction = rows[0];
    if (!instruction) {
      res.status(404).json({ success: false, message: 'Instruction not found.' });
      return;
    }
    if (cleanText(instruction.category, 40).toLowerCase() !== 'medicine') {
      res.status(422).json({ success: false, message: 'Ingredient-label evidence is available for medicine instructions only.' });
      return;
    }

    const preferredLanguage = await preferredLanguageForRequest(req);
    const labelAiResult = await analyzeMedicineLabel({
      fileBuffer: imageBuffer,
      fileName: originalName,
      mimeType,
      prescriptionTitle: instruction.title,
      prescriptionInstruction: instruction.instruction,
      prescriptionTiming: instruction.timing,
      preferredLanguage,
    });
    const label = parseIngredientLabel(labelAiResult.text, preferredLanguage);

    const ingredientChecks = await Promise.all(
      label.activeIngredients.slice(0, 4).map(async (ingredient) => ({
        ingredient,
        check: await trustedSourceCheck({
          category: 'medicine',
          title: ingredient.name,
          instruction: ingredient.strength,
          timing: '',
        }),
      })),
    );

    let purposeCheck = {
      status: 'needs_confirmation',
      summary: label.activeIngredients.length === 0
        ? localizedAiFallbackText(
            'noActiveIngredientPurpose',
            preferredLanguage,
          )
        : localizedAiFallbackText(
            'purposeCheckUnavailable',
            preferredLanguage,
          ),
      questionForProfessional: localizedAiFallbackText(
        'confirmPackagePrescription',
        preferredLanguage,
      ),
      sources: [],
    };
    let purposeAiResult = null;
    if (label.activeIngredients.length > 0) {
      try {
        purposeAiResult = await checkIngredientPurpose({
          activeIngredients: label.activeIngredients,
          prescriptionTitle: instruction.title,
          prescriptionInstruction: instruction.instruction,
          prescriptionTiming: instruction.timing,
          preferredLanguage,
        });
        purposeCheck = parsePurposeCheck(
          purposeAiResult.text,
          purposeAiResult.citations,
          preferredLanguage,
        );
      } catch (purposeError) {
        console.error('Ingredient purpose check unavailable:', purposeError?.message || purposeError);
      }
    }

    const sourceMap = new Map();
    for (const source of [
      ...ingredientChecks.flatMap((item) => item.check.sources || []),
      ...(purposeCheck.sources || []),
    ]) {
      if (source?.url && !sourceMap.has(source.url)) sourceMap.set(source.url, source);
    }
    const sources = [...sourceMap.values()].slice(0, 8);

    await logAiUsage({
      userId: req.auth.userId,
      carePlanId: instruction.care_plan_id,
      result: {
        ...labelAiResult,
        inputTokens: Number(labelAiResult.inputTokens || 0) + Number(purposeAiResult?.inputTokens || 0),
        outputTokens: Number(labelAiResult.outputTokens || 0) + Number(purposeAiResult?.outputTokens || 0),
      },
      status: 'success',
      featureName: 'ingredient_evidence',
    });

    res.json({
      success: true,
      message: 'Ingredient-label evidence is ready for review.',
      data: {
        evidence: {
          ...label,
          purposeStatus: purposeCheck.status,
          purposeSummary: purposeCheck.summary,
          questionForProfessional: purposeCheck.questionForProfessional,
          sources,
          prescriptionChanged: false,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/instructions/:id', authenticate, async (req, res, next) => {
  const instructionId = req.params.id;
  if (!idPattern.test(instructionId)) {
    res.status(422).json({ success: false, message: 'Invalid instruction ID.' });
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT i.id, i.care_plan_id, i.category, i.title
       FROM extracted_instructions i
       JOIN care_plans p ON p.id = i.care_plan_id
       WHERE i.id = ? AND p.user_id = ?
       LIMIT 1 FOR UPDATE`,
      [instructionId, req.auth.userId],
    );
    const instruction = rows[0];
    if (!instruction) {
      await connection.rollback();
      res.status(404).json({ success: false, message: 'Instruction not found.' });
      return;
    }

    const [scheduleRows] = await connection.execute(
      `SELECT COUNT(*) AS total
       FROM care_schedule_items
       WHERE instruction_id = ? AND care_plan_id = ? AND user_id = ?`,
      [instructionId, instruction.care_plan_id, req.auth.userId],
    );
    const deletedScheduleCount = Number(scheduleRows[0]?.total || 0);

    // Occurrences are removed by their schedule-item FK cascade. Local Android
    // notifications are reconciled by the client by cancelling the plan and
    // rebuilding only the remaining authoritative tasks.
    await connection.execute(
      `DELETE FROM care_schedule_items
       WHERE instruction_id = ? AND care_plan_id = ? AND user_id = ?`,
      [instructionId, instruction.care_plan_id, req.auth.userId],
    );
    await connection.execute(
      `DELETE FROM extracted_instructions
       WHERE id = ? AND care_plan_id = ?`,
      [instructionId, instruction.care_plan_id],
    );

    // Any rows that previously pointed to this instruction as a duplicate now
    // remain visible, but are no longer linked to a deleted row.
    await connection.execute(
      `UPDATE extracted_instructions
       SET duplicate_reason = CASE
             WHEN duplicate_of_instruction_id = ? THEN NULL
             ELSE duplicate_reason
           END,
           duplicate_of_instruction_id = NULL
       WHERE care_plan_id = ? AND duplicate_of_instruction_id = ?`,
      [instructionId, instruction.care_plan_id, instructionId],
    );

    await connection.commit();

    await refreshCareGaps({
      db: pool,
      planId: String(instruction.care_plan_id),
      userId: req.auth.userId,
      realityQuestionTemplates,
    });

    res.json({
      success: true,
      message: 'Instruction and its SehatMate reminders were removed.',
      data: {
        planId: String(instruction.care_plan_id),
        instructionId: String(instructionId),
        category: instruction.category,
        title: instruction.title,
        deletedScheduleCount,
      },
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    next(error);
  } finally {
    connection.release();
  }
});

app.patch('/api/instructions/:id', authenticate, async (req, res, next) => {
  const instructionId = req.params.id;
  const title = cleanText(req.body?.title, 160);
  const instruction = cleanText(req.body?.instruction, 4000);
  const timing = cleanText(req.body?.timing, 160);
  const reviewStatus = cleanText(req.body?.reviewStatus, 20).toLowerCase();

  if (!idPattern.test(instructionId)) {
    res.status(422).json({ success: false, message: 'Invalid instruction ID.' });
    return;
  }
  if (!['verified', 'unclear', 'rejected'].includes(reviewStatus)) {
    res.status(422).json({ success: false, message: 'Select a valid review status.' });
    return;
  }
  if (reviewStatus === 'verified' && (!title || !instruction)) {
    res.status(422).json({ success: false, message: 'Verified instructions require a title and instruction.' });
    return;
  }

  try {
    const [rows] = await pool.execute(
      `SELECT extracted_instructions.id, extracted_instructions.care_plan_id
       FROM extracted_instructions
       JOIN care_plans ON care_plans.id = extracted_instructions.care_plan_id
       WHERE extracted_instructions.id = ? AND care_plans.user_id = ? LIMIT 1`,
      [instructionId, req.auth.userId],
    );
    if (rows.length === 0) {
      res.status(404).json({ success: false, message: 'Instruction not found.' });
      return;
    }

    // Build values in JavaScript instead of comparing text values inside MySQL.
    // This avoids the utf8mb4_general_ci / utf8mb4_unicode_ci collation error.
    const verified = reviewStatus === 'verified' ? 1 : 0;
    const updates = [];
    const values = [];
    if (title) {
      updates.push('title = ?');
      values.push(title);
    }
    if (instruction) {
      updates.push('instruction = ?');
      values.push(instruction);
    }
    updates.push('timing = ?', 'review_status = ?');
    values.push(timing || null, reviewStatus);
    updates.push('requires_professional_confirmation = CASE WHEN ? = 1 THEN 0 ELSE requires_professional_confirmation END');
    values.push(verified);
    updates.push('verified_by = CASE WHEN ? = 1 THEN ? ELSE NULL END');
    values.push(verified, req.auth.userId);
    updates.push('verified_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END');
    values.push(verified, instructionId);

    await pool.execute(
      `UPDATE extracted_instructions SET ${updates.join(', ')} WHERE id = ?`,
      values,
    );

    await refreshCareGaps({
      db: pool,
      planId: String(rows[0].care_plan_id),
      userId: req.auth.userId,
      realityQuestionTemplates,
    });

    res.json({ success: true, message: 'Instruction review saved.', data: {} });
  } catch (error) {
    next(error);
  }
});

app.post('/api/care-plans/:id/finalize-review', authenticate, async (req, res, next) => {
  const planId = req.params.id;
  if (!idPattern.test(planId)) {
    res.status(422).json({ success: false, message: 'Invalid care plan ID.' });
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [plans] = await connection.execute(
      'SELECT id, status FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1 FOR UPDATE',
      [planId, req.auth.userId],
    );
    const plan = plans[0];
    if (!plan) {
      await connection.rollback();
      res.status(404).json({ success: false, message: 'Care plan not found.' });
      return;
    }

    const [[counts]] = await connection.execute(
      `SELECT
        COUNT(*) AS total_count,
        SUM(review_status = 'verified') AS verified_count,
        SUM(review_status = 'rejected') AS rejected_count,
        SUM(review_status = 'pending') AS pending_count,
        SUM(review_status = 'unclear') AS question_count
       FROM extracted_instructions
       WHERE care_plan_id = ?`,
      [planId],
    );

    const totalCount = Number(counts.total_count || 0);
    const verifiedCount = Number(counts.verified_count || 0);
    const rejectedCount = Number(counts.rejected_count || 0);
    const pendingCount = Number(counts.pending_count || 0);
    const questionCount = Number(counts.question_count || 0);

    if (totalCount === 0 || verifiedCount === 0) {
      await connection.rollback();
      res.status(409).json({
        success: false,
        message: 'Confirm at least one instruction before continuing.',
      });
      return;
    }
    if (pendingCount > 0) {
      await connection.rollback();
      res.status(409).json({
        success: false,
        message: 'Review every instruction before continuing.',
        data: { totalCount, verifiedCount, rejectedCount, pendingCount, questionCount },
      });
      return;
    }

    if (plan.status === 'needs_review') {
      await connection.execute(
        `UPDATE care_plans
         SET status = 'reality_check',
             setup_step = 'schedule',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`,
        [planId, req.auth.userId],
      );
    } else if (!['reality_check', 'needs_attention', 'active', 'completed'].includes(plan.status)) {
      await connection.rollback();
      res.status(409).json({
        success: false,
        message: `This care plan cannot be finalized while it is ${plan.status}.`,
      });
      return;
    }

    await connection.commit();
    res.json({
      success: true,
      message: 'Verified instructions are ready for the care plan.',
      data: {
        planId: String(planId),
        status: plan.status === 'needs_review' ? 'reality_check' : plan.status,
        totalCount,
        verifiedCount,
        rejectedCount,
        pendingCount,
        questionCount,
      },
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

app.post('/api/care-plans/:id/generate-schedule', authenticate, aiLimiter, async (req, res, next) => {
  const planId = req.params.id;
  if (!idPattern.test(planId)) {
    res.status(422).json({ success: false, message: 'Invalid care plan ID.' });
    return;
  }

  try {
    const [plans] = await pool.execute(
      'SELECT id, status, duration_mode FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
      [planId, req.auth.userId],
    );
    if (plans.length === 0) {
      res.status(404).json({ success: false, message: 'Care plan not found.' });
      return;
    }
    if (!['reality_check', 'needs_attention', 'active'].includes(plans[0].status)) {
      res.status(409).json({ success: false, message: 'Finalize the instruction review before generating a schedule.' });
      return;
    }

    const [instructions] = await pool.execute(
      `SELECT id, category, title, instruction, timing,
        original_title, original_instruction, original_timing
       FROM extracted_instructions
       WHERE care_plan_id = ? AND review_status = 'verified'
       ORDER BY id`,
      [planId],
    );
    if (instructions.length === 0) {
      res.status(409).json({ success: false, message: 'No verified instructions are available for scheduling.' });
      return;
    }

    const preferredLanguage = await preferredLanguageForRequest(req);
    const aiResult = await generateGroundedCareSchedule({
      today: new Date().toISOString().slice(0, 10),
      instructions: instructions.map((item) => ({
        id: String(item.id),
        category: item.category,
        title: cleanText(item.title, 160),
        instruction: cleanText(item.instruction, 4000),
        timing: cleanText(item.timing, 160),
      })),
      preferredLanguage,
    });
    const allowedIds = new Set(instructions.map((item) => String(item.id)));
    const parsedSchedule = parseCareSchedule(aiResult.text, allowedIds);
    const schedule = normalizeCareScheduleForInstructions(
      parsedSchedule,
      instructions,
      preferredLanguage,
    );
    if (schedule.length === 0) {
      throw new AiServiceError('No schedulable details were found in the verified instructions.', 422);
    }

    const durationDaysByInstruction = new Map(
      instructions.map((instruction) => [
        String(instruction.id),
        instruction.category === 'medicine'
          ? instructionDurationDays(
              `${instruction.instruction || instruction.original_instruction || ''} ` +
              `${instruction.timing || instruction.original_timing || ''}`,
            )
          : null,
      ]),
    );
    const explicitDays = [...durationDaysByInstruction.values()]
      .filter((value) => Number.isInteger(value) && value > 0 && value <= 3650);
    const scheduleDates = schedule.map((item) => item.date).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value || ''));
    const today = new Date();
    let suggestedEndDate;
    if (explicitDays.length) {
      const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      end.setUTCDate(end.getUTCDate() + Math.max(...explicitDays) - 1);
      suggestedEndDate = end.toISOString().slice(0, 10);
    } else if (scheduleDates.length) {
      suggestedEndDate = scheduleDates.sort().at(-1);
    } else {
      const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 6));
      suggestedEndDate = end.toISOString().slice(0, 10);
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        'DELETE FROM care_schedule_items WHERE care_plan_id = ? AND user_id = ?',
        [planId, req.auth.userId],
      );
      for (const item of schedule) {
        await connection.execute(
          `INSERT INTO care_schedule_items (
            care_plan_id, user_id, instruction_id, title, task_kind,
            schedule_date, schedule_time, display_time, recurrence_text,
            grounding, requires_confirmation, confirmation_status, reason,
            instruction_duration_days
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            planId,
            req.auth.userId,
            item.instructionId,
            item.title,
            item.taskKind,
            item.date,
            item.time,
            item.displayTime,
            item.recurrence,
            item.grounding,
            item.requiresConfirmation ? 1 : 0,
            item.requiresConfirmation ? 'needs_confirmation' : 'ready',
            item.reason,
            durationDaysByInstruction.get(String(item.instructionId)) || null,
          ],
        );
      }
      if ((plans[0].duration_mode || 'prescription') === 'prescription') {
        await connection.execute(
          `UPDATE care_plans SET suggested_end_date = ?, planned_end_date = ?
           WHERE id = ? AND user_id = ?`,
          [suggestedEndDate, suggestedEndDate, planId, req.auth.userId],
        );
      } else {
        await connection.execute(
          'UPDATE care_plans SET suggested_end_date = ? WHERE id = ? AND user_id = ?',
          [suggestedEndDate, planId, req.auth.userId],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    await logAiUsage({
      userId: req.auth.userId,
      carePlanId: planId,
      result: aiResult,
      status: 'success',
      featureName: 'schedule_generation',
    });

    await refreshCareGaps({
      db: pool,
      planId,
      userId: req.auth.userId,
      realityQuestionTemplates,
    });

    res.json({
      success: true,
      message: 'A prescription-grounded schedule draft is ready.',
      data: {
        itemCount: schedule.length,
        readyCount: schedule.filter((item) => !item.requiresConfirmation).length,
        confirmationCount: schedule.filter((item) => item.requiresConfirmation).length,
      },
    });
  } catch (error) {
    if (error instanceof AiServiceError) {
      await logAiUsage({
        userId: req.auth.userId,
        carePlanId: planId,
        result: null,
        status: 'failed',
        errorCode: String(error.statusCode),
        featureName: 'schedule_generation',
      });
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
});

app.patch('/api/schedule-items/:id/confirm', authenticate, async (req, res, next) => {
  try {
    const result = await confirmScheduleItem({
      pool,
      userId: req.auth.userId,
      itemId: req.params.id,
      displayTime: req.body?.displayTime,
      scheduleTime: req.body?.scheduleTime,
      learningSource: req.body?.learningSource,
    });
    if (!result.ok) {
      sendServiceError(res, result);
      return;
    }

    res.json({
      success: true,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
});


function customRealityRiskPoints(note, template) {
  const value = String(note || '').trim().toLowerCase();
  const options = Array.isArray(template?.options) ? template.options : [];
  if (!value || !options.length) return 0;

  const first = Number(options[0]?.points || 0);
  const middle = Number(options[Math.min(1, options.length - 1)]?.points || 0);
  const last = Number(options[options.length - 1]?.points || middle);

  // Strong positive/reliable language.
  if (/\b(yes|always|reliably|reliable|available|arranged|no problem|works well|can do|can follow|can access|have all)\b/.test(value)) {
    return first;
  }

  // Variable/conditional language.
  if (/\b(sometimes|occasionally|depends|change|changes|changing|varies|vary|some days|not always|usually|maybe|partly)\b/.test(value)) {
    return middle;
  }

  // Strong difficulty/unavailability language.
  if (/\b(no|never|cannot|can't|unable|difficult|hard|unavailable|missing|none|not available|not possible)\b/.test(value)) {
    return last;
  }

  // Unknown free text is treated as a practical attention signal rather than
  // as a medical blocker. The user's original wording is still preserved.
  return middle;
}

app.get('/api/care-plans/:id/reality-check', authenticate, async (req, res, next) => {
  const planId = req.params.id;
  if (!idPattern.test(planId)) {
    return res.status(422).json({ success: false, message: 'Invalid care plan ID.' });
  }

  try {
    const result = await readRealityCheckState({
      pool,
      userId: req.auth.userId,
      planId,
      preferredLanguage: await preferredLanguageForRequest(req),
    });
    if (!result.ok) {
      sendServiceError(res, result);
      return;
    }

    res.json({ success: true, data: result.data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/care-plans/:id/reality-check', authenticate, async (req, res, next) => {
  try {
    const result = await saveRealityAnswers({
      pool,
      userId: req.auth.userId,
      planId: req.params.id,
      answers: req.body?.answers,
      questionSetVersion: req.body?.questionSetVersion,
    });
    if (!result.ok) {
      sendServiceError(res, result);
      return;
    }

    res.json({
      success: true,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
});


app.post('/api/care-plans/:id/adapt-plan', authenticate, async (req, res, next) => {
  const planId = req.params.id;
  const rawAdjustments = Array.isArray(req.body?.adjustments)
    ? req.body.adjustments.slice(0, 20)
    : [];
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  const allowedPeriods = new Set(['morning', 'afternoon', 'evening', 'night']);

  if (!idPattern.test(planId)) {
    return res.status(422).json({ success: false, message: 'Invalid care plan ID.' });
  }
  if (rawAdjustments.length === 0) {
    return res.status(422).json({
      success: false,
      message: 'Select at least one routine adjustment before applying the plan.',
    });
  }

  const connection = await pool.getConnection();
  try {
    const [plans] = await connection.execute(
      'SELECT id FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
      [planId, req.auth.userId],
    );
    if (!plans.length) {
      return res.status(404).json({ success: false, message: 'Care plan not found.' });
    }

    const [rows] = await connection.execute(
      `SELECT id, care_plan_id, instruction_id, schedule_date,
        TIME_FORMAT(schedule_time, '%H:%i') AS schedule_time,
        display_time, recurrence_text, grounding, title, task_kind
       FROM care_schedule_items
       WHERE care_plan_id = ? AND user_id = ?
       ORDER BY id`,
      [planId, req.auth.userId],
    );
    const taskById = new Map(rows.map((item) => [String(item.id), item]));
    const projectedTasks = rows.map((item) => ({ ...item }));
    const projectedById = new Map(
      projectedTasks.map((item) => [String(item.id), item]),
    );

    const normalized = [];
    for (const input of rawAdjustments) {
      const taskId = cleanText(input?.taskId, 30);
      const decision = cleanText(input?.decision, 30).toLowerCase();
      const scheduleTime = cleanText(input?.scheduleTime, 5);
      const period = cleanText(input?.period, 20).toLowerCase();
      const task = taskById.get(taskId);

      if (!task) {
        throw new AiServiceError('One of the selected reminder tasks no longer exists. Refresh the simulation and try again.', 409);
      }
      if (!['apply', 'keep_current'].includes(decision)) {
        throw new AiServiceError('Choose Apply or Keep current for every selected adjustment.', 422);
      }
      if (!allowedPeriods.has(period) || !timePattern.test(scheduleTime)) {
        throw new AiServiceError('One of the selected reminder times is invalid. Review the suggested times and try again.', 422);
      }

      const originalPeriod = schedulePeriodKey(task.display_time);
      if (originalPeriod && originalPeriod !== period) {
        throw new AiServiceError(
          `The ${task.title || 'reminder'} adjustment must stay inside its verified ${originalPeriod} period.`,
          422,
        );
      }

      const window = scheduleWindow(period);
      const minutes = scheduleTimeToMinutes(scheduleTime);
      if (minutes == null || !timeFitsScheduleWindow(minutes, window)) {
        throw new AiServiceError(
          `Select a time within ${window?.label || period} for ${task.title || 'this reminder'}.`,
          422,
        );
      }

      if (decision === 'apply') {
        if (String(task.grounding || '') === 'explicit') {
          throw new AiServiceError(
            `SehatMate will not automatically move the explicit verified time for ${task.title || 'this reminder'}.`,
            409,
          );
        }

        const projectedTask = projectedById.get(taskId);
        if (hasPracticalScheduleConflict(projectedTask, scheduleTime, projectedTasks)) {
          throw new AiServiceError(
            `The suggested time for ${task.title || 'a reminder'} now conflicts with another task. Refresh the simulation for a new suggestion.`,
            409,
          );
        }

        // Preserve the same-instruction rules used by the normal Set time flow.
        const siblingConflict = projectedTasks.find((other) => {
          if (String(other.id) === taskId) return false;
          if (String(other.instruction_id || '') !== String(task.instruction_id || '')) return false;
          if (String(other.schedule_date || '') !== String(task.schedule_date || '')) return false;
          const otherTime = String(other.schedule_time || '').slice(0, 5);
          const otherPeriod = schedulePeriodKey(other.display_time);
          return otherTime === scheduleTime || (period && otherPeriod === period);
        });
        if (siblingConflict) {
          throw new AiServiceError(
            `Another reminder for ${task.title || 'this instruction'} already uses that period or exact time.`,
            409,
          );
        }

        projectedTask.schedule_time = scheduleTime;
        projectedTask.display_time = `${periodDisplayLabel(period)} · Confirmed reminder at ${formatScheduleTime(scheduleTime)}`;
      }

      normalized.push({ taskId, task, decision, scheduleTime, period });
    }

    await connection.beginTransaction();
    let appliedCount = 0;
    let keptCount = 0;

    for (const item of normalized) {
      if (item.decision === 'keep_current') {
        keptCount += 1;
        await recordRoutineLearningEvent({
          db: connection,
          userId: req.auth.userId,
          carePlanId: planId,
          eventType: 'suggestion_rejected',
          period: item.period,
          scheduleTime: item.scheduleTime,
          signalValue: item.task.title || 'Kept current reminder',
          metadata: {
            taskId: item.taskId,
            source: 'adapt_my_plan',
          },
        });
        continue;
      }

      const displayTime = `${periodDisplayLabel(item.period)} · Confirmed reminder at ${formatScheduleTime(item.scheduleTime)}`;
      const previousTime = String(item.task.schedule_time || '').slice(0, 5);
      await connection.execute(
        `UPDATE care_schedule_items
         SET schedule_time = ?, display_time = ?, requires_confirmation = 0,
             confirmation_status = 'ready', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND care_plan_id = ? AND user_id = ?`,
        [item.scheduleTime, displayTime, item.taskId, planId, req.auth.userId],
      );
      await connection.execute(
        `UPDATE care_task_occurrences
         SET scheduled_at = CONCAT(occurrence_date, ' ', ?, ':00'),
             updated_at = CURRENT_TIMESTAMP
         WHERE schedule_item_id = ? AND user_id = ? AND status = 'pending'`,
        [item.scheduleTime, item.taskId, req.auth.userId],
      );
      appliedCount += 1;

      if (previousTime !== item.scheduleTime) {
        await recordRoutineLearningEvent({
          db: connection,
          userId: req.auth.userId,
          carePlanId: planId,
          eventType: 'suggestion_accepted',
          period: item.period,
          scheduleTime: item.scheduleTime,
          signalValue: item.task.title || displayTime,
          metadata: {
            taskId: item.taskId,
            previousTime: previousTime || null,
            source: 'adapt_my_plan',
          },
        });
      }
    }

    await connection.commit();

    await refreshCareGaps({
      db: pool,
      planId,
      userId: req.auth.userId,
      realityQuestionTemplates,
    });

    return res.json({
      success: true,
      message: appliedCount > 0
        ? `${appliedCount} routine adjustment${appliedCount === 1 ? '' : 's'} applied. Simulation and Care Gaps are ready to refresh.`
        : 'Current reminders kept. SehatMate saved your choices as routine learning signals.',
      data: { appliedCount, keptCount },
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
      // No active transaction is also safe here.
    }
    next(error);
  } finally {
    try {
      connection.release();
    } catch (_) {
      // Ignore a connection that was already released after an early 404.
    }
  }
});

app.get('/api/care-plans/:id/simulation', authenticate, async (req, res, next) => {
  const planId = req.params.id;
  if (!idPattern.test(planId)) {
    return res.status(422).json({ success: false, message: 'Invalid care plan ID.' });
  }

  try {
    const result = await readSimulationState({
      pool,
      userId: req.auth.userId,
      planId,
    });
    if (!result.ok) {
      sendServiceError(res, result);
      return;
    }

    res.json({ success: true, data: result.data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/care-plans/:id', authenticate, async (req, res, next) => {
  try {
    const result = await readCarePlanDetail({
      pool,
      userId: req.auth.userId,
      planId: req.params.id,
    });
    if (!result.ok) {
      sendServiceError(res, result);
      return;
    }

    res.json({ success: true, data: result.data });
  } catch (error) {
    next(error);
  }
});


app.get('/api/care-plans/:id/care-gaps', authenticate, async (req, res, next) => {
  try {
    const result = await listCareGaps({
      pool,
      userId: req.auth.userId,
      planId: req.params.id,
      lifecycle: req.query?.lifecycle,
      severity: req.query?.severity,
      gapType: req.query?.type,
    });
    if (!result.ok) {
      sendServiceError(res, result);
      return;
    }

    res.json({ success: true, data: result.data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/care-plans/:id/care-gaps/refresh', authenticate, async (req, res, next) => {
  const planId = req.params.id;
  if (!idPattern.test(planId)) {
    res.status(422).json({ success: false, message: 'Invalid care plan ID.' });
    return;
  }

  try {
    const [plans] = await pool.execute(
      'SELECT id FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
      [planId, req.auth.userId],
    );
    if (!plans.length) {
      res.status(404).json({ success: false, message: 'Care plan not found.' });
      return;
    }

    const rows = await refreshCareGaps({
      db: pool,
      planId,
      userId: req.auth.userId,
      realityQuestionTemplates,
    });

    res.json({
      success: true,
      message: 'Care gaps refreshed.',
      data: {
        summary: careGapSummary(rows),
        gaps: rows.map(careGapJson),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/care-gaps/:id', authenticate, async (req, res, next) => {
  try {
    const result = await readCareGapDetail({
      pool,
      userId: req.auth.userId,
      gapId: req.params.id,
    });
    if (!result.ok) {
      sendServiceError(res, result);
      return;
    }

    res.json({ success: true, data: result.data });
  } catch (error) {
    next(error);
  }
});


app.patch('/api/care-gaps/:id', authenticate, async (req, res, next) => {
  try {
    const result = await updateCareGapLifecycle({
      pool,
      userId: req.auth.userId,
      gapId: req.params.id,
      lifecycleStatus: req.body?.lifecycleStatus,
      resolutionNote: req.body?.resolutionNote,
      preferredLanguage: await preferredLanguageForRequest(req),
    });
    if (!result.ok) {
      sendServiceError(res, result);
      return;
    }

    res.json({
      success: true,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/care-gaps/:id/doctor-question', authenticate, async (req, res, next) => {
  const gapId = req.params.id;

  if (!idPattern.test(gapId)) {
    res.status(422).json({
      success: false,
      message: 'Invalid care gap ID.',
    });
    return;
  }

  const groupName =
    cleanText(req.body?.groupName, 60) || 'Care Instructions';

  const title =
    cleanText(req.body?.title, 160) || 'Care-plan clarification';

  const question =
    cleanText(req.body?.question, 2000);

  if (!question) {
    res.status(422).json({
      success: false,
      message:
        'Enter the question you want to verify with a healthcare professional.',
    });
    return;
  }

  const connection = await pool.getConnection();
  let transactionStarted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    /*
     * Lock the Care Gap row first.
     *
     * This is important because two fast taps, or two requests arriving
     * at nearly the same time, must not both create a pending question.
     *
     * Every request for this exact gap has to wait for this row lock,
     * so after the first request creates a question, the second request
     * sees that pending question and reuses it.
     */
    const [gapRows] = await connection.execute(
      `SELECT
         g.id,
         g.care_plan_id,
         g.lifecycle_status
       FROM care_gaps g
       JOIN care_plans p
         ON p.id = g.care_plan_id
       WHERE g.id = ?
         AND p.user_id = ?
       LIMIT 1
       FOR UPDATE`,
      [
        gapId,
        req.auth.userId,
      ],
    );

    const gap = gapRows[0];

    if (!gap) {
      await connection.rollback();
      transactionStarted = false;

      res.status(404).json({
        success: false,
        message: 'Care gap not found.',
      });
      return;
    }

    /*
     * There should be only ONE pending healthcare-professional
     * question per Care Gap.
     *
     * Answered questions are intentionally NOT included here because
     * they are history and must not be deleted.
     */
    const [pendingQuestions] = await connection.execute(
      `SELECT
         id,
         group_name,
         title,
         question,
         status
       FROM doctor_questions
       WHERE care_gap_id = ?
         AND care_plan_id = ?
         AND status = 'pending'
       ORDER BY id
       FOR UPDATE`,
      [
        gapId,
        gap.care_plan_id,
      ],
    );

    /*
     * Existing pending question found:
     * - Keep the oldest pending question as canonical.
     * - Remove any duplicate pending rows left by older app builds.
     * - Do NOT touch answered questions.
     * - Do NOT create another question.
     */
    if (pendingQuestions.length > 0) {
      const canonicalQuestion = pendingQuestions[0];

      const duplicateCount = Math.max(
        0,
        pendingQuestions.length - 1,
      );

      if (duplicateCount > 0) {
        await connection.execute(
          `DELETE FROM doctor_questions
           WHERE care_gap_id = ?
             AND care_plan_id = ?
             AND status = 'pending'
             AND id <> ?`,
          [
            gapId,
            gap.care_plan_id,
            canonicalQuestion.id,
          ],
        );
      }

      /*
       * Creating/reusing a Doctor Question means this Care Gap is being
       * worked on. Do not reopen a gap that is already resolved.
       */
      await connection.execute(
        `UPDATE care_gaps
         SET lifecycle_status = CASE
           WHEN lifecycle_status = 'resolved'
             THEN lifecycle_status
           ELSE 'in_progress'
         END
         WHERE id = ?`,
        [gapId],
      );

      await connection.commit();
      transactionStarted = false;

      res.status(200).json({
        success: true,
        message:
          duplicateCount > 0
            ? 'Existing pending question kept; duplicate pending questions were removed.'
            : 'A pending healthcare-professional question already exists for this care gap.',
        data: {
          questionId: String(canonicalQuestion.id),
          created: false,
          existing: true,
          deduplicatedCount: duplicateCount,
        },
      });

      return;
    }

    /*
     * No pending question currently exists for this Care Gap,
     * so creating one is safe.
     */
    const [result] = await connection.execute(
      `INSERT INTO doctor_questions (
         care_plan_id,
         care_gap_id,
         group_name,
         title,
         question,
         status
       ) VALUES (?, ?, ?, ?, ?, 'pending')`,
      [
        gap.care_plan_id,
        gapId,
        groupName,
        title,
        question,
      ],
    );

    await connection.execute(
      `UPDATE care_gaps
       SET lifecycle_status = CASE
         WHEN lifecycle_status = 'resolved'
           THEN lifecycle_status
         ELSE 'in_progress'
       END
       WHERE id = ?`,
      [gapId],
    );

    await connection.commit();
    transactionStarted = false;

    res.status(201).json({
      success: true,
      message:
        'Question saved for healthcare-professional verification.',
      data: {
        questionId: String(result.insertId),
        created: true,
        existing: false,
        deduplicatedCount: 0,
      },
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (_) {
        // Preserve the original error.
      }
    }

    next(error);
  } finally {
    connection.release();
  }
});

app.patch('/api/doctor-questions/:id', authenticate, async (req, res, next) => {
  const questionId = req.params.id;
  if (!idPattern.test(questionId)) {
    res.status(422).json({ success: false, message: 'Invalid question ID.' });
    return;
  }

  const answer = cleanText(req.body?.answer, 4000);
  const status = cleanText(req.body?.status, 20).toLowerCase();

  if (!['pending', 'answered'].includes(status)) {
    res.status(422).json({ success: false, message: 'Choose a valid question status.' });
    return;
  }
  if (status === 'answered' && !answer) {
    res.status(422).json({
      success: false,
      message: 'Add the healthcare-professional answer before marking this question answered.',
    });
    return;
  }

  try {
    const [rows] = await pool.execute(
      `SELECT doctor_questions.id, doctor_questions.care_plan_id, doctor_questions.care_gap_id
       FROM doctor_questions
       JOIN care_plans ON care_plans.id = doctor_questions.care_plan_id
       WHERE doctor_questions.id = ? AND care_plans.user_id = ? LIMIT 1`,
      [questionId, req.auth.userId],
    );
    if (!rows.length) {
      res.status(404).json({ success: false, message: 'Question not found.' });
      return;
    }

    await pool.execute(
      `UPDATE doctor_questions
       SET answer = ?, status = ?,
         answered_at = CASE WHEN ? = 'answered' THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE id = ?`,
      [answer || null, status, status, questionId],
    );

    if (rows[0].care_gap_id != null) {
      await pool.execute(
        `UPDATE care_gaps
         SET lifecycle_status = CASE
           WHEN lifecycle_status = 'resolved' THEN lifecycle_status
           ELSE 'in_progress'
         END
         WHERE id = ?`,
        [rows[0].care_gap_id],
      );
    }

    if (
 rows[0].care_gap_id != null) {
  const preferredLanguage = await preferredLanguageForRequest(req);
  try {
    await analyzeAndStoreCareGapContext({
      db: pool,
      gapId: String(
        rows[0].care_gap_id,
      ),
      userId:
        req.auth.userId,
      generateAiText,
      preferredLanguage,
    });
  } catch (contextError) {
    /*
     * The professional answer has already been saved.
     *
     * AI/context analysis is secondary and must never
     * make the primary answer-save operation fail.
     */
    console.error(
      'Care-gap context analysis failed after professional answer:',
      contextError,
    );
  }
}

    res.json({
      success: true,
      message: status === 'answered'
        ? 'Healthcare-professional answer saved.'
        : 'Question updated.',
      data: {},
    });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/care-plans/:id/status', authenticate, async (req, res, next) => {
  const planId = req.params.id;
  const nextStatus = cleanText(req.body?.status, 30);
  if (!idPattern.test(planId) || !carePlanStatuses.has(nextStatus)) {
    res.status(422).json({
      success: false,
      message: 'Enter a valid care plan ID and status.',
    });
    return;
  }

  try {
    const [plans] = await pool.execute(
      'SELECT * FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
      [planId, req.auth.userId],
    );
    const plan = plans[0];
    if (!plan) {
      res.status(404).json({ success: false, message: 'Care plan not found.' });
      return;
    }

    if (plan.status !== nextStatus && !allowedStatusTransitions[plan.status]?.has(nextStatus)) {
      res.status(409).json({
        success: false,
        message: `Care plan cannot move from ${plan.status} to ${nextStatus}.`,
      });
      return;
    }

    if (nextStatus === 'active') {
      if (plan.duration_mode !== 'ongoing' && !plan.planned_end_date) {
        res.status(409).json({ success: false, message: 'Choose the plan duration before activation.' });
        return;
      }

      // A completed finite plan can only be reactivated while its selected
      // plan end date is still valid. This prevents an expired plan from being
      // silently restarted by an accidental Reactivate tap.
      if (
        plan.status === 'completed' &&
        plan.duration_mode !== 'ongoing'
      ) {
        const plannedEnd = dbDateKey(plan.planned_end_date);
        const today = serverDateKey();
        if (plannedEnd && plannedEnd < today) {
          res.status(409).json({
            success: false,
            message:
              'This care plan has already reached its selected end date. Review the plan duration before reactivating it.',
          });
          return;
        }
      }
      const [instructionRows] = await pool.execute(
        `SELECT review_status
         FROM extracted_instructions WHERE care_plan_id = ?`,
        [planId],
      );
      const gapRows = await refreshCareGaps({
        db: pool,
        planId,
        userId: req.auth.userId,
        realityQuestionTemplates,
      });
      const [scheduleRows] = await pool.execute(
        `SELECT task_kind, title, display_time, recurrence_text, reason,
          schedule_time, requires_confirmation
         FROM care_schedule_items
         WHERE care_plan_id = ? AND user_id = ?`,
        [planId, req.auth.userId],
      );
      const [realityAnswers] = await pool.execute(
        `SELECT question_key, selected_answer, risk_points
         FROM care_reality_answers
         WHERE care_plan_id = ? AND user_id = ?`,
        [planId, req.auth.userId],
      );

      const verifiedCount = instructionRows.filter((item) => item.review_status === 'verified').length;
      const pendingCount = instructionRows.filter((item) => item.review_status === 'pending').length;
      const openGapCount = gapRows.filter((item) => item.lifecycle_status !== 'resolved').length;
      const blockingGapCount = gapRows.filter(
        (item) => item.lifecycle_status !== 'resolved' && item.severity === 'blocking',
      ).length;
      const attentionGapCount = gapRows.filter(
        (item) => item.lifecycle_status !== 'resolved' && item.severity !== 'blocking',
      ).length;
      const missingTimeCount = scheduleRows.filter((item) => item.schedule_time == null).length;
      const confirmationCount = scheduleRows.filter((item) => Boolean(item.requires_confirmation)).length;
      const reality = await realityDecisionTemplatesForPlan({
        db: pool,
        planId,
        userId: req.auth.userId,
        tasks: scheduleRows,
        createIfMissing: false,
      });
      const realityTemplates = reality.templates;
      const realityAnswerKeys = new Set(realityAnswers.map((item) => item.question_key));
      const currentRealityAnswers = realityAnswers.filter((item) =>
        realityTemplates.some((template) => template.key === item.question_key));
      const unansweredRealityCount = realityTemplates.filter((template) =>
        !realityAnswerKeys.has(template.key)).length;
      const realityRiskCount = currentRealityAnswers.filter((item) => Number(item.risk_points || 0) > 0).length;

      if (
        verifiedCount === 0 ||
        pendingCount > 0 ||
        blockingGapCount > 0 ||
        scheduleRows.length === 0 ||
        missingTimeCount > 0 ||
        confirmationCount > 0 ||
        unansweredRealityCount > 0
      ) {
        const activationIssues = [];
        if (verifiedCount === 0 || pendingCount > 0) activationIssues.push('instruction review');
        if (blockingGapCount > 0) activationIssues.push('blocking care gaps');
        if (scheduleRows.length === 0 || missingTimeCount > 0 || confirmationCount > 0) activationIssues.push('schedule confirmation');
        if (unansweredRealityCount > 0) activationIssues.push('Reality Check');

        res.status(409).json({
          success: false,
          message: `Resolve the remaining ${activationIssues.join(', ')} item${activationIssues.length === 1 ? '' : 's'} before activation.`,
          data: {
            verifiedCount,
            pendingCount,
            openGapCount,
            blockingGapCount,
            attentionGapCount,
            missingTimeCount,
            confirmationCount,
            unansweredRealityCount,
            realityRiskCount,
          },
        });
        return;
      }
    }

    if (nextStatus === 'active') {
      const reactivating = plan.status === 'completed';
      await pool.execute(
        `UPDATE care_plans
         SET status = ?,
             setup_step = 'complete',
             activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
             completed_at = CASE WHEN ? THEN NULL ELSE completed_at END,
             completion_reason = CASE WHEN ? THEN NULL ELSE completion_reason END,
             completed_by = CASE WHEN ? THEN NULL ELSE completed_by END
         WHERE id = ? AND user_id = ?`,
        [nextStatus, reactivating ? 1 : 0, reactivating ? 1 : 0, reactivating ? 1 : 0, planId, req.auth.userId],
      );
      await recordLifecycleEvent({
        db: pool,
        userId: req.auth.userId,
        planId,
        eventType: reactivating ? 'reactivated' : 'activated',
        reason: reactivating ? 'The completed care plan was reactivated by the user.' : 'Care plan activated.',
      });
      await ensureOccurrencesForDate({
        db: pool,
        userId: req.auth.userId,
        planId,
        dateKey: serverDateKey(),
      });
    } else if (nextStatus === 'completed') {
      await pool.execute(
        `UPDATE care_plans
         SET status = ?,
             setup_step = 'complete',
             completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
             completion_reason = 'manual', completed_by = 'user'
         WHERE id = ? AND user_id = ?`,
        [nextStatus, planId, req.auth.userId],
      );
      await pool.execute(
        `DELETE FROM care_task_occurrences
         WHERE care_plan_id = ? AND user_id = ?
           AND status = 'pending' AND scheduled_at > CURRENT_TIMESTAMP`,
        [planId, req.auth.userId],
      );
      await recordLifecycleEvent({
        db: pool,
        userId: req.auth.userId,
        planId,
        eventType: 'manual_completed',
        reason: 'Care plan completed manually by the user.',
      });
    } else {
      await pool.execute(
        'UPDATE care_plans SET status = ? WHERE id = ? AND user_id = ?',
        [nextStatus, planId, req.auth.userId],
      );
    }
    const [updated] = await pool.execute(
      'SELECT * FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
      [planId, req.auth.userId],
    );

    res.json({
      success: true,
      message: 'Care plan status updated successfully.',
      data: { plan: carePlanJson(updated[0]) },
    });
  } catch (error) {
    next(error);
  }
});



// App-wide task outcome source used by Dashboard and Calendar.
// Every surface reads/writes the same care_task_occurrences rows.
app.get('/api/task-occurrences', authenticate, async (req, res, next) => {
  try {
    const result = await readTodayTasksState({
      pool,
      userId: req.auth.userId,
      date: req.query?.date,
      today: req.query?.today,
    });
    if (!result.ok) {
      sendServiceError(res, result);
      return;
    }
    res.json({ success: true, data: result.data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/task-outcomes/summary', authenticate, async (req, res, next) => {
  try {
    const result = await readTaskOutcomeSummary({
      pool,
      userId: req.auth.userId,
      endDate: req.query?.endDate,
      today: req.query?.today,
      days: req.query?.days,
    });
    if (!result.ok) {
      sendServiceError(res, result);
      return;
    }
    res.json({ success: true, data: result.data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/care-plans/:id/task-occurrences', authenticate, async (req, res, next) => {
  const planId = req.params.id;
  const dateKey = taskOutcomeDate(req.query?.date) || serverDateKey();
  const clientToday = taskOutcomeDate(req.query?.today) || serverDateKey();
  if (!idPattern.test(planId)) {
    return res.status(422).json({ success: false, message: 'Invalid care plan ID.' });
  }

  try {
    await reconcilePlanLifecycle({ db: pool, userId: req.auth.userId, today: clientToday });
    const [plans] = await pool.execute(
      `SELECT id, status FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1`,
      [planId, req.auth.userId],
    );
    if (!plans.length) {
      return res.status(404).json({ success: false, message: 'Care plan not found.' });
    }

    await reconcileMissedOccurrences({
      db: pool,
      userId: req.auth.userId,
      beforeDate: clientToday,
    });
    await reconcileExpiredFixedDurationOccurrences({
      db: pool,
      userId: req.auth.userId,
      planId,
      dateKey,
    });
    await ensureOccurrencesForDate({
      db: pool,
      userId: req.auth.userId,
      planId,
      dateKey,
    });

    const [rows] = await pool.execute(
      `SELECT o.id, o.care_plan_id, o.schedule_item_id, o.occurrence_date,
        TIME_FORMAT(o.scheduled_at, '%H:%i') AS scheduled_time,
        o.status, o.completed_at,
        TIME_FORMAT(o.completed_at, '%H:%i') AS completed_time,
        o.outcome_source, o.note,
        s.title, s.task_kind, s.display_time, s.recurrence_text, s.grounding
       FROM care_task_occurrences o
       JOIN care_schedule_items s ON s.id = o.schedule_item_id
       WHERE o.user_id = ? AND o.care_plan_id = ? AND o.occurrence_date = ?
       ORDER BY o.scheduled_at, o.id`,
      [req.auth.userId, planId, dateKey],
    );

    const summary = rows.reduce((value, row) => {
      value.total += 1;
      if (row.status === 'completed') value.completed += 1;
      else if (row.status === 'skipped') value.skipped += 1;
      else if (row.status === 'missed') value.missed += 1;
      else value.pending += 1;
      return value;
    }, { total: 0, completed: 0, skipped: 0, missed: 0, pending: 0 });

    res.json({
      success: true,
      data: {
        date: dateKey,
        planStatus: plans[0].status,
        occurrences: rows.map(taskOccurrenceJson),
        summary,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/task-occurrences/:id/outcome', authenticate, async (req, res, next) => {
  try {
    const result = await applyTaskOutcome({
      pool,
      userId: req.auth.userId,
      occurrenceId: req.params.id,
      outcome: req.body?.status,
      note: req.body?.note,
      operationKey: req.body?.operationKey,
      baseStatus: req.body?.baseStatus,
      today: req.body?.today,
    });
    if (!result.ok) {
      sendServiceError(res, result);
      return;
    }

    res.json({
      success: true,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/care-plans/:id/task-outcomes/summary', authenticate, async (req, res, next) => {
  const planId = req.params.id;
  const endDate = taskOutcomeDate(req.query?.endDate) || serverDateKey();
  const clientToday = taskOutcomeDate(req.query?.today) || endDate;
  const days = Math.max(1, Math.min(31, Number.parseInt(req.query?.days, 10) || 7));
  const end = new Date(`${endDate}T00:00:00Z`);
  const start = new Date(end.getTime() - ((days - 1) * 86400000));
  const startDate = start.toISOString().slice(0, 10);
  if (!idPattern.test(planId)) {
    return res.status(422).json({ success: false, message: 'Invalid care plan ID.' });
  }

  try {
    const [plans] = await pool.execute(
      `SELECT id FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1`,
      [planId, req.auth.userId],
    );
    if (!plans.length) {
      return res.status(404).json({ success: false, message: 'Care plan not found.' });
    }

    await reconcileMissedOccurrences({ db: pool, userId: req.auth.userId, beforeDate: clientToday });
    await ensureOccurrencesForRange({
      db: pool,
      userId: req.auth.userId,
      planId,
      startDate,
      endDate,
    });

    const [rows] = await pool.execute(
      `SELECT status, scheduled_at, completed_at
       FROM care_task_occurrences
       WHERE user_id = ? AND care_plan_id = ?
         AND occurrence_date BETWEEN ? AND ?`,
      [req.auth.userId, planId, startDate, endDate],
    );

    const summary = rows.reduce((value, row) => {
      value.scheduled += 1;
      if (row.status === 'completed') {
        value.completed += 1;
        const scheduled = new Date(row.scheduled_at);
        const completed = new Date(row.completed_at);
        if (!Number.isNaN(scheduled.getTime()) && !Number.isNaN(completed.getTime())) {
          const deltaMinutes = Math.round((completed.getTime() - scheduled.getTime()) / 60000);
          if (deltaMinutes <= 30) value.onTime += 1;
          else value.late += 1;
        }
      } else if (row.status === 'skipped') value.skipped += 1;
      else if (row.status === 'missed') value.missed += 1;
      else value.pending += 1;
      return value;
    }, { scheduled: 0, completed: 0, onTime: 0, late: 0, skipped: 0, missed: 0, pending: 0 });

    res.json({
      success: true,
      data: { startDate, endDate, days, summary },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/care-plans/:id/lifecycle', authenticate, async (req, res, next) => {
  try {
    const result = await readPlanLifecycleEvents({
      pool,
      userId: req.auth.userId,
      planId: req.params.id,
    });
    if (!result.ok) {
      sendServiceError(res, result);
      return;
    }

    res.json({ success: true, data: result.data });
  } catch (error) {
    next(error);
  }
});


app.get('/api/routine-profile', authenticate, async (req, res, next) => {
  try {
    const profile = await readRoutineProfile(pool, req.auth.userId);
    res.json({ success: true, data: { profile } });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/routine-profile', authenticate, async (req, res, next) => {
  try {
    const profile = await updateRoutineProfile(
      pool,
      req.auth.userId,
      req.body || {},
    );
    res.json({
      success: true,
      message: 'Routine preferences saved.',
      data: { profile },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/routine-profile/reset-learning', authenticate, async (req, res, next) => {
  try {
    const profile = await resetRoutineLearning(pool, req.auth.userId);
    res.json({
      success: true,
      message: 'Learned routine history reset.',
      data: { profile },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/routine-learning/events', authenticate, async (req, res, next) => {
  const eventType = cleanText(req.body?.eventType, 60);
  const allowed = new Set([
    'suggestion_rejected',
    'task_completed',
    'task_missed',
    'task_skipped',
    'caregiver_availability',
  ]);
  if (!allowed.has(eventType)) {
    return res.status(422).json({
      success: false,
      message: 'Invalid routine learning event.',
    });
  }

  const period = cleanText(req.body?.period, 20).toLowerCase();
  const scheduleTime = cleanText(req.body?.scheduleTime, 5);
  const carePlanId = cleanText(req.body?.carePlanId, 30) || null;
  const taskId = cleanText(req.body?.taskId, 30) || null;

  try {
    await recordRoutineLearningEvent({
      db: pool,
      userId: req.auth.userId,
      carePlanId,
      eventType,
      period,
      scheduleTime,
      signalValue: cleanText(req.body?.signalValue, 500),
      metadata: taskId ? { taskId } : null,
    });
    res.json({
      success: true,
      message: 'Routine learning signal saved.',
      data: {},
    });
  } catch (error) {
    next(error);
  }
});

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: 'API route not found.',
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);

  const corsError =
    error?.message === 'Origin is not allowed by CORS.';
  const bodyTooLarge = error?.type === 'entity.too.large';
  const aiError = error instanceof AiServiceError;

  res.status(corsError ? 403 : bodyTooLarge ? 413 : aiError ? error.statusCode : 500).json({
    success: false,
    message: corsError
      ? error.message
      : bodyTooLarge
        ? 'The uploaded document exceeds the 20 MB limit.'
        : aiError
          ? error.message
          : 'The server could not complete this request.',
  });
});


async function ensureMedicalSafetySchema() {
  const [instructionColumns] = await pool.execute(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'extracted_instructions'
       AND COLUMN_NAME IN (
         'original_title',
         'original_instruction',
         'original_timing',
         'duplicate_of_instruction_id',
         'duplicate_reason'
       )`,
  );
  const instructionNames = new Set(
    instructionColumns.map((item) => item.COLUMN_NAME),
  );

  const instructionAlters = [];
  if (!instructionNames.has('original_title')) {
    instructionAlters.push('ADD COLUMN original_title VARCHAR(160) NULL AFTER title');
  }
  if (!instructionNames.has('original_instruction')) {
    instructionAlters.push('ADD COLUMN original_instruction TEXT NULL AFTER instruction');
  }
  if (!instructionNames.has('original_timing')) {
    instructionAlters.push('ADD COLUMN original_timing VARCHAR(160) NULL AFTER timing');
  }
  if (!instructionNames.has('duplicate_of_instruction_id')) {
    instructionAlters.push('ADD COLUMN duplicate_of_instruction_id BIGINT UNSIGNED NULL AFTER safety_note');
  }
  if (!instructionNames.has('duplicate_reason')) {
    instructionAlters.push('ADD COLUMN duplicate_reason VARCHAR(500) NULL AFTER duplicate_of_instruction_id');
  }
  if (instructionAlters.length) {
    await pool.execute(
      `ALTER TABLE extracted_instructions ${instructionAlters.join(', ')}`,
    );
  }

  // Existing rows become their own immutable baseline. Pre-migration edits
  // cannot be reconstructed, but every edit after this migration is traceable.
  await pool.execute(
    `UPDATE extracted_instructions
     SET original_title = COALESCE(NULLIF(original_title, ''), title),
         original_instruction = COALESCE(NULLIF(original_instruction, ''), instruction),
         original_timing = COALESCE(original_timing, timing)
     WHERE original_title IS NULL
        OR original_instruction IS NULL
        OR original_timing IS NULL`,
  );

  const [scheduleColumns] = await pool.execute(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'care_schedule_items'
       AND COLUMN_NAME = 'instruction_duration_days'
     LIMIT 1`,
  );
  if (!scheduleColumns.length) {
    await pool.execute(
      `ALTER TABLE care_schedule_items
       ADD COLUMN instruction_duration_days INT UNSIGNED NULL AFTER reason`,
    );
  }

  const [existingMedicineSchedules] = await pool.execute(
    `SELECT s.id, i.instruction, i.timing
     FROM care_schedule_items s
     JOIN extracted_instructions i ON i.id = s.instruction_id
     WHERE s.instruction_duration_days IS NULL
       AND i.category = 'medicine'`,
  );
  for (const row of existingMedicineSchedules) {
    const days = instructionDurationDays(
      `${row.instruction || ''} ${row.timing || ''}`,
    );
    if (days) {
      await pool.execute(
        `UPDATE care_schedule_items
         SET instruction_duration_days = ?
         WHERE id = ?`,
        [days, row.id],
      );
    }
  }
}

async function cleanupDuplicatePendingDoctorQuestions() {
  /*
   * Older builds allowed Create Doctor Question to insert a new
   * pending row every time the button was tapped.
   *
   * Keep the oldest pending question for each Care Gap and delete
   * only the extra pending copies.
   *
   * Important:
   * - answered questions are preserved
   * - questions not linked to a Care Gap are preserved
   * - no medical instruction or schedule is changed
   */
  const [duplicateGroups] = await pool.execute(
    `SELECT
       care_gap_id,
       care_plan_id,
       MIN(id) AS keep_id,
       COUNT(*) AS pending_count
     FROM doctor_questions
     WHERE status = 'pending'
       AND care_gap_id IS NOT NULL
     GROUP BY
       care_gap_id,
       care_plan_id
     HAVING COUNT(*) > 1`,
  );

  let removedCount = 0;

  for (const group of duplicateGroups) {
    const [result] = await pool.execute(
      `DELETE FROM doctor_questions
       WHERE care_gap_id = ?
         AND care_plan_id = ?
         AND status = 'pending'
         AND id <> ?`,
      [
        group.care_gap_id,
        group.care_plan_id,
        group.keep_id,
      ],
    );

    removedCount += Number(result.affectedRows || 0);
  }

  if (removedCount > 0) {
    console.log(
      `Removed ${removedCount} duplicate pending healthcare-professional question${
        removedCount === 1 ? '' : 's'
      }.`,
    );
  }

  return removedCount;
}

async function ensureAdvancedTaskLifecycleSchema() {
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS care_task_occurrences (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      care_plan_id BIGINT UNSIGNED NOT NULL,
      schedule_item_id BIGINT UNSIGNED NOT NULL,
      occurrence_date DATE NOT NULL,
      scheduled_at DATETIME NOT NULL,
      status ENUM('pending', 'completed', 'skipped', 'missed') NOT NULL DEFAULT 'pending',
      completed_at DATETIME NULL DEFAULT NULL,
      outcome_source VARCHAR(40) NOT NULL DEFAULT 'system',
      note VARCHAR(500) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY care_task_occurrence_unique (schedule_item_id, occurrence_date),
      KEY care_task_occurrence_user_date_idx (user_id, occurrence_date, status),
      KEY care_task_occurrence_plan_date_idx (care_plan_id, occurrence_date, status),
      CONSTRAINT care_task_occurrence_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT care_task_occurrence_plan_fk
        FOREIGN KEY (care_plan_id) REFERENCES care_plans (id) ON DELETE CASCADE,
      CONSTRAINT care_task_occurrence_schedule_fk
        FOREIGN KEY (schedule_item_id) REFERENCES care_schedule_items (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  await pool.execute(
    `CREATE TABLE IF NOT EXISTS care_task_outcome_operations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      occurrence_id BIGINT UNSIGNED NOT NULL,
      operation_key VARCHAR(120) NOT NULL,
      outcome VARCHAR(20) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY care_task_outcome_operation_key_unique (user_id, operation_key),
      KEY care_task_outcome_operation_occurrence_idx (occurrence_id, created_at),
      CONSTRAINT care_task_outcome_operation_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT care_task_outcome_operation_occurrence_fk
        FOREIGN KEY (occurrence_id) REFERENCES care_task_occurrences (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  await pool.execute(
    `DELETE FROM care_task_outcome_operations
     WHERE created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 90 DAY)`,
  );

  await pool.execute(
    `CREATE TABLE IF NOT EXISTS care_plan_lifecycle_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      care_plan_id BIGINT UNSIGNED NOT NULL,
      event_type VARCHAR(60) NOT NULL,
      reason VARCHAR(500) NULL,
      metadata_json LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY care_plan_lifecycle_plan_idx (care_plan_id, created_at),
      KEY care_plan_lifecycle_user_idx (user_id, created_at),
      CONSTRAINT care_plan_lifecycle_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT care_plan_lifecycle_plan_fk
        FOREIGN KEY (care_plan_id) REFERENCES care_plans (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  const [columns] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'care_plans'
       AND COLUMN_NAME IN ('completion_reason', 'completed_by')`,
  );
  const names = new Set(columns.map((item) => item.COLUMN_NAME));
  if (!names.has('completion_reason')) {
    await pool.execute(
      `ALTER TABLE care_plans ADD COLUMN completion_reason VARCHAR(80) NULL AFTER completed_at`,
    );
  }
  if (!names.has('completed_by')) {
    await pool.execute(
      `ALTER TABLE care_plans ADD COLUMN completed_by VARCHAR(40) NULL AFTER completion_reason`,
    );
  }
}

async function ensureSetupProgressSchema() {
  const [columns] = await pool.execute(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'care_plans'
       AND COLUMN_NAME = 'setup_step'
     LIMIT 1`,
  );

  if (!columns.length) {
    await pool.execute(
      `ALTER TABLE care_plans
       ADD COLUMN setup_step ENUM(
         'upload',
         'review',
         'schedule',
         'reality_check',
         'simulation',
         'care_gaps',
         'activate',
         'complete'
       ) NULL DEFAULT NULL AFTER status`,
    );
  }
}

let server;

let lifecycleInterval;

async function startServer() {
  await pool.query('SELECT 1');

 await ensureSetupProgressSchema();
await ensureRoutineLearningSchema(pool);
await ensureRealityCheckPersistenceSchema(pool);
await ensureMedicalSafetySchema();
await ensureAdvancedTaskLifecycleSchema();
await ensureCareContextSchema(pool);

  /*
   * Clean duplicate pending Doctor Questions created by older builds
   * before the API starts accepting requests.
   */
  await cleanupDuplicatePendingDoctorQuestions();

  await reconcilePlanLifecycle({ db: pool });

  lifecycleInterval = setInterval(() => {
    reconcilePlanLifecycle({ db: pool }).catch((error) => {
      console.error(
        'Care-plan lifecycle reconciliation failed.',
        error,
      );
    });
  }, 60 * 60 * 1000);

  lifecycleInterval.unref?.();

  server = app.listen(port, '0.0.0.0', () => {
    console.log(`SehatMate API listening on port ${port}`);
  });
}

async function shutdown(signal) {
  console.log(`${signal} received. Closing server.`);
  if (lifecycleInterval) clearInterval(lifecycleInterval);

  if (!server) {
    await pool.end();
    process.exit(0);
    return;
  }

  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

startServer().catch(async (error) => {
  console.error('SehatMate API failed to start.', error);
  await pool.end();
  process.exit(1);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
