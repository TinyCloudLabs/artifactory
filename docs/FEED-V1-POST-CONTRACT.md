# Feed v1 artifact posts

Feed is a stream of small posts backed by richer artifacts. A workflow may
produce any artifact type and keep its type-specific structure in `body`; it
may also expose one or more top-level `posts` that Feed can rank
independently. Opening a post follows its `expansionTarget.artifactId` and,
only when the artifact declares it in `renderHints.sectionIds`, an optional
`sectionId`.

Artifact posts are an additive `feed.artifact.v1` extension. Old documents
without `posts` remain valid. Present arrays must be non-empty and valid.

## Normative identity and construction

`canonicalFeedPostIdentity` is the normative producer/consumer function. It:

1. allowlists `kind`, `title`, `body`, and typed `evidence` fields;
2. resolves source references to `observedHash`, parent references to their
   `observedHash`, and inference support to canonical direct-evidence digests;
3. hashes normalized quote/excerpt/rationale content and location/section data,
   excluding local evidence, source, and artifact identifiers;
4. normalizes Unicode to NFC, collapses harmless whitespace, and sorts evidence;
5. hashes the stable serialization with SHA-256; and
6. returns `post:<digest>` and `sha256:<digest>`.

Evidence ordering, harmless text whitespace, artifact storage keys, and
unknown candidate fields cannot change identity. Final artifact validation
recomputes both values and rejects tampering or duplicate canonical content.
`candidateToArtifact` explicitly reconstructs allowed fields and discards any
candidate-controlled IDs, storage, media, or unknown properties.
Artifact idempotency automatically incorporates the sorted set of canonical
post fingerprints, so reordering or whitespace does not change an artifact
fingerprint while a material post change does.

Feed post kinds are extensible lowercase strings. First-party packages may use
short values such as `insight`; third parties should namespace values, for
example `acme.risk_signal`. Type-specific content remains in the artifact
`body` rather than growing the universal post contract.

Post titles are capped at 240 Unicode characters and post bodies at 4,000.
Validation counts NFC-normalized Unicode code points deterministically; the
exact boundary is accepted and one character over is rejected.

M1 is text-first. Candidate-controlled media previews are not accepted. A
future media descriptor must be stamped by a trusted worker after storage and
content verification.

## Evidence

Every post has one or more discriminated evidence records:

- `verified_quote`: a quote and optional location tied to `sourceRefs`;
- `located_source`: a required location and optional excerpt tied to
  `sourceRefs`;
- `parent_artifact`: an artifact listed in `parentArtifactRefs`; or
- `analytic_inference`: a rationale directly supported by one or more
  non-inference evidence IDs in the same post.

Evidence IDs are unique per post. Locations must match `quoteLineRefs` when
the source supplies that list. Candidate `quality` and `sourceQuotes` fields are
never verification authority. The runtime deterministically normalized-matches
every `verified_quote` against worker-held `sourcePack.excerpts`; unmatched
posts are dropped. Artifact construction requires that trusted runtime result
and persists `worker_source_quote_match` plus the verified source
`observedHash`; final validation rejects absent or mismatched proof. Parent IDs
and source IDs must be present in the candidate pack and final artifact.

## Feed-owned projection and interaction targets

Artifactory emits artifacts and posts. Feed owns materialization, ranking,
dual writes, and reconciliation of `FeedItemProjection` rows. A row targets
either:

- `{ kind: "post", artifactId, postId }`; or
- `{ kind: "artifact_preview", artifactId }`.

Typed artifact-to-artifact relationships remain on the artifact through
`parentArtifactRefs` (`artifactId`, `artifactType`, and optional observed hash).
The Feed projection does not own or duplicate that relationship graph.

## Authority and surface policy

Source refs may carry non-secret authority lineage metadata: a lineage ID,
release policy (`private`, `delegated`, or `public`), optional grantor DID,
allowed audience DIDs, and expiry. Bearers, private keys, authorization headers,
and raw delegation payloads are rejected from this structure.

