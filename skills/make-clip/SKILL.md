# Skill: make-clip

Distill a transcript-derived narrative into a **short video clip artifact**
(~15s) by compiling it through an intermediate storyboard: **narrative ->
storyboard SHEET -> video**. Works on a single transcript or a collection
(file paths or directories — always passed in, never assumed). The output is
a contract-valid `clip` artifact that surfaces in the TinyFeed feed as video:
an mp4 + a poster frame, stamped with the quality block.

**The novelty bar (read first).** Same as every distillery skill: the viewer
ATTENDED these meetings. A clip earns its runtime only by dramatizing an
EMOTIONAL TRUTH they couldn't reconstruct from the room — a reversal, a
drift, a single-voice truth. A pretty summary is a failed clip. Metaphor and
anthropomorphism are encouraged: the transcript supplies the emotional truth
and the reversal; the metaphor is the costume.

Same division of labor as every distillery skill: **scripts do deterministic
plumbing** (fal queue calls, storage upload, ffmpeg frame extraction +
captioning, validation, persistence); **you — the agent — do the judgment**
(mining the narrative, writing the three prompts, running the locks checklist,
the blind-test gate). **No script calls an LLM.**

## The compiler model (frame the whole skill this way)

This is a **three-stage compiler**: `narrative -> storyboard SHEET -> video`.
The storyboard sheet is an INTERMEDIATE REPRESENTATION (IR) that
OVER-CONSTRAINS the video model so it can't drift. Video models drift: left
alone, a 15s generation re-cuts the scene, reinvents characters, moves the
camera. The IR compiles the narrative into a spatially explicit, panel-indexed
contract that pins every axis of drift before the expensive video roll.

**Two-reference technique (separation of concerns).** Two independent
references, generated and re-rolled independently:

- **identity image = WHO** — character authority + consistency. Pixels are a
  stronger contract than words; the video model copies what it sees.
- **storyboard sheet = WHAT/WHERE/WHEN** — staging + continuity authority.

The video stage passes BOTH: identity as `@Image1`, storyboard as `@Image2`,
and declares which reference wins on which axis.

## Economics shape the architecture (internalize this)

Iterate on the CHEAP stages and arrive at the EXPENSIVE video with clean refs.
Front-load all legibility debt into the storyboard.

| Stage | Provider | ~Cost | ~Time |
| --- | --- | --- | --- |
| identity image | GPT Image 2 (high) | ~$0.25 | ~3 min |
| storyboard sheet | GPT Image 2 (high) | ~$0.25 | ~3 min |
| video | Seedance 2.0, 15s/720p | ~$4.50 | ~4.5 min |

A whole clip is ~$5. **Default budgets: 2-3 image rolls, 1 video roll.** Two
**retry modes** (a documented flag, same posture as speculative podcast gen):

- **`strict`** (showcase): the full blind-test loop, re-roll on failure within
  budget. Use when the clip ships.
- **`speculative`** (feed batch gen): single-shot each stage, discard freely —
  same posture as speculative podcast generation. Use for volume.

## Prerequisites

- bun installed; **ffmpeg** on PATH (frame extraction, captioning, poster) —
  `ffprobe` too for duration probing.
- `FAL_KEY` resolvable from env for the spend steps only (identity, storyboard,
  video). Copy from the TinyCloud Secret Manager into `.env`. The narrative,
  extract-frames, caption, and save steps need no key.

## Live-verified fal facts (2026-06-12 — reuse, don't re-discover)

Two full prototype rounds against the live fal API (provenance:
`prototypes/make-clip/output/RUN-LOG.md`). Encoded in
`skills/_shared/lib/fal.ts`:

- Image model `openai/gpt-image-2` (alias `fal-ai/gpt-image-2`; NO
  `/text-to-image` sub-path). `image_size` = preset OR `{width,height}`
  (multiples of 16, max edge 3840, max 8,294,400 px); `quality=high` is the
  lever.
