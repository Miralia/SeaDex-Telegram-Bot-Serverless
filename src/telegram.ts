import { findEntryByAniList, findEntryById, getMetadata, getRandomEntry, getStats, getTorrents, searchMetadata } from "./repository"
import { buildUpdateNotification } from "./notifications"
import eastAsianWidth from "eastasianwidth"
import type { AnimeMetadata, Env, SeaDexEntry, SeaDexTorrent, TelegramUpdate } from "./types"

const TELEGRAM_API = "https://api.telegram.org"
const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000
const TELEGRAM_MAX_ATTEMPTS = 3
const TELEGRAM_TEXT_LIMIT = 4096
const TELEGRAM_CAPTION_LIMIT = 1024

type TelegramButton = { text: string; url: string }

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfter?: number
  ) {
    super(`Telegram ${method} failed: ${description}`)
    this.name = "TelegramApiError"
  }

  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500 || this.status === 0
  }

  get permanent(): boolean {
    return !this.retryable
  }
}

export function escapeMarkdown(value: string): string {
  return value.replace(/[\\_*\[\]()~`>#+\-=|{}.!]/g, (char) => `\\${char}`)
}

function escapeCode(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`")
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function retryDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined && Number.isFinite(retryAfter)) return Math.min(Math.max(retryAfter, 1) * 1000, 30_000)
  return Math.min(1_000 * 2 ** attempt, 8_000)
}

/** Strip MarkdownV2 markers for plain-text fallbacks. */
export function stripMarkdownV2(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\\([\\_*\[\]()~`>#+\-=|{}.!])/g, "$1")
    .replace(/```(?:diff)?\n?/g, "")
    .replace(/[\*_~`]/g, "")
}

function limitText(value: string, limit: number): string {
  const characters = Array.from(value)
  if (characters.length <= limit) return value
  return `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`
}

function plainBody(body: Record<string, unknown>): Record<string, unknown> {
  const fallback = { ...body }
  delete fallback.parse_mode
  if (typeof fallback.text === "string") fallback.text = limitText(stripMarkdownV2(fallback.text), TELEGRAM_TEXT_LIMIT)
  if (typeof fallback.caption === "string") fallback.caption = limitText(stripMarkdownV2(fallback.caption), TELEGRAM_CAPTION_LIMIT)
  return fallback
}

function formattedTextBody(text: string): { text: string; parse_mode?: "MarkdownV2" } {
  const tooLong = Array.from(text).length > TELEGRAM_TEXT_LIMIT
  return tooLong
    ? { text: limitText(stripMarkdownV2(text), TELEGRAM_TEXT_LIMIT) }
    : { text, parse_mode: "MarkdownV2" }
}

export function formatPictureUrl(url: string | null): string | null {
  if (!url || !url.includes("cdn.myanimelist.net")) return url
  if (url.endsWith("t.jpg")) return `${url.slice(0, -5)}l.jpg`
  if (url.endsWith("l.jpg")) return url
  if (url.endsWith(".jpg")) return `${url.slice(0, -4)}l.jpg`
  return url
}

function formatReleaseDetails(torrent: SeaDexTorrent): string {
  const parts: string[] = []
  if (torrent.dualAudio) parts.push("Dual Audio")
  const official = ["Broken", "Deband Recommended", "Deband Required", "Dolby Vision", "HDR", "Incomplete", "Misplaced Special", "Patch Required", "VFR", "YUV444P"]
  const tags = new Set(torrent.tags.map((tag) => tag.trim()).filter(Boolean))
  parts.push(...official.filter((tag) => [...tags].some((value) => value.toLowerCase() === tag.toLowerCase())))
  parts.push(...[...tags].filter((tag) => !official.some((known) => known.toLowerCase() === tag.toLowerCase())).sort())
  return parts.length ? ` (${parts.join(" / ")})` : ""
}

function ptUrl(url: string): string {
  const id = url.match(/[?&]id=(\d+)/)?.[1]
  const torrentId = url.match(/[?&]torrentid=(\d+)/)?.[1]
  return id && torrentId ? `https://ab.pt/torrents.php?id=${id}&torrentid=${torrentId}` : url
}

function formatStatsUpdated(value: string | null): string {
  if (!value) return "Never"
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) return value
  return `${timestamp.toISOString().slice(0, 19).replace("T", " ")} UTC`
}

// Match the original /stats filter, including bot suffixes and ignored arguments.
export function isStatsCommand(text: string): boolean {
  return /^\/stats(?:@\w+)?(?:\s|$)/.test(text)
}

function markdownLink(label: string, url: string): string {
  return `[${escapeMarkdown(label)}](${url.replaceAll("\\", "\\\\").replaceAll(")", "\\)")})`
}

function torrentUrl(torrent: SeaDexTorrent): { kind: "Nyaa" | "PT"; url: string } | null {
  if (!torrent.url) return null
  if (torrent.groupedUrl) return { kind: "Nyaa", url: torrent.groupedUrl }
  return torrent.tracker === "Nyaa" ? { kind: "Nyaa", url: torrent.url } : { kind: "PT", url: ptUrl(torrent.url) }
}

async function telegramOnce(env: Env, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    throw new TelegramApiError(method, 0, error instanceof Error ? error.message : String(error))
  }
  const payload = await response.json<{ ok: boolean; description?: string; parameters?: { retry_after?: number } }>()
    .catch(() => ({ ok: false, description: "invalid Telegram response", parameters: undefined }))
  if (!response.ok || !payload.ok) {
    const error = new TelegramApiError(
      method,
      response.status,
      payload.description ?? `HTTP ${response.status}`,
      payload.parameters?.retry_after
    )
    console.error(`Telegram ${method} failed`, { status: error.status, description: error.description })
    throw error
  }
  return payload as Record<string, unknown>
}

async function telegram(env: Env, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let requestBody = body
  let usedPlainFallback = false
  for (let attempt = 0; attempt < TELEGRAM_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await telegramOnce(env, method, requestBody)
    } catch (error) {
      const apiError = error instanceof TelegramApiError
        ? error
        : new TelegramApiError(method, 0, error instanceof Error ? error.message : String(error))

      if (!usedPlainFallback && apiError.status === 400 && /can't parse entities|can't find end of the entity/i.test(apiError.description) && body.parse_mode === "MarkdownV2" && (method === "sendMessage" || method === "sendPhoto")) {
        requestBody = plainBody(body)
        usedPlainFallback = true
        attempt -= 1
        console.warn(`Telegram ${method}: retrying with plain text fallback`)
        continue
      }
      if (!apiError.retryable || attempt === TELEGRAM_MAX_ATTEMPTS - 1) throw apiError
      await sleep(retryDelay(attempt, apiError.retryAfter))
    }
  }
  throw new TelegramApiError(method, 0, "request attempts exhausted")
}

interface TelegramSentMessage {
  inline_message_id?: string
  message_id?: number
}

async function answerGuestQuery(
  env: Env,
  guestQueryId: string,
  result: Record<string, unknown>
): Promise<TelegramSentMessage> {
  const response = await telegram(env, "answerGuestQuery", {
    guest_query_id: guestQueryId,
    result
  })
  const sent = response.result
  return sent && typeof sent === "object" ? sent as TelegramSentMessage : {}
}

async function sendText(env: Env, chatId: string | number, text: string, replyTo?: number): Promise<void> {
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text: limitText(text, TELEGRAM_TEXT_LIMIT),
    reply_parameters: replyTo ? { message_id: replyTo } : undefined
  })
}

