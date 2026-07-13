import { describe, expect, test } from "bun:test";
import {
  buildSourcePackFromConversations,
  createListenResolverDriver,
  resolveListenConversations,
  resolveListenResolution,
  type ListenConversationRow,
  type ListenResolverDriver,
  type ListenResolvedConversation,
  type ListenTranscriptSegment,
} from "../../packages/artifactory/src/listen-resolver.ts";
import type { PermissionEntry, PortableDelegation } from "@tinycloud/node-sdk";
import {
  SourceAuthorityError,
  type RegisteredListenSourceAuthority,
} from "../../packages/artifactory/src/source-authority.ts";

const AGENT_DID = "did:key:agent";
const SPACE_ID = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";
const EXPIRY = "2027-07-02T00:00:00.000Z";

function portableDelegation(overrides: Partial<PortableDelegation> = {}): PortableDelegation {
  return {
    cid: "bafy-listen-child",
    parentCid: "bafy-parent",
    delegateDID: AGENT_DID,
    delegatorDID: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
    spaceId: SPACE_ID,
    path: "xyz.tinycloud.listen/conversations",
    actions: ["tinycloud.sql/read"],
    expiry: new Date(EXPIRY),
    delegationHeader: { Authorization: "Bearer child-secret-marker" },
    ownerAddress: "0x1111111111111111111111111111111111111111",
    chainId: 1,
    host: "https://node.tinycloud.xyz",
    disableSubDelegation: true,
    resources: [
      { service: "sql", space: SPACE_ID, path: "xyz.tinycloud.listen/conversations", actions: ["tinycloud.sql/read"] },
      { service: "kv", space: SPACE_ID, path: "xyz.tinycloud.listen/transcript/", actions: ["tinycloud.kv/get"] },
    ],
    ...overrides,
  };
}

function subset(requested: readonly PermissionEntry[], granted: readonly PermissionEntry[]) {
  const actionMatches = (requestedAction: string, grantedAction: string) =>
    requestedAction === grantedAction || requestedAction.endsWith(`/${grantedAction}`) || grantedAction.endsWith(`/${requestedAction}`);
  const missing = requested.filter((request) => !granted.some((grant) =>
    grant.service === request.service && grant.space === request.space && grant.path === request.path &&
    request.actions.every((action) => grant.actions.some((grantedAction) => actionMatches(action, grantedAction))),
  ));
  return { subset: missing.length === 0, missing: [...missing] };
}

function authorityRecord(
  portable: PortableDelegation,
  overrides: Partial<RegisteredListenSourceAuthority> = {},
): RegisteredListenSourceAuthority {
  return {
    schemaVersion: "feed.source_authority.v1",
    name: "listen-child",
    status: "active",
    host: "https://node.tinycloud.xyz",
    agentDid: AGENT_DID,
    spaceId: SPACE_ID,
    delegationCid: portable.cid,
    expectedParentCid: "bafy-parent",
    expiresAt: portable.expiry.toISOString(),
    serializedDelegation: JSON.stringify({ ...portable, expiry: portable.expiry.toISOString() }),
    privateKeyEnv: "ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY",
    access: { releasePolicy: "delegated", audienceDids: ["did:example:reader"] },
    ...overrides,
  };
}

function fakeSdk(options: { activatedSpace?: string; activationError?: string; queryError?: string } = {}) {
  class FakeTinyCloudNode {
    readonly sessionDid = AGENT_DID;
    async signIn(): Promise<void> {}
    async useDelegation() {
      if (options.activationError) throw new Error(options.activationError);
      return {
        spaceId: options.activatedSpace ?? SPACE_ID,
        sql: { db: () => ({ query: async () => options.queryError
          ? { ok: false, error: options.queryError }
          : { ok: true, data: { columns: [], rows: [], rowCount: 0 } } }) },
        kv: { get: async () => ({ ok: true }) },
      };
    }
  }
  return async () => ({
    TinyCloudNode: FakeTinyCloudNode,
    deserializeDelegation(serialized: string) {
      const parsed = JSON.parse(serialized);
      return { ...parsed, expiry: new Date(parsed.expiry) };
    },
    isCapabilitySubset: subset,
    principalDidEquals: (left: string, right: string) => left === right,
  });
}

