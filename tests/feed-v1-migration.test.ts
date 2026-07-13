import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { bootstrapFeedV1SplitSchema } from "../packages/artifactory/src/migration.ts";
import { validateFeedArtifact } from "../skills/_shared/lib/feed-v1.ts";
import {
  FEED_V1_FEED_MIGRATIONS,
  FEED_V1_LEGACY_PROJECTION_PARITY_SQL,
  FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL,
} from "../skills/_shared/lib/feed-v1-schema.ts";
import {
  applyFeedV1MigrationPlan,
  buildFeedV1MigrationPlan,
  type FeedV1MigrationWriter,
  type MigratedFeedArtifact,
} from "../skills/_shared/lib/feed-v1-migration.ts";

type SqlSeedRow = {
  table: string;
  values: Record<string, string | number | null>;
};

const VALID_ARTIFACT = {
  id: "legacy-card-1",
  type: "article",
  render_type: "article",
  slug: "legacy-card-1",
  headline: "Legacy headline",
  body_md: "Legacy body.",
  quote: "Legacy quote.",
  attribution: "Legacy attribution",
  source_transcripts: JSON.stringify(["listen-1", "listen-2"]),
  hero_image_key: "media/legacy-card-1/hero.png",
  hero_image_sha256: null,
  hero_image_mime: null,
  audio_key: null,
  audio_sha256: null,
  audio_mime: null,
  video_key: null,
  video_sha256: null,
  video_mime: null,
  video_url: null,
  audience: null,
  approval_status: "published",
  platform: "legacy",
  generation_model: "legacy-model",
  critic_pass: 1,
  quotes_verified: 1,
  raw_artifact: JSON.stringify({
    producer: { run_id: "run-legacy-1", pipeline: "legacy-pipeline" },
    source_quotes: [{ quote: "Legacy quote." }],
    summary: "Legacy summary.",
  }),
  generated_at: "2026-06-01T10:00:00.000Z",
  published_at: "2026-06-01T11:00:00.000Z",
  publisher_did: "did:pkh:eip155:1:0x1234567890abcdef1234567890abcdef12345678",
  schema_version: 1,
  tags: "[]",
};

const LEGACY_INTERACTIONS = [
  interaction("int-1", "more", "2026-06-01T11:10:00.000Z"),
  interaction("int-2", "save", "2026-06-01T11:11:00.000Z"),
  interaction("int-3", "less", "2026-06-01T11:12:00.000Z"),
  interaction("int-4", "already_knew", "2026-06-01T11:13:00.000Z"),
  interaction("int-5", "wrong", "2026-06-01T11:14:00.000Z"),
  interaction("int-6", "promote", "2026-06-01T11:15:00.000Z", "Build a deeper artifact."),
];