- Video model `bytedance/seedance-2.0/reference-to-video`: `image_urls` up to
  9 (referenced `@Image1`…), `duration` is a STRING enum `"4"`–`"15"`/`"auto"`,
  `resolution` `480p`/`720p`/`1080p` (1080p = quality lever), `aspect_ratio`
  incl. `1:1`/`9:16`/`16:9`, `generate_audio` bool (FREE), optional `seed`.
- Queue API at `queue.fal.run` (submit -> poll `status_url` -> fetch
  `response_url`); storage upload host `rest.alpha.fal.ai` (`rest.fal.run` does
  NOT resolve); auth `Authorization: Key <FAL_KEY>`.

## Aspect ratio: SQUARE (1:1) is the default

The TinyFeed video well is square by default; a 9:16 vertical clip gets cropped
to a sliver. **Square is feed-native + platform-portable — 1:1 is the default.**
Allow `--aspect 9:16|1:1|16:9` for explicit platform targets.

## Procedure

Run all commands from the distillery repo root. Use a scratch dir (e.g. a
`work/` under `/tmp`) for intermediates; only `save.ts` writes into
`artifacts/`.

### 1. Mine the transcript-derived narrative (your judgment)

Mine the corpus for a dramatizable EMOTIONAL TRUTH + beat structure — NOT a
summary. Draw on the same engines the other skills use:

```sh
bun skills/_shared/scripts/novelty-scan.ts <transcript-path>... --format md
# and, when available, the corpus miner:
bun harness/query-corpus/scripts/query.ts ...   # novelty.ts drift / single-voice / cross-meeting
```

The narrative's spine is one of: a **quantified-drift** finding, a
**single-voice** truth, or a **cross-meeting reversal** no single speaker
stated. Write `narrative.md` capturing:

- **The emotional truth** (insider read) AND the **stranger read** (what a
  cold viewer should perceive). Both must be nameable.
- **The reversal** — 15s buys exactly ONE reversal. Material-format matching:
  pick a story that IS a single reversal (setup -> turn -> button).
- **The cast** — two characters, opposite silhouettes + scales.
- **Source grounding** — verbatim quotes anchoring the emotional truth, with
  transcript paths, for `source_quotes`. Use `check-quote` to verify them.

**Metaphor-distance dial (set it deliberately).** Choose the referential
distance: `literal` / `grounded-allegory` / `pure-allegory`. The further
toward pure allegory, the more "translation tax" the viewer pays (felt as
"abstract"). Counter it with ICONOGRAPHY: make symbols carry meaning — if the
orbs ARE the data, render them as legible data (memory-fragments, photos,
documents), not generic glowing orbs. This is a KNOB you set, recorded in
`narrative.md`, not an accident.

**15 seconds is a gesture, not a story.** Structure = setup -> turn -> button.
~4 beats max (mapped over 6 storyboard panels, with the turn given a panel
pair). 5-6 distinct new actions rush each beat, kill dwell time, and read
abstract. The emotional BUTTON — a held final beat with real acting — is what
lets a viewer LEAVE WITH A FEELING rather than decode a proposition.

### 2. Write the three prompts (your judgment — from the templates)

Copy the three templates and fill their ALL-CAPS slots for your narrative. Do
NOT hardcode any example story; the templates are skeletons.

- `templates/01-identity.md` -> `identity.prompt.md` — the WHO. **Pre-stage
  every prop the finale depends on** (a pouch/container/tool must be plainly
  visible and correctly shaped HERE) and use **exact counts** for countable
  props. Establish the signature effect's at-rest look and the iconography.
- `templates/02-storyboard-sheet.md` -> `storyboard.prompt.md` — the
  WHAT/WHERE/WHEN. **This is where you run the LOCKS LIBRARY checklist (below)
  — apply every lock.** Set the metaphor distance in the MICRO BRIEF +
  EFFECT LOCK.
