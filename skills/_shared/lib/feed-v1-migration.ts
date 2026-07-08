import { createHash } from "node:crypto";
import {
  artifactIndexRow,
  projectionRow,
  type SqlSeedRow,
} from "./feed-v1-bootstrap.ts";
import type {
  ControlIntentEvent,
  FeedArtifact,
  FeedArtifactProjection,
  FeedbackEvent,
  GenerationRequest,
  TranscriptSourceRef,
} from "./feed-v1.ts";
import { validateFeedArtifact } from "./feed-v1.ts";
import {
  FEED_V1_ARTIFACT_DOC_PREFIX,
  FEED_V1_ARTIFACTS_INDEX_DB_PATH,
  FEED_V1_FEED_INDEX_DB_PATH,
} from "./feed-v1-schema.ts";

export const LEGACY_FEED_DB_PATH = "xyz.tinycloud.artifacts/feed";
export const LEGACY_INTERACTIONS_DB_PATH = "xyz.tinycloud.artifacts/interactions";

const LEGACY_RENDER_TYPE_TO_SHAPE: Record<string, FeedArtifact["renderShape"]> = {
  tweet: "short_form",
  article: "longform",
  video: "media",
};

const LEGACY_ACTION_TO_SIGNAL: Record<
  string,
  FeedbackEvent["signal"] | "ask_feed"
> = {
  more: "helpful",
  save: "save",
  less: "hide",
  already_knew: "unhelpful",
  wrong: "unhelpful",
  promote: "ask_feed",
};

const LEGACY_FEEDBACK_ACTIONS = new Set(["more", "save", "less", "already_knew", "wrong"]);
const LEGACY_CONTROL_ACTIONS = new Set(["promote"]);

export type LegacyArtifactRow = Record<string, unknown>;
export type LegacyInteractionRow = Record<string, unknown>;

export type MigratedArtifactRefs = {
  sourceDb: string;
  rowId: string;
  rowHash: string;
};

export type MigratedFeedArtifact = FeedArtifact & {
  legacyRefs: MigratedArtifactRefs;
};

export type FeedV1MigrationAudit = {
  kind: "artifact" | "interaction";
  legacyId: string;
  reason: string;
  detail?: string;
};

export type FeedV1MigrationSummary = {
  legacyArtifacts: number;
  legacyInteractions: number;
  migratedArtifacts: number;
  migratedArtifactDocs: number;
  migratedArtifactRows: number;
  migratedFeedRows: number;
  migratedFeedbackEvents: number;
  migratedControlIntents: number;
  migratedGenerationRequests: number;
  skippedArtifacts: number;
  skippedInteractions: number;
};

export type FeedV1MigrationPlan = {
  artifactRows: SqlSeedRow[];
  feedRows: SqlSeedRow[];
  artifactDocs: { docKey: string; value: MigratedFeedArtifact }[];
  audits: FeedV1MigrationAudit[];
  summary: FeedV1MigrationSummary;
};

export type FeedV1MigrationWriter = {
  writeSqlRows(dbName: "artifacts_index" | "feed_index", rows: SqlSeedRow[]): Promise<void>;
  writeArtifactDocument(artifact: MigratedFeedArtifact): Promise<void>;
};

type NormalizedLegacyArtifactRow = {
  id: string;
  type: string;
  renderType: FeedArtifact["renderShape"];
  headline: string;
  slug: string;
  bodyMd: string | null;
  quote: string | null;
  attribution: string | null;
  sourceTranscripts: string[];
  heroImageKey: string | null;
  audioKey: string | null;
  videoKey: string | null;
  rawArtifact: Record<string, unknown>;
  generatedAt: string;
  publishedAt: string;
  publisherDid: string;
  schemaVersion: number;
};

type NormalizedLegacyInteractionRow = {
  id: string;
  artifactId: string;
  artifactType: string;
  action: string;
  note: string | null;
  readerDid: string;
  nonce: string;
  createdAt: string;
  recordedAt: string;
};

type ArtifactPlan = {
  artifact: MigratedFeedArtifact;
  canonicalArtifact: FeedArtifact;
  projection: FeedArtifactProjection;
  feedbackRows: SqlSeedRow[];
  controlRows: SqlSeedRow[];
  generationRows: SqlSeedRow[];
};

