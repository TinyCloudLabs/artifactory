// Feed v1 contracts owned by Artifactory for M0.
//
// This module intentionally mirrors the handoff types in the Feed v1 spec
// without pulling in a schema dependency. Skill scripts and workers should be
// runnable by any Bun-capable agent with plain TypeScript.

import { createHash } from "node:crypto";

export type IsoDateString = string;
export type HashString = string;

export type RenderShape = "short_form" | "longform" | "media";
export type RuntimeClass = "feed_hosted" | "hosted_private" | "local" | "stub";
export type ProviderClass = "first_party" | "user_byok" | "local" | "none";
export type CredentialMode = "feed_hosted" | "user_byok_api_key" | "user_oauth_token" | "none";
export type EgressClass = "none" | "model_provider" | "media_provider" | "tool_provider";
export type SpendClass = "none" | "model" | "media" | "tool";

// FeedPost kinds are intentionally extensible. First-party packages use simple
// names (for example "insight"), while third parties should use a namespaced
// value (for example "acme.risk_signal").
export type FeedPostKind = string;
export const FEED_POST_TITLE_MAX_CHARS = 240;
export const FEED_POST_BODY_MAX_CHARS = 4_000;

export type VerifiedQuoteEvidence = {
  kind: "verified_quote";
  evidenceId: string;
  sourceRefId: string;
  quote: string;
  loc?: string;
  verification: {
    method: "worker_source_quote_match";
    sourceObservedHash: HashString;
  };
};

export type LocatedSourceEvidence = {
  kind: "located_source";
  evidenceId: string;
  sourceRefId: string;
  loc: string;
  excerpt?: string;
};

export type ParentArtifactEvidence = {
  kind: "parent_artifact";
  evidenceId: string;
  artifactId: string;
  sectionId?: string;
};

export type AnalyticInferenceEvidence = {
  kind: "analytic_inference";
  evidenceId: string;
  rationale: string;
  supportedBy: string[];
};

export type FeedPostEvidence =
  | VerifiedQuoteEvidence
  | LocatedSourceEvidence
  | ParentArtifactEvidence
  | AnalyticInferenceEvidence;

export type CandidateVerifiedQuoteEvidence = Omit<VerifiedQuoteEvidence, "verification">;
export type CandidateFeedPostEvidence =
  | CandidateVerifiedQuoteEvidence
  | LocatedSourceEvidence
  | ParentArtifactEvidence
  | AnalyticInferenceEvidence;

export type FeedPost = {
  postId: string;
  postFingerprint: HashString;
  kind: FeedPostKind;
  title?: string;
  body: string;
  evidence: FeedPostEvidence[];
  expansionTarget: {
    artifactId: string;
    sectionId?: string;
  };
};

export type CandidateFeedPost = Pick<FeedPost, "kind" | "title" | "body"> & {
  evidence: CandidateFeedPostEvidence[];
  sectionId?: string;
};

export type TrustedCandidateVerification = {
  verifiedQuotes: Array<{
    evidenceId: string;
    sourceRefId: string;
    sourceObservedHash: HashString;
    quoteHash: HashString;
  }>;
  trustedSourceRefs?: TranscriptSourceRef[];
  trustedParentArtifacts?: Array<{
    ref: ArtifactInputRef;
    derivedAccess: DerivedAccessPolicy;
  }>;
};

export type CanonicalFeedPostIdentityContext = {
  sourceRefs: TranscriptSourceRef[];
  parentArtifactRefs?: Array<{ artifactId: string; observedHash?: HashString }>;
};

export type ExternalRuntimeCapability = {
  kind: "model" | "media_generation" | "web_search" | "provider_tool";
  provider: string;
  credentialMode: CredentialMode;
  scopes: string[];
  spendClass: SpendClass;
  egressClass: EgressClass;
};

export type RuntimePolicy = {
  runtimeClass: RuntimeClass;
  providerClass: ProviderClass;
  credentialMode: CredentialMode;
  egressClass: EgressClass;
  allowedTools: string[];
  disallowedTools: string[];
  maxModelCalls: number;
  timeoutMs: number;
  maxOutputBytes: number;
  budgetId?: string;
  externalCapabilities?: ExternalRuntimeCapability[];
};

export type TranscriptSourceRef = {
  sourceRefId: string;
  sourceKind: "listen_conversation";
  sourceId: string;
  observedPath: "kv_transcript" | "sql_transcript_json" | "sql_transcript_text" | "host_source_api";
  observedHash: HashString;
  observedAt: IsoDateString;
  quoteLineRefs?: string[];
  authority?: {
    lineageId: string;
    releasePolicy: "private" | "delegated" | "public";
    grantorDid?: string;
    audienceDids?: string[];
    expiresAt?: IsoDateString;
  };
};

export type DerivedAccessPolicy = {
  releasePolicy: "private" | "delegated" | "public";
  lineage: Array<{
    sourceRefId: string;
    lineageId: string | null;
    releasePolicy: "private" | "delegated" | "public";
  }>;
  parentArtifacts: Array<{
    artifactId: string;
    releasePolicy: "private" | "delegated" | "public";
    lineageIds: string[];
  }>;
  audienceDids: string[];
  expiresAt?: IsoDateString;
};

export function deriveAccessPolicy(
  sourceRefs: TranscriptSourceRef[],
  parentArtifacts: Array<{ artifactId: string; derivedAccess: DerivedAccessPolicy }> = [],
): DerivedAccessPolicy {
  const rank = { private: 0, delegated: 1, public: 2 } as const;
  const policies = [
    ...sourceRefs.map((source) => source.authority?.releasePolicy ?? "private"),
    ...parentArtifacts.map((parent) => parent.derivedAccess.releasePolicy),
  ];
  const releasePolicy = policies.reduce<DerivedAccessPolicy["releasePolicy"]>(
    (current, policy) => rank[policy] < rank[current] ? policy : current,
    "public",
  );
  const restrictedAudiences = [
    ...sourceRefs
      .filter((source) => (source.authority?.releasePolicy ?? "private") !== "public")
      .map((source) => source.authority?.audienceDids),
    ...parentArtifacts
      .filter((parent) => parent.derivedAccess.releasePolicy !== "public")
      .map((parent) => parent.derivedAccess.audienceDids),
  ];
  let audienceDids: string[] = [];
  if (restrictedAudiences.length > 0 && restrictedAudiences.every(Array.isArray)) {
    audienceDids = [...new Set(restrictedAudiences[0]!)].sort();
    for (const audience of restrictedAudiences.slice(1)) {
      const allowed = new Set(audience!);
      audienceDids = audienceDids.filter((did) => allowed.has(did));
    }
  }
  const expiries = [
    ...sourceRefs.flatMap((source) => source.authority?.expiresAt ? [source.authority.expiresAt] : []),
    ...parentArtifacts.flatMap((parent) => parent.derivedAccess.expiresAt ? [parent.derivedAccess.expiresAt] : []),
  ]
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return {
    releasePolicy,
    lineage: sourceRefs.map((source) => ({
      sourceRefId: source.sourceRefId,
      lineageId: source.authority?.lineageId ?? null,
      releasePolicy: source.authority?.releasePolicy ?? "private",
    })).sort((left, right) => left.sourceRefId.localeCompare(right.sourceRefId)),
    parentArtifacts: parentArtifacts.map((parent) => ({
      artifactId: parent.artifactId,
      releasePolicy: parent.derivedAccess.releasePolicy,
      lineageIds: parent.derivedAccess.lineage
        .flatMap((entry) => entry.lineageId ? [entry.lineageId] : [])
        .sort(),
    })).sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
    audienceDids,
    expiresAt: expiries[0],
  };
}

