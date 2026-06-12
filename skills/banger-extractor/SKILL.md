# Skill: banger-extractor

Compress one transcript or a collection into the **single most non-obvious
EARNED SECRET actually said** — turned into ONE postable line for X (a
`social-post` artifact). This is the X "home base": not a thread, not a
listicle, not a summary. One line that a stranger scrolling their feed stops on
because it is *true and not obvious*, and that only someone in the room could
have learned.

The competitive edge is the **source material** — private meetings are an
earned-secret factory. The hard, valuable work is the **abstraction**: turning a
private incident into a shareable line WITHOUT leaking the customer, the person,
the deal, or the unannounced number, AND killing every AI-slop tell so it reads
like a sharp human wrote it. The writing is the easy part.

The **scripts do deterministic plumbing** (survey, the two mechanical checks,
quote verification, persistence); **you — the agent — do the judgment** (which
line, climbing the abstraction ladder, deciding there is no banger). No script
in this skill calls a model. Any agent that can run bun can use it.

## The cardinal rule (read first)

**NOTHING outward-facing auto-publishes.** A banger is a `social-post` artifact
with `audience: "public"`. It saves with `approval_status: "pending"` and the
save script *refuses* to persist anything pre-approved. Approval is a human gate
that lives DOWNSTREAM of this skill — never assert a line is "ready to post".
Your output is a candidate for a human to approve, nothing more.

## Prerequisites

- bun installed.
- No API keys required. Transcript paths (.md/.txt files or directories) are
  always passed at invocation time — nothing is hardcoded to any machine.

## Procedure — the quality loop

Run all commands from the distillery repo root. **Quality beats quantity at
every step. Most meetings yield NO banger. Zero is a valid, good result** — a
forgettable line shipped is worse than nothing.

### 1. Survey (script)

```sh
bun skills/banger-extractor/scripts/survey.ts <transcript-path>... [--max-chunk 8000] [--format md] [--out survey.md]
```

Optionally also run the shared novelty scan to surface candidates (drift,
single-voice topics, the prior-artifact baseline):

```sh
bun skills/_shared/scripts/novelty-scan.ts <transcript-path>... --format md
```

The survey emits the spoken turns (the banger lives in the chunk TEXT) plus a
per-speaker turn-count hint for *who holds the asymmetric view*. `--format md`
is the better read. Read all of it before deciding anything.

### 2. Pick the ONE line (your judgment)

Find the single most compressed, non-obvious earned secret **actually said** in
these turns. The bar, all of which must hold:

- **Non-obvious.** Would a smart person who attended none of these meetings stop
  and think "huh, I didn't know that"? If it's a truism, a platitude, or
  something the reader already believes, it's not a banger.
- **Earned.** It is true *because someone was in the room* — a lesson paid for
  with a real incident, not a take anyone could tweet from their couch.
- **One line.** It compresses to a single postable line (aim well under 280
  chars). If it needs a thread to land, it isn't this artifact.
- **Built from a novelty candidate** (if you ran the scan): a quantified-drift
  finding, a single-voice topic, or a cross-transcript connection no single
  speaker stated. An "interesting thing that was said" is disqualified — the
  team was there.

If no line clears this bar, **stop and output nothing.** Say so and why. Do not
stretch a mediocre observation into a banger.

### 3. Climb the abstraction ladder (your judgment — the core work)

The raw incident names the customer, the person, the deal, the number. A post
that keeps any of those is a **leak**, however well-written. Climb the ladder in
`skills/_shared/lib/abstraction.ts` (`ABSTRACTION_LADDER`):

1. **specific-incident** — the real moment, still naming everyone.
2. **strip-identifiers** — remove names, companies, products, deals, exact $,
   pinning dates, anything a search resolves to the real entity.
