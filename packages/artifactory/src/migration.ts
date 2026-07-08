import {
  kvPutString,
  sqlExecute,
  sqlQuery,
  type SqlQueryResult,
} from "../../../skills/_shared/lib/tc.ts";
import {
  applyFeedV1MigrationPlan,
  buildFeedV1MigrationPlan,
  LEGACY_FEED_DB_PATH,
  LEGACY_INTERACTIONS_DB_PATH,
  type FeedV1MigrationPlan,
  type FeedV1MigrationSummary,
  type FeedV1MigrationWriter,
  type MigratedFeedArtifact,
} from "../../../skills/_shared/lib/feed-v1-migration.ts";
import {
  FEED_V1_ARTIFACTS_INDEX_DB_PATH,
  FEED_V1_FEED_INDEX_DB_PATH,
} from "../../../skills/_shared/lib/feed-v1-schema.ts";

export type MigrationCliIO = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

export type MigrationCliResult = { exitCode: number };

export async function runMigrationCommand(input: {
  argv: string[];
  io: MigrationCliIO;
}): Promise<MigrationCliResult> {
  const { argv, io } = input;
  const flags = parseFlags(argv);
  const dryRun = flags["dry-run"] === "true";
  const profile = flags.profile;
  const space = flags.space;

  const target = space ? { space } : {};
  const opts = profile ? { profile } : {};

  const legacyArtifacts = await queryRowsOrEmpty(
    "SELECT * FROM artifact ORDER BY published_at ASC, id ASC",
    { db: LEGACY_FEED_DB_PATH, ...target },
    opts,
  );
  const legacyInteractions = await queryRowsOrEmpty(
    "SELECT * FROM interaction ORDER BY recorded_at ASC, id ASC",
    { db: LEGACY_INTERACTIONS_DB_PATH, ...target },
    opts,
  );

  const plan = buildFeedV1MigrationPlan({ legacyArtifacts, legacyInteractions });
  const summary = await applyFeedV1MigrationPlan(plan, cliWriter({ target, opts }), { dryRun });

  io.stdout(
    JSON.stringify(
      {
        command: "migrate",
        dryRun,
        space: space ?? null,
        ...summary,
        audits: plan.audits,
      },
      null,
      2,
    ),
  );
  return { exitCode: 0 };
}

function cliWriter(input: {
  target: { space?: string };
  opts: { profile?: string };
}): FeedV1MigrationWriter {
  return {
    async writeSqlRows(dbName, rows) {
      const dbPath = dbName === "artifacts_index" ? FEED_V1_ARTIFACTS_INDEX_DB_PATH : FEED_V1_FEED_INDEX_DB_PATH;
      for (const row of rows) {
        const statement = insertSql(row);
        await sqlExecute(statement, { db: dbPath, space: input.target.space }, Object.values(row.values), input.opts);
      }
    },
    async writeArtifactDocument(artifact) {
      await kvPutString(artifact.storage.docKey, JSON.stringify(artifact), input.target, input.opts);
    },
  };
}

async function queryRowsOrEmpty(
  statement: string,
  target: { db: string; space?: string },
  opts: { profile?: string },
): Promise<Record<string, unknown>[]> {
  try {
    const result = await sqlQuery(statement, target, undefined, opts);
    return rowsToObjects(result);
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

function rowsToObjects(result: SqlQueryResult): Record<string, unknown>[] {
  return result.rows.map((row) => {
    if (!Array.isArray(row)) return row as Record<string, unknown>;
    return Object.fromEntries(result.columns.map((column, index) => [column, row[index]]));
  });
}

function insertSql(row: { table: string; values: Record<string, string | number | null> }): string {
  const keys = Object.keys(row.values);
  const columns = keys.map(identifier).join(", ");
  const placeholders = keys.map(() => "?").join(", ");
  return `INSERT OR REPLACE INTO ${identifier(row.table)} (${columns}) VALUES (${placeholders})`;
}

function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`unsafe SQL identifier: ${value}`);
  return value;
}

function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table/i.test(message);
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || !arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

export type { FeedV1MigrationPlan, FeedV1MigrationSummary, MigratedFeedArtifact };