export type WorkflowDisclosure = {
  userCopy: string;
  credentialOwner: CredentialMode;
  providerClass: ProviderClass;
  egressClass: EgressClass;
};

// Human-readable routine copy for workflow controls (TC-182). Presentation is
// display-only: it never grants or describes authority, and stays separate
// from the runtime/authority fields on FeedWorkflowPackage. Every field is
// plain user language — no hashes, DIDs, cron, or capability paths.
export type WorkflowPresentation = {
  schemaVersion: "feed.workflow_presentation.v1";
  // One or two sentences on what this routine makes for the user.
  purpose: string;
  // When it runs, in user language ("Runs once a day").
  triggerLabel: string;
  // Cadence copy shown next to controls ("Daily", "As new content arrives").
  cadenceLabel: string;
  // What it reads, in user language ("New conversations you've authorized").
  sourcesLabel: string;
  // Who sees the output ("Private to you").
  audienceLabel: string;
  // Short sample output titles so an unrun routine still feels concrete.
  exampleTitles: string[];
};

export type FeedWorkflowPackage = {
  schemaVersion: "feed.workflow_package.v1";
  packageId: string;
  displayName: string;
  version: string;
  digest: HashString;
  manifestKey: string;
  workflowRef: string;
  workflowDigest: HashString;
  admissionState: "candidate" | "enabled_local" | "reviewed_first_party" | "blocked";
  disclosure: WorkflowDisclosure;
  // Optional so existing compiled packages and stored rows stay valid.
  presentation?: WorkflowPresentation;
};

export type FeedArtifact = {
  schemaVersion: "feed.artifact.v1";
  artifactId: string;
  artifactType: string;
  renderShape: RenderShape;
  title: string;
  summary?: string;
  body: unknown;
  renderHints?: Record<string, unknown>;
  sourceRefs: TranscriptSourceRef[];
  feedSurface?: { mode: "posts" | "artifact_preview" | "none" };
  derivedAccess?: DerivedAccessPolicy;
  /**
   * Additive v1 extension. Existing feed.artifact.v1 documents without this
   * field remain valid; when present it must be a non-empty array of fully
   * evidence-backed posts.
   */
  posts?: FeedPost[];
  parentArtifactRefs?: Array<{
    artifactId: string;
    artifactType: string;
    observedHash?: HashString;
    derivedAccess?: DerivedAccessPolicy;
  }>;
  producedBy: {
    packageId: string;
    packageVersion: string;
    packageDigest: string;
    runId: string;
    runtimeClass: RuntimeClass;
    providerClass: ProviderClass;
    credentialOwner: CredentialMode;
    egressClass: EgressClass;
    disclosure: WorkflowDisclosure;
  };
  freshness: {
    label: "fresh" | "as_of" | "stale" | "source_unavailable" | "source_revoked";
    asOf: IsoDateString;
    lastCheckedAt?: IsoDateString;
  };
  idempotency: {
    sourceFingerprint: HashString;
    artifactFingerprint: HashString;
    dedupeKey: HashString;
  };
  storage: {
    docKey: string;
    mediaKeys?: string[];
  };
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
};

export type FeedArtifactProjection = {
  artifactId: string;
  rankScore: number;
  disposition: "default" | "saved" | "hidden";
  visibility: "ranked" | "deferred" | "capped" | "hidden" | "repair_only";
  freshnessLabel: FeedArtifact["freshness"]["label"];
  reasonCodes: string[];
  packageId: string;
  sourceFingerprint: HashString;
  publishedAt: IsoDateString;
  updatedAt: IsoDateString;
};

// Shared specification for the Feed-owned projection. Artifactory emits
// artifacts/posts only; Feed materializes and ranks these rows.
export type FeedItemTarget =
  | { kind: "post"; artifactId: string; postId: string }
  | { kind: "artifact_preview"; artifactId: string };

export type FeedItemProjection = {
  feedItemId: string;
  target: FeedItemTarget;
  rankScore: number;
  disposition: "default" | "saved" | "hidden";
  visibility: "ranked" | "deferred" | "capped" | "hidden" | "repair_only";
  freshnessLabel: FeedArtifact["freshness"]["label"];
  reasonCodes: string[];
  packageId: string;
  sourceFingerprint: HashString;
  publishedAt: IsoDateString;
  updatedAt: IsoDateString;
};

export function feedItemIdFor(artifactId: string, postId: string): string {
  return `${artifactId}::${encodeURIComponent(postId)}`;
}

export function artifactPreviewFeedItemIdFor(artifactId: string): string {
  return `legacy:${artifactId}`;
}

export type FeedInteractionTarget =
  | { kind: "artifact"; artifactId: string }
  | { kind: "post"; artifactId: string; postId: string }
  | { kind: "feed_item"; feedItemId: string };

export type FeedbackEvent = {
  eventId: string;
  artifactId: string;
  actorId: string;
  readerNonce: string;
  signal: "save" | "unsave" | "hide" | "unhide" | "helpful" | "unhelpful" | "show_fewer" | "text_note";
  payload?: unknown;
  payloadHash?: HashString;
  createdAt: IsoDateString;
};

export type FeedTargetedInteractionEvent = Omit<FeedbackEvent, "artifactId"> & {
  target: FeedInteractionTarget;
};

export type FeedProjectionValidationContext = {
  artifacts?: ReadonlyMap<string, FeedArtifact>;
};