export function buildFeedV1MigrationPlan(input: {
  legacyArtifacts: unknown[];
  legacyInteractions: unknown[];
}): FeedV1MigrationPlan {
  const audits: FeedV1MigrationAudit[] = [];
  const normalizedArtifacts = new Map<string, NormalizedLegacyArtifactRow>();
  let skippedArtifacts = 0;
  let skippedInteractions = 0;

  for (const value of input.legacyArtifacts) {
    const normalized = normalizeLegacyArtifactRow(value);
    if (!normalized.ok) {
      audits.push({
        kind: "artifact",
        legacyId: legacyRowId(value, "artifact"),
        reason: "invalid_legacy_artifact",
        detail: normalized.errors.join("; "),
      });
      skippedArtifacts += 1;
      continue;
    }
    if (normalizedArtifacts.has(normalized.value.id)) {
      audits.push({
        kind: "artifact",
        legacyId: normalized.value.id,
        reason: "duplicate_legacy_artifact",
      });
      skippedArtifacts += 1;
      continue;
    }
    normalizedArtifacts.set(normalized.value.id, normalized.value);
  }

  const interactionsByArtifact = new Map<string, NormalizedLegacyInteractionRow[]>();
  const seenInteractionIds = new Set<string>();

  for (const value of input.legacyInteractions) {
    const normalized = normalizeLegacyInteractionRow(value);
    if (!normalized.ok) {
      audits.push({
        kind: "interaction",
        legacyId: legacyRowId(value, "interaction"),
        reason: "invalid_legacy_interaction",
        detail: normalized.errors.join("; "),
      });
      skippedInteractions += 1;
      continue;
    }
    if (seenInteractionIds.has(normalized.value.id)) {
      audits.push({
        kind: "interaction",
        legacyId: normalized.value.id,
        reason: "duplicate_legacy_interaction",
      });
      skippedInteractions += 1;
      continue;
    }
    if (!LEGACY_ACTION_TO_SIGNAL[normalized.value.action]) {
      audits.push({
        kind: "interaction",
        legacyId: normalized.value.id,
        reason: "unexpected_legacy_action",
        detail: normalized.value.action,
      });
      skippedInteractions += 1;
      continue;
    }
    if (!normalizedArtifacts.has(normalized.value.artifactId)) {
      audits.push({
        kind: "interaction",
        legacyId: normalized.value.id,
        reason: "missing_legacy_artifact",
        detail: normalized.value.artifactId,
      });
      skippedInteractions += 1;
      continue;
    }
    seenInteractionIds.add(normalized.value.id);
    const current = interactionsByArtifact.get(normalized.value.artifactId) ?? [];
    current.push(normalized.value);
    interactionsByArtifact.set(normalized.value.artifactId, current);
  }

  const artifactPlans: ArtifactPlan[] = [];
  const orderedArtifacts = [...normalizedArtifacts.values()].sort((a, b) =>
    a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id),
  );

  for (const artifact of orderedArtifacts) {
    const plan = buildArtifactPlan(artifact, interactionsByArtifact.get(artifact.id) ?? []);
    if (!plan) {
      audits.push({
        kind: "artifact",
        legacyId: artifact.id,
        reason: "unmigratable_legacy_artifact",
      });
      skippedArtifacts += 1;
      continue;
    }
    artifactPlans.push(plan);
  }

  const artifactRows = artifactPlans.map((plan) => artifactIndexRow(plan.canonicalArtifact));
  const feedRows = artifactPlans.flatMap((plan) => [projectionRow(plan.projection), ...plan.feedbackRows, ...plan.controlRows, ...plan.generationRows]);
  const artifactDocs = artifactPlans.map((plan) => ({
    docKey: plan.artifact.storage.docKey,
    value: plan.artifact,
  }));

  return {
    artifactRows,
    feedRows,
    artifactDocs,
    audits,
    summary: {
      legacyArtifacts: input.legacyArtifacts.length,
      legacyInteractions: input.legacyInteractions.length,
      migratedArtifacts: artifactPlans.length,
      migratedArtifactDocs: artifactDocs.length,
      migratedArtifactRows: artifactRows.length,
      migratedFeedRows: feedRows.length,
      migratedFeedbackEvents: artifactPlans.reduce((sum, plan) => sum + plan.feedbackRows.length, 0),
      migratedControlIntents: artifactPlans.reduce((sum, plan) => sum + plan.controlRows.length, 0),
      migratedGenerationRequests: artifactPlans.reduce((sum, plan) => sum + plan.generationRows.length, 0),
      skippedArtifacts,
      skippedInteractions,
    },
  };
}

