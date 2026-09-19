#!/usr/bin/env bash
#
# Restore a SeaDex D1 backup produced by scripts/backup-d1.sh.
#
# The dump only carries rows, so a restore always rebuilds the database in the
# same three steps:
#
#   1. schema/*.sql      -> tables, indexes, triggers, FTS5 virtual table
#   2. the data dump     -> rows; the entries trigger repopulates entry_torrents
#   3. one INSERT        -> anime_metadata_fts rebuilt from anime_metadata
#
# Modes:
#   --local <target.db>   rebuild into a scratch SQLite file (default)
#   --verify              rebuild into a temporary file and compare the row
#                         counts with the backup manifest
#   --remote --confirm    rebuild inside the production D1 database. Requires
#                         --wipe, because the dump contains plain INSERTs.
#
# Usage:
#   scripts/restore-d1.sh --verify  backups/seadex-20260919T155300Z.sql.gz
#   scripts/restore-d1.sh --local /tmp/seadex.db backups/seadex-....sql.gz
#
# Environment:
#   D1_DATABASE            database name for --remote (default: seadex)
#   CLOUDFLARE_D1_DATABASE_ID required for --remote

set -euo pipefail
# Deterministic glob order for schema/0*.sql.
export LC_ALL=C

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd -- "$PROJECT_DIR"

MODE="local"
TARGET=""
ARCHIVE=""
CONFIRM=0
WIPE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) MODE="local"; TARGET="${2:-}"; shift 2 ;;
    --verify) MODE="verify"; shift ;;
    --remote) MODE="remote"; shift ;;
    --confirm) CONFIRM=1; shift ;;
    --wipe) WIPE=1; shift ;;
    -*) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done

if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  printf 'usage: %s [--local <target.db> | --verify | --remote --wipe --confirm] <backup.sql.gz>\n' "$0" >&2
  exit 2
fi

command -v sqlite3 >/dev/null || { printf 'sqlite3 is required\n' >&2; exit 2; }

MANIFEST="$ARCHIVE.manifest.json"

# 0001_initial.sql already declares columns that 0003 later re-adds, so a replay
# from scratch reports "duplicate column name" once. Every other error is fatal.
apply_schema() {
  local db="$1" file output
  for file in "$PROJECT_DIR"/schema/[0-9]*.sql; do
    if ! output="$(sqlite3 "$db" < "$file" 2>&1)"; then
      if grep -q "duplicate column name" <<<"$output"; then continue; fi
      printf 'schema %s failed: %s\n' "$(basename "$file")" "$output" >&2
      return 1
    fi
  done
}

rebuild() {
  local db="$1"
  rm -f "$db"
  apply_schema "$db"
  gunzip -c "$ARCHIVE" | sqlite3 "$db"
  # contentless-free FTS5 table: repopulate exactly like build-metadata.ts does.
  sqlite3 "$db" "INSERT INTO anime_metadata_fts(rowid, anilist_id, title, search_text)
                 SELECT anilist_id, anilist_id, title, search_text FROM anime_metadata;"
}

report() {
  sqlite3 "$1" "SELECT 'entries='||(SELECT COUNT(*) FROM entries)||
                       ' torrents='||(SELECT COUNT(*) FROM torrents)||
                       ' entry_torrents='||(SELECT COUNT(*) FROM entry_torrents)||
                       ' anime_metadata='||(SELECT COUNT(*) FROM anime_metadata)||
                       ' fts='||(SELECT COUNT(*) FROM anime_metadata_fts)||
                       ' sync_state='||(SELECT COUNT(*) FROM sync_state)||
                       ' outbox='||(SELECT COUNT(*) FROM notification_outbox)||
                       ' sync_runs='||(SELECT COUNT(*) FROM sync_runs)||
                       ' sync_diffs='||(SELECT COUNT(*) FROM sync_diffs);"
}

if [[ "$MODE" == "remote" ]]; then
  if [[ "$CONFIRM" != 1 || "$WIPE" != 1 ]]; then
    cat >&2 <<'EOF'
--remote needs --wipe --confirm.

Prefer Time Travel for point-in-time recovery; it is non-interactive and keeps
the current bookmark:
  npx wrangler d1 time-travel info seadex
  npx wrangler d1 time-travel restore seadex --bookmark=<bookmark>