async function sendMarkdown(env: Env, chatId: string | number, text: string, replyMarkup?: unknown, replyTo?: number): Promise<void> {
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    ...formattedTextBody(text),
    reply_markup: replyMarkup,
    reply_parameters: replyTo ? { message_id: replyTo } : undefined
  })
}

export function releaseLines(torrents: SeaDexTorrent[], entry: SeaDexEntry): string[] {
  const groups = (best: boolean) => [...new Set(
    torrents.filter((torrent) => torrent.isBest === best).map((torrent) => torrent.releaseGroup ?? "Unknown")
  )]
  const lines: string[] = []
  const best = groups(true)
  const alt = groups(false)
  if (entry.theoreticalBest || best.length) {
    lines.push("_Best_")
    if (entry.theoreticalBest) lines.push(`*${escapeMarkdown(entry.theoreticalBest)}* \\(Unmuxed\\)`)
    lines.push(...best.map((group) => `*${escapeMarkdown(group)}*${escapeMarkdown(formatReleaseDetails(torrents.find((torrent) => torrent.isBest && (torrent.releaseGroup ?? "Unknown") === group)!))}`))
    lines.push("")
  }
  if (alt.length) {
    lines.push("_Alt_", ...alt.map((group) => `*${escapeMarkdown(group)}*${escapeMarkdown(formatReleaseDetails(torrents.find((torrent) => !torrent.isBest && (torrent.releaseGroup ?? "Unknown") === group)!))}`))
    lines.push("")
  }
  if (entry.notes) {
    lines.push("_Notes_", ...entry.notes.slice(0, 500).split("\n").filter((line) => line.trim()).map((line) => `>${escapeMarkdown(line)}`))
    lines.push("")
  }
  if (entry.comparison) {
    // Add a second separator so Comparisons stays distinct from blockquotes.
    if (lines.at(-1) === "") lines.push("")
    lines.push("_Comparisons_")
    lines.push(...entry.comparison.split(/[,\r\n]+/).map((value) => value.trim()).filter(Boolean).map((url) => markdownLink(url, url)))
    lines.push("")
  }
  return lines
}

