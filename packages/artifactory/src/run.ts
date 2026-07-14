// Deterministic pipeline for a single workflow run.
// This is the "artifactory smithers.sh" — the CLI holds this logic; the agent
// (eliza-service) invokes it via RUN_ARTIFACT_SKILL. Everything downstream of
// the runtime call is deterministic (validation → dedupe → publish).

import { candidateToArtifact } from "../../../skills/_shared/lib/feed-v1-bootstrap.ts";
import type {
  CredentialMode,
  FeedArtifact,
  FeedWorkflowRun,
  SkillRunInput,
} from "../../../skills/_shared/lib/feed-v1.ts";
import { FEED_V1_PROVIDER_PROFILES } from "../../../skills/_shared/lib/feed-v1.ts";
import type { CostLedger, CostLedgerEntry } from "./cost-ledger.ts";
import type { PublishWriter } from "./publish-writer.ts";
import type { RunLockStore } from "./run-lock.ts";
import {
  redactArtifactSkillRuntimeOutput,
  redactArtifactSkillRuntimeText,
  type ArtifactSkillRuntime,
  type ArtifactSkillRuntimeOutput,
} from "./runtime-adapter.ts";
import type { SourceLedger } from "./source-ledger.ts";
import {
  validateCandidates,
  type DropAudit,
  type DroppedCandidate,
} from "./validation.ts";
import {
  resolveListenResolution,
  type ListenResolverFactory,
  type ListenResolvedConversation,
} from "./listen-resolver.ts";
import { bindAdmittedArtifactPack, type WorkflowFixture } from "./workflow.ts";

export type RunOptions = {
  runId: string;
  ownerId: string;
  workflow: WorkflowFixture;
  now: Date;
  leaseMs: number;
  runtime: ArtifactSkillRuntime;
  runLock: RunLockStore;
  sourceLedger: SourceLedger;
  costLedger: CostLedger;
  publishWriter: PublishWriter;
  dropAudit: DropAudit;
  listenResolverFactory?: ListenResolverFactory;
  priorContext?: SkillRunInput["priorContext"];
};

export type RunResult = {
  status: FeedWorkflowRun["status"];
  workflowRun: FeedWorkflowRun;
  publishedArtifacts: FeedArtifact[];
  dropped: DroppedCandidate[];
  runtimeOutput: ArtifactSkillRuntimeOutput;
  sourcePack: WorkflowFixture["sourcePack"];
  resolvedConversations: ListenResolvedConversation[];
};

