import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { buildSearchText } from "../src/search"

type JsonObject = Record<string, unknown>

type AnimeDbEntry = {
  sources?: string[]
  title?: string
  type?: string
  animeSeason?: { year?: number }
  picture?: string
  thumbnail?: string
  synonyms?: string[]
}

type BangumiEntry = {
  title?: string
  titleTranslate?: Record<string, string | string[]>
  sites?: Array<{ site?: string; id?: string | number }>
}

type KnownRelationsPayload = {
  version?: number
  relations?: Array<{ bangumi_id?: unknown; anilist_id?: unknown }>
  data?: Record<string, unknown>
}

type AniListEntry = {
  id: number
  title?: {
    english?: string | null
    romaji?: string | null
    native?: string | null
    userPreferred?: string | null
  }
  synonyms?: unknown[]
  type?: string | null
  format?: string | null
  seasonYear?: number | null
  coverImage?: { large?: string | null; medium?: string | null } | null
}

type BuiltMetadata = {
  anilistId: number
  title: string
  picture: string | null
  thumbnail: string | null
  type: string | null
  seasonYear: number | null
  aliases: Set<string>
  titleSource: "placeholder" | "anime-offline-database" | "bangumi-data" | "anilist"
}

type MetadataStateRecord = Omit<BuiltMetadata, "aliases" | "titleSource"> & { aliases: string[] }

type MetadataState = {
  version: 1
  anilist: AniListEntry[]
  records: MetadataStateRecord[]
  sourceFingerprint: string
  updatedAt: string
}

export function formatPictureUrl(url: string | null | undefined): string | null {
  if (!url) return null
  if (!url.includes("cdn.myanimelist.net")) return url
  if (url.endsWith("t.jpg")) return `${url.slice(0, -5)}l.jpg`
  if (url.endsWith("l.jpg")) return url
  if (url.endsWith(".jpg")) return `${url.slice(0, -4)}l.jpg`
  return url
}

const DEFAULTS = {
  animeDb: "https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json",
  bangumiDb: "https://raw.githubusercontent.com/bangumi-data/bangumi-data/master/dist/data.json",
  seadexIds: "https://releases.moe/api/listIDs",
  anilistApi: "https://graphql.anilist.co"
}

const ANILIST_QUERY = `query Metadata($page: Int!, $perPage: Int!, $ids: [Int!]) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: ANIME, id_in: $ids, sort: ID) {
      id
      title { english romaji native userPreferred }
      synonyms
      type
      format
      seasonYear
      coverImage { large medium }
    }
  }
}`

// Stay below AniList's 30 requests-per-minute limit.
const ANILIST_MIN_INTERVAL_MS = 2_100
let lastAniListRequestAt = 0

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function argumentAny(names: string[], fallback: string): string {
  for (const name of names) {
    const index = process.argv.indexOf(name)
    if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  }
  return fallback
}

async function readSource(source: string): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { headers: { accept: "application/json" } })
    if (!response.ok) throw new Error(`Download failed (${response}): ${response.status}`)
    return response.text()
  }
  return readFile(resolve(source), "utf8")
}

async function readState(source: string): Promise<MetadataState | null> {
  try {
    const payload = JSON.parse(await readFile(resolve(source), "utf8")) as Partial<MetadataState>
    if (payload.version !== 1 || !Array.isArray(payload.anilist) || !Array.isArray(payload.records)) return null
    return payload as MetadataState
  } catch {
    return null
  }
}

async function writeState(source: string, stateValue: MetadataState): Promise<void> {
  await mkdir(dirname(resolve(source)), { recursive: true })
  await writeFile(resolve(source), `${JSON.stringify(stateValue)}\n`, "utf8")
}

function parseAniListEntries(payload: unknown): AniListEntry[] {
  if (Array.isArray(payload)) return payload.filter(isAniListEntry)
  if (!payload || typeof payload !== "object") return []
  const value = payload as JsonObject
  const data = value.data && typeof value.data === "object" ? value.data as JsonObject : value
  const page = data.Page && typeof data.Page === "object" ? data.Page as JsonObject : data
  const media = page.media ?? page.items ?? value.items
  return Array.isArray(media) ? media.filter(isAniListEntry) : []
}

