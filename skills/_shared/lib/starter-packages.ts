// Reviewed first-party starter workflow packages with their human-readable
// presentation (TC-182). The identity/authority fields (digests, refs,
// version) are copied verbatim from the compiled packages and pinned by
// policies/reviewed-bundle-policy.json; tests/artifactory/
// starter-packages-module.test.ts recompiles the starters and fails if this
// module drifts. Presentation is display-only copy for the routine controls
// in Feed's Access & automation view.
//
// Feed Host imports this module to admit the reviewed starter pack for every
// actor at bootstrap, so unrun routines appear in the workflow library.

import type { FeedWorkflowPackage } from "./feed-v1.ts";

export const REVIEWED_STARTER_PACKAGES: FeedWorkflowPackage[] = [
  {
    schemaVersion: "feed.workflow_package.v1",
    packageId: "feed-daily-brief",
    displayName: "Daily Brief",
    version: "0.1.0",
    digest: "sha256:f58716ce1654c91eee24abd4b768cd5cbf8275620af15c8d4a78f1740f82a9be",
    manifestKey: "packages/feed-daily-brief/manifest.json",
    workflowRef: "workflows/feed-daily-brief.stub.json",
    workflowDigest: "sha256:b60023c21c35a3ff09d1860f1eee5b199e95261768a5886194960dbef8448487",
    admissionState: "reviewed_first_party",
    trigger: {
      kind: "scheduled",
      cadence: "daily",
    },
    disclosure: {
      userCopy: "Creates a daily role-aware briefing from authorized context, with confidence, implications, and continuity.\n",
      credentialOwner: "none",
      providerClass: "none",
      egressClass: "none",
    },
    presentation: {
      schemaVersion: "feed.workflow_presentation.v1",
      purpose: "Builds a daily briefing from your recent conversations, with what changed, why it matters, and what to watch.",
      triggerLabel: "Runs once a day",
      cadenceLabel: "Daily",
      sourcesLabel: "Authorized conversations since your last brief",
      audienceLabel: "Private to you",
      exampleTitles: ["Daily Brief: three decisions moved forward", "Daily Brief: quiet day, one open question"],
    },
  },
  {
    schemaVersion: "feed.workflow_package.v1",
    packageId: "feed-short-insights",
    displayName: "Short Insights",
    version: "0.1.0",
    digest: "sha256:89e7989ffb9c5e23e2479269884db30caa11b3f96e3fdf023e44e222b18b227c",
    manifestKey: "packages/feed-short-insights/manifest.json",
    workflowRef: "workflows/feed-short-insights.stub.json",
    workflowDigest: "sha256:61d6fed576448c643b38d6e014fde758cd3d22124c554a6728a2663321d02fff",
    admissionState: "reviewed_first_party",
    trigger: {
      kind: "source_event",
      cadence: "on_new_authorized_content",
    },
    disclosure: {
      userCopy: "Reads only unseen authorized transcript content and creates distinct evidence-backed insights and Feed posts.\n",
      credentialOwner: "none",
      providerClass: "none",
      egressClass: "none",
    },
    presentation: {
      schemaVersion: "feed.workflow_presentation.v1",
      purpose: "Turns new conversations into short, evidence-backed insights you can read in under a minute.",
      triggerLabel: "Runs when new conversations arrive",
      cadenceLabel: "As new content arrives",
      sourcesLabel: "New authorized conversations you haven't seen insights from yet",
      audienceLabel: "Private to you",
      exampleTitles: ["The budget freeze only applies to new vendors", "One team is quietly blocking the launch date"],
    },
  },
  {
    schemaVersion: "feed.workflow_package.v1",
    packageId: "feed-exception-alert",
    displayName: "Exception Alert",
    version: "0.1.0",
    digest: "sha256:f3318540de3311fb3087345b9958a3735a6e3e41b3620c1f579b95a69ddffe57",
    manifestKey: "packages/feed-exception-alert/manifest.json",
    workflowRef: "workflows/feed-exception-alert.stub.json",
    workflowDigest: "sha256:3a57a28dd5bebe9d29c89458da3b0a681ffc929907800620867823c7aa28eee3",
    admissionState: "reviewed_first_party",
    trigger: {
      kind: "source_event",
      cadence: "on_new_authorized_content",
    },
    disclosure: {
      userCopy: "Checks authorized context for meaningful deviations and stays silent when nothing requires attention.\n",
      credentialOwner: "none",
      providerClass: "none",
      egressClass: "none",
    },
    presentation: {
      schemaVersion: "feed.workflow_presentation.v1",
      purpose: "Watches your conversations for surprises \u2014 commitments, risks, and changes that break an expected pattern.",
      triggerLabel: "Runs when new conversations arrive",
      cadenceLabel: "As new content arrives",
      sourcesLabel: "Authorized conversations since the last check",
      audienceLabel: "Private to you",
      exampleTitles: ["Heads up: the deadline moved without an owner", "A promised follow-up never happened"],
    },
  },
  {
    schemaVersion: "feed.workflow_package.v1",
    packageId: "feed-synthesis-report",
    displayName: "Synthesis Report",
    version: "0.1.0",
    digest: "sha256:5fab0ac3798b5ba4a03c996f5273643f2a7c132207a4a4f59daf6bf3532f73cd",
    manifestKey: "packages/feed-synthesis-report/manifest.json",
    workflowRef: "workflows/feed-synthesis-report.stub.json",
    workflowDigest: "sha256:8cc22f31525b81be610fec749614dc2a0efb230ce55b8c3cf420840d7e8ea761",
    admissionState: "reviewed_first_party",
    trigger: {
      kind: "on_demand",
      cadence: "human_or_authorized_agent",
    },
    disclosure: {
      userCopy: "Creates an on-demand synthesis from selected authorized context and preserves evidence, uncertainty, and dissent.\n",
      credentialOwner: "none",
      providerClass: "none",
      egressClass: "none",
    },
    presentation: {
      schemaVersion: "feed.workflow_presentation.v1",
      purpose: "Weaves the conversations you pick into one connected report with themes, tensions, and takeaways.",
      triggerLabel: "Runs when you ask",
      cadenceLabel: "On demand",
      sourcesLabel: "Conversations you select",
      audienceLabel: "Private to you",
      exampleTitles: ["What the last month of hiring calls actually says"],
    },
  },
  {
    schemaVersion: "feed.workflow_package.v1",
    packageId: "feed-decision-memo",
    displayName: "Decision Memo",
    version: "0.1.0",
    digest: "sha256:0afb13be1f99854ca9c501f365d97f72a2a5e5a74d7b0a631ab8847190b24fa1",
    manifestKey: "packages/feed-decision-memo/manifest.json",
    workflowRef: "workflows/feed-decision-memo.stub.json",
    workflowDigest: "sha256:de877625018ee11322a8c7dd7cbc1483acde26c1d6a0ae4bf3cb8c68a474ca3c",
    admissionState: "reviewed_first_party",
    trigger: {
      kind: "on_demand",
      cadence: "human_or_authorized_agent",
    },
    disclosure: {
      userCopy: "Creates an on-demand decision memo from selected authorized context with options, tradeoffs, evidence, and open questions.\n",
      credentialOwner: "none",
      providerClass: "none",
      egressClass: "none",
    },
    presentation: {
      schemaVersion: "feed.workflow_presentation.v1",
      purpose: "Drafts a decision memo from the conversations you pick: options, evidence, and a recommendation.",
      triggerLabel: "Runs when you ask",
      cadenceLabel: "On demand",
      sourcesLabel: "Conversations you select",
      audienceLabel: "Private to you",
      exampleTitles: ["Decision memo: build the importer now or wait a quarter"],
    },
  },
  {
    schemaVersion: "feed.workflow_package.v1",
    packageId: "feed-playbook",
    displayName: "Playbook",
    version: "0.1.0",
    digest: "sha256:22d416f1d04906f9b4f86937f54c5dcbca333b3af6b354c7738288d809ad96d5",
    manifestKey: "packages/feed-playbook/manifest.json",
    workflowRef: "workflows/feed-playbook.stub.json",
    workflowDigest: "sha256:ce5b5ab58946bef9adc30b0f40392e469eda053b0e36ca603a8fa863eef06ce1",
    admissionState: "reviewed_first_party",
    trigger: {
      kind: "on_demand",
      cadence: "human_or_authorized_agent",
    },
    disclosure: {
      userCopy: "Turns an operational process from selected authorized conversations into an evidence-backed playbook and actionable Feed posts.\n",
      credentialOwner: "none",
      providerClass: "none",
      egressClass: "none",
    },
    presentation: {
      schemaVersion: "feed.workflow_presentation.v1",
      purpose: "Captures how you handled something as a reusable playbook: steps, pitfalls, and what good looks like.",
      triggerLabel: "Runs when you ask",
      cadenceLabel: "On demand",
      sourcesLabel: "Conversations you select",
      audienceLabel: "Private to you",
      exampleTitles: ["Playbook: running a customer incident call"],
    },
  },
];

export function starterPackageById(packageId: string): FeedWorkflowPackage | undefined {
  return REVIEWED_STARTER_PACKAGES.find((pkg) => pkg.packageId === packageId);
}