export async function executeRun(options: RunOptions): Promise<RunResult> {
  const { runId, ownerId, workflow, now, leaseMs, runtime } = options;
  const nowIso = now.toISOString();
  const boundArtifactPack = bindAdmittedArtifactPack(workflow);

  const gate = await resolveRunGates({
    ownerId,
    workflow,
    costLedger: options.costLedger,
    runId,
    nowIso,
  });
  if (!gate.ok) {
    const workflowRun = makeBlockedWorkflowRun({
      runId,
      workflow,
      nowIso,
      status: gate.status,
      errorCode: gate.errorCode,
      message: gate.message,
      budgetId: gate.budgetId,
      currency: gate.currency,
      droppedReason: gate.droppedReason,
    });
    await options.publishWriter.recordRun(workflowRun);
    return {
      status: gate.status,
      workflowRun,
      publishedArtifacts: [],
      dropped: [],
      runtimeOutput: {
        candidates: [],
        trace: {
          procedureVersion: gate.errorCode,
          modelCalls: 0,
          toolCalls: [],
          stageTrace: [],
          droppedCandidates: [],
        },
      },
      sourcePack: workflow.sourcePack,
      resolvedConversations: [],
    };
  }

  const acquired = await options.runLock.acquire({
    scope: workflow.packageId,
    ownerId,
    runId,
    leaseMs,
    now,
  });
  if (!acquired.ok) {
    // Package lock lost after the budget reservation was taken. Release the
    // reservation so a blocked run does not burn budget.
    await cancelBudgetReservationQuietly(options.costLedger, gate.reservedLedgerId, ownerId);
    const workflowRun = makeBlockedWorkflowRun({
      runId,
      workflow,
      nowIso,
      status: "blocked_authority",
      errorCode: "run_lock_conflict",
      message: `scope ${workflow.packageId} held by ${acquired.heldBy.ownerId}`,
      budgetId: gate.budgetId,
      currency: gate.currency,
      droppedReason: `run_lock_held_by:${acquired.heldBy.ownerId}`,
    });
    await options.publishWriter.recordRun(workflowRun);
    return {
      status: "blocked_authority",
      workflowRun,
      publishedArtifacts: [],
      dropped: [],
      runtimeOutput: {
        candidates: [],
        trace: {
          procedureVersion: "blocked_authority",
          modelCalls: 0,
          toolCalls: [],
          stageTrace: [],
          droppedCandidates: [],
        },
      },
      sourcePack: workflow.sourcePack,
      resolvedConversations: [],
    };
  }

  let completedSuccessfully = false;
  try {
    let sourcePack = workflow.sourcePack;
    let resolvedConversations: ListenResolvedConversation[] = [];
    if (workflow.listenResolution) {
      const listenResolution = workflow.listenResolution;
      const listenResult = await resolveListenResolution(
        listenResolution,
        workflow.sourcePack.maxInputTokens,
        {
          now: () => now,
          driver: options.listenResolverFactory
            ? await options.listenResolverFactory(listenResolution.auth)
            : undefined,
          // skillManifest.limits are hard caps on the packed sources.
          limits: {
            maxSourceRefs: workflow.skillManifest.limits.maxSourceRefs,
            maxInputTokens: workflow.skillManifest.limits.maxInputTokens,
          },
        },
      );
      sourcePack = listenResult.sourcePack;
      resolvedConversations = listenResult.conversations;
    }

    for (const ref of sourcePack.refs) {
      await options.sourceLedger.observe({ runId, ref });
    }

    const skillInput: SkillRunInput = {
      runId,
      skillManifest: workflow.skillManifest,
      sourcePack,
      artifactPack: boundArtifactPack?.runtimePack,
      settings: workflow.settings,
      runtimePolicy: workflow.runtimePolicy,
      secretEnv: gate.secretEnv,
      priorContext: options.priorContext,
    };

    const rawRuntimeOutput = await invokeRuntimeSafely(
      runtime,
      skillInput,
      gate.sensitiveValues,
    );
    const runtimeOutput = redactArtifactSkillRuntimeOutput(
      rawRuntimeOutput,
      gate.sensitiveValues,
    );
    const outcome = validateCandidates(runtimeOutput.candidates, {
      runId,
      audit: options.dropAudit,
      maxAccepted: workflow.maxAcceptedArtifacts,
      trustedSourceRefs: new Map(sourcePack.refs.map((ref) => [ref.sourceRefId, ref])),
      trustedParentArtifacts: boundArtifactPack?.trustedParentArtifacts,
      sourceExcerpts: new Map(sourcePack.refs.map((ref) => [
        ref.sourceRefId,
        sourcePack.excerpts
          .filter((excerpt) => excerpt.sourceRefId === ref.sourceRefId)
          .map((excerpt) => excerpt.text),
      ])),
    });

    const producedBy = {
      packageId: workflow.packageId,
      packageVersion: workflow.version,
      packageDigest: workflow.digest,
      runId,
      runtimeClass: workflow.runtimePolicy.runtimeClass,
      providerClass: workflow.runtimePolicy.providerClass,
      credentialOwner: workflow.runtimePolicy.credentialMode,
      egressClass: workflow.runtimePolicy.egressClass,
      disclosure: workflow.skillManifest.disclosure,
    };

    const published: FeedArtifact[] = [];
    for (const accepted of outcome.accepted) {
      const artifact = candidateToArtifact(
        accepted.candidate,
        producedBy,
        nowIso,
        accepted.verification,
      );
      await options.publishWriter.publish(artifact);
      published.push(artifact);
    }

    const droppedFromRuntime = runtimeOutput.trace.droppedCandidates;
    for (const drop of droppedFromRuntime) {
      options.dropAudit.record(runId, drop);
    }
    const allDropped = [...droppedFromRuntime, ...outcome.dropped];

    const status: FeedWorkflowRun["status"] =
      published.length > 0 ? "published" : "zero_artifacts";

    const workflowRun: FeedWorkflowRun = {
      schemaVersion: "feed.workflow_run.v1",
      runId,
      packageId: workflow.packageId,
      packageDigest: workflow.digest,
      status,
      sourceRefs: sourcePack.refs,
      publishedArtifactIds: published.map((artifact) => artifact.artifactId),
      droppedCandidates: allDropped,
      spend: { budgetId: gate.budgetId, amount: gate.runAmount, currency: gate.currency },
      startedAt: nowIso,
      finishedAt: new Date(now.getTime() + 1).toISOString(),
    };
    await options.publishWriter.recordRun(workflowRun);

    // The reservation from resolveRunGates already appended the entry to the
    // ledger, so we DO NOT call record() again — that would double-count.
    completedSuccessfully = true;

    return {
      status,
      workflowRun,
      publishedArtifacts: published,
      dropped: allDropped,
      runtimeOutput,
      sourcePack,
      resolvedConversations,
    };
  } finally {
    if (!completedSuccessfully) {
      // Runtime threw, publish threw, listen resolve threw, etc. Release the
      // budget reservation so failed runs do not burn budget.
      await cancelBudgetReservationQuietly(options.costLedger, gate.reservedLedgerId, ownerId);
    }
    await options.runLock.release(acquired.row.lockId, ownerId);
  }
}