export function buttons(metadata: AnimeMetadata, torrents: SeaDexTorrent[]): TelegramButton[][] {
  const rows: TelegramButton[][] = [[{
    text: "AniList",
    url: `https://anilist.co/anime/${metadata.anilistId}`
  }, { text: "Seadex", url: `https://releases.moe/${metadata.anilistId}` }]]
  const groupedSeen = new Set<string>()
  const deduplicated: SeaDexTorrent[] = []
  for (const torrent of torrents) {
    if (!torrent.groupedUrl) {
      deduplicated.push(torrent)
      continue
    }
    // Match the original tuple key before applying the "Unknown" fallback.
    const key = JSON.stringify([torrent.groupedUrl, torrent.tracker, torrent.releaseGroup])
    if (groupedSeen.has(key)) continue
    groupedSeen.add(key)
    deduplicated.push({ ...torrent, url: torrent.groupedUrl })
  }
  const limited = deduplicated.slice(0, 12)
  const best = limited.filter((torrent) => torrent.isBest)
  const alt = limited.filter((torrent) => !torrent.isBest)
  for (const bucket of [best, alt]) {
    const groups = new Set(bucket.map((torrent) => torrent.releaseGroup || "Unknown"))
    const needGroup = groups.size > 1
    const groupButtons = new Map<string, TelegramButton[]>()
    for (const torrent of bucket) {
      const target = torrentUrl(torrent)
      if (!target) continue
      const label = `${torrent.isBest ? "Best" : "Alt"}(${target.kind}${needGroup ? ` / ${torrent.releaseGroup || "Unknown"}` : ""})`
      const group = torrent.releaseGroup || "Unknown"
      const values = groupButtons.get(group) ?? []
      values.push({ text: label, url: torrent.groupedUrl || target.url })
      groupButtons.set(group, values)
    }
    const compareStrings = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
    const flattened = [...groupButtons.keys()].sort(compareStrings).flatMap((group) => (groupButtons.get(group) ?? []).sort((left, right) => {
      const leftNyaa = left.text.includes("(Nyaa") ? 0 : 1
      const rightNyaa = right.text.includes("(Nyaa") ? 0 : 1
      return leftNyaa - rightNyaa || compareStrings(left.text, right.text)
    }))
    let start = 0
    const width = (value: string): number => [...value].reduce((total, char) => {
      // Match Python's combining-mark and East Asian width rules.
      if (/\p{Mn}|\p{Me}/u.test(char)) return total
      return total + (["W", "F"].includes(eastAsianWidth.eastAsianWidth(char)) ? 2 : 1)
    }, 0)
    // Match the original 3/2/1-column width limits.
    const limits = [Number.POSITIVE_INFINITY, 32, 20]
    while (start < flattened.length) {
      const max = Math.min(3, flattened.length - start)
      let columns = 1
      for (let candidate = max; candidate >= 1; candidate -= 1) {
        const labels = flattened.slice(start, start + candidate).map((button) => width(button.text))
        if (Math.max(...labels) <= limits[candidate - 1]) {
          columns = candidate
          break
        }
      }
      rows.push(flattened.slice(start, start + columns))
      start += columns
    }
  }
  return rows
}

function isPhotoFallbackError(error: unknown): boolean {
  return error instanceof TelegramApiError && error.status === 400
}

async function sendRichMessage(
  env: Env,
  chatId: string | number,
  metadata: AnimeMetadata,
  text: string,
  replyMarkup: unknown,
  replyTo?: number
): Promise<void> {
  const caption = limitText(text, TELEGRAM_CAPTION_LIMIT)
  const picture = formatPictureUrl(metadata.picture)
  if (picture && Array.from(text).length <= TELEGRAM_CAPTION_LIMIT) {
    try {
      await telegram(env, "sendPhoto", {
        chat_id: chatId,
        photo: picture,
        caption,
        parse_mode: "MarkdownV2",
        reply_markup: replyMarkup,
        reply_parameters: replyTo ? { message_id: replyTo } : undefined
      })
      return
    } catch (error) {
      // Fall back only for Telegram's invalid-photo response.
      if (!isPhotoFallbackError(error)) throw error
    }
  }
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    ...formattedTextBody(text),
    reply_markup: replyMarkup,
    reply_parameters: replyTo ? { message_id: replyTo } : undefined
  })
}

async function sendAnime(env: Env, chatId: string | number, metadata: AnimeMetadata, replyTo?: number): Promise<void> {
  const entry = await findEntryByAniList(env.DB, metadata.anilistId)
  if (!entry) {
    await sendMarkdown(env, chatId, `*${escapeMarkdown(metadata.title)}*\n\n${escapeMarkdown("This anime exists in AniList but not in SeaDex yet.")}`, undefined, replyTo)
    return
  }
  const torrents = await getTorrents(env.DB, entry.trs)
  const caption = [`*${escapeMarkdown(metadata.title)}*`, "", ...releaseLines(torrents, entry)].join("\n")
  const replyMarkup = { inline_keyboard: buttons(metadata, torrents) }
  await sendRichMessage(env, chatId, metadata, caption, replyMarkup, replyTo)
}