export async function applyFeedV1MigrationPlan(
  plan: FeedV1MigrationPlan,
  writer: FeedV1MigrationWriter,
  opts: { dryRun?: boolean } = {},
): Promise<FeedV1MigrationSummary> {
  if (opts.dryRun) return plan.summary;
  for (const doc of plan.artifactDocs) {
    await writer.writeArtifactDocument(doc.value);
  }
  if (plan.artifactRows.length > 0) {
    await writer.writeSqlRows("artifacts_index", plan.artifactRows);
  }
  if (plan.feedRows.length > 0) {
    await writer.writeSqlRows("feed_index", plan.feedRows);
  }
  return plan.summary;
}

export async function queryLegacyMigrationRows(input: {
  artifacts: () => Promise<unknown[]>;
  interactions: () => Promise<unknown[]>;
}): Promise<{ legacyArtifacts: unknown[]; legacyInteractions: unknown[] }> {
  const [legacyArtifacts, legacyInteractions] = await Promise.all([input.artifacts(), input.interactions()]);
  return { legacyArtifacts, legacyInteractions };
}

export function legacyMigrationSummaryIsEmpty(summary: FeedV1MigrationSummary): boolean {
  return summary.legacyArtifacts === 0 && summary.legacyInteractions === 0;
}

export function legacyMigrationDbPaths(): readonly [string, string, string, string] {
  return [
    LEGACY_FEED_DB_PATH,
    LEGACY_INTERACTIONS_DB_PATH,
    FEED_V1_ARTIFACTS_INDEX_DB_PATH,
    FEED_V1_FEED_INDEX_DB_PATH,
  ];
}

function buildArtifactPlan(
  artifact: NormalizedLegacyArtifactRow,
  interactions: NormalizedLegacyInteractionRow[],
): ArtifactPlan | null {
  const sourceRefs = artifact.sourceTranscripts.map((sourceId, index) => legacySourceRef(artifact, sourceId, index));
  if (sourceRefs.length === 0) return null;

  const legacyRefs: MigratedArtifactRefs = {
    sourceDb: LEGACY_FEED_DB_PATH,
    rowId: artifact.id,
    rowHash: sha256(stableStringify(artifact)),
  };

  const producedBy = {
    packageId: `legacy:${artifact.type}`,
    packageVersion: String(artifact.schemaVersion),
    packageDigest: sha256(stableStringify({ type: artifact.type, schemaVersion: artifact.schemaVersion })),
    runId: legacyRunId(artifact),
    runtimeClass: "stub" as const,
    providerClass: "none" as const,
    credentialOwner: "none" as const,
    egressClass: "none" as const,
    disclosure: {
      userCopy: "Migrated from legacy Feed artifact data.",
      credentialOwner: "none" as const,
      providerClass: "none" as const,
      egressClass: "none" as const,
    },
  };

  const createdAt = artifact.publishedAt;
  const body = artifact.rawArtifact;
  const storage = {
    docKey: `${FEED_V1_ARTIFACT_DOC_PREFIX}/${artifact.id}.json`,
    mediaKeys: [artifact.heroImageKey, artifact.audioKey, artifact.videoKey].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  };

  const canonicalArtifact: FeedArtifact = {
    schemaVersion: "feed.artifact.v1",
    artifactId: artifact.id,
    artifactType: artifact.type,
    renderShape: artifact.renderType,
    title: artifact.headline,
    summary: artifact.quote ?? artifact.bodyMd ?? undefined,
    body,
    sourceRefs,
    producedBy,
    freshness: {
      label: "as_of",
      asOf: artifact.publishedAt,
      lastCheckedAt: artifact.generatedAt,
    },
    idempotency: {
      sourceFingerprint: sourceFingerprintFor(artifact),
      artifactFingerprint: "sha256:pending",
      dedupeKey: "sha256:pending",
    },
    storage,
    createdAt,
    updatedAt: createdAt,
  };
  canonicalArtifact.idempotency = derivedIdempotency(canonicalArtifact);

  const migratedArtifact: MigratedFeedArtifact = {
    ...canonicalArtifact,
    legacyRefs,
  };

  if (!validateCanonicalArtifact(migratedArtifact)) return null;

  const interactionsPlan = buildInteractionRows(artifact, interactions);
  const projection = projectionForArtifact(canonicalArtifact, interactions);

  return {
    artifact: migratedArtifact,
    canonicalArtifact,
    projection,
    feedbackRows: interactionsPlan.feedbackRows,
    controlRows: interactionsPlan.controlRows,
    generationRows: interactionsPlan.generationRows,
  };
}

