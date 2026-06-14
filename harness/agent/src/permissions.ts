// permissions.ts — the scopes the user must delegate to the agent (server-info
// shape, so the front end can splice them into the OpenKey manifest before
// sign-in). Mirrors Listen's AGENT_PERMISSIONS but scoped to the two app spaces
// this agent needs: Listen-read (in) + artifacts read/write (out).
//
// This is BOTH what /agent/info advertises AND the upper bound the delegation
// validator enforces (a grant may not exceed these). Defined in its own module
// so the validator can import it without pulling in the HTTP server.

import type { PermissionEntry } from "@tinycloud/node-sdk";

export const PERMISSIONS: readonly PermissionEntry[] = [
  {
    service: "tinycloud.sql",
    path: "xyz.tinycloud.listen/conversations",
    actions: ["read"],
    description: "Read your Listen conversations to distill them into artifacts.",
  },
  {
    service: "tinycloud.kv",
    path: "xyz.tinycloud.listen/",
    actions: ["get", "list", "metadata"],
    description: "Read your Listen transcripts to distill them into artifacts.",
  },
  {
    service: "tinycloud.sql",
    path: "xyz.tinycloud.artifacts/",
    actions: ["read", "write"],
    description: "Publish distilled artifacts to your feed.",
  },
  {
    service: "tinycloud.kv",
    path: "xyz.tinycloud.artifacts/",
    actions: ["get", "put", "list", "metadata"],
    description: "Publish artifact media (hero images, audio) to your space.",
  },
];
