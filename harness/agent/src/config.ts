// config.ts — resolve the agent backend's runtime paths + tunables from env,
// anchored to the distillery REPO ROOT (this file is harness/agent/src/, so the
// repo root is three levels up — same convention as harness/feed/src/server.ts).
//
// All agent state lives under a SINGLE dir (AGENT_STATE_DIR, default
// <home>/.tinycloud-agent — OUTSIDE the repo on purpose):
//   agent-key.json            — the stable agent wallet key → did:pkh
//   delegation.json           — the last-POSTed serialized PortableDelegation
//   api-token                 — the per-install API bearer token
//   runs/<run_id>/status.json — per-run state for GET /agent/run/:id
//   tc-home/.tinycloud/...    — the sandboxed tc profile the delegation activates
//                               (HOME for every skill spawn; never the user's ~)
//
// WHY OUTSIDE THE REPO: the generate `claude -p` step is --add-dir'd onto the
// run's corpus/artifacts scratch (which live under AGENT_STATE_DIR). If the state
// dir were inside repoRoot, a prompt-injected transcript could Read the agent key
// / token / delegation via the allowed Read tool. Keeping the whole state tree
// out of the repo (and never --add-dir'ing its root) puts those credentials
// beyond the generate child's reach. See runner.ts buildGenerationArgs.

import { resolve } from "node:path";
import { homedir } from "node:os";

const repoRoot = process.env.DISTILLERY_REPO_ROOT
  ? resolve(process.env.DISTILLERY_REPO_ROOT)
  : resolve(import.meta.dir, "..", "..", "..");

const agentStateDir = process.env.AGENT_STATE_DIR
  ? resolve(process.env.AGENT_STATE_DIR)
  : resolve(homedir(), ".tinycloud-agent");

export const config = {
  /** The distillery checkout the skills run from (cwd of every skill spawn). */
  repoRoot,
  /** Root of all agent runtime state (gitignored). */
  agentStateDir,
  /** The stable agent wallet key file. */
  agentKeyPath: resolve(agentStateDir, "agent-key.json"),
  /** The last-granted serialized delegation (for restart restore). */
  delegationPath: resolve(agentStateDir, "delegation.json"),
  /** The per-install API bearer token (generated + persisted if unset). */
  apiTokenPath: resolve(agentStateDir, "api-token"),
  /** Per-run status dir root. */
  runsDir: resolve(agentStateDir, "runs"),
  /** Sandbox HOME for skill spawns — tc reads <home>/.tinycloud. */
  tcHome: resolve(agentStateDir, "tc-home"),
  /** The tc profile name the delegation activates inside the sandbox. */
  profileName: process.env.AGENT_TC_PROFILE ?? "delegated",

  /** TinyCloud node the agent signs into + the delegation targets. */
  host: process.env.TINYCLOUD_HOST ?? "https://node.tinycloud.xyz",
  port: Number(process.env.AGENT_PORT ?? 4097),
  /** Loopback by default (a tunnel/front end connects via localhost). */
  hostname: process.env.AGENT_HOST_BIND ?? "127.0.0.1",
  name: process.env.AGENT_NAME ?? "Distillery Agent",
  /** The single trusted browser origin allowed by CORS (no wildcard). When
   *  unset, NO cross-origin request is reflected (same-origin / curl only). */
  allowedOrigin: process.env.AGENT_ALLOWED_ORIGIN?.trim() || null,
  /** Per-install API bearer token. If set via env it wins; otherwise the
   *  server generates one on first boot, persists it (0600), and logs it once. */
  apiToken: process.env.AGENT_API_TOKEN?.trim() || null,
  /** Cap on the serialized-delegation payload the server will deserialize. */
  maxDelegationBytes: Number(process.env.AGENT_MAX_DELEGATION_BYTES ?? 256 * 1024),
  /** The EVM chain the agent operates on; a delegation must match it. */
  chainId: Number(process.env.AGENT_CHAIN_ID ?? 1),
  /** Advertised delegation lifetime (informational, for GET /agent/info). */
  delegationExpiry: process.env.AGENT_DELEGATION_EXPIRY ?? "7d",
  /** How many Listen transcripts a run pulls. */
  transcriptCount: Number(process.env.AGENT_TRANSCRIPT_COUNT ?? 5),
  /** Generation model for the headless `claude -p` step. */
  genModel: process.env.AGENT_GEN_MODEL ?? "opus",
} as const;
