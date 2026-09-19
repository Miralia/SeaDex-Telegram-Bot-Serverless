# D1 backup and recovery

The production database is a single Cloudflare D1 database (`seadex`, 80 MB).
This document covers what can actually be lost, the three recovery layers, and
what to do when something breaks.

## What is at risk

| Data | Rows | Loss impact | Rebuildable |
| --- | --- | --- | --- |
| `anime_metadata` | ~20.7k | Search and every notification title | Yes, `npm run build:metadata` (AniList + offline datasets) |
| `anime_metadata_fts` | ~20.7k | Search only | Yes, one `INSERT … SELECT` from `anime_metadata` |
| `entries` | ~2.9k | Everything | Yes, full sync from the SeaDex API (~130 pages) |
| `torrents` | ~10.4k | Everything | Yes, full sync from the SeaDex API |
| `entry_torrents` | ~9.4k | Sync lookups | Yes, maintained by triggers from `entries.trs` |
| `sync_state` | 5 | Sync watermarks, probes, `sync_initialized` | Yes, re-derived from the newest `entries`/`torrents` row |
| `notification_outbox` | small | Pending pushes | No — unsent notifications are gone |
| `sync_runs`, `sync_diffs` | ~1.7k | Sync audit history | No |
| `stats`, `metadata_stats`, `metadata_builds` | 3 | Cached counters | Yes |

Nothing in the database is user-uploaded or unique content: it mirrors SeaDex
and public anime metadata. The unrecoverable parts are the audit trail and any
notification that had not been delivered yet.

## Layer 1 — Time Travel (already on)

D1 keeps minute-granularity history for the **last 30 days** at no cost. This is
the first tool to reach for and it needs no setup.

```sh
# Current restore point
npx wrangler d1 time-travel info seadex

# The restore point for a moment in the past
npx wrangler d1 time-travel info seadex --timestamp="2026-09-19T15:30:00Z"

# Rewind production (destructive, in place)
npx wrangler d1 time-travel restore seadex --bookmark=<bookmark>
```

Notes:

- Restore is **in place** and cancels in-flight queries. The command prints the
  previous bookmark, which is how you undo a restore.
- `d1 export` already records the bookmark of the data it dumped, and
  `scripts/backup-d1.sh` stores it in the manifest next to every archive.
- Time Travel does not survive losing the account, and it forgets anything
  older than 30 days. That is what layer 2 is for.

## Layer 2 — Periodic logical backups

`.github/workflows/backup.yml` runs daily at 02:23 UTC, exports the
source-of-truth tables, then **rebuilds the dump in a throwaway SQLite database
and compares row counts with the manifest** before publishing it. A backup that
cannot be restored fails the workflow.

```sh
# Manual run (needs CLOUDFLARE_D1_DATABASE_ID)
CLOUDFLARE_D1_DATABASE_ID=<uuid> ./scripts/backup-d1.sh backups

# Prove an archive restores
./scripts/restore-d1.sh --verify backups/seadex-20260919T155634Z.sql.gz

# Inspect an archive locally
./scripts/restore-d1.sh --local /tmp/seadex.db backups/seadex-20260919T155634Z.sql.gz
```

Each archive is ~8.6 MB gzipped (47 MB of SQL, exported in ~12 s) plus a
`.sha256` and a `.manifest.json` holding the row counts, the source table list
and the Time Travel bookmark.

Destinations, in order of durability:

1. **R2** — set the repository variable `BACKUP_R2_BUCKET`. 8.6 MB/day is ~3 GB
   per year, inside the 10 GB free tier, and a lifecycle rule can expire old
   objects. R2 is not enabled on this account yet (the dashboard asks for a
   payment method); once it is, nothing else has to change.
2. **Telegram** — set the variable `BACKUP_TELEGRAM_CHAT` (for example the
   `TELEGRAM_PUSH_IDS` group). The bot already exists, the 8.6 MB archive is far
   under the 50 MB Bot API limit, and the copy lives outside the Cloudflare
   account. It is a chat folder rather than a backup service, so treat it as a
   second copy, not the system of record.
3. **Actions artifact** — always uploaded, 14 day retention. Convenient, but it
   expires and it shares storage with the repository.

To retrieve an archive by hand, download the artifact from the workflow run, or
list the destination: `npx wrangler r2 object get <bucket>/<archive> --file`.

### Why the dump is table-by-table

`wrangler d1 export` fails outright on databases containing virtual tables:

```
D1 Export error: cannot export databases with Virtual Tables (fts5)
```

Dropping `anime_metadata_fts` on production to satisfy the exporter is not
acceptable, so `scripts/backup-d1.sh` passes an explicit `--table` list.
Deliberately excluded:

- `anime_metadata_fts` and its five shadow tables — rebuilt from
  `anime_metadata` with the same `INSERT … SELECT` that
  `scripts/build-metadata.ts` uses.
- `entry_torrents` — rebuilt by the `entries_entry_torrents_after_*` triggers
  while the dump loads, so exporting it would only create PK conflicts.
- `schema_migrations` — recreated by replaying `schema/*.sql`.
- `_cf_KV` — D1 internal.

Restoring therefore always means: schema from git, then rows, then rebuild the
FTS index. `scripts/restore-d1.sh` does exactly that.

## Layer 3 — Rebuild from source

If every copy is gone, the database can be rebuilt without backups:

1. Apply `schema/0001` … `schema/0010` to a fresh D1 database.
2. Clear `sync_state` and let the queue run: `runSyncTick` starts a full sync
   from the SeaDex API and rebuilds `entries`, `torrents`, `entry_torrents` and
   `stats`. At one page per tick it takes a few hours.
3. Reimport metadata: run the `Build Metadata` workflow, which imports
   `anime_metadata` and repopulates the FTS index.
4. Reset the Telegram webhook: `npm run deploy:telegram`.

Only `sync_runs`, `sync_diffs` and undelivered outbox rows are unrecoverable.

## Runbook

**A bad `UPDATE`/`DELETE`, or a migration that dropped data**
→ Time Travel, within 30 days. Capture the current bookmark first.

**A bug wrote wrong rows and the sync keeps re-adding them**
→ Stop the source of writes (`wrangler triggers deploy` with an empty cron, or
pause the queue consumer), then Time Travel, then fix the code.

**The database is corrupted or deleted**
→ Create a fresh D1 database, then either
`./scripts/restore-d1.sh --remote --wipe --confirm backups/<archive>.sql.gz`
or replay the sync (layer 3). Remember to update the D1 UUID in the
`production` environment secret.

**The account is lost**
→ Restore the newest archive from R2/Telegram into a new account. This is the
only scenario layers 1 and 3 cannot cover.

**Suspecting a broken backup before you need it**
→ `./scripts/restore-d1.sh --verify <archive>` rebuilds it locally and diffs the
row counts against the manifest. The daily workflow runs the same check.

## Caveats

- The export is **not one cross-table transaction**. A write landing between two
  table exports can leave the dump slightly inconsistent. Backups run at 02:23
  UTC, when the sync writes ~100 rows/day, and Time Travel covers the rest.
- The manifest row counts cover the source tables; `entry_torrents` and
  `anime_metadata_fts` are compared as derived values during `--verify`.
- `restore-d1.sh --remote` wipes production before loading. Prefer Time Travel.
- The metadata build state (`.metadata-state.json`) lives in the Actions cache
  and expires after 7 idle days. Losing it only forces a slower metadata
  rebuild; the importer is fingerprint-guarded, so already-imported rows are not
  rewritten.
