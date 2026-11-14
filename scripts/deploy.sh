#!/usr/bin/env bash
# Deploy exactly what is committed at HEAD - never the working tree - to Cloudflare.
#   ./scripts/deploy.sh
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
if ! git -C "$ROOT" diff --quiet HEAD -- web engine/rules; then
  echo "note: uncommitted changes under web/ or engine/rules are NOT deployed" >&2
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git -C "$ROOT" archive HEAD | tar -x -C "$TMP"
cd "$TMP/web"
npm ci --no-fund --no-audit
npm run build
npx --yes wrangler@4 deploy
echo "deployed $(git -C "$ROOT" rev-parse --short HEAD): $(git -C "$ROOT" log -1 --format=%s)"
