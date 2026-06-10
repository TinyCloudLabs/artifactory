#!/usr/bin/env bun
// illustrate.ts — generate a hero illustration for a saved artifact and
// wire it into artifact.json (hero_image + quality.notes).
//
// Usage:
//   bun skills/illustrate-card/scripts/illustrate.ts \
//     --artifact-dir <dir> (--prompt "..." | --prompt-file file.txt) \
//     [--aspect 16:9] [--note "..."] [--skip-existing]
//
//   bun skills/illustrate-card/scripts/illustrate.ts \
//     --artifact-dir <dir> --annotate "quality-loop outcome text"
//
// Deterministic plumbing only: the agent reading SKILL.md crafts the
// prompt and judges the generated image; this script validates the
// artifact, calls the image model, writes hero.<ext> alongside
// artifact.json, and updates hero_image + quality.notes. --annotate
// appends a quality note without generating (used to record the final
// quality-loop verdict). Exits non-zero on any failure.

import { readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { validateArtifact, type Artifact } from "../../_shared/lib/artifact.ts";
import {
  generateImage,
  type GenerateImageOptions,
  type GeneratedImage,
} from "../../_shared/lib/gemini.ts";

export const IMAGE_MODEL_NOTE = "gemini-2.5-flash-image";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export class UsageError extends Error {}

export interface IllustrateArgs {
  artifactDir: string;
  prompt?: string;
  promptFile?: string;
  annotate?: string;
  aspectRatio: string;
  note?: string;
  skipExisting: boolean;
}

export function parseArgs(argv: string[]): IllustrateArgs {
  let artifactDir: string | undefined;
  let prompt: string | undefined;
  let promptFile: string | undefined;
  let annotate: string | undefined;
  let aspectRatio = "16:9";
  let note: string | undefined;
  let skipExisting = false;

  const value = (flag: string, v: string | undefined): string => {
    if (v === undefined || v.startsWith("--")) {
      throw new UsageError(`${flag} requires a value`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--artifact-dir":
        artifactDir = value(arg, argv[++i]);
        break;
      case "--prompt":
        prompt = value(arg, argv[++i]);
        break;
      case "--prompt-file":
        promptFile = value(arg, argv[++i]);
        break;
      case "--annotate":
        annotate = value(arg, argv[++i]);
        break;
      case "--aspect":
        aspectRatio = value(arg, argv[++i]);
        break;
      case "--note":
        note = value(arg, argv[++i]);
        break;
      case "--skip-existing":
        skipExisting = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  if (!artifactDir) throw new UsageError("--artifact-dir is required");
  const modes = [prompt, promptFile, annotate].filter((m) => m !== undefined);
  if (modes.length !== 1) {
    throw new UsageError(
      "exactly one of --prompt, --prompt-file, or --annotate is required",
    );
  }
  if (annotate !== undefined && (note !== undefined || skipExisting)) {
    throw new UsageError("--note/--skip-existing only apply when generating");
  }

  return { artifactDir, prompt, promptFile, annotate, aspectRatio, note, skipExisting };
}

/** Injection point for tests: same shape as the shared generateImage. */
export type ImageProvider = (
  opts: GenerateImageOptions,
) => Promise<GeneratedImage>;

export interface IllustrateResult {
  status: "generated" | "skipped" | "annotated";
  jsonPath: string;
  /** Absolute path of the written hero file (status "generated" only). */
  heroPath?: string;
}

function appendNote(existing: string | undefined, note: string): string {
  const tagged = `[illustrate-card] ${note}`;
  return existing?.trim() ? `${existing.trim()} | ${tagged}` : tagged;
}

async function loadArtifact(jsonPath: string): Promise<Artifact> {
  let raw: string;
  try {
    raw = await readFile(jsonPath, "utf8");
  } catch {
    throw new Error(`no artifact.json found at ${jsonPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`artifact.json is not valid JSON: ${(e as Error).message}`);
  }
  const result = validateArtifact(parsed);
  if (!result.ok) {
    throw new Error(
      `artifact.json fails the contract:\n  - ${result.errors.join("\n  - ")}`,
    );
  }
  return result.artifact;
}

async function persistArtifact(jsonPath: string, artifact: Artifact): Promise<void> {
  const result = validateArtifact(artifact);
  if (!result.ok) {
    throw new Error(
      `refusing to write contract-invalid artifact:\n  - ${result.errors.join("\n  - ")}`,
    );
  }
  await writeFile(jsonPath, JSON.stringify(artifact, null, 2) + "\n");
}

export async function illustrate(
  args: IllustrateArgs,
  provider: ImageProvider = generateImage,
): Promise<IllustrateResult> {
  const jsonPath = join(args.artifactDir, "artifact.json");
  const artifact = await loadArtifact(jsonPath);

  if (args.annotate !== undefined) {
    artifact.quality.notes = appendNote(artifact.quality.notes, args.annotate);
    await persistArtifact(jsonPath, artifact);
    return { status: "annotated", jsonPath };
  }

  if (
    args.skipExisting &&
    artifact.hero_image &&
    existsSync(join(args.artifactDir, artifact.hero_image))
  ) {
    return { status: "skipped", jsonPath };
  }

  let prompt = args.prompt;
  if (args.promptFile !== undefined) {
    try {
      prompt = (await readFile(args.promptFile, "utf8")).trim();
    } catch {
      throw new Error(`could not read prompt file: ${args.promptFile}`);
    }
  }
  if (!prompt?.trim()) throw new Error("prompt is empty");
  prompt = prompt.trim();

  const image = await provider({ prompt, aspectRatio: args.aspectRatio });
  const ext = MIME_EXT[image.mimeType] ?? "png";
  const heroName = `hero.${ext}`;
  const heroPath = join(args.artifactDir, heroName);
  await writeFile(heroPath, image.bytes);

  // A regeneration can change the extension (png → jpg); drop the stale file.
  const previous = artifact.hero_image;
  if (previous && previous !== heroName) {
    await unlink(join(args.artifactDir, previous)).catch(() => {});
  }

  artifact.hero_image = heroName;
  artifact.quality.notes = appendNote(
    artifact.quality.notes,
    args.note ?? `hero image generated (${IMAGE_MODEL_NOTE})`,
  );
  await persistArtifact(jsonPath, artifact);
  return { status: "generated", jsonPath, heroPath };
}

const USAGE = `usage: bun skills/illustrate-card/scripts/illustrate.ts
  --artifact-dir <dir> (--prompt "..." | --prompt-file file.txt)
  [--aspect 16:9] [--note "..."] [--skip-existing]
or, to record a quality note without generating:
  --artifact-dir <dir> --annotate "..."`;

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await illustrate(args);
    switch (result.status) {
      case "generated":
        console.log(`Wrote ${result.heroPath}`);
        console.log(`Updated ${result.jsonPath} (hero_image + quality.notes)`);
        break;
      case "skipped":
        console.log(
          `Skipped: hero image already exists for ${result.jsonPath} (--skip-existing)`,
        );
        break;
      case "annotated":
        console.log(`Updated quality.notes in ${result.jsonPath}`);
        break;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(USAGE);
      console.error(`error: ${e.message}`);
      process.exit(2);
    }
    console.error(`illustrate-card: ${(e as Error).message}`);
    process.exit(1);
  }
}