3. **generalize-actors** — replace named actors with role/class ("a mid-market
   customer", "a founder we were selling to").
4. **lift-to-lesson** — state the transferable truth. If it only makes sense
   when you know who it was about, you haven't lifted it.
5. **keep-one-true-detail** — keep exactly ONE concrete, non-confidential detail
   so the line stays specific and credible, not generic LinkedIn mush.

Then answer the 4-question safety test (`SAFETY_TEST`) — first three must be
**no**, last must be **yes**:

- Could a reader identify the specific customer / company / deal / product?
- Would a meeting participant feel exposed, misquoted, or betrayed reading this
  in public?
- Does this reveal unannounced strategy, roadmap, numbers, or anything not
  already public?
- Stripped to the lesson, is there still a non-obvious insight worth a
  stranger's attention?

Any wrong answer sends the line back down the ladder — **or kills it.** If
abstraction empties the line of its insight, there was no shareable banger here.

**Identity grounding (mandatory).** Never assert an *inference about a person*
(role, title, employer, affiliation, location, relationships) as fact. State who
someone is only when the transcript supports it; otherwise generalize to a role.
This protects the abstraction AND avoids stating a guess as fact.

### 4. Scrub the slop + safety-check (script + your judgment)

```sh
bun skills/banger-extractor/scripts/scrub-check.ts --line "your candidate line" <transcript-path>...
```

**Pass the source transcript path(s)** so the safety check can mark which
flagged specifics ALSO appear in the source (`⚠ IN SOURCE` — real private
entities carried straight from the meeting, the highest-risk leaks). The check
runs both deterministic linters and REPORTS — it never rewrites:

- **leak-safety flags** (`abstraction.ts` `safetyFlags`): proper names, money,
  percentages, emails, URLs. An IN-SOURCE flag is a likely leak; climb the
  ladder. A not-in-source flag (a generic illustrative name/number you invented)
  isn't automatically a leak but must be defensible at the gate.
- **AI-slop tells** (`slop-scrubber.ts` `scrubSlop`): negative parallelism
  ("not just X but Y"), hype vocab (game-changer, 10x, unlock, leverage,
  seamless…), em-dash overuse, repeated rule-of-three rhythm, hot-take openers,
  clean uniform listicles. Any tell on a one-liner is fatal — rewrite it out.

Exit 0 means clean on **both** checks. That is **necessary, not sufficient** —
you still own the ladder + 4-question judgment. **Revise and re-run until exit
0.** If you can't get there without gutting the insight, there is no banger.

### 5. Verify the quote (script — must exit 0)

A banger asserts something someone actually SAID. Anchor it to at least one
verbatim quote and verify before saving:

```sh
# while drafting, check a candidate quote against the source:
bun skills/_shared/scripts/check-quote.ts --quote "exact spoken words" <transcript-path>...
# before saving, verify every source_quote in the draft:
bun skills/banger-extractor/scripts/verify-quotes.ts drafts/<slug>.json --stamp
```

`source_quotes` must be **exact verbatim** transcript text — never paraphrase
inside them. The post LINE is your abstracted prose; the quote PROVES the
underlying claim was real. An empty `source_quotes` list fails — a banger
without an anchor doesn't ship. On full success `--stamp` writes
`quality.quotes_verified: true` (atomic); on any failure nothing stamps. **Never
hand-set `quotes_verified`.** Verification proves the text was spoken, not who
spoke it (diarization labels can be wrong) — note that caveat in `quality.notes`.

### 6. Critic pass (your judgment — mandatory)

Re-read the one line as a skeptical editor and as a security reviewer:

1. **Non-obvious value** — does a stranger learn something? If it reads like a
   platitude or a summary, kill it.
2. **Leak-safe** — re-run the 4-question safety test honestly. Any "wrong"
   answer kills or sends it back to step 3.
3. **No slop** — `scrub-check` exit 0, and the line reads like a sharp human.
4. **Anchored** — the claim traces to a verified verbatim quote.
5. **Identity grounding** — no inferred person-claim stated as fact.

Record the verdict in `quality.notes` (what survived, what was cut, why nothing
shipped if so), with the novelty convention, e.g.
`[novelty] lead=single-voice: ...; adversarial critic: ...`. Set
`quality.critic_pass: true` only on a survivor.

### 7. Save (script)

Write the draft artifact JSON to `drafts/<slug>.json` at the repo root
(gitignored), then:

```sh
bun skills/banger-extractor/scripts/save.ts drafts/<slug>.json [--out-dir artifacts]
```

Validates against the contract and writes
`<out-dir>/social-post/<slug>/artifact.json`. The script forces
`type: "social-post"`, defaults `platform: "x"` / `audience: "public"`, and
forces `approval_status: "pending"` — it **rejects** any other approval status.
It warns if the line exceeds 280 chars. Leave `hero_image` unset; illustration
is the separate illustrate-card skill, pointed at this artifact later.

## Artifact shape

`artifacts/social-post/<slug>/artifact.json`, conforming to
`skills/_shared/lib/artifact.ts`:

- `type: "social-post"`
- `headline` — a short INTERNAL label for the banger (not posted).
- `body` — **the postable line itself** (the abstracted one-liner).
- `quote` / `attribution` — optional pull-quote face; the abstracted line is
  usually the body, not a raw quote.
- `tags`, `source_transcripts` (input paths as given).
- `source_quotes` — exact verbatim anchor(s) proving the earned secret was said.
- `platform: "x"`, `audience: "public"`, **`approval_status: "pending"`**.
- `generation_model` — name yourself, the drafting agent.
- `quality: { critic_pass, quotes_verified, notes }`.

The future feed UI consumes these folders directly — keep the JSON strictly
contract-valid. And again: it ends at a human-approval gate. Pending, always.
