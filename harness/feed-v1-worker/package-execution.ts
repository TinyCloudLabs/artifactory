import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileSkillPackage } from "../../packages/artifactory/src/package-compiler.ts";
import { compileOutputBodySchema, type OutputBodyValidator } from "../../packages/artifactory/src/output-schema.ts";
import type { Artifact } from "../../skills/_shared/lib/artifact.ts";
import { candidateToArtifact } from "../../skills/_shared/lib/feed-v1-bootstrap.ts";
import { toFeedArtifact } from "../../skills/_shared/lib/feed-v1-convert.ts";
import {
  validateFeedArtifact,
  type CandidateArtifactEnvelope,
  type FeedArtifact,
  type FeedPost,
  type FeedWorkflowPackage,
  type RenderShape,
  type TranscriptSourceRef,
} from "../../skills/_shared/lib/feed-v1.ts";
import { starterPackageById } from "../../skills/_shared/lib/starter-packages.ts";
import {
  ArtifactQualityRejectedError,
  claudeCommand,
  generateInsightArtifact,
  runClaudeSubprocess,
  sourceTranscriptPath,
  type ClaudeProcessRunner,
  type DraftCard,
  type GenerationInput,
  type GenerationSource,
  type GeneratorKind,
} from "./generate.ts";

export const DEFAULT_WORKFLOW_ID = "artifactory.extract-insights";

export type FeedPostContract = {
  minPosts: number;
  maxPosts: number;
  distinctBodies: boolean;
  evidencePerPost: boolean;
  sectionTargetPerPost?: boolean;
};

export type PackageExecutionProfile = {
  package: FeedWorkflowPackage;
  skillMarkdown: string;
  settingsSchema: unknown;
  settingsDefaults: Record<string, unknown>;
  outputSchema: unknown;
  validateOutputBody: OutputBodyValidator;
  artifactType: string;
  renderShape: RenderShape;
  feedPostContract: FeedPostContract;
};

export type AssembledPackagePrompt = {
  system: string;
  user: string;
  combined: string;
};

type PackagePostDraft = {
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  evidenceSourceIds?: unknown;
  sectionId?: unknown;
};

type PackageCardDraft = {
  markdown?: unknown;
  quote?: unknown;
  attribution?: unknown;
  tags?: unknown;
  sourceQuotes?: unknown;
};

export type PackageGeneratedDraft = {
  title?: unknown;
  body?: unknown;
  posts?: unknown;
  card?: unknown;
  notes?: unknown;
};

export type PackageDraftGenerator = (input: {
  profile: PackageExecutionProfile;
  prompt: AssembledPackagePrompt;
  transcripts: Parameters<NonNullable<GenerationInput["draftGenerator"]>>[0]["transcripts"];
  model: string;
  attempt: number;
  feedback: string[];
  processRunner: ClaudeProcessRunner;
}) => PackageGeneratedDraft | Promise<PackageGeneratedDraft>;

export type PackageExecutionInput = {
  profile: PackageExecutionProfile;
  requestId: string;
  runId: string;
  prompt: string | null;
  settings?: Record<string, unknown>;
  transcriptDirs: string[];
  sources?: GenerationSource[];
  sourceRefs?: TranscriptSourceRef[];
  resolveSourceRefs?: (artifact: Artifact) => TranscriptSourceRef[] | Promise<TranscriptSourceRef[]>;
  model: string;
  generator: GeneratorKind;
  producer: Pick<FeedArtifact["producedBy"], "runtimeClass" | "providerClass" | "credentialOwner" | "egressClass">;
  ffmpegPath?: string;
  generationProcessRunner?: ClaudeProcessRunner;
  criticProcessRunner?: ClaudeProcessRunner;
  packageDraftGenerator?: PackageDraftGenerator;
  onPrompt?: (prompt: AssembledPackagePrompt) => void;
  log?: GenerationInput["log"];
};

export type PackageExecutionResult = {
  feedArtifact: FeedArtifact;
  legacyArtifact: Artifact;
  prompt: AssembledPackagePrompt;
};

export class PackageExecutionProfileError extends Error {
  readonly code = "package_not_admitted";
  readonly retryable = false;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PackageExecutionProfileError";
  }
}

