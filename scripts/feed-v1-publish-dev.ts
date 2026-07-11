#!/usr/bin/env bun
// Publish a legacy Artifactory artifact.json into a local new-architecture Feed Host.
//
// Usage:
//   bun scripts/feed-v1-publish-dev.ts artifacts/insight-card/foo/artifact.json \
//     --host https://feed-host.localhost:1355 [--actor did:pkh:...] [--token TOKEN] [--insecure]
//
// The Feed Host must be started with FEED_HOST_DEV_PUBLISH=1.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { validateArtifact } from "../skills/_shared/lib/artifact.ts";
import { toFeedArtifact } from "../skills/_shared/lib/feed-v1-convert.ts";

type Args = {
  artifactPath?: string;
  host: string;
  actor?: string;
  token?: string;
  insecure: boolean;
  dryRun: boolean;
};

function usage(): never {
  console.error(
    [
      "usage: bun scripts/feed-v1-publish-dev.ts <artifact.json> [--host URL] [--actor DID] [--token TOKEN] [--insecure] [--dry-run]",
      "",
      "Defaults:",
      "  --host http://127.0.0.1:8787",
      "",
      "The Feed Host must be started with FEED_HOST_DEV_PUBLISH=1.",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    host: process.env.FEED_HOST_URL || "http://127.0.0.1:8787",
    actor: process.env.FEED_ACTOR_ID || undefined,
    token: process.env.FEED_HOST_TOKEN || undefined,
    insecure: process.env.FEED_HOST_INSECURE_TLS === "1",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--host") {
      args.host = argv[++i] ?? usage();
    } else if (arg === "--actor") {
      args.actor = argv[++i] ?? usage();
    } else if (arg === "--token") {
      args.token = argv[++i] ?? usage();
    } else if (arg === "--insecure") {
      args.insecure = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg.startsWith("--")) {
      usage();
    } else if (!args.artifactPath) {
      args.artifactPath = arg;
    } else {
      usage();
    }
  }
  if (!args.artifactPath) usage();
  return args;
}

const args = parseArgs(process.argv.slice(2));
const raw = JSON.parse(await readFile(args.artifactPath!, "utf8")) as unknown;
const legacyResult = validateArtifact(raw);
if (!legacyResult.ok) {
  console.error("Legacy artifact failed validation:");
  for (const error of legacyResult.errors) console.error(`  - ${error}`);
  process.exit(1);
}

const artifact = await toFeedArtifact(legacyResult.artifact, { skill: "extract-insights" });
if (args.dryRun) {
  console.log(JSON.stringify({ artifact }, null, 2));
  process.exit(0);
}

const url = new URL("/admin/dev/publish-artifact", args.host);
const headers = new Headers({ "content-type": "application/json" });
if (args.actor) headers.set("x-feed-actor-id", args.actor);
if (args.token) headers.set("authorization", `Bearer ${args.token}`);

const response = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify({ artifact }),
  tls: args.insecure ? { rejectUnauthorized: false } : undefined,
});
const text = await response.text();
if (!response.ok) {
  console.error(`Publish failed (${response.status}) for ${basename(args.artifactPath!)}:`);
  console.error(text);
  process.exit(1);
}

console.log(text);
