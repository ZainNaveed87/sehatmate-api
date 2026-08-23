ALTER TABLE extracted_instructions
  ADD COLUMN IF NOT EXISTS requires_professional_confirmation TINYINT(1) NOT NULL DEFAULT 0 AFTER review_status,
  ADD COLUMN IF NOT EXISTS ambiguity_reason TEXT NULL AFTER requires_professional_confirmation,
  ADD COLUMN IF NOT EXISTS possible_interpretation TEXT NULL AFTER ambiguity_reason,
  ADD COLUMN IF NOT EXISTS safety_note TEXT NULL AFTER possible_interpretation,
  ADD COLUMN IF NOT EXISTS safety_check_status ENUM('not_checked', 'needs_confirmation', 'no_issue_found', 'source_not_found') NOT NULL DEFAULT 'not_checked' AFTER safety_note,
  ADD COLUMN IF NOT EXISTS safety_check_summary TEXT NULL AFTER safety_check_status,
  ADD COLUMN IF NOT EXISTS safety_possible_interpretation TEXT NULL AFTER safety_check_summary,
  ADD COLUMN IF NOT EXISTS safety_question TEXT NULL AFTER safety_possible_interpretation,
  ADD COLUMN IF NOT EXISTS safety_sources JSON NULL AFTER safety_question,
  ADD COLUMN IF NOT EXISTS safety_checked_at TIMESTAMP NULL DEFAULT NULL AFTER safety_sources;
