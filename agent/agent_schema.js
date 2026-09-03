/**
 * Schema definition for the agent foundation tables (Phase A2).
 *
 * agent_sessions        one bounded conversational session per row
 * agent_action_audit    one accountable record per requested/executed agent action
 *
 * The DDL follows the repository conventions exactly (BIGINT UNSIGNED ids,
 * TIMESTAMP defaults, utf8mb4_unicode_ci, named FOREIGN KEY constraints with
 * deliberate ON DELETE behavior). CREATE TABLE IF NOT EXISTS keeps every
 * statement idempotent, so ensureAgentFoundationSchema can run repeatedly.
 *
 * The persisted agent session language is the canonical compact code
 * (en / ur / roman_ur) and the column default is 'en'; display names such
 * as English / Urdu / Roman Urdu are never persisted (the conversion
 * boundary lives in agent_session_store.js).
 *
 * Deliberate ON DELETE behavior:
 *   - agent_sessions.user_id       ON DELETE CASCADE  (a deleted user loses
 *     their sessions)
 *   - agent_action_audit.user_id   ON DELETE CASCADE  (a deleted user loses
 *     their audit trail; required by the users-FK convention)
 *   - agent_action_audit.session_id ON DELETE SET NULL (audit records must
 *     OUTLIVE session deletion - accountability is retained even after a
 *     session is expired or explicitly deleted)
 */

export const AGENT_SESSIONS_DDL = `CREATE TABLE IF NOT EXISTS agent_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  language VARCHAR(20) NOT NULL DEFAULT 'en',
  state_json LONGTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  PRIMARY KEY (id),
  KEY agent_sessions_user_idx (user_id, expires_at),
  KEY agent_sessions_expiry_idx (expires_at),
  CONSTRAINT agent_sessions_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

export const AGENT_ACTION_AUDIT_DDL = `CREATE TABLE IF NOT EXISTS agent_action_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NULL,
  tool_name VARCHAR(60) NOT NULL,
  permission_class VARCHAR(40) NOT NULL,
  input_json LONGTEXT NULL,
  result_status VARCHAR(20) NOT NULL,
  backend_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  target_type VARCHAR(40) NULL,
  target_id VARCHAR(191) NULL,
  error_code VARCHAR(80) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY agent_action_audit_user_idx (user_id, created_at),
  KEY agent_action_audit_session_idx (session_id, created_at),
  CONSTRAINT agent_action_audit_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT agent_action_audit_session_fk
    FOREIGN KEY (session_id) REFERENCES agent_sessions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

/**
 * Idempotently create both agent foundation tables. Safe to run any number
 * of times; it never drops, alters, or deletes anything.
 */
export async function ensureAgentFoundationSchema(db) {
  await db.execute(AGENT_SESSIONS_DDL);
  await db.execute(AGENT_ACTION_AUDIT_DDL);
}

function normalizeColumnDefault(rawValue) {
  if (rawValue == null) return null;
  // MySQL 8 returns bare literals; older MySQL/MariaDB may quote them.
  return String(rawValue).replace(/^'+|'+$/g, '');
}

/**
 * Structural verification against information_schema. Returns
 * { ok: true } or { ok: false, problems: [...] } describing anything
 * unexpected (missing table, column, index, or foreign key). The migration
 * runner fails loudly when problems are found so operators notice a wrongly
 * pre-existing table instead of silently running on a broken schema.
 */
export async function verifyAgentFoundationSchema(db) {
  const problems = [];

  const [tables] = await db.execute(
    `SELECT TABLE_NAME
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('agent_sessions', 'agent_action_audit')`,
  );
  const tableNames = new Set(tables.map((row) => row.TABLE_NAME));

  const [columns] = await db.execute(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_DEFAULT
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('agent_sessions', 'agent_action_audit')`,
  );
  const columnNames = new Set(
    columns.map((row) => `${row.TABLE_NAME}.${row.COLUMN_NAME}`),
  );
  const columnDefaults = new Map(
    columns.map((row) => [
      `${row.TABLE_NAME}.${row.COLUMN_NAME}`,
      normalizeColumnDefault(row.COLUMN_DEFAULT),
    ]),
  );

  const [statistics] = await db.execute(
    `SELECT DISTINCT TABLE_NAME, INDEX_NAME
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('agent_sessions', 'agent_action_audit')`,
  );
  const indexNames = new Set(
    statistics.map((row) => `${row.TABLE_NAME}.${row.INDEX_NAME}`),
  );

  const [constraints] = await db.execute(
    `SELECT TABLE_NAME, CONSTRAINT_NAME
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('agent_sessions', 'agent_action_audit')
       AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
  );
  const constraintNames = new Set(
    constraints.map((row) => `${row.TABLE_NAME}.${row.CONSTRAINT_NAME}`),
  );

  const expectations = [
    ['table', 'agent_sessions'],
    ['table', 'agent_action_audit'],
    ['column', 'agent_sessions.id'],
    ['column', 'agent_sessions.user_id'],
    ['column', 'agent_sessions.language'],
    ['column', 'agent_sessions.state_json'],
    ['column', 'agent_sessions.created_at'],
    ['column', 'agent_sessions.last_active_at'],
    ['column', 'agent_sessions.expires_at'],
    ['columnDefault', 'agent_sessions.language', 'en'],
    ['column', 'agent_action_audit.id'],
    ['column', 'agent_action_audit.user_id'],
    ['column', 'agent_action_audit.session_id'],
    ['column', 'agent_action_audit.tool_name'],
    ['column', 'agent_action_audit.permission_class'],
    ['column', 'agent_action_audit.input_json'],
    ['column', 'agent_action_audit.result_status'],
    ['column', 'agent_action_audit.backend_confirmed'],
    ['column', 'agent_action_audit.target_type'],
    ['column', 'agent_action_audit.target_id'],
    ['column', 'agent_action_audit.error_code'],
    ['column', 'agent_action_audit.created_at'],
    ['index', 'agent_sessions.agent_sessions_user_idx'],
    ['index', 'agent_sessions.agent_sessions_expiry_idx'],
    ['index', 'agent_action_audit.agent_action_audit_user_idx'],
    ['index', 'agent_action_audit.agent_action_audit_session_idx'],
    ['foreignKey', 'agent_sessions.agent_sessions_user_fk'],
    ['foreignKey', 'agent_action_audit.agent_action_audit_user_fk'],
    ['foreignKey', 'agent_action_audit.agent_action_audit_session_fk'],
  ];

  for (const [kind, identifier, expected] of expectations) {
    if (kind === 'columnDefault') {
      if (columnDefaults.get(identifier) !== expected) {
        problems.push(
          `unexpected default: ${identifier} (expected '${expected}')`,
        );
      }
      continue;
    }
    const present =
      kind === 'table' ? tableNames.has(identifier)
        : kind === 'column' ? columnNames.has(identifier)
          : kind === 'index' ? indexNames.has(identifier)
            : constraintNames.has(identifier);
    if (!present) {
      problems.push(`missing ${kind}: ${identifier}`);
    }
  }

  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, problems: [] };
}