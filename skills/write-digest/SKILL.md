# Skill: write-digest

Weave **2-3 related threads from across the corpus** into one compact
**digest artifact**: a headline, a ~300-500 word markdown body, 2-3 pull
quotes anchored to source, and tags. A digest sits between an insight card
and an article: more connective tissue than a card can hold, but one
synthesis — no sections, no throat-clearing, nothing that needs 900 words.

The **scripts do deterministic plumbing** (quote verification, validation,
persistence); **you — the agent — do the editorial work** (thread
selection, weaving, critiquing). No script in this skill calls a model.
Any agent that can run bun can use it.

## Prerequisites

- bun installed.
- No API keys required. Transcript paths (.md/.txt files or directories)
  are always passed at invocation time — nothing is hardcoded to any
  machine.

## When a digest is the right format (and when it isn't)

A digest exists to surface a **connection across meetings** — the same
question answered differently in two rooms, a number that moved between
calls, one person's claim that a later conversation confirms or
contradicts. The multi-thread requirement is enforced: `save.ts` rejects
artifacts with fewer than 2 `source_transcripts`.

- One strong thread from one conversation → **extract-insights** (card).
- A thesis that needs sections and 400-900 words of argument →
  **write-article**.
- A conversation-shaped thread worth hearing → **make-podcast**.
- 2-3 threads whose *joint* meaning is the insight → **this skill**.

## Procedure — the quality loop

Run all commands from the distillery repo root. Quality beats quantity at
every step: one good digest, or none.

### 1. Survey (scripts)

```sh
bun skills/_shared/scripts/novelty-scan.ts <transcript-path>... --format md [--out novelty.md]
```

**Run the novelty scan — always.** Its cross-transcript findings
(quantified-claim drift, single-voice topics, the prior-artifact baseline)
are exactly the raw material a digest is made of. Optionally also run
`bun skills/write-article/scripts/survey.ts <paths>... --format md` for
per-transcript metadata and chunked text; either way, **read the real
transcripts before claiming anything connects.**

### 2. Select the connection (your judgment)

Pick 2-3 threads whose joint meaning clears this bar: **would a smart team
member who attended none of these meetings learn something non-obvious
from seeing these threads side by side?** The connection itself must be
built from at least one novelty candidate — quantified drift across
transcripts, a single-voice topic echoed (or contradicted) elsewhere, or a
cross-transcript connection no single speaker stated.

**Novelty baseline check:** if a prior artifact already surfaced the
connection, it's disqualified unless you can say something materially new —
justify that judgment in `quality.notes`. If no connection clears the bar,
stop and output nothing. **Zero artifacts is a valid result** — say so and
why. Never staple two weak threads together and call the staple a
connection.

### 3. Draft (your judgment)

Write the digest as markdown in the artifact's `body` field:

- Line 1: a one-line italic dek (`*Like this.*`) that states the
  connection, not the topics.
- Then ~300-500 words, **no headings, no sections** — one continuous
  argument that moves between the threads. Pull quotes appear inline as
  blockquotes: `> Exact quote here. — Speaker Name`
- 2-3 quotes total, at least one from each thread you claim. Every pull
  quote and factual claim must be anchored by an entry in `source_quotes`
  (exact verbatim transcript text — never paraphrase inside
  `source_quotes`).

**Check each quote the moment you draft it:**

```sh
bun skills/_shared/scripts/check-quote.ts --quote "exact words you plan to use" <transcript-path>...
```

**Attribution:** attribute per the transcript's speaker labels, but know
diarization can be wrong — verification proves the *text* was spoken, not
*who* spoke it. Record this caveat in `quality.notes`.

Write the draft artifact JSON to `drafts/<slug>.json` at the repo root
(gitignored); `save.ts` moves survivors into `artifacts/`.

Fill the rest per `skills/_shared/lib/artifact.ts`: `type: "digest"`,
`headline`, the lead pull quote in `quote` + `attribution`, `tags`,
`source_transcripts` (**all** threads' paths — 2 minimum, enforced),
`source_quotes`, and `generation_model` naming you. Leave `hero_image`
unset (or `null` — the save script strips it); illustration is the
separate **illustrate-card** skill.

**Writing quality** — the write-article rules apply verbatim (see
`skills/write-article/SKILL.md` §4): no inflated symbolism, no
rule-of-three padding, no negative parallelisms, banned vocabulary (delve,
landscape, tapestry, robust, seamless, leverage-as-verb, game-changer,
crucial, pivotal…), concrete over abstract, let people speak in their own
words. At digest length there is no room to hide filler — if a sentence
isn't carrying the connection, cut it.

### 4. Critic pass (your judgment — mandatory)

Re-read as a skeptical editor, each criterion pass/fail:

1. **The connection is real** — do the threads change each other's
   meaning, or are they merely adjacent topics? Adjacency gets killed.
2. **Non-obvious value** — meeting minutes with a transition sentence is
   not a digest.
3. **Anchoring** — every claim and quote backed by `source_quotes`, at
   least one anchor per thread.
4. **Identity grounding** — never assert an *inference about a person*
   (role, employer, affiliation) as fact; state who someone is only when
   the transcript supports it, otherwise mark the guess.

If criterion 1 or 2 fails after one honest rewrite, discard — back to
step 2 or output nothing. Record the verdict in `quality.notes`; set
`quality.critic_pass: true` only on a survivor.

**Then the adversarial novelty critic (mandatory):** argue the team
already knows this — each thread was plainly stated in a meeting they
attended, and the connection is one they'd draw themselves. If the
argument holds, kill the digest. Record the verdict with the novelty
convention, e.g. `[novelty] lead=cross-transcript: ...; adversarial
critic: ...`.

### 5. Verify quotes (script — must exit 0)

```sh
bun skills/write-digest/scripts/verify-quotes.ts drafts/<slug>.json --stamp
```

Checks every `source_quotes[].quote` verbatim against its transcript. An
empty list fails — digests without anchors don't ship. With `--stamp`,
full success writes `quality.quotes_verified: true` (atomic); **never
hand-set it**.

### 6. Save (script)

```sh
bun skills/write-digest/scripts/save.ts drafts/<slug>.json [--out-dir artifacts]
```

Validates against the shared contract plus the digest rules (type,
non-empty body, >= 2 source_transcripts) and persists to
`artifacts/digest/<slug>/artifact.json` with `body.md` alongside. Warns
(non-fatal) outside the ~300-500 word target.