async function handleSearch(env: Env, chatId: string | number, query: string, replyTo?: number): Promise<void> {
  const results = await searchMetadata(env.DB, query)
  if (!results.length) {
    await sendText(env, chatId, `No results found for: ${query}`, replyTo)
    return
  }
  await sendAnime(env, chatId, results[0], replyTo)
}

async function answerInline(env: Env, queryId: string, query: string): Promise<void> {
  if (!query) {
    await telegram(env, "answerInlineQuery", {
      inline_query_id: queryId, cache_time: 300,
      results: [{
        type: "article", id: "random", title: "Random", description: "Click to get random anime",
        input_message_content: { message_text: `*Random*\n\n${escapeMarkdown("Fetching random entry.")}`, parse_mode: "MarkdownV2" },
        reply_markup: { inline_keyboard: [[{ text: "Random", callback_data: "random" }]] }
      }]
    })
    return
  }
  const direct = /^\d+$/.test(query) ? await getMetadata(env.DB, Number(query)) : null
  const results = await searchMetadata(env.DB, query)
  const deduped = results.filter((metadata) => !direct || metadata.anilistId !== direct.anilistId)
  const inlineResults = direct ? [direct, ...deduped] : deduped
  await telegram(env, "answerInlineQuery", {
    inline_query_id: queryId,
    cache_time: 300,
    results: inlineResults.map((metadata, index) => ({
      type: "article",
      id: direct && index === 0 ? `show_${metadata.anilistId}` : String(metadata.anilistId),
      title: metadata.title,
      description: direct && index === 0 ? `ID: ${metadata.anilistId}` : `Type: ${metadata.type ?? "Unknown"} | Season: ${metadata.seasonYear ?? "N/A"}`,
      thumbnail_url: metadata.thumbnail ?? metadata.picture ?? undefined,
      input_message_content: {
        message_text: `*${escapeMarkdown(metadata.title)}*\n\n${escapeMarkdown("Loading...")}`,
        parse_mode: "MarkdownV2"
      },
      reply_markup: { inline_keyboard: [[{ text: "Loading...", callback_data: "loading" }]] }
    }))
  })
}

async function answerCallback(env: Env, callbackId: string): Promise<void> {
  await telegram(env, "answerCallbackQuery", { callback_query_id: callbackId })
}

function searchCaption(metadata: AnimeMetadata, torrents: SeaDexTorrent[], entry: SeaDexEntry): string {
  return [`*${escapeMarkdown(metadata.title)}*`, "", ...releaseLines(torrents, entry)].join("\n")
}

export function updateCaptionLegacy(metadata: AnimeMetadata, oldEntry: SeaDexEntry | null, entry: SeaDexEntry, torrents: SeaDexTorrent[]): string | null {
  const lines = ["🆕 *New Update* 🆕", "", `*${escapeMarkdown(metadata.title)}*`, ""]
  const oldTids = new Set(oldEntry?.trs ?? [])
  const newTids = new Set(entry.trs)
  const oldTorrents = oldEntry ? torrents.filter((torrent) => oldTids.has(torrent.id)) : []
  const newTorrents = torrents.filter((torrent) => newTids.has(torrent.id))
  const oldGroups = new Set(oldTorrents.filter((torrent) => torrent.isBest).map((torrent) => torrent.releaseGroup || "Unknown"))
  const newGroups = new Set(newTorrents.filter((torrent) => torrent.isBest).map((torrent) => torrent.releaseGroup || "Unknown"))
  const bestDiff = [...oldGroups].filter((group) => !newGroups.has(group)).map((group) => `- ${escapeCode(group)}`).concat([...newGroups].filter((group) => !oldGroups.has(group)).map((group) => `+ ${escapeCode(group)}`))
  if (bestDiff.length) lines.push("_New Best_", "```diff", ...bestDiff, "```", "")
  const oldAlt = new Set(oldTorrents.filter((torrent) => !torrent.isBest).map((torrent) => torrent.releaseGroup || "Unknown"))
  const newAlt = new Set(newTorrents.filter((torrent) => !torrent.isBest).map((torrent) => torrent.releaseGroup || "Unknown"))
  const altDiff = [...oldAlt].filter((group) => !newAlt.has(group)).map((group) => `- ${escapeCode(group)}`).concat([...newAlt].filter((group) => !oldAlt.has(group)).map((group) => `+ ${escapeCode(group)}`))
  if (altDiff.length) lines.push("_New Alt_", "```diff", ...altDiff, "```", "")
  if ((oldEntry?.notes ?? "") !== (entry.notes ?? "")) {
    lines.push("_Notes_", "```diff")
    if (oldEntry?.notes) lines.push(`- ${escapeCode(oldEntry.notes)}`)
    if (entry.notes) lines.push(`+ ${escapeCode(entry.notes)}`)
    lines.push("```", "")
  }
  if ((oldEntry?.comparison ?? "") !== (entry.comparison ?? "") && entry.comparison) {
    if (lines.at(-1) === "") lines.push("")
    lines.push("_Comparisons_", ...entry.comparison.split(",").map((value) => value.trim()).filter(Boolean), "")
  }
  return lines.length > 4 ? lines.join("\n") : null
}

