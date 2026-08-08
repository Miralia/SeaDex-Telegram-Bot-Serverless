import { buildUpdateNotification } from "./notifications"
import { createSyncRun, failSyncRun, finishSyncRun, newSyncRunId, syncDiffStatement, type SyncDiffInput } from "./audit"
import { findEntriesByIds, findEntriesByTorrentIds, getMetadata, getTorrents } from "./repository"
import { buttons, sendPush, TelegramApiError } from "./telegram"
import type { AnimeMetadata, BotStats, Env, SeaDexEntry, SeaDexTorrent } from "./types"

type PocketBasePage = { items: Record<string, unknown>[]; totalPages: number }
type InitialState = {
  phase: "entries" | "torrents"
  page: number
  runId?: string
  baseEntries?: number
  baseTorrents?: number
}
type Watermark = { updated: string; ids: string[] }
type OutboxPayload = {
  chatId: string
  entryId: string
  updated: string
  metadata: AnimeMetadata
  caption: string
  replyMarkup: unknown
}

type PendingNotification = {
  payload: OutboxPayload
  serialized: string
}

const PAGE_SIZE = 100
const torrentFields = ["url", "infoHash", "releaseGroup", "tracker", "isBest", "dualAudio", "groupedUrl", "tags", "files"] as const
const SEADEX_REQUEST_TIMEOUT_MS = 20_000
const SEADEX_MAX_ATTEMPTS = 4
const SEADEX_RETRY_BASE_MS = 500

function now(): string { return new Date().toISOString() }

