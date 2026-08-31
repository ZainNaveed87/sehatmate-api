import crypto from 'node:crypto';

import {
  generatePersonalizedRealityCheckQuestions,
  REALITY_CHECK_MAX_QUESTIONS,
} from './reality_check_engine.js';

export const REALITY_CHECK_GENERATOR_VERSION = 'reality-ai-v2-wording-safety';

function cleanText(value, maxLength = 500) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function normalizeId(value) {
  return value == null ? '' : String(value).trim();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      const normalized = canonicalize(value[key]);
      if (normalized !== undefined) result[key] = normalized;
      return result;
    }, {});
}

function hashValue(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function normalizedInstructions(instructions) {
  if (!Array.isArray(instructions)) return [];
  return instructions.map((item) => ({
    id: normalizeId(item?.id ?? item?.instructionId ?? item?.instruction_id),
    category: cleanText(item?.category, 40),
    title: cleanText(item?.title, 180),
    instruction: cleanText(item?.instruction, 700),
    timing: cleanText(item?.timing, 180),
    reviewStatus: cleanText(item?.reviewStatus ?? item?.review_status, 40),
    requiresProfessionalConfirmation: Boolean(
      item?.requiresProfessionalConfirmation ?? item?.requires_professional_confirmation,
    ),
  }));
}

function normalizedTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.map((item) => ({
    id: normalizeId(item?.id ?? item?.taskId ?? item?.task_id),
    instructionId: normalizeId(item?.instructionId ?? item?.instruction_id),
    taskKind: cleanText(item?.taskKind ?? item?.task_kind, 40),
    title: cleanText(item?.title, 180),
    scheduleDate: cleanText(item?.scheduleDate ?? item?.schedule_date, 20),
    scheduleTime: cleanText(item?.scheduleTime ?? item?.schedule_time, 20),
    displayTime: cleanText(item?.displayTime ?? item?.display_time, 120),
    recurrenceText: cleanText(item?.recurrenceText ?? item?.recurrence_text, 180),
    grounding: cleanText(item?.grounding, 30),
    reason: cleanText(item?.reason, 320),
  }));
}

function normalizedRoutineProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return canonicalize({
    learningEnabled: profile.learningEnabled !== false,
    preferredReminderStyle: cleanText(profile.preferredReminderStyle, 40),
    notes: profile.notes || {},
    learned: profile.learned || {},
  });
}

function normalizedKnownFacts(facts) {
  if (!Array.isArray(facts)) return [];
  return facts.map((item) => {
    if (typeof item === 'string') return cleanText(item, 400);
    return canonicalize({
      intent: cleanText(item?.intent, 60),
      period: cleanText(item?.period, 20),
      fact: cleanText(item?.fact ?? item?.value ?? item?.signalValue, 400),
      confidence: cleanText(item?.confidence, 40),
    });
  });
}

/**
 * Hashes the complete generation context. Layer 2 never silently replaces an
 * active set just because this hash changes; callers must explicitly request a
 * refresh. This prevents Reality Check answers from causing regeneration loops
 * through routine-learning updates.
 */
export function buildRealityCheckContextHash({
  instructions = [],
  tasks = [],
  routineProfile = null,
  knownRealityFacts = [],
}) {
  return hashValue({
    instructions: normalizedInstructions(instructions),
    tasks: normalizedTasks(tasks),
    routineProfile: normalizedRoutineProfile(routineProfile),
    knownRealityFacts: normalizedKnownFacts(knownRealityFacts),
  });
}

/** Stable across wording changes for the same practical concern. */
export function buildStableRealityQuestionKey(question) {
  const intent = cleanText(question?.intent, 60).toLowerCase();
  const period = cleanText(question?.period, 20).toLowerCase() || 'any';
  const responseProfile = cleanText(question?.responseProfile, 60).toLowerCase();
  const targets = Array.isArray(question?.targetTaskIds)
    ? [...new Set(question.targetTaskIds.map(normalizeId).filter(Boolean))].sort()
    : [];

  const digest = hashValue({ intent, period, responseProfile, targets }).slice(0, 24);
  return `rq_${digest}`;
}