export function updateCaption(metadata: AnimeMetadata, oldEntry: SeaDexEntry | null, entry: SeaDexEntry, torrents: SeaDexTorrent[]): string | null {
  const oldIds = new Set(oldEntry?.trs ?? [])
  const currentIds = new Set(entry.trs)
  return buildUpdateNotification(metadata, {
    isNew: !oldEntry,
    current: entry,
    fieldChanges: {
      trs: { old: oldEntry?.trs ?? [], new: entry.trs, added: entry.trs.filter((id) => !oldIds.has(id)), removed: (oldEntry?.trs ?? []).filter((id) => !currentIds.has(id)) },
      notes: { old: oldEntry?.notes ?? "", new: entry.notes ?? "" },
      comparison: { old: oldEntry?.comparison ?? "", new: entry.comparison ?? "" },
      theoretical_best: { old: oldEntry?.theoreticalBest ?? "", new: entry.theoreticalBest ?? "" }
    },
    torrentFieldChanges: {},
    previousTorrents: torrents.filter((torrent) => oldIds.has(torrent.id)),
    currentTorrents: torrents.filter((torrent) => currentIds.has(torrent.id))
  })?.caption ?? null
}

export async function notifyPushes(env: Env, metadata: AnimeMetadata, caption: string, torrents: SeaDexTorrent[], replyMarkup = { inline_keyboard: buttons(metadata, torrents) }): Promise<void> {
  for (const value of (env.TELEGRAM_PUSH_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean)) {
    await sendPush(env, value, metadata, caption, replyMarkup)
  }
}

/** Send one push notification. Sync uses this primitive through its durable outbox. */
export async function sendPush(env: Env, chatId: string, metadata: AnimeMetadata, caption: string, replyMarkup: unknown): Promise<void> {
  await sendRichMessage(env, chatId, metadata, caption, replyMarkup)
}

async function editInlineResult(env: Env, inlineMessageId: string, alid: number): Promise<void> {
  const metadata = await getMetadata(env.DB, alid)
  if (!metadata) {
    await telegram(env, "editMessageText", { inline_message_id: inlineMessageId, text: "No results found for this anime." })
    return
  }
  const entry = await findEntryByAniList(env.DB, alid)
  if (!entry) {
    await telegram(env, "editMessageText", { inline_message_id: inlineMessageId, text: `*${escapeMarkdown(metadata.title)}*\n\n${escapeMarkdown("This anime exists in AniList but not in SeaDex yet.")}`, parse_mode: "MarkdownV2" })
    return
  }
  const torrents = await getTorrents(env.DB, entry.trs)
  const caption = searchCaption(metadata, torrents, entry)
  const replyMarkup = { inline_keyboard: buttons(metadata, torrents) }
  if (metadata.picture && Array.from(caption).length <= TELEGRAM_CAPTION_LIMIT) {
    try {
      await telegram(env, "editMessageMedia", { inline_message_id: inlineMessageId, media: { type: "photo", media: formatPictureUrl(metadata.picture), caption, parse_mode: "MarkdownV2" }, reply_markup: replyMarkup })
      return
    } catch (error) {
      // Fall back when Telegram rejects the photo edit.
      if (!isPhotoFallbackError(error)) throw error
    }
  }
  await telegram(env, "editMessageText", { inline_message_id: inlineMessageId, ...formattedTextBody(caption), reply_markup: replyMarkup })
}

function guestPlainResult(id: string, title: string, text: string): Record<string, unknown> {
  return {
    type: "article",
    id,
    title,
    input_message_content: { message_text: limitText(text, TELEGRAM_TEXT_LIMIT) }
  }
}

function guestMetadataResult(metadata: AnimeMetadata): Record<string, unknown> {
  return {
    type: "article",
    id: `guest_${metadata.anilistId}`,
    title: metadata.title,
    description: `ID: ${metadata.anilistId}`,
    ...(metadata.thumbnail || metadata.picture ? { thumbnail_url: metadata.thumbnail ?? metadata.picture } : {}),
    input_message_content: {
      message_text: limitText(`*${escapeMarkdown(metadata.title)}*\n\n${escapeMarkdown("Loading...")}`, TELEGRAM_TEXT_LIMIT),
      parse_mode: "MarkdownV2"
    },
    reply_markup: { inline_keyboard: [[{ text: "Loading...", callback_data: "loading" }]] }
  }
}

