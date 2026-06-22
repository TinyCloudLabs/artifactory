import type { ArtifactType } from "../../../skills/_shared/lib/formats.ts";
import type { HeldArtifactRef, PublishedRef, RunMediaSummary } from "./runner.ts";

export interface AgentRunProofCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AgentRunProof {
  ok: boolean;
  targetArtifactType?: ArtifactType;
  checks: AgentRunProofCheck[];
}

export function summarizeRunProofMedia(published: readonly PublishedRef[] | undefined): RunMediaSummary {
  const summary: RunMediaSummary = { heroImages: 0, audio: 0, video: 0 };
  for (const artifact of Array.isArray(published) ? published : []) {
    if (artifact?.media?.heroImage) summary.heroImages += 1;
    if (artifact?.media?.audio) summary.audio += 1;
    if (artifact?.media?.video) summary.video += 1;
  }
  return summary;
}

function check(name: string, ok: boolean, detail: string): AgentRunProofCheck {
  return { name, ok, detail };
}

function publishedLabels(published: readonly PublishedRef[]): string {
  return published.length > 0
    ? published.map((artifact) => `${artifact.type}/${artifact.slug}`).join(", ")
    : "none";
}

function heldLabels(held: readonly HeldArtifactRef[]): string {
  return held.length > 0
    ? held.map((artifact) => `${artifact.type}/${artifact.slug}: ${artifact.reason}`).join("; ")
    : "none";
}

function proofMediaCheck(targetArtifactType: ArtifactType, artifact: PublishedRef): AgentRunProofCheck | null {
  if (targetArtifactType === "clip") {
    return check("target: clip has video", Boolean(artifact.media?.video), `${artifact.type}/${artifact.slug}`);
  }
  if (targetArtifactType === "podcast") {
    return check("target: podcast has audio", Boolean(artifact.media?.audio), `${artifact.type}/${artifact.slug}`);
  }
  if (targetArtifactType === "article") {
    return check("target: article has hero image", Boolean(artifact.media?.heroImage), `${artifact.type}/${artifact.slug}`);
  }
  return null;
}

export function verifyAgentRunProof({
  targetArtifactType,
  published,
  held,
  media,
}: {
  targetArtifactType?: ArtifactType;
  published: readonly PublishedRef[];
  held?: readonly HeldArtifactRef[];
  media: RunMediaSummary;
}): AgentRunProof {
  if (!targetArtifactType) {
    return {
      ok: true,
      checks: [check("target: auto", true, "no explicit artifact target requested")],
    };
  }

  const checks: AgentRunProofCheck[] = [];
  const matching = published.filter((artifact) => artifact.type === targetArtifactType);
  checks.push(
    check(
      `target: published ${targetArtifactType}`,
      matching.length > 0,
      matching.length > 0 ? publishedLabels(matching) : `published=${publishedLabels(published)}; held=${heldLabels(held ?? [])}`,
    ),
  );

  const mediaCheck = matching[0] ? proofMediaCheck(targetArtifactType, matching[0]) : null;
  if (mediaCheck) checks.push(mediaCheck);

  if (targetArtifactType === "clip") {
    checks.push(check("target: aggregate video count", media.video >= 1, String(media.video)));
  } else if (targetArtifactType === "podcast") {
    checks.push(check("target: aggregate audio count", media.audio >= 1, String(media.audio)));
  } else if (targetArtifactType === "article") {
    checks.push(check("target: aggregate hero image count", media.heroImages >= 1, String(media.heroImages)));
  }

  return {
    ok: checks.every((item) => item.ok),
    targetArtifactType,
    checks,
  };
}
