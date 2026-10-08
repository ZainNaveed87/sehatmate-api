const suffix = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
export const AGENT_COPILOT_DDL = Object.freeze([
`CREATE TABLE IF NOT EXISTS agent_memory (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(30) NOT NULL,
  memory_key VARCHAR(80) NOT NULL,
  value_json LONGTEXT NOT NULL,
  source VARCHAR(30) NOT NULL,
  evidence_ref VARCHAR(191) NOT NULL,
  confidence DECIMAL(4,3) NOT NULL,
  confirmed_by_user TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  expires_at TIMESTAMP NULL,
  superseded_by BIGINT UNSIGNED NULL,
  sensitivity_class VARCHAR(30) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  KEY agent_memory_relevance_idx (user_id, status, memory_key, updated_at),
  KEY agent_memory_expiry_idx (expires_at),
  CONSTRAINT agent_memory_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT agent_memory_superseded_fk FOREIGN KEY (superseded_by) REFERENCES agent_memory (id) ON DELETE SET NULL
) ${suffix}`,
`CREATE TABLE IF NOT EXISTS agent_copilot_contexts (
  user_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NOT NULL,
  context_json LONGTEXT NOT NULL,
  context_version VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  PRIMARY KEY (user_id, session_id),
  KEY agent_copilot_context_expiry_idx (expires_at),
  CONSTRAINT agent_copilot_context_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT agent_copilot_context_session_fk FOREIGN KEY (session_id) REFERENCES agent_sessions (id) ON DELETE CASCADE
) ${suffix}`,
`CREATE TABLE IF NOT EXISTS agent_copilot_plans (
  user_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NOT NULL,
  plan_id VARCHAR(80) NOT NULL,
  screen_version VARCHAR(160) NOT NULL,
  plan_json LONGTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  PRIMARY KEY (user_id, session_id, plan_id),
  KEY agent_copilot_plan_expiry_idx (expires_at),
  CONSTRAINT agent_copilot_plan_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT agent_copilot_plan_session_fk FOREIGN KEY (session_id) REFERENCES agent_sessions (id) ON DELETE CASCADE
) ${suffix}`,
`CREATE TABLE IF NOT EXISTS agent_copilot_receipts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NULL,
  plan_id VARCHAR(80) NOT NULL,
  action_id VARCHAR(160) NOT NULL,
  target_id VARCHAR(160) NOT NULL,
  result_status VARCHAR(20) NOT NULL,
  source VARCHAR(10) NOT NULL,
  screen_version_before VARCHAR(160) NOT NULL,
  screen_version_after VARCHAR(160) NOT NULL,
  args_json LONGTEXT NOT NULL,
  result_code VARCHAR(40) NOT NULL,
  client_confirmation_ref VARCHAR(160) NULL,
  workflow_id VARCHAR(80) NULL,
  backend_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY agent_copilot_receipt_idempotency_idx (user_id, session_id, plan_id, action_id, target_id),
  KEY agent_copilot_receipt_user_idx (user_id, created_at),
  CONSTRAINT agent_copilot_receipt_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT agent_copilot_receipt_session_fk FOREIGN KEY (session_id) REFERENCES agent_sessions (id) ON DELETE SET NULL
) ${suffix}`,
]);

export async function ensureAgentCopilotSchema(db) {
  // Verify dependencies before any DDL; never guess user/session ID types.
  const [columns] = await db.execute(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('users', 'agent_sessions') AND COLUMN_NAME = 'id'`);
  if (!['users', 'agent_sessions'].every(table => columns.some(c => c.TABLE_NAME === table && /^bigint(?:\(\d+\))? unsigned$/i.test(c.COLUMN_TYPE)))) throw new Error('Agent Copilot requires existing users.id and agent_sessions.id BIGINT UNSIGNED. Run the foundation migration first.');
  for (const ddl of AGENT_COPILOT_DDL) await db.execute(ddl);
  return verifyAgentCopilotSchema(db);
}
export async function verifyAgentCopilotSchema(db) {
  const tables = ['agent_memory', 'agent_copilot_contexts', 'agent_copilot_plans', 'agent_copilot_receipts'];
  const [columns] = await db.execute(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')})`, tables);
  const [indexes] = await db.execute(`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')})`, tables);
  const [foreignKeys] = await db.execute(`SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')}) AND REFERENCED_TABLE_NAME IS NOT NULL`, tables);
  const problems = [];
  AGENT_COPILOT_DDL.forEach((ddl, i) => {
    for (const line of ddl.split('\n')) {
      const column = /^  ([a-z_]+) (BIGINT UNSIGNED|VARCHAR\(\d+\)|LONGTEXT|TIMESTAMP|TINYINT\(1\)|DECIMAL\(4,3\))/i.exec(line);
      if (!column) continue;
      const actual = columns.find(c => c.TABLE_NAME === tables[i] && c.COLUMN_NAME === column[1]);
      const canonical = value => String(value).toLowerCase().replace(/bigint\(\d+\)/, 'bigint');
      if (!actual || canonical(actual.COLUMN_TYPE) !== canonical(column[2])) problems.push(`${tables[i]}.${column[1]} missing or wrong type`);
    }
    if (!foreignKeys.some(f => f.TABLE_NAME === tables[i] && f.COLUMN_NAME === 'user_id' && f.REFERENCED_TABLE_NAME === 'users' && f.REFERENCED_COLUMN_NAME === 'id')) problems.push(`${tables[i]} user foreign key missing`);
    if (tables[i] !== 'agent_memory' && !foreignKeys.some(f => f.TABLE_NAME === tables[i] && f.COLUMN_NAME === 'session_id' && f.REFERENCED_TABLE_NAME === 'agent_sessions' && f.REFERENCED_COLUMN_NAME === 'id')) problems.push(`${tables[i]} session foreign key missing`);
    if (!indexes.some(index => index.TABLE_NAME === tables[i] && index.INDEX_NAME === 'PRIMARY')) problems.push(`${tables[i]} primary index missing`);
  });
  const contextVersion = columns.find(c => c.TABLE_NAME === 'agent_copilot_contexts' && c.COLUMN_NAME === 'context_version');
  if (contextVersion?.CHARACTER_SET_NAME !== 'ascii' || contextVersion?.COLLATION_NAME !== 'ascii_bin') problems.push('agent_copilot_contexts.context_version requires ascii_bin ordering');
  const unique = indexes.filter(i => i.TABLE_NAME === 'agent_copilot_receipts' && i.INDEX_NAME === 'agent_copilot_receipt_idempotency_idx' && Number(i.NON_UNIQUE) === 0).sort((a, b) => a.SEQ_IN_INDEX - b.SEQ_IN_INDEX).map(i => i.COLUMN_NAME);
  if (unique.join(',') !== 'user_id,session_id,plan_id,action_id,target_id') problems.push('Receipt idempotency unique index missing or wrong columns');
  return { ok: problems.length === 0, problems };
}