// Any error surfaced by the runtime.run() call can carry raw secret material
// (provider bodies, secret refs, api-key values). We redact the message,
// stack, and cause chain BEFORE rethrowing so nothing embedded in the error
// leaks past executeRun.
async function invokeRuntimeSafely(
  runtime: ArtifactSkillRuntime,
  input: SkillRunInput,
  sensitiveValues: readonly string[],
): Promise<ArtifactSkillRuntimeOutput> {
  try {
    return await runtime.run(input);
  } catch (err) {
    throw redactError(err, sensitiveValues, "runtime failed");
  }
}

function redactError(
  err: unknown,
  sensitiveValues: readonly string[],
  fallbackMessage: string,
): Error {
  if (!(err instanceof Error)) {
    return new Error(
      redactArtifactSkillRuntimeText(String(err ?? fallbackMessage), sensitiveValues),
    );
  }
  const scrubbedMessage = redactArtifactSkillRuntimeText(err.message, sensitiveValues);
  const scrubbedCause = err.cause !== undefined
    ? redactError(err.cause, sensitiveValues, fallbackMessage)
    : undefined;
  const scrubbed = new Error(scrubbedMessage, scrubbedCause ? { cause: scrubbedCause } : undefined);
  if (err.stack) {
    scrubbed.stack = redactArtifactSkillRuntimeText(err.stack, sensitiveValues);
  }
  return scrubbed;
}

async function cancelBudgetReservationQuietly(
  costLedger: CostLedger,
  ledgerId: string | undefined,
  userId: string,
): Promise<void> {
  if (!ledgerId) return;
  try {
    await costLedger.cancel(ledgerId, userId);
  } catch {
    // Cleanup failure must not shadow the primary result/error surfaced to
    // the caller. The ledger error would also carry provider strings, so we
    // must not rethrow it here.
  }
}

type RunSettingsRecord = Record<string, unknown>;

type CredentialGate = {
  secretEnv: NonNullable<SkillRunInput["secretEnv"]>;
  sensitiveValues: string[];
};

type BudgetGate = {
  budgetId: string;
  runAmount: number;
  currency: string;
  spendClass: "none" | "model" | "media" | "tool";
  reservedLedgerId?: string;
};

type RunGateSuccess = CredentialGate & BudgetGate;

type RunGateFailure = {
  ok: false;
  status: FeedWorkflowRun["status"];
  errorCode: string;
  message: string;
  droppedReason?: string;
  budgetId: string;
  currency: string;
};

type RunGateResult = ({ ok: true } & RunGateSuccess) | RunGateFailure;

