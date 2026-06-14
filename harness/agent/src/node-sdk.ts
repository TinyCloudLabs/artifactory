// node-sdk.ts — resolve + re-export the @tinycloud/node-sdk handles the agent
// backend needs (useDelegation / deserializeDelegation / PrivateKeySigner /
// TinyCloudNode), mirroring how skills/_shared/lib/tc.ts resolves `tc-local`.
//
// Why a resolver and not a plain `import "@tinycloud/node-sdk"`: this distillery
// worktree's js-sdk is a submodule POINTER (unbuilt — no dist/). The BUILT
// node-sdk lives in the primary tinycloud-dev checkout that `tc-local` runs
// from. We import its dist/ directly (it has no extra install step) so the
// agent server can mint a delegated session in-process exactly like Listen's
// sidecar (useDelegation → restorable → tc profile). Override with NODE_SDK_DIST
// when the worktree's own node-sdk is built or relocated.

import { existsSync } from "node:fs";

// The built node-sdk the primary checkout's `tc-local` already uses. Same
// machine-specific anchor convention as tc.ts's DEFAULT_TC_LOCAL.
const DEFAULT_NODE_SDK_DIST =
  "/Users/samgbafa/Documents/github/tinycloud-dev/repositories/js-sdk/packages/node-sdk/dist/index.js";

function resolveNodeSdkPath(): string {
  const override = process.env.NODE_SDK_DIST?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`NODE_SDK_DIST does not exist: ${override}`);
    }
    return override;
  }
  if (existsSync(DEFAULT_NODE_SDK_DIST)) return DEFAULT_NODE_SDK_DIST;
  throw new Error(
    `@tinycloud/node-sdk dist not found at ${DEFAULT_NODE_SDK_DIST}. ` +
      `Build it (bun run --cwd packages/node-sdk build in the js-sdk checkout) ` +
      `or set NODE_SDK_DIST to a built dist/index.js.`,
  );
}

// A late, dynamic import so the resolver runs at call time (not module-eval),
// matching tc.ts's lazy `tcBin()`. The returned module is the node-sdk's full
// ESM surface; callers destructure the handles they need.
export async function loadNodeSdk(): Promise<typeof import("@tinycloud/node-sdk")> {
  const path = resolveNodeSdkPath();
  return (await import(path)) as typeof import("@tinycloud/node-sdk");
}
