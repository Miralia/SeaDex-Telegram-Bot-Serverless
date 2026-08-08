import { metadataMatchRank, normalizeText, toFtsQuery } from "./search"
import type { AnimeMetadata, BotStats, SeaDexEntry, SeaDexTorrent } from "./types"

type MetadataRow = {
  anilist_id: number
  title: string
  picture_url: string | null
  thumbnail_url: string | null
  type: string | null
  season_year: number | null
  aliases?: string | null
  fts_rank?: number
}

function asMetadata(row: MetadataRow): AnimeMetadata {
  return {
    anilistId: row.anilist_id,
    title: row.title,
    picture: row.picture_url,
    thumbnail: row.thumbnail_url,
    type: row.type,
    seasonYear: row.season_year
  }
}

export async function getMetadata(db: D1Database, anilistId: number): Promise<AnimeMetadata | null> {
  const row = await db.prepare(
    "SELECT anilist_id, title, picture_url, thumbnail_url, type, season_year FROM anime_metadata WHERE anilist_id = ?"
  ).bind(anilistId).first<MetadataRow>()
  return row ? asMetadata(row) : null
}

export async function searchMetadata(db: D1Database, query: string, limit = 10): Promise<AnimeMetadata[]> {
  const ftsQuery = toFtsQuery(query)
  if (!ftsQuery) return []
  const candidateLimit = Math.min(Math.max(limit, 1) * 5, 100)
  const { results } = await db.prepare(
    `SELECT m.anilist_id, m.title, m.picture_url, m.thumbnail_url, m.type, m.season_year, m.aliases,
            bm25(anime_metadata_fts) AS fts_rank
     FROM anime_metadata_fts f
     JOIN anime_metadata m ON m.anilist_id = CAST(f.anilist_id AS INTEGER)
     WHERE anime_metadata_fts MATCH ?
     ORDER BY fts_rank, m.anilist_id
     LIMIT ?`
  ).bind(ftsQuery, candidateLimit).all<MetadataRow>()
  const normalizedQuery = normalizeText(query)
  const ranked = results.map((row, index) => {
    let aliases: string[] = []
    try {
      const parsed = row.aliases ? JSON.parse(row.aliases) : []
      if (Array.isArray(parsed)) aliases = parsed.filter((value): value is string => typeof value === "string")
    } catch {
      aliases = []
    }
    return {
      row,
      rank: metadataMatchRank(normalizedQuery, row.title, aliases, row.type),
      ftsRank: Number(row.fts_rank ?? 0),
      index
    }
  })
  ranked.sort((left, right) => {
    for (let index = 0; index < left.rank.length; index += 1) {
      if (left.rank[index] !== right.rank[index]) return left.rank[index] - right.rank[index]
    }
    return left.row.anilist_id - right.row.anilist_id || left.ftsRank - right.ftsRank || left.index - right.index
  })
  return ranked.slice(0, Math.min(Math.max(limit, 1), 20)).map(({ row }) => asMetadata(row))
}

export async function findEntryByAniList(db: D1Database, anilistId: number): Promise<SeaDexEntry | null> {
  const row = await db.prepare(
    "SELECT id, alid, incomplete, notes, comparison, trs, theoretical_best, created, updated FROM entries WHERE alid = ?"
  ).bind(anilistId).first<Record<string, unknown>>()
  return row ? parseEntry(row) : null
}

export async function findEntryById(db: D1Database, id: string): Promise<SeaDexEntry | null> {
  const row = await db.prepare(
    "SELECT id, alid, incomplete, notes, comparison, trs, theoretical_best, created, updated FROM entries WHERE id = ?"
  ).bind(id).first<Record<string, unknown>>()
  return row ? parseEntry(row) : null
}

export async function findEntriesByIds(db: D1Database, ids: string[]): Promise<Map<string, SeaDexEntry>> {
  const entries = new Map<string, SeaDexEntry>()
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  for (let offset = 0; offset < uniqueIds.length; offset += 100) {
    const chunk = uniqueIds.slice(offset, offset + 100)
    const placeholders = chunk.map(() => "?").join(", ")
    const { results } = await db.prepare(
      `SELECT id, alid, incomplete, notes, comparison, trs, theoretical_best, created, updated
       FROM entries WHERE id IN (${placeholders})`
    ).bind(...chunk).all<Record<string, unknown>>()
    for (const row of results) {
      const entry = parseEntry(row)
      entries.set(entry.id, entry)
    }
  }
  return entries
}