function guestRandomResult(): Record<string, unknown> {
  return {
    type: "article",
    id: "guest_random",
    title: "Random",
    description: "Get a random anime",
    input_message_content: {
      message_text: `*Random*\n\n${escapeMarkdown("Loading...")}`,
      parse_mode: "MarkdownV2"
    },
    reply_markup: { inline_keyboard: [[{ text: "Loading...", callback_data: "loading" }]] }
  }
}

async function claimUpdate(db: D1Database, updateId: number): Promise<boolean> {
  const now = new Date().toISOString()
  try {
    // Store only a bounded technical dedupe set.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    await db.prepare("DELETE FROM telegram_update_dedupe WHERE updated_at < ?").bind(cutoff).run()
    const inserted = await db.prepare(
      "INSERT OR IGNORE INTO telegram_update_dedupe(update_id, state, updated_at) VALUES (?, 'processing', ?)"
    ).bind(updateId, now).run()
    if (Number(inserted.meta.changes ?? 0) > 0) return true
    const existing = await db.prepare(
      "SELECT state, updated_at FROM telegram_update_dedupe WHERE update_id = ?"
    ).bind(updateId).first<{ state: string; updated_at: string }>()
    if (!existing || existing.state === "done") return false
    const age = Date.now() - Date.parse(existing.updated_at)
    if (!Number.isFinite(age) || age < 5 * 60_000) return false
    const reclaimed = await db.prepare(
      "UPDATE telegram_update_dedupe SET state = 'processing', updated_at = ? WHERE update_id = ? AND state = 'processing' AND updated_at = ?"
    ).bind(now, updateId, existing.updated_at).run()
    return Number(reclaimed.meta.changes ?? 0) > 0
  } catch (error) {
    // Missing dedupe storage must not block a user response.
    console.warn("Telegram update dedupe unavailable", String(error))
    return true
  }
}

async function markUpdateDone(db: D1Database, updateId: number): Promise<void> {
  try {
    await db.prepare("UPDATE telegram_update_dedupe SET state = 'done', updated_at = ? WHERE update_id = ?")
      .bind(new Date().toISOString(), updateId).run()
  } catch (error) {
    console.warn("Failed to mark Telegram update complete", String(error))
  }
}

async function releaseUpdate(db: D1Database, updateId: number): Promise<void> {
  try {
    await db.prepare("DELETE FROM telegram_update_dedupe WHERE update_id = ?").bind(updateId).run()
  } catch (error) {
    console.warn("Failed to release Telegram update claim", String(error))
  }
}

let cachedBotUsername: string | null | undefined

async function getBotUsername(env: Env): Promise<string | null> {
  if (env.TELEGRAM_BOT_USERNAME?.trim()) return env.TELEGRAM_BOT_USERNAME.trim().replace(/^@/, "")
  if (cachedBotUsername !== undefined) return cachedBotUsername
  const result = await telegram(env, "getMe", {})
  const user = result.result && typeof result.result === "object" ? result.result as { username?: unknown } : null
  cachedBotUsername = typeof user?.username === "string" ? user.username : null
  return cachedBotUsername
}

function extractMentionQuery(text: string, username: string): string | null {
  const mention = new RegExp(`(?<![A-Za-z0-9_])@${username.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?![A-Za-z0-9_])`, "i")
  if (!mention.test(text)) return null
  return text.replace(mention, " ").replace(/\s+/g, " ").trim()
}

async function findGuestMetadata(env: Env, query: string): Promise<AnimeMetadata | null> {
  if (/^\d+$/.test(query)) {
    const direct = await getMetadata(env.DB, Number(query))
    if (direct) return direct
  }
  return (await searchMetadata(env.DB, query, 1))[0] ?? null
}

async function editGuestResult(env: Env, sent: TelegramSentMessage, alid: number): Promise<void> {
  if (!sent.inline_message_id) return
  try {
    await editInlineResult(env, sent.inline_message_id, alid)
  } catch (error) {
    // The query is already answered; retrying may target an expired ID.
    console.error("Telegram guest result edit failed", String(error))
  }
}

