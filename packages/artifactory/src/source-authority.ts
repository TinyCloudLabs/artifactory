import { readFile } from "node:fs/promises";
import type { PermissionEntry, PortableDelegation } from "@tinycloud/node-sdk";
import type { TranscriptSourceRef } from "../../../skills/_shared/lib/feed-v1.ts";

export const LISTEN_SOURCE_HOST = "https://node.tinycloud.xyz";
export const LISTEN_SOURCE_PERMISSIONS: readonly PermissionEntry[] = [
  { service: "tinycloud.sql", path: "xyz.tinycloud.listen/conversations", actions: ["read"] },
  { service: "tinycloud.kv", path: "xyz.tinycloud.listen/transcript/", actions: ["get"] },
];

export type RegisteredListenSourceAuthority = {
  schemaVersion: "feed.source_authority.v1";
  name: string;
  status: "active" | "revoked" | "unavailable";
  host: string;
  agentDid: string;
  spaceId: string;
  delegationCid: string;
  expectedParentCid: string;
  expiresAt: string;
  serializedDelegation: string;
  privateKeyPath?: string;
  privateKeyEnv?: string;
  access: {
    releasePolicy: "private" | "delegated" | "public";
    audienceDids?: string[];
  };
};

export type SourceAuthorityResolver = (
  name: string,
) => Promise<RegisteredListenSourceAuthority | undefined> | RegisteredListenSourceAuthority | undefined;

export type SourceAuthoritySdkHelpers = {
  isCapabilitySubset(
    requested: readonly PermissionEntry[],
    granted: readonly PermissionEntry[],
  ): { subset: boolean; missing: PermissionEntry[] };
  principalDidEquals(left: string, right: string): boolean;
};

export class SourceAuthorityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`Listen source authority unavailable (${code}): ${message}`);
    this.name = "SourceAuthorityError";
    this.code = code;
  }
}

export async function resolveRegisteredSourceAuthority(
  name: string,
  resolver: SourceAuthorityResolver = loadSourceAuthorityFromRegistryFile,
  now: () => Date = () => new Date(),
): Promise<RegisteredListenSourceAuthority> {
  if (!name.trim()) throw new SourceAuthorityError("authority_name_missing", "authority name is required");
  let record: RegisteredListenSourceAuthority | undefined;
  try {
    record = await resolver(name.trim());
  } catch (error) {
    if (error instanceof SourceAuthorityError) throw error;
    throw new SourceAuthorityError("registry_unavailable", "registered authority store could not be queried");
  }
  if (!record) throw new SourceAuthorityError("authority_not_found", `registered authority '${name.trim()}' was not found`);
  validateRegisteredRecord(record, name.trim(), now());
  return structuredClone(record);
}

export function validatePortableListenAuthority(
  record: RegisteredListenSourceAuthority,
  delegation: PortableDelegation,
  agentSessionDid: string,
  helpers: SourceAuthoritySdkHelpers,
  now: Date,
): void {
  if (!delegation || typeof delegation !== "object") {
    throw new SourceAuthorityError("authority_transport_invalid", "portable delegation is malformed");
  }
  if (delegation.cid !== record.delegationCid || delegation.disableSubDelegation !== true) {
    throw new SourceAuthorityError("authority_not_constrained_child", "delegation is not the registered constrained child");
  }
  if (delegation.parentCid !== record.expectedParentCid) {
    throw new SourceAuthorityError("authority_wrong_parent", "delegation parent does not match its registration");
  }
  if (typeof delegation.host !== "string" || normalizeHost(delegation.host) !== normalizeHost(record.host)) {
    throw new SourceAuthorityError("authority_wrong_host", "portable delegation host does not match its registration");
  }
  if (delegation.spaceId !== record.spaceId) {
    throw new SourceAuthorityError("authority_cross_space", "portable delegation targets a different space");
  }
  if (
    typeof delegation.delegateDID !== "string" ||
    !helpers.principalDidEquals(agentSessionDid, record.agentDid) ||
    !helpers.principalDidEquals(delegation.delegateDID, record.agentDid)
  ) {
    throw new SourceAuthorityError("authority_wrong_audience", "portable delegation audience is not this agent");
  }
  if (!(delegation.expiry instanceof Date) || delegation.expiry.getTime() <= now.getTime()) {
    throw new SourceAuthorityError("authority_expired", "portable delegation is expired");
  }
  if (delegation.expiry.toISOString() !== new Date(record.expiresAt).toISOString()) {
    throw new SourceAuthorityError("authority_expiry_mismatch", "portable delegation expiry does not match registration");
  }
  if (!Array.isArray(delegation.resources) || delegation.resources.length !== LISTEN_SOURCE_PERMISSIONS.length) {
    throw new SourceAuthorityError("authority_broadened", "portable delegation resources are not the exact Listen read set");
  }
  const serviceNames: Record<string, string> = { sql: "tinycloud.sql", kv: "tinycloud.kv" };
  const granted: PermissionEntry[] = delegation.resources.map((resource) => {
    if (!resource || typeof resource !== "object" || !Array.isArray(resource.actions)) {
      throw new SourceAuthorityError("authority_transport_invalid", "portable delegation resource is malformed");
    }
    if (resource.space !== record.spaceId) {
      throw new SourceAuthorityError("authority_cross_space", "portable delegation resource targets a different space");
    }
    const service = serviceNames[resource.service];
    if (!service) throw new SourceAuthorityError("authority_broadened", "portable delegation includes an unsupported service");
    return { service, space: record.spaceId, path: resource.path, actions: [...resource.actions] };
  });
  const allowed = LISTEN_SOURCE_PERMISSIONS.map((permission) => ({
    ...permission,
    space: record.spaceId,
    actions: [...permission.actions],
  }));
  if (!helpers.isCapabilitySubset(granted, allowed).subset || !helpers.isCapabilitySubset(allowed, granted).subset) {
    throw new SourceAuthorityError("authority_broadened", "portable delegation exceeds or differs from exact Listen read authority");
  }
}

