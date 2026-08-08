# SeaDex Telegram Bot Serverless

Cloudflare Worker implementation of the SeaDex Telegram bot. It uses D1 for
SeaDex data and Queues for serialized synchronization jobs.

## Production

- Worker: `seadex-telegram-bot-serverless`
- D1: `seadex`
- Queue: `seadex-sync`
- Dead-letter queue: `seadex-sync-dlq`

Pushes to `main` deploy the Worker through
`.github/workflows/deploy.yml`. Metadata builds run through
`.github/workflows/metadata.yml`.

Create a GitHub Environment named `production` with these secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_D1_DATABASE_ID`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_PUSH_IDS`

Add these environment variables:

- `WORKER_URL`: public Worker URL, without `/telegram`
- `METADATA_D1_DATABASE`: `seadex`

The Cloudflare API token needs permission to deploy Workers and update D1 and
Queues. The real D1 UUID is supplied through GitHub Secrets and is never stored
in `wrangler.toml`.

## Development

```sh
npm ci
npm run typecheck
```

## API

- `GET /health`
- `GET /api/search?q=<query>`
- `GET /api/anime/<anilist-id>`
- `POST /telegram` (Telegram webhook)

## License

Project-authored source code, schema, scripts, and configuration are licensed
under the [0BSD license](LICENSE).

Generated metadata can include data derived from
[anime-offline-database](https://github.com/manami-project/anime-offline-database)
(ODbL 1.0 and DBCL 1.0) and
[bangumi-data](https://github.com/bangumi-data/bangumi-data) (CC BY 4.0).
Their licenses and attribution requirements still apply.