async function handleGuestMessage(env: Env, message: NonNullable<TelegramUpdate["guest_message"]>): Promise<void> {
  const guestQueryId = message.guest_query_id
  if (!guestQueryId) return

  const rawText = message.text?.trim() ?? ""
  let query = rawText
  if (rawText) {
    let username: string | null
    try {
      username = await getBotUsername(env)
    } catch (error) {
      console.error("Telegram guest username lookup failed", String(error))
      await answerGuestQuery(env, guestQueryId, guestPlainResult(
        "guest_search_error",
        "Search unavailable",
        "Search is temporarily unavailable."
      ))
      return
    }
    if (username) query = extractMentionQuery(rawText, username) ?? rawText
  }

  if (!query) {
    let entry: SeaDexEntry | null
    try {
      entry = await getRandomEntry(env.DB)
    } catch (error) {
      console.error("Telegram guest random lookup failed", String(error))
      await answerGuestQuery(env, guestQueryId, guestPlainResult(
        "guest_search_error",
        "Search unavailable",
        "Search is temporarily unavailable."
      ))
      return
    }
    if (!entry?.alid) {
      await answerGuestQuery(env, guestQueryId, guestPlainResult("guest_no_entries", "No entries", "No entries found"))
      return
    }
    let metadata: AnimeMetadata | null
    try {
      metadata = await getMetadata(env.DB, entry.alid)
    } catch (error) {
      console.error("Telegram guest random metadata lookup failed", String(error))
      await answerGuestQuery(env, guestQueryId, guestPlainResult(
        "guest_search_error",
        "Search unavailable",
        "Search is temporarily unavailable."
      ))
      return
    }
    if (!metadata) {
      await answerGuestQuery(env, guestQueryId, guestPlainResult(
        "guest_no_metadata",
        "Random unavailable",
        "Random entry has no metadata"
      ))
      return
    }
    const sent = await answerGuestQuery(env, guestQueryId, guestRandomResult())
    await editGuestResult(env, sent, metadata.anilistId)
    return
  }

  let metadata: AnimeMetadata | null
  try {
    metadata = await findGuestMetadata(env, query)
  } catch (error) {
    console.error("Telegram guest search failed", String(error))
    await answerGuestQuery(env, guestQueryId, guestPlainResult(
      "guest_search_error",
      "Search unavailable",
      "Search is temporarily unavailable."
    ))
    return
  }
  if (!metadata) {
    await answerGuestQuery(env, guestQueryId, guestPlainResult(
      "guest_no_results",
      "No results",
      `No results found for: ${query}`
    ))
    return
  }

  const sent = await answerGuestQuery(env, guestQueryId, guestMetadataResult(metadata))
  await editGuestResult(env, sent, metadata.anilistId)
}

async function handleGuestMention(env: Env, message: NonNullable<TelegramUpdate["message"]>, text: string): Promise<boolean> {
  // Avoid getMe for ordinary text when no mention entity is present.
  const configuredUsername = env.TELEGRAM_BOT_USERNAME?.trim()
  const hasMentionEntity = message.entities?.some((entity) => entity.type === "mention") ?? false
  if (!configuredUsername && !hasMentionEntity) return false
  const username = await getBotUsername(env)
  if (!username) return false
  const query = extractMentionQuery(text, username)
  if (query === null) return false
  if (!query) {
    const entry = await getRandomEntry(env.DB)
    if (!entry?.alid) {
      await sendText(env, message.chat.id, "No entries found", message.message_id)
      return true
    }
    const metadata = await getMetadata(env.DB, entry.alid)
    if (!metadata) {
      await sendText(env, message.chat.id, `Anime (${entry.alid}) is waiting for metadata.`, message.message_id)
      return true
    }
    await sendAnime(env, message.chat.id, metadata, message.message_id)
    return true
  }
  const results = await searchMetadata(env.DB, query)
  if (!results.length) {
    await sendText(env, message.chat.id, `No results found for: ${query}`, message.message_id)
    return true
  }
  await sendAnime(env, message.chat.id, results[0], message.message_id)
  return true
}

