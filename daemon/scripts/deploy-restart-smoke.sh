#!/usr/bin/env bash
set -euo pipefail

# One-command deploy + restart + smoke test for Linux hosts (Pi/server)
# Usage: ./scripts/deploy-restart-smoke.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/6] Fetch latest code"
git pull --ff-only

echo "[2/6] Install deps"
npm ci

echo "[3/6] Build daemon"
npm run build

echo "[4/6] Restart service"
if command -v pm2 >/dev/null 2>&1; then
  MB_BUILD_VERSION="$(node -p "require('./package.json').version")"
  MB_GIT_SHA="$(git rev-parse HEAD)"
  export MB_BUILD_VERSION MB_GIT_SHA NODE_ENV=production

  if pm2 describe mother-brain-daemon >/dev/null 2>&1; then
    pm2 restart mother-brain-daemon --update-env
  else
    pm2 start ecosystem.config.cjs --only mother-brain-daemon --update-env
  fi
else
  echo "pm2 not found; using background node process fallback"
  pkill -f "dist/index.js" || true
  nohup env NODE_ENV=production MB_BUILD_VERSION="$(node -p "require('./package.json').version")" MB_GIT_SHA="$(git rev-parse HEAD)" node dist/index.js > "$HOME/.mother-brain-daemon/daemon.log" 2>&1 &
fi

echo "[5/6] Process status"
if command -v pm2 >/dev/null 2>&1; then
  pm2 status mother-brain-daemon
fi

echo "[6/6] Smoke check"
if [[ -f dist/daemon-*.js ]]; then
  echo "Build artifact present: OK"
else
  echo "Expected dist artifact missing" >&2
  exit 1
fi

echo "Done. In Telegram, send /version and confirm version + commit changed."
