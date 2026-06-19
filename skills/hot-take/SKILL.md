# Skill: hot-take

Distill one transcript moment into a compact **Feed-visible hot take**: a sharp
internal `insight-card` that is faster to produce than a full article and more
opinionated than a neutral summary.

Use this when a run needs to fill the Feed with small, useful artifacts:
a single non-obvious lesson, contradiction, operating principle, or uncomfortable
truth that can be anchored to one quote. This is internal and publishable by
default. It is **not** a public social post.

## Prerequisites

- bun installed.
- No API key required. The scripts validate and save; the agent supplies
  judgment.

## Procedure

Run all commands from the distillery repo root.

### 1. Find the take

Read the selected transcript snippets or files. Pick one claim that clears all
of these bars:

- non-obvious, opinionated, and useful internally
- anchored to a verbatim quote
- safe to show in the private Feed
- small enough to understand in one screen

Good hot takes sound like:

- "The bug was not timeout length. It was when the clock started."
- "The demo works, but the handoff path does not."
- "Runway anxiety is more dilutive than the valuation term."

Bad hot takes are generic meeting summaries, motivational slogans, or public
copy. If the point wants a thread, use `write-article`. If it wants a neutral
card, use `extract-insights`.

### 2. Draft JSON

Create a draft JSON under `drafts/`:

```json
{
  "type": "insight-card",
  "headline": "Short, sharp headline",
  "body": "One compact paragraph. State the take, then why it matters.",
  "quote": "The exact quote that anchors the take.",
  "attribution": "Speaker",
  "tags": ["engineering"],
  "source_transcripts": ["path/to/transcript.md"],
  "source_quotes": [
    {
      "quote": "The exact quote that anchors the take.",
      "speaker": "Speaker",
      "transcript": "path/to/transcript.md"
    }
  ],
  "quality": {
    "critic_pass": true,
    "quotes_verified": true,
    "notes": "[hot-take] why this clears the bar; what was cut"
  }
}
```

Rules:

- `type` must be `insight-card`.
- `body` must be compact: 450 characters or fewer.
- Include at least one `source_quotes` entry.
- Do not set `audience: "public"` or `approval_status: "pending"`; this is an
  internal Feed artifact, not an outward draft.
- Do not create hero images.

### 3. Verify quotes

Use the insight-card verifier because this skill writes the same artifact type:

```sh
bun skills/extract-insights/scripts/verify-quotes.ts drafts/<slug>.json --stamp
```

Never hand-set `quality.quotes_verified`; fix or drop the draft if verification
fails.

### 4. Save

```sh
bun skills/hot-take/scripts/save.ts drafts/<slug>.json [--out-dir artifacts]
```

This validates the artifact contract plus the hot-take compactness rules, then
writes:

```text
<out-dir>/insight-card/<slug>/artifact.json
```

## Output contract

The saved artifact is an `insight-card`, so the existing publish path stores it
as a Feed-visible internal artifact with no schema or renderer changes.