export function probeHash(items: Record<string, unknown>[]): string {
  // FNV-1a keeps the probe compact.
  let hash = 2166136261
  for (const char of JSON.stringify(items)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

type StatsEntryRow = { incomplete: number; trs: unknown }
type StatsTorrentRow = { tracker: string | null; is_best: number; id: string }
type EntryStatsAggregate = {
  entry_count: number
  incomplete_count: number
  best_entry_count: number
  alt_entry_count: number
}
type TorrentStatsAggregate = {
  torrent_count: number
  nyaa_torrent_count: number
  pt_torrent_count: number
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== "string") return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Calculate stats without parsing entry JSON during a request. */
export function calculateStats(entries: StatsEntryRow[], torrents: StatsTorrentRow[], metadata: number, updated: string | null): BotStats {
  const torrentBest = new Map(torrents.map((torrent) => [torrent.id, Boolean(torrent.is_best)]))
  let best = 0
  let alt = 0
  for (const entry of entries) {
    let hasBest = false
    let hasAlt = false
    for (const id of jsonArray(entry.trs)) {
      if (typeof id !== "string") continue
      const isBest = torrentBest.get(id)
      if (isBest === true) hasBest = true
      if (isBest === false) hasAlt = true
    }
    if (hasBest) best += 1
    if (hasAlt) alt += 1
  }
  const entryCount = entries.length
  const incomplete = entries.filter((entry) => Boolean(entry.incomplete)).length
  const nyaa = torrents.filter((torrent) => torrent.tracker === "Nyaa").length
  // Match SQL's NULL handling for `tracker != 'Nyaa'`.
  const pt = torrents.filter((torrent) => torrent.tracker !== null && torrent.tracker !== "Nyaa").length
  return {
    entries: entryCount,
    torrents: torrents.length,
    nyaa,
    pt,
    best,
    alt,
    incomplete,
    metadata,
    completion: entryCount ? ((entryCount - incomplete) / entryCount) * 100 : 0,
    updated
  }
}

/** Refresh the cached /stats row. */
export async function refreshStats(db: D1Database): Promise<void> {
  const [entryAggregate, torrentAggregate, metadataRow] = await Promise.all([
    db.prepare(
      `SELECT
         COUNT(*) AS entry_count,
         COALESCE(SUM(CASE WHEN incomplete != 0 THEN 1 ELSE 0 END), 0) AS incomplete_count,
         COALESCE(SUM(CASE WHEN EXISTS (
           SELECT 1
           FROM entry_torrents et
           JOIN torrents t ON t.id = et.torrent_id
           WHERE et.entry_id = e.id AND t.is_best = 1
         ) THEN 1 ELSE 0 END), 0) AS best_entry_count,
         COALESCE(SUM(CASE WHEN EXISTS (
           SELECT 1
           FROM entry_torrents et
           JOIN torrents t ON t.id = et.torrent_id
           WHERE et.entry_id = e.id AND t.is_best = 0
         ) THEN 1 ELSE 0 END), 0) AS alt_entry_count
       FROM entries e`
    ).first<EntryStatsAggregate>(),
    db.prepare(
      `SELECT
         COUNT(*) AS torrent_count,
         COALESCE(SUM(CASE WHEN tracker = 'Nyaa' THEN 1 ELSE 0 END), 0) AS nyaa_torrent_count,
         COALESCE(SUM(CASE WHEN tracker IS NOT NULL AND tracker != 'Nyaa' THEN 1 ELSE 0 END), 0) AS pt_torrent_count
       FROM torrents`
    ).first<TorrentStatsAggregate>(),
    db.prepare("SELECT raw_record_count FROM metadata_stats WHERE id = 1").first<{ raw_record_count: number }>()
  ])
  let metadata = Number(metadataRow?.raw_record_count ?? 0)
  if (!metadata) {
    const fallback = await db.prepare("SELECT count(*) AS count FROM anime_metadata").first<{ count: number }>()
    metadata = Number(fallback?.count ?? 0)
  }
  const entries = Number(entryAggregate?.entry_count ?? 0)
  const incomplete = Number(entryAggregate?.incomplete_count ?? 0)
  const updated = now()
  await db.prepare(
    `INSERT INTO stats(id, entry_count, torrent_count, nyaa_torrent_count, pt_torrent_count,
       best_entry_count, alt_entry_count, incomplete_count, completion_rate, metadata_count, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET entry_count=excluded.entry_count,
       torrent_count=excluded.torrent_count, nyaa_torrent_count=excluded.nyaa_torrent_count,
       pt_torrent_count=excluded.pt_torrent_count, best_entry_count=excluded.best_entry_count,
       alt_entry_count=excluded.alt_entry_count, incomplete_count=excluded.incomplete_count,
       completion_rate=excluded.completion_rate, metadata_count=excluded.metadata_count,
       updated_at=excluded.updated_at`
  ).bind(
    entries,
    Number(torrentAggregate?.torrent_count ?? 0),
    Number(torrentAggregate?.nyaa_torrent_count ?? 0),
    Number(torrentAggregate?.pt_torrent_count ?? 0),
    Number(entryAggregate?.best_entry_count ?? 0),
    Number(entryAggregate?.alt_entry_count ?? 0),
    incomplete,
    entries ? ((entries - incomplete) / entries) * 100 : 0,
    metadata,
    updated
  ).run()
}

async function state<T>(db: D1Database, name: string): Promise<T | null> {
  const row = await db.prepare("SELECT value FROM sync_state WHERE name = ?").bind(name).first<{ value: string }>()
  if (!row) return null
  const parsed = JSON.parse(row.value) as T
  if (name.endsWith("_watermark") && parsed && typeof parsed === "object") {
    const value = parsed as T & { updated?: unknown; ids?: unknown }
    if (!Array.isArray(value.ids)) value.ids = []
    return value
  }
  return parsed
}

async function saveState(db: D1Database, name: string, value: unknown): Promise<void> {
  await db.prepare(
    `INSERT INTO sync_state(name, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(name, JSON.stringify(value), now()).run()
}

async function clearState(db: D1Database, name: string): Promise<void> {
  await db.prepare("DELETE FROM sync_state WHERE name = ?").bind(name).run()
}

async function page(env: Env, collection: "entries" | "torrents", pageNumber: number): Promise<PocketBasePage> {
  const url = new URL(`${env.SEADEX_API_URL}/${collection}/records`)
  url.searchParams.set("perPage", String(PAGE_SIZE))
  url.searchParams.set("page", String(pageNumber))
  url.searchParams.set("sort", "-updated")
  let lastError: unknown = null
  for (let attempt = 0; attempt < SEADEX_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(SEADEX_REQUEST_TIMEOUT_MS) })
      if (response.ok) return await response.json<PocketBasePage>()
      const error = new Error(`SeaDex ${collection} fetch failed: ${response.status}`)
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt === SEADEX_MAX_ATTEMPTS - 1) {
        lastError = error
        break
      }
      lastError = error
      const retryAfter = response.headers.get("retry-after")
      const retryAfterSeconds = Number(retryAfter ?? "")
      const retryAfterDate = retryAfter && !Number.isFinite(retryAfterSeconds) ? Date.parse(retryAfter) - Date.now() : 0
      const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : Number.isFinite(retryAfterDate) ? Math.max(0, retryAfterDate) : 0
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(Math.max(retryAfterMs, SEADEX_RETRY_BASE_MS * 2 ** attempt), 30_000)))
    } catch (error) {
      lastError = error
      if (attempt === SEADEX_MAX_ATTEMPTS - 1) break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, SEADEX_RETRY_BASE_MS * 2 ** attempt))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function entryFromApi(record: Record<string, unknown>): SeaDexEntry {
  return {
    id: String(record.id), alid: typeof record.alID === "number" ? record.alID : null,
    incomplete: Boolean(record.incomplete), notes: typeof record.notes === "string" ? record.notes : null,
    comparison: typeof record.comparison === "string" ? record.comparison : null,
    trs: Array.isArray(record.trs) ? record.trs.filter((item): item is string => typeof item === "string") : [],
    theoreticalBest: typeof record.theoreticalBest === "string" ? record.theoreticalBest : null,
    created: typeof record.created === "string" ? record.created : null, updated: String(record.updated ?? now())
  }
}

function torrentFromApi(record: Record<string, unknown>): SeaDexTorrent {
  return {
    id: String(record.id), url: typeof record.url === "string" ? record.url : null,
    infoHash: typeof record.infoHash === "string" ? record.infoHash : null,
    releaseGroup: typeof record.releaseGroup === "string" ? record.releaseGroup : null,
    tracker: typeof record.tracker === "string" ? record.tracker : null,
    isBest: Boolean(record.isBest), dualAudio: Boolean(record.dualAudio),
    groupedUrl: typeof record.groupedUrl === "string" ? record.groupedUrl : null,
    tags: Array.isArray(record.tags) ? record.tags.filter((item): item is string => typeof item === "string") : [],
    files: Array.isArray(record.files) ? record.files : [],
    created: typeof record.created === "string" ? record.created : null, updated: String(record.updated ?? now())
  }
}

/** Normalize API and importer timestamp formats for watermark comparison. */
export function compareUpdated(left: string, right: string): number {
  const leftTime = Date.parse(left.replace(" ", "T"))
  const rightTime = Date.parse(right.replace(" ", "T"))
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return Math.sign(leftTime - rightTime)
  return left === right ? 0 : left > right ? 1 : -1
}

export function entryChanges(oldEntry: SeaDexEntry | null, current: SeaDexEntry): Record<string, unknown> {
  if (!oldEntry) return {
    trs: { old: [], new: current.trs, added: current.trs },
    theoretical_best: { old: "", new: current.theoreticalBest ?? "" },
    notes: { old: "", new: current.notes ?? "" }, comparison: { old: "", new: current.comparison ?? "" }
  }
  const changes: Record<string, unknown> = {}
  const oldIds = new Set(oldEntry.trs)
  const currentIds = new Set(current.trs)
  if (oldEntry.trs.length !== current.trs.length || oldEntry.trs.some((id) => !currentIds.has(id))) changes.trs = {
    old: oldEntry.trs, new: current.trs, added: current.trs.filter((id) => !oldIds.has(id)), removed: oldEntry.trs.filter((id) => !currentIds.has(id))
  }
  const scalar: [keyof SeaDexEntry, string][] = [
    ["alid", "alID"], ["incomplete", "incomplete"],
    ["notes", "notes"], ["comparison", "comparison"], ["theoreticalBest", "theoretical_best"]
  ]
  for (const [field, name] of scalar) if ((oldEntry[field] ?? "") !== (current[field] ?? "")) changes[name] = { old: oldEntry[field] ?? "", new: current[field] ?? "" }
  return changes
}

/** Reconstruct the pre-update torrent list used by notification diffs. */
export function previousTorrentSnapshot(
  ids: string[],
  persisted: SeaDexTorrent[],
  changedBefore: Map<string, SeaDexTorrent>
): SeaDexTorrent[] {
  const persistedById = new Map(persisted.map((torrent) => [torrent.id, torrent]))
  return ids.flatMap((id) => {
    const torrent = changedBefore.get(id) ?? persistedById.get(id)
    return torrent ? [torrent] : []
  })
}

function torrentChanges(oldTorrent: SeaDexTorrent, current: SeaDexTorrent): Record<string, unknown> {
  const changes: Record<string, unknown> = {}
  for (const name of torrentFields) {
    if (name === "isBest") continue
    const oldValue = oldTorrent[name]
    const currentValue = current[name]
    if (JSON.stringify(oldValue) !== JSON.stringify(currentValue)) {
      const target = name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
      changes[target] = { old: oldValue, new: currentValue }
    }
  }
  return changes
}

function entryUpsert(db: D1Database, record: Record<string, unknown>): D1PreparedStatement {
  const entry = entryFromApi(record)
  return db.prepare(`INSERT INTO entries(id, alid, incomplete, notes, comparison, trs, theoretical_best, created, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET alid=excluded.alid, incomplete=excluded.incomplete,
    notes=excluded.notes, comparison=excluded.comparison, trs=excluded.trs, theoretical_best=excluded.theoretical_best, created=excluded.created, updated=excluded.updated`)
    .bind(entry.id, entry.alid, Number(entry.incomplete), entry.notes, entry.comparison, JSON.stringify(entry.trs), entry.theoreticalBest, entry.created, entry.updated)
}

function torrentUpsert(db: D1Database, record: Record<string, unknown>): D1PreparedStatement {
  const torrent = torrentFromApi(record)
  return db.prepare(`INSERT INTO torrents(id, url, info_hash, release_group, tracker, is_best, dual_audio, grouped_url, tags, files, created, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET url=excluded.url, info_hash=excluded.info_hash,
    release_group=excluded.release_group, tracker=excluded.tracker, is_best=excluded.is_best, dual_audio=excluded.dual_audio,
    grouped_url=excluded.grouped_url, tags=excluded.tags, files=excluded.files, created=excluded.created, updated=excluded.updated`)
    .bind(torrent.id, torrent.url, torrent.infoHash, torrent.releaseGroup, torrent.tracker, Number(torrent.isBest), Number(torrent.dualAudio), torrent.groupedUrl, JSON.stringify(torrent.tags), JSON.stringify(torrent.files), torrent.created, torrent.updated)
}

async function upsertEntries(db: D1Database, records: Record<string, unknown>[]): Promise<void> {
  const statements = records.map((record) => entryUpsert(db, record))
  if (statements.length) await db.batch(statements)
}

async function upsertTorrents(db: D1Database, records: Record<string, unknown>[]): Promise<void> {
  const statements = records.map((record) => torrentUpsert(db, record))
  if (statements.length) await db.batch(statements)
}

function stateUpsert(db: D1Database, name: string, value: unknown): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO sync_state(name, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(name, JSON.stringify(value), now())
}

export function updatedRecords(
  items: Record<string, unknown>[],
  watermark: Watermark | null,
  includeKnownFrontier = true
): Record<string, unknown>[] {
  if (!watermark) return items
  const frontier = new Set(watermark.ids)
  return items.filter((item) => {
    const updated = String(item.updated ?? "")
    const comparison = compareUpdated(updated, watermark.updated)
    if (comparison > 0) return true
    if (comparison < 0) return false
    // Include known frontier rows when the probe changed; fields may change without `updated`.
    return includeKnownFrontier || !frontier.has(String(item.id ?? ""))
  })
}

export function nextWatermark(previous: Watermark | null, items: Record<string, unknown>[]): Watermark | null {
  const candidates = items
  if (!candidates.length) return previous
  let newest = previous?.updated ?? ""
  for (const item of candidates) {
    const updated = String(item.updated ?? "")
    if (!newest || compareUpdated(updated, newest) > 0) newest = updated
  }
  if (!newest) return previous
  const ids = items
    .filter((item) => compareUpdated(String(item.updated ?? ""), newest) === 0)
    .map((item) => String(item.id ?? ""))
  const sameFrontier = Boolean(previous && compareUpdated(newest, previous.updated) === 0)
  return { updated: newest, ids: sameFrontier ? [...new Set([...(previous?.ids ?? []), ...ids])] : ids }
}

async function initialPage(env: Env, stateValue: InitialState): Promise<void> {
  const started = Date.now()
  const syncRunId = stateValue.runId ?? newSyncRunId()
  try {
    if (!stateValue.runId) {
      await createSyncRun(env.DB, syncRunId, "full")
      await saveState(env.DB, "initial_sync", { ...stateValue, runId: syncRunId })
    }
    const result = await page(env, stateValue.phase, stateValue.page)
    if (stateValue.phase === "entries") await upsertEntries(env.DB, result.items)
    else await upsertTorrents(env.DB, result.items)
    if (stateValue.page < result.totalPages) {
      await saveState(env.DB, "initial_sync", { ...stateValue, runId: syncRunId, page: stateValue.page + 1 })
    } else if (stateValue.phase === "entries") {
      await saveState(env.DB, "initial_sync", { ...stateValue, runId: syncRunId, phase: "torrents", page: 1 })
    } else {
      for (const collection of ["entries", "torrents"] as const) {
        const rows = (await env.DB.prepare(`SELECT id, updated FROM ${collection}`).all<{ id: string; updated: string }>()).results
        let newest: string | null = null
        for (const row of rows) {
          if (!newest || compareUpdated(row.updated, newest) > 0) newest = row.updated
        }
        const ids = newest ? rows.filter((row) => compareUpdated(row.updated, newest!) === 0).map((row) => row.id) : []
        if (newest) await saveState(env.DB, `${collection}_watermark`, { updated: newest, ids })
      }
      const [entryCount, torrentCount] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS count FROM entries").first<{ count: number }>(),
        env.DB.prepare("SELECT COUNT(*) AS count FROM torrents").first<{ count: number }>()
      ])
      await refreshStats(env.DB)
      await finishSyncRun(env.DB, syncRunId, {
        entriesAdded: Math.max(0, Number(entryCount?.count ?? 0) - Number(stateValue.baseEntries ?? 0)),
        torrentsAdded: Math.max(0, Number(torrentCount?.count ?? 0) - Number(stateValue.baseTorrents ?? 0))
      })
      await env.DB.prepare("DELETE FROM sync_state WHERE name = ?").bind("initial_sync").run()
      await saveState(env.DB, "sync_initialized", { completedAt: now() })
    }
    console.log("SeaDex initial sync page", {
      phase: stateValue.phase,
      page: stateValue.page,
      records: result.items.length,
      durationMs: Date.now() - started
    })
    await env.SYNC_QUEUE.send({ kind: "sync_tick" })
  } catch (error) {
    try {
      await failSyncRun(env.DB, syncRunId, error)
    } catch (auditError) {
      console.error("SeaDex initial sync audit update failed", { syncRunId, error: String(auditError) })
    }
    throw error
  }
}

async function beginInitialSync(env: Env): Promise<void> {
  const [entryCount, torrentCount] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM entries").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM torrents").first<{ count: number }>()
  ])
  const runId = newSyncRunId()
  const stateValue: InitialState = {
    phase: "entries",
    page: 1,
    runId,
    baseEntries: Number(entryCount?.count ?? 0),
    baseTorrents: Number(torrentCount?.count ?? 0)
  }
  await createSyncRun(env.DB, runId, "full")
  await saveState(env.DB, "initial_sync", stateValue)
  await env.SYNC_QUEUE.send({ kind: "sync_tick" })
}

const OUTBOX_MAX_ATTEMPTS = 8

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

async function markOutboxFailed(env: Env, id: number, attempts: number, message: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE notification_outbox SET attempts = ?, last_error = ?, failed_at = ?, available_at = ? WHERE id = ?"
  ).bind(attempts, message, now(), now(), id).run()
}

async function deliverOutbox(env: Env, id: number, payload: OutboxPayload, attempts = 0, maxAttempts = OUTBOX_MAX_ATTEMPTS): Promise<void> {
  try {
    await sendPush(env, payload.chatId, payload.metadata, payload.caption, payload.replyMarkup)
    await env.DB.prepare("UPDATE notification_outbox SET sent_at = ?, available_at = ? WHERE id = ?")
      .bind(now(), now(), id).run()
  } catch (error) {
    const nextAttempts = attempts + 1
    const permanent = error instanceof TelegramApiError && error.permanent
    if (permanent || nextAttempts >= maxAttempts) {
      await markOutboxFailed(env, id, nextAttempts, errorText(error))
      console.error("SeaDex notification delivery permanently failed", { id, attempts: nextAttempts, error: errorText(error) })
      return
    }
    const retryAt = new Date(Date.now() + Math.min(60_000 * 2 ** Math.max(0, nextAttempts - 1), 15 * 60_000)).toISOString()
    await env.DB.prepare("UPDATE notification_outbox SET attempts = ?, last_error = ?, available_at = ? WHERE id = ?")
      .bind(nextAttempts, errorText(error), retryAt, id).run()
    console.error("SeaDex notification delivery failed; retained in outbox", { id, attempts: nextAttempts, error: errorText(error) })
  }
}

async function retryNotificationOutbox(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, payload, attempts, max_attempts FROM notification_outbox WHERE sent_at IS NULL AND failed_at IS NULL AND available_at <= ? ORDER BY id LIMIT 20"
  ).bind(now()).all<{ id: number; payload: string; attempts: number; max_attempts: number }>()
  for (const row of results) {
    try {
      const payload = JSON.parse(row.payload) as OutboxPayload
      if (!payload.chatId || !payload.metadata || typeof payload.caption !== "string") {
        await markOutboxFailed(env, row.id, Number(row.attempts ?? 0) + 1, "invalid notification payload")
        continue
      }
      await deliverOutbox(env, row.id, payload, Number(row.attempts ?? 0), Number(row.max_attempts ?? OUTBOX_MAX_ATTEMPTS))
    } catch (error) {
      console.error("Invalid SeaDex notification outbox payload", { id: row.id, error: String(error) })
      await markOutboxFailed(env, row.id, Number(row.attempts ?? 0) + 1, errorText(error))
    }
  }
}

async function prepareEntryNotifications(env: Env, oldEntry: SeaDexEntry | null, current: SeaDexEntry, changes: Record<string, unknown>, torrentFieldChanges: Record<string, Record<string, unknown>>, previousTorrents: SeaDexTorrent[], currentTorrents: SeaDexTorrent[]): Promise<PendingNotification[]> {
  if (!current.alid || !env.TELEGRAM_PUSH_IDS) return []
  const metadata = await getMetadata(env.DB, current.alid) ?? {
    anilistId: current.alid,
    title: `Anime (${current.alid})`,
    picture: null,
    thumbnail: null,
    type: null,
    seasonYear: null
  }
  const message = buildUpdateNotification(metadata, { isNew: !oldEntry, current, fieldChanges: changes, torrentFieldChanges, previousTorrents, currentTorrents })
  if (!message) return []
  // Preserve diff order for deduplication and the 12-button limit.
  const selected = message.buttonTorrentIds.length
    ? message.buttonTorrentIds.flatMap((id) => currentTorrents.filter((torrent) => torrent.id === id))
    : []
  const replyMarkup = { inline_keyboard: buttons(metadata, selected) }
  return (env.TELEGRAM_PUSH_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean).map((chatId) => {
    // Keep entry identity so identical rendered notifications remain distinct.
    const payload: OutboxPayload = {
      chatId,
      entryId: current.id,
      updated: current.updated,
      metadata,
      caption: message.caption,
      replyMarkup
    }
    return { payload, serialized: JSON.stringify(payload) }
  })
}

async function changedPages(
  env: Env,
  collection: "entries" | "torrents",
  watermark: Watermark | null,
  force = false,
  relatedTorrentIds: Set<string> = new Set()
): Promise<{ records: Record<string, unknown>[]; head: Record<string, unknown>[]; probe: string }> {
  const records: Record<string, unknown>[] = []
  const seen = new Set<string>()
  const foundRelated = new Set<string>()
  const first = await page(env, collection, 1)
  const head = first.items
  const probe = probeHash(head)
  const previousProbe = await state<string>(env.DB, `${collection}_probe`)
  if (!force && watermark && previousProbe === probe) return { records, head, probe }
  const includeKnownFrontier = force || previousProbe !== probe

  let pageNumber = 1
  while (true) {
    const result = pageNumber === 1 ? first : await page(env, collection, pageNumber)
    const changed = updatedRecords(result.items, watermark, includeKnownFrontier)
    const related = collection === "entries" && force && relatedTorrentIds.size
      ? result.items.filter((item) => {
          const ids = Array.isArray(item.trs) ? item.trs : []
          const matches = ids.filter((id): id is string => typeof id === "string" && relatedTorrentIds.has(id))
          for (const id of matches) foundRelated.add(id)
          return matches.length > 0
        })
      : []
    for (const record of [...changed, ...related]) {
      const id = String(record.id ?? "")
      if (!seen.has(id)) {
        seen.add(id)
        records.push(record)
      }
    }
    const reachedKnownHistory = pageNumber >= result.totalPages ||
      (!force && changed.length !== result.items.length) ||
      (force && relatedTorrentIds.size > 0 && foundRelated.size === relatedTorrentIds.size)
    if (reachedKnownHistory) break
    pageNumber += 1
  }
  return { records, head, probe }
}

const D1_BATCH_STATEMENT_LIMIT = 90

async function batchInGroups(db: D1Database, groups: D1PreparedStatement[][]): Promise<void> {
  let batch: D1PreparedStatement[] = []
  const flush = async (): Promise<void> => {
    if (!batch.length) return
    await db.batch(batch)
    batch = []
  }
  for (const group of groups) {
    if (group.length > D1_BATCH_STATEMENT_LIMIT) {
      await flush()
      for (let offset = 0; offset < group.length; offset += D1_BATCH_STATEMENT_LIMIT) {
        await db.batch(group.slice(offset, offset + D1_BATCH_STATEMENT_LIMIT))
      }
    } else {
      if (batch.length + group.length > D1_BATCH_STATEMENT_LIMIT) await flush()
      batch.push(...group)
    }
  }
  await flush()
}

type PendingEntry = {
  old: SeaDexEntry | null
  current: SeaDexEntry
  changes: Record<string, unknown>
  torrentChanges: Record<string, Record<string, unknown>>
}

function appendTorrentAddition(changes: Record<string, unknown>, id: string, current: SeaDexEntry): void {
  const trs = (changes.trs && typeof changes.trs === "object" ? changes.trs : {}) as Record<string, unknown>
  const added = Array.isArray(trs.added) ? trs.added.filter((value): value is string => typeof value === "string") : []
  if (!added.includes(id)) added.push(id)
  changes.trs = { old: Array.isArray(trs.old) ? trs.old : current.trs.filter((value) => value !== id), new: current.trs, ...trs, added }
}

function entryAuditDiff(item: PendingEntry): SyncDiffInput | null {
  const diff: Record<string, unknown> = { ...item.changes }
  if (item.old && compareUpdated(item.old.updated, item.current.updated) !== 0) {
    diff.updated = { old: item.old.updated, new: item.current.updated }
  }
  if (Object.keys(item.torrentChanges).length) diff.torrent_field_changes = item.torrentChanges
  if (!Object.keys(diff).length) return null
  return {
    type: item.old ? "updated" : "added",
    entityType: "entry",
    entityId: item.current.id,
    diff
  }
}

function torrentAuditDiff(id: string, before: SeaDexTorrent | null, after: SeaDexTorrent): SyncDiffInput | null {
  if (!before) {
    return { type: "added", entityType: "torrent", entityId: id, diff: { is_new: true } }
  }
  const diff = torrentChanges(before, after)
  if (before.isBest !== after.isBest) diff.is_best = { old: before.isBest, new: after.isBest }
  if (compareUpdated(before.updated, after.updated) !== 0) diff.updated = { old: before.updated, new: after.updated }
  if (!Object.keys(diff).length) return null
  return { type: "updated", entityType: "torrent", entityId: id, diff }
}

async function incremental(env: Env): Promise<void> {
  const started = Date.now()
  const entryWatermark = await state<Watermark>(env.DB, "entries_watermark")
  const torrentWatermark = await state<Watermark>(env.DB, "torrents_watermark")
  let [entryFeed, torrentFeed] = await Promise.all([
    changedPages(env, "entries", entryWatermark), changedPages(env, "torrents", torrentWatermark)
  ])
  const changedTorrentIds = [...new Set(torrentFeed.records.map((record) => String(record.id ?? "")).filter(Boolean))]
  const oldTorrents = new Map<string, SeaDexTorrent | null>()
  for (const torrent of await getTorrents(env.DB, changedTorrentIds)) oldTorrents.set(torrent.id, torrent)
  for (const id of changedTorrentIds) if (!oldTorrents.has(id)) oldTorrents.set(id, null)
  const newTorrentIds = new Set(changedTorrentIds.filter((id) => !oldTorrents.get(id)))
  // Scan entries when new torrents may precede their parent entry in the feed.
  if (newTorrentIds.size) {
    const relatedFeed = await changedPages(env, "entries", entryWatermark, true, newTorrentIds)
    const records = new Map<string, Record<string, unknown>>()
    for (const record of [...entryFeed.records, ...relatedFeed.records]) {
      const id = String(record.id ?? "")
      if (id) records.set(id, record)
    }
    entryFeed = { ...relatedFeed, records: [...records.values()] }
  }
  const entryRecords = entryFeed.records
  const torrentRecords = torrentFeed.records
  if (!entryRecords.length && !torrentRecords.length) {
    await saveState(env.DB, "entries_probe", entryFeed.probe)
    await saveState(env.DB, "torrents_probe", torrentFeed.probe)
    console.log("SeaDex incremental sync", { entries: 0, torrents: 0, durationMs: Date.now() - started })
    return
  }

  const oldEntries = await findEntriesByIds(env.DB, entryRecords.map((record) => String(record.id ?? "")))
  const affected = await findEntriesByTorrentIds(env.DB, changedTorrentIds)
  const oldParentEntries = new Map(affected.map((entry) => [entry.id, entry]))

  const pending = new Map<string, PendingEntry>()
  for (const record of entryRecords) {
    const id = String(record.id ?? "")
    const current = entryFromApi(record)
    const old = oldEntries.get(id) ?? null
    pending.set(id, { old, current, changes: entryChanges(old, current), torrentChanges: {} })
  }

  // Assign shared new torrents to the first changed entry, matching the original service.
  const assignedNewTorrents = new Set<string>()
  for (const item of pending.values()) {
    const added = item.changes.trs && typeof item.changes.trs === "object"
      ? (item.changes.trs as { added?: unknown }).added
      : []
    for (const id of Array.isArray(added) ? added : []) {
      if (typeof id === "string" && newTorrentIds.has(id)) assignedNewTorrents.add(id)
    }
  }

  const remoteTorrents = new Map(torrentRecords.map((record) => {
    const torrent = torrentFromApi(record)
    return [torrent.id, torrent] as const
  }))
  for (const persisted of affected) {
    const item = pending.get(persisted.id)
    const current = item?.current ?? persisted
    const referenced = changedTorrentIds.filter((candidate) => current.trs.includes(candidate))
    // Existing torrent updates require an entry update; do not fan out.
    if (!item) {
      const additions = referenced.filter((id) => newTorrentIds.has(id) && !assignedNewTorrents.has(id))
      if (!additions.length) continue
      const created: PendingEntry = {
        old: oldParentEntries.get(current.id) ?? current,
        current,
        changes: {},
        torrentChanges: {}
      }
      for (const id of additions) {
        appendTorrentAddition(created.changes, id, current)
        assignedNewTorrents.add(id)
      }
      pending.set(current.id, created)
      continue
    }

    for (const id of referenced) {
      const before = oldTorrents.get(id) ?? null
      const after = remoteTorrents.get(id) ?? (await getTorrents(env.DB, [id]))[0]
      if (!after) continue
      if (!before) {
        appendTorrentAddition(item.changes, id, current)
        assignedNewTorrents.add(id)
        continue
      }
      const changes = torrentChanges(before, after)
      if (Object.keys(changes).length) item.torrentChanges[id] = changes
      if (before.isBest !== after.isBest) {
        const isBest = (item.changes.is_best && typeof item.changes.is_best === "object" ? item.changes.is_best : {}) as Record<string, unknown>
        isBest[id] = { old: before.isBest, new: after.isBest }
        item.changes.is_best = isBest
      }
    }
    pending.set(current.id, item)
  }
  const notifications: PendingNotification[] = []
  const auditDiffs: SyncDiffInput[] = []
  const ordered = [...pending.values()].sort((left, right) => compareUpdated(left.current.updated, right.current.updated) || left.current.id.localeCompare(right.current.id))
  const notificationTorrentIds = [...new Set(ordered.flatMap((item) => [
    ...(item.old?.trs ?? item.current.trs),
    ...item.current.trs
  ]))]
  const unchangedTorrentIds = notificationTorrentIds.filter((id) => !oldTorrents.has(id))
  const persistedTorrents = [
    ...[...oldTorrents.values()].filter((torrent): torrent is SeaDexTorrent => Boolean(torrent)),
    ...await getTorrents(env.DB, unchangedTorrentIds)
  ]
  const beforeById = new Map(
    [...oldTorrents.entries()].filter((entry): entry is [string, SeaDexTorrent] => Boolean(entry[1]))
  )
  const persistedById = new Map(persistedTorrents.map((torrent) => [torrent.id, torrent]))
  const currentById = new Map(persistedById)
  for (const [id, torrent] of remoteTorrents) currentById.set(id, torrent)
  for (const item of ordered) {
    const previousIds = item.old?.trs ?? item.current.trs
    const currentTorrents = item.current.trs.flatMap((id) => {
      const torrent = currentById.get(id)
      return torrent ? [torrent] : []
    })
    const previousTorrents = previousTorrentSnapshot(previousIds, persistedTorrents, beforeById)
    notifications.push(...await prepareEntryNotifications(env, item.old, item.current, item.changes, item.torrentChanges, previousTorrents, currentTorrents))
    const entryDiff = entryAuditDiff(item)
    if (entryDiff) auditDiffs.push(entryDiff)
  }
  for (const id of changedTorrentIds) {
    const after = remoteTorrents.get(id)
    if (!after) continue
    const torrentDiff = torrentAuditDiff(id, oldTorrents.get(id) ?? null, after)
    if (torrentDiff) auditDiffs.push(torrentDiff)
  }
  // Carry all visited pages into the watermark to avoid repeated same-timestamp IDs.
  const entryNext = nextWatermark(entryWatermark, entryFeed.records)
  const torrentNext = nextWatermark(torrentWatermark, torrentFeed.records)
  const syncRunId = newSyncRunId()
  await createSyncRun(env.DB, syncRunId, "incremental")
  const auditStatements = new Map<string, D1PreparedStatement>()
  for (const diff of auditDiffs) {
    auditStatements.set(`${diff.entityType}:${diff.entityId}`, syncDiffStatement(env.DB, syncRunId, diff))
  }
  const notificationStatements = new Map<string, D1PreparedStatement[]>()
  const notificationKeys = new Set<string>()
  for (const notification of notifications) {
    const key = `${notification.payload.chatId}\n${notification.serialized}`
    if (notificationKeys.has(key)) continue
    notificationKeys.add(key)
    const existing = await env.DB.prepare(
      "SELECT id FROM notification_outbox WHERE chat_id = ? AND payload = ? AND sent_at IS NULL AND failed_at IS NULL LIMIT 1"
    ).bind(notification.payload.chatId, notification.serialized).first<{ id: number }>()
    if (!existing) {
      const statement = env.DB.prepare(
        `INSERT OR IGNORE INTO notification_outbox(chat_id, payload, sync_run_id, dedupe_key,
           attempts, max_attempts, available_at, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
      ).bind(notification.payload.chatId, notification.serialized, syncRunId, notification.serialized, OUTBOX_MAX_ATTEMPTS, now(), now())
      const entryId = notification.payload.entryId
      const statements = notificationStatements.get(entryId) ?? []
      statements.push(statement)
      notificationStatements.set(entryId, statements)
    }
  }
  const dataGroups: D1PreparedStatement[][] = []
  const consumedAudit = new Set<string>()
  const consumedNotifications = new Set<string>()
  // Keep each source row with its audit and outbox statements across batch boundaries.
  for (const record of entryRecords) {
    const id = String(record.id ?? "")
    const group = [entryUpsert(env.DB, record)]
    const auditKey = `entry:${id}`
    const audit = auditStatements.get(auditKey)
    if (audit) {
      group.push(audit)
      consumedAudit.add(auditKey)
    }
    const notificationsForEntry = notificationStatements.get(id)
    if (notificationsForEntry) {
      group.push(...notificationsForEntry)
      consumedNotifications.add(id)
    }
    dataGroups.push(group)
  }
  // Persist entries first so retries rediscover torrents before advancing state.
  for (const record of torrentRecords) {
    const id = String(record.id ?? "")
    const group = [torrentUpsert(env.DB, record)]
    const auditKey = `torrent:${id}`
    const audit = auditStatements.get(auditKey)
    if (audit) {
      group.push(audit)
      consumedAudit.add(auditKey)
    }
    dataGroups.push(group)
  }
  for (const [key, statement] of auditStatements) if (!consumedAudit.has(key)) dataGroups.push([statement])
  for (const [entryId, statements] of notificationStatements) if (!consumedNotifications.has(entryId)) dataGroups.push(statements)
  // Persist the dirty marker with the data batch so a later retry can repair stats after a partial failure.
  dataGroups.unshift([stateUpsert(env.DB, "stats_dirty", true)])
  const stateStatements: D1PreparedStatement[] = []
  if (entryNext) stateStatements.push(stateUpsert(env.DB, "entries_watermark", entryNext))
  if (torrentNext) stateStatements.push(stateUpsert(env.DB, "torrents_watermark", torrentNext))
  stateStatements.push(stateUpsert(env.DB, "entries_probe", entryFeed.probe))
  stateStatements.push(stateUpsert(env.DB, "torrents_probe", torrentFeed.probe))
  // Advance watermarks only after idempotent source and outbox writes complete.
  try {
    await batchInGroups(env.DB, dataGroups)
    await env.DB.batch(stateStatements)
  } catch (error) {
    await failSyncRun(env.DB, syncRunId, error)
    throw error
  }
  try {
    for (const notification of notifications) {
      const row = await env.DB.prepare(
        "SELECT id, attempts, max_attempts FROM notification_outbox WHERE chat_id = ? AND payload = ? AND sent_at IS NULL AND failed_at IS NULL ORDER BY id LIMIT 1"
      ).bind(notification.payload.chatId, notification.serialized).first<{ id: number; attempts: number; max_attempts: number }>()
      if (row) await deliverOutbox(env, row.id, notification.payload, Number(row.attempts ?? 0), Number(row.max_attempts ?? OUTBOX_MAX_ATTEMPTS))
    }
    await refreshStats(env.DB)
    await clearState(env.DB, "stats_dirty")
    await finishSyncRun(env.DB, syncRunId, {
      entriesAdded: auditDiffs.filter((diff) => diff.entityType === "entry" && diff.type === "added").length,
      entriesUpdated: auditDiffs.filter((diff) => diff.entityType === "entry" && diff.type === "updated").length,
      torrentsAdded: auditDiffs.filter((diff) => diff.entityType === "torrent" && diff.type === "added").length,
      torrentsUpdated: auditDiffs.filter((diff) => diff.entityType === "torrent" && diff.type === "updated").length
    })
  } catch (error) {
    await failSyncRun(env.DB, syncRunId, error)
    throw error
  }
  console.log("SeaDex incremental sync", {
    entries: entryRecords.length,
    torrents: torrentRecords.length,
    notifications: pending.size,
    durationMs: Date.now() - started
  })
}

export async function runSyncTick(env: Env): Promise<void> {
  await retryNotificationOutbox(env)
  const initial = await state<InitialState>(env.DB, "initial_sync")
  if (initial) return initialPage(env, initial)
  const initialized = await state<{ completedAt?: string }>(env.DB, "sync_initialized")
  if (!initialized) {
    const [entryPresent, torrentPresent] = await Promise.all([
      env.DB.prepare("SELECT 1 AS present FROM entries LIMIT 1").first<{ present: number }>(),
      env.DB.prepare("SELECT 1 AS present FROM torrents LIMIT 1").first<{ present: number }>()
    ])
    if (!entryPresent || !torrentPresent) {
      await beginInitialSync(env)
      return
    }
  }
  if (await state<boolean>(env.DB, "stats_dirty")) {
    await refreshStats(env.DB)
    await clearState(env.DB, "stats_dirty")
  }
  // incremental() refreshes stats only after a batch changes data. Avoid a full-table reconciliation on every tick.
  await incremental(env)
}
