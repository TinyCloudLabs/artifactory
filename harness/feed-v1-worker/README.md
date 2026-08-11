# Feed v1 worker

This worker claims Feed Host generation requests, reads bounded Listen source
batches through the request's live fencing identity, generates and independently
critiques one artifact, checkpoints an immutable publication manifest,
reconciles the Feed projection, and completes the request.

## Required production environment

- `FEED_HOST_URL`: Feed Host base URL.
- `FEED_ACTOR_ID`: actor whose delegated sources and Feed storage the request
  belongs to.
- `FEED_HOST_TOKEN`: bearer token matching the Host's
  `FEED_HOST_WORKER_TOKEN`.
- `FEED_WORKER_PACKAGE_VERSION`: exact reviewed worker package version.
- `FEED_WORKER_PACKAGE_DIGEST`: immutable digest for that reviewed build.
- One Claude credential inherited by the separate generator and Sonnet critic
  subprocesses:
  `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.
- One Gemini image credential from the shared secrets precedence chain:
  `GOOGLE_AI_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY`.
- `ffmpeg` on `PATH`, with WebP encoding support, for the mandatory local
  resize/compression pass. `FEED_WORKER_FFMPEG_PATH` can name an explicit
  binary. Startup runs that binary with `-version` once and fails before
  polling if it is missing or unhealthy.

`FEED_WORKER_SOURCE=host` is the default and production setting. The worker
requests at most `FEED_WORKER_SOURCE_BATCH_LIMIT` sources per claimed request
(default 5, Host maximum 10) and carries the returned cursor into completion.
Because the Host claim API is workflow-scoped, the default worker polls the
legacy extract-insights queue first and then all six reviewed starter-package
queues. Setting `FEED_WORKER_WORKFLOW_ID` to a non-default id limits a worker to
that one queue as an operational override.

Every published card has a sharp headline, a 150-300 word markdown body, an
exact verified pull quote with attribution, at least one exact verified source
quote, 2-5 tags, a passing independent critic verdict, and a bounded WebP hero.
A below-floor draft is regenerated once with critic/floor feedback. A second
rejection completes the queue request as `zero_artifacts`; provider and
subprocess transport failures retain the normal attempt retry lifecycle.
`FEED_WORKER_GENERATOR=stub` uses deterministic text, a deterministic no-spend
critic, and a tiny WebP without provider calls.

Both package provenance values are mandatory. The worker fails at startup when
either is absent rather than publishing a placeholder version or derived label.

Host follow-up for the architect: the claim endpoint should emit a Host-owned
event when it skips an already exhausted request. An empty claim response does
not expose skipped request IDs or attempt counts, so the worker cannot truthfully
produce that diagnostic. The worker does explicitly send `retryable=false` for
the final claimed attempt, which drives that request to `dead_letter` and frees
dedupe without guessing about unobserved claim candidates.

## Explicit local-source fallback

Local transcript directories are never selected merely because
`TRANSCRIPT_DIRS` exists. To opt in for development, set both:

```sh
export FEED_WORKER_SOURCE=local
export TRANSCRIPT_DIRS=/absolute/transcript-dir
```

The architect-provided local credential file can be loaded by the invoking
shell from `../../.context/feed-worker.env`; reference that path rather than
copying the file or its values into this repository.

## Transcript privacy boundary

Listen transcript bytes remain in memory. They are sent to both `claude -p`
subprocesses only on stdin, never argv. Each subprocess inherits its container
credential environment and runs with no tools, no MCP servers,
`--no-session-persistence`, and explicit network/shell/file-tool denials. Logs
and run-directory metadata contain only counts, sizes, timing, bounded typed
failure detail, artifact IDs, and publication hashes. Provider stderr, model
output excerpts, source text, and raw transcript bytes are not recorded.

## Real Host integration

After the vendored `submodules/feed` checkout is populated at the Host revision
that provides the fenced sources route, run the port-binding suite separately:

```sh
bun test harness/feed-v1-worker/real-host.integration.test.ts
```

The sandboxed root test gate excludes only this suite and the two pre-existing
tests that bind ports; all port-free Feed harness tests remain in `bun test`.
