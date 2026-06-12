# Skill: person-brief

Build a **grounded pre-meeting dossier** on one person from the meeting
corpus: who they are, their role/affiliation, what they have actually said
across meetings, the positions they hold, their relationship to TinyCloud,
and the open threads with them. The output is a `person-brief` artifact —
your prep doc for the next conversation with that person.

This is the POSITIVE use of the identity machinery the rest of the system
uses to *prevent* leaks. Here the discipline is the whole point: the
**identity-grounding rule is LOAD-BEARING**. EVERY claim about the person
must be transcript-grounded and cited; any inference is marked explicitly
("likely…"); a role/affiliation is **NEVER fabricated**. Fabricating a
role from context — "Cush, a Shape Rotator cohort founder" — is the exact
failure this skill is built to make impossible, inverted into a feature.

Like every distillery skill: the **scripts do deterministic plumbing**
(finding mentions, verifying quotes, validating, persisting); **you — the
agent — do the judgment** (deciding what is grounded, separating fact from
inference, organizing, marking the guesses). No script here calls a model.

## Prerequisites

- bun installed. No API key — the scripts are deterministic plumbing.
- Transcript paths (.md/.txt files or directories) are always passed at
  invocation time. Nothing is hardcoded to any machine.

## Audience

`audience: "internal"` — a person-brief is your own prep doc, so the
abstraction bar is lighter than a social post (you are allowed to name the
person; that is the point of the document). **The no-fabrication rule is
absolute regardless of audience.** A lighter abstraction bar is NOT a
lighter grounding bar. If you ever intend to share a brief outward, treat
it as a fresh outward artifact and run it through `abstraction.ts` first.

## Procedure — the grounding loop

Run all commands from the distillery repo root. Quality beats quantity: a
short, fully-grounded brief beats a long one padded with inference.

### 1. Gather every mention (script)

```sh
bun skills/person-brief/scripts/gather.ts --name "Full Name" <transcript-path>... [--format md|json] [--out dossier.md]
```

Scans the corpus for the person and emits the **raw dossier survey**: per
transcript, the turns they **spoke** (candidate quotes), the turns where
**others mention them by name**, whether they appear in the **participants
header**, and the **co-speakers** present. It draws no conclusions — it
finds and formats the evidence.

Matching is conservative: the full name matches as a whole phrase
(high-confidence); a lone first/last name is reported but flagged
**low-confidence** — a bare "Sam" can be the wrong Sam. Speaker labels are
the diarizer's; a spoken-turn match means the diarizer *attributed* the
words to that label, not that the human provably said them.

**If the survey reports zero evidence, stop.** A grounded brief is not
possible from no source material — say so and output nothing. Do not
fabricate. (First, sanity-check spelling and try a name variant; the corpus
may label the person differently.)

To find which transcripts even mention the person before gathering, you
can also use `query-corpus --speaker "Name"` over the built index — but the
brief's evidence must come from `gather.ts` reading the actual transcripts.

### 2. Separate grounded facts from inferences (your judgment)

Read the survey. Build, in scratch notes, two distinct piles:

- **Grounded facts** — statements directly supported by the evidence:
  - what the person *said* (their own turns; quote them in their words);
  - positions they took, asks they made, commitments they gave;
  - a role/affiliation **only if the transcript states it** (they said
    "I'm at Flashbots", or another speaker introduces them as such, or the
    participants header carries it). Cite the source.
  - their relationship to TinyCloud, again only as the transcript shows it
    (a customer call, a cohort intro, an investor conversation — whatever
    the source actually establishes).
- **Inferences** — anything you are reading *between* the lines: an implied
  seniority, a guessed employer, a probable motive. These are allowed in
  the brief **only when marked** ("likely…", "reads like…", "implied, not
  stated") and never stated as fact.

The bright line: **if the transcript does not establish who someone is, you
do not get to decide who they are.** Refer to them by what they verifiably
said or did. Never promote an inference into the flat voice of fact.

Lone first-name mentions flagged low-confidence: confirm from surrounding
context that they really refer to *this* person before you use them. If you
can't confirm, drop them.

### 3. Draft the brief (your judgment)

Write the brief as markdown in the artifact's `body`. A workable shape (adapt
to the person — omit empty sections rather than padding them):

- **Who they are** — name, and role/affiliation *as the transcript
  establishes it* (cited). If the source never establishes a role, say so
  plainly: "Role/affiliation not stated in the corpus." Do not guess one.
- **Relationship to TinyCloud** — how they show up in our meetings
  (customer, prospect, cohort, investor, partner), grounded in the source.
- **What they've said** — the substance: their positions, recurring themes,
  notable claims, in *their own words* via pull quotes. This is the meat.