export function authorityMetadata(
  record: RegisteredListenSourceAuthority,
  delegation: PortableDelegation,
): NonNullable<TranscriptSourceRef["authority"]> {
  return {
    lineageId: record.delegationCid,
    releasePolicy: record.access.releasePolicy,
    grantorDid: delegation.delegatorDID,
    audienceDids: record.access.audienceDids ? [...record.access.audienceDids] : undefined,
    expiresAt: record.expiresAt,
  };
}

async function loadSourceAuthorityFromRegistryFile(
  name: string,
): Promise<RegisteredListenSourceAuthority | undefined> {
  const path = process.env.ARTIFACTORY_SOURCE_AUTHORITY_REGISTRY?.trim();
  if (!path) {
    throw new SourceAuthorityError(
      "registry_unavailable",
      "ARTIFACTORY_SOURCE_AUTHORITY_REGISTRY is not configured",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new SourceAuthorityError("registry_unavailable", "registered authority store could not be loaded");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SourceAuthorityError("registry_invalid", "registered authority store is malformed");
  }
  return (parsed as Record<string, RegisteredListenSourceAuthority>)[name];
}

function validateRegisteredRecord(record: RegisteredListenSourceAuthority, expectedName: string, now: Date): void {
  if (record.schemaVersion !== "feed.source_authority.v1" || record.name !== expectedName) {
    throw new SourceAuthorityError("authority_record_invalid", "registered authority identity is malformed");
  }
  if (record.status === "revoked") throw new SourceAuthorityError("authority_revoked", "registered child delegation is revoked");
  if (record.status !== "active") throw new SourceAuthorityError("authority_unavailable", "registered child delegation is unavailable");
  if (typeof record.host !== "string" || normalizeHost(record.host) !== LISTEN_SOURCE_HOST) {
    throw new SourceAuthorityError("authority_wrong_host", "registered authority targets an unsupported host");
  }
  if (
    typeof record.agentDid !== "string" || !record.agentDid.startsWith("did:") ||
    typeof record.spaceId !== "string" || !record.spaceId.startsWith("tinycloud:pkh:")
  ) {
    throw new SourceAuthorityError("authority_record_invalid", "registered audience or space is malformed");
  }
  if (
    typeof record.delegationCid !== "string" || !record.delegationCid ||
    typeof record.expectedParentCid !== "string" || !record.expectedParentCid ||
    typeof record.expiresAt !== "string" || !isIsoFuture(record.expiresAt, now)
  ) {
    throw new SourceAuthorityError("authority_expired", "registered child delegation is expired or malformed");
  }
  if (typeof record.serializedDelegation !== "string" || !record.serializedDelegation.trim().startsWith("{")) {
    throw new SourceAuthorityError("authority_transport_invalid", "registered authority must contain portable delegation JSON");
  }
  if (/(?:tc1:|https?:\/\/)/i.test(record.serializedDelegation.trim().slice(0, 16))) {
    throw new SourceAuthorityError("authority_transport_invalid", "share links are not accepted as source authority");
  }
  rejectEmbeddedKeyMaterial(record.serializedDelegation);
  const envRef = typeof record.privateKeyEnv === "string" && record.privateKeyEnv.trim().length > 0;
  const pathRef = typeof record.privateKeyPath === "string" && record.privateKeyPath.trim().length > 0;
  const keyRefs = Number(envRef) + Number(pathRef);
  if (keyRefs !== 1) {
    throw new SourceAuthorityError("authority_key_ref_invalid", "registered authority requires exactly one agent key reference");
  }
  if (!record.access || typeof record.access !== "object" || !["private", "delegated", "public"].includes(record.access.releasePolicy)) {
    throw new SourceAuthorityError("authority_access_invalid", "registered source access policy is malformed");
  }
  if (
    record.access.audienceDids !== undefined &&
    (!Array.isArray(record.access.audienceDids) || !record.access.audienceDids.every((did) => typeof did === "string" && did.startsWith("did:")))
  ) {
    throw new SourceAuthorityError("authority_access_invalid", "registered data audience is malformed");
  }
}

function rejectEmbeddedKeyMaterial(serialized: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new SourceAuthorityError("authority_transport_invalid", "portable delegation JSON is malformed");
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (["jwk", "privateKey", "private_key"].includes(key)) {
        throw new SourceAuthorityError("authority_embedded_key", "embedded key material is forbidden");
      }
      visit(child);
    }
  };
  visit(parsed);
}

function normalizeHost(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function isIsoFuture(value: string, now: Date): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time > now.getTime();
}
