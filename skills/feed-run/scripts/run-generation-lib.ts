// run-generation-lib.ts — the testable plumbing for the headless generation
// runner (spec §7/§8 — the piece that turns a run-brief into artifacts by
// invoking a generation AGENT HEADLESSLY).
//
// THE BOUNDARY (base SPEC + corpus-nav SPEC, non-negotiable): the index / query
// / feed-run SCRIPTS make NO model calls — they surface, the agent judges. This
// runner is the ORCHESTRATION layer that sits ABOVE that boundary: it is
// explicitly allowed to invoke the agent CLI (`claude -p`, the
// reference_claude_cli_headless recipe). It does not itself reason about
// transcripts; it spawns an agent that does. Everything reasoning-shaped stays
// inside the agent's run; everything here is deterministic plumbing:
//   - building the correct `claude -p` argv + system prompt,
//   - diffing artifacts/ before vs after to learn what the agent created,
//   - parsing a structured summary out of that diff.
//
// All of THIS file is pure + side-effect-free at import time, so the tests can
// assert the invocation shape WITHOUT ever calling claude or generating.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactType } from "../../_shared/lib/artifact.ts";
import { ARTIFACT_TYPES } from "../../_shared/lib/artifact.ts";

// ---------------------------------------------------------------------------
// Defaults + config
// ---------------------------------------------------------------------------

/**
 * Default model for the headless generation agent. Hunter's best-model default
 * (per feedback_best_available_model): generation quality matters, so `opus`.
 * Overridable via $MEET_GEN_MODEL or the --model flag.
 */
export const DEFAULT_GEN_MODEL = "opus";

/** The env var that overrides the default model (a --model flag wins over it). */
export const GEN_MODEL_ENV = "MEET_GEN_MODEL";

/**
 * Resolve the generation model: an explicit flag wins, else $MEET_GEN_MODEL,
 * else the `opus` default. Pure — `env` is injected so tests don't touch
 * process.env.
 */