- **Open threads** — unresolved asks, commitments, questions left hanging,
  things to follow up on next time — each anchored to a real turn.
- **Inferences (clearly labeled)** — a short, explicitly-marked section for
  the read-between-the-lines guesses, if any are worth noting.

Pull quotes appear inline as blockquotes: `> Exact quote. — Speaker Name`.
Every factual claim and every quote is anchored by a `source_quotes` entry —
**exact verbatim transcript text, never paraphrased inside `source_quotes`**.
Check each quote the moment you draft it:

```sh
bun skills/_shared/scripts/check-quote.ts --quote "exact words" <transcript-path>...
```

**Attribution caveat:** attribute per the diarizer's speaker labels (your
only attribution source), but know they can be wrong — Fireflies has filed
one speaker's lines under another's name. Quote verification proves the
*text* was spoken, not *who* spoke it. Record this caveat in
`quality.notes`; if a turn-count or content pattern makes an attribution
look implausible, flag it there too.

Write the draft artifact JSON to `drafts/<slug>.json` at the repo root
(gitignored) — the sanctioned pre-save workspace; `save.ts` moves survivors
into `artifacts/`. Fill the artifact per `skills/_shared/lib/artifact.ts`:
`type: "person-brief"`, a `headline` (e.g. "Brief: Samuel Gbafa"), the body,
`tags`, `source_transcripts` (the input paths as given), `source_quotes`,
`audience: "internal"` (the save script defaults this), and
`generation_model` naming you. Leave `hero_image` unset — briefs aren't
illustrated. `approval_status` defaults to `pending`: a person-brief names a
real person, so it gates at a human-approval step like every outward artifact.

#### Writing quality

Write like a sharp analyst's prep note, not a press release. Kill the
AI-slop tells — `slop-scrubber.ts` (`SLOP_GUIDANCE`) names them: no negative
parallelism ("not just X but Y"), no hype vocab, no em-dash overuse, no
repeated rule-of-three rhythm, no uniform listicles. Concrete over abstract:
the person's actual words beat your summary of them.

### 4. Critic pass — the grounding audit (your judgment — mandatory)

Re-read the draft as a skeptical fact-checker. For **every sentence that
asserts something about the person**, ask:

1. **Is it grounded?** Point to the `source_quotes` entry (or the
   participants-header fact) that supports it. An unsupported assertion gets
   cut or anchored — never hedged into staying.
2. **Is it fact or inference?** If you inferred it (role, employer,
   seniority, motive, relationship not stated in the source), is it marked
   as an inference ("likely…")? An unmarked inference stated as fact is the
   Cush failure — fix it or cut it.
3. **Is the attribution defensible?** Does the diarizer-label caveat apply?
   Is any quote attributed to a speaker the content makes implausible?
4. **Did a lone-first-name mention sneak in unconfirmed?** Drop it if you
   can't confirm it refers to this person.

Record the audit verdict in `quality.notes`: what you cut, what you
re-marked from fact to inference, and the attribution caveat. Set
`quality.critic_pass: true` only after the audit passes. If the grounded
material doesn't support a useful brief, **output nothing — that is a valid
result.** A thin-but-true brief beats a rich-but-fabricated one.

### 5. Verify quotes (script — must exit 0)

```sh
bun skills/person-brief/scripts/verify-quotes.ts drafts/<slug>.json --stamp
```

Checks every `source_quotes[].quote` verbatim against its transcript. An
empty `source_quotes` list **fails** — a brief with no grounded anchors is
the fabrication failure this skill prevents. Fix or drop failing quotes (and
the claims that leaned on them), then re-run until exit 0. With `--stamp`,
full success writes `quality.quotes_verified: true` (atomic write); on any
failure nothing is stamped. **Never hand-set `quotes_verified`.** This
proves the text, not the attribution.

### 6. Save (script)

```sh
bun skills/person-brief/scripts/save.ts drafts/<slug>.json [--out-dir artifacts]
```

Validates against the contract and writes
`<out-dir>/person-brief/<slug>/artifact.json` **plus `brief.md` alongside**.
It defaults `audience: "internal"`, rejects a missing body or an empty
`source_quotes` list, and (via the contract) defaults `approval_status` to
`pending`. Validation errors are printed; fix the JSON rather than bypassing
the script.

## Output contract

`artifacts/person-brief/<slug>/artifact.json` + `brief.md` in the same
folder. See `skills/_shared/lib/artifact.ts` for the full type:
`type: "person-brief"`, `audience: "internal"`, `approval_status: "pending"`
by default. Nothing outward-facing auto-publishes — the brief ends at a
human-approval gate. Keep the JSON strictly contract-valid; the future feed
UI consumes these folders directly.
