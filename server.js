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
  aiConfiguration,
  extractCareInstructions,
  generateAiText,
} from './ai_service.js';

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

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const idPattern = /^[1-9]\d*$/;
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
  completed: new Set(),
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

function cleanText(value, maxLength) {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, maxLength)
    : '';
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

function carePlanJson(row) {
  return {
    id: String(row.id),
    title: row.title,
    status: row.status,
    startDate: row.start_date,
    readinessScore: Number(row.readiness_score || 0),
    understandingScore: Number(row.understanding_score || 0),
    activatedAt: row.activated_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    documentCount: Number(row.document_count || 0),
    taskCount: Number(row.task_count || 0),
    openGapCount: Number(row.open_gap_count || 0),
  };
}

function parseStoredJson(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

function parseAiInstructions(text) {
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

    return {
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

function parseSafetyCheck(text, citations) {
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
      : 'No matching trusted source was found. The written instruction has not been changed.',
    possibleInterpretation: hasSources
      ? cleanText(value?.possibleInterpretation, 2000)
      : null,
    questionForProfessional: cleanText(value?.questionForProfessional, 1000) ||
      'Please confirm the exact medicine, amount per dose, frequency, route, and duration written here.',
    sources,
  };
}

function trustedSourceFallback(instruction, reason = 'automatic lookup unavailable') {
  const title = cleanText(instruction?.title, 160) || 'care instruction';
  const query = encodeURIComponent(title);
  const category = cleanText(instruction?.category, 40).toLowerCase();

  const sources = category === 'medicine'
    ? [
        {
          title: `DailyMed medicine search for ${title}`,
          url: `https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=${query}`,
        },
        {
          title: 'NHS Medicines A to Z',
          url: 'https://www.nhs.uk/medicines/',
        },
        {
          title: 'MedlinePlus Drugs and Supplements',
          url: 'https://medlineplus.gov/druginformation.html',
        },
      ]
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
      `Trusted databases could not verify “${title}” because ${reason}. This does not mean the instruction is correct or incorrect. The extracted instruction has not been changed.`,
    possibleInterpretation: null,
    questionForProfessional:
      `Please confirm whether “${title}” and its exact amount, timing, frequency, route, and duration match the original instruction.`,
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
  const dailyMedApiUrl = `https://dailymed.nlm.nih.gov/dailymed/services/v2/drugnames.json?drug_name=${encodedTerm}&name_type=both&pagesize=5&page=1`;
  const dailyMedSearchUrl = `https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=${encodedTerm}`;

  const [rxNormResult, dailyMedResult] = await Promise.allSettled([
    fetchTrustedJson(rxNormApiUrl),
    fetchTrustedJson(dailyMedApiUrl),
  ]);

  const rxNormIds = rxNormResult.status === 'fulfilled' && Array.isArray(rxNormResult.value?.idGroup?.rxnormId)
    ? rxNormResult.value.idGroup.rxnormId.map((id) => cleanText(id, 40)).filter(Boolean).slice(0, 3)
    : [];
  const dailyMedNames = dailyMedResult.status === 'fulfilled' && Array.isArray(dailyMedResult.value?.data)
    ? dailyMedResult.value.data
        .map((item) => cleanText(item?.drug_name, 200))
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const sourceReached = rxNormResult.status === 'fulfilled' || dailyMedResult.status === 'fulfilled';
  const sources = [
    { title: `RxNorm exact/normalized lookup for “${lookupTerm}”`, url: rxNormApiUrl },
    { title: `DailyMed label search for “${lookupTerm}”`, url: dailyMedSearchUrl },
  ];

  if (rxNormIds.length === 0 && dailyMedNames.length === 0) {
    if (!sourceReached) {
      return trustedSourceFallback(instruction, 'the official services could not be reached');
    }
    return {
      status: 'source_not_found',
      summary:
        `No exact or normalized medicine-name match for “${lookupTerm}” was found in RxNorm or DailyMed. It may be a local brand, a supplement, or unclear handwriting; this result does not prove the product is invalid. The extracted instruction has not been changed.`,
      possibleInterpretation: null,
      questionForProfessional:
        `Please confirm the exact spelling and active ingredients of “${originalTitle}”, plus the amount per dose, frequency, route, and duration.`,
      sources,
    };
  }

  const matchedText = dailyMedNames.length > 0
    ? dailyMedNames.map((name) => `“${name}”`).join(', ')
    : `${rxNormIds.length} RxNorm concept${rxNormIds.length === 1 ? '' : 's'}`;
  return {
    status: 'needs_confirmation',
    summary:
      `A trusted medicine-name lookup returned ${matchedText} for “${lookupTerm}”. This confirms only that a similar database name exists; it does not verify the handwriting, patient-specific dose, frequency, route, or duration. The extracted instruction has not been changed.`,
    possibleInterpretation: null,
    questionForProfessional:
      `Please confirm whether “${originalTitle}” is the intended medicine and confirm its exact active ingredients, amount per dose, frequency, route, and duration.`,
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
    const [rows] = await pool.execute(
      `SELECT care_plans.*,
        (SELECT COUNT(*) FROM care_documents
          WHERE care_documents.care_plan_id = care_plans.id) AS document_count,
        (SELECT COUNT(*) FROM care_tasks
          WHERE care_tasks.care_plan_id = care_plans.id) AS task_count,
        (SELECT COUNT(*) FROM care_gaps
          WHERE care_gaps.care_plan_id = care_plans.id
            AND care_gaps.status <> 'resolved') AS open_gap_count
       FROM care_plans
       WHERE care_plans.user_id = ?
       ORDER BY care_plans.updated_at DESC`,
      [req.auth.userId],
    );

    res.json({
      success: true,
      data: { plans: rows.map(carePlanJson) },
    });
  } catch (error) {
    next(error);
  }
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
      `INSERT INTO care_plans (user_id, title, status)
       VALUES (?, ?, 'draft')`,
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
          });
          const instructions = parseAiInstructions(aiResult.text);
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
            for (const instruction of instructions) {
              await connection.execute(
                `INSERT INTO extracted_instructions (
                  care_plan_id, document_id, category, title, instruction,
                  timing, source_page, confidence_score, review_status,
                  requires_professional_confirmation, ambiguity_reason,
                  possible_interpretation, safety_note
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  planId,
                  document.id,
                  instruction.category,
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
                ],
              );
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
            errorCode: error?.statusCode ? String(error.statusCode) : 'extraction_failed',
          });
        }
      }

      const [[totals]] = await pool.execute(
        'SELECT COUNT(*) AS instruction_count FROM extracted_instructions WHERE care_plan_id = ?',
        [planId],
      );
      const totalInstructions = Number(totals.instruction_count || 0);
      await pool.execute(
        'UPDATE care_plans SET status = ? WHERE id = ? AND user_id = ?',
        [totalInstructions > 0 ? 'needs_review' : 'processing', planId, req.auth.userId],
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
      `SELECT extracted_instructions.id
       FROM extracted_instructions
       JOIN care_plans ON care_plans.id = extracted_instructions.care_plan_id
       WHERE extracted_instructions.id = ? AND care_plans.user_id = ? LIMIT 1`,
      [instructionId, req.auth.userId],
    );
    if (rows.length === 0) {
      res.status(404).json({ success: false, message: 'Instruction not found.' });
      return;
    }

    await pool.execute(
      `UPDATE extracted_instructions SET
        title = CASE WHEN ? <> '' THEN ? ELSE title END,
        instruction = CASE WHEN ? <> '' THEN ? ELSE instruction END,
        timing = NULLIF(?, ''),
        review_status = ?,
        requires_professional_confirmation = CASE WHEN ? = 'verified' THEN 0 ELSE requires_professional_confirmation END,
        verified_by = CASE WHEN ? = 'verified' THEN ? ELSE NULL END,
        verified_at = CASE WHEN ? = 'verified' THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE id = ?`,
      [
        title, title,
        instruction, instruction,
        timing,
        reviewStatus,
        reviewStatus,
        reviewStatus, req.auth.userId,
        reviewStatus,
        instructionId,
      ],
    );

    res.json({ success: true, message: 'Instruction review saved.', data: {} });
  } catch (error) {
    next(error);
  }
});

app.get('/api/care-plans/:id', authenticate, async (req, res, next) => {
  const planId = req.params.id;
  if (!idPattern.test(planId)) {
    res.status(422).json({ success: false, message: 'Invalid care plan ID.' });
    return;
  }

  try {
    const [plans] = await pool.execute(
      'SELECT * FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
      [planId, req.auth.userId],
    );
    if (plans.length === 0) {
      res.status(404).json({ success: false, message: 'Care plan not found.' });
      return;
    }

    const [documents] = await pool.execute(
      `SELECT id, document_type, original_name, mime_type, file_size_bytes,
        page_count, processing_status, processing_error, created_at
       FROM care_documents
       WHERE care_plan_id = ? AND user_id = ? ORDER BY created_at DESC`,
      [planId, req.auth.userId],
    );
    const [instructions] = await pool.execute(
      `SELECT id, document_id, category, title, instruction, timing,
        source_page, confidence_score, review_status,
        requires_professional_confirmation, ambiguity_reason,
        possible_interpretation, safety_note, safety_check_status,
        safety_check_summary, safety_possible_interpretation,
        safety_question, safety_sources,
        safety_checked_at, verified_at
       FROM extracted_instructions
       WHERE care_plan_id = ? ORDER BY id`,
      [planId],
    );
    const [tasks] = await pool.execute(
      `SELECT id, instruction_id, caregiver_id, task_date, task_time,
        title, note, task_kind, status, completed_at
       FROM care_tasks WHERE care_plan_id = ?
       ORDER BY task_date, task_time, id`,
      [planId],
    );
    const [gaps] = await pool.execute(
      `SELECT id, task_id, category, title, status, when_text, summary,
        instruction_snapshot, patient_reality, reason, next_step,
        resolution_note, resolved_at
       FROM care_gaps WHERE care_plan_id = ? ORDER BY id`,
      [planId],
    );
    const [caregivers] = await pool.execute(
      `SELECT id, name, relationship, phone, availability, helps_with,
        access_permissions
       FROM caregivers
       WHERE user_id = ? AND (care_plan_id = ? OR care_plan_id IS NULL)
       ORDER BY name`,
      [req.auth.userId, planId],
    );
    const [questions] = await pool.execute(
      `SELECT id, care_gap_id, group_name, title, question, answer,
        status, answered_at
       FROM doctor_questions WHERE care_plan_id = ? ORDER BY id`,
      [planId],
    );

    res.json({
      success: true,
      data: {
        plan: carePlanJson(plans[0]),
        documents: documents.map((item) => ({ ...item, id: String(item.id) })),
        instructions: instructions
          .filter((item) => cleanText(item.title, 160) && cleanText(item.instruction, 4000))
          .map((item) => ({
            ...item,
            id: String(item.id),
            title: cleanText(item.title, 160),
            instruction: cleanText(item.instruction, 4000),
            timing: cleanText(item.timing, 160) || null,
            document_id: item.document_id == null ? null : String(item.document_id),
            safety_sources: parseStoredJson(item.safety_sources),
          })),
        tasks: tasks.map((item) => ({
          ...item,
          id: String(item.id),
          instruction_id: item.instruction_id == null ? null : String(item.instruction_id),
          caregiver_id: item.caregiver_id == null ? null : String(item.caregiver_id),
        })),
        gaps: gaps.map((item) => ({
          ...item,
          id: String(item.id),
          task_id: item.task_id == null ? null : String(item.task_id),
        })),
        caregivers: caregivers.map((item) => ({
          ...item,
          id: String(item.id),
          helps_with: parseStoredJson(item.helps_with),
          access_permissions: parseStoredJson(item.access_permissions),
        })),
        questions: questions.map((item) => ({
          ...item,
          id: String(item.id),
          care_gap_id: item.care_gap_id == null ? null : String(item.care_gap_id),
        })),
      },
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
      const [[instructionCounts]] = await pool.execute(
        `SELECT
          SUM(review_status = 'verified') AS verified_count,
          SUM(review_status IN ('pending', 'unclear')) AS unresolved_count
         FROM extracted_instructions WHERE care_plan_id = ?`,
        [planId],
      );
      const [[gapCounts]] = await pool.execute(
        `SELECT COUNT(*) AS open_count FROM care_gaps
         WHERE care_plan_id = ? AND status <> 'resolved'`,
        [planId],
      );

      if (
        Number(instructionCounts.verified_count || 0) === 0 ||
        Number(instructionCounts.unresolved_count || 0) > 0 ||
        Number(gapCounts.open_count || 0) > 0
      ) {
        res.status(409).json({
          success: false,
          message: 'Verify instructions and resolve every care gap before activation.',
        });
        return;
      }
    }

    await pool.execute(
      `UPDATE care_plans SET
        status = ?,
        activated_at = CASE
          WHEN ? = 'active' THEN COALESCE(activated_at, CURRENT_TIMESTAMP)
          ELSE activated_at
        END,
        completed_at = CASE
          WHEN ? = 'completed' THEN COALESCE(completed_at, CURRENT_TIMESTAMP)
          ELSE completed_at
        END
       WHERE id = ? AND user_id = ?`,
      [nextStatus, nextStatus, nextStatus, planId, req.auth.userId],
    );
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

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`SehatRoute API listening on port ${port}`);
});

async function shutdown(signal) {
  console.log(`${signal} received. Closing server.`);

  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