Listen workflows name a registered input authority; workflow JSON never carries
a share link, portable delegation, embedded JWK, or parent bearer. The registry
holds a constrained child `PortableDelegation` and an agent-key reference.
The default registry is a JSON object keyed by authority name at
`ARTIFACTORY_SOURCE_AUTHORITY_REGISTRY`; deployments may inject the equivalent
trusted registry resolver.
Before SDK activation, Artifactory verifies active/revoked state, host, child
lineage, agent audience, expiry, space, and the exact read-only Listen grants
(`sql/read` on conversations and `kv/get` only on
`xyz.tinycloud.listen/transcript/`). The registered expected parent CID must
match the child exactly. The SDK then
activates the signed delegation and Artifactory confirms the activated space.
Registry status, identity, and current expiry are resolved again immediately
before every SQL or KV read, so a mid-run revoke or expiry stops consumption.
Each input authority remains named and separate from artifact/output authority.
Only its non-secret lineage and access policy enter `TranscriptSourceRef`.

The worker reconstructs published source refs from its trusted source pack and
derives the artifact's `derivedAccess` from transcript sources plus the
`derivedAccess` carried by every referenced artifact-pack input. Missing lineage
defaults to private; mixed inputs use the most restrictive release policy,
intersect restricted audiences, and select the earliest expiry. Final artifact
validation recomputes this policy, preventing a workflow from relaxing source
or parent-artifact restrictions.

Before dispatch, Artifactory strictly validates each artifact-pack ref and
record as a one-to-one pair. The ref's `observedHash` is the canonical SHA-256
of the complete artifact input, including `derivedAccess`; mismatched content,
missing or malformed access, duplicate IDs, and type mismatches fail admission.
The pack reference itself is part of the reviewed workflow digest, and the
referenced canonical JSON material is part of the admitted package digest. The
loader keeps that compiled material digest outside the mutable workflow fixture
and rehashes the exact pack immediately before execution. The runtime receives a separate
clone from the worker-held trusted binding.

New workflow output declares `feedSurface.mode` as `posts`,
`artifact_preview`, or `none`. Posts mode requires at least one post; preview
and none modes prohibit posts. New Artifactory execution uses the explicit
`new_workflow_execution` validation context and rejects an absent mode. Absence
remains valid only at the stored-v1 compatibility boundary for documents
produced before this field.

New post items derive `feedItemId` as
`artifactId + "::" + encodeURIComponent(postId)`. Legacy artifact-only rows
use `feedItemId = "legacy:" + artifactId`, target `artifact_preview`, and a
SQL `NULL` post ID. They never pretend a dangling post exists.

Existing artifact-level `FeedbackEvent` remains valid. New targeted
interactions use a `FeedInteractionTarget` for an artifact, post, or feed
item and persist separately in `feed_targeted_interaction_event` during the
compatibility window.

`validateFeedItemProjection` recomputes item IDs and can verify artifact/post
joins against hydrated artifacts. `validateFeedTargetedInteractionEvent`
enforces the target union, signal allowlist, and optional artifact/feed-item
joins. Feed must call these validators (or generated equivalents from this
canonical Artifactory-owned contract) at hydration and write boundaries.

## Rolling migration

Migration `002_post_feed_items` is additive: it leaves
`feed_artifact_projection` and `feedback_event` intact, creates the Feed-owned
`feed_item_projection` and targeted interaction table, and performs an initial
artifact-preview reconciliation.

Deployment order:

1. Apply migration 002 everywhere.
2. Feed dual-reads the old and new tables, deduplicating a legacy item by its
   artifact ID.
3. Feed dual-writes old artifact-level behavior and the new target-aware rows.
4. While any old writer exists, repeatedly run
   `FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL`. It upserts both late inserts
   and later ranking/disposition updates, but never overwrites a new-table row
   whose `updated_at` is newer.
5. After all writers and readers use the target-aware contract, stop legacy
   writes and require `FEED_V1_LEGACY_PROJECTION_PARITY_SQL` to report zero
   mismatches before removing the old read path in a later migration.

Rollback before step 5 is safe: old readers and writers continue using the
untouched tables, and the additive new tables may be ignored.

Feed owns the actual startup and scheduled reconciliation loop, partial
dual-write recovery, and the parity gate required before step 5. Artifactory
owns migration tooling, the normative TypeScript contract, and the canonical
rich-artifact fixture; both repositories must consume the same contract fixture
and `feed-post-identity-vectors.json`, or assert identical vendored digests until a
published shared package exists.
