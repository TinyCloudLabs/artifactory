# Distillery agent backend

A small HTTP server that holds a stable agent key (→ `did:pkh`), accepts a
user's TinyCloud **delegation**, and runs the artifact pipeline **under that
delegation** — publishing distilled artifacts to the **user's own**
`xyz.tinycloud.artifacts` space. The feed front end delegates the user's
Listen-read + artifacts-read/write scopes to this agent's DID, then hits
`/agent/run` to generate.

MVP: runs locally (`bun`). Phala/TEE deploy is phase 2 (Listen's
`agent-runtime` Docker is the deploy precedent).

## API contract

```
GET  /agent/info             → { did, name, permissions: PermissionEntry[] }
POST /agent/delegation       { serialized } → { ok, agentDid, delegationCid, spaceId, expiresAt }
POST /agent/run              {} (uses the stored delegation) → { run_id, status:"queued" }
GET  /agent/run/:run_id      → { run_id, status:"queued"|"running"|"done"|"error", published?:[{type,slug}], error? }
```

`permissions` advertises the scopes the user must delegate: Listen-read on
`xyz.tinycloud.listen` (SQL `conversations` read + KV `transcript` get/list) and
read/write on `xyz.tinycloud.artifacts` (SQL feed + KV media). The front end
splices these into the OpenKey manifest so they're covered in the signed recap.

## Run

```sh
bun harness/agent/src/server.ts
```

Env (all optional):

| var | default | meaning |
|---|---|---|
| `AGENT_PORT` | `4097` | listen port |
| `AGENT_HOST_BIND` | `127.0.0.1` | bind address (loopback; a tunnel/front end connects via localhost) |
| `TINYCLOUD_HOST` | `https://node.tinycloud.xyz` | node the agent signs into + the delegation targets |
| `AGENT_STATE_DIR` | `<repo>/harness/agent/.agent-state` | all runtime state (gitignored) |
| `AGENT_TC_PROFILE` | `delegated` | sandbox tc profile the delegation activates |
| `AGENT_NAME` | `Distillery Agent` | advertised in `/agent/info` |
| `AGENT_TRANSCRIPT_COUNT` | `5` | Listen transcripts pulled per run |
| `AGENT_GEN_MODEL` | `opus` | model for the headless `claude -p` generate step |
| `NODE_SDK_DIST` | (built js-sdk checkout) | override the `@tinycloud/node-sdk` dist path |

The generate step spawns `claude -p`, so `claude` must be on PATH (and logged
in). An optional Gemini key (`GOOGLE_AI_API_KEY` / `GEMINI_API_KEY` /
`GOOGLE_API_KEY`) lets the article get an illustrated hero; without one the
generation agent uses a local image.

## How the delegation threads into the skills (no skill changes)

The existing pipeline skills (`tc-listen-read`, `tc-publish`) already accept
`--space` and run `tc` through `skills/_shared/lib/tc.ts` (which forwards spawn
env). The tc CLI's config dir is `os.homedir()/.tinycloud` with no env override
— but `os.homedir()` honors `$HOME`. So:

1. `POST /agent/delegation` → `node.useDelegation(serialized)` mints a delegated
   session; `access.restorable` is projected into a **sandboxed** tc profile at
   `<AGENT_STATE_DIR>/tc-home/.tinycloud/profiles/<profile>/` (the Listen
   sidecar's profile-writer pattern: `profile.json` + `key.json` +
   `session.json`, `authMethod:"openkey"` so the CLI restores from
   `session.json` alone — no agent key on disk in the sandbox).
2. `POST /agent/run` runs each tc-backed stage with `env HOME=<sandbox>` +
   `--space <delegation.spaceId>`. The sandbox's default profile IS the
   delegated profile, so `tc` operates **as the delegator on the delegator's
   space** — never an owner/cli-test key (hard rule). The user's real
   `~/.tinycloud` is never touched.
3. The **generate** stage (`claude -p`) runs with the **real** `$HOME` (claude's
   credentials live in `~/.claude`) and writes artifact files locally — it
   touches no `tc` and no delegation. Only the tc-backed stages get the sandbox
   HOME.

## The pipeline (`POST /agent/run`)

`bootstrap → listen-read → generate → critic → publish`, all under the
delegation, into a per-run scratch dir (`<AGENT_STATE_DIR>/runs/<id>/`):

1. **bootstrap** — `tc-publish/bootstrap-schema.ts` ensures the user's three
   artifact DBs (idempotent; the node's rejection of `CREATE INDEX` is expected).
2. **listen-read** — `tc-listen-read/listen-read.ts` pulls the user's Listen
   transcripts into the run's corpus. **Empty-Listen-safe:** 0 transcripts →
   the run completes with 0 artifacts (valid), skipping generate + publish.
3. **generate** — headless `claude -p` distills one tweet (banger-extractor) and
   one article (write-article + hero) into the run's artifacts dir, with an
   adversarial critic + verify-quotes gate (no human approval, per §9).
4. **publish** — `tc-publish/publish.ts` upserts each survivor to the user's
   `xyz.tinycloud.artifacts` (KV media + SQL feed row, `approval_status='approved'`).

The Smithers form of this flow is authored at
`.smithers/workflows/agent-run.tsx` (phase-2 target). It is **not yet runnable**
via `smithers up` on this branch: the local `.smithers` orchestrator pins
`smithers-orchestrator ^0.20.4` while the global CLI is `0.22.0` (a React-version
skew that blocks `graph`/`run`). Until the versions align, `/agent/run` runs the
same stages directly (`runner.ts`).

## Runtime state (gitignored: `/harness/agent/.agent-state/`)

```
agent-key.json              the stable agent wallet key → did:pkh
delegation.json             the last-POSTed serialized delegation (restored on restart)
runs/<run_id>/status.json   per-run state for GET /agent/run/:id
runs/<run_id>/{corpus,artifacts}/   per-run scratch
tc-home/.tinycloud/...      the sandboxed delegated tc profile
```
