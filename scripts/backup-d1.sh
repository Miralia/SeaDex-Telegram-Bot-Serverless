#!/usr/bin/env bash
#
# Logical backup of the SeaDex D1 database.
#
# `wrangler d1 export` refuses databases that contain virtual tables, and this
# database has `anime_metadata_fts` (FTS5). Instead of dropping the index on
# production, only the source-of-truth tables are exported; everything else is
# rebuilt by scripts/restore-d1.sh:
#
#   rebuilt from schema/*.sql   -> every index, trigger and the FTS table
#   rebuilt from entries.trs    -> entry_torrents (trigger maintained)
#   rebuilt from anime_metadata -> anime_metadata_fts (see build-metadata.ts)
#
# Usage:
#   CLOUDFLARE_D1_DATABASE_ID=<uuid> scripts/backup-d1.sh [output-dir]
#
# Environment:
#   D1_DATABASE          database name (default: seadex)
#   TELEGRAM_BACKUP_CHAT chat id that also receives the archive (optional)
#   R2_BACKUP_BUCKET     R2 bucket that also receives the archive (optional)
#
# Telegram needs TELEGRAM_BOT_TOKEN, R2 needs wrangler credentials. Both are
# best-effort: a failed off-site copy never fails the local backup.

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd -- "$PROJECT_DIR"

D1_DATABASE="${D1_DATABASE:-seadex}"
OUT_DIR="${1:-backups}"
D1_DATABASE_ID="${CLOUDFLARE_D1_DATABASE_ID:-}"

if [[ ! "$D1_DATABASE_ID" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]]; then
  printf '%s\n' "CLOUDFLARE_D1_DATABASE_ID must be a D1 UUID" >&2
  exit 2
fi

# Source-of-truth tables. Keep in sync with restore-d1.sh.
TABLES=(
  anime_metadata
  entries
  torrents
  metadata_builds
  metadata_stats
  notification_outbox
  stats
  sync_diffs
  sync_runs
  sync_state
  telegram_update_dedupe
)

RUN_ID="$$-$(date -u +%s)"
mkdir -p "$PROJECT_DIR/.wrangler" "$OUT_DIR"
WRANGLER_CONFIG="$PROJECT_DIR/.wrangler/backup-wrangler-$RUN_ID.toml"
TMP_SQL="$OUT_DIR/.dump-$RUN_ID.sql"
TMP_COUNTS="$OUT_DIR/.counts-$RUN_ID.json"
TMP_PARSED="$OUT_DIR/.counts-$RUN_ID.parsed.json"
TMP_TABLES="$OUT_DIR/.tables-$RUN_ID.json"
cleanup() { rm -f "$WRANGLER_CONFIG" "$TMP_SQL" "$TMP_COUNTS" "$TMP_PARSED" "$TMP_TABLES"; }
trap cleanup EXIT

bash "$SCRIPT_DIR/prepare-wrangler-config.sh" "$WRANGLER_CONFIG"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TABLE_ARGS=()
for table in "${TABLES[@]}"; do TABLE_ARGS+=(--table "$table"); done

printf 'Backing up %s (%s table(s))...\n' "$D1_DATABASE" "${#TABLES[@]}"
# --no-schema: the schema is rebuilt from schema/*.sql so it stays reviewable in
# git; the dump only carries rows.
npx wrangler d1 export "$D1_DATABASE" \
  --config "$WRANGLER_CONFIG" \
  --remote \
  --no-schema \
  --skip-confirmation \
  --output "$TMP_SQL" \
  "${TABLE_ARGS[@]}"

if [[ ! -s "$TMP_SQL" ]]; then
  printf '%s\n' "export produced an empty dump" >&2
  exit 1
fi

# D1 rejects compound SELECTs well below SQLite's own limit, so the counts are
# scalar subqueries in a single SELECT.
COUNTS_SQL="SELECT"
for table in "${TABLES[@]}"; do COUNTS_SQL+=" (SELECT COUNT(*) FROM $table) AS \"$table\","; done
COUNTS_SQL="${COUNTS_SQL%,}"

