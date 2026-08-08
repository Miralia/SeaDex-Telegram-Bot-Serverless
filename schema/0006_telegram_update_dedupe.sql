CREATE TABLE IF NOT EXISTS telegram_update_dedupe (
  update_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS telegram_update_dedupe_updated_idx
  ON telegram_update_dedupe(updated_at);