function buildInteractionRows(
  artifact: NormalizedLegacyArtifactRow,
  interactions: NormalizedLegacyInteractionRow[],
): {
  feedbackRows: SqlSeedRow[];
  controlRows: SqlSeedRow[];
  generationRows: SqlSeedRow[];
} {
  const ordered = [...interactions].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
  const feedbackRows: SqlSeedRow[] = [];
  const controlRows: SqlSeedRow[] = [];
  const generationRows: SqlSeedRow[] = [];

  for (const interaction of ordered) {
    const signal = LEGACY_ACTION_TO_SIGNAL[interaction.action];
    const note = interaction.note?.trim() ? interaction.note.trim() : null;
    const payload = note
      ? { legacyAction: interaction.action, note }
      : { legacyAction: interaction.action };
    const payloadJson = json(payload);
    const payloadHash = sha256(stableStringify(payload));

    if (LEGACY_FEEDBACK_ACTIONS.has(interaction.action)) {
      feedbackRows.push({
        table: "feedback_event",
        values: {
          event_id: interaction.id,
          artifact_id: interaction.artifactId,
          reader_nonce: interaction.nonce,
          actor_id: interaction.readerDid,
          signal: signal as FeedbackEvent["signal"],
          payload_json: payloadJson,
          payload_hash: payloadHash,
          created_at: interaction.recordedAt,
        },
      });
      continue;
    }

    if (LEGACY_CONTROL_ACTIONS.has(interaction.action)) {
      const targetRef = `artifact:${interaction.artifactId}`;
      const prompt = note ?? artifact.headline;
      controlRows.push({
        table: "control_intent_event",
        values: {
          event_id: interaction.id,
          reader_nonce: interaction.nonce,
          actor_id: interaction.readerDid,
          intent_kind: "ask_feed",
          status: "accepted",
          target_ref: targetRef,
          payload_hash: payloadHash,
          payload_json: json({
            legacyAction: interaction.action,
            ...(prompt ? { prompt } : {}),
          }),
          created_at: interaction.recordedAt,
        },
      });
      generationRows.push({
        table: "generation_request",
        values: {
          request_id: interaction.id,
          reader_nonce: interaction.nonce,
          actor_id: interaction.readerDid,
          status: "accepted",
          scope_json: json({
            targetRef,
            artifactId: interaction.artifactId,
            artifactType: interaction.artifactType,
          }),
          package_id: null,
          dedupe_key: payloadHash,
          prompt: prompt ?? null,
          expires_at: addHours(interaction.recordedAt, 1),
          created_at: interaction.recordedAt,
          updated_at: interaction.recordedAt,
        },
      });
    }
  }

  return { feedbackRows, controlRows, generationRows };
}

