// delegation-validator.ts — gate an incoming PortableDelegation BEFORE the agent
// activates it (node.useDelegation) or persists it to disk. useDelegation in
// wallet mode does NOT check the audience or scopes itself, so a forged/over-
// broad delegation would otherwise be accepted silently and run under. This is
// the agent's trust boundary: every check here must pass or we throw (the server
// maps the throw to HTTP 400 with the message).
//
// Checks (all must hold):
//   1. chainId is the agent's expected numeric chain.
//   2. expiry is a real future Date.
//   3. spaceId is a well-formed tinycloud:pkh space URI.
//   4. restorable.spaceId === delegation.spaceId (the activated session targets
//      the same space the delegation claims).
//   5. the delegate/audience DID === THIS agent's did:pkh (no foreign audience).
//   6. the delegation's granted resources are a SUBSET of the agent's advertised
//      PERMISSIONS (no scope escalation beyond what /agent/info promised).
//
// The serialized-payload size cap is enforced in session.activate (before
// deserialize), since it bounds the parse, not the parsed object.

import type { PortableDelegation, PermissionEntry } from "@tinycloud/node-sdk";
import type { RestorableSession } from "./profile-writer.ts";

// The bare `@tinycloud/node-sdk` specifier resolves to the package's .d.ts at
// runtime (its dist has no package "main"), so VALUE helpers must come through
// the same dynamic resolver the rest of the backend uses — never a static
// value import. The caller injects them (it already has the loaded sdk module).
export interface CapabilityHelpers {
  isCapabilitySubset: (
    requested: readonly PermissionEntry[],
    granted: readonly PermissionEntry[],
  ) => { subset: boolean; missing: PermissionEntry[] };
  principalDidEquals: (a: string, b: string) => boolean;
}

/** What the validator compares the delegation against. */
export interface ValidationContext {
  /** The agent's stable did:pkh (the only allowed audience). */
  agentDid: string;
  /** The chain the agent operates on; the delegation must match. */
  expectedChainId: number;
  /** The agent's advertised scopes (the upper bound on what may be granted). */
  permissions: readonly PermissionEntry[];
  /** The session minted by useDelegation — must agree on spaceId. */
  restorable: RestorableSession;
  /** SDK capability helpers (injected — see CapabilityHelpers above). */
  helpers: CapabilityHelpers;
}

/** Short tc service names → the long-form the manifest/subset check expects. */
const SERVICE_SHORT_TO_LONG: Readonly<Record<string, string>> = {
  kv: "tinycloud.kv",
  sql: "tinycloud.sql",
  duckdb: "tinycloud.duckdb",
  capabilities: "tinycloud.capabilities",
  hooks: "tinycloud.hooks",
  encryption: "tinycloud.encryption",
};

/** A tinycloud:pkh:eip155:<chain>:<addr>:<name> space URI (the only shape we grant on). */
const SPACE_URI_RE = /^tinycloud:pkh:eip155:\d+:0x[0-9a-fA-F]{40}:.+$/;

/** Trailing space-name segment of a full space URI; short names pass through. */
function spaceName(space: string): string {
  if (!space.startsWith("tinycloud:")) return space;
  const lastColon = space.lastIndexOf(":");
  return lastColon === -1 || lastColon === space.length - 1
    ? space
    : space.slice(lastColon + 1);
}

/**
 * Throw with a client-facing message on any failure; return normally when the
 * delegation is safe to activate + persist. The server treats a throw as 400.
 */
export function validateDelegation(
  delegation: PortableDelegation,
  ctx: ValidationContext,
): void {
  // 1. chainId — numeric + the agent's expected chain.
  if (typeof delegation.chainId !== "number" || !Number.isFinite(delegation.chainId)) {
    throw new Error("invalid delegation: chainId is missing or non-numeric.");
  }
  if (delegation.chainId !== ctx.expectedChainId) {
    throw new Error(
      `invalid delegation: chainId ${delegation.chainId} != expected ${ctx.expectedChainId}.`,
    );
  }

  // 2. expiry — a real Date strictly in the future.
  const expiry = delegation.expiry;
  if (!(expiry instanceof Date) || Number.isNaN(expiry.getTime())) {
    throw new Error("invalid delegation: expiry is not a valid date.");
  }
  if (expiry.getTime() <= Date.now()) {
    throw new Error(`invalid delegation: already expired (${expiry.toISOString()}).`);
  }

  // 3. spaceId — well-formed pkh space URI.
  if (typeof delegation.spaceId !== "string" || !SPACE_URI_RE.test(delegation.spaceId)) {
    throw new Error(`invalid delegation: malformed spaceId '${delegation.spaceId}'.`);
  }

  // 4. restorable.spaceId agrees with the delegation's claimed space.
  if (ctx.restorable.spaceId !== delegation.spaceId) {
    throw new Error(
      `invalid delegation: activated session space '${ctx.restorable.spaceId}' ` +
        `!= delegation space '${delegation.spaceId}'.`,
    );
  }

  // 5. audience — the delegate DID must be THIS agent's did:pkh.
  if (typeof delegation.delegateDID !== "string" || delegation.delegateDID.length === 0) {
    throw new Error("invalid delegation: missing delegateDID.");
  }
  if (!ctx.helpers.principalDidEquals(delegation.delegateDID, ctx.agentDid)) {
    throw new Error(
      `invalid delegation: audience '${delegation.delegateDID}' is not this agent ` +
        `('${ctx.agentDid}').`,
    );
  }

  // 6. scope subset — the granted resources must not exceed the advertised
  //    PERMISSIONS. We need the full per-resource breakdown to know the service
  //    of each grant; a legacy single-resource delegation (no `resources[]`)
  //    can't be scope-checked, so we reject it (this agent always issues the
  //    multi-resource shape).
  const resources = delegation.resources;
  if (!Array.isArray(resources) || resources.length === 0) {
    throw new Error(
      "invalid delegation: no resources[] breakdown to scope-check (multi-resource " +
        "delegation required).",
    );
  }

  const grantSpace = spaceName(delegation.spaceId);
  const granted: PermissionEntry[] = resources.map((r) => {
    const longService = SERVICE_SHORT_TO_LONG[r.service];
    if (!longService) {
      throw new Error(`invalid delegation: unknown service '${r.service}' in a resource.`);
    }
    // Every resource must target the delegation's own space — a resource on a
    // different space is a malformed/escalating grant.
    if (spaceName(r.space) !== grantSpace) {
      throw new Error(
        `invalid delegation: resource space '${r.space}' != delegation space '${delegation.spaceId}'.`,
      );
    }
    return { service: longService, space: grantSpace, path: r.path, actions: r.actions };
  });

  // Normalize the advertised permissions to the same space so the subset check
  // compares service/path/actions (not the space label, which we've already
  // pinned to grantSpace on both sides).
  const allowed: PermissionEntry[] = ctx.permissions.map((p) => ({
    service: p.service,
    space: grantSpace,
    path: p.path,
    actions: [...p.actions],
  }));

  const { subset, missing } = ctx.helpers.isCapabilitySubset(granted, allowed);
  if (!subset) {
    const detail = missing
      .map((m) => `${m.service} ${m.path} [${m.actions.join(",")}]`)
      .join("; ");
    throw new Error(
      `invalid delegation: granted scopes exceed the agent's advertised permissions ` +
        `(escalation): ${detail}.`,
    );
  }
}