function isAniListEntry(value: unknown): value is AniListEntry {
  return Boolean(value && typeof value === "object" && Number.isSafeInteger((value as JsonObject).id))
}

function parseIdList(value: string): number[] {
  return [...new Set(value.split(",").map((item) => Number(item.trim())).filter((id) => Number.isSafeInteger(id) && id > 0))]
}

function parseNumericIds(payload: unknown): number[] {
  if (typeof payload === "string") return parseIdList(payload.replaceAll(/\s+/g, ","))
  if (Array.isArray(payload)) {
    return [...new Set(payload.map((value) => Number(value)).filter((id) => Number.isSafeInteger(id) && id > 0))]
  }
  if (!payload || typeof payload !== "object") return []
  const value = payload as JsonObject
  return parseNumericIds(value.ids ?? value.data ?? [])
}

function parseKnownRelations(payload: unknown): Map<number, number> {
  const result = new Map<number, number>()
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (!item || typeof item !== "object") continue
      const relation = item as { bangumi_id?: unknown; anilist_id?: unknown; bgm_id?: unknown }
      const bangumiId = Number(relation.bangumi_id ?? relation.bgm_id)
      const anilistId = Number(relation.anilist_id)
      if (Number.isSafeInteger(bangumiId) && bangumiId > 0 && Number.isSafeInteger(anilistId) && anilistId > 0) {
        result.set(bangumiId, anilistId)
      }
    }
    return result
  }
  if (!payload || typeof payload !== "object") return result
  const value = payload as KnownRelationsPayload
  if (Array.isArray(value.relations)) return parseKnownRelations(value.relations)
  for (const [bangumi, anilist] of Object.entries(value.data ?? {})) {
    const bangumiId = Number(bangumi)
    const anilistId = Number(anilist)
    if (Number.isSafeInteger(bangumiId) && bangumiId > 0 && Number.isSafeInteger(anilistId) && anilistId > 0) {
      result.set(bangumiId, anilistId)
    }
  }
  return result
}