async function resolveRunGates(input: {
  ownerId: string;
  workflow: WorkflowFixture;
  costLedger: CostLedger;
  runId: string;
  nowIso: string;
}): Promise<RunGateResult> {
  const settings = asRecord(input.workflow.settings);
  const budget = asRecord(firstDefined(settings, "budget", "budgets", "spend", "metering"));
  const credentials = asRecord(firstDefined(settings, "credentials", "credential", "credentialBinding"));
  const killSwitches = asRecord(firstDefined(settings, "killSwitches", "kill_switches", "controls"));

  const budgetId = stringFromRecord(
    budget,
    "budgetId",
    "id",
    "budget_id",
  ) ?? input.workflow.runtimePolicy.budgetId ?? "m0";
  const currency = stringFromRecord(budget, "currency") ?? "USD";
  const runAmount = numberFromRecord(
    budget,
    "amount",
    "runAmount",
    "estimatedSpend",
    "cost",
  ) ?? 0;
  const spendClass = spendClassFromRecord(budget) ?? (runAmount > 0 ? "model" : "none");

  if (booleanFromRecord(killSwitches, "globalDisabled", "disabled", "paused")) {
    return {
      ok: false,
      status: "blocked_authority",
      errorCode: "run_disabled_global",
      message: "global generation kill switch is enabled",
      budgetId,
      currency,
    };
  }

  const disabledPackages = stringArrayFromRecord(killSwitches, "disabledPackages", "packages");
  if (
    booleanFromRecord(killSwitches, "packageDisabled", "disabledPackage") ||
    disabledPackages.includes(input.workflow.packageId)
  ) {
    return {
      ok: false,
      status: "blocked_authority",
      errorCode: "run_disabled_package",
      message: `package ${input.workflow.packageId} is disabled`,
      budgetId,
      currency,
    };
  }

  const credentialGate = resolveCredentialGate(settings, credentials, input.workflow);
  if (!credentialGate.ok) {
    return {
      ok: false,
      status: "blocked_secret",
      errorCode: credentialGate.errorCode,
      message: credentialGate.message,
      budgetId,
      currency,
    };
  }

  const limit = numberFromRecord(budget, "limit", "maxSpend", "cap", "ceiling");
  const ledgerId = `${input.runId}:${budgetId}:${input.nowIso}`;
  const entry: CostLedgerEntry = {
    ledgerId,
    userId: input.ownerId,
    budgetId,
    windowStart: input.nowIso,
    spendClass,
    amount: runAmount,
    currency,
    runId: input.runId,
    recordedAt: input.nowIso,
  };

  // Atomic check-and-reserve. Errors from the ledger must not leak provider
  // strings — wrap in a generic "budget accounting failed".
  let reservation: Awaited<ReturnType<CostLedger["reserve"]>>;
  try {
    reservation = await input.costLedger.reserve(entry, { limit });
  } catch {
    throw new Error("budget accounting failed");
  }
  if (!reservation.ok) {
    return {
      ok: false,
      status: "blocked_budget",
      errorCode: "budget_exhausted",
      message: `budget ${budgetId} exhausted`,
      budgetId,
      currency,
    };
  }

  const resolvedCredentialGate: CredentialGate = {
    secretEnv: credentialGate.secretEnv,
    sensitiveValues: credentialGate.sensitiveValues,
  };

  return {
    ok: true,
    ...resolvedCredentialGate,
    budgetId,
    runAmount,
    currency,
    spendClass,
    reservedLedgerId: ledgerId,
  };
}

