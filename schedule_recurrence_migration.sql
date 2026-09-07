-- Optional manual migration companion for structured medicine recurrence.
-- The runtime server startup also adds these columns idempotently.

ALTER TABLE care_schedule_items
  ADD COLUMN IF NOT EXISTS recurrence_mode VARCHAR(20) NULL AFTER recurrence_text,
  ADD COLUMN IF NOT EXISTS recurrence_weekdays_json LONGTEXT NULL AFTER recurrence_mode,
  ADD COLUMN IF NOT EXISTS recurrence_interval_days INT UNSIGNED NULL AFTER recurrence_weekdays_json,
  ADD COLUMN IF NOT EXISTS recurrence_month_days_json LONGTEXT NULL AFTER recurrence_interval_days,
  ADD COLUMN IF NOT EXISTS recurrence_source VARCHAR(20) NULL AFTER recurrence_month_days_json;