async function routeTelegramUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  if (update.guest_message) {
    await handleGuestMessage(env, update.guest_message)
    return
  }

  if (update.inline_query) {
    await answerInline(env, update.inline_query.id, update.inline_query.query.trim())
    return
  }

  if (update.callback_query) {
    await answerCallback(env, update.callback_query.id)
    return
  }

  // Telegram inserts a placeholder before the chosen inline result is edited.
  if (update.chosen_inline_result?.inline_message_id) {
    const resultId = update.chosen_inline_result.result_id
    const alid = resultId.startsWith("show_") ? Number(resultId.slice(5)) : Number(resultId)
    if (resultId === "random") {
      const entry = await getRandomEntry(env.DB)
      if (!entry) {
        await telegram(env, "editMessageText", { inline_message_id: update.chosen_inline_result.inline_message_id, text: "No entries found" })
      } else if (!entry.alid) {
        await telegram(env, "editMessageText", { inline_message_id: update.chosen_inline_result.inline_message_id, text: "Random entry has no AniList ID" })
      } else if (!await getMetadata(env.DB, entry.alid)) {
        await telegram(env, "editMessageText", { inline_message_id: update.chosen_inline_result.inline_message_id, text: "Random entry has no metadata" })
      } else {
        await editInlineResult(env, update.chosen_inline_result.inline_message_id, entry.alid)
      }
    } else if (Number.isSafeInteger(alid) && alid > 0) {
      await editInlineResult(env, update.chosen_inline_result.inline_message_id, alid)
    }
    return
  }

  const message = update.message
  if (!message?.text) return
  const text = message.text.trim()
  const chatId = message.chat.id
  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
    await sendText(env, chatId, "Welcome to SeaDex Bot!\n\nThis bot monitors anime releases from releases.moe\nand sends notifications about updates.\n\nCommands:\n/search - Search for anime\n/random - Get a random entry\n/stats - Show database statistics\n/help - Show this help", message.message_id)
    return
  }
  if (/^\/help(?:@\w+)?(?:\s|$)/i.test(text)) {
    await sendText(env, chatId, "/search <anime title> - Search for anime by title\n/random - Get a random entry\n/show <anilist id> - Show entry by AniList ID\n/stats - Show database statistics\n/help - Show this help\n\n", message.message_id)
    return
  }
  if (isStatsCommand(text)) {
    const stats = await getStats(env.DB)
    const completion = stats.completion.toFixed(1)
    await sendMarkdown(env, chatId, `*Entries*: ${stats.entries}\n*Torrents*: ${stats.torrents}\n  \\- Nyaa: ${stats.nyaa}\n  \\- PT: ${stats.pt}\n*With Best*: ${stats.best}\n*With Alt*: ${stats.alt}\n*Completion*: ${escapeMarkdown(completion)}%\n*Metadata*: ${stats.metadata}\n*Updated*: ${escapeMarkdown(formatStatsUpdated(stats.updated))}`, undefined, message.message_id)
    return
  }
  if (/^\/random(?:@\w+)?(?:\s|$)/i.test(text)) {
    const entry = await getRandomEntry(env.DB)
    if (!entry?.alid) {
      await sendText(env, chatId, "No entries found", message.message_id)
      return
    }
    const metadata = await getMetadata(env.DB, entry.alid)
    if (!metadata) {
      await sendText(env, chatId, `Anime (${entry.alid}) is waiting for metadata.`, message.message_id)
      return
    }
    await sendAnime(env, chatId, metadata, message.message_id)
    return
  }

  if (/^\/search(?:@\w+)?$/i.test(text)) {
    await sendText(env, chatId, "Usage: /search <anime title>\n\nExample: /search Bocchi the Rock", message.message_id)
    return
  }
  if (/^\/show(?:@\w+)?$/i.test(text)) {
    await sendText(env, chatId, "Usage: /show <anilist id>\n\nExample: /show 1535", message.message_id)
    return
  }
  const invalidShow = text.match(/^\/show(?:@\w+)?\s+(.+)$/i)
  if (invalidShow && !/^\d+$/.test(invalidShow[1].trim())) {
    await sendText(env, chatId, "Invalid AniList ID. Please provide a numeric ID.\n\nExample: /show 1535", message.message_id)
    return
  }
  const command = text.match(/^\/(search|show)(?:@\w+)?\s+(.+)$/i)
  if (command) {
    const [, name, argument] = command
    if (name.toLowerCase() === "show" && /^\d+$/.test(argument)) {
      const metadata = await getMetadata(env.DB, Number(argument))
      if (!metadata) await sendText(env, chatId, `No anime found with AniList ID: ${argument}`, message.message_id)
      else await sendAnime(env, chatId, metadata, message.message_id)
      return
    }
    await handleSearch(env, chatId, argument, message.message_id)
    return
  }
  if (text.startsWith("/")) {
    await sendText(env, chatId, "Use /help to see available commands.", message.message_id)
    return
  }
  await handleGuestMention(env, message, text)
}

export async function handleTelegramUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const updateId = update.update_id
  const claimed = Number.isSafeInteger(updateId) ? await claimUpdate(env.DB, updateId) : true
  if (!claimed) return
  try {
    await routeTelegramUpdate(env, update)
    if (Number.isSafeInteger(updateId)) await markUpdateDone(env.DB, updateId)
  } catch (error) {
    console.error("Telegram update handling failed", { updateId, error: String(error) })
    const message = update.message
    if (message?.chat?.id !== undefined) {
      try {
        await sendText(env, message.chat.id, "SeaDex is temporarily unavailable. Please try again later.", message.message_id)
        if (Number.isSafeInteger(updateId)) await markUpdateDone(env.DB, updateId)
        return
      } catch (replyError) {
        console.error("Telegram error reply failed", String(replyError))
      }
    }
    if (Number.isSafeInteger(updateId)) await releaseUpdate(env.DB, updateId)
    throw error
  }
}