function resolveCredentialGate(
  settings: RunSettingsRecord,
  credentials: RunSettingsRecord | null,
  workflow: WorkflowFixture,
): { ok: true } & CredentialGate | { ok: false; errorCode: string; message: string } {
  const credentialMode = credentialModeFromString(
    stringFromRecord(credentials, "credentialMode", "mode") ??
      stringFromRecord(settings, "credentialMode", "mode") ??
      workflow.runtimePolicy.credentialMode ??
      workflow.skillManifest.disclosure.credentialOwner,
  );

  if (credentialMode === "none") {
    return { ok: true, secretEnv: [], sensitiveValues: [] };
  }

  const secretState = credentialStateFromString(
    stringFromRecord(credentials, "state", "secretState", "availability"),
  );
  if (secretState === "missing_secret") {
    return { ok: false, errorCode: "missing_secret", message: "provider credential missing" };
  }
  if (secretState === "decrypt_denied") {
    return { ok: false, errorCode: "decrypt_denied", message: "provider credential decrypt denied" };
  }
  if (secretState === "provider_auth_failed") {
    return { ok: false, errorCode: "provider_auth_failed", message: "provider credential authentication failed" };
  }

  const secretRef = stringFromRecord(credentials, "secretRef", "secret_ref", "ref");
  const providerId = stringFromRecord(credentials, "providerId", "provider", "provider_id");
  const profile = providerProfileFor(providerId);
  const canonicalSecretRef = profile?.secretRefs[0];
  const resolvedSecretRef =
    credentialMode === "feed_hosted"
      ? canonicalSecretRef && (!secretRef || secretRef === canonicalSecretRef)
        ? canonicalSecretRef
        : undefined
      : secretRef;
  if (!resolvedSecretRef) {
    return { ok: false, errorCode: "missing_secret", message: "provider credential missing" };
  }

  const envName =
    stringFromRecord(credentials, "envName", "secretEnvName", "env") ??
    envNameFromSecretRef(resolvedSecretRef);
  if (!envName) {
    return { ok: false, errorCode: "missing_secret", message: "provider credential missing" };
  }

  return {
    ok: true,
    secretEnv: [
      {
        name: envName,
        secretRef: resolvedSecretRef,
        injection: "env",
        stageId:
          stringFromRecord(credentials, "stageId", "secretStageId") ??
          workflow.skillManifest.stageCapabilities[0]?.stageId ??
          "run",
        source: "worker_injected",
      },
    ],
    sensitiveValues: [resolvedSecretRef],
  };
}

function makeBlockedWorkflowRun(input: {
  runId: string;
  workflow: WorkflowFixture;
  nowIso: string;
  status: FeedWorkflowRun["status"];
  errorCode: string;
  message: string;
  budgetId: string;
  currency: string;
  droppedReason?: string;
}): FeedWorkflowRun {
  return {
    schemaVersion: "feed.workflow_run.v1",
    runId: input.runId,
    packageId: input.workflow.packageId,
    packageDigest: input.workflow.digest,
    status: input.status,
    sourceRefs: input.workflow.sourcePack.refs,
    publishedArtifactIds: [],
    droppedCandidates: input.droppedReason ? [{ reason: input.droppedReason }] : [],
    spend: { budgetId: input.budgetId, amount: 0, currency: input.currency },
    error: { code: input.errorCode, message: input.message },
    startedAt: input.nowIso,
    finishedAt: input.nowIso,
  };
}

function asRecord(value: unknown): RunSettingsRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RunSettingsRecord)
    : {};
}

function firstDefined(record: RunSettingsRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function stringFromRecord(record: RunSettingsRecord | null, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  const value = firstDefined(record, ...keys);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberFromRecord(record: RunSettingsRecord | null, ...keys: string[]): number | undefined {
  if (!record) return undefined;
  const value = firstDefined(record, ...keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanFromRecord(record: RunSettingsRecord | null, ...keys: string[]): boolean {
  if (!record) return false;
  const value = firstDefined(record, ...keys);
  return value === true;
}

function stringArrayFromRecord(record: RunSettingsRecord | null, ...keys: string[]): string[] {
  if (!record) return [];
  const value = firstDefined(record, ...keys);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function spendClassFromRecord(
  record: RunSettingsRecord | null,
): BudgetGate["spendClass"] | undefined {
  const value = stringFromRecord(record, "spendClass", "spend_class");
  if (value === "none" || value === "model" || value === "media" || value === "tool") return value;
  return undefined;
}

function credentialModeFromString(value: string | undefined): CredentialMode {
  switch (value) {
    case "feed_hosted":
    case "user_byok_api_key":
    case "user_oauth_token":
    case "none":
      return value;
    default:
      return "none";
  }
}

function credentialStateFromString(
  value: string | undefined,
): "missing_secret" | "decrypt_denied" | "provider_auth_failed" | "ready" {
  switch (value) {
    case "missing_secret":
    case "decrypt_denied":
    case "provider_auth_failed":
      return value;
    default:
      return "ready";
  }
}

function providerProfileFor(providerId: string | undefined) {
  if (providerId) {
    const profile = FEED_V1_PROVIDER_PROFILES.find((entry) => entry.providerId === providerId);
    if (profile) return profile;
  }
  return FEED_V1_PROVIDER_PROFILES[0];
}

function envNameFromSecretRef(secretRef: string): string | undefined {
  const parts = secretRef.split("/").filter(Boolean);
  return parts[parts.length - 1] || undefined;
}