async function expectAuthorityFailure(input: {
  portable?: PortableDelegation;
  record?: RegisteredListenSourceAuthority;
  resolveMissing?: boolean;
  activatedSpace?: string;
  activationError?: string;
  queryError?: string;
}, code: string): Promise<void> {
  const portable = input.portable ?? portableDelegation();
  const record = input.record ?? authorityRecord(portable);
  const prior = process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY;
  process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY = "agent-private-secret-marker";
  let error: unknown;
  try {
    await createListenResolverDriver(
      { authorityName: "listen-child" },
      fakeSdk(input),
      async () => input.resolveMissing ? undefined : record,
      () => new Date("2026-07-02T00:00:00.000Z"),
    );
  } catch (caught) {
    error = caught;
  } finally {
    if (prior === undefined) delete process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY;
    else process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY = prior;
  }
  expect(error).toBeInstanceOf(SourceAuthorityError);
  if (error instanceof SourceAuthorityError) {
    expect(error.code).toBe(code);
    expect(error.message).not.toContain("child-secret-marker");
    expect(error.message).not.toContain("agent-private-secret-marker");
  }
}

async function expectSourceReadFailure(operation: Promise<unknown>, code: string): Promise<void> {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SourceAuthorityError);
  if (error instanceof SourceAuthorityError) expect(error.code).toBe(code);
}

function makeResolvedConversation(id: string, text: string): ListenResolvedConversation {
  return {
    conversationId: id,
    row: { id },
    transcriptSource: "kv_transcript",
    sourceRef: {
      sourceRefId: id,
      sourceKind: "listen_conversation",
      sourceId: id,
      observedPath: "kv_transcript",
      observedHash: `sha256:${id}`,
      observedAt: "2026-07-02T00:00:00.000Z",
    },
    transcript: [{ index: 0, text }],
  };
}

function makeDriver(rows: ListenConversationRow[], transcripts: Record<string, ListenTranscriptSegment[]>): ListenResolverDriver {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  return {
    authority: {
      lineageId: "bafy-listen-child",
      releasePolicy: "delegated",
      audienceDids: ["did:example:agent"],
      expiresAt: "2027-07-02T00:00:00.000Z",
    },
    async listRecent(limit, offset) {
      return rows.slice(offset, offset + limit);
    },
    async loadMany(conversationIds) {
      return conversationIds.map((id) => rowById.get(id)).filter((row): row is ListenConversationRow => Boolean(row));
    },
    async loadTranscript(conversationId) {
      return transcripts[conversationId] ?? [];
    },
  };
}

