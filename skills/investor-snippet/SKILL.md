# Skill: investor-snippet

Distill one transcript or a collection into a **single, short, forwardable
investor-update nugget**: ONE credible signal — a customer pull, a hire, a
shipped milestone, a partner signal — framed the way you'd want an investor to
hear it. Credible, concrete, honest. Not hype.

Think **"drop into an investor DM,"** not a memo. The output is one or two
sentences a founder could forward to a backer with zero editing and not cringe.
A monthly update has its own skill (`investor-update`) — this is deliberately
smaller: one real proof-point, sharply framed, or nothing.

The **scripts do deterministic plumbing** (surveying, leak + slop linting,
quote verification, validation, persistence); **you — the agent — do the
judgment** (finding the one genuine signal, framing it without hype, deciding
when there's nothing worth sending). No script in this skill calls a model.

## Prerequisites

- bun installed.
- No API keys required. Transcript paths (.md/.txt files or directories) are
  always passed at invocation — nothing is hardcoded to any machine.

## What this is not

- **Not a memo or a monthly update** (use `investor-update`). One nugget.
- **Not hype.** No "we're crushing it", no "massive", no "game-changer". An
  investor pattern-matches hype to noise. The credibility *is* the value.
- **Not a leak vector.** The edge of this whole system is the private source
  material; the snippet must never expose another party's confidential numbers,
  an unannounced deal, or a customer who didn't agree to be named.

## The investor register — read before drafting

You are framing for a **semi-trusted** reader. An investor is closer than the
public, so you apply a **lighter** abstraction pass than a public social post —
you may keep more specificity, because the relationship carries some confidence.
But "lighter" is not "off":

- **Strip anything that isn't yours to share.** Your own milestone, your own
  hire, your own revenue motion — fair game, framed credibly. Another company's
  confidential numbers, a customer's internal roadmap, a partner's unannounced
  plans — NOT yours, strip them even for an investor. "A mid-market logistics
  customer expanded their contract" is shareable; naming the customer and their
  spend usually is not, unless the source shows they're public about it.
- **Credible beats impressive.** "Three inbound enterprise demos this week off
  one conference talk" lands harder with an investor than "explosive top-of-
  funnel growth." Specific, checkable, modest-toned.
- **Honest framing.** If the signal is early, say it's early. Investors fund
  pattern recognition; a real small signal honestly framed builds more trust
  than a real signal inflated.
- **One signal.** A snippet that lists three things is a memo. Pick the single
  strongest proof-point and frame that.

The competitive edge is the source material; the hard work is the framing +
killing AI-slop tells, NOT the writing volume.

## Procedure — the quality loop

Run all commands from the distillery repo root. **Zero snippets is a valid,
common, correct result** — most meetings do not contain an investor-grade
signal worth a founder's forward. Do not manufacture one.

### 1. Survey (scripts)

```sh
bun skills/investor-snippet/scripts/survey.ts <transcript-path>... [--max-chunk 8000] [--format md] [--out digest.md]
bun skills/_shared/scripts/novelty-scan.ts <transcript-path>... --format md [--out novelty.md]
```

The survey digest gives per-transcript metadata, speaker turn counts,
cross-transcript signals (collection mode), and the full chunked text. Read all
of it. The novelty scan surfaces quantified drift, single-voice topics, and the
prior-artifact baseline — useful for spotting a *real change* (a number that
moved, a milestone that landed) versus noise.

### 2. Find ONE genuine investor signal (your judgment)

Scan for a single credible proof-point an investor would actually care about:

- **customer pull** — inbound interest, an expansion, a renewal, a champion
  pulling you into a bigger deal, a logo that signed
- **a hire** — a named-by-role senior hire that de-risks the plan ("we closed
  our first enterprise AE")
- **a milestone** — a shipped feature that unblocks revenue, a launch, a
  threshold crossed
- **a partner signal** — a distribution partner, an integration, an inbound
  from someone strategic

The bar: **would this change a backer's read of the company, even slightly, and
is it TRUE and yours to share?** If nothing clears that bar, stop here and
output nothing — say so and why. A "summary of a good meeting" is not a signal.

### 3. Abstraction pass (your judgment — lighter, not off)

Climb the abstraction ladder (`skills/_shared/lib/abstraction.ts`,
`ABSTRACTION_GUIDANCE`) with the **investor register**: you may keep more
specificity than a public post, but every retained specific must be **yours to
share and defensible**. In practice, for an investor snippet you usually:

- keep YOUR own milestone/number/hire (it's yours);
- generalize the OTHER party (customer/partner) to a role + class unless the
  source shows they're public about the relationship;
- strip any confidential figure, roadmap, or unannounced plan that belongs to
  someone else;
- keep exactly the detail that makes the signal credible — and no more.

### 4. Draft (your judgment)

Draft the artifact JSON to `drafts/<slug>.json` at the repo root (gitignored) —
the sanctioned pre-save workspace; `save.ts` moves survivors to `artifacts/`.

- `type: "investor-update-snippet"`
- `headline`: the one-line framing — the subject line of the forward.
- `body`: the forwardable nugget itself (~12-90 words; outside that band the
  save warns). This is what an investor reads. Make it a clean DM, not prose
  with markdown scaffolding.
- `source_transcripts`: the input paths as given.
- `source_quotes`: at least one **exact verbatim** transcript quote that
  anchors the claim. The claim must be something actually said in the meeting —
  never paraphrase inside `source_quotes`. Check each quote the moment you write
  it:

  ```sh
  bun skills/_shared/scripts/check-quote.ts --quote "exact words" <transcript-path>...
  ```

- `tags`, and `generation_model` naming you, the drafting agent.
- Leave `audience` and `approval_status` to the save step — it forces
  `audience: "investors"` and `approval_status: "pending"` regardless of the
  draft. Leave `hero_image` unset.

#### Writing register — kill the AI-slop tells

Write like a founder typing a quick, confident DM to someone who already
believes in them. Specifically (these mirror `SLOP_GUIDANCE` in
`skills/_shared/lib/slop-scrubber.ts`):

- **No hype vocab:** game-changer, 10x, unlock, supercharge, the future of,
  seamless, leverage, massive, explosive, crushing it.
- **No negative parallelism:** "not just X but Y", "it's not about X, it's
  about Y" — state Y directly.
- **No em-dash overuse**, **no rule-of-three padding**, **no hot-take openers**.
- **Concrete and checkable.** A number, a role, a named milestone (yours) beats
  an adjective. "Two inbound enterprise demos off one talk" not "huge interest."
- **Honest about stage.** "Early, but" is a stronger investor signal than
  false certainty.

### 5. Lint — leak + slop (script — mandatory)

```sh
bun skills/investor-snippet/scripts/lint.ts drafts/<slug>.json [--format md]
```

Runs both deterministic linters over the draft's headline + body:

- **Leak flags** — proper nouns, money, percentages, emails, URLs. Anything
  marked **IN SOURCE** appears in the source transcript: a real private entity
  carried straight from the meeting, the highest-risk leak. For each flag, ask:
  is this mine to share with an investor? A flag is not automatically a leak,
  but every flag must be defensible before approval.
- **AI-slop tells** — with a density score. A non-trivial score is a rewrite
  signal.

The linter REPORTS; it does not rewrite or block. Rewriting and climbing the
ladder is your judgment. Re-lint until the leak flags are all defensible and the
slop score is near zero.

### 6. Critic pass (your judgment — mandatory)

Re-read the draft as a skeptical reader, then run the 4-question safety test
(`SAFETY_TEST` in `abstraction.ts`) with the investor register:

1. **Identifiable third party** — could a reader identify a customer, partner,
   or deal that *isn't yours to disclose*? (Your own company being identifiable
   is fine — that's the point.) yes → strip or generalize the third party.
2. **Participant exposed** — would a meeting participant feel betrayed seeing
   this forwarded? yes → generalize or drop.
3. **Unannounced / not-yours** — does it reveal another party's confidential
   numbers, roadmap, or unannounced plans? yes → remove or don't ship.
4. **Signal survives** — stripped down, is there still a credible, true,
   non-hype proof-point an investor would care about? no → kill it (zero is
   valid).

**Identity grounding (mandatory).** Speculate freely about meaning, but never
assert an *inference about a person* (role, title, employer, affiliation,
relationships) as fact. State who someone is only when the transcript supports
it; otherwise describe them by what they verifiably said or did, or mark the
guess ("likely…"). Wrong: "Cush, a Shape Rotator cohort founder"; right: "a
founder on a call with the team."

Set `quality.critic_pass: true` only on a survivor, with `quality.notes`
recording the safety-test verdict, what was abstracted, and why — or, if
nothing shipped, why zero was the answer.

### 7. Verify quotes (script — must exit 0)

```sh
bun skills/investor-snippet/scripts/verify-quotes.ts drafts/<slug>.json --stamp
```

Checks every `source_quotes[].quote` verbatim against its transcript. An empty
list is suspicious — an investor claim should be anchored to something said. Fix
or drop failing quotes (and the claims that depended on them), then re-run until
exit 0. With `--stamp`, full success writes `quality.quotes_verified: true`
(atomic write); on failure nothing is stamped. **Never hand-set
`quotes_verified`.** Verification proves the text, not who spoke it.

### 8. Save (script)

```sh
bun skills/investor-snippet/scripts/save.ts drafts/<slug>.json [--out-dir artifacts]
```

Validates against the contract and writes
`<out-dir>/investor-update-snippet/<slug>/artifact.json`, **forcing
`audience: "investors"` and `approval_status: "pending"`**. Warns if the body
falls outside the forwardable-nugget length band. Validation errors are printed;
fix the JSON rather than bypassing the script.

## Output contract

`artifacts/investor-update-snippet/<slug>/artifact.json`. See
`skills/_shared/lib/artifact.ts` for the full type.

**The approval gate is the point.** Every snippet lands `approval_status:
"pending"`. NOTHING outward-facing auto-publishes — a human reads the snippet
and the lint report, then approves and sends. This skill produces a draft for
that human, never a sent message.
