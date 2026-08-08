export type SyncDiffInput = {
  type: "added" | "updated"
  entityType: "entry" | "torrent"
  entityId: string
  diff: unknown
}

type SyncRunCounts = {
  entriesAdded?: number
  entriesUpdated?: number
  torrentsAdded?: number
  torrentsUpdated?: number
}

type ReplayRow = { id: number; chat_id: string; payload: string }

function now(): string {
  return new Date().toISOString()
}

export function newSyncRunId(): string {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function createSyncRun(db: D1Database, id: string, syncType: string): Promise<void> {
  await db.prepare(
    `INSERT INTO sync_runs(id, sync_type, status, started_at)
     VALUES (?, ?, 'running', ?)`
  ).bind(id, syncType, now()).run()
}

export async function finishSyncRun(db: D1Database, id: string, counts: SyncRunCounts = {}): Promise<void> {
  await db.prepare(
    `UPDATE sync_runs SET status = 'success', completed_at = ?, entries_added = ?,
     entries_updated = ?, torrents_added = ?, torrents_updated = ?, error_message = NULL
     WHERE id = ?`
  ).bind(
    now(), counts.entriesAdded ?? 0, counts.entriesUpdated ?? 0,
    counts.torrentsAdded ?? 0, counts.torrentsUpdated ?? 0, id
  ).run()
}

export async function failSyncRun(db: D1Database, id: string, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
  await db.prepare(
    "UPDATE sync_runs SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ?"
  ).bind(now(), message, id).run()
}

export function syncDiffStatement(db: D1Database, syncRunId: string, diff: SyncDiffInput): D1PreparedStatement {
  const serialized = JSON.stringify(diff.diff)
  return db.prepare(
    `INSERT INTO sync_diffs(sync_run_id, type, entity_type, entity_id, diff, created_at)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM sync_diffs
       WHERE entity_type = ? AND entity_id = ? AND diff = ?
     )`
  ).bind(syncRunId, diff.type, diff.entityType, diff.entityId, serialized, now(), diff.entityType, diff.entityId, serialized)
}

/** Requeue rendered notifications from a completed run. */
export async function replaySyncNotifications(db: D1Database, syncRunId: string): Promise<number> {
  const { results } = await db.prepare(
    `SELECT id, chat_id, payload FROM notification_outbox
     WHERE sync_run_id = ? AND replay_of_id IS NULL
       AND (sent_at IS NOT NULL OR failed_at IS NOT NULL)
     ORDER BY id`
  ).bind(syncRunId).all<ReplayRow>()
  let queued = 0
  for (let offset = 0; offset < results.length; offset += 50) {
    const statements = results.slice(offset, offset + 50).map((row) => db.prepare(
      `INSERT OR IGNORE INTO notification_outbox(chat_id, payload, sync_run_id, replay_of_id,
         attempts, max_attempts, available_at, created_at)
       VALUES (?, ?, ?, ?, 0, 8, ?, ?)`
    ).bind(row.chat_id, row.payload, syncRunId, row.id, now(), now()))
    if (statements.length) {
      const batchResults = await db.batch(statements)
      queued += batchResults.reduce((count, result) => count + Number(result.meta?.changes ?? 0), 0)
    }
  }
  return queued
}
