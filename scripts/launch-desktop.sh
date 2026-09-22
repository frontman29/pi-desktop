#!/usr/bin/env bash
# Launcher for the application drawer.
#
# Runs the already-built app. It does not rebuild on every start, so launching
# stays fast; run `npm run build` after changing the app itself, and
# `node scripts/run.mjs build` in the Hexmorph project after changing the
# workspace extension.
set -euo pipefail

APP_DIR="${PI_DESKTOP_DIR:-/home/rob/Documents/pi-desktop}"
cd "$APP_DIR"

if [[ ! -d out/main ]]; then
  # First run after a fresh clone: build once rather than failing silently.
  npm run build
fi

# --no-sandbox matches the project's own `npm run dev`, which needs it on this
# system's Electron build.
exec npx electron out/main/index.js --no-sandbox "$@"