export function resolveModel(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): string {
  if (flag && flag.trim()) return flag.trim();
  const fromEnv = env[GEN_MODEL_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return DEFAULT_GEN_MODEL;
}

// ---------------------------------------------------------------------------
// The claude -p invocation
// ---------------------------------------------------------------------------

export interface GenInvocationInput {
  /** Absolute (or repo-relative) path to the run-brief markdown the agent reads. */
  briefPath: string;
  /** Repo root the agent runs the skills from (cwd for the spawn). */
  repoRoot: string;
  /** Where survivors are saved + what the diff watches. */
  artifactsDir: string;
  /** Hard cap on artifacts this run may publish (MAX_ARTIFACTS_PER_RUN). */
  cap: number;
  /** Resolved model id (opus by default). */
  model: string;
  /** The run id (for log + provenance), ISO-ish. */
  runId: string;
}

/**
 * The headless system prompt (the reference_claude_cli_headless recipe REQUIRES
 * `--system-prompt` to fully override the default so the run is clean — no
 * SessionStart hook / skill chatter polluting the agent's work). This is the
 * agent's marching orders: consume the brief, run the artifact skills, apply the
 * adversarial novelty critic, respect the cap, save + append the ledger.
 *
 * Pure string builder so a test can assert its shape without spawning anything.
 */
export function buildSystemPrompt(input: GenInvocationInput): string {
  return [
    "You are the distillery feed-run GENERATION agent, invoked headlessly.",
    "You produce feed artifacts from meeting transcripts. Judgment is yours;",
    "the orchestrator already did the deterministic plumbing (index → distill →",
    "query → brief). Generation quality is the whole point — be ruthless.",
    "",
    "RUN CONTEXT (paths are authoritative; do not invent others):",
    `- run-brief:    ${input.briefPath}`,
    `- repo root:    ${input.repoRoot}`,
    `- artifacts to: ${input.artifactsDir}`,
    `- run id:       ${input.runId}`,
    `- MAX_ARTIFACTS_PER_RUN (hard cap): ${input.cap}`,
    "",
    "DO, in order:",
    "1. Read the run-brief at the path above. It lists the selected transcripts",
    "   (recency window + one rotating deep-dive) with titles, paths, source,",
    "   match-context snippets, the preferences panel, and the prior-artifact",
    "   baseline. It tells you WHERE to look; you do the looking.",
    "2. Read the ACTUAL transcript files at the paths in the brief (the brief",
    "   surfaced paths only — never bodies).",
    "3. For each transcript, run the artifact skills appropriate to the material:",
    "   extract-insights (insight cards), write-article (longform), make-podcast",
    "   (micro-podcasts). Pick the format the material earns; not every",
    "   transcript yields an artifact.",
    "4. Run each skill's baked-in novelty-scan + the MANDATORY adversarial",
    "   novelty critic. Kill anything that re-angles a prior artifact or clears",
    "   no novelty bar. ZERO artifacts is a valid, good run — quality beats",
    "   quantity.",
    `5. Publish at most ${input.cap} survivors with save.ts (auto-publish straight`,
    `   to ${input.artifactsDir}). One hero image per artifact at most.`,
    "6. After saving, append each EXAMINED transcript (shipped or not) to the",
    "   surfaced ledger (index/surfaced.json) per skills/feed-run/SKILL.md —",
    "   path, topic_keys, outcome (shipped|examined-no-ship), mode. Do NOT touch",
    "   the deep-dive cursor; the orchestrator already advanced + persisted it.",
    "",
    "CONSTRAINTS:",
    "- Honor the preferences panel in the brief (topics, novelty bar, formats).",
    `- NEVER exceed the cap of ${input.cap} published artifacts.`,
    "- Anchor every claim to a verbatim transcript quote (verify quotes).",
    "- Stay inside the repo; write artifacts only under the artifacts dir above.",
    "",
    "When you are finished, print a final one-line summary of what you shipped",
    "and what you killed, then stop.",
  ].join("\n");
}

/** The user message that kicks the headless run (short — the system prompt carries the detail). */
export function buildUserMessage(input: GenInvocationInput): string {
  return (
    `Run the distillery feed-run GENERATION step for run ${input.runId}. ` +
    `Read the run-brief at ${input.briefPath} and execute its generation: read ` +
    `the selected transcripts, run the artifact skills with the adversarial ` +
    `novelty critic, publish the best ≤${input.cap} survivors to ` +
    `${input.artifactsDir}, then append the surfaced ledger per ` +
    `skills/feed-run/SKILL.md. Do not advance the deep-dive cursor.`
  );
}

/**
 * Build the full `claude -p` argv (the reference_claude_cli_headless recipe).
 * Returns `{ cmd, args }` so a test asserts the argv shape WITHOUT spawning.
 * Shape: `claude -p "<user msg>" --system-prompt "<full override>" --model <m>`.
 * `--system-prompt` (not `--append-system-prompt`) so the run is clean.
 */
export function buildClaudeInvocation(input: GenInvocationInput): {
  cmd: string;
  args: string[];
} {
  return {
    cmd: "claude",
    args: [
      "-p",
      buildUserMessage(input),
      "--system-prompt",
      buildSystemPrompt(input),
      "--model",
      input.model,
    ],
  };
}

// ---------------------------------------------------------------------------
// Artifact before/after diff
// ---------------------------------------------------------------------------

/** A single artifact folder discovered under artifacts/<type>/<slug>/. */
export interface ArtifactRef {
  type: ArtifactType;
  slug: string;
  /** `<type>/<slug>` — the stable key used for the before/after diff. */
  key: string;
  /** Absolute path to the artifact's folder. */
  dir: string;
}

/**
 * Scan artifacts/ into the set of `<type>/<slug>` folders that contain an
 * artifact.json. Never throws (a missing artifacts dir → empty set), matching
 * the never-throw stance of priorArtifactIndex / readIndex. Pure-ish: only
 * reads the filesystem, no model calls.
 */
export async function scanArtifacts(artifactsDir: string): Promise<ArtifactRef[]> {
  const refs: ArtifactRef[] = [];
  for (const type of ARTIFACT_TYPES) {
    const typeDir = join(artifactsDir, type);
    let slugs: string[];
    try {
      slugs = (await readdir(typeDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue; // type dir absent → no artifacts of this type
    }
    for (const slug of slugs) {
      const dir = join(typeDir, slug);
      // Only count folders that actually hold an artifact.json (a half-written
      // or stray dir is not a published artifact).
      try {
        await readFile(join(dir, "artifact.json"), "utf8");
      } catch {
        continue;
      }
      refs.push({ type, slug, key: `${type}/${slug}`, dir });
    }
  }
  return refs;
}

export interface CreatedArtifact {
  type: ArtifactType;
  slug: string;
  /**
   * The novelty score the agent recorded on the artifact, if any. Read from the
   * artifact.json's quality.notes / a `novelty` field when present — best-effort
   * provenance, never load-bearing.
   */
  novelty?: number | string;
}

/**
 * Diff a before-set against an after-set of artifact refs: which keys are NEW
 * (created this run). Pure — operates on the two scanned lists. Returns the
 * after-refs whose key was not in `before`.
 */
export function diffCreated(before: ArtifactRef[], after: ArtifactRef[]): ArtifactRef[] {
  const beforeKeys = new Set(before.map((r) => r.key));
  return after.filter((r) => !beforeKeys.has(r.key));
}

/**
 * Read a best-effort novelty value off an artifact.json. Looks for a top-level
 * `novelty` field, else a `quality.notes` string. Never throws (missing/garbage
 * → undefined). Provenance only — the summary tolerates its absence.
 */
export async function readNovelty(artifactDir: string): Promise<number | string | undefined> {
  try {
    const raw = await readFile(join(artifactDir, "artifact.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.novelty === "number" || typeof parsed.novelty === "string") {
      return parsed.novelty as number | string;
    }
    const q = parsed.quality as Record<string, unknown> | undefined;
    if (q && typeof q.novelty === "number") return q.novelty;
    if (q && typeof q.notes === "string" && q.notes.trim()) return q.notes;
  } catch {
    // no readable novelty — fine
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The structured run summary
// ---------------------------------------------------------------------------

export interface GenerationSummary {
  /** Artifacts created this run (from the before/after diff). */
  created: CreatedArtifact[];
  /**
   * Artifacts the agent reported KILLING (clearing no novelty bar). Best-effort:
   * parsed from the agent's stdout summary line; absent → empty.
   */
  killed: KilledArtifact[];
  /** Wall-clock duration of the headless run, in ms. */
  duration: number;
  /** The exit status of the `claude -p` spawn (0 = clean). */
  exit_code: number;
}

export interface KilledArtifact {
  /** A short label the agent used for the killed candidate (slug-ish). */
  label: string;
  /** Why it was killed, if the agent said. */
  reason?: string;
}

/**
 * Parse the count/labels of KILLED candidates out of the agent's stdout. The
 * agent prints a free-form final summary; we look for a "killed" line and pull
 * `label (reason)` shaped fragments. Best-effort, never throws, never required
 * (the diff is the authoritative record of what shipped; killed is provenance).
 *
 * Recognized shapes (case-insensitive), e.g.:
 *   "killed: foo-card (re-angles prior), bar-podcast (no novelty)"
 *   "Killed 2: foo (dup), bar (thin)"
 */
export function parseKilled(stdout: string): KilledArtifact[] {
  const out: KilledArtifact[] = [];
  for (const line of stdout.split("\n")) {
    const m = /killed[^:]*:\s*(.+)$/i.exec(line.trim());
    if (!m) continue;
    const body = m[1]!.trim();
    if (!body || /^(none|0|nothing)\b/i.test(body)) return [];
    // Split on commas at top level; each fragment is `label (reason)`.
    for (const frag of body.split(",")) {
      const f = frag.trim();
      if (!f) continue;
      const lm = /^(.+?)\s*\(([^)]*)\)\s*$/.exec(f);
      if (lm) {
        out.push({ label: lm[1]!.trim(), reason: lm[2]!.trim() || undefined });
      } else {
        out.push({ label: f });
      }
    }
    // First "killed:" line wins (the agent's final summary).
    if (out.length) break;
  }
  return out;
}

/**
 * Assemble the structured generation summary from the before/after artifact
 * diff + the agent's stdout + timing. `createdRefs` is the diff result
 * (diffCreated) ALREADY enriched with novelty (the caller reads novelty off
 * disk). Pure — no I/O.
 */
export function buildSummary(args: {
  created: CreatedArtifact[];
  stdout: string;
  duration: number;
  exitCode: number;
}): GenerationSummary {
  return {
    created: args.created,
    killed: parseKilled(args.stdout),
    duration: args.duration,
    exit_code: args.exitCode,
  };
}

/** A one-line human summary of a generation run (mirrors summarizeRun's style). */
export function summarizeGeneration(s: GenerationSummary): string {
  const created = s.created.map((c) => `${c.type}/${c.slug}`).join(", ") || "none";
  return (
    `generation: created=${s.created.length} [${created}] ` +
    `killed=${s.killed.length} ` +
    `duration=${Math.round(s.duration)}ms exit=${s.exit_code}`
  );
}
