// profile-writer.ts — project an activated delegation's session into a
// tc-compatible profile so the EXISTING distillery skills run under it via
// `tc --profile <name>` with HOME pointed at our sandbox. ZERO skill changes:
// the skills already accept --profile / --space and tc.ts forwards opts.env.
//
// Adapted from Listen's packages/agent-runtime/docker/profile-writer.ts. The
// shape (profile.json + key.json + session.json) is exactly what the tc CLI's
// createSDKInstance restores for an `authMethod:"openkey"` profile — it rebuilds
// the node purely from session.json's delegationHeader/delegationCid/jwk, no
// private key on disk (verified: js-sdk cli/src/lib/sdk.ts).
//
// THE SANDBOX (the load-bearing local-MVP choice): the tc CLI's config dir is
// os.homedir()/.tinycloud with NO env override — but os.homedir() honors $HOME.
// So the agent writes this profile under <agentStateDir>/tc-home/.tinycloud and
// runs every skill with env HOME=<agentStateDir>/tc-home. The user's real
// ~/.tinycloud is never touched, and no owner/cli-test key can leak in.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DelegatedAccess, PortableDelegation } from "@tinycloud/node-sdk";

/**
 * The handles needed to rehydrate a delegation activation in a fresh node via
 * restoreSession. This checkout's node-sdk exposes `access.restorable` (PR #196
 * landed), so we read it directly — no shim.
 */
export interface RestorableSession {
  delegationHeader: { Authorization: string };
  delegationCid: string;
  spaceId: string;
  jwk: object;
  verificationMethod: string;
  address: string;
  chainId: number;
}

export function extractRestorable(access: DelegatedAccess): RestorableSession {
  const r = (access as unknown as { restorable?: RestorableSession }).restorable;
  if (!r) {
    throw new Error(
      "DelegatedAccess exposes no .restorable — node-sdk version mismatch (need PR #196).",
    );
  }
  return r;
}

export interface ProfileSynthesisInput {
  /** The sandbox HOME — the profile lands under <home>/.tinycloud/profiles/<name>/. */
  home: string;
  profileName: string;
  host: string;
  /** 0x… the agent's wallet address (the delegate). */
  agentAddress: string;
  delegation: PortableDelegation;
  restorable: RestorableSession;
}

function configDir(home: string): string {
  return join(home, ".tinycloud");
}

function profileDir(home: string, name: string): string {
  return join(configDir(home), "profiles", name);
}

function loadExistingCreatedAt(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { createdAt?: string };
    return typeof parsed.createdAt === "string" ? parsed.createdAt : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, body: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/**
 * Write the full delegated profile (profile.json + key.json + session.json) and
 * point the sandbox config at it as the default profile. Runs once per grant;
 * idempotent (rewrites in place, preserving createdAt).
 */
export function writeDelegatedProfile(input: ProfileSynthesisInput): void {
  const dir = profileDir(input.home, input.profileName);
  mkdirSync(dir, { recursive: true });

  const profilePath = join(dir, "profile.json");
  const keyPath = join(dir, "key.json");

  const createdAt = loadExistingCreatedAt(profilePath) ?? new Date().toISOString();
  const agentDid = `did:pkh:eip155:${input.delegation.chainId}:${input.agentAddress}`;

  // authMethod:"openkey" → the CLI restores the session from session.json alone
  // (no privateKey field), which is what we want: the agent's wallet key never
  // lands on disk in the sandbox; only the delegated session does.
  const profile = {
    name: input.profileName,
    host: input.host,
    chainId: input.delegation.chainId,
    spaceName: input.profileName,
    did: input.restorable.verificationMethod,
    ownerDid: agentDid,
    spaceId: input.delegation.spaceId,
    createdAt,
    authMethod: "openkey" as const,
  };
  writeJsonAtomic(profilePath, profile);
  writeJsonAtomic(keyPath, input.restorable.jwk);

  writeSessionOnly(input);
  writeGlobalConfig(input.home, input.profileName);
}

/** Rewrite only session.json (runs on every refresh; profile.json/key.json are stable). */
export function writeSessionOnly(input: ProfileSynthesisInput): void {
  const dir = profileDir(input.home, input.profileName);
  mkdirSync(dir, { recursive: true });

  const ownerDid = `did:pkh:eip155:${input.delegation.chainId}:${input.delegation.ownerAddress}`;

  const session = {
    delegationHeader: input.restorable.delegationHeader,
    delegationCid: input.restorable.delegationCid,
    spaceId: input.restorable.spaceId,
    verificationMethod: input.restorable.verificationMethod,
    jwk: input.restorable.jwk,
    address: input.delegation.ownerAddress,
    chainId: input.delegation.chainId,
    ownerDid,
  };
  writeJsonAtomic(join(dir, "session.json"), session);
}

/** Move session.json aside so `tc` surfaces AUTH_REQUIRED (revoked/expired). */
export function clearSession(home: string, profileName: string): void {
  const sessionPath = join(profileDir(home, profileName), "session.json");
  if (!existsSync(sessionPath)) return;
  try {
    renameSync(sessionPath, `${sessionPath}.revoked-${Date.now()}`);
  } catch {
    // best effort
  }
}

function writeGlobalConfig(home: string, defaultProfile: string): void {
  const configPath = join(configDir(home), "config.json");
  mkdirSync(configDir(home), { recursive: true });
  // Always (re)write so the sandbox default profile tracks the active grant.
  writeJsonAtomic(configPath, { defaultProfile, version: 1 });
}
