ALTER TABLE notification_outbox ADD COLUMN dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_dedupe_idx
  ON notification_outbox(dedupe_key)
  WHERE dedupe_key IS NOT NULL;
