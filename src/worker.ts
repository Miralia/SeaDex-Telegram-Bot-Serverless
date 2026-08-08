import { replaySyncNotifications } from "./audit"
import { getMetadata, searchMetadata } from "./repository"
import { runSyncTick } from "./sync"
import { handleTelegramUpdate } from "./telegram"
import type { Env, SyncMessage, TelegramUpdate } from "./types"

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } })
}

function isAuthorizedWebhook(request: Request, env: Env): boolean {
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === env.TELEGRAM_WEBHOOK_SECRET
}

function isAuthorizedReplay(request: Request, env: Env): boolean {
  return Boolean(env.TELEGRAM_WEBHOOK_SECRET) && request.headers.get("Authorization") === `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`
}

const worker: ExportedHandler<Env, SyncMessage> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true })

    if (request.method === "GET" && url.pathname === "/api/search") {
      const query = url.searchParams.get("q") ?? ""
      const limitValue = Number(url.searchParams.get("limit") ?? "10")
      const limit = Number.isFinite(limitValue) ? Math.min(Math.max(Math.trunc(limitValue), 1), 20) : 10
      return json(await searchMetadata(env.DB, query, limit))
    }

    const animeMatch = url.pathname.match(/^\/api\/anime\/(\d+)$/)
    if (request.method === "GET" && animeMatch) {
      const metadata = await getMetadata(env.DB, Number(animeMatch[1]))
      return metadata ? json(metadata) : json({ error: "not found" }, 404)
    }

    const replayMatch = url.pathname.match(/^\/api\/sync-runs\/([^/]+)\/replay$/)
    if (request.method === "POST" && replayMatch) {
      if (!isAuthorizedReplay(request, env)) return json({ error: "unauthorized" }, 401)
      const syncRunId = decodeURIComponent(replayMatch[1])
      const queued = await replaySyncNotifications(env.DB, syncRunId)
      return json({ ok: true, sync_run_id: syncRunId, queued })
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (!isAuthorizedWebhook(request, env)) return json({ error: "unauthorized" }, 401)
      const update = await request.json<TelegramUpdate>()
      await handleTelegramUpdate(env, update)
      return json({ ok: true })
    }
    return json({ error: "not found" }, 404)
  },

  async scheduled(_, env): Promise<void> {
    console.log("SeaDex scheduled sync: enqueueing sync_tick")
    await env.SYNC_QUEUE.send({ kind: "sync_tick" })
  },

  async queue(batch, env): Promise<void> {
    console.log(`SeaDex sync queue: received ${batch.messages.length} message(s)`)
    for (const message of batch.messages) {
      try {
        if (message.body.kind === "sync_tick") {
          await runSyncTick(env)
          console.log("SeaDex sync queue: sync_tick completed")
        }
        message.ack()
      } catch (error) {
        // Let Cloudflare Queue retry transient sync failures.
        console.error("SeaDex sync queue: sync_tick failed; scheduling retry", error)
        message.retry({ delaySeconds: 60 })
      }
    }
  }
}

export default worker
