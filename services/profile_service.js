import { normalizePreferredLanguage } from '../language_support.js';
import { cleanText } from './shared_utils.js';

const usingForOptions = new Set(['Myself', 'Someone I care for']);
const ageGroups = new Set([
  'Under 18',
  '18 - 30',
  '18 – 30',
  '31 - 45',
  '31 – 45',
  '46 - 59',
  '46 – 59',
  '60 - 70',
  '60 – 70',
  '71 - 80',
  '71 – 80',
  '81+',
]);
const accessibilityModes = new Set([
  'Standard',
  'Large Text',
  'Voice Guidance',
  'Simple Care Mode',
]);

function normalizeBool(value) {
  return value === true || value === 1 || value === '1';
}

function normalizeAgeGroup(value) {
  return cleanText(value, 20).replace(/ - /g, ' – ');
}

export function validateProfile(body = {}) {
  const usingFor = cleanText(body.usingFor, 40);
  const patientName = cleanText(body.patientName, 80);
  const ageGroup = normalizeAgeGroup(body.ageGroup);
  const city = cleanText(body.city, 100);
  const preferredLanguage = normalizePreferredLanguage(body.preferredLanguage);
  const accessibilityMode =
    cleanText(body.accessibilityMode, 40) || 'Standard';
  const caregiverSupport = normalizeBool(body.caregiverSupport);

  if (!usingForOptions.has(usingFor)) {
    return { error: 'Select who this care plan is for.' };
  }
  if (patientName.length < 2) {
    return { error: 'Patient name must contain at least 2 characters.' };
  }
  if (ageGroup && !ageGroups.has(ageGroup)) {
    return { error: 'Select a valid age group.' };
  }
  if (city && city.length < 2) {
    return { error: 'City must contain at least 2 characters.' };
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

export function profileJson(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    usingFor: cleanText(row.using_for, 40),
    patientName: cleanText(row.patient_name, 80),
    ageGroup: normalizeAgeGroup(row.age_group),
    city: cleanText(row.city, 100),
    preferredLanguage: normalizePreferredLanguage(row.preferred_language),
    accessibilityMode: cleanText(row.accessibility_mode, 40) || 'Standard',
    caregiverSupport: normalizeBool(row.caregiver_support),
    onboardingCompleted: normalizeBool(row.onboarding_completed),
  };
}

export async function saveProfile(pool, userId, profile, onboardingCompleted) {
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

  await pool.execute(
    'UPDATE users SET name = ? WHERE id = ?',
    [profile.patientName, userId],
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
