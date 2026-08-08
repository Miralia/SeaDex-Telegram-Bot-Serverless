#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$PROJECT_DIR/wrangler.toml"
OUTPUT="${1:-}"
D1_DATABASE_ID="${CLOUDFLARE_D1_DATABASE_ID:-}"

if [[ -z "$OUTPUT" ]]; then
  printf '%s\n' "usage: CLOUDFLARE_D1_DATABASE_ID=<uuid> $0 <output-path>" >&2
  exit 2
fi
if [[ ! "$D1_DATABASE_ID" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]]; then
  printf '%s\n' "CLOUDFLARE_D1_DATABASE_ID must be a D1 UUID" >&2
  exit 2
fi
if [[ ! -f "$TEMPLATE" ]]; then
  printf '%s\n' "Wrangler template not found: $TEMPLATE" >&2
  exit 2
fi

mkdir -p "$(dirname -- "$OUTPUT")"
sed \
  -e "s#^main = \"src/worker.ts\"#main = \"$PROJECT_DIR/src/worker.ts\"#" \
  -e "s/REPLACE_WITH_D1_DATABASE_ID/$D1_DATABASE_ID/g" \
  "$TEMPLATE" > "$OUTPUT"
chmod 600 "$OUTPUT"
