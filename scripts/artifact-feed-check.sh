#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/artifact-lib.sh"

ensure_bun
ensure_feed_deps "$ROOT"
check_feed_submodule_drift "$ROOT"

(cd "$ROOT" && bun test tests/render-type.test.ts)
(cd "$ROOT/submodules/feed" && bun run typecheck)
(cd "$ROOT/submodules/feed" && bun run build)
