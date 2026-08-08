-- Make entry-to-torrent lookups indexable instead of expanding every entry's JSON.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS entry_torrents (
  entry_id TEXT NOT NULL,
  torrent_id TEXT NOT NULL,
  PRIMARY KEY (entry_id, torrent_id),
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS entry_torrents_torrent_idx
  ON entry_torrents(torrent_id, entry_id);

INSERT OR IGNORE INTO entry_torrents(entry_id, torrent_id)
SELECT e.id, CAST(item.value AS TEXT)
FROM entries e, json_each(CASE WHEN json_valid(e.trs) THEN e.trs ELSE '[]' END) item
WHERE item.type = 'text'
  AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 10);

CREATE TRIGGER IF NOT EXISTS entries_entry_torrents_after_insert
AFTER INSERT ON entries
BEGIN
  INSERT OR IGNORE INTO entry_torrents(entry_id, torrent_id)
  SELECT NEW.id, CAST(item.value AS TEXT)
  FROM json_each(CASE WHEN json_valid(NEW.trs) THEN NEW.trs ELSE '[]' END) item
  WHERE item.type = 'text';
END;

CREATE TRIGGER IF NOT EXISTS entries_entry_torrents_after_update
AFTER UPDATE OF trs ON entries
WHEN OLD.trs IS NOT NEW.trs
BEGIN
  DELETE FROM entry_torrents WHERE entry_id = OLD.id;
  INSERT OR IGNORE INTO entry_torrents(entry_id, torrent_id)
  SELECT NEW.id, CAST(item.value AS TEXT)
  FROM json_each(CASE WHEN json_valid(NEW.trs) THEN NEW.trs ELSE '[]' END) item
  WHERE item.type = 'text';
END;

CREATE TRIGGER IF NOT EXISTS entries_entry_torrents_after_delete
AFTER DELETE ON entries
BEGIN
  DELETE FROM entry_torrents WHERE entry_id = OLD.id;
END;

INSERT OR IGNORE INTO schema_migrations(version) VALUES (10);