describe("listen resolver", () => {
  test("activates only a registered constrained child portable delegation", async () => {
    const envKey = "ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY";
    const previousPrivateKey = process.env[envKey];
    process.env[envKey] = "0xfeed";
    const portable = portableDelegation();
    let deserializedInput = "";

    class FakeTinyCloudNode {
      readonly sessionDid = AGENT_DID;
      async signIn(): Promise<void> {}

      async useDelegation(): Promise<{
        spaceId: string;
        sql: { db(): { query(): Promise<{ ok: boolean }> } };
        kv: { get(): Promise<{ ok: boolean }> };
      }> {
        return {
          spaceId: SPACE_ID,
          sql: { db: () => ({ query: async () => ({ ok: true }) }) },
          kv: { get: async () => ({ ok: true }) },
        };
      }
    }

    try {
      await createListenResolverDriver(
        {
          authorityName: "listen-child",
        },
        async () => ({
          TinyCloudNode: FakeTinyCloudNode,
          deserializeDelegation(serialized: string) {
            deserializedInput = serialized;
            const parsed = JSON.parse(serialized);
            return { ...parsed, expiry: new Date(parsed.expiry) };
          },
          isCapabilitySubset: subset,
          principalDidEquals: (left: string, right: string) => left === right,
        }),
        async () => ({
          schemaVersion: "feed.source_authority.v1",
          name: "listen-child",
          status: "active",
          host: "https://node.tinycloud.xyz",
          agentDid: AGENT_DID,
          spaceId: SPACE_ID,
          delegationCid: portable.cid,
          expectedParentCid: "bafy-parent",
          expiresAt: EXPIRY,
          serializedDelegation: JSON.stringify({ ...portable, expiry: portable.expiry.toISOString() }),
          privateKeyEnv: envKey,
          access: { releasePolicy: "delegated", audienceDids: ["did:example:agent"] },
        }),
        () => new Date("2026-07-02T00:00:00.000Z"),
      );
    } finally {
      if (previousPrivateKey === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previousPrivateKey;
      }
    }

    expect(JSON.parse(deserializedInput).cid).toBe(portable.cid);
  });

  test("selects named input authorities independently and preserves their lineage", async () => {
    const prior = process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY;
    process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY = "0xfeed";
    const secondary = portableDelegation({ cid: "bafy-listen-secondary" });
    try {
      const driver = await createListenResolverDriver(
        { authorityName: "listen-secondary" },
        fakeSdk(),
        async (name) => name === "listen-secondary"
          ? authorityRecord(secondary, { name: "listen-secondary" })
          : undefined,
        () => new Date("2026-07-02T00:00:00.000Z"),
      );
      expect(driver.authority.lineageId).toBe("bafy-listen-secondary");
    } finally {
      if (prior === undefined) delete process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY;
      else process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY = prior;
    }
  });

  test("revalidates registry status and expiry immediately before every SQL and KV read", async () => {
    const prior = process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY;
    process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY = "0xfeed";
    const portable = portableDelegation();
    const record = authorityRecord(portable);
    let now = new Date("2026-07-02T00:00:00.000Z");
    try {
      const driver = await createListenResolverDriver(
        { authorityName: "listen-child" },
        fakeSdk(),
        async () => record,
        () => now,
      );

      record.status = "revoked";
      await expectSourceReadFailure(driver.listRecent(1, 0), "authority_revoked");

      record.status = "unavailable";
      await expectSourceReadFailure(driver.loadTranscript("conversation-1"), "authority_unavailable");

      record.status = "active";
      record.delegationCid = "bafy-replaced-child";
      await expectSourceReadFailure(driver.listRecent(1, 0), "authority_not_constrained_child");

      record.delegationCid = portable.cid;
      now = new Date("2027-07-02T00:00:00.001Z");
      await expectSourceReadFailure(driver.loadMany(["conversation-1"]), "authority_expired");
    } finally {
      if (prior === undefined) delete process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY;
      else process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY = prior;
    }
  });

  test("fails closed for unavailable, expired, revoked, wrong-host, and wrong-audience authorities", async () => {
    await expectAuthorityFailure({ resolveMissing: true }, "authority_not_found");

    const expiredPortable = portableDelegation({ expiry: new Date("2026-07-01T00:00:00.000Z") });
    await expectAuthorityFailure({ portable: expiredPortable }, "authority_expired");
    await expectAuthorityFailure({
      portable: expiredPortable,
      record: authorityRecord(expiredPortable, { expiresAt: EXPIRY }),
    }, "authority_expired");

    const revokedPortable = portableDelegation();
    await expectAuthorityFailure({
      portable: revokedPortable,
      record: authorityRecord(revokedPortable, { status: "revoked" }),
    }, "authority_revoked");

    const hostPortable = portableDelegation();
    await expectAuthorityFailure({
      portable: hostPortable,
      record: authorityRecord(hostPortable, { host: "https://evil.example" }),
    }, "authority_wrong_host");

    await expectAuthorityFailure({
      portable: portableDelegation({ delegateDID: "did:key:other-agent" }),
    }, "authority_wrong_audience");
  });

  test("rejects broadened and cross-space child delegations before SDK activation", async () => {
    const broadened = portableDelegation();
    broadened.resources![1]!.actions.push("tinycloud.kv/put");
    await expectAuthorityFailure({ portable: broadened }, "authority_broadened");

    const wrongPath = portableDelegation();
    wrongPath.resources![0]!.path = "/";
    await expectAuthorityFailure({ portable: wrongPath }, "authority_broadened");

    const appRoot = portableDelegation();
    appRoot.resources![1]!.path = "xyz.tinycloud.listen/";
    await expectAuthorityFailure({ portable: appRoot }, "authority_broadened");

    const otherSpace = "tinycloud:pkh:eip155:1:0x2222222222222222222222222222222222222222:default";
    await expectAuthorityFailure({
      portable: portableDelegation({ spaceId: otherSpace }),
    }, "authority_cross_space");
    await expectAuthorityFailure({ activatedSpace: otherSpace }, "authority_cross_space");
  });

  test("rejects share links, embedded keys, parent bearers, and redacts activation failures", async () => {
    const portable = portableDelegation();
    await expectAuthorityFailure({
      portable,
      record: authorityRecord(portable, { serializedDelegation: "tc1://share-secret" }),
    }, "authority_transport_invalid");

    await expectAuthorityFailure({
      portable,
      record: authorityRecord(portable, {
        serializedDelegation: JSON.stringify({ ...portable, expiry: EXPIRY, jwk: { d: "secret" } }),
      }),
    }, "authority_embedded_key");

    await expectAuthorityFailure({ portable: portableDelegation({ parentCid: "bafy-wrong-parent" }) }, "authority_wrong_parent");
    await expectAuthorityFailure({ portable: portableDelegation({ parentCid: undefined }) }, "authority_wrong_parent");
    await expectAuthorityFailure({ activationError: "provider leaked Bearer child-secret-marker" }, "authority_unavailable");

    let rawWorkflowError: unknown;
    try {
      await createListenResolverDriver({
        authorityName: "listen-child",
        serializedDelegation: "tc1://parent-bearer",
        jwk: { d: "secret" },
      } as unknown as { authorityName: string }, fakeSdk());
    } catch (error) {
      rawWorkflowError = error;
    }
    expect(rawWorkflowError).toBeInstanceOf(SourceAuthorityError);
    if (rawWorkflowError instanceof SourceAuthorityError) {
      expect(rawWorkflowError.code).toBe("authority_transport_invalid");
      expect(rawWorkflowError.message).not.toContain("parent-bearer");
    }

    const prior = process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY;
    process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY = "0xfeed";
    let queryError: unknown;
    try {
      const child = portableDelegation();
      const driver = await createListenResolverDriver(
        { authorityName: "listen-child" },
        fakeSdk({ queryError: "server leaked Bearer child-secret-marker" }),
        async () => authorityRecord(child),
        () => new Date("2026-07-02T00:00:00.000Z"),
      );
      await driver.listRecent(1, 0);
    } catch (error) {
      queryError = error;
    } finally {
      if (prior === undefined) delete process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY;
      else process.env.ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY = prior;
    }
    expect(queryError).toBeInstanceOf(SourceAuthorityError);
    expect((queryError as Error).message).not.toContain("child-secret-marker");
  });

  test("preserves explicit conversation order and resolves KV transcripts", async () => {
    const now = new Date("2026-07-02T00:00:00.000Z");
    const driver = makeDriver(
      [
        { id: "conversation-1" },
        { id: "conversation-2" },
      ],
      {
        "conversation-1": [{ index: 0, text: "alpha" }],
        "conversation-2": [{ index: 0, text: "bravo" }],
      },
    );

    const resolved = await resolveListenConversations(
      { conversationIds: ["conversation-2", "conversation-1"] },
      driver,
      () => now,
    );

    expect(resolved.map((conversation) => conversation.conversationId)).toEqual([
      "conversation-2",
      "conversation-1",
    ]);
    expect(resolved[0]?.transcriptSource).toBe("kv_transcript");
    expect(resolved[0]?.sourceRef.observedAt).toBe(now.toISOString());
    expect(resolved[0]?.sourceRef.authority).toEqual(driver.authority);
  });

  test("windows transcript segments into excerpts under the token budget", () => {
    const conversation: ListenResolvedConversation = {
      conversationId: "conversation-1",
      row: { id: "conversation-1" },
      transcriptSource: "kv_transcript",
      sourceRef: {
        sourceRefId: "conversation-1",
        sourceKind: "listen_conversation",
        sourceId: "conversation-1",
        observedPath: "kv_transcript",
        observedHash: "sha256:test",
        observedAt: "2026-07-02T00:00:00.000Z",
      },
      transcript: [
        { index: 0, text: "aaaa" },
        { index: 1, text: "bbbb" },
        { index: 2, text: "cccc" },
      ],
    };

    const sourcePack = buildSourcePackFromConversations([conversation], 3);

    // The token budget is a hard cap on the TOTAL packed tokens: the first
    // window ("aaaa\nbbbb", 3 estimated tokens) exhausts the budget, so the
    // trailing "cccc" window is not packed.
    expect(sourcePack.refs).toHaveLength(1);
    expect(sourcePack.refs[0]?.sourceRefId).toBe("conversation-1");
    expect(sourcePack.excerpts).toHaveLength(1);
    expect(sourcePack.excerpts[0]).toEqual({
      sourceRefId: "conversation-1",
      text: "aaaa\nbbbb",
      quoteLineRefs: ["0", "1"],
    });
    expect(sourcePack.maxInputTokens).toBe(3);
  });

  test("enforces skillManifest.limits.maxSourceRefs as a hard cap on packed refs", () => {
    // Oversized fixture: 4 conversations against a declared cap of 2.
    const conversations = ["c-1", "c-2", "c-3", "c-4"].map((id) => makeResolvedConversation(id, "aaaaaaaa"));

    const sourcePack = buildSourcePackFromConversations(conversations, 100, {
      maxSourceRefs: 2,
      maxInputTokens: 100,
    });

    expect(sourcePack.refs.map((ref) => ref.sourceRefId)).toEqual(["c-1", "c-2"]);
    expect(sourcePack.excerpts.map((excerpt) => excerpt.sourceRefId)).toEqual(["c-1", "c-2"]);
  });

  test("enforces the declared token budget as a hard cap on total packed tokens", () => {
    // Each transcript is 8 chars ≈ 2 estimated tokens; a budget of 5 admits two
    // conversations (4 tokens) and hard-stops before the third.
    const conversations = ["c-1", "c-2", "c-3"].map((id) => makeResolvedConversation(id, "aaaaaaaa"));

    const sourcePack = buildSourcePackFromConversations(conversations, 100, {
      maxSourceRefs: 10,
      maxInputTokens: 5,
    });

    expect(sourcePack.maxInputTokens).toBe(5);
    expect(sourcePack.refs.map((ref) => ref.sourceRefId)).toEqual(["c-1", "c-2"]);
    expect(sourcePack.excerpts).toHaveLength(2);
    const totalTokens = sourcePack.excerpts.reduce(
      (sum, excerpt) => sum + Math.ceil(excerpt.text.length / 4),
      0,
    );
    expect(totalTokens).toBeLessThanOrEqual(5);
  });

  test("resolveListenResolution combines resolution and packing with injected fixtures", async () => {
    const now = new Date("2026-07-02T00:00:00.000Z");
    const driver = makeDriver(
      [{ id: "conversation-1" }],
      {
        "conversation-1": [
          { index: 0, text: "aaaa" },
          { index: 1, text: "bbbb" },
        ],
      },
    );

    const result = await resolveListenResolution(
      {
        auth: {
          authorityName: "listen-child",
        },
        query: { conversationId: "conversation-1" },
      },
      3,
      { driver, now: () => now },
    );

    expect(result.conversations).toHaveLength(1);
    expect(result.sourcePack.excerpts).toHaveLength(1);
    expect(result.sourcePack.excerpts[0]?.quoteLineRefs).toEqual(["0", "1"]);
    expect(result.sourcePack.refs[0]?.authority?.lineageId).toBe("bafy-listen-child");
  });
});
