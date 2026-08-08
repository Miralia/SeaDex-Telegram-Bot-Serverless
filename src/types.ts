export interface Env {
  DB: D1Database
  SYNC_QUEUE: Queue<SyncMessage>
  PUBLIC_API_RATE_LIMITER?: RateLimit
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET: string
  TELEGRAM_BOT_USERNAME?: string
  TELEGRAM_PUSH_IDS?: string
  SEADEX_API_URL: string
}

export interface AnimeMetadata {
  anilistId: number
  title: string
  picture: string | null
  thumbnail: string | null
  type: string | null
  seasonYear: number | null
}

export interface SeaDexEntry {
  id: string
  alid: number | null
  incomplete: boolean
  notes: string | null
  comparison: string | null
  trs: string[]
  theoreticalBest: string | null
  created: string | null
  updated: string
}

export interface SeaDexTorrent {
  id: string
  url: string | null
  infoHash: string | null
  releaseGroup: string | null
  tracker: string | null
  isBest: boolean
  dualAudio: boolean
  groupedUrl: string | null
  tags: string[]
  files: unknown[]
  created: string | null
  updated: string
}

export interface BotStats {
  entries: number
  torrents: number
  nyaa: number
  pt: number
  best: number
  alt: number
  incomplete: number
  metadata: number
  completion: number
  updated: string | null
}

export type SyncMessage = { kind: "sync_tick" }

export interface TelegramMessage {
  message_id: number
  chat: { id: number | string }
  text?: string
  entities?: TelegramMessageEntity[]
  guest_query_id?: string
}

export interface TelegramMessageEntity {
  type: string
  offset: number
  length: number
}

export interface TelegramInlineQuery {
  id: string
  query: string
}

export interface TelegramChosenInlineResult {
  result_id: string
  inline_message_id?: string
}

export interface TelegramCallbackQuery {
  id: string
  data?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  guest_message?: TelegramMessage
  inline_query?: TelegramInlineQuery
  chosen_inline_result?: TelegramChosenInlineResult
  callback_query?: TelegramCallbackQuery
}