async function fetchAniListPage(endpoint: string, page: number, ids: number[]): Promise<{ entries: AniListEntry[]; hasNextPage: boolean }> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const elapsed = Date.now() - lastAniListRequestAt
      if (elapsed < ANILIST_MIN_INTERVAL_MS) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, ANILIST_MIN_INTERVAL_MS - elapsed))
      }
      lastAniListRequestAt = Date.now()
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          query: ANILIST_QUERY,
          variables: { page, perPage: 50, ids }
        }),
        signal: controller.signal
      })
      const payload: JsonObject = await response.json<JsonObject>().catch(() => ({} as JsonObject))
      if (response.ok && !Array.isArray(payload.errors)) {
        const data = payload.data && typeof payload.data === "object" ? payload.data as JsonObject : {}
        const pageData = data.Page && typeof data.Page === "object" ? data.Page as JsonObject : {}
        const pageInfo = pageData.pageInfo && typeof pageData.pageInfo === "object" ? pageData.pageInfo as JsonObject : {}
        return {
          entries: parseAniListEntries(payload),
          hasNextPage: pageInfo.hasNextPage === true
        }
      }
      const retryAfter = Number(response.headers.get("retry-after") ?? "0")
      lastError = new Error(`AniList request failed: ${response.status} ${JSON.stringify(payload.errors ?? payload)}`)
      if (response.status !== 429 && response.status < 500) throw lastError
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(retryAfter * 1000, 1000 * 2 ** attempt)))
    } catch (error) {
      lastError = error
      if (attempt === 3) break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000 * 2 ** attempt))
    } finally {
      clearTimeout(timeout)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function fetchAniListEntries(endpoint: string, ids: number[]): Promise<AniListEntry[]> {
  if (!ids.length) return []
  const entries: AniListEntry[] = []
  for (let offset = 0; offset < ids.length; offset += 50) {
    const result = await fetchAniListPage(endpoint, 1, ids.slice(offset, offset + 50))
    entries.push(...result.entries)
  }
  return entries
}

function asArray(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : []
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []
}

function animeDbEntries(payload: unknown): unknown[] {
  return Array.isArray(payload) ? payload : (payload as { data?: unknown[] }).data ?? []
}

function anilistId(sources: string[] | undefined): number | null {
  for (const source of sources ?? []) {
    const match = source.match(/anilist\.co\/anime\/(\d+)/i)
    if (match) return Number(match[1])
  }
  return null
}

function siteId(entry: BangumiEntry, site: string): string | null {
  const value = entry.sites?.find((candidate) => candidate.site === site)?.id
  return value === undefined || value === null ? null : String(value)
}

function directAniListTarget(entry: BangumiEntry): number | null {
  const direct = siteId(entry, "aniList")
  if (direct && /^\d+$/.test(direct)) return Number(direct)
  return null
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''").replaceAll("\0", "")}'`
}

function sqlValue(value: string | number | null): string {
  return value === null ? "NULL" : typeof value === "number" ? String(value) : sqlString(value)
}

function fingerprint(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex")
}

function sortedAliases(record: BuiltMetadata): string[] {
  return [...new Set([...record.aliases].map((value) => value.trim()).filter(Boolean))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

function metadataRecordFingerprint(record: BuiltMetadata): string {
  const aliases = sortedAliases(record)
  const searchText = buildSearchText(aliases)
  return fingerprint([
    String(record.anilistId), record.title, record.picture ?? "", record.thumbnail ?? "",
    record.type ?? "", String(record.seasonYear ?? ""), searchText, JSON.stringify(aliases)
  ])
}

function stateRecord(record: BuiltMetadata): MetadataStateRecord {
  return {
    anilistId: record.anilistId,
    title: record.title,
    picture: record.picture,
    thumbnail: record.thumbnail,
    type: record.type,
    seasonYear: record.seasonYear,
    aliases: sortedAliases(record)
  }
}

function stateRecordFingerprint(record: MetadataStateRecord): string {
  const aliases = [...new Set(record.aliases)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  return fingerprint([
    String(record.anilistId), record.title, record.picture ?? "", record.thumbnail ?? "",
    record.type ?? "", String(record.seasonYear ?? ""), buildSearchText(aliases), JSON.stringify(aliases)
  ])
}

function changedRecords(records: BuiltMetadata[], previous: MetadataState | null): BuiltMetadata[] {
  if (!previous) return records
  const previousById = new Map(previous.records.map((record) => [record.anilistId, record]))
  return records.filter((record) => {
    const old = previousById.get(record.anilistId)
    return !old || stateRecordFingerprint(stateRecord(record)) !== stateRecordFingerprint(old)
  })
}

function mergeAniListEntries(...groups: AniListEntry[][]): AniListEntry[] {
  const merged = new Map<number, AniListEntry>()
  for (const group of groups) {
    for (const entry of group) {
      if (Number.isSafeInteger(entry.id) && entry.id > 0) merged.set(entry.id, entry)
    }
  }
  return [...merged.values()].sort((left, right) => left.id - right.id)
}

function recordFor(records: Map<number, BuiltMetadata>, id: number): BuiltMetadata {
  const existing = records.get(id)
  if (existing) return existing
  const created: BuiltMetadata = {
    anilistId: id,
    title: `AniList (${id})`,
    picture: null,
    thumbnail: null,
    type: null,
    seasonYear: null,
    aliases: new Set(),
    titleSource: "placeholder"
  }
  records.set(id, created)
  return created
}

function addAnimeDb(records: Map<number, BuiltMetadata>, payload: unknown): void {
  for (const raw of animeDbEntries(payload)) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as AnimeDbEntry
    const id = anilistId(entry.sources)
    if (!id) continue
    const record = recordFor(records, id)
    if (entry.title?.trim() && record.titleSource === "placeholder") {
      record.title = entry.title
      record.titleSource = "anime-offline-database"
    }
    // Prefer the normalized MAL large image for Telegram photos.
    record.picture = formatPictureUrl(entry.picture) ?? record.picture
    record.thumbnail = entry.thumbnail ?? record.thumbnail
    record.type = record.type ?? entry.type ?? null
    record.seasonYear = record.seasonYear ?? entry.animeSeason?.year ?? null
    record.aliases.add(record.title)
    for (const synonym of entry.synonyms ?? []) record.aliases.add(synonym)
  }
}

function addBangumi(records: Map<number, BuiltMetadata>, payload: unknown, knownRelations: Map<number, number>): void {
  const entries = (payload as { items?: unknown[] }).items ?? []
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as BangumiEntry
    const direct = directAniListTarget(entry)
    const bangumi = siteId(entry, "bangumi")
    const manual = bangumi && /^\d+$/.test(bangumi) ? knownRelations.get(Number(bangumi)) ?? null : null
    // Prefer current bangumi-data links over manual relations.
    const id = direct ?? manual
    if (!id) continue
    const record = records.get(id)
    // Bangumi must not expand the minimal catalog.
    if (!record) continue
    const englishTitle = asArray(entry.titleTranslate?.en)[0]
    // Use Bangumi titles only for placeholder rows; AniList remains authoritative.
    if (englishTitle && record.titleSource === "placeholder") {
      record.title = englishTitle
      record.titleSource = "bangumi-data"
    }
    else if (record.title.startsWith("AniList (") && entry.title?.trim()) {
      record.title = entry.title
      record.titleSource = "bangumi-data"
    }
    if (entry.title?.trim()) record.aliases.add(entry.title)
    for (const values of Object.values(entry.titleTranslate ?? {})) {
      for (const value of asArray(values)) record.aliases.add(value)
    }
  }
}

function addAniList(records: Map<number, BuiltMetadata>, entries: AniListEntry[]): void {
  for (const entry of entries) {
    const id = Number(entry.id)
    if (!Number.isSafeInteger(id) || id <= 0) continue
    const record = records.get(id)
    // Ignore responses outside the current ID universe.
    if (!record) continue
    const english = entry.title?.english?.trim()
    const romaji = entry.title?.romaji?.trim()
    const native = entry.title?.native?.trim()
    const preferred = entry.title?.userPreferred?.trim()
    // Prefer AniList English, then romaji, for display titles.
    if (english) record.title = english
    else if (romaji && record.titleSource === "placeholder") record.title = romaji
    if (english || romaji || record.titleSource === "placeholder") record.titleSource = "anilist"
    record.picture = record.picture ?? formatPictureUrl(entry.coverImage?.large)
    record.thumbnail = record.thumbnail ?? entry.coverImage?.medium ?? entry.coverImage?.large ?? null
    record.type = record.type ?? entry.format ?? null
    record.seasonYear = record.seasonYear ?? entry.seasonYear ?? null
    for (const value of [english, romaji, native, preferred]) if (value) record.aliases.add(value)
    for (const synonym of asArray(entry.synonyms)) record.aliases.add(synonym)
  }
}

function addSeaDexIds(records: Map<number, BuiltMetadata>, payload: string): Set<number> {
  const ids = new Set<number>()
  for (const value of payload.split(/[\s,]+/)) {
    const id = Number(value.trim())
    if (Number.isSafeInteger(id) && id > 0) {
      ids.add(id)
      recordFor(records, id)
    }
  }
  return ids
}

function addNumericIds(records: Map<number, BuiltMetadata>, ids: Iterable<number>): Set<number> {
  const result = new Set<number>()
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0) continue
    result.add(id)
    recordFor(records, id)
  }
  return result
}