export async function findEntriesByTorrentIds(db: D1Database, torrentIds: string[]): Promise<SeaDexEntry[]> {
  if (!torrentIds.length) return []
  const byId = new Map<string, SeaDexEntry>()
  for (let offset = 0; offset < torrentIds.length; offset += 100) {
    const chunk = torrentIds.slice(offset, offset + 100)
    const placeholders = chunk.map(() => "?").join(", ")
    const { results } = await db.prepare(
      `SELECT DISTINCT e.id, e.alid, e.incomplete, e.notes, e.comparison, e.trs, e.theoretical_best, e.created, e.updated
       FROM entry_torrents et JOIN entries e ON e.id = et.entry_id
       WHERE et.torrent_id IN (${placeholders})`
    ).bind(...chunk).all<Record<string, unknown>>()
    for (const row of results) {
      const entry = parseEntry(row)
      byId.set(entry.id, entry)
    }
  }
  return [...byId.values()]
}

export async function getRandomEntry(db: D1Database): Promise<SeaDexEntry | null> {
  const row = await db.prepare(
    "SELECT id, alid, incomplete, notes, comparison, trs, theoretical_best, created, updated FROM entries WHERE incomplete = 0 AND alid IS NOT NULL ORDER BY RANDOM() LIMIT 1"
  ).first<Record<string, unknown>>()
  return row ? parseEntry(row) : null
}

export async function getStats(db: D1Database): Promise<BotStats> {
  const [row, metadataStats] = await Promise.all([
    db.prepare(
      `SELECT entry_count, torrent_count, nyaa_torrent_count, pt_torrent_count,
              best_entry_count, alt_entry_count, incomplete_count, completion_rate,
              metadata_count, updated_at
         FROM stats WHERE id = 1`
    ).first<Record<string, unknown>>(),
    db.prepare("SELECT raw_record_count FROM metadata_stats WHERE id = 1")
      .first<{ raw_record_count: number }>()
  ])
  // Keep the raw upstream count; anime_metadata is deduplicated.
  const cachedMetadata = Number(row?.metadata_count ?? 0)
  const metadata = cachedMetadata || Number(metadataStats?.raw_record_count ?? 0)
  return {
    entries: Number(row?.entry_count ?? 0),
    torrents: Number(row?.torrent_count ?? 0),
    nyaa: Number(row?.nyaa_torrent_count ?? 0),
    pt: Number(row?.pt_torrent_count ?? 0),
    best: Number(row?.best_entry_count ?? 0),
    alt: Number(row?.alt_entry_count ?? 0),
    incomplete: Number(row?.incomplete_count ?? 0),
    metadata,
    completion: Number(row?.completion_rate ?? 0),
    updated: row?.updated_at ? String(row.updated_at) : null
  }
}

export async function getTorrents(db: D1Database, torrentIds: string[]): Promise<SeaDexTorrent[]> {
  if (!torrentIds.length) return []
  const byId = new Map<string, SeaDexTorrent>()
  for (let offset = 0; offset < torrentIds.length; offset += 100) {
    const chunk = torrentIds.slice(offset, offset + 100)
    const placeholders = chunk.map(() => "?").join(", ")
    const { results } = await db.prepare(
      `SELECT id, url, info_hash, release_group, tracker, is_best, dual_audio, grouped_url, tags, files, created, updated
       FROM torrents WHERE id IN (${placeholders})`
    ).bind(...chunk).all<Record<string, unknown>>()
    for (const row of results) {
      const torrent = parseTorrent(row)
      byId.set(torrent.id, torrent)
    }
  }
  return torrentIds.flatMap((id) => {
    const torrent = byId.get(id)
    return torrent ? [torrent] : []
  })
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== "string") return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseEntry(row: Record<string, unknown>): SeaDexEntry {
  return {
    id: String(row.id),
    alid: typeof row.alid === "number" ? row.alid : null,
    incomplete: Boolean(row.incomplete),
    notes: typeof row.notes === "string" ? row.notes : null,
    comparison: typeof row.comparison === "string" ? row.comparison : null,
    trs: parseJsonArray(row.trs).filter((item): item is string => typeof item === "string"),
    theoreticalBest: typeof row.theoretical_best === "string" ? row.theoretical_best : null,
    created: typeof row.created === "string" ? row.created : null,
    updated: String(row.updated)
  }
}

function parseTorrent(row: Record<string, unknown>): SeaDexTorrent {
  return {
    id: String(row.id),
    url: typeof row.url === "string" ? row.url : null,
    infoHash: typeof row.info_hash === "string" ? row.info_hash : null,
    releaseGroup: typeof row.release_group === "string" ? row.release_group : null,
    tracker: typeof row.tracker === "string" ? row.tracker : null,
    isBest: Boolean(row.is_best),
    dualAudio: Boolean(row.dual_audio),
    groupedUrl: typeof row.grouped_url === "string" ? row.grouped_url : null,
    tags: parseJsonArray(row.tags).filter((item): item is string => typeof item === "string"),
    files: parseJsonArray(row.files),
    created: typeof row.created === "string" ? row.created : null,
    updated: String(row.updated)
  }
}