- `templates/03-video.md` -> `video.prompt.md` — the binding. Uses `@Image1`
  (identity) / `@Image2` (storyboard) literally. Re-state causality + effect
  physics + the disambiguation lock in prose; diegetic-only audio; the held
  button.

#### THE LOCKS LIBRARY (apply every one in the storyboard sheet)

The named, reusable checklist — each lock prevents one axis of drift:

- [ ] **Spatial-continuity lock** — locked camera + master-shot rule; named
      anchors + an explicit WHITELIST of what may change.
- [ ] **Signature-effect lock** — ONE key effect with an explicit per-panel
      STATE MACHINE; consistent look across every firing.
- [ ] **Exact-count language** for countable props ("exactly three, never
      more"), stated in every panel.
- [ ] **Scale anchor** — "trace panel 01's composition"; whole-head-in-frame,
      identical eye-line/face-width all six panels; never zoom/push-in.
- [ ] **Dim lock** — dimness is value change only, and specify WHAT dims (the
      actor that loses power, NOT the scene — scene-wide dark flashes are
      unattributable).
- [ ] **Body-language disambiguation lock** — opposite beats that look alike
      (protective-cradling vs eating) pinned to their distinguishing staging.
- [ ] **Pre-stage every finale prop in the identity stage** (also enforced at
      stage 1).
- [ ] **Sample the final panel AFTER the climax resolves** (P06 = the held
      button, not a mid-action frame).

### 3. Generate the identity image (script — needs FAL_KEY)

**First run on a machine/key: smoke-test first** (a few cents, confirms the
pipe) before the high-quality roll:

```sh
bun skills/make-clip/scripts/generate-image.ts identity.prompt.md --out /tmp/work/identity.png --smoke
# then the real roll (square default; for a 4:5 portrait identity use --size 1600x2000):
bun skills/make-clip/scripts/generate-image.ts identity.prompt.md --out /tmp/work/identity.png --size 1600x2000 --quality high
```

QA the identity (your judgment): opposite silhouettes? every finale prop
pre-staged and correctly shaped? exact counts right? no text? In `strict` mode
re-roll (within the 2-3 image budget) until it passes; in `speculative` mode
take the single roll or discard.

### 4. Generate the storyboard sheet (script — needs FAL_KEY)

```sh
bun skills/make-clip/scripts/generate-image.ts storyboard.prompt.md --out /tmp/work/storyboard.png --size 3840x2160 --quality high
```

QA the sheet (your judgment) against the LOCKS LIBRARY: grayscale purity? all
six panels same scale/framing? counts exact per panel? the signature effect
visible in every firing? the disambiguation reading correct? P06 = the
resolved button? This is the CHEAP stage — iterate here; front-load every
legibility fix into the sheet.

### 5. Generate the video (script — the EXPENSIVE stage, needs FAL_KEY)

```sh
bun skills/make-clip/scripts/generate-video.ts video.prompt.md \
  --identity /tmp/work/identity.png --storyboard /tmp/work/storyboard.png \
  --out /tmp/work/clip.mp4 --aspect 1:1 --duration 15 --resolution 720p
```

`generate-video.ts` uploads identity FIRST (-> `@Image1`) and storyboard
SECOND (-> `@Image2`), then runs Seedance. Defaults: aspect `1:1`, duration
`"15"`, resolution `720p`, audio on. Use `--resolution 1080p` as the quality
lever once refs are clean. **Budget: 1 video roll.**

### 6. The blind-reconstruction critic gate (THE gate — your judgment)

Before accepting the clip, run the gate. It is ~free (frame extraction, no
generation):

```sh
bun skills/make-clip/scripts/extract-frames.ts /tmp/work/clip.mp4 \
  --out-dir /tmp/work/frames --count 8 --audio /tmp/work/frames/audio.aac
```

Then spawn or instruct a **CONTEXT-FREE reviewer** (a blind sub-agent that has
NOT seen the narrative) to watch the frames + listen to the audio and narrate
back:

1. what LITERALLY happens, beat by beat;
2. what STORY / EMOTION they perceive;
3. who is protagonist / antagonist;
4. any confusions or ambiguous beats;
5. their METAPHOR guess.

**PASS = a cold viewer reconstructs the intended story AND FEELS it** — not
merely decodes the metaphor. This catches the creator's curse-of-knowledge
that self-QA cannot. On FAIL, route the fix by failure type:

- **identity drift** (character melts/changes) -> re-roll **stage 1**.
- **staging / causality / legibility** (effect invisible, counts wrong,
  geography reset, the misread returns) -> re-roll **stage 2** (storyboard).
- **pacing / audio / dwell** (rushed, button doesn't land, audio slop) ->
  re-roll **stage 3** (video).

In `strict` mode, loop within budget. In `speculative` mode, a fail is a
discard — no re-roll.

### 7. Caption (post-process only — your judgment whether to caption)

NEVER ask the model to render text. End-caption via ffmpeg over the final
~2.5s (fade-in; audio stream-copied untouched). The caption is an OPTIONAL
"language channel" the user opts into. Emit BOTH captioned + clean outputs:

```sh
# with a caption:
bun skills/make-clip/scripts/caption.ts /tmp/work/clip.mp4 \
  --out-captioned /tmp/work/clip-captioned.mp4 --out-clean /tmp/work/clip-clean.mp4 \
  --text "your data, where they can't blink it away." --duration 15
# or no caption (still emits a uniform pair):
bun skills/make-clip/scripts/caption.ts /tmp/work/clip.mp4 \
  --out-captioned /tmp/work/clip-captioned.mp4 --out-clean /tmp/work/clip-clean.mp4
```

### 8. Save (script — artifact contract)

```sh
bun skills/make-clip/scripts/save.ts artifact.json \
  --video /tmp/work/clip-captioned.mp4 --clean /tmp/work/clip-clean.mp4 \
  --narrative narrative.md [--poster poster.png] [--out-dir artifacts]
```

Draft `artifact.json` per `skills/_shared/lib/artifact.ts`: `type: "clip"`, a
sharp `headline` (the slug), `body` = a 2-3 sentence description (the emotional
truth + stranger read), `tags`, `source_transcripts`, and `source_quotes`
(verbatim, transcript-anchored). The required
`quality { critic_pass, quotes_verified, notes? }`:

- **`critic_pass: true`** ONLY when the blind-reconstruction gate PASSED (a
  cold viewer reconstructed AND felt the story). Record the blind reviewer's
  metaphor guess + any residual nits in `quality.notes`.
- **`quotes_verified: true`** ONLY after the source quotes verify verbatim
  (use `check-quote` / the shared quote verifier).
- **`quality.notes`** carries the `[novelty] lead=<type>: ...` convention plus
  the metaphor-distance setting and the blind-test verdict.

`save.ts` samples a poster frame AFTER the climax (90% through) when `--poster`
is not given, and persists the mp4(s) + poster + `narrative.md`.

**Zero clips is a valid result.** If the narrative doesn't clear the novelty
bar, or no roll passes the blind-test gate within budget, save nothing and say
why. Video is the most expensive artifact — spend it on nothing rather than
noise.

## Output contract

Every artifact lands at `artifacts/clip/<slug>/` containing `artifact.json` +
the captioned mp4 (default) + the clean mp4 + `poster.png` + `narrative.md`.
The captioned mp4 file name is recorded in the typed `video` field, the clean
cut is kept as `video-clean:<file>` tag, and `hero_image` points at the poster.
At publish time, `tc-publish` uploads the typed video file to TinyCloud media
KV and stores the video pointer triple on the feed row. See
`skills/_shared/lib/artifact.ts` for the full type; the `quality` block must
reflect the blind-test gate + quote verification + the `[novelty]` note.