export function validateFeedItemProjection(
  value: unknown,
  context: FeedProjectionValidationContext = {},
): ValidationResult<FeedItemProjection> {
  const projection = record(value);
  if (!projection) return { ok: false, errors: ["projection must be an object"] };
  const errors: string[] = [];
  for (const field of ["feedItemId", "disposition", "visibility", "freshnessLabel", "packageId", "sourceFingerprint"] as const) {
    if (typeof projection[field] !== "string" || projection[field].length === 0) {
      errors.push(`${field}: required string`);
    }
  }
  if (typeof projection.rankScore !== "number" || !Number.isFinite(projection.rankScore)) {
    errors.push("rankScore: required finite number");
  }
  if (!isStringArray(projection.reasonCodes)) errors.push("reasonCodes: required string array");
  addIso(errors, projection.publishedAt, "publishedAt");
  addIso(errors, projection.updatedAt, "updatedAt");
  if (!["default", "saved", "hidden"].includes(String(projection.disposition))) {
    errors.push("disposition: invalid disposition");
  }
  if (!["ranked", "deferred", "capped", "hidden", "repair_only"].includes(String(projection.visibility))) {
    errors.push("visibility: invalid visibility");
  }
  const target = record(projection.target);
  if (!target || typeof target.artifactId !== "string" || target.artifactId.length === 0) {
    errors.push("target.artifactId: required string");
  } else if (target.kind === "post") {
    if (Object.keys(target).some((key) => !["kind", "artifactId", "postId"].includes(key))) {
      errors.push("target: post contains unsupported fields");
    }
    if (typeof target.postId !== "string" || target.postId.length === 0) {
      errors.push("target.postId: required string");
    } else if (projection.feedItemId !== feedItemIdFor(target.artifactId, target.postId)) {
      errors.push("feedItemId: must match canonical post feed item id");
    }
    const artifact = context.artifacts?.get(target.artifactId);
    if (artifact && !artifact.posts?.some((post) => post.postId === target.postId)) {
      errors.push("target.postId: must join to the target artifact");
    }
  } else if (target.kind === "artifact_preview") {
    if (Object.keys(target).some((key) => !["kind", "artifactId"].includes(key))) {
      errors.push("target: artifact preview contains unsupported fields");
    }
    if (target.postId !== undefined) errors.push("target.postId: artifact preview must not name a post");
    if (projection.feedItemId !== artifactPreviewFeedItemIdFor(target.artifactId)) {
      errors.push("feedItemId: must match canonical artifact preview id");
    }
  } else {
    errors.push("target.kind: invalid target kind");
  }
  if (target && typeof target.artifactId === "string" && context.artifacts && !context.artifacts.has(target.artifactId)) {
    errors.push("target.artifactId: must join to an available artifact");
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: projection as unknown as FeedItemProjection };
}

export type FeedInteractionValidationContext = {
  artifacts?: ReadonlySet<string>;
  feedItems?: ReadonlyMap<string, FeedItemProjection>;
};

export function validateFeedTargetedInteractionEvent(
  value: unknown,
  context: FeedInteractionValidationContext = {},
): ValidationResult<FeedTargetedInteractionEvent> {
  const event = record(value);
  if (!event) return { ok: false, errors: ["interaction must be an object"] };
  const errors: string[] = [];
  for (const field of ["eventId", "actorId", "readerNonce", "signal"] as const) {
    if (typeof event[field] !== "string" || event[field].length === 0) errors.push(`${field}: required string`);
  }
  const signals: FeedbackEvent["signal"][] = [
    "save", "unsave", "hide", "unhide", "helpful", "unhelpful", "show_fewer", "text_note",
  ];
  if (!signals.includes(event.signal as FeedbackEvent["signal"])) errors.push("signal: invalid feedback signal");
  addIso(errors, event.createdAt, "createdAt");
  const target = record(event.target);
  if (!target) {
    errors.push("target: required object");
  } else if (target.kind === "artifact") {
    if (Object.keys(target).some((key) => !["kind", "artifactId"].includes(key))) {
      errors.push("target: artifact contains unsupported fields");
    }
    if (typeof target.artifactId !== "string" || target.artifactId.length === 0) {
      errors.push("target.artifactId: required string");
    } else if (context.artifacts && !context.artifacts.has(target.artifactId)) {
      errors.push("target.artifactId: must join to an available artifact");
    }
  } else if (target.kind === "post") {
    if (Object.keys(target).some((key) => !["kind", "artifactId", "postId"].includes(key))) {
      errors.push("target: post contains unsupported fields");
    }
    if (typeof target.artifactId !== "string" || typeof target.postId !== "string") {
      errors.push("target: post requires artifactId and postId");
    } else {
      const feedItem = context.feedItems?.get(feedItemIdFor(target.artifactId, target.postId));
      if (context.feedItems && (!feedItem || feedItem.target.kind !== "post")) {
        errors.push("target: post must join to an available feed item");
      }
    }
  } else if (target.kind === "feed_item") {
    if (Object.keys(target).some((key) => !["kind", "feedItemId"].includes(key))) {
      errors.push("target: feed item contains unsupported fields");
    }
    if (typeof target.feedItemId !== "string" || target.feedItemId.length === 0) {
      errors.push("target.feedItemId: required string");
    } else if (context.feedItems && !context.feedItems.has(target.feedItemId)) {
      errors.push("target.feedItemId: must join to an available feed item");
    }
  } else {
    errors.push("target.kind: invalid target kind");
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: event as unknown as FeedTargetedInteractionEvent };
}

export type GenerationRequest = {
  requestId: string;
  actorId: string;
  readerNonce: string;
  status: "accepted" | "pending" | "blocked" | "rejected" | "consumed" | "expired";
  scope: { artifactType?: string; packageId?: string; sourceRefId?: string };
  prompt?: string;
  dedupeKey?: HashString;
  expiresAt: IsoDateString;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
};

export type ControlIntentEvent = {
  eventId: string;
  actorId: string;
  readerNonce: string;
  intentKind:
    | "enable_package"
    | "pause_package"
    | "disable_package"
    | "tune_package"
    | "reset_package"
    | "generate_new_request"
    | "ask_feed";
  status: "accepted" | "pending" | "blocked" | "rejected" | "consumed";
  targetRef: string;
  payload?: unknown;
  payloadHash?: HashString;
  createdAt: IsoDateString;
};

export type FeedWorkflowRun = {
  schemaVersion: "feed.workflow_run.v1";
  runId: string;
  packageId: string;
  packageDigest: HashString;
  status:
    | "queued"
    | "running"
    | "validating"
    | "published"
    | "zero_artifacts"
    | "blocked_authority"
    | "blocked_secret"
    | "blocked_budget"
    | "failed_runtime"
    | "failed_validation"
    | "cancelled"
    | "stale";
  sourceRefs: TranscriptSourceRef[];
  publishedArtifactIds: string[];
  droppedCandidates: { reason: string; title?: string; localCandidateId?: string }[];
  spend: { budgetId?: string; amount?: number; currency?: string };
  error?: { code: string; message: string };
  startedAt: IsoDateString;
  finishedAt?: IsoDateString;
};

