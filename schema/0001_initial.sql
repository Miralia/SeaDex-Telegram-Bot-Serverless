PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS anime_metadata (
  anilist_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  picture_url TEXT,
  thumbnail_url TEXT,
  type TEXT,
  season_year INTEGER,
  search_text TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  source_fingerprint TEXT NOT NULL,
  index_fingerprint TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS anime_metadata_fts USING fts5(
  anilist_id UNINDEXED,
  title,
  search_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  alid INTEGER,
  incomplete INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  comparison TEXT,
  trs TEXT NOT NULL DEFAULT '[]',
  theoretical_best TEXT,
  created TEXT,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_alid_idx ON entries(alid);

CREATE TABLE IF NOT EXISTS torrents (
  id TEXT PRIMARY KEY,
  url TEXT,
  info_hash TEXT,
  release_group TEXT,
  tracker TEXT,
  is_best INTEGER NOT NULL DEFAULT 0,
  dual_audio INTEGER NOT NULL DEFAULT 0,
  grouped_url TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '[]',
  created TEXT,
  updated TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS metadata_builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_fingerprint TEXT NOT NULL UNIQUE,
  built_at TEXT NOT NULL,
  record_count INTEGER NOT NULL
);

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