npx wrangler d1 execute "$D1_DATABASE" --config "$WRANGLER_CONFIG" --remote --json \
  --command "$COUNTS_SQL" > "$TMP_COUNTS"

printf '%s\n' "${TABLES[@]}" \
  | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.trim().split("\n"))))' \
  > "$TMP_TABLES"

# A truncated export would silently restore an incomplete database: every table
# that holds rows upstream must appear in the dump.
node -e '
const fs = require("fs")
const raw = fs.readFileSync(process.argv[1], "utf8")
const counts = JSON.parse(raw.slice(raw.indexOf("[")))[0].results[0]
const dump = fs.readFileSync(process.argv[2], "utf8")
const missing = Object.entries(counts)
  .filter(([table, rows]) => Number(rows) > 0 && !dump.includes(`INSERT INTO "${table}"`))
  .map(([table]) => table)
if (missing.length) {
  console.error(`dump is missing rows for: ${missing.join(", ")}`)
  process.exit(1)
}
fs.writeFileSync(process.argv[3], JSON.stringify(counts))
' "$TMP_COUNTS" "$TMP_SQL" "$TMP_PARSED"

ARCHIVE="$OUT_DIR/$D1_DATABASE-$STAMP.sql.gz"
gzip -9 -c "$TMP_SQL" > "$ARCHIVE"
SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
printf '%s  %s\n' "$SHA256" "$(basename "$ARCHIVE")" > "$ARCHIVE.sha256"

# The bookmark pins this backup to a Time Travel restore point.
BOOKMARK="$(npx wrangler d1 time-travel info "$D1_DATABASE" --config "$WRANGLER_CONFIG" 2>/dev/null \
  | sed -n "s/.*current bookmark is '\([^']*\)'.*/\1/p" || true)"

MANIFEST="$ARCHIVE.manifest.json"
node -e '
const fs = require("fs")
const [archive, sha256, bookmark, database, exportedAt, countsFile, tablesFile] = process.argv.slice(1)
const manifest = {
  database,
  exported_at: exportedAt,
  archive: archive.split("/").pop(),
  sha256,
  time_travel_bookmark: bookmark || null,
  source_tables: JSON.parse(fs.readFileSync(tablesFile, "utf8")),
  row_counts: JSON.parse(fs.readFileSync(countsFile, "utf8")),
  rebuilt_on_restore: ["entry_torrents", "anime_metadata_fts", "indexes", "triggers"]
}
fs.writeFileSync(`${archive}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
' "$ARCHIVE" "$SHA256" "$BOOKMARK" "$D1_DATABASE" "$STAMP" "$TMP_PARSED" "$TMP_TABLES"

printf 'archive:  %s (%s)\n' "$ARCHIVE" "$(du -h "$ARCHIVE" | awk '{print $1}')"
printf 'sha256:   %s\n' "$SHA256"
printf 'bookmark: %s\n' "${BOOKMARK:-unknown}"

if [[ -n "${R2_BACKUP_BUCKET:-}" ]]; then
  printf 'uploading to r2://%s ...\n' "$R2_BACKUP_BUCKET"
  npx wrangler r2 object put "$R2_BACKUP_BUCKET/$(basename "$ARCHIVE")" \
    --config "$WRANGLER_CONFIG" --file "$ARCHIVE" --remote || printf '%s\n' "R2 upload failed" >&2
  npx wrangler r2 object put "$R2_BACKUP_BUCKET/$(basename "$MANIFEST")" \
    --config "$WRANGLER_CONFIG" --file "$MANIFEST" --remote || true
fi

if [[ -n "${TELEGRAM_BACKUP_CHAT:-}" && -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  printf 'sending to telegram chat %s ...\n' "$TELEGRAM_BACKUP_CHAT"
  curl --silent --show-error --fail-with-body --max-time 300 \
    -F "chat_id=${TELEGRAM_BACKUP_CHAT}" \
    -F "caption=D1 backup ${D1_DATABASE} ${STAMP} sha256 ${SHA256:0:12} bookmark ${BOOKMARK:-n/a}" \
    -F "document=@${ARCHIVE}" \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument" > /dev/null \
    || printf '%s\n' "Telegram upload failed" >&2
fi

printf 'done\n'