describe("Feed v1 legacy migration", () => {
  test("fresh user with no legacy rows is a no-op", () => {
    const plan = buildFeedV1MigrationPlan({ legacyArtifacts: [], legacyInteractions: [] });
    expect(plan.summary).toEqual({
      legacyArtifacts: 0,
      legacyInteractions: 0,
      migratedArtifacts: 0,
      migratedArtifactDocs: 0,
      migratedArtifactRows: 0,
      migratedFeedRows: 0,
      migratedFeedbackEvents: 0,
      migratedControlIntents: 0,
      migratedGenerationRequests: 0,
      skippedArtifacts: 0,
      skippedInteractions: 0,
    });
    expect(plan.audits).toEqual([]);
    expect(plan.artifactRows).toEqual([]);
    expect(plan.feedRows).toEqual([]);
    expect(plan.artifactDocs).toEqual([]);
  });

  test("legacy user migrates artifact, projection, feedback, and ask-feed control rows", () => {
    const plan = buildFeedV1MigrationPlan({
      legacyArtifacts: [VALID_ARTIFACT],
      legacyInteractions: LEGACY_INTERACTIONS,
    });

    expect(plan.summary.migratedArtifacts).toBe(1);
    expect(plan.summary.migratedArtifactRows).toBe(1);
    expect(plan.summary.migratedArtifactDocs).toBe(1);
    expect(plan.summary.migratedFeedRows).toBe(8);
    expect(plan.summary.migratedFeedbackEvents).toBe(5);
    expect(plan.summary.migratedControlIntents).toBe(1);
    expect(plan.summary.migratedGenerationRequests).toBe(1);
    expect(plan.summary.skippedArtifacts).toBe(0);
    expect(plan.summary.skippedInteractions).toBe(0);
    expect(plan.audits).toEqual([]);

    const artifactDoc = plan.artifactDocs[0]?.value;
    expect(artifactDoc).toBeDefined();
    if (!artifactDoc) throw new Error("expected migrated artifact document");
    expect(artifactDoc.legacyRefs.rowId).toBe("legacy-card-1");
    expect(validateFeedArtifact(artifactDoc)).toEqual({ ok: true, value: artifactDoc });
    expect(artifactDoc.storage.docKey).toBe("xyz.tinycloud.artifacts/artifacts/legacy-card-1.json");

    const projectionRow = plan.feedRows.find((row) => row.table === "feed_item_projection");
    expect(projectionRow?.values.feed_item_id).toBe("legacy:legacy-card-1");
    expect(projectionRow?.values.target_kind).toBe("artifact_preview");
    expect(projectionRow?.values.post_id).toBeNull();
    expect(projectionRow?.values.disposition).toBe("hidden");
    expect(projectionRow?.values.visibility).toBe("hidden");
    expect(String(projectionRow?.values.reason_codes_json)).toContain("legacy_migrated");
    expect(String(projectionRow?.values.reason_codes_json)).toContain("saved");
    expect(String(projectionRow?.values.reason_codes_json)).toContain("helpful_signal");
    expect(String(projectionRow?.values.reason_codes_json)).toContain("less_like_this");
    expect(String(projectionRow?.values.reason_codes_json)).toContain("hidden");

    expect(plan.feedRows.filter((row) => row.table === "feedback_event").map((row) => row.values.signal)).toEqual([
      "helpful",
      "save",
      "hide",
      "unhelpful",
      "unhelpful",
    ]);

    const controlRow = plan.feedRows.find((row) => row.table === "control_intent_event");
    expect(controlRow?.values.intent_kind).toBe("ask_feed");
    expect(controlRow?.values.target_ref).toBe("artifact:legacy-card-1");

    const requestRow = plan.feedRows.find((row) => row.table === "generation_request");
    expect(requestRow?.values.request_id).toBe("int-6");
    expect(String(requestRow?.values.prompt)).toBe("Build a deeper artifact.");
    expect(controlRow?.values.payload_hash).toBe(sha256(String(controlRow?.values.payload_json)));
    expect(requestRow?.values.dedupe_key).toBe(controlRow?.values.payload_hash);
  });

  test("partially migrated user resumes without duplicates", async () => {
    const plan = buildFeedV1MigrationPlan({
      legacyArtifacts: [VALID_ARTIFACT],
      legacyInteractions: LEGACY_INTERACTIONS,
    });
    const writer = new MemoryMigrationWriter();

    await writer.writeSqlRows("artifacts_index", plan.artifactRows);
    await writer.writeArtifactDocument(plan.artifactDocs[0]!.value);

    expect(writer.artifacts.size).toBe(1);
    expect(writer.feed.size).toBe(0);
    expect(writer.documents.size).toBe(1);

    await applyFeedV1MigrationPlan(plan, writer);
    expect(writer.artifacts.size).toBe(1);
    expect(writer.feed.size).toBe(8);
    expect(writer.documents.size).toBe(1);

    await applyFeedV1MigrationPlan(plan, writer);
    expect(writer.artifacts.size).toBe(1);
    expect(writer.feed.size).toBe(8);
    expect(writer.documents.size).toBe(1);
  });

  test("corrupted or unexpected rows are skipped and audited without crashing", () => {
    const plan = buildFeedV1MigrationPlan({
      legacyArtifacts: [
        VALID_ARTIFACT,
        {
          id: "bad-legacy-card",
          type: "article",
          render_type: "tweet",
          slug: "bad-legacy-card",
          headline: "Bad legacy card",
          raw_artifact: "{not-json",
          source_transcripts: "[]",
          generated_at: "not-a-date",
          published_at: "also-not-a-date",
          publisher_did: "",
          schema_version: "nope",
        },
      ],
      legacyInteractions: [
        interaction("bad-int-1", "dance", "2026-06-01T11:20:00.000Z"),
        interaction("bad-int-2", "save", "2026-06-01T11:21:00.000Z", "  "),
      ],
    });

    expect(plan.summary.migratedArtifacts).toBe(1);
    expect(plan.summary.skippedArtifacts).toBe(1);
    expect(plan.summary.skippedInteractions).toBe(1);
    expect(plan.audits.some((audit) => audit.reason === "invalid_legacy_artifact")).toBe(true);
    expect(plan.audits.some((audit) => audit.reason === "unexpected_legacy_action")).toBe(true);
  });

  test("bootstrapFeedV1SplitSchema provisions the split schema before migration writes", async () => {
    const statements: Array<{ db: string; sql: string }> = [];
    await bootstrapFeedV1SplitSchema({
      target: { space: "test-space" },
      opts: { profile: "test-profile" },
      execute: async (statement, target) => {
        statements.push({ db: target.db, sql: statement });
        return { changes: 0, lastInsertRowId: 0 };
      },
    });

    const artifactsStatements = statements.filter((statement) => statement.db === "xyz.tinycloud.artifacts/index");
    const feedStatements = statements.filter((statement) => statement.db === "xyz.tinycloud.feed/index");
    expect(artifactsStatements).toHaveLength(7);
    expect(feedStatements).toHaveLength(9);
    expect(artifactsStatements[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS artifact_index");
    expect(feedStatements[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS feed_artifact_projection");
    expect(feedStatements[6]?.sql).toContain("CREATE TABLE IF NOT EXISTS feed_item_projection");
  });

  test("migration 002 backfills legacy projections into the canonical post-aware table", () => {
    const db = new Database(":memory:");
    try {
      for (const migration of FEED_V1_FEED_MIGRATIONS.slice(0, 1)) {
        for (const statement of migration.sql) db.run(statement);
      }
      db.run(
        `INSERT INTO feed_artifact_projection (
          artifact_id, rank_score, disposition, visibility, freshness_label,
          reason_codes_json, package_id, source_fingerprint, published_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "artifact-old",
          42,
          "default",
          "ranked",
          "fresh",
          "[]",
          "package-old",
          "sha256:source",
          "2026-07-01T00:00:00.000Z",
          "2026-07-01T00:00:00.000Z",
        ],
      );
      for (const statement of FEED_V1_FEED_MIGRATIONS[1]!.sql) db.run(statement);

      const row = db.query(
        "SELECT feed_item_id, target_kind, artifact_id, post_id FROM feed_item_projection",
      ).get() as { feed_item_id: string; target_kind: string; artifact_id: string; post_id: null };
      expect(row).toEqual({
        feed_item_id: "legacy:artifact-old",
        target_kind: "artifact_preview",
        artifact_id: "artifact-old",
        post_id: null,
      });
      expect(() => db.run(
        `INSERT INTO feed_item_projection
        SELECT 'bad-preview', 'artifact_preview', artifact_id, 'dangling', rank_score,
          disposition, visibility, freshness_label, reason_codes_json, package_id,
          source_fingerprint, published_at, updated_at
        FROM feed_artifact_projection WHERE artifact_id = 'artifact-old'`,
      )).toThrow();
      expect(() => db.run(
        `INSERT INTO feed_targeted_interaction_event (
          event_id, target_kind, artifact_id, post_id, feed_item_id,
          reader_nonce, actor_id, signal, created_at
        ) VALUES ('bad-target', 'post', 'artifact-old', NULL, NULL,
          'nonce', 'actor', 'save', '2026-07-01T00:00:00.000Z')`,
      )).toThrow();

      // A legacy writer can insert after migration during rolling deployment;
      // reconciliation must discover it and later propagate updates.
      db.run(
        `INSERT INTO feed_artifact_projection (
          artifact_id, rank_score, disposition, visibility, freshness_label,
          reason_codes_json, package_id, source_fingerprint, published_at, updated_at
        ) SELECT 'artifact-late', rank_score, disposition, visibility, freshness_label,
          reason_codes_json, package_id, source_fingerprint, published_at, updated_at
          FROM feed_artifact_projection WHERE artifact_id = 'artifact-old'`,
      );
      expect(db.query(FEED_V1_LEGACY_PROJECTION_PARITY_SQL).get()).toEqual({ mismatch_count: 1 });
      db.run(FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL);
      expect(db.query("SELECT COUNT(*) AS count FROM feed_item_projection").get()).toEqual({ count: 2 });
      expect(db.query(FEED_V1_LEGACY_PROJECTION_PARITY_SQL).get()).toEqual({ mismatch_count: 0 });

      db.run("UPDATE feed_item_projection SET published_at = ? WHERE feed_item_id = ?", [
        "2026-06-30T00:00:00.000Z",
        "legacy:artifact-old",
      ]);
      expect(db.query(FEED_V1_LEGACY_PROJECTION_PARITY_SQL).get()).toEqual({ mismatch_count: 1 });
      db.run("UPDATE feed_item_projection SET published_at = ? WHERE feed_item_id = ?", [
        "2026-07-01T00:00:00.000Z",
        "legacy:artifact-old",
      ]);
      expect(db.query(FEED_V1_LEGACY_PROJECTION_PARITY_SQL).get()).toEqual({ mismatch_count: 0 });

      db.run("UPDATE feed_item_projection SET rank_score = 123, updated_at = ? WHERE feed_item_id = ?", [
        "2026-07-03T00:00:00.000Z",
        "legacy:artifact-old",
      ]);
      db.run("UPDATE feed_artifact_projection SET rank_score = 99, updated_at = ? WHERE artifact_id = ?", [
        "2026-07-02T00:00:00.000Z",
        "artifact-old",
      ]);
      db.run(FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL);
      expect(db.query(
        "SELECT rank_score, updated_at FROM feed_item_projection WHERE feed_item_id = 'legacy:artifact-old'",
      ).get()).toEqual({ rank_score: 123, updated_at: "2026-07-03T00:00:00.000Z" });

      db.run("UPDATE feed_artifact_projection SET rank_score = 100, updated_at = ? WHERE artifact_id = ?", [
        "2026-07-04T00:00:00.000Z",
        "artifact-old",
      ]);
      db.run(FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL);
      expect(db.query(
        "SELECT rank_score, updated_at FROM feed_item_projection WHERE feed_item_id = 'legacy:artifact-old'",
      ).get()).toEqual({ rank_score: 100, updated_at: "2026-07-04T00:00:00.000Z" });

      db.run("DELETE FROM feed_artifact_projection WHERE artifact_id = 'artifact-late'");
      expect(db.query(FEED_V1_LEGACY_PROJECTION_PARITY_SQL).get()).toEqual({ mismatch_count: 1 });
    } finally {
      db.close();
    }
  });
});

function interaction(
  id: string,
  action: "more" | "less" | "save" | "already_knew" | "wrong" | "promote" | string,
  recordedAt: string,
  note?: string,
) {
  return {
    id,
    artifact_id: "legacy-card-1",
    artifact_type: "article",
    action,
    note: note ?? null,
    reader_did: "did:pkh:eip155:1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    nonce: `${id}-nonce`,
    created_at: recordedAt,
    recorded_at: recordedAt,
  };
}

class MemoryMigrationWriter implements FeedV1MigrationWriter {
  readonly artifacts = new Map<string, SqlSeedRow>();
  readonly feed = new Map<string, SqlSeedRow>();
  readonly documents = new Map<string, MigratedFeedArtifact>();

  async writeSqlRows(dbName: "artifacts_index" | "feed_index", rows: SqlSeedRow[]): Promise<void> {
    for (const row of rows) {
      const key = rowKey(row);
      if (dbName === "artifacts_index") {
        this.artifacts.set(key, row);
      } else {
        this.feed.set(`${row.table}:${key}`, row);
      }
    }
  }

  async writeArtifactDocument(artifact: MigratedFeedArtifact): Promise<void> {
    this.documents.set(artifact.storage.docKey, artifact);
  }
}

function rowKey(row: SqlSeedRow): string {
  switch (row.table) {
    case "artifact_index":
      return String(row.values.artifact_id);
    case "feed_item_projection":
      return String(row.values.feed_item_id);
    case "feedback_event":
      return String(row.values.event_id);
    case "control_intent_event":
      return String(row.values.event_id);
    case "generation_request":
      return String(row.values.request_id);
    default:
      return `${row.table}:${Object.values(row.values).join(":")}`;
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
