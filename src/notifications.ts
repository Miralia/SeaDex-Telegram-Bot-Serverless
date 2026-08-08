import type { AnimeMetadata, SeaDexEntry, SeaDexTorrent } from "./types"

export type EntryNotificationDiff = {
  isNew: boolean
  current: SeaDexEntry
  fieldChanges: Record<string, unknown>
  torrentFieldChanges: Record<string, Record<string, unknown>>
  previousTorrents: SeaDexTorrent[]
  currentTorrents: SeaDexTorrent[]
}

type Bucket = {
  removed: Set<string>
  added: Set<string>
  updated: Map<string, string>
  moved: Set<string>
}

// Escape backslashes and backticks inside MarkdownV2 code blocks.
const code = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll("`", "\\`")
const markdown = (value: string): string => value.replace(/[\\_*\[\]()~`>#+\-=|{}.!]/g, (char) => `\\${char}`)
const link = (url: string): string => `[${markdown(url)}](${url.replaceAll("\\", "\\\\").replaceAll(")", "\\)")})`

function field(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

function ids(value: unknown, name: "old" | "new" | "added" | "removed"): string[] {
  const candidate = field(value)[name]
  return Array.isArray(candidate) ? candidate.filter((item): item is string => typeof item === "string") : []
}

function text(value: unknown): { old: string; next: string; changed: boolean } {
  const change = field(value)
  const old = typeof change.old === "string" ? change.old : ""
  const next = typeof change.new === "string" ? change.new : ""
  return { old, next, changed: old !== next }
}

function urls(value: string): string[] {
  const seen = new Set<string>()
  return value.split(/[,\r\n]+/).map((item) => item.trim()).filter((item) => Boolean(item) && !seen.has(item) && Boolean(seen.add(item)))
}

function releaseDetails(torrent: SeaDexTorrent): string {
  const official = ["Broken", "Deband Recommended", "Deband Required", "Dolby Vision", "HDR", "Incomplete", "Misplaced Special", "Patch Required", "VFR", "YUV444P"]
  const values = new Set(torrent.tags.map((tag) => tag.trim()).filter(Boolean))
  const tags = [...official.filter((tag) => [...values].some((value) => value.toLowerCase() === tag.toLowerCase())), ...[...values].filter((tag) => !official.some((known) => known.toLowerCase() === tag.toLowerCase())).sort()]
  const parts = torrent.dualAudio ? ["Dual Audio", ...tags] : tags
  return parts.length ? ` (${parts.join(" / ")})` : ""
}

function lineDiff(oldValue: string, newValue: string): string {
  const oldLines = oldValue.trim() ? oldValue.trim().split("\n") : []
  const newLines = newValue.trim() ? newValue.trim().split("\n") : []
  // Preserve order and duplicates to match difflib.ndiff.
  const common = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0))
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      common[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? common[oldIndex + 1][newIndex + 1] + 1
        : Math.max(common[oldIndex + 1][newIndex], common[oldIndex][newIndex + 1])
    }
  }

  const result: string[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      oldIndex += 1
      newIndex += 1
    } else if (oldIndex < oldLines.length && (newIndex >= newLines.length || common[oldIndex + 1][newIndex] >= common[oldIndex][newIndex + 1])) {
      result.push(`- ${code(oldLines[oldIndex])}`)
      oldIndex += 1
    } else if (newIndex < newLines.length) {
      result.push(`+ ${code(newLines[newIndex])}`)
      newIndex += 1
    }
  }
  if (!result.length) return ""
  let output = result.join("\n")
  if (output.length > 800) output = `${output.slice(0, 800)}\n...`
  return `\`\`\`diff\n${output}\n\`\`\``
}

function changedButtonIds(diff: EntryNotificationDiff): string[] {
  if (diff.isNew) return diff.current.trs
  const torrentIds = [
    ...ids(diff.fieldChanges.trs, "added"),
    ...Object.keys(field(diff.fieldChanges.is_best)),
    ...Object.entries(diff.torrentFieldChanges).filter(([, changes]) => {
      const keys = Object.keys(changes)
      return keys.some((key) => key !== "dual_audio" && key !== "tags")
    }).map(([id]) => id)
  ]
  const current = new Set(diff.current.trs)
  return [...new Set(torrentIds)].filter((id) => current.has(id))
}

function buildBucket(): Bucket {
  return { removed: new Set(), added: new Set(), updated: new Map(), moved: new Set() }
}

/** Build a MarkdownV2 notification with the original section semantics. */
export function buildUpdateNotification(metadata: AnimeMetadata, diff: EntryNotificationDiff): { caption: string; buttonTorrentIds: string[] } | null {
  const lines = [diff.isNew ? "🆕 *New Entry* 🆕" : "🆕 *New Update* 🆕", "", `*${markdown(metadata.title)}*`, ""]
  const previous = new Map(diff.previousTorrents.map((torrent) => [torrent.id, torrent]))
  const current = new Map(diff.currentTorrents.map((torrent) => [torrent.id, torrent]))
  const torrent = (id: string, preferCurrent = true): SeaDexTorrent | undefined => preferCurrent ? current.get(id) ?? previous.get(id) : previous.get(id) ?? current.get(id)
  const trs = field(diff.fieldChanges.trs)
  const added = diff.isNew ? diff.current.trs : ids(trs, "added")
  const removed = ids(trs, "removed")

  if (diff.isNew) {
    for (const [label, isBest] of [["Best", true], ["Alt", false]] as const) {
      const groups = new Set<string>()
      const output: string[] = []
      if (isBest && diff.current.theoreticalBest) {
        groups.add(diff.current.theoreticalBest)
        output.push(`+ ${code(diff.current.theoreticalBest)} (Unmuxed)`)
      }
      for (const id of added) {
        const value = torrent(id)
        if (!value || value.isBest !== isBest) continue
        const group = value.releaseGroup || "Unknown"
        if (!groups.has(group)) {
          groups.add(group)
          output.push(`+ ${code(group)}${code(releaseDetails(value))}`)
        }
      }
      if (output.length) lines.push(`_${label}_`, `\`\`\`diff\n${output.join("\n")}\n\`\`\``, "")
    }
    if (diff.current.notes) {
      const output = diff.current.notes.split("\n").filter((line) => line.trim()).slice(0, 10).map((line) => `+ ${code(line)}`)
      if (output.length) lines.push("_Notes_", `\`\`\`diff\n${output.join("\n")}\n\`\`\``, "")
    }
    if (diff.current.comparison) {
      if (lines.at(-1) === "") lines.push("")
      lines.push("_Comparisons_", ...urls(diff.current.comparison).map(link), "")
    }
    return { caption: lines.join("\n"), buttonTorrentIds: changedButtonIds(diff) }
  }

  const best = buildBucket()
  const alt = buildBucket()
  for (const id of removed) {
    const value = torrent(id, false)
    if (value) (value.isBest ? best : alt).removed.add(value.releaseGroup || "Unknown")
  }
  for (const id of added) {
    const value = torrent(id)
    if (value) (value.isBest ? best : alt).added.add(value.releaseGroup || "Unknown")
  }
  for (const [id, raw] of Object.entries(field(diff.fieldChanges.is_best))) {
    const value = torrent(id)
    const change = field(raw)
    const group = value?.releaseGroup || "Unknown"
    if (change.old === true && change.new === false) { best.removed.add(group); alt.added.add(group); alt.moved.add(group) }
    if (change.old === false && change.new === true) { alt.removed.add(group); best.added.add(group); best.moved.add(group) }
  }
  for (const bucket of [best, alt]) for (const group of [...bucket.removed].filter((group) => bucket.added.has(group))) {
    bucket.removed.delete(group)
    bucket.added.delete(group)
    bucket.updated.set(group, bucket === best ? "Updated Best Link" : "Updated Alt Link")
  }
  for (const [id, changes] of Object.entries(diff.torrentFieldChanges)) {
    const keys = Object.keys(changes)
    if (!keys.length || keys.every((key) => key === "dual_audio" || key === "tags")) continue
    const value = torrent(id)
    if (!value) continue
    const linkOnly = keys.every((key) => ["url", "info_hash", "grouped_url", "tracker"].includes(key))
    ;(value.isBest ? best : alt).updated.set(value.releaseGroup || "Unknown", linkOnly ? (value.isBest ? "Updated Best Link" : "Updated Alt Link") : (value.isBest ? "Updated Best Release" : "Updated Alt Release"))
  }
  const oldTrs = ids(trs, "old")
  const oldGroups = (isBest: boolean): Set<string> => new Set(oldTrs.map((id) => torrent(id, false)).filter((value): value is SeaDexTorrent => Boolean(value && value.isBest === isBest)).map((value) => value.releaseGroup || "Unknown"))
  const theoretical = text(diff.fieldChanges.theoretical_best)
  const renderBucket = (heading: string, bucket: Bucket, old: Set<string>, includeTheoretical: boolean): boolean => {
    const removals = new Set(bucket.removed)
    const additions = new Set(bucket.added)
    if (includeTheoretical && theoretical.old) removals.add(theoretical.old)
    if (includeTheoretical && theoretical.next) additions.add(theoretical.next)
    const output: string[] = []
    for (const group of [...removals].sort()) {
      if (includeTheoretical && group === theoretical.old && !bucket.removed.size) continue
      output.push(`- ${code(group)}${includeTheoretical && group === theoretical.old ? " (Unmuxed)" : ""}`)
    }
    for (const group of [...additions].sort()) {
      const comment = bucket.moved.has(group) ? (bucket === best ? "  # Moved from Alt" : "  # Moved from Best") : old.has(group) ? (bucket === best ? "  # Added Best Link" : "  # Added Alt Link") : ""
      output.push(`+ ${code(group)}${includeTheoretical && group === theoretical.next ? " (Unmuxed)" : ""}${comment}`)
    }
    for (const [group, comment] of [...bucket.updated.entries()].sort(([left], [right]) => left.localeCompare(right))) output.push(`+ ${code(group)}  # ${comment}`)
    if (!output.length) return false
    lines.push(`_${heading}_`, `\`\`\`diff\n${output.join("\n")}\n\`\`\``, "")
    return true
  }
  let meaningful = renderBucket("New Best", best, oldGroups(true), true)
  meaningful = renderBucket("New Alt", alt, oldGroups(false), false) || meaningful
  const notes = text(diff.fieldChanges.notes)
  if (notes.changed) {
    const output = lineDiff(notes.old, notes.next)
    if (output) { lines.push("_Notes_", output, ""); meaningful = true }
  }
  const comparison = text(diff.fieldChanges.comparison)
  if (comparison.changed) {
    const old = urls(comparison.old)
    const next = urls(comparison.next)
    const addedUrls = next.filter((url) => !old.includes(url))
    const display = addedUrls.length ? addedUrls : next
    if (display.length) {
      if (lines.at(-1) === "") lines.push("")
      lines.push("_Comparisons_", ...display.map(link), "")
      meaningful = true
    }
  }
  return meaningful ? { caption: lines.join("\n"), buttonTorrentIds: changedButtonIds(diff) } : null
}
