ALTER TABLE notification_outbox ADD COLUMN replay_of_id INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_replay_idx
  ON notification_outbox(replay_of_id);
