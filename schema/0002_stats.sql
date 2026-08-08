CREATE TABLE IF NOT EXISTS metadata_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  raw_record_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  entry_count INTEGER NOT NULL DEFAULT 0,
  torrent_count INTEGER NOT NULL DEFAULT 0,
  nyaa_torrent_count INTEGER NOT NULL DEFAULT 0,
  pt_torrent_count INTEGER NOT NULL DEFAULT 0,
  best_entry_count INTEGER NOT NULL DEFAULT 0,
  alt_entry_count INTEGER NOT NULL DEFAULT 0,
  incomplete_count INTEGER NOT NULL DEFAULT 0,
  completion_rate REAL NOT NULL DEFAULT 0,
  metadata_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