export async function loadPackageExecutionProfile(
  workflowId: string,
  options: { skillsRoot?: string; policyPath?: string } = {},
): Promise<PackageExecutionProfile> {
  if (workflowId === DEFAULT_WORKFLOW_ID) {
    throw new PackageExecutionProfileError("legacy default workflow uses the extract-insights fallback");
  }
  const declared = starterPackageById(workflowId);
  if (!declared) {
    throw new PackageExecutionProfileError(`unknown reviewed starter package for workflowId=${workflowId}`);
  }

  const skillsRoot = options.skillsRoot ?? resolve(import.meta.dir, "../../skills");
  let compiled: Awaited<ReturnType<typeof compileSkillPackage>>;
  try {
    compiled = await compileSkillPackage(join(skillsRoot, declared.packageId), {
      ...(options.policyPath ? { policyPath: options.policyPath } : {}),
    });
  } catch (error) {
    throw new PackageExecutionProfileError(
      `reviewed package ${declared.packageId} failed digest or policy verification`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }

  const identityIssues = packageIdentityIssues(declared, compiled.package);
  if (identityIssues.length > 0) {
    throw new PackageExecutionProfileError(
      `reviewed package ${declared.packageId} does not match the starter registry: ${identityIssues.join("; ")}`,
    );
  }
  const feedPostContract = readFeedPostContract(compiled.workflowPack.feedPostContract);
  const settingsSchema = compiled.manifest.settingsSchemaRef
    ? JSON.parse(await readFile(join(skillsRoot, declared.packageId, compiled.manifest.settingsSchemaRef), "utf8")) as unknown
    : { type: "object", properties: {} };
  return {
    package: declared,
    skillMarkdown: compiled.executionBundle.instructions,
    settingsSchema,
    settingsDefaults: schemaDefaults(settingsSchema),
    outputSchema: compiled.executionBundle.outputSchema,
    validateOutputBody: compileOutputBodySchema(compiled.executionBundle.outputSchema),
    artifactType: compiled.manifest.artifactTypes[0]!,
    renderShape: compiled.manifest.renderShapes[0]!,
    feedPostContract,
  };
}

export function assemblePackagePrompt(input: {
  profile: PackageExecutionProfile;
  settings?: Record<string, unknown>;
  requestPrompt: string | null;
  sourceBatch: string;
  feedback?: string[];
}): AssembledPackagePrompt {
  const effectiveSettings = { ...input.profile.settingsDefaults, ...(input.settings ?? {}) };
  const system = [
    `You execute reviewed Feed package ${input.profile.package.packageId}@${input.profile.package.version}.`,
    "Follow its SKILL.md contract exactly and use only evidence in the supplied source batch.",
    "Preserve uncertainty. Do not invent identity, history, or context.",
    "",
    "SKILL.md contract:",
    input.profile.skillMarkdown.trim(),
    "",
    "Return only one JSON object with this execution envelope:",
    '{"title":"...","body":<package output body>,"posts":[{"kind":"...","title":"...","body":"...","evidenceSourceIds":["<sourceId>"],"sectionId":"..."}],"card":{"markdown":"150-300 grounded words","quote":"exact source quote","attribution":"speaker","tags":["tag1","tag2"],"sourceQuotes":[{"transcript":"<transcript path>","quote":"exact source quote","speaker":"speaker","timestamp":"optional"}]},"notes":"..."}',
    "The body must match this JSON Schema:",
    JSON.stringify(input.profile.outputSchema),
    `Feed post contract: ${JSON.stringify(input.profile.feedPostContract)}.`,
    "Every evidenceSourceIds entry must be a sourceId shown in the source batch.",
  ].join("\n");
  const user = [
    `Package: ${input.profile.package.packageId}`,
    `Settings defaults: ${JSON.stringify(input.profile.settingsDefaults)}`,
    `Effective settings: ${JSON.stringify(effectiveSettings)}`,
    input.requestPrompt?.trim() ? `Reader request: ${input.requestPrompt.trim()}` : "Reader request: none",
    input.feedback && input.feedback.length > 0
      ? `Regeneration feedback (fix every item): ${JSON.stringify(input.feedback)}`
      : "",
    "",
    "Authorized source batch:",
    input.sourceBatch,
  ].filter(Boolean).join("\n");
  return { system, user, combined: `SYSTEM\n${system}\n\nUSER\n${user}` };
}

export async function executePackageProfile(input: PackageExecutionInput): Promise<PackageExecutionResult> {
  let latestDraft: PackageGeneratedDraft | undefined;
  let latestPrompt: AssembledPackagePrompt | undefined;
  const generator = input.packageDraftGenerator ?? (input.generator === "stub" ? stubPackageDraft : modelPackageDraft);
  const processRunner = input.generationProcessRunner ?? runClaudeSubprocess;
  let promptedSourceIds = new Set<string>();

  const legacyArtifact = await generateInsightArtifact({
    requestId: input.requestId,
    prompt: input.prompt,
    transcriptDirs: input.transcriptDirs,
    sources: input.sources,
    model: input.model,
    generator: input.generator,
    ffmpegPath: input.ffmpegPath,
    criticProcessRunner: input.criticProcessRunner,
    log: input.log,
    draftGenerator: async ({ transcripts, chunks, model, attempt, feedback }) => {
      const promptedPaths = new Set(chunks.map((chunk) => chunk.transcript));
      const promptedSources = (input.sources ?? []).filter((source) => promptedPaths.has(sourceTranscriptPath(source.sourceId)));
      promptedSourceIds = new Set(promptedSources.map((source) => source.sourceId));
      if (promptedSourceIds.size === 0) {
        promptedSourceIds = new Set(chunks.map((chunk) => chunk.transcript));
      }
      const sourceCatalog = promptedSources.map((source) =>
        `sourceId=${source.sourceId}; title=${source.title}; transcript=${sourceTranscriptPath(source.sourceId)}`
      ).join("\n");
      const sourceBatch = [
        sourceCatalog ? `Source catalog:\n${sourceCatalog}` : "",
        chunks
          .map((chunk) => `--- transcript: ${chunk.transcript} (chunk ${chunk.index}) ---\n${chunk.text}`)
          .join("\n\n"),
      ].filter(Boolean).join("\n\n");
      const prompt = assemblePackagePrompt({
        profile: input.profile,
        settings: input.settings,
        requestPrompt: input.prompt,
        sourceBatch,
        feedback,
      });
      latestPrompt = prompt;
      input.onPrompt?.(prompt);
      latestDraft = await generator({
        profile: input.profile,
        prompt,
        transcripts,
        model,
        attempt,
        feedback,
        processRunner,
      });
      return packageDraftToCard(latestDraft, input.profile.package.displayName);
    },
    additionalDraftIssues: () => latestDraft
      ? packageDraftIssues(latestDraft, input.profile, promptedSourceIds)
      : ["package generator did not return a draft"],
  });

  if (!latestDraft || !latestPrompt) {
    throw new ArtifactQualityRejectedError(["package generator did not return a draft"], legacyArtifact.source_transcripts);
  }
  const finalIssues = packageDraftIssues(latestDraft, input.profile, promptedSourceIds);
  if (finalIssues.length > 0) {
    throw new ArtifactQualityRejectedError(finalIssues, legacyArtifact.source_transcripts);
  }
  const resolvedSourceRefs = input.sourceRefs
    ?? await input.resolveSourceRefs?.(legacyArtifact)
    ?? (await toFeedArtifact(legacyArtifact, { runId: input.runId })).sourceRefs;
  const candidate = packageDraftToCandidate(latestDraft, legacyArtifact, input.profile, resolvedSourceRefs);
  const feedArtifact = candidateToArtifact(candidate, {
    packageId: input.profile.package.packageId,
    packageVersion: input.profile.package.version,
    packageDigest: input.profile.package.digest,
    runId: input.runId,
    ...input.producer,
    disclosure: input.profile.package.disclosure,
  }, legacyArtifact.generated_at);
  const finalContractIssues = assertFeedPostContract(feedArtifact.posts ?? [], input.profile.feedPostContract);
  const bodyIssues = input.profile.validateOutputBody(feedArtifact.body);
  const validated = validateFeedArtifact(feedArtifact);
  if (bodyIssues.length > 0 || finalContractIssues.length > 0 || !validated.ok) {
    throw new ArtifactQualityRejectedError([
      ...bodyIssues.map((issue) => `package output body ${issue}`),
      ...finalContractIssues,
      ...(validated.ok ? [] : validated.errors),
    ], legacyArtifact.source_transcripts);
  }
  return { feedArtifact: validated.value, legacyArtifact, prompt: latestPrompt };
}

export function assertFeedPostContract(
  posts: Array<FeedPost | PackagePostDraft>,
  contract: FeedPostContract,
): string[] {
  const issues: string[] = [];
  if (posts.length < contract.minPosts || posts.length > contract.maxPosts) {
    issues.push(`feed posts must contain ${contract.minPosts}-${contract.maxPosts} posts (received ${posts.length})`);
  }
  if (contract.distinctBodies) {
    const bodies = posts.map((post) => typeof post.body === "string" ? normalizeText(post.body) : "");
    if (bodies.some((body) => body.length === 0)) issues.push("every feed post must have a nonempty body");
    if (new Set(bodies).size !== bodies.length) issues.push("feed post bodies must be distinct");
  }
  if (contract.evidencePerPost) {
    posts.forEach((post, index) => {
      const evidence = "evidence" in post ? post.evidence : post.evidenceSourceIds;
      if (!Array.isArray(evidence) || evidence.length === 0) {
        issues.push(`feed post ${index + 1} must include evidence`);
      }
    });
  }
  if (contract.sectionTargetPerPost) {
    posts.forEach((post, index) => {
      const sectionId = "expansionTarget" in post ? post.expansionTarget.sectionId : post.sectionId;
      if (typeof sectionId !== "string" || !sectionId.trim()) {
        issues.push(`feed post ${index + 1} must target an artifact section`);
      }
    });
  }
  return issues;
}

function packageDraftIssues(
  draft: PackageGeneratedDraft,
  profile: PackageExecutionProfile,
  knownSourceIds: Set<string>,
): string[] {
  const issues = profile.validateOutputBody(draft.body).map((issue) => `package output body ${issue}`);
  const posts = Array.isArray(draft.posts) ? draft.posts as PackagePostDraft[] : [];
  issues.push(...assertFeedPostContract(posts, profile.feedPostContract));
  if (typeof draft.title !== "string" || !draft.title.trim()) issues.push("package output title must be nonempty");
  posts.forEach((post, postIndex) => {
    if (typeof post.kind !== "string" || !/^[a-z][a-z0-9]*(?:[._/-][a-z0-9_]+)*$/.test(post.kind)) {
      issues.push(`feed post ${postIndex + 1} kind must be lowercase and stable`);
    }
    if (!Array.isArray(post.evidenceSourceIds)) return;
    post.evidenceSourceIds.forEach((sourceId) => {
      if (typeof sourceId !== "string" || (!knownSourceIds.has(sourceId) && knownSourceIds.size > 0)) {
        issues.push(`feed post ${postIndex + 1} references an unknown sourceId`);
      }
    });
  });
  return [...new Set(issues)];
}

function packageDraftToCard(draft: PackageGeneratedDraft, displayName: string): DraftCard {
  const card = record(draft.card) as PackageCardDraft | undefined;
  const sourceQuotes = Array.isArray(card?.sourceQuotes) ? card.sourceQuotes.flatMap((value) => {
    const quote = record(value);
    return typeof quote?.quote === "string" && typeof quote.transcript === "string"
      ? [{
          quote: quote.quote,
          transcript: quote.transcript,
          ...(typeof quote.speaker === "string" ? { speaker: quote.speaker } : {}),
          ...(typeof quote.timestamp === "string" ? { timestamp: quote.timestamp } : {}),
        }]
      : [];
  }) : [];
  return {
    headline: typeof draft.title === "string" ? draft.title : `${displayName} output`,
    body: typeof card?.markdown === "string" ? card.markdown : "",
    quote: typeof card?.quote === "string" ? card.quote : undefined,
    attribution: typeof card?.attribution === "string" ? card.attribution : undefined,
    tags: Array.isArray(card?.tags) ? card.tags.filter((tag): tag is string => typeof tag === "string") : [],
    source_quotes: sourceQuotes,
    notes: typeof draft.notes === "string" ? draft.notes : undefined,
  };
}

function packageDraftToCandidate(
  draft: PackageGeneratedDraft,
  artifact: Artifact,
  profile: PackageExecutionProfile,
  sourceRefs: TranscriptSourceRef[],
): CandidateArtifactEnvelope {
  const posts = (draft.posts as PackagePostDraft[]).map((post, postIndex) => ({
    kind: post.kind as string,
    ...(typeof post.title === "string" && post.title.trim() ? { title: post.title.trim() } : {}),
    body: post.body as string,
    evidence: (post.evidenceSourceIds as string[]).map((sourceId, evidenceIndex) => {
      const source = sourceRefs.find((ref) => ref.sourceId === sourceId || ref.sourceRefId === sourceId);
      if (!source) throw new Error(`package post source was not observed: ${sourceId}`);
      return {
        kind: "located_source" as const,
        evidenceId: `source-${postIndex + 1}-${evidenceIndex + 1}`,
        sourceRefId: source.sourceRefId,
        loc: source.quoteLineRefs?.[0] ?? "authorized transcript",
      };
    }),
    ...(typeof post.sectionId === "string" ? { sectionId: post.sectionId } : {}),
  }));
  const sectionIds = posts.flatMap((post) => post.sectionId ? [post.sectionId] : []);
  return {
    schemaVersion: "feed.candidate_artifact.v1",
    localCandidateId: artifact.id,
    artifactType: profile.artifactType,
    renderShape: profile.renderShape,
    title: (draft.title as string).trim(),
    summary: artifact.body?.replace(/\s+/g, " ").trim().slice(0, 240),
    body: draft.body,
    renderHints: {
      generationModel: artifact.generation_model ?? "unknown",
      quality: artifact.quality,
      heroImage: artifact.hero_image,
      sectionIds,
    },
    sourceRefs,
    feedSurface: { mode: "posts" },
    posts,
    quality: {
      criticPass: artifact.quality.critic_pass,
      quotesVerified: artifact.quality.quotes_verified,
      reasons: [],
      warnings: [],
    },
    idempotencyBasis: {
      sourceFingerprintMaterial: sourceRefs.map((source) => `${source.sourceId}:${source.observedHash}`),
      artifactFingerprintMaterial: { title: draft.title, body: draft.body },
    },
  };
}

async function modelPackageDraft(input: Parameters<PackageDraftGenerator>[0]): Promise<PackageGeneratedDraft> {
  const output = await input.processRunner(
    [...claudeCommand(input.model), "--system-prompt", input.prompt.system],
    input.prompt.user,
    "generation",
  );
  return parsePackageJson(output);
}

function stubPackageDraft(input: Parameters<PackageDraftGenerator>[0]): PackageGeneratedDraft {
  const transcript = input.transcripts[0]!;
  const turns = transcript.turns.filter((turn) => turn.text.trim().length >= 40);
  const anchor = (turns.length > 0 ? turns : transcript.turns)[0]!;
  const sourceId = transcript.path.startsWith("listen:") ? transcript.path.slice("listen:".length) : transcript.path;
  const packageId = input.profile.package.packageId;
  const displayName = input.profile.package.displayName;
  const minPosts = input.profile.feedPostContract.minPosts;
  const sectionIds = Array.from({ length: minPosts }, (_, index) => `${packageId}-section-${index + 1}`);
  const posts = sectionIds.map((sectionId, index) => ({
    kind: packageId.replace(/^feed-/, "").replaceAll("-", "_"),
    title: `${displayName}: evidence ${index + 1}`,
    body: `${displayName} finding ${index + 1}: the authorized review ties the operating choice to a measurable threshold and a named follow-up.`,
    evidenceSourceIds: [sourceId],
    ...(input.profile.feedPostContract.sectionTargetPerPost ? { sectionId } : {}),
  }));
  return {
    title: `${displayName}: launch readiness signal`,
    body: stubBody(packageId, sourceId),
    posts,
    card: {
      markdown: stubCardMarkdown(displayName),
      quote: anchor.text.trim(),
      attribution: anchor.speaker ?? "Source",
      tags: [packageId.replace(/^feed-/, ""), "operations"],
      sourceQuotes: [{
        transcript: transcript.path,
        quote: anchor.text.trim(),
        speaker: anchor.speaker,
        timestamp: anchor.timestamp,
      }],
    },
    notes: `deterministic ${packageId} package stub`,
  };
}

function stubBody(packageId: string, sourceId: string): unknown {
  switch (packageId) {
    case "feed-daily-brief":
      return {
        audienceRole: "operator",
        priorities: [{ development: "The launch gate is now measurable.", implication: "Rehearsal and rollback ownership determine Friday readiness.", confidence: "high", evidenceSourceIds: [sourceId] }],
        followUps: ["Confirm the compatibility gate can be tested before Wednesday."],
      };
    case "feed-short-insights":
      return {
        insights: [
          { claim: "Friday is conditional on two explicit gates.", implication: "Readiness can be decided before launch day.", evidenceSourceIds: [sourceId] },
          { claim: "Parser failures exceeded the normal baseline.", implication: "The compatibility path needs an immediate decision.", evidenceSourceIds: [sourceId] },
        ],
      };
    case "feed-exception-alert":
      return { baseline: "Two failed imports per thousand.", deviation: "Eighteen failures per thousand after enabling the parser.", impact: "The customer migration is at risk.", urgency: "high", confidence: "high", evidenceSourceIds: [sourceId] };
    case "feed-synthesis-report":
      return { assessment: "Launch readiness depends on reconciling schedule pressure with parser reliability.", findings: [{ finding: "The team has explicit gates and rollback options.", confidence: "high", evidenceSourceIds: [sourceId] }], uncertainties: ["Compatibility-gate test capacity is unresolved."], dissent: ["Keeping the parser and rolling it back remain live options."] };
    case "feed-decision-memo":
      return { decision: "Whether to keep the parser for the customer migration.", options: [{ label: "Compatibility gate", description: "Keep the parser behind a tested gate.", tradeoffs: ["Preserves Friday but needs engineering capacity."], evidenceSourceIds: [sourceId] }, { label: "Rollback", description: "Restore the prior parser and delay migration.", tradeoffs: ["Reduces parser risk but moves the schedule."], evidenceSourceIds: [sourceId] }], openQuestions: ["Can the gate be tested before Wednesday?"] };
    case "feed-playbook":
      return { outcome: "Decide whether the migration is safe to launch.", owner: "Rollback owner", prerequisites: ["Queue snapshot", "Canary tenant"], steps: [{ instruction: "Snapshot the queue and run the rehearsal against the canary tenant.", caution: "Stop above five failures per thousand.", evidenceSourceIds: [sourceId] }], validationChecks: ["Compare the rehearsal error rate with the stop threshold."] };
    default:
      return {};
  }
}

function stubCardMarkdown(displayName: string): string {
  return [
    `## ${displayName} operating signal`,
    "",
    `The authorized launch review gives this ${displayName.toLowerCase()} a concrete center: Friday remains possible, but only if the migration rehearsal finishes by Wednesday and rollback ownership is explicit. That is more useful than a generic status summary because it names the conditions that turn schedule confidence into an observable decision. The same source also establishes a reliability baseline of two failed imports per thousand and records a sharp deviation after the new parser was enabled.`,
    "",
    "The practical implication is to treat the rehearsal as a decision gate, not a ceremonial checkpoint. Snapshot the queue, exercise the canary tenant, compare the resulting error rate with the agreed stop threshold, and make the compatibility choice while there is still time to preserve a controlled rollback. The evidence supports both the urgency and the available alternatives without pretending that the unresolved staffing question has already been answered.",
    "",
    "This framing keeps the output grounded in what the team actually said. It separates the measured deviation from the inferred consequence, carries forward the open question about test capacity, and gives the reader a specific place to verify whether launch readiness has improved.",
  ].join("\n");
}

function parsePackageJson(output: string): PackageGeneratedDraft {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced);
  } catch (error) {
    throw new Error("package generator returned invalid JSON", error instanceof Error ? { cause: error } : undefined);
  }
  if (!record(parsed)) throw new Error("package generator output must be a JSON object");
  return parsed as PackageGeneratedDraft;
}

