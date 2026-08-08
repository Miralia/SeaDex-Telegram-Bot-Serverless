CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  sync_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  entries_added INTEGER NOT NULL DEFAULT 0,
  entries_updated INTEGER NOT NULL DEFAULT 0,
  torrents_added INTEGER NOT NULL DEFAULT 0,
  torrents_updated INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS sync_runs_started_idx
  ON sync_runs(started_at DESC, id);

CREATE TABLE IF NOT EXISTS sync_diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  diff TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(id)
);

CREATE INDEX IF NOT EXISTS sync_diffs_run_idx
  ON sync_diffs(sync_run_id, id);

CREATE INDEX IF NOT EXISTS sync_diffs_entity_idx
  ON sync_diffs(entity_type, entity_id, id);

ALTER TABLE notification_outbox ADD COLUMN sync_run_id TEXT;

CREATE INDEX IF NOT EXISTS notification_outbox_run_idx
  ON notification_outbox(sync_run_id, id);
