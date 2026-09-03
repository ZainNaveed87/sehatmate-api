-- Run this ONCE only if you prefer phpMyAdmin instead of `npm run migrate:agent-foundation`.
-- The Node migration script is safer because it verifies tables, columns,
-- indexes, and foreign keys after creating them.

CREATE TABLE IF NOT EXISTS agent_sessions (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_action_audit (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;