function projectionForArtifact(
  artifact: FeedArtifact,
  interactions: NormalizedLegacyInteractionRow[],
): FeedArtifactProjection {
  let disposition: FeedArtifactProjection["disposition"] = "default";
  let savedCount = 0;
  let helpfulCount = 0;
  let unhelpfulCount = 0;
  let hiddenCount = 0;
  let showFewerCount = 0;

  for (const interaction of interactions.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id))) {
    switch (interaction.action) {
      case "save":
        disposition = "saved";
        savedCount += 1;
        break;
      case "less":
        disposition = "hidden";
        hiddenCount += 1;
        break;
      case "more":
        helpfulCount += 1;
        break;
      case "already_knew":
      case "wrong":
        unhelpfulCount += 1;
        break;
      default:
        break;
    }
  }

  const reasonCodes = new Set<string>(["legacy_migrated"]);
  if (savedCount > 0 || disposition === "saved") reasonCodes.add("saved");
  if (helpfulCount > 0) reasonCodes.add("helpful_signal");
  if (unhelpfulCount > 0) reasonCodes.add("less_like_this");
  if (hiddenCount > 0 || disposition === "hidden") reasonCodes.add("hidden");
  if (showFewerCount > 0) reasonCodes.add("cooldown");

  const rankScore = legacyRankScore(artifact.createdAt, {
    savedCount,
    helpfulCount,
    unhelpfulCount,
    hiddenCount,
    showFewerCount,
  });

  return {
    artifactId: artifact.artifactId,
    rankScore,
    disposition,
    visibility: disposition === "hidden" ? "hidden" : "ranked",
    freshnessLabel: artifact.freshness.label,
    reasonCodes: [...reasonCodes],
    packageId: artifact.producedBy.packageId,
    sourceFingerprint: artifact.idempotency.sourceFingerprint,
    publishedAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function legacyRankScore(
  publishedAt: string,
  counts: { savedCount: number; helpfulCount: number; unhelpfulCount: number; hiddenCount: number; showFewerCount: number },
): number {
  const base = Date.parse(publishedAt);
  return (
    base +
    counts.savedCount * 1000 +
    counts.helpfulCount * 100 -
    counts.unhelpfulCount * 100 -
    counts.hiddenCount * 2000 -
    counts.showFewerCount * 50
  );
}

function validateCanonicalArtifact(artifact: MigratedFeedArtifact): boolean {
  const result = validateFeedArtifact(artifact);
  return result.ok;
}

function derivedIdempotency(artifact: FeedArtifact): FeedArtifact["idempotency"] {
  const canonical = {
    schemaVersion: artifact.schemaVersion,
    artifactId: artifact.artifactId,
    artifactType: artifact.artifactType,
    renderShape: artifact.renderShape,
    title: artifact.title,
    summary: artifact.summary ?? null,
    body: artifact.body,
    renderHints: artifact.renderHints ?? null,
    sourceRefs: artifact.sourceRefs,
    parentArtifactRefs: artifact.parentArtifactRefs ?? null,
    producedBy: artifact.producedBy,
    freshness: artifact.freshness,
    storage: artifact.storage,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
  const sourceFingerprint = artifact.idempotency.sourceFingerprint;
  const artifactFingerprint = sha256(stableStringify(canonical));
  return {
    sourceFingerprint,
    artifactFingerprint,
    dedupeKey: sha256(artifact.producedBy.packageDigest + sourceFingerprint + artifactFingerprint),
  };
}

function sourceFingerprintFor(artifact: NormalizedLegacyArtifactRow): string {
  return sha256(stableStringify(artifact.sourceTranscripts));
}

function legacySourceRef(
  artifact: NormalizedLegacyArtifactRow,
  sourceId: string,
  index: number,
): TranscriptSourceRef {
  return {
    sourceRefId: `${artifact.id}:legacy-source:${index}`,
    sourceKind: "listen_conversation",
    sourceId,
    observedPath: "sql_transcript_text",
    observedHash: sha256(stableStringify({ artifactId: artifact.id, sourceId, index })),
    observedAt: artifact.publishedAt,
  };
}

function legacyRunId(artifact: NormalizedLegacyArtifactRow): string {
  const producer = record(artifact.rawArtifact.producer);
  const runId = stringValue(producer?.run_id ?? producer?.runId);
  return runId ?? `legacy:${artifact.id}`;
}

function normalizeLegacyArtifactRow(
  value: unknown,
): { ok: true; value: NormalizedLegacyArtifactRow } | { ok: false; errors: string[] } {
  const recordValue = record(value);
  if (!recordValue) return { ok: false, errors: ["value must be an object"] };
  const errors: string[] = [];

  const id = stringValue(recordValue.id);
  const type = stringValue(recordValue.type);
  const renderType = stringValue(recordValue.render_type);
  const headline = stringValue(recordValue.headline);
  const slug = stringValue(recordValue.slug);
  const rawArtifactValue = parseJsonOrRecord(recordValue.raw_artifact);
  const sourceTranscripts = parseStringArray(recordValue.source_transcripts)
    ?? parseStringArray(rawArtifactValue?.source_transcripts);
  const generatedAt = stringValue(recordValue.generated_at);
  const publishedAt = stringValue(recordValue.published_at);
  const publisherDid = stringValue(recordValue.publisher_did);
  const schemaVersion = numberValue(recordValue.schema_version);

  if (!id) errors.push("id: required string");
  if (!type) errors.push("type: required string");
  if (!renderType) errors.push("render_type: required string");
  else if (!(renderType in LEGACY_RENDER_TYPE_TO_SHAPE)) errors.push("render_type: unsupported legacy render type");
  if (!headline) errors.push("headline: required string");
  if (!slug) errors.push("slug: required string");
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) errors.push("generated_at: required ISO date string");
  if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) errors.push("published_at: required ISO date string");
  if (!publisherDid) errors.push("publisher_did: required string");
  if (!rawArtifactValue) errors.push("raw_artifact: required JSON object");
  if (!sourceTranscripts || sourceTranscripts.length === 0) errors.push("source_transcripts: required non-empty string array");
  if (schemaVersion === null) errors.push("schema_version: required number");

  if (errors.length > 0 || !id || !type || !renderType || !headline || !slug || !generatedAt || !publishedAt || !publisherDid || !rawArtifactValue || !sourceTranscripts || schemaVersion === null) {
    return { ok: false, errors };
  }

  const bodyMd = optionalString(recordValue.body_md);
  const quote = optionalString(recordValue.quote);
  const attribution = optionalString(recordValue.attribution);
  const heroImageKey = optionalString(recordValue.hero_image_key);
  const audioKey = optionalString(recordValue.audio_key);
  const videoKey = optionalString(recordValue.video_key);

  return {
    ok: true,
    value: {
      id,
      type,
      renderType: LEGACY_RENDER_TYPE_TO_SHAPE[renderType] ?? "longform",
      headline,
      slug,
      bodyMd,
      quote,
      attribution,
      sourceTranscripts,
      heroImageKey,
      audioKey,
      videoKey,
      rawArtifact: rawArtifactValue,
      generatedAt,
      publishedAt,
      publisherDid,
      schemaVersion,
    },
  };
}

