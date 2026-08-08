const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u
const TOKEN_PATTERN = /[\p{L}\p{N}\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+/gu

export function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim()
}

export function cjkBigrams(value: string): string[] {
  const chars = Array.from(normalizeText(value)).filter((char) => CJK_PATTERN.test(char))
  if (chars.length < 2) return chars
  const terms: string[] = []
  for (let index = 0; index < chars.length - 1; index += 1) {
    terms.push(chars.slice(index, index + 2).join(""))
  }
  return terms
}

export function buildSearchText(values: Iterable<string | null | undefined>): string {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const value of values) {
    if (!value) continue
    const normalized = normalizeText(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    terms.push(normalized, ...cjkBigrams(normalized))
  }
  return [...new Set(terms)].join(" ")
}

type MatchRank = [priority: number, typePriority: number, lengthDifference: number, matchLength: number]

function classifyMatch(query: string, value: string, words: string[]): [number, number] | null {
  if (!value) return null
  if (query === value) return [0, value.length]
  if (value.includes(query) || (words.length === 1 && value.includes(words[0]))) return [1, value.length]
  if (words.length > 1 && words.every((word) => value.includes(word))) return [2, value.length]
  return null
}

/** Rank an FTS candidate using title, alias and type priorities. */
export function metadataMatchRank(query: string, title: string, aliases: string[], type: string | null): MatchRank {
  const normalizedQuery = normalizeText(query)
  const words = normalizedQuery.match(TOKEN_PATTERN) ?? []
  const candidates = [title, ...aliases]
    .map((value) => classifyMatch(normalizedQuery, normalizeText(value), words))
    .filter((value): value is [number, number] => value !== null)
  const match = candidates.sort((left, right) => left[0] - right[0] || left[1] - right[1])[0]
  if (!match) return [99, 1, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  const typePriority = type && ["TV", "MOVIE"].includes(type.toUpperCase()) ? 0 : 1
  return [match[0], typePriority, Math.abs(match[1] - normalizedQuery.length), match[1]]
}

function escapeFtsToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`
}

export function toFtsQuery(query: string): string | null {
  const normalized = normalizeText(query)
  if (!normalized) return null

  const terms: string[] = []
  for (const token of normalized.match(TOKEN_PATTERN) ?? []) {
    const cjk = cjkBigrams(token)
    if (cjk.length > 0) {
      terms.push(...cjk.map(escapeFtsToken))
    } else if (token.length >= 2) {
      terms.push(`${escapeFtsToken(token)}*`)
    }
  }
  return terms.length ? terms.join(" AND ") : null
}
