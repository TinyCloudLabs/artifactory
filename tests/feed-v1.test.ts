import { describe, expect, test } from "bun:test";
import {
  assertFeedV1SchemaUsesMigrations,
  feedV1MigrationApplyPlans,
  FEED_V1_APP_SCHEMA,
  FEED_V1_ARTIFACT_DOC_PREFIX,
  FEED_V1_ARTIFACTS_INDEX_DB_PATH,
  FEED_V1_FEED_INDEX_DB_PATH,
} from "../skills/_shared/lib/feed-v1-schema.ts";
import {
  assertNotLegacyFeedShape,
  buildGreenfieldSeed,
  candidateToArtifact,
  deriveFeedPosts,
  feedItemProjectionRow,
} from "../skills/_shared/lib/feed-v1-bootstrap.ts";
import {
  FEED_V1_PROVIDER_PROFILES,
  FEED_V1_SKILL_OPTIONS,
  FEED_POST_BODY_MAX_CHARS,
  FEED_POST_TITLE_MAX_CHARS,
  canonicalFeedPostIdentity,
  canonicalEvidenceTextHash,
  deriveAccessPolicy,
  feedItemIdFor,
  validateFeedArtifact,
  validateFeedItemProjection,
  validateFeedTargetedInteractionEvent,
  validateCandidateArtifactEnvelope,
  validateSkillRunOutput,
  type CandidateArtifactEnvelope,
  type CandidateFeedPost,
  type FeedArtifact,
  type FeedArtifactProjection,
  type FeedItemProjection,
  type FeedWorkflowPackage,
  type FeedWorkflowRun,
  type SkillRunOutput,
  type TranscriptSourceRef,
} from "../skills/_shared/lib/feed-v1.ts";

const now = "2026-06-28T12:00:00.000Z";

function source(): TranscriptSourceRef {
  return {
    sourceRefId: "src-1",
    sourceKind: "listen_conversation",
    sourceId: "listen-1",
    observedPath: "sql_transcript_text",
    observedHash: "sha256:source",
    observedAt: now,
    quoteLineRefs: ["L1"],
  };
}

function pkg(): FeedWorkflowPackage {
  return {
    schemaVersion: "feed.workflow_package.v1",
    packageId: "daily_digest",
    displayName: "Daily Digest",
    version: "0.1.0",
    digest: "sha256:pkg",
    manifestKey: "packages/daily_digest/manifest.json",
    workflowRef: "workflows/daily-digest.smithers.json",
    workflowDigest: "sha256:workflow",
    admissionState: "reviewed_first_party",
    disclosure: {
      userCopy: "Reads bounded Listen excerpts and writes private Feed artifacts.",
      credentialOwner: "feed_hosted",
      providerClass: "first_party",
      egressClass: "model_provider",
    },
  };
}

function artifact(): FeedArtifact {
  const p = pkg();
  return {
    schemaVersion: "feed.artifact.v1",
    artifactId: "artifact-1",
    artifactType: "daily_digest",
    renderShape: "longform",
    title: "Daily Digest",
    summary: "One grounded artifact.",
    body: { markdown: "A grounded digest." },
    sourceRefs: [source()],
    producedBy: {
      packageId: p.packageId,
      packageVersion: p.version,
      packageDigest: p.digest,
      runId: "run-1",
      runtimeClass: "feed_hosted",
      providerClass: "first_party",
      credentialOwner: "feed_hosted",
      egressClass: "model_provider",
      disclosure: p.disclosure,
    },
    freshness: { label: "fresh", asOf: now },
    idempotency: {
      sourceFingerprint: "sha256:source",
      artifactFingerprint: "sha256:artifact",
      dedupeKey: "daily_digest:sha256:source",
    },
    storage: { docKey: "artifacts/artifact-1.json" },
    createdAt: now,
    updatedAt: now,
  };
}

function run(): FeedWorkflowRun {
  return {
    schemaVersion: "feed.workflow_run.v1",
    runId: "run-1",
    packageId: "daily_digest",
    packageDigest: "sha256:pkg",
    status: "published",
    sourceRefs: [source()],
    publishedArtifactIds: ["artifact-1"],
    droppedCandidates: [],
    spend: { budgetId: "m0", amount: 0, currency: "USD" },
    startedAt: now,
    finishedAt: now,
  };
}

function projection(): FeedArtifactProjection {
  return {
    artifactId: "artifact-1",
    rankScore: 100,
    disposition: "default",
    visibility: "ranked",
    freshnessLabel: "fresh",
    reasonCodes: ["seed"],
    packageId: "daily_digest",
    sourceFingerprint: "sha256:source",
    publishedAt: now,
    updatedAt: now,
  };
}

