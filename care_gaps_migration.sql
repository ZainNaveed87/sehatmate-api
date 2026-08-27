-- Run this ONCE only if you prefer phpMyAdmin instead of `npm run migrate:care-gaps`.
-- The Node migration script is safer because it checks existing columns/indexes first.

ALTER TABLE care_gaps
  ADD COLUMN gap_type VARCHAR(40) NULL AFTER category,
  ADD COLUMN severity ENUM('blocking','attention') NOT NULL DEFAULT 'attention' AFTER status,
  ADD COLUMN lifecycle_status ENUM('open','in_progress','resolved') NOT NULL DEFAULT 'open' AFTER severity,
  ADD COLUMN source_key VARCHAR(160) NULL AFTER resolved_at,
  ADD COLUMN source_kind VARCHAR(40) NULL AFTER source_key,
  ADD COLUMN source_id VARCHAR(191) NULL AFTER source_kind,
  ADD COLUMN due_at DATETIME NULL AFTER source_id,
  ADD COLUMN auto_managed TINYINT(1) NOT NULL DEFAULT 0 AFTER due_at;

UPDATE care_gaps
SET lifecycle_status = CASE WHEN status = 'resolved' THEN 'resolved' ELSE 'open' END,
    severity = CASE
      WHEN status IN ('blocked', 'unclear') THEN 'blocking'
      ELSE 'attention'
    END;

ALTER TABLE care_gaps
  ADD UNIQUE KEY care_gaps_source_unique (care_plan_id, source_key),
  ADD KEY care_gaps_severity_lifecycle_idx (care_plan_id, severity, lifecycle_status);
