import { cleanText, idPattern } from './shared_utils.js';

export const CARE_PLAN_TITLE_EXISTS = 'CARE_PLAN_TITLE_EXISTS';
export const INVALID_CARE_PLAN_TITLE = 'INVALID_CARE_PLAN_TITLE';

export const CARE_PLAN_TITLE_LIMITS = Object.freeze({
  maxCharacters: 80,
  maxKeyCharacters: 255,
});

const CONTROL_AND_FORMAT_CHARS = /[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g;

function unicodeNormalize(value) {
  try {
    return String(value || '').normalize('NFKC');
  } catch {
    return String(value || '');
  }
}

export function normalizeCarePlanTitle(value) {
  return unicodeNormalize(value)
    .replace(CONTROL_AND_FORMAT_CHARS, '')
    .trim()
    .replace(/\s+/gu, ' ');
}

export function carePlanTitleKey(value) {
  return normalizeCarePlanTitle(value).toLowerCase();
}

function titleCharacterLength(value) {
  return Array.from(value).length;
}

function invalidTitle(message) {
  return {
    ok: false,
    code: INVALID_CARE_PLAN_TITLE,
    message,
  };
}

export function validateCarePlanTitle(value) {
  const title = normalizeCarePlanTitle(value);
  if (!title) return invalidTitle('Plan name is required.');
  const length = titleCharacterLength(title);
  if (length < 2 || length > CARE_PLAN_TITLE_LIMITS.maxCharacters) {
    return invalidTitle('Care plan name must be between 2 and 80 characters.');
  }
  return {
    ok: true,
    title,
    titleKey: carePlanTitleKey(title),
  };
}

function titleExistsResult() {
  return {
    ok: false,
    code: CARE_PLAN_TITLE_EXISTS,
    message: 'A care plan with this name already exists.',
    data: { code: CARE_PLAN_TITLE_EXISTS },
  };
}

function isDuplicateKeyError(error) {
  return (
    error?.code === 'ER_DUP_ENTRY' ||
    Number(error?.errno) === 1062 ||
    error?.sqlState === '23000'
  );
}

async function findTitleDuplicate({
  db,
  userId,
  titleKey,
  excludePlanId = null,
}) {
  const params = [userId, titleKey];
  let sql =
    'SELECT id FROM care_plans WHERE user_id = ? AND title_key = ?';
  if (excludePlanId != null) {
    sql += ' AND id <> ?';
    params.push(excludePlanId);
  }
  sql += ' LIMIT 1';
  const [rows] = await db.execute(sql, params);
  return rows.length > 0;
}

export async function createCarePlan({ db, userId, title }) {
  const validated = validateCarePlanTitle(title);
  if (!validated.ok) return validated;

  if (
    await findTitleDuplicate({
      db,
      userId,
      titleKey: validated.titleKey,
    })
  ) {
    return titleExistsResult();
  }

  let insertId;
  try {
    const [result] = await db.execute(
      `INSERT INTO care_plans (user_id, title, title_key, status, setup_step)
       VALUES (?, ?, ?, 'draft', 'upload')`,
      [userId, validated.title, validated.titleKey],
    );
    insertId = result.insertId;
  } catch (error) {
    if (isDuplicateKeyError(error)) return titleExistsResult();
    throw error;
  }

  const [rows] = await db.execute(
    'SELECT * FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
    [insertId, userId],
  );

  return { ok: true, data: { plan: rows[0] } };
}

export async function renameCarePlan({ db, userId, planId, title }) {
  if (!idPattern.test(String(planId || ''))) {
    return {
      ok: false,
      code: 'INVALID_PLAN_ID',
      message: 'Invalid care plan ID.',
    };
  }

  const validated = validateCarePlanTitle(title);
  if (!validated.ok) return validated;

  const [plans] = await db.execute(
    'SELECT id FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
    [planId, userId],
  );
  if (!plans.length) {
    return {
      ok: false,
      code: 'PLAN_NOT_FOUND',
      message: 'Care plan not found.',
    };
  }

  if (
    await findTitleDuplicate({
      db,
      userId,
      titleKey: validated.titleKey,
      excludePlanId: planId,
    })
  ) {
    return titleExistsResult();
  }

  try {
    await db.execute(
      `UPDATE care_plans
       SET title = ?, title_key = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [validated.title, validated.titleKey, planId, userId],
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) return titleExistsResult();
    throw error;
  }

  const [rows] = await db.execute(
    'SELECT * FROM care_plans WHERE id = ? AND user_id = ? LIMIT 1',
    [planId, userId],
  );

  return { ok: true, data: { plan: rows[0] } };
}

export async function detectDuplicateCarePlanTitles({ db }) {
  const [rows] = await db.execute(
    `SELECT user_id, title_key, COUNT(*) AS duplicate_count,
       GROUP_CONCAT(CONCAT(id, ':', title) ORDER BY id SEPARATOR ' || ') AS plans
     FROM care_plans
     WHERE title_key IS NOT NULL
     GROUP BY user_id, title_key
     HAVING COUNT(*) > 1`,
  );
  return rows.map((row) => ({
    userId: String(row.user_id),
    titleKey: cleanText(row.title_key, CARE_PLAN_TITLE_LIMITS.maxKeyCharacters),
    duplicateCount: Number(row.duplicate_count || 0),
    plans: cleanText(row.plans, 1000),
  }));
}

export async function ensureCarePlanTitleSchema({ db }) {
  const [columns] = await db.execute(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'care_plans'
       AND COLUMN_NAME = 'title_key'
     LIMIT 1`,
  );

  if (!columns.length) {
    await db.execute(
      `ALTER TABLE care_plans
       ADD COLUMN title_key VARCHAR(255)
         CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER title`,
    );
  }

  const [plans] = await db.execute(
    'SELECT id, title, title_key FROM care_plans ORDER BY id',
  );
  for (const plan of plans) {
    const nextKey = carePlanTitleKey(plan.title);
    if (plan.title_key !== nextKey) {
      await db.execute(
        'UPDATE care_plans SET title_key = ? WHERE id = ?',
        [nextKey, plan.id],
      );
    }
  }

  const duplicateGroups = await detectDuplicateCarePlanTitles({ db });
  if (duplicateGroups.length) {
    return {
      ok: false,
      code: CARE_PLAN_TITLE_EXISTS,
      message:
        'Existing duplicate care plan titles prevent adding the unique title index.',
      duplicateGroups,
    };
  }

  const [indexes] = await db.execute(
    `SELECT INDEX_NAME
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'care_plans'
       AND INDEX_NAME = 'care_plan_title_key_unique'
     LIMIT 1`,
  );
  if (!indexes.length) {
    await db.execute(
      `ALTER TABLE care_plans
       ADD UNIQUE KEY care_plan_title_key_unique (user_id, title_key)`,
    );
  }

  return { ok: true, duplicateGroups: [] };
}