function itemProjection(): FeedItemProjection {
  return {
    feedItemId: feedItemIdFor("artifact-1", "post-1"),
    target: { kind: "post", artifactId: "artifact-1", postId: "post-1" },
    rankScore: 100,
    disposition: "default",
    visibility: "ranked",
    freshnessLabel: "fresh",
    reasonCodes: ["seed"],
    packageId: "daily_digest",
    sourceFingerprint: "sha256:source",
    publishedAt: now,
    updatedAt: now,
  };
}

describe("Feed v1 contracts", () => {
  test("validates a canonical FeedArtifact", () => {
    const result = validateFeedArtifact(artifact());
    expect(result.ok).toBe(true);
  });

  test("keeps pre-post feed.artifact.v1 documents valid as an explicit additive compatibility policy", () => {
    const oldArtifact = artifact();
    expect(oldArtifact.posts).toBeUndefined();
    expect(validateFeedArtifact(oldArtifact)).toEqual({ ok: true, value: oldArtifact });
  });

  test("validates a rich artifact with multiple evidence-backed posts", async () => {
    const fixture = await Bun.file(new URL("./fixtures/feed-v1/rich-artifact.json", import.meta.url)).json();
    const result = validateFeedArtifact(fixture);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.posts).toHaveLength(2);
      expect(result.value.posts?.[0]?.expansionTarget.artifactId).toBe(result.value.artifactId);
      expect(result.value.posts?.[1]?.expansionTarget).toEqual({ artifactId: result.value.artifactId });
    }
  });

  test("rejects post evidence refs outside the artifact sourceRefs", () => {
    const invalid = {
      ...artifact(),
      posts: [
        {
          ...canonicalFeedPostIdentity({
            kind: "insight",
            body: "Unsupported claim.",
            evidence: [{ kind: "located_source", evidenceId: "e1", sourceRefId: "src-not-observed", loc: "L1" }],
          }, { sourceRefs: [{ ...source(), sourceRefId: "src-not-observed" }] }),
          kind: "insight",
          body: "Unsupported claim.",
          evidence: [{ kind: "located_source", evidenceId: "e1", sourceRefId: "src-not-observed", loc: "L1" }],
          expansionTarget: { artifactId: "artifact-1" },
        },
      ],
    };
    const result = validateFeedArtifact(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        "posts[0].evidence[0].sourceRefId: must reference artifact sourceRefs",
      );
    }
  });

  test("validates SkillRunOutput candidate envelopes", () => {
    const candidate: CandidateArtifactEnvelope = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "c-1",
      artifactType: "insight",
      renderShape: "short_form",
      title: "A sharp point",
      body: { body: "A sharp point." },
      sourceRefs: [source()],
      posts: [
        {
          kind: "insight",
          title: "A sharp point",
          body: "A sharp point.",
          evidence: [
            {
              kind: "verified_quote",
              evidenceId: "quote-1",
              sourceRefId: "src-1",
              quote: "A sharp point.",
              loc: "L1",
            },
          ],
        },
      ],
      parentArtifactRefs: [
        {
          kind: "feed_artifact",
          artifactId: "artifact-0",
          artifactType: "daily_digest",
          observedHash: "sha256:parent",
          observedAt: now,
        },
      ],
      sourceQuotes: [{ quote: "A sharp point.", sourceRefId: "src-1", loc: "L1" }],
      quality: { criticPass: true, quotesVerified: true, reasons: ["quotes verified"], warnings: [] },
      idempotencyBasis: {
        sourceFingerprintMaterial: ["listen-1", "sha256:source"],
        artifactFingerprintMaterial: { body: "A sharp point." },
      },
    };
    const output: SkillRunOutput = {
      candidates: [candidate],
      trace: {
        procedureVersion: "0.1.0",
        modelCalls: 1,
        toolCalls: [],
        stageTrace: [],
        droppedCandidates: [],
      },
    };

    expect(validateSkillRunOutput(output).ok).toBe(true);
    const trustedVerification = {
      verifiedQuotes: [{
        evidenceId: "quote-1",
        sourceRefId: "src-1",
        sourceObservedHash: "sha256:source",
        quoteHash: canonicalEvidenceTextHash("A sharp point."),
      }],
    };
    expect(() => candidateToArtifact(candidate, artifact().producedBy, now)).toThrow(/trusted worker proof/);
    const derived = candidateToArtifact(candidate, artifact().producedBy, now, trustedVerification);
    expect(derived.schemaVersion).toBe("feed.artifact.v1");
    expect(validateFeedArtifact(derived).ok).toBe(true);
    // Worker-assigned idempotency: dedupeKey = sha256(packageDigest + sourceFingerprint + artifactFingerprint).
    expect(derived.idempotency.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(derived.idempotency.artifactFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(derived.idempotency.dedupeKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(derived.storage.docKey).toBe("runs/run-1/c-1.json");
    expect(derived.parentArtifactRefs).toEqual([
      { artifactId: "artifact-0", artifactType: "daily_digest", observedHash: "sha256:parent" },
    ]);
    expect(derived.posts).toHaveLength(1);
    const derivedFeedPost = derived.posts?.[0];
    expect(derivedFeedPost).toBeDefined();
    expect(derivedFeedPost?.evidence[0]).toMatchObject({
      verification: { method: "worker_source_quote_match", sourceObservedHash: "sha256:source" },
    });
    const missingProof = structuredClone(derived);
    delete (missingProof.posts![0]!.evidence[0] as unknown as { verification?: unknown }).verification;
    expect(validateFeedArtifact(missingProof).ok).toBe(false);
    expect(derived.posts?.[0]?.expansionTarget).toEqual({
      artifactId: "run-1:c-1",
      sectionId: undefined,
    });
    // Deterministic: identical basis + package digest re-derives identical keys.
    expect(candidateToArtifact(candidate, artifact().producedBy, now, trustedVerification).idempotency).toEqual(derived.idempotency);
    expect(deriveFeedPosts(candidate, "run-1:c-1", trustedVerification)).toEqual(derived.posts);
    expect(deriveFeedPosts(candidate, "another-artifact", trustedVerification)?.[0]?.postFingerprint).toBe(
      derived.posts?.[0]?.postFingerprint,
    );
    expect(deriveFeedPosts(candidate, "another-artifact", trustedVerification)?.[0]?.postId).toBe(
      derived.posts?.[0]?.postId,
    );
    expect(feedItemIdFor(derived.artifactId, derivedFeedPost!.postId)).toBe(
      `run-1:c-1::${encodeURIComponent(derivedFeedPost!.postId)}`,
    );
  });

  test("canonical identity ignores evidence order and harmless whitespace", () => {
    const context = {
      sourceRefs: [source()],
      parentArtifactRefs: [{ artifactId: "artifact-0", observedHash: "sha256:parent" }],
    };
    const first = canonicalFeedPostIdentity({
      kind: "acme.risk_signal",
      title: "  Risk   moved ",
      body: "One\n claim",
      evidence: [
        { kind: "located_source", evidenceId: "b", sourceRefId: "src-1", loc: "L1" },
        { kind: "parent_artifact", evidenceId: "a", artifactId: "artifact-0" },
      ],
    }, context);
    const reordered = canonicalFeedPostIdentity({
      kind: "acme.risk_signal",
      title: "Risk moved",
      body: "One claim",
      evidence: [
        { kind: "parent_artifact", evidenceId: "renamed-a", artifactId: "renamed-artifact" },
        { kind: "located_source", evidenceId: "renamed-b", sourceRefId: "renamed-source", loc: "L1" },
      ],
    }, {
      sourceRefs: [{ ...source(), sourceRefId: "renamed-source" }],
      parentArtifactRefs: [{ artifactId: "renamed-artifact", observedHash: "sha256:parent" }],
    });
    expect(reordered).toEqual(first);
  });

  test("matches the canonical cross-repository post identity vector", async () => {
    const fixture = await Bun.file(
      new URL("./fixtures/feed-v1/feed-post-identity-vectors.json", import.meta.url),
    ).json() as {
      vectors: Array<{
        input: Parameters<typeof canonicalFeedPostIdentity>[0];
        context: Parameters<typeof canonicalFeedPostIdentity>[1];
        equivalentInput: Parameters<typeof canonicalFeedPostIdentity>[0];
        equivalentContext: Parameters<typeof canonicalFeedPostIdentity>[1];
        expected: ReturnType<typeof canonicalFeedPostIdentity>;
      }>;
    };
    for (const vector of fixture.vectors) {
      expect(canonicalFeedPostIdentity(vector.input, vector.context)).toEqual(vector.expected);
      expect(canonicalFeedPostIdentity(vector.equivalentInput, vector.equivalentContext)).toEqual(vector.expected);
    }
  });

  test("artifact fingerprint automatically includes the order-invariant canonical post set", () => {
    const candidate: CandidateArtifactEnvelope = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "fingerprint",
      artifactType: "report",
      renderShape: "longform",
      title: "Report",
      body: {},
      sourceRefs: [source()],
      posts: [
        { kind: "acme.one", body: " First  post ", evidence: [{ kind: "located_source", evidenceId: "a", sourceRefId: "src-1", loc: "L1" }] },
        { kind: "acme.two", body: "Second post", evidence: [{ kind: "located_source", evidenceId: "b", sourceRefId: "src-1", loc: "L1" }] },
      ],
      quality: { criticPass: true, quotesVerified: true, reasons: [], warnings: [] },
      idempotencyBasis: { sourceFingerprintMaterial: ["src-1"], artifactFingerprintMaterial: { body: "same" } },
    };
    const first = candidateToArtifact(candidate, artifact().producedBy, now).idempotency.artifactFingerprint;
    const reordered = structuredClone(candidate);
    reordered.posts = [reordered.posts![1]!, { ...reordered.posts![0]!, body: "First post" }];
    expect(candidateToArtifact(reordered, artifact().producedBy, now).idempotency.artifactFingerprint).toBe(first);
    reordered.posts[1]!.body = "Materially changed post";
    expect(candidateToArtifact(reordered, artifact().producedBy, now).idempotency.artifactFingerprint).not.toBe(first);
  });

  test("recomputes final identity and rejects tampering or duplicate post content", () => {
    const candidate: CandidateArtifactEnvelope = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "identity",
      artifactType: "report",
      renderShape: "longform",
      title: "Report",
      body: {},
      sourceRefs: [source()],
      posts: [{
        kind: "acme.signal",
        body: "Stable text",
        evidence: [{ kind: "located_source", evidenceId: "e1", sourceRefId: "src-1", loc: "L1" }],
      }],
      quality: { criticPass: true, quotesVerified: true, reasons: [], warnings: [] },
      idempotencyBasis: { sourceFingerprintMaterial: ["src-1"], artifactFingerprintMaterial: {} },
    };
    const derived = candidateToArtifact(candidate, artifact().producedBy, now);
    const duplicate = { ...derived.posts![0] };
    expect(validateFeedArtifact({ ...derived, posts: [derived.posts![0], duplicate] }).ok).toBe(false);
    expect(validateFeedArtifact({
      ...derived,
      posts: [{ ...derived.posts![0], postId: "post:forged" }],
    }).ok).toBe(false);
    expect(validateFeedArtifact({
      ...derived,
      posts: [{
        ...derived.posts![0],
        expansionTarget: { artifactId: derived.artifactId, anchor: derived.posts![0]!.postId },
      }],
    }).ok).toBe(false);
    expect(validateFeedArtifact({
      ...derived,
      posts: [{ ...derived.posts![0], mediaPreview: { mediaKey: "untrusted" } }],
    }).ok).toBe(false);
  });

  test("strips unknown candidate fields and never treats candidate quote flags as trusted proof", () => {
    const candidate = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "strip",
      artifactType: "report",
      renderShape: "longform",
      title: "Report",
      body: {},
      sourceRefs: [source()],
      posts: [{
        kind: "acme.signal",
        body: "Stable text",
        evidence: [{ kind: "located_source", evidenceId: "e1", sourceRefId: "src-1", loc: "L1", secret: "drop" }],
        mediaPreview: { mediaKey: "candidate-controlled" },
        postId: "candidate-controlled",
      }],
      quality: { criticPass: true, quotesVerified: true, reasons: [], warnings: [] },
      idempotencyBasis: { sourceFingerprintMaterial: ["src-1"], artifactFingerprintMaterial: {} },
    } as unknown as CandidateArtifactEnvelope;
    const derived = candidateToArtifact(candidate, artifact().producedBy, now);
    const storageVariant = structuredClone(candidate) as unknown as Record<string, unknown>;
    storageVariant.storage = { docKey: "candidate-controlled" };
    (storageVariant.posts as Array<Record<string, unknown>>)[0]!.mediaPreview = { mediaKey: "different" };
    const derivedVariant = candidateToArtifact(
      storageVariant as unknown as CandidateArtifactEnvelope,
      artifact().producedBy,
      now,
    );
    expect(derived.posts?.[0]).not.toHaveProperty("mediaPreview");
    expect(derived.posts?.[0]).not.toHaveProperty("secret");
    expect(derived.posts?.[0]?.evidence[0]).not.toHaveProperty("secret");
    expect(derivedVariant.posts?.[0]?.postId).toBe(derived.posts?.[0]?.postId);

    const unverified = structuredClone(candidate);
    unverified.posts![0] = {
      kind: "quote",
      body: "Quote",
      evidence: [{ kind: "verified_quote", evidenceId: "q1", sourceRefId: "src-1", quote: "Quote", loc: "L1" }],
    };
    unverified.sourceQuotes = [{ quote: "Quote", sourceRefId: "src-1", loc: "L1" }];
    unverified.quality.quotesVerified = false;
    expect(validateSkillRunOutput({ candidates: [unverified], trace: {
      procedureVersion: "test", modelCalls: 0, toolCalls: [], stageTrace: [], droppedCandidates: [],
    } }).ok).toBe(true);
    expect(() => candidateToArtifact(unverified, artifact().producedBy, now)).toThrow(/trusted worker proof/);
  });

  test("rejects invalid locations, parents, inference support, evidence ids, and synthetic sections", () => {
    const outputFor = (post: CandidateFeedPost, extras: Partial<CandidateArtifactEnvelope> = {}) => ({
      candidates: [{
        schemaVersion: "feed.candidate_artifact.v1" as const,
        localCandidateId: "negative-evidence",
        artifactType: "report",
        renderShape: "longform" as const,
        title: "Report",
        body: {},
        sourceRefs: [source()],
        posts: [post],
        quality: { criticPass: true, quotesVerified: true, reasons: [], warnings: [] },
        idempotencyBasis: { sourceFingerprintMaterial: ["src-1"], artifactFingerprintMaterial: {} },
        ...extras,
      }],
      trace: { procedureVersion: "test", modelCalls: 0, toolCalls: [], stageTrace: [], droppedCandidates: [] },
    });

    expect(validateSkillRunOutput(outputFor({
      kind: "acme.signal",
      body: "Bad location",
      evidence: [{ kind: "located_source", evidenceId: "e1", sourceRefId: "src-1", loc: "L999" }],
    })).ok).toBe(false);
    expect(validateSkillRunOutput(outputFor({
      kind: "acme.signal",
      body: "Missing parent",
      evidence: [{ kind: "parent_artifact", evidenceId: "e1", artifactId: "not-a-parent" }],
    })).ok).toBe(false);
    expect(validateSkillRunOutput(outputFor({
      kind: "acme.signal",
      body: "Unsupported inference",
      evidence: [{ kind: "analytic_inference", evidenceId: "i1", rationale: "Because", supportedBy: ["missing"] }],
    })).ok).toBe(false);
    expect(validateSkillRunOutput(outputFor({
      kind: "acme.signal",
      body: "Duplicate evidence",
      evidence: [
        { kind: "located_source", evidenceId: "same", sourceRefId: "src-1", loc: "L1" },
        { kind: "located_source", evidenceId: "same", sourceRefId: "src-1", loc: "L1" },
      ],
    })).ok).toBe(false);
    expect(validateSkillRunOutput(outputFor({
      kind: "acme.signal",
      body: "Synthetic section",
      sectionId: "invented",
      evidence: [{ kind: "located_source", evidenceId: "e1", sourceRefId: "src-1", loc: "L1" }],
    })).ok).toBe(false);

    const valid = outputFor({
      kind: "acme.signal",
      body: "Real section",
      sectionId: "details",
      evidence: [{ kind: "located_source", evidenceId: "e1", sourceRefId: "src-1", loc: "L1" }],
    }, { renderHints: { sectionIds: ["details"] } });
    expect(validateSkillRunOutput(valid).ok).toBe(true);
    const duplicateCandidate = structuredClone(valid);
    duplicateCandidate.candidates[0]!.posts!.push(structuredClone(duplicateCandidate.candidates[0]!.posts![0]!));
    expect(validateSkillRunOutput(duplicateCandidate).ok).toBe(false);
    const artifactWithSection = candidateToArtifact(valid.candidates[0]!, artifact().producedBy, now);
    expect(artifactWithSection.posts?.[0]?.expansionTarget).toEqual({
      artifactId: "run-1:negative-evidence",
      sectionId: "details",
    });
  });

  test("rejects candidates that self-assign idempotency/storage instead of shipping basis material", () => {
    const legacyCandidate = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "c-legacy",
      artifactType: "insight",
      renderShape: "short_form",
      title: "Self-assigned keys",
      body: { body: "nope" },
      sourceRefs: [source()],
      quality: { criticPass: true, quotesVerified: true },
      idempotency: {
        sourceFingerprint: "sha256:source",
        artifactFingerprint: "sha256:candidate",
        dedupeKey: "insight:sha256:source",
      },
      storage: { docKey: "scratch/c-legacy.json" },
    };
    const result = validateSkillRunOutput({
      candidates: [legacyCandidate],
      trace: {
        procedureVersion: "0.1.0",
        modelCalls: 1,
        toolCalls: [],
        stageTrace: [],
        droppedCandidates: [],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes("idempotencyBasis"))).toBe(true);
    }
  });

  test("rejects legacy artifact/interactions rows as native v1 input", () => {
    expect(() => assertNotLegacyFeedShape({ raw_artifact: "{}", render_type: "tweet" })).toThrow(
      /legacy artifact/,
    );
    expect(() => assertNotLegacyFeedShape({ action: "more", artifact_id: "old" })).toThrow(
      /legacy artifact/,
    );
  });

  test("validates Feed-owned projection identities, joins, interaction targets, and signals", () => {
    expect(validateFeedItemProjection(itemProjection()).ok).toBe(true);
    expect(validateFeedItemProjection({ ...itemProjection(), feedItemId: "forged" }).ok).toBe(false);
    expect(validateFeedItemProjection(itemProjection(), {
      artifacts: new Map([["artifact-1", artifact()]]),
    }).ok).toBe(false);

    const artifactInteraction = {
      eventId: "event-1",
      actorId: "actor-1",
      readerNonce: "nonce-1",
      signal: "save",
      target: { kind: "artifact", artifactId: "artifact-1" },
      createdAt: now,
    };
    expect(validateFeedTargetedInteractionEvent(artifactInteraction, {
      artifacts: new Set(["artifact-1"]),
    }).ok).toBe(true);
    expect(validateFeedTargetedInteractionEvent({ ...artifactInteraction, signal: "delete_everything" }).ok).toBe(false);
    expect(validateFeedTargetedInteractionEvent({
      ...artifactInteraction,
      target: { kind: "post", artifactId: "artifact-1", postId: "missing" },
    }, { feedItems: new Map() }).ok).toBe(false);
  });

  test("combines authority lineage conservatively and defaults missing authority to private", () => {
    const publicSource: TranscriptSourceRef = {
      ...source(),
      sourceRefId: "src-public",
      authority: { lineageId: "cid:public", releasePolicy: "public" },
    };
    const delegatedSource: TranscriptSourceRef = {
      ...source(),
      sourceRefId: "src-delegated",
      authority: {
        lineageId: "cid:delegated",
        releasePolicy: "delegated",
        audienceDids: ["did:example:b", "did:example:a"],
        expiresAt: "2026-07-01T00:00:00.000Z",
      },
    };
    expect(deriveAccessPolicy([publicSource, delegatedSource])).toEqual({
      releasePolicy: "delegated",
      lineage: [
        { sourceRefId: "src-delegated", lineageId: "cid:delegated", releasePolicy: "delegated" },
        { sourceRefId: "src-public", lineageId: "cid:public", releasePolicy: "public" },
      ],
      parentArtifacts: [],
      audienceDids: ["did:example:a", "did:example:b"],
      expiresAt: "2026-07-01T00:00:00.000Z",
    });
    expect(deriveAccessPolicy([publicSource, source()])).toMatchObject({
      releasePolicy: "private",
      audienceDids: [],
    });

    const candidate: CandidateArtifactEnvelope = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "authority",
      artifactType: "report",
      renderShape: "longform",
      title: "Authority",
      body: {},
      sourceRefs: [publicSource, delegatedSource],
      feedSurface: { mode: "none" },
      quality: { criticPass: true, quotesVerified: true, reasons: [], warnings: [] },
      idempotencyBasis: { sourceFingerprintMaterial: ["authority"], artifactFingerprintMaterial: {} },
    };
    const derived = candidateToArtifact(candidate, artifact().producedBy, now);
    expect(derived.derivedAccess?.releasePolicy).toBe("delegated");
    expect(validateFeedArtifact({
      ...derived,
      derivedAccess: { ...derived.derivedAccess!, releasePolicy: "public" },
    }).ok).toBe(false);
    expect(validateFeedArtifact({
      ...derived,
      sourceRefs: [{
        ...publicSource,
        authority: { ...publicSource.authority!, authHeader: "secret" },
      }],
    }).ok).toBe(false);
  });

  test("enforces explicit Feed surface modes while retaining absent-mode compatibility", () => {
    const base: CandidateArtifactEnvelope = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "surface",
      artifactType: "report",
      renderShape: "longform",
      title: "Surface",
      body: {},
      sourceRefs: [source()],
      quality: { criticPass: true, quotesVerified: true, reasons: [], warnings: [] },
      idempotencyBasis: { sourceFingerprintMaterial: ["surface"], artifactFingerprintMaterial: {} },
    };
    expect(validateSkillRunOutput({ candidates: [base], trace: {
      procedureVersion: "legacy", modelCalls: 0, toolCalls: [], stageTrace: [], droppedCandidates: [],
    } }).ok).toBe(true);
    expect(validateCandidateArtifactEnvelope(base, { context: "new_workflow_execution" }).ok).toBe(false);
    expect(() => candidateToArtifact({ ...base, feedSurface: { mode: "posts" } }, artifact().producedBy, now)).toThrow(
      /posts requires/,
    );
    expect(() => candidateToArtifact({
      ...base,
      feedSurface: { mode: "artifact_preview" },
      posts: [{
        kind: "insight",
        body: "Unexpected post",
        evidence: [{ kind: "located_source", evidenceId: "e1", sourceRefId: "src-1", loc: "L1" }],
      }],
    }, artifact().producedBy, now)).toThrow(/must not include posts/);
    expect(candidateToArtifact({ ...base, feedSurface: { mode: "none" } }, artifact().producedBy, now).feedSurface).toEqual({ mode: "none" });
  });

  test("composes trusted parent authority with transcript authority and detects access tampering", () => {
    const publicSource: TranscriptSourceRef = {
      ...source(),
      authority: { lineageId: "cid:transcript", releasePolicy: "public" },
    };
    const parentRef = {
      kind: "feed_artifact" as const,
      artifactId: "artifact-private-parent",
      artifactType: "research_report",
      observedHash: "sha256:private-parent",
      observedAt: now,
    };
    const parentAccess = {
      releasePolicy: "delegated" as const,
      lineage: [{
        sourceRefId: "src-parent",
        lineageId: "cid:parent-private",
        releasePolicy: "delegated" as const,
      }],
      parentArtifacts: [],
      audienceDids: ["did:example:b", "did:example:a"],
      expiresAt: "2026-06-29T00:00:00.000Z",
    };
    const candidate: CandidateArtifactEnvelope = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "parent-authority",
      artifactType: "synthesis",
      renderShape: "longform",
      title: "Restricted synthesis",
      body: {},
      sourceRefs: [publicSource],
      parentArtifactRefs: [parentRef],
      feedSurface: { mode: "artifact_preview" },
      quality: { criticPass: true, quotesVerified: true, reasons: [], warnings: [] },
      idempotencyBasis: { sourceFingerprintMaterial: ["parent"], artifactFingerprintMaterial: {} },
    };
    const derived = candidateToArtifact(candidate, artifact().producedBy, now, {
      verifiedQuotes: [],
      trustedSourceRefs: [publicSource],
      trustedParentArtifacts: [{ ref: parentRef, derivedAccess: parentAccess }],
    });
    expect(derived.derivedAccess).toMatchObject({
      releasePolicy: "delegated",
      audienceDids: ["did:example:a", "did:example:b"],
      expiresAt: "2026-06-29T00:00:00.000Z",
      parentArtifacts: [{
        artifactId: "artifact-private-parent",
        releasePolicy: "delegated",
        lineageIds: ["cid:parent-private"],
      }],
    });
    expect(validateFeedArtifact(derived).ok).toBe(true);
    expect(validateFeedArtifact({
      ...derived,
      derivedAccess: { ...derived.derivedAccess!, audienceDids: ["did:example:attacker"] },
    }).ok).toBe(false);
    expect(validateFeedArtifact({
      ...derived,
      parentArtifactRefs: derived.parentArtifactRefs?.map((parent) => ({
        ...parent,
        derivedAccess: { ...parent.derivedAccess!, releasePolicy: "public" },
      })),
    }).ok).toBe(false);
    expect(validateFeedArtifact({
      ...derived,
      parentArtifactRefs: derived.parentArtifactRefs?.map(({ derivedAccess: _removed, ...parent }) => parent),
    }).ok).toBe(false);
  });

  test("enforces deterministic generous FeedPost title and body boundaries", () => {
    const candidateFor = (title: string, body: string): CandidateArtifactEnvelope => ({
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "bounds",
      artifactType: "report",
      renderShape: "longform",
      title: "Bounds",
      body: {},
      sourceRefs: [source()],
      feedSurface: { mode: "posts" },
      posts: [{
        kind: "insight",
        title,
        body,
        evidence: [{ kind: "located_source", evidenceId: "e1", sourceRefId: "src-1", loc: "L1" }],
      }],
      quality: { criticPass: true, quotesVerified: true, reasons: [], warnings: [] },
      idempotencyBasis: { sourceFingerprintMaterial: ["bounds"], artifactFingerprintMaterial: {} },
    });
    expect(validateSkillRunOutput({ candidates: [candidateFor(
      "t".repeat(FEED_POST_TITLE_MAX_CHARS),
      "😀".repeat(FEED_POST_BODY_MAX_CHARS),
    )], trace: { procedureVersion: "bounds", modelCalls: 0, toolCalls: [], stageTrace: [], droppedCandidates: [] } }).ok).toBe(true);
    expect(validateSkillRunOutput({ candidates: [candidateFor(
      "t".repeat(FEED_POST_TITLE_MAX_CHARS + 1),
      "body",
    )], trace: { procedureVersion: "bounds", modelCalls: 0, toolCalls: [], stageTrace: [], droppedCandidates: [] } }).ok).toBe(false);
    expect(validateSkillRunOutput({ candidates: [candidateFor(
      "title",
      "b".repeat(FEED_POST_BODY_MAX_CHARS + 1),
    )], trace: { procedureVersion: "bounds", modelCalls: 0, toolCalls: [], stageTrace: [], droppedCandidates: [] } }).ok).toBe(false);
  });
});