function packageIdentityIssues(declared: FeedWorkflowPackage, compiled: FeedWorkflowPackage): string[] {
  const issues: string[] = [];
  for (const field of ["packageId", "version", "digest", "workflowRef", "workflowDigest", "admissionState"] as const) {
    if (declared[field] !== compiled[field]) issues.push(`${field} mismatch`);
  }
  if (JSON.stringify(declared.disclosure) !== JSON.stringify(compiled.disclosure)) issues.push("disclosure mismatch");
  if (JSON.stringify(declared.trigger) !== JSON.stringify(compiled.trigger)) issues.push("trigger mismatch");
  return issues;
}

function readFeedPostContract(value: unknown): FeedPostContract {
  const contract = record(value);
  if (
    !contract ||
    !Number.isInteger(contract.minPosts) ||
    !Number.isInteger(contract.maxPosts) ||
    (contract.minPosts as number) < 1 ||
    (contract.maxPosts as number) < (contract.minPosts as number) ||
    contract.distinctBodies !== true ||
    contract.evidencePerPost !== true ||
    (contract.sectionTargetPerPost !== undefined && typeof contract.sectionTargetPerPost !== "boolean")
  ) {
    throw new PackageExecutionProfileError("reviewed starter has an invalid feedPostContract");
  }
  return {
    minPosts: contract.minPosts as number,
    maxPosts: contract.maxPosts as number,
    distinctBodies: true,
    evidencePerPost: true,
    ...(typeof contract.sectionTargetPerPost === "boolean" ? { sectionTargetPerPost: contract.sectionTargetPerPost } : {}),
  };
}

function schemaDefaults(schema: unknown): Record<string, unknown> {
  const object = record(schema);
  const properties = record(object?.properties);
  if (!properties) return {};
  const defaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    const property = record(value);
    if (property && "default" in property) defaults[key] = property.default;
  }
  return defaults;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}