async function readOptionalSource(source: string): Promise<string> {
  try {
    return await readSource(source)
  } catch (error) {
    if (!/^https?:\/\//.test(source) && error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
}

async function writeMissingIds(source: string, ids: Iterable<number>): Promise<void> {
  const sorted = [...new Set(ids)].sort((left, right) => left - right)
  await mkdir(dirname(resolve(source)), { recursive: true })
  await writeFile(resolve(source), `${JSON.stringify({ version: 1, ids: sorted }, null, 2)}\n`, "utf8")
}

function validateCompleteness(records: BuiltMetadata[], requiredIds: Set<number>): void {
  const recordIds = new Set(records.map((record) => record.anilistId))
  const missing = [...requiredIds].filter((id) => !recordIds.has(id))
  if (missing.length) {
    throw new Error(`Metadata is missing SeaDex AniList IDs: ${missing.join(", ")}`)
  }
  const incomplete = records
    .filter((record) => record.title.startsWith("AniList ("))
    .map((record) => record.anilistId)
  if (incomplete.length) {
    throw new Error(`Metadata is incomplete for AniList IDs: ${incomplete.join(", ")}`)
  }
}

function targetReadyExpression(previous: MetadataState): string {
  return `(
    EXISTS (SELECT 1 FROM metadata_builds WHERE source_fingerprint = ${sqlString(previous.sourceFingerprint)} AND record_count = ${previous.records.length})
    AND (SELECT COUNT(*) FROM anime_metadata) = ${previous.records.length}
    AND (SELECT COUNT(*) FROM anime_metadata_fts) = ${previous.records.length}
    AND NOT EXISTS (
      SELECT 1
      FROM anime_metadata m
      LEFT JOIN anime_metadata_fts f
        ON f.rowid = m.anilist_id
       AND f.anilist_id = CAST(m.anilist_id AS TEXT)
       AND f.title = m.title
       AND f.search_text = m.search_text
      WHERE f.rowid IS NULL
    )
  )`
}

function metadataUpsert(record: BuiltMetadata, condition: string | null, timestamp: string): string {
  const aliases = JSON.stringify(sortedAliases(record))
  const searchText = buildSearchText(JSON.parse(aliases) as string[])
  const recordFingerprint = metadataRecordFingerprint(record)
  const values = [
    record.anilistId,
    sqlString(record.title),
    sqlValue(record.picture),
    sqlValue(record.thumbnail),
    sqlValue(record.type),
    sqlValue(record.seasonYear),
    sqlString(searchText),
    sqlString(aliases),
    sqlString(recordFingerprint),
    sqlString(""),
    sqlString(timestamp)
  ].join(", ")
  const source = condition ? `SELECT ${values} WHERE ${condition}` : `VALUES (${values})`
  return `INSERT INTO anime_metadata(anilist_id, title, picture_url, thumbnail_url, type, season_year, search_text, aliases, source_fingerprint, index_fingerprint, updated_at)
    ${source} ON CONFLICT(anilist_id) DO UPDATE SET
      title = excluded.title, picture_url = excluded.picture_url, thumbnail_url = excluded.thumbnail_url,
      type = excluded.type, season_year = excluded.season_year, search_text = excluded.search_text, aliases = excluded.aliases,
      source_fingerprint = excluded.source_fingerprint, index_fingerprint = excluded.index_fingerprint, updated_at = excluded.updated_at
      WHERE anime_metadata.source_fingerprint != excluded.source_fingerprint
         OR anime_metadata.index_fingerprint != excluded.index_fingerprint;`
}

function emitSql(
  changedRecords: BuiltMetadata[],
  allRecords: BuiltMetadata[],
  sourceFingerprint: string,
  rawRecordCount: number,
  totalRecordCount: number,
  staleRecordIds: number[],
  previousState: MetadataState | null,
  resetDatabase: boolean
): string {
  const timestamp = new Date().toISOString()
  const lines = [
    "-- Generated by scripts/build-metadata.ts. Do not edit."
  ]
  if (resetDatabase) {
    lines.push("DELETE FROM anime_metadata_fts;", "DELETE FROM anime_metadata;")
  }
  const ready = !resetDatabase && previousState ? targetReadyExpression(previousState) : null
  if (ready && previousState) {
    // Rebuild when the persisted state does not describe a ready D1 target.
    lines.push(
      `DELETE FROM anime_metadata_fts WHERE NOT (${ready});`,
      `DELETE FROM anime_metadata WHERE NOT (${ready});`,
      `DELETE FROM metadata_builds WHERE source_fingerprint = ${sqlString(previousState.sourceFingerprint)} AND NOT (${ready});`
    )
  }
  if (!resetDatabase) {
    for (const id of staleRecordIds) {
      lines.push(
        `DELETE FROM anime_metadata_fts WHERE rowid = ${id};`,
        `DELETE FROM anime_metadata WHERE anilist_id = ${id};`
      )
    }
  }
  const changedIds = new Set(changedRecords.map((record) => record.anilistId))
  const fullImportCondition = !resetDatabase && previousState
    ? `NOT EXISTS (SELECT 1 FROM metadata_builds WHERE source_fingerprint = ${sqlString(previousState.sourceFingerprint)} AND record_count = ${previousState.records.length})`
    : null
  for (const record of allRecords) {
    const condition = fullImportCondition && !changedIds.has(record.anilistId) ? fullImportCondition : null
    lines.push(metadataUpsert(record, condition, timestamp))
  }
  lines.push(
    "DELETE FROM anime_metadata_fts WHERE rowid IN (SELECT anilist_id FROM anime_metadata WHERE index_fingerprint = '');",
    "INSERT INTO anime_metadata_fts(rowid, anilist_id, title, search_text) SELECT anilist_id, anilist_id, title, search_text FROM anime_metadata WHERE index_fingerprint = '';",
    "UPDATE anime_metadata SET index_fingerprint = source_fingerprint WHERE index_fingerprint = '';",
    `INSERT OR IGNORE INTO metadata_builds(source_fingerprint, built_at, record_count) VALUES (${sqlString(sourceFingerprint)}, ${sqlString(timestamp)}, ${totalRecordCount});`,
    `INSERT INTO metadata_stats(id, raw_record_count, updated_at) VALUES (1, ${rawRecordCount}, ${sqlString(timestamp)}) ON CONFLICT(id) DO UPDATE SET raw_record_count=excluded.raw_record_count, updated_at=excluded.updated_at;`,
    "UPDATE stats SET metadata_count = (SELECT raw_record_count FROM metadata_stats WHERE id = 1) WHERE id = 1;",
  )
  return `${lines.join("\n")}\n`
}

async function main(): Promise<void> {
  const animeOfflineDatabaseSource = argumentAny(
    ["--anime-offline-database", "--anime-db"],
    process.env.ANIME_OFFLINE_DATABASE_URL ?? process.env.ANIME_DB_URL ?? DEFAULTS.animeDb
  )
  const bangumiDataSource = argumentAny(
    ["--bangumi-data", "--bangumi-db"],
    process.env.BANGUMI_DATA_URL ?? process.env.BANGUMI_DB_URL ?? DEFAULTS.bangumiDb
  )
  const seadexIdsSource = argument("--seadex-ids", process.env.SEADEX_IDS_URL ?? DEFAULTS.seadexIds)
  const missingIdsSource = argument("--missing-anilist-ids", process.env.MISSING_ANILIST_IDS ?? "data/missing_anilist_ids.json")
  const missingIdsOutput = argument("--missing-anilist-ids-out", process.env.MISSING_ANILIST_IDS_OUT ?? missingIdsSource)
  const knownRelationsSource = argument("--known-relations", process.env.KNOWN_RELATIONS ?? "data/known_relations.json")
  const anilistSource = argument("--anilist", process.env.ANILIST_SOURCE ?? "")
  const anilistApi = argument("--anilist-api", process.env.ANILIST_API_URL ?? DEFAULTS.anilistApi)
  const anilistMode = argument("--anilist-mode", process.env.ANILIST_MODE ?? "known")
  const anilistIdsArgument = argument("--anilist-ids", process.env.ANILIST_IDS ?? "")
  const stateSource = argument("--state", process.env.METADATA_STATE ?? "")
  const output = argument("--out", "artifacts/metadata.sql")
  const force = process.argv.includes("--force")
  const previousState = stateSource ? await readState(stateSource) : null

  const [animeRaw, bangumiRaw, seadexIds, missingIdsRaw, knownRelationsRaw] = await Promise.all([
    readSource(animeOfflineDatabaseSource),
    readSource(bangumiDataSource),
    readSource(seadexIdsSource),
    readOptionalSource(missingIdsSource),
    readOptionalSource(knownRelationsSource)
  ])
  const animePayload = JSON.parse(animeRaw)
  const records = new Map<number, BuiltMetadata>()
  addAnimeDb(records, animePayload)
  const animeIds = new Set(records.keys())
  const configuredMissingIds = parseNumericIds(missingIdsRaw ? JSON.parse(missingIdsRaw) : [])
  const seadexIdSet = addSeaDexIds(records, seadexIds)
  const upstreamMissingIds = [...seadexIdSet].filter((id) => !animeIds.has(id))
  // Keep only current SeaDex IDs missing from anime-offline-database.
  const effectiveMissingIds = [...new Set([
    ...configuredMissingIds.filter((id) => seadexIdSet.has(id)),
    ...upstreamMissingIds
  ])]
    .filter((id) => !animeIds.has(id))
    .sort((left, right) => left - right)
  addNumericIds(records, effectiveMissingIds)
  const knownRelations = parseKnownRelations(knownRelationsRaw ? JSON.parse(knownRelationsRaw) : {})
  // Seed SeaDex IDs before Bangumi enrichment.
  addBangumi(records, JSON.parse(bangumiRaw), knownRelations)
  await writeMissingIds(missingIdsOutput, effectiveMissingIds)

  const knownIds = [...records.keys()]
  // Enrich SeaDex IDs; catalog-only records do not consume AniList quota.
  const enrichmentIds = anilistIdsArgument
    ? parseIdList(anilistIdsArgument)
    : [...seadexIdSet]
  let anilistEntries: AniListEntry[] = []
  let anilistRaw = ""
  if (anilistSource) {
    if (/^https?:\/\//.test(anilistSource)) {
      anilistEntries = await fetchAniListEntries(anilistSource, enrichmentIds)
    } else {
      anilistEntries = parseAniListEntries(JSON.parse(await readSource(anilistSource)))
    }
  } else {
    const cached = previousState?.anilist ?? []
    const cachedIds = new Set(cached.map((entry) => entry.id))
    const idsToFetch = anilistMode.toLowerCase() === "incremental"
      ? enrichmentIds.filter((id) => !cachedIds.has(id))
      : enrichmentIds
    const fetched = await fetchAniListEntries(anilistApi, idsToFetch)
    const requested = new Set(enrichmentIds)
    const cachedRelevant = cached.filter((entry) => requested.has(entry.id))
    anilistEntries = mergeAniListEntries(cachedRelevant, fetched)
    anilistRaw = JSON.stringify(anilistEntries)
  }
  const allowedIds = new Set(knownIds)
  const allowedEnrichmentIds = new Set(enrichmentIds)
  anilistEntries = mergeAniListEntries(anilistEntries)
    .filter((entry) => allowedIds.has(Number(entry.id)) && allowedEnrichmentIds.has(Number(entry.id)))
  addAniList(records, anilistEntries)

  const sortedRecords = [...records.values()].sort((left, right) => left.anilistId - right.anilistId)
  validateCompleteness(sortedRecords, seadexIdSet)
  anilistRaw = JSON.stringify(anilistEntries)
  const sourceFingerprint = fingerprint([
    animeRaw,
    bangumiRaw,
    seadexIds,
    JSON.stringify(effectiveMissingIds),
    JSON.stringify([...knownRelations.entries()].sort((left, right) => left[0] - right[0])),
    anilistRaw
  ])
  const changed = force ? sortedRecords : changedRecords(sortedRecords, previousState)
  const currentIds = new Set(sortedRecords.map((record) => record.anilistId))
  const staleRecordIds = previousState
    ? previousState.records.map((record) => record.anilistId).filter((id) => !currentIds.has(id))
    : []
  const resetDatabase = force || !previousState || previousState.records.length === 0
  // Report searchable records after AniList-ID deduplication.
  const sql = emitSql(
    changed,
    sortedRecords,
    sourceFingerprint,
    sortedRecords.length,
    sortedRecords.length,
    staleRecordIds,
    previousState,
    resetDatabase
  )
  await mkdir(dirname(resolve(output)), { recursive: true })
  await writeFile(resolve(output), sql, "utf8")
  if (stateSource) {
    await writeState(stateSource, {
      version: 1,
      anilist: anilistEntries,
      records: sortedRecords.map(stateRecord),
      sourceFingerprint,
      updatedAt: new Date().toISOString()
    })
  }
  process.stdout.write(`Built ${sortedRecords.length} metadata records (${changed.length} changed) with ${anilistEntries.length} AniList records: ${output}\n`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