export type ArtifactorySkillManifest = {
  schemaVersion: "feed.skill_manifest.v1";
  packageId: string;
  displayName: string;
  version: string;
  digest: HashString;
  source: "first_party" | "user_local" | "generated" | "imported";
  tier: 1 | 2;
  admissionState: FeedWorkflowPackage["admissionState"];
  artifactTypes: string[];
  renderShapes: RenderShape[];
  outputSchemaRef: string;
  settingsSchemaRef?: string;
  validatorRefs: string[];
  evaluatorRefs: string[];
  workflowRef: string;
  workflowDigest: HashString;
  workflowExecutor: "smithers" | "stub";
  stageCapabilities: {
    stageId: string;
    capabilities: string[];
    authority: "none" | "worker_run_stage_scope";
    egressClass?: EgressClass;
    spendClass?: SpendClass;
  }[];
  runtimePolicy: RuntimePolicy;
  limits: {
    maxAcceptedArtifacts: number;
    timeoutMs: number;
    maxOutputBytes: number;
    maxModelCalls: number;
    maxSourceRefs: number;
    maxInputTokens: number;
  };
  disclosure: WorkflowDisclosure;
};

export type ArtifactInputRef = {
  kind: "feed_artifact";
  artifactId: string;
  artifactType: string;
  observedHash?: HashString;
  observedAt: IsoDateString;
};

export type SkillExecutionBundle = {
  schemaVersion: "feed.skill_execution_bundle.v1";
  packageDigest: HashString;
  bundleDigest: HashString;
  instructions: string;
  instructionsDigest: HashString;
  outputSchema: unknown;
  outputSchemaRef: string;
  evaluators: Array<{
    ref: string;
    instructions: string;
    digest: HashString;
  }>;
  materialDigests: Array<{
    path: string;
    kind: "json" | "toml" | "text" | "binary";
    digest: HashString;
  }>;
  validation: {
    requireQuoteAnchoring: boolean;
  };
};

export type SkillRequestContext = {
  scope: GenerationRequest["scope"];
  prompt?: string;
};

export type SkillRunInput = {
  runId: string;
  skillManifest: ArtifactorySkillManifest;
  executionBundle?: SkillExecutionBundle;
  requestContext?: SkillRequestContext;
  sourcePack: {
    refs: TranscriptSourceRef[];
    excerpts: { sourceRefId: string; text: string; quoteLineRefs?: string[] }[];
    maxInputTokens: number;
  };
  artifactPack?: {
    refs: ArtifactInputRef[];
    artifacts: {
      artifactId: string;
      artifactType: string;
      title: string;
      summary?: string;
      body: unknown;
      sourceRefs: TranscriptSourceRef[];
      derivedAccess: DerivedAccessPolicy;
      producedBy: FeedArtifact["producedBy"];
    }[];
    maxInputTokens: number;
  };
  settings: unknown;
  runtimePolicy: RuntimePolicy;
  secretEnv?: {
    name: string;
    secretRef?: string;
    injection: "env";
    stageId: string;
    source: "worker_injected";
  }[];
  priorContext?: {
    recentArtifacts?: Pick<FeedArtifact, "artifactId" | "artifactType" | "title" | "idempotency">[];
    generationRequests?: GenerationRequest[];
  };
};

export type CandidateArtifactEnvelope = {
  schemaVersion: "feed.candidate_artifact.v1";
  localCandidateId: string;
  artifactType: string;
  renderShape: FeedArtifact["renderShape"];
  title: string;
  summary?: string;
  body: unknown;
  renderHints?: FeedArtifact["renderHints"];
  sourceRefs: TranscriptSourceRef[];
  feedSurface?: FeedArtifact["feedSurface"];
  posts?: CandidateFeedPost[];
  parentArtifactRefs?: ArtifactInputRef[];
  sourceQuotes?: { quote: string; sourceRefId: string; loc?: string }[];
  quality: {
    criticPass: boolean;
    quotesVerified: boolean;
    reasons: string[];
    warnings: string[];
  };
  // Candidates carry fingerprint material only. The Worker seam
  // (candidateToArtifact) derives durable idempotency keys and storage keys;
  // skill output never assigns them (spec §Runtime Contract).
  idempotencyBasis: {
    sourceFingerprintMaterial: string[];
    artifactFingerprintMaterial: unknown;
  };
};

export type SkillRunTrace = {
  procedureVersion: string;
  modelCalls: number;
  toolCalls: { name: string; purpose: string }[];
  stageTrace: {
    stageId: string;
    declaredCapabilities: string[];
    grantedCapabilities: string[];
    authorityUsed: boolean;
    deniedReasons: string[];
  }[];
  droppedCandidates: { reason: string; title?: string; localCandidateId?: string }[];
};

