-- Query-path indexes for the incremental sync and durable notification queue.
CREATE INDEX IF NOT EXISTS entries_updated_idx ON entries(updated);
CREATE INDEX IF NOT EXISTS torrents_updated_idx ON torrents(updated);
CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx
  ON notification_outbox(sent_at, available_at, id);