describe("Feed v1 schema and bootstrap", () => {
  test("declares app-kit schema resources with migration apply plans", () => {
    assertFeedV1SchemaUsesMigrations();
    const plans = feedV1MigrationApplyPlans();
    expect(plans.map((plan) => plan.dbName)).toEqual(["artifacts_index", "feed_index"]);
    expect(plans.map((plan) => plan.dbPath)).toEqual([
      "xyz.tinycloud.artifacts/index",
      "xyz.tinycloud.feed/index",
    ]);
    expect(plans[0]!.namespace).toBe("xyz.tinycloud.artifacts.index");
    expect(plans[1]!.namespace).toBe("xyz.tinycloud.feed.index");
    expect(plans[0]!.migrations[0]!.sql.some((sql) => sql.includes("artifact_index"))).toBe(true);
    expect(plans[1]!.migrations[0]!.sql.some((sql) => sql.includes("feed_artifact_projection"))).toBe(true);
    expect(plans[1]!.migrations[1]!.sql.some((sql) => sql.includes("feed_item_projection"))).toBe(true);
    expect(
      FEED_V1_APP_SCHEMA.resources.sql.every((resource) =>
        resource.capabilities.includes("tinycloud.sql/schema"),
      ),
    ).toBe(true);
    expect(
      plans.some((plan) =>
        plan.migrations.some((migration) =>
          migration.sql.some((sql) => /^CREATE\s+(UNIQUE\s+)?INDEX/i.test(sql)),
        ),
      ),
    ).toBe(false);
  });

  test("uses the spec's canonical Feed/Artifacts resource split", () => {
    expect(FEED_V1_ARTIFACTS_INDEX_DB_PATH).toBe("xyz.tinycloud.artifacts/index");
    expect(FEED_V1_FEED_INDEX_DB_PATH).toBe("xyz.tinycloud.feed/index");
    expect(FEED_V1_ARTIFACT_DOC_PREFIX).toBe("xyz.tinycloud.artifacts/artifacts");
    expect(FEED_V1_APP_SCHEMA.resources.sql.map((resource) => [resource.namespace, resource.dbPath])).toEqual([
      ["xyz.tinycloud.artifacts", "xyz.tinycloud.artifacts/index"],
      ["xyz.tinycloud.feed", "xyz.tinycloud.feed/index"],
    ]);
  });

  test("builds deterministic seed rows for package, run, artifact, and projection", () => {
    const seed = buildGreenfieldSeed({
      pkg: pkg(),
      run: run(),
      artifact: artifact(),
      projection: projection(),
    });

    expect(seed.artifacts.map((row) => row.table)).toEqual([
      "workflow_package_state",
      "workflow_run_index",
      "artifact_index",
    ]);
    expect(seed.feed.map((row) => row.table)).toEqual(["feed_artifact_projection"]);
    expect(seed.feed[0]?.values).toMatchObject({
      artifact_id: "artifact-1",
    });
    expect(feedItemProjectionRow(itemProjection()).values).toMatchObject({
      feed_item_id: "artifact-1::post-1",
      target_kind: "post",
      artifact_id: "artifact-1",
      post_id: "post-1",
    });
    expect(seed.artifacts[2]!.values.dedupe_key).toBe("daily_digest:sha256:source");
  });
});

describe("Feed v1 provider and skill defaults", () => {
  test("starts hosted provider profiles with OpenAI and Phala", () => {
    expect(FEED_V1_PROVIDER_PROFILES.map((profile) => profile.providerId)).toEqual(["openai", "phala"]);
    expect(FEED_V1_PROVIDER_PROFILES.find((profile) => profile.providerId === "phala")?.verification).toBe(
      "phala_tdx",
    );
    expect(FEED_V1_PROVIDER_PROFILES.map((profile) => profile.secretRefs[0])).toEqual([
      "vault/secrets/scoped/feed/OPENAI_API_KEY",
      "vault/secrets/scoped/feed/REDPILL_API_KEY",
    ]);
  });

  test("keeps outward and media-heavy Artifactory skills gated", () => {
    const byId = Object.fromEntries(FEED_V1_SKILL_OPTIONS.map((option) => [option.skillId, option]));
    expect(byId["extract-insights"]?.tier).toBe("default_internal");
    expect(byId["person-brief"]?.tier).toBe("on_demand");
    expect(byId["quote-card"]?.autoPublish).toBe(false);
    expect(byId["make-clip"]?.tier).toBe("budget_provider_gated");
  });
});
