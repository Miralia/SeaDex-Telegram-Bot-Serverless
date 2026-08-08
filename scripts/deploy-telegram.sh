#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd -- "$PROJECT_DIR"

WORKER_URL="${WORKER_URL:-}"
BOT_TOKEN="${DEPLOY_TELEGRAM_BOT_TOKEN:-}"
WEBHOOK_SECRET="${DEPLOY_TELEGRAM_WEBHOOK_SECRET:-}"
PUSH_IDS="${DEPLOY_TELEGRAM_PUSH_IDS:-}"
DEPLOY_MESSAGE="${DEPLOY_MESSAGE:-production telegram deployment}"
D1_DATABASE_ID="${CLOUDFLARE_D1_DATABASE_ID:-}"

if [[ -z "$BOT_TOKEN" ]]; then
  printf '%s\n' "DEPLOY_TELEGRAM_BOT_TOKEN is required" >&2
  exit 2
fi
if [[ -z "$WEBHOOK_SECRET" ]]; then
  printf '%s\n' "DEPLOY_TELEGRAM_WEBHOOK_SECRET is required" >&2
  exit 2
fi
if [[ -z "$PUSH_IDS" ]]; then
  printf '%s\n' "DEPLOY_TELEGRAM_PUSH_IDS is required" >&2
  exit 2
fi
if [[ ! "$PUSH_IDS" =~ ^-?[0-9]+([[:space:]]*,[[:space:]]*-?[0-9]+)*$ ]]; then
  printf '%s\n' "DEPLOY_TELEGRAM_PUSH_IDS must be a comma-separated list of chat IDs" >&2
  exit 2
fi

if [[ -z "$WORKER_URL" ]]; then
  printf '%s\n' "WORKER_URL is required" >&2
  exit 2
fi
if [[ ! "$D1_DATABASE_ID" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]]; then
  printf '%s\n' "CLOUDFLARE_D1_DATABASE_ID must be a D1 UUID" >&2
  exit 2
fi

mkdir -p "$PROJECT_DIR/.wrangler"
WRANGLER_CONFIG="$(mktemp "$PROJECT_DIR/.wrangler/seadex-wrangler.XXXXXX.toml")"
trap 'rm -f "$WRANGLER_CONFIG"' EXIT
bash "$PROJECT_DIR/scripts/prepare-wrangler-config.sh" "$WRANGLER_CONFIG"

WEBHOOK_URL="${WORKER_URL%/}/telegram"

printf '%s' "$BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN --config "$WRANGLER_CONFIG"
printf '%s' "$WEBHOOK_SECRET" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --config "$WRANGLER_CONFIG"

npx wrangler deploy \
  --config "$WRANGLER_CONFIG" \
  --var "TELEGRAM_PUSH_IDS:${PUSH_IDS}" \
  --message "$DEPLOY_MESSAGE"
npx wrangler triggers deploy --config "$WRANGLER_CONFIG"

curl --fail-with-body --silent --show-error --max-time 30 \
  -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WEBHOOK_URL}" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","guest_message","inline_query","chosen_inline_result","callback_query"]'
printf '\n'

curl --fail-with-body --silent --show-error --max-time 30 \
  "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
printf '\n'