function rowToQuestion(row) {
  let targetTaskIds = [];
  try {
    const parsed = JSON.parse(row.target_task_ids_json || '[]');
    if (Array.isArray(parsed)) targetTaskIds = parsed.map(String);
  } catch {
    targetTaskIds = [];
  }
  return {
    id: String(row.id),
    key: row.question_key,
    intent: row.intent,
    category: row.category,
    question: row.question_text,
    responseProfile: row.response_profile,
    targetTaskIds,
    period: row.period,
    reasonForAsking: row.reason_for_asking,
    source: row.source || 'ai_generated',
    status: row.status,
  };
}

function rowToQuestionSet(row, questions = []) {
  if (!row) return null;
  return {
    id: String(row.id),
    carePlanId: String(row.care_plan_id),
    userId: String(row.user_id),
    contextHash: row.context_hash,
    version: Number(row.version),
    generatorVersion: row.generator_version,
    status: row.status,
    questionCount: Number(row.question_count || questions.length),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    questions,
  };
}

export async function ensureRealityCheckPersistenceSchema(db) {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS care_reality_question_sets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      care_plan_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      context_hash CHAR(64) NOT NULL,
      version INT UNSIGNED NOT NULL,
      generator_version VARCHAR(60) NOT NULL,
      status ENUM('active', 'retired') NOT NULL DEFAULT 'active',
      question_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY care_reality_question_set_version_unique (care_plan_id, user_id, version),
      KEY care_reality_question_set_active_idx (care_plan_id, user_id, status, created_at),
      KEY care_reality_question_set_context_idx (care_plan_id, user_id, context_hash),
      CONSTRAINT care_reality_question_set_plan_fk
        FOREIGN KEY (care_plan_id) REFERENCES care_plans (id) ON DELETE CASCADE,
      CONSTRAINT care_reality_question_set_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  await db.execute(
    `CREATE TABLE IF NOT EXISTS care_reality_questions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      question_set_id BIGINT UNSIGNED NOT NULL,
      care_plan_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      question_key VARCHAR(80) NOT NULL,
      ordinal SMALLINT UNSIGNED NOT NULL,
      intent VARCHAR(60) NOT NULL,
      category VARCHAR(80) NOT NULL,
      question_text VARCHAR(500) NOT NULL,
      response_profile VARCHAR(60) NOT NULL,
      target_task_ids_json LONGTEXT NOT NULL,
      period VARCHAR(20) NOT NULL DEFAULT 'any',
      reason_for_asking VARCHAR(500) NOT NULL,
      source VARCHAR(40) NOT NULL DEFAULT 'ai_generated',
      status ENUM('active', 'retired') NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY care_reality_question_set_key_unique (question_set_id, question_key),
      KEY care_reality_question_plan_key_idx (care_plan_id, user_id, question_key),
      KEY care_reality_question_status_idx (question_set_id, status, ordinal),
      CONSTRAINT care_reality_question_set_fk
        FOREIGN KEY (question_set_id) REFERENCES care_reality_question_sets (id) ON DELETE CASCADE,
      CONSTRAINT care_reality_question_plan_fk
        FOREIGN KEY (care_plan_id) REFERENCES care_plans (id) ON DELETE CASCADE,
      CONSTRAINT care_reality_question_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
}

export async function readActiveRealityQuestionSet({ db, planId, userId }) {
  const [sets] = await db.execute(
    `SELECT id, care_plan_id, user_id, context_hash, version, generator_version,
            status, question_count, created_at, updated_at
     FROM care_reality_question_sets
     WHERE care_plan_id = ? AND user_id = ? AND status = 'active'
     ORDER BY version DESC, id DESC
     LIMIT 1`,
    [planId, userId],
  );
  if (!sets.length) return null;

  const [questions] = await db.execute(
    `SELECT id, question_key, intent, category, question_text, response_profile,
            target_task_ids_json, period, reason_for_asking, source, status
     FROM care_reality_questions
     WHERE question_set_id = ? AND status = 'active'
     ORDER BY ordinal, id`,
    [sets[0].id],
  );

  return rowToQuestionSet(sets[0], questions.map(rowToQuestion));
}

async function withTransaction(db, work) {
  if (typeof db.getConnection !== 'function') {
    return work(db);
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function persistNewQuestionSet({
  db,
  planId,
  userId,
  contextHash,
  questions,
  generatorVersion,
}) {
  return withTransaction(db, async (connection) => {
    const [versionRows] = await connection.execute(
      `SELECT COALESCE(MAX(version), 0) AS max_version
       FROM care_reality_question_sets
       WHERE care_plan_id = ? AND user_id = ?
       FOR UPDATE`,
      [planId, userId],
    );
    const nextVersion = Number(versionRows[0]?.max_version || 0) + 1;

    await connection.execute(
      `UPDATE care_reality_question_sets
       SET status = 'retired'
       WHERE care_plan_id = ? AND user_id = ? AND status = 'active'`,
      [planId, userId],
    );

    const [insertSet] = await connection.execute(
      `INSERT INTO care_reality_question_sets
        (care_plan_id, user_id, context_hash, version, generator_version, status, question_count)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      [planId, userId, contextHash, nextVersion, generatorVersion, questions.length],
    );
    const setId = insertSet.insertId;

    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index];
      const questionKey = buildStableRealityQuestionKey(question);
      await connection.execute(
        `INSERT INTO care_reality_questions (
          question_set_id, care_plan_id, user_id, question_key, ordinal,
          intent, category, question_text, response_profile,
          target_task_ids_json, period, reason_for_asking, source, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          setId,
          planId,
          userId,
          questionKey,
          index + 1,
          question.intent,
          question.category,
          question.question,
          question.responseProfile,
          JSON.stringify(question.targetTaskIds || []),
          question.period || 'any',
          question.reasonForAsking,
          question.source || 'ai_generated',
        ],
      );
    }

    const [storedQuestions] = await connection.execute(
      `SELECT id, question_key, intent, category, question_text, response_profile,
              target_task_ids_json, period, reason_for_asking, source, status
       FROM care_reality_questions
       WHERE question_set_id = ? AND status = 'active'
       ORDER BY ordinal, id`,
      [setId],
    );

    return {
      id: String(setId),
      carePlanId: String(planId),
      userId: String(userId),
      contextHash,
      version: nextVersion,
      generatorVersion,
      status: 'active',
      questionCount: storedQuestions.length,
      questions: storedQuestions.map(rowToQuestion),
    };
  });
}

/**
 * Layer 2 public entry point.
 *
 * Existing active questions are reused by default, even if mutable routine
 * learning changes the context hash. Pass refreshIfContextChanged=true only
 * from a deliberate upstream refresh trigger (for example, a materially
 * changed verified instruction or schedule in Layer 3).
 */
export async function getOrCreateRealityQuestionSet({
  db,
  planId,
  userId,
  instructions = [],
  tasks = [],
  routineProfile = null,
  knownRealityFacts = [],
  refreshIfContextChanged = false,
  maxQuestions = REALITY_CHECK_MAX_QUESTIONS,
  generatorVersion = REALITY_CHECK_GENERATOR_VERSION,
}) {
  if (!db) throw new Error('Reality Check persistence requires a database connection.');
  if (!normalizeId(planId) || !normalizeId(userId)) throw new Error('Reality Check persistence requires planId and userId.');
  if (!Array.isArray(tasks) || tasks.length === 0) return null;

  const contextHash = buildRealityCheckContextHash({
    instructions,
    tasks,
    routineProfile,
    knownRealityFacts,
  });

  const active = await readActiveRealityQuestionSet({ db, planId, userId });
  const generatorChanged = Boolean(active && active.generatorVersion !== generatorVersion);
  if (
    active &&
    !generatorChanged &&
    (!refreshIfContextChanged || active.contextHash === contextHash)
  ) {
    return {
      ...active,
      reused: true,
      contextChanged: active.contextHash !== contextHash,
      generatorChanged: false,
    };
  }

  const questions = await generatePersonalizedRealityCheckQuestions({
    instructions,
    tasks,
    routineProfile,
    knownRealityFacts,
    maxQuestions,
  });

  if (!questions.length) {
    // A safety-version change must never silently fall back to questions
    // generated by the older rules. Return null so the caller can use its safe
    // non-AI fallback and retry generation on a later request.
    if (generatorChanged) return null;

    if (active) {
      return {
        ...active,
        reused: true,
        contextChanged: true,
        regenerationSkipped: true,
        generatorChanged: false,
      };
    }
    return null;
  }

  const stored = await persistNewQuestionSet({
    db,
    planId,
    userId,
    contextHash,
    questions,
    generatorVersion,
  });

  return {
    ...stored,
    reused: false,
    contextChanged: Boolean(active),
    generatorChanged,
  };
}