export type SkillRunOutput = {
  candidates: CandidateArtifactEnvelope[];
  trace: SkillRunTrace;
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type FieldType = "string" | "number" | "boolean" | "array" | "object";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeIdentityText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalEvidenceTextHash(value: string): HashString {
  return `sha256:${createHash("sha256").update(normalizeIdentityText(value)).digest("hex")}`;
}

function identityHash(value: string): HashString {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalDirectEvidence(
  value: CandidateFeedPostEvidence | FeedPostEvidence,
  context: CanonicalFeedPostIdentityContext,
): Record<string, unknown> | null {
  switch (value.kind) {
    case "verified_quote": {
      const source = context.sourceRefs.find((ref) => ref.sourceRefId === value.sourceRefId);
      if (!source) throw new Error("verified quote source is not in identity context");
      return {
        kind: value.kind,
        sourceObservedHash: source.observedHash,
        quoteHash: canonicalEvidenceTextHash(value.quote),
        loc: value.loc === undefined ? undefined : normalizeIdentityText(value.loc),
      };
    }
    case "located_source": {
      const source = context.sourceRefs.find((ref) => ref.sourceRefId === value.sourceRefId);
      if (!source) throw new Error("located source is not in identity context");
      return {
        kind: value.kind,
        sourceObservedHash: source.observedHash,
        loc: normalizeIdentityText(value.loc),
        excerptHash:
          value.excerpt === undefined ? undefined : canonicalEvidenceTextHash(value.excerpt),
      };
    }
    case "parent_artifact": {
      const parent = context.parentArtifactRefs?.find((ref) => ref.artifactId === value.artifactId);
      if (!parent?.observedHash) throw new Error("parent artifact observedHash is not in identity context");
      return {
        kind: value.kind,
        parentObservedHash: parent.observedHash,
        sectionId: value.sectionId === undefined ? undefined : normalizeIdentityText(value.sectionId),
      };
    }
    case "analytic_inference":
      return null;
    default:
      throw new Error("unsupported post evidence kind");
  }
}

/** Normative, content-addressed post identity shared by producers and Feed. */
export function canonicalFeedPostIdentity(
  post: Pick<CandidateFeedPost, "kind" | "title" | "body" | "evidence"> | FeedPost,
  context: CanonicalFeedPostIdentityContext,
): { postId: string; postFingerprint: HashString } {
  const directEvidenceByLocalId = new Map<string, Record<string, unknown>>();
  for (const evidence of post.evidence) {
    const canonical = canonicalDirectEvidence(evidence, context);
    if (canonical) directEvidenceByLocalId.set(evidence.evidenceId, canonical);
  }
  const evidence = post.evidence.map((entry) => {
    const direct = directEvidenceByLocalId.get(entry.evidenceId);
    if (direct) return direct;
    if (entry.kind !== "analytic_inference") throw new Error("evidence could not be canonicalized");
    const supportedBy = entry.supportedBy.map((localId) => {
      const support = directEvidenceByLocalId.get(localId);
      if (!support) throw new Error("analytic inference support is not direct evidence");
      return identityHash(stableStringify(support));
    }).sort();
    return {
      kind: entry.kind,
      rationaleHash: canonicalEvidenceTextHash(entry.rationale),
      supportedBy,
    };
  }).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  const normalizedTitle = post.title === undefined ? undefined : normalizeIdentityText(post.title);
  const material = {
    kind: normalizeIdentityText(post.kind),
    title: normalizedTitle || undefined,
    body: normalizeIdentityText(post.body),
    evidence,
  };
  const digest = createHash("sha256").update(stableStringify(material)).digest("hex");
  return {
    postId: `post:${digest}`,
    postFingerprint: `sha256:${digest}`,
  };
}

function addRequired(errors: string[], value: Record<string, unknown>, path: string, type: FieldType): void {
  const v = value[path];
  if (type === "array") {
    if (!Array.isArray(v)) errors.push(`${path}: required array`);
    return;
  }
  if (type === "object") {
    if (record(v) === null) errors.push(`${path}: required object`);
    return;
  }
  if (typeof v !== type) errors.push(`${path}: required ${type}`);
}

function addIso(errors: string[], value: unknown, path: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${path}: required ISO date string`);
  }
}

function requireSchema<T>(value: unknown, schemaVersion: string, fields: Array<[string, FieldType]>): ValidationResult<T> {
  const obj = record(value);
  if (!obj) return { ok: false, errors: ["value must be an object"] };
  const errors: string[] = [];
  if (obj.schemaVersion !== schemaVersion) errors.push(`schemaVersion: must be ${schemaVersion}`);
  for (const [field, type] of fields) addRequired(errors, obj, field, type);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: obj as T };
}

export function validateTranscriptSourceRef(value: unknown): ValidationResult<TranscriptSourceRef> {
  const obj = record(value);
  if (!obj) return { ok: false, errors: ["source ref must be an object"] };
  const errors: string[] = [];
  for (const field of ["sourceRefId", "sourceKind", "sourceId", "observedPath", "observedHash"]) {
    addRequired(errors, obj, field, "string");
  }
  if (obj.sourceKind !== "listen_conversation") errors.push("sourceKind: must be listen_conversation");
  if (!["kv_transcript", "sql_transcript_json", "sql_transcript_text", "host_source_api"].includes(String(obj.observedPath))) {
    errors.push("observedPath: invalid transcript path kind");
  }
  addIso(errors, obj.observedAt, "observedAt");
  if (obj.authority !== undefined) {
    const authority = record(obj.authority);
    const allowedFields = new Set(["lineageId", "releasePolicy", "grantorDid", "audienceDids", "expiresAt"]);
    if (!authority) {
      errors.push("authority: must be an object");
    } else {
      if (Object.keys(authority).some((key) => !allowedFields.has(key))) {
        errors.push("authority: contains unsupported or secret-bearing fields");
      }
      if (typeof authority.lineageId !== "string" || authority.lineageId.length === 0) {
        errors.push("authority.lineageId: required string");
      }
      if (!["private", "delegated", "public"].includes(String(authority.releasePolicy))) {
        errors.push("authority.releasePolicy: invalid release policy");
      }
      if (authority.grantorDid !== undefined && typeof authority.grantorDid !== "string") {
        errors.push("authority.grantorDid: must be a string");
      }
      if (authority.audienceDids !== undefined && !isStringArray(authority.audienceDids)) {
        errors.push("authority.audienceDids: must be a string array");
      }
      if (authority.expiresAt !== undefined) addIso(errors, authority.expiresAt, "authority.expiresAt");
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: obj as TranscriptSourceRef };
}

export function validateFeedArtifact(value: unknown): ValidationResult<FeedArtifact> {
  const result = requireSchema<FeedArtifact>(value, "feed.artifact.v1", [
    ["artifactId", "string"],
    ["artifactType", "string"],
    ["renderShape", "string"],
    ["title", "string"],
    ["sourceRefs", "array"],
    ["producedBy", "object"],
    ["freshness", "object"],
    ["idempotency", "object"],
    ["storage", "object"],
    ["createdAt", "string"],
    ["updatedAt", "string"],
  ]);
  if (!result.ok) return result;
  const errors: string[] = [];
  if (!["short_form", "longform", "media"].includes(result.value.renderShape)) {
    errors.push("renderShape: invalid render shape");
  }
  if (result.value.sourceRefs.length === 0) errors.push("sourceRefs: required non-empty array");
  result.value.sourceRefs.forEach((source, i) => {
    const sourceResult = validateTranscriptSourceRef(source);
    if (!sourceResult.ok) errors.push(...sourceResult.errors.map((e) => `sourceRefs[${i}].${e}`));
  });
  validateFeedPosts(
    errors,
    result.value.posts,
    result.value.sourceRefs,
    result.value.parentArtifactRefs ?? [],
    result.value.artifactId,
    result.value.renderHints,
  );
  validateFeedSurface(errors, result.value.feedSurface, result.value.posts);
  if (result.value.feedSurface !== undefined && result.value.derivedAccess === undefined) {
    errors.push("derivedAccess: required for artifacts with an explicit Feed surface mode");
  }
  if (result.value.feedSurface !== undefined) {
    result.value.parentArtifactRefs?.forEach((parent, index) => {
      if (parent.derivedAccess === undefined) {
        errors.push(`parentArtifactRefs[${index}].derivedAccess: required for new artifacts`);
      }
    });
  }
  if (result.value.derivedAccess !== undefined) {
    const expectedAccess = deriveAccessPolicy(
      result.value.sourceRefs,
      (result.value.parentArtifactRefs ?? []).flatMap((parent) => parent.derivedAccess
        ? [{ artifactId: parent.artifactId, derivedAccess: parent.derivedAccess }]
        : []),
    );
    if (stableStringify(result.value.derivedAccess) !== stableStringify(expectedAccess)) {
      errors.push("derivedAccess: must equal the combined source authority restrictions");
    }
  }
  const mediaKeys = result.value.storage.mediaKeys;
  if (mediaKeys !== undefined && !isStringArray(mediaKeys)) {
    errors.push("storage.mediaKeys: must be a string array");
  }
  addIso(errors, result.value.createdAt, "createdAt");
  addIso(errors, result.value.updatedAt, "updatedAt");
  addIso(errors, result.value.freshness.asOf, "freshness.asOf");
  for (const field of ["sourceFingerprint", "artifactFingerprint", "dedupeKey"] as const) {
    if (!result.value.idempotency[field]) errors.push(`idempotency.${field}: required string`);
  }
  if (!result.value.storage.docKey) errors.push("storage.docKey: required string");
  return errors.length > 0 ? { ok: false, errors } : result;
}

export function validateCandidateArtifactEnvelope(
  value: unknown,
  options: { context?: "stored_v1_compat" | "new_workflow_execution" } = {},
): ValidationResult<CandidateArtifactEnvelope> {
  const result = requireSchema<CandidateArtifactEnvelope>(value, "feed.candidate_artifact.v1", [
    ["localCandidateId", "string"],
    ["artifactType", "string"],
    ["renderShape", "string"],
    ["title", "string"],
    ["sourceRefs", "array"],
    ["quality", "object"],
    ["idempotencyBasis", "object"],
  ]);
  if (!result.ok) return result;
  const errors: string[] = [];
  if (result.value.sourceRefs.length === 0) errors.push("sourceRefs: required non-empty array");
  result.value.sourceRefs.forEach((source, i) => {
    const sourceResult = validateTranscriptSourceRef(source);
    if (!sourceResult.ok) errors.push(...sourceResult.errors.map((e) => `sourceRefs[${i}].${e}`));
  });
  if (typeof result.value.quality.criticPass !== "boolean") errors.push("quality.criticPass: required boolean");
  if (typeof result.value.quality.quotesVerified !== "boolean") errors.push("quality.quotesVerified: required boolean");
  if (!isStringArray(result.value.quality.reasons)) errors.push("quality.reasons: required string array");
  if (!isStringArray(result.value.quality.warnings)) errors.push("quality.warnings: required string array");
  if (!isStringArray(result.value.idempotencyBasis.sourceFingerprintMaterial)) {
    errors.push("idempotencyBasis.sourceFingerprintMaterial: required string array");
  }
  if (!("artifactFingerprintMaterial" in result.value.idempotencyBasis)) {
    errors.push("idempotencyBasis.artifactFingerprintMaterial: required");
  }
  if (result.value.parentArtifactRefs !== undefined) {
    if (!Array.isArray(result.value.parentArtifactRefs)) {
      errors.push("parentArtifactRefs: must be an array");
    } else {
      result.value.parentArtifactRefs.forEach((ref, i) => {
        const obj = record(ref);
        if (!obj) {
          errors.push(`parentArtifactRefs[${i}]: must be an object`);
          return;
        }
        if (obj.kind !== "feed_artifact") errors.push(`parentArtifactRefs[${i}].kind: must be feed_artifact`);
        if (typeof obj.artifactId !== "string") errors.push(`parentArtifactRefs[${i}].artifactId: required string`);
        if (typeof obj.artifactType !== "string") errors.push(`parentArtifactRefs[${i}].artifactType: required string`);
        addIso(errors, obj.observedAt, `parentArtifactRefs[${i}].observedAt`);
      });
    }
  }
  validateCandidateFeedPosts(
    errors,
    result.value.posts,
    result.value.sourceRefs,
    result.value.parentArtifactRefs ?? [],
    result.value.renderHints,
  );
  if (options.context === "new_workflow_execution" && result.value.feedSurface === undefined) {
    errors.push("feedSurface: required for new workflow execution");
  }
  validateFeedSurface(errors, result.value.feedSurface, result.value.posts);
  return errors.length > 0 ? { ok: false, errors } : result;
}

function validateFeedSurface(
  errors: string[],
  surface: FeedArtifact["feedSurface"] | undefined,
  posts: FeedPost[] | CandidateFeedPost[] | undefined,
): void {
  // Absence is the additive compatibility policy for already-produced v1
  // artifacts/candidates. New workflow output declares an explicit mode.
  if (surface === undefined) return;
  const value = record(surface);
  if (!value || !["posts", "artifact_preview", "none"].includes(String(value.mode))) {
    errors.push("feedSurface.mode: must be posts, artifact_preview, or none");
    return;
  }
  if (value.mode === "posts" && (!Array.isArray(posts) || posts.length === 0)) {
    errors.push("feedSurface.mode: posts requires a non-empty posts array");
  }
  if ((value.mode === "artifact_preview" || value.mode === "none") && posts !== undefined) {
    errors.push(`feedSurface.mode: ${value.mode} must not include posts`);
  }
}

function validateCandidateFeedPosts(
  errors: string[],
  posts: CandidateFeedPost[] | undefined,
  sourceRefs: TranscriptSourceRef[],
  parentArtifactRefs: ArtifactInputRef[],
  renderHints: Record<string, unknown> | undefined,
): void {
  if (posts === undefined) return;
  validateFeedPostArray(errors, posts, sourceRefs, parentArtifactRefs, {
    renderHints,
  });
}

function validateFeedPosts(
  errors: string[],
  posts: FeedPost[] | undefined,
  sourceRefs: TranscriptSourceRef[],
  parentArtifactRefs: { artifactId: string; artifactType: string; observedHash?: HashString }[],
  artifactId: string,
  renderHints: Record<string, unknown> | undefined,
): void {
  if (posts === undefined) return;
  if (!Array.isArray(posts)) {
    errors.push("posts: must be a non-empty array when present");
    return;
  }
  validateFeedPostArray(errors, posts, sourceRefs, parentArtifactRefs, {
    artifactId,
    renderHints,
  });
  const ids = new Set<string>();
  const fingerprints = new Set<string>();
  for (const [index, value] of posts.entries()) {
    const post = record(value);
    if (!post || typeof post.postId !== "string") continue;
    if (ids.has(post.postId)) errors.push(`posts[${index}].postId: duplicate post id`);
    ids.add(post.postId);
    if (typeof post.postFingerprint === "string") {
      if (fingerprints.has(post.postFingerprint)) {
        errors.push(`posts[${index}].postFingerprint: duplicate post content`);
      }
      fingerprints.add(post.postFingerprint);
    }
  }
}

function validateFeedPostArray(
  errors: string[],
  posts: CandidateFeedPost[] | FeedPost[],
  sourceRefs: TranscriptSourceRef[],
  parentArtifactRefs: Array<{ artifactId: string }>,
  options: {
    artifactId?: string;
    renderHints?: Record<string, unknown>;
  },
): void {
  if (!Array.isArray(posts) || posts.length === 0) {
    errors.push("posts: must be a non-empty array when present");
    return;
  }
  const allowedSources = new Map(
    sourceRefs.flatMap((source) => {
      const ref = record(source);
      return typeof ref?.sourceRefId === "string" ? [[ref.sourceRefId, ref] as const] : [];
    }),
  );
  const allowedParents = new Map(
    parentArtifactRefs.flatMap((value) => {
      const ref = record(value);
      return typeof ref?.artifactId === "string" ? [[ref.artifactId, ref] as const] : [];
    }),
  );
  const allowedSectionIds = new Set(
    isStringArray(options.renderHints?.sectionIds) ? options.renderHints.sectionIds : [],
  );
  const candidateFingerprints = new Set<string>();
  posts.forEach((value, index) => {
    const post = record(value);
    if (!post) {
      errors.push(`posts[${index}]: must be an object`);
      return;
    }
    if (typeof post.kind !== "string" || !/^[a-z][a-z0-9]*(?:[._/-][a-z0-9_]+)*$/.test(post.kind)) {
      errors.push(`posts[${index}].kind: required extensible lowercase kind`);
    }
    if (post.title !== undefined && typeof post.title !== "string") {
      errors.push(`posts[${index}].title: must be a string`);
    }
    if (typeof post.body !== "string" || post.body.trim().length === 0) {
      errors.push(`posts[${index}].body: required non-empty string`);
    } else if (Array.from(post.body.normalize("NFC")).length > FEED_POST_BODY_MAX_CHARS) {
      errors.push(`posts[${index}].body: exceeds ${FEED_POST_BODY_MAX_CHARS} characters`);
    }
    if (
      typeof post.title === "string" &&
      Array.from(post.title.normalize("NFC")).length > FEED_POST_TITLE_MAX_CHARS
    ) {
      errors.push(`posts[${index}].title: exceeds ${FEED_POST_TITLE_MAX_CHARS} characters`);
    }
    validateFeedPostEvidence(
      errors,
      post.evidence,
      index,
      allowedSources,
      allowedParents,
      options.artifactId !== undefined,
    );
    const sectionId = options.artifactId === undefined ? post.sectionId : record(post.expansionTarget)?.sectionId;
    if (sectionId !== undefined && (typeof sectionId !== "string" || !allowedSectionIds.has(sectionId))) {
      errors.push(`posts[${index}].sectionId: must reference renderHints.sectionIds`);
    }
    if (options.artifactId !== undefined) {
      if (typeof post.postId !== "string" || post.postId.length === 0) {
        errors.push(`posts[${index}].postId: required string`);
      }
      if (typeof post.postFingerprint !== "string" || post.postFingerprint.length === 0) {
        errors.push(`posts[${index}].postFingerprint: required string`);
      }
      const expansion = record(post.expansionTarget);
      if (!expansion || expansion.artifactId !== options.artifactId) {
        errors.push(`posts[${index}].expansionTarget.artifactId: must reference containing artifact`);
      } else if (Object.keys(expansion).some((key) => key !== "artifactId" && key !== "sectionId")) {
        errors.push(`posts[${index}].expansionTarget: contains unsupported fields`);
      }
      const allowedFinalFields = new Set([
        "postId",
        "postFingerprint",
        "kind",
        "title",
        "body",
        "evidence",
        "expansionTarget",
      ]);
      if (Object.keys(post).some((key) => !allowedFinalFields.has(key))) {
        errors.push(`posts[${index}]: contains unsupported final fields`);
      }
      try {
        const expected = canonicalFeedPostIdentity(post as unknown as FeedPost, {
          sourceRefs,
          parentArtifactRefs,
        });
        if (post.postId !== expected.postId) {
          errors.push(`posts[${index}].postId: does not match canonical identity`);
        }
        if (post.postFingerprint !== expected.postFingerprint) {
          errors.push(`posts[${index}].postFingerprint: does not match canonical content`);
        }
      } catch {
        errors.push(`posts[${index}]: cannot derive canonical identity`);
      }
    } else {
      try {
        const identity = canonicalFeedPostIdentity(post as unknown as CandidateFeedPost, {
          sourceRefs,
          parentArtifactRefs,
        });
        if (candidateFingerprints.has(identity.postFingerprint)) {
          errors.push(`posts[${index}]: duplicate canonical post content`);
        }
        candidateFingerprints.add(identity.postFingerprint);
      } catch {
        // Evidence validation above reports the actionable shape error.
      }
    }
  });
}

function validateFeedPostEvidence(
  errors: string[],
  value: unknown,
  postIndex: number,
  allowedSources: Map<string, Record<string, unknown>>,
  allowedParents: Map<string, Record<string, unknown>>,
  finalArtifact: boolean,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`posts[${postIndex}].evidence: required non-empty array`);
    return;
  }
  const evidenceById = new Map<string, Record<string, unknown>>();
  value.forEach((entry, evidenceIndex) => {
    const evidence = record(entry);
    const path = `posts[${postIndex}].evidence[${evidenceIndex}]`;
    if (!evidence) {
      errors.push(`${path}: must be an object`);
      return;
    }
    if (typeof evidence.evidenceId !== "string" || evidence.evidenceId.trim().length === 0) {
      errors.push(`${path}.evidenceId: required string`);
    } else if (evidenceById.has(evidence.evidenceId)) {
      errors.push(`${path}.evidenceId: duplicate evidence id`);
    } else {
      evidenceById.set(evidence.evidenceId, evidence);
    }
    const allowedFieldsByKind: Record<string, Set<string>> = {
      verified_quote: new Set(["kind", "evidenceId", "sourceRefId", "quote", "loc", "verification"]),
      located_source: new Set(["kind", "evidenceId", "sourceRefId", "loc", "excerpt"]),
      parent_artifact: new Set(["kind", "evidenceId", "artifactId", "sectionId"]),
      analytic_inference: new Set(["kind", "evidenceId", "rationale", "supportedBy"]),
    };
    const allowedFields = typeof evidence.kind === "string" ? allowedFieldsByKind[evidence.kind] : undefined;
    if (finalArtifact && allowedFields && Object.keys(evidence).some((key) => !allowedFields.has(key))) {
      errors.push(`${path}: contains unsupported final fields`);
    }
    if (evidence.kind === "verified_quote" || evidence.kind === "located_source") {
      const source = typeof evidence.sourceRefId === "string" ? allowedSources.get(evidence.sourceRefId) : undefined;
      if (!source) errors.push(`${path}.sourceRefId: must reference artifact sourceRefs`);
      if (evidence.kind === "verified_quote") {
        if (typeof evidence.quote !== "string" || evidence.quote.trim().length === 0) {
          errors.push(`${path}.quote: required non-empty string`);
        }
        if (evidence.loc !== undefined && typeof evidence.loc !== "string") {
          errors.push(`${path}.loc: must be a string`);
        }
        if (finalArtifact) {
          const verification = record(evidence.verification);
          if (
            !verification ||
            verification.method !== "worker_source_quote_match" ||
            verification.sourceObservedHash !== source?.observedHash
          ) {
            errors.push(`${path}.verification: must be worker proof for the observed source hash`);
          }
        }
      } else if (typeof evidence.loc !== "string" || evidence.loc.trim().length === 0) {
        errors.push(`${path}.loc: required non-empty string`);
      } else if (evidence.excerpt !== undefined && typeof evidence.excerpt !== "string") {
        errors.push(`${path}.excerpt: must be a string`);
      }
      if (source && typeof evidence.loc === "string") {
        const lineRefs = source.quoteLineRefs;
        if (isStringArray(lineRefs) && lineRefs.length > 0 && !lineRefs.includes(evidence.loc)) {
          errors.push(`${path}.loc: must reference source quoteLineRefs`);
        }
      }
    } else if (evidence.kind === "parent_artifact") {
      const parent = typeof evidence.artifactId === "string" ? allowedParents.get(evidence.artifactId) : undefined;
      if (!parent) {
        errors.push(`${path}.artifactId: must reference parentArtifactRefs`);
      } else if (typeof parent.observedHash !== "string" || parent.observedHash.length === 0) {
        errors.push(`${path}.artifactId: parent reference must include observedHash`);
      }
      if (evidence.sectionId !== undefined && typeof evidence.sectionId !== "string") {
        errors.push(`${path}.sectionId: must be a string`);
      }
    } else if (evidence.kind === "analytic_inference") {
      if (typeof evidence.rationale !== "string" || evidence.rationale.trim().length === 0) {
        errors.push(`${path}.rationale: required non-empty string`);
      }
      if (!isStringArray(evidence.supportedBy) || evidence.supportedBy.length === 0) {
        errors.push(`${path}.supportedBy: required non-empty evidence id array`);
      } else if (new Set(evidence.supportedBy).size !== evidence.supportedBy.length) {
        errors.push(`${path}.supportedBy: duplicate evidence ids are not allowed`);
      }
    } else {
      errors.push(`${path}.kind: invalid evidence kind`);
    }
  });
  for (const [evidenceId, evidence] of evidenceById) {
    if (evidence.kind !== "analytic_inference" || !isStringArray(evidence.supportedBy)) continue;
    for (const supportId of evidence.supportedBy) {
      const support = evidenceById.get(supportId);
      if (!support || support.kind === "analytic_inference" || supportId === evidenceId) {
        errors.push(
          `posts[${postIndex}].evidence.${evidenceId}.supportedBy: must reference direct non-inference evidence`,
        );
      }
    }
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function validateSkillRunOutput(value: unknown): ValidationResult<SkillRunOutput> {
  const obj = record(value);
  if (!obj) return { ok: false, errors: ["skill run output must be an object"] };
  const errors: string[] = [];
  if (!Array.isArray(obj.candidates)) errors.push("candidates: required array");
  if (record(obj.trace) === null) errors.push("trace: required object");
  if (Array.isArray(obj.candidates)) {
    obj.candidates.forEach((candidate, i) => {
      const result = validateCandidateArtifactEnvelope(candidate);
      if (!result.ok) errors.push(...result.errors.map((e) => `candidates[${i}].${e}`));
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: obj as SkillRunOutput };
}

export type FeedV1ProviderProfile = {
  providerId: "openai" | "phala";
  displayName: string;
  credentialMode: "feed_hosted";
  providerClass: "first_party";
  defaultEgressClass: "model_provider";
  secretRefs: string[];
  defaultModel: string;
  verification: "none" | "phala_tdx";
};

export const FEED_V1_PROVIDER_PROFILES: FeedV1ProviderProfile[] = [
  {
    providerId: "openai",
    displayName: "OpenAI",
    credentialMode: "feed_hosted",
    providerClass: "first_party",
    defaultEgressClass: "model_provider",
    secretRefs: ["vault/secrets/scoped/feed/OPENAI_API_KEY"],
    defaultModel: "openai/gpt-5-mini",
    verification: "none",
  },
  {
    providerId: "phala",
    displayName: "Phala",
    credentialMode: "feed_hosted",
    providerClass: "first_party",
    defaultEgressClass: "model_provider",
    secretRefs: ["vault/secrets/scoped/feed/REDPILL_API_KEY"],
    defaultModel: "phala/gpt-oss-120b",
    verification: "phala_tdx",
  },
];

export type FeedV1SkillTier = "default_internal" | "on_demand" | "approval_gated" | "budget_provider_gated";

export type FeedV1SkillOption = {
  skillId: string;
  tier: FeedV1SkillTier;
  autoPublish: boolean;
};

export const FEED_V1_SKILL_OPTIONS: FeedV1SkillOption[] = [
  { skillId: "extract-insights", tier: "default_internal", autoPublish: true },
  { skillId: "hot-take", tier: "default_internal", autoPublish: true },
  { skillId: "write-digest", tier: "default_internal", autoPublish: true },
  { skillId: "plan-feed-mix", tier: "default_internal", autoPublish: true },
  { skillId: "tc-listen-read", tier: "default_internal", autoPublish: true },
  { skillId: "person-brief", tier: "on_demand", autoPublish: false },
  { skillId: "banger-extractor", tier: "approval_gated", autoPublish: false },
  { skillId: "investor-snippet", tier: "approval_gated", autoPublish: false },
  { skillId: "quote-card", tier: "approval_gated", autoPublish: false },
  { skillId: "write-article", tier: "budget_provider_gated", autoPublish: false },
  { skillId: "make-podcast", tier: "budget_provider_gated", autoPublish: false },
  { skillId: "illustrate-card", tier: "budget_provider_gated", autoPublish: false },
  { skillId: "make-cheap-video", tier: "budget_provider_gated", autoPublish: false },
  { skillId: "make-clip", tier: "budget_provider_gated", autoPublish: false },
];
