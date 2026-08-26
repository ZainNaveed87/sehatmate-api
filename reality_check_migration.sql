CREATE TABLE IF NOT EXISTS care_reality_answers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  care_plan_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  question_key VARCHAR(80) NOT NULL,
  category VARCHAR(80) NOT NULL,
  question_text VARCHAR(500) NOT NULL,
  selected_answer VARCHAR(240) NOT NULL,
  risk_points INT UNSIGNED NOT NULL DEFAULT 0,
  note VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY care_reality_answer_unique (care_plan_id, user_id, question_key),
  KEY care_reality_plan_index (care_plan_id),
  KEY care_reality_user_index (user_id),
  CONSTRAINT care_reality_plan_fk FOREIGN KEY (care_plan_id) REFERENCES care_plans(id) ON DELETE CASCADE,
  CONSTRAINT care_reality_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
