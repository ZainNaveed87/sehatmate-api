import assert from 'node:assert/strict';

import {
  profileJson,
  saveProfile,
  validateProfile,
} from './services/profile_service.js';

function validProfile(overrides = {}) {
  return {
    usingFor: 'Myself',
    patientName: 'Sara Khan',
    ageGroup: '',
    city: '',
    preferredLanguage: 'roman urdu',
    accessibilityMode: '',
    caregiverSupport: false,
    ...overrides,
  };
}

function createPool() {
  const calls = [];
  const state = {
    userName: 'Old Name',
    row: {
      id: 7,
      using_for: 'Myself',
      patient_name: 'Old Name',
      age_group: '',
      city: '',
      preferred_language: 'English',
      accessibility_mode: 'Standard',
      caregiver_support: 0,
      onboarding_completed: 0,
    },
  };

  return {
    calls,
    state,
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('INSERT INTO patient_profiles')) {
        state.row = {
          id: 7,
          using_for: params[1],
          patient_name: params[2],
          age_group: params[3],
          city: params[4],
          preferred_language: params[5],
          accessibility_mode: params[6],
          caregiver_support: params[7],
          onboarding_completed: params[8],
        };
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE users SET name')) {
        state.userName = params[0];
        state.updatedUserId = params[1];
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('SELECT id, using_for')) {
        return [[state.row]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

const optional = validateProfile(validProfile());
assert.equal(optional.error, undefined);
assert.equal(optional.value.ageGroup, '');
assert.equal(optional.value.city, '');
assert.equal(optional.value.preferredLanguage, 'Roman Urdu');
assert.equal(optional.value.accessibilityMode, 'Standard');

const invalidAge = validateProfile(validProfile({ ageGroup: '101 - 120' }));
assert.equal(invalidAge.error, 'Select a valid age group.');

const invalidName = validateProfile(validProfile({ patientName: 'A' }));
assert.equal(
  invalidName.error,
  'Patient name must contain at least 2 characters.',
);

const serialized = profileJson({
  id: 9,
  using_for: 'Someone I care for',
  patient_name: 'Amina',
  age_group: null,
  city: null,
  preferred_language: 'Urdu',
  accessibility_mode: null,
  caregiver_support: 1,
  onboarding_completed: 1,
  email: 'hidden@example.com',
  password_hash: 'secret',
});
assert.deepEqual(Object.keys(serialized), [
  'id',
  'usingFor',
  'patientName',
  'ageGroup',
  'city',
  'preferredLanguage',
  'accessibilityMode',
  'caregiverSupport',
  'onboardingCompleted',
]);
assert.equal(serialized.ageGroup, '');
assert.equal(serialized.city, '');
assert.equal(serialized.preferredLanguage, 'Urdu');
assert.equal(serialized.accessibilityMode, 'Standard');

const pool = createPool();
const saved = await saveProfile(
  pool,
  '42',
  {
    ...optional.value,
    userId: '999',
  },
  true,
);

assert.equal(pool.calls[0].params[0], '42');
assert.equal(pool.calls[1].params[1], '42');
assert.equal(pool.state.userName, 'Sara Khan');
assert.equal(pool.state.updatedUserId, '42');
assert.equal(saved.patientName, 'Sara Khan');
assert.equal(saved.onboardingCompleted, true);

console.log('profile service tests passed');