function normalizeLegacyInteractionRow(
  value: unknown,
): { ok: true; value: NormalizedLegacyInteractionRow } | { ok: false; errors: string[] } {
  const recordValue = record(value);
  if (!recordValue) return { ok: false, errors: ["value must be an object"] };
  const errors: string[] = [];

  const id = stringValue(recordValue.id);
  const artifactId = stringValue(recordValue.artifact_id);
  const artifactType = stringValue(recordValue.artifact_type);
  const action = stringValue(recordValue.action);
  const readerDid = stringValue(recordValue.reader_did);
  const nonce = stringValue(recordValue.nonce);
  const createdAt = stringValue(recordValue.created_at);
  const recordedAt = stringValue(recordValue.recorded_at);
  const note = optionalString(recordValue.note);

  if (!id) errors.push("id: required string");
  if (!artifactId) errors.push("artifact_id: required string");
  if (!artifactType) errors.push("artifact_type: required string");
  if (!action) errors.push("action: required string");
  if (!readerDid) errors.push("reader_did: required string");
  if (!nonce) errors.push("nonce: required string");
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) errors.push("created_at: required ISO date string");
  if (!recordedAt || Number.isNaN(Date.parse(recordedAt))) errors.push("recorded_at: required ISO date string");

  if (errors.length > 0 || !id || !artifactId || !artifactType || !action || !readerDid || !nonce || !createdAt || !recordedAt) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      id,
      artifactId,
      artifactType,
      action,
      note,
      readerDid,
      nonce,
      createdAt,
      recordedAt,
    },
  };
}

function parseJsonOrRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return record(parsed);
    } catch {
      return null;
    }
  }
  return record(value);
}

function parseStringArray(value: unknown): string[] | null {
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function legacyRowId(value: unknown, kind: "artifact" | "interaction"): string {
  const row = record(value);
  const candidate = row ? stringValue(row.id) : null;
  return candidate ?? `${kind}:unknown`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  const obj = record(value);
  if (!obj) return value;
  return Object.fromEntries(Object.keys(obj).sort().map((key) => [key, sortValue(obj[key])]));
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function addHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();
}