Use this script only when the backup predates the 30 day Time Travel window.
EOF
    exit 2
  fi
  D1_DATABASE="${D1_DATABASE:-seadex}"
  D1_DATABASE_ID="${CLOUDFLARE_D1_DATABASE_ID:-}"
  [[ "$D1_DATABASE_ID" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] \
    || { printf 'CLOUDFLARE_D1_DATABASE_ID must be a D1 UUID\n' >&2; exit 2; }
  printf 'This will DELETE every row in %s and reload %s.\n' "$D1_DATABASE" "$ARCHIVE" >&2
  read -r -p "Type the database name to continue: " answer
  [[ "$answer" == "$D1_DATABASE" ]] || { printf 'aborted\n' >&2; exit 1; }

  WRANGLER_CONFIG="$(mktemp "$PROJECT_DIR/.wrangler/restore-wrangler.XXXXXX.toml")"
  trap 'rm -f "$WRANGLER_CONFIG"' EXIT
  bash "$SCRIPT_DIR/prepare-wrangler-config.sh" "$WRANGLER_CONFIG"
  TMP_SQL="$(mktemp "$PROJECT_DIR/.wrangler/restore-XXXXXX.sql")"
  trap 'rm -f "$WRANGLER_CONFIG" "$TMP_SQL"' EXIT

  # The triggers would repopulate entry_torrents while entries reload; drop them
  # and let the wipe plus the explicit rebuild below handle the derived tables.
  npx wrangler d1 execute "$D1_DATABASE" --config "$WRANGLER_CONFIG" --remote --yes --command \
    "PRAGMA foreign_keys=OFF;
     DELETE FROM entry_torrents; DELETE FROM entries; DELETE FROM torrents;
     DELETE FROM anime_metadata_fts; DELETE FROM anime_metadata;
     DELETE FROM metadata_builds; DELETE FROM metadata_stats; DELETE FROM notification_outbox;
     DELETE FROM stats; DELETE FROM sync_diffs; DELETE FROM sync_runs;
     DELETE FROM sync_state; DELETE FROM telegram_update_dedupe;
     DELETE FROM schema_migrations;"
  gunzip -c "$ARCHIVE" > "$TMP_SQL"
  npx wrangler d1 execute "$D1_DATABASE" --config "$WRANGLER_CONFIG" --remote --yes --file "$TMP_SQL"
  npx wrangler d1 execute "$D1_DATABASE" --config "$WRANGLER_CONFIG" --remote --yes --file "$PROJECT_DIR/schema/0010_entry_torrents.sql"
  npx wrangler d1 execute "$D1_DATABASE" --config "$WRANGLER_CONFIG" --remote --yes --command \
    "INSERT INTO anime_metadata_fts(rowid, anilist_id, title, search_text)
     SELECT anilist_id, anilist_id, title, search_text FROM anime_metadata;"
  printf 'remote restore complete\n'
  exit 0
fi

if [[ "$MODE" == "verify" ]]; then
  TARGET="$(mktemp -t seadex-restore-XXXXXX.db)"
  trap 'rm -f "$TARGET"' EXIT
fi

if [[ -z "$TARGET" ]]; then
  printf 'usage: %s --local <target.db> <backup.sql.gz>\n' "$0" >&2
  exit 2
fi

rebuild "$TARGET"

if [[ "$MODE" == "verify" ]]; then
  printf 'restored: %s\n' "$(report "$TARGET")"
  if [[ -f "$MANIFEST" ]] && command -v node >/dev/null; then
    expected="$(node -e '
      const fs = require("fs")
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      const c = m.row_counts
      process.stdout.write(`entries=${c.entries} torrents=${c.torrents} anime_metadata=${c.anime_metadata} sync_state=${c.sync_state} outbox=${c.notification_outbox} sync_runs=${c.sync_runs} sync_diffs=${c.sync_diffs}`)
    ' "$MANIFEST")"
    actual="$(sqlite3 "$TARGET" "SELECT 'entries='||(SELECT COUNT(*) FROM entries)||
                                      ' torrents='||(SELECT COUNT(*) FROM torrents)||
                                      ' anime_metadata='||(SELECT COUNT(*) FROM anime_metadata)||
                                      ' sync_state='||(SELECT COUNT(*) FROM sync_state)||
                                      ' outbox='||(SELECT COUNT(*) FROM notification_outbox)||
                                      ' sync_runs='||(SELECT COUNT(*) FROM sync_runs)||
                                      ' sync_diffs='||(SELECT COUNT(*) FROM sync_diffs);")"
    if [[ "$expected" != "$actual" ]]; then
      printf 'VERIFY FAILED\nexpected: %s\nactual:   %s\n' "$expected" "$actual" >&2
      exit 1
    fi
    printf 'manifest counts match: %s\n' "$actual"
  else
    printf 'no manifest next to the archive; counts reported above only\n'
  fi
  printf 'OK\n'
  exit 0
fi

printf 'restored into %s: %s\n' "$TARGET" "$(report "$TARGET")"
