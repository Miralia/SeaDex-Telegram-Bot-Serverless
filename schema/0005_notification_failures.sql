ALTER TABLE notification_outbox ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 8;
ALTER TABLE notification_outbox ADD COLUMN last_error TEXT;
ALTER TABLE notification_outbox ADD COLUMN failed_at TEXT;

CREATE INDEX IF NOT EXISTS notification_outbox_retry_idx
  ON notification_outbox(sent_at, failed_at, available_at, id);
