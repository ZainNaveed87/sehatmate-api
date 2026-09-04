CREATE TABLE IF NOT EXISTS family_invitations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  care_recipient_user_id BIGINT UNSIGNED NOT NULL,
  caregiver_user_id BIGINT UNSIGNED NOT NULL,
  relationship_label VARCHAR(80) NOT NULL,
  status ENUM('pending', 'accepted', 'declined', 'revoked') NOT NULL DEFAULT 'pending',
  scopes_json LONGTEXT NULL,
  created_by_user_id BIGINT UNSIGNED NOT NULL,
  accepted_at TIMESTAMP NULL DEFAULT NULL,
  declined_at TIMESTAMP NULL DEFAULT NULL,
  revoked_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY family_invitation_pair_status_unique (care_recipient_user_id, caregiver_user_id, status),
  KEY family_invitation_caregiver_status_idx (caregiver_user_id, status, created_at),
  KEY family_invitation_recipient_status_idx (care_recipient_user_id, status, created_at),
  CONSTRAINT family_invitation_recipient_fk
    FOREIGN KEY (care_recipient_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT family_invitation_caregiver_fk
    FOREIGN KEY (caregiver_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT family_invitation_creator_fk
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS family_relationships (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  care_recipient_user_id BIGINT UNSIGNED NOT NULL,
  caregiver_user_id BIGINT UNSIGNED NOT NULL,
  relationship_label VARCHAR(80) NOT NULL,
  status ENUM('active', 'revoked') NOT NULL DEFAULT 'active',
  invitation_id BIGINT UNSIGNED NULL,
  created_by_user_id BIGINT UNSIGNED NOT NULL,
  accepted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY family_relationship_pair_status_unique (care_recipient_user_id, caregiver_user_id, status),
  KEY family_relationship_caregiver_status_idx (caregiver_user_id, status, updated_at),
  KEY family_relationship_recipient_status_idx (care_recipient_user_id, status, updated_at),
  CONSTRAINT family_relationship_recipient_fk
    FOREIGN KEY (care_recipient_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT family_relationship_caregiver_fk
    FOREIGN KEY (caregiver_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT family_relationship_creator_fk
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT family_relationship_invitation_fk
    FOREIGN KEY (invitation_id) REFERENCES family_invitations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS family_permissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  relationship_id BIGINT UNSIGNED NOT NULL,
  scope VARCHAR(80) NOT NULL,
  allowed TINYINT(1) NOT NULL DEFAULT 0,
  updated_by_user_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY family_permission_scope_unique (relationship_id, scope),
  KEY family_permission_scope_idx (scope, allowed),
  CONSTRAINT family_permission_relationship_fk
    FOREIGN KEY (relationship_id) REFERENCES family_relationships (id) ON DELETE CASCADE,
  CONSTRAINT family_permission_updated_by_fk
    FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS family_activity_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  care_recipient_user_id BIGINT UNSIGNED NULL,
  caregiver_user_id BIGINT UNSIGNED NULL,
  relationship_id BIGINT UNSIGNED NULL,
  invitation_id BIGINT UNSIGNED NULL,
  event_type VARCHAR(80) NOT NULL,
  metadata_json LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY family_audit_actor_idx (actor_user_id, created_at),
  KEY family_audit_relationship_idx (relationship_id, created_at),
  KEY family_audit_invitation_idx (invitation_id, created_at),
  CONSTRAINT family_audit_actor_fk
    FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT family_audit_recipient_fk
    FOREIGN KEY (care_recipient_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT family_audit_caregiver_fk
    FOREIGN KEY (caregiver_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT family_audit_relationship_fk
    FOREIGN KEY (relationship_id) REFERENCES family_relationships (id) ON DELETE SET NULL,
  CONSTRAINT family_audit_invitation_fk
    FOREIGN KEY (invitation_id) REFERENCES family_invitations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
