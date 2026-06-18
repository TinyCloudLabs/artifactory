#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/artifact-lib.sh"

ensure_bun
ensure_root_deps "$ROOT"

# Development-only bridge while Gemini credentials still live outside TinyCloud
# secrets. This sources the file silently and never prints key values.
load_dev_env() {
  local candidates=()
  if [ -n "${DEV_DISTILLERY_ENV:-}" ]; then
    candidates+=("$DEV_DISTILLERY_ENV")
  fi
  candidates+=(
    "$HOME/development.nosync/distillery/.env"
    "$HOME/Development.nosync/distillery/.env"
  )

  local env_file
  for env_file in "${candidates[@]}"; do
    if [ -f "$env_file" ]; then
      set -a
      # shellcheck disable=SC1090
      source "$env_file"
      set +a
      return 0
    fi
  done
}

load_dev_env || true

export DISTILLERY_REPO_ROOT="${DISTILLERY_REPO_ROOT:-$ROOT}"
export AGENT_PORT="${AGENT_PORT:-${PORT:-4097}}"
export AGENT_API_TOKEN="${AGENT_API_TOKEN:-local-claude-dev}"
export AGENT_ALLOWED_ORIGIN="${AGENT_ALLOWED_ORIGIN:-https://feed.localhost:1355,https://feed.localhost}"
export AGENT_NAME="${AGENT_NAME:-Local Claude Distillery Agent}"

cd "$ROOT"
exec bun harness/agent/src/server.ts "$@"
