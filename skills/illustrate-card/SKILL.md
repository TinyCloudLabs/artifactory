# Skill: illustrate-card

Add a **hero illustration** to a saved artifact. Input is an artifact
directory (`artifacts/<type>/<slug>/` containing a contract-valid
`artifact.json`, e.g. produced by extract-insights). Output is a
`hero.png` (or `.jpg`/`.webp`, per the model's mimeType) written alongside
`artifact.json`, with `hero_image` and `quality.notes` updated.

Despite the name, this skill works on **any** artifact type — insight
cards, articles, podcasts — anything with a contract-valid
`artifact.json` whose headline + body can seed a prompt.

As everywhere in distillery: the **script does the plumbing** (validate
artifact, call the image model, write the file, update the JSON); **you —
the agent — do the judgment** (craft the prompt, view the result, decide
whether it's good enough, retry or accept).

## Prerequisites

- bun installed.
- A Gemini API key in env: `GOOGLE_AI_API_KEY` | `GEMINI_API_KEY` |
  `GOOGLE_API_KEY` (first match wins). Copy from the TinyCloud Secret
  Manager into `.env` for now. Images cost ~$0.039 each
  (`gemini-2.5-flash-image`, "nano-banana").

> **Until live-verified:** this skill's unit tests run against a fake
> image provider — there is no Gemini key on the dev machine. The first
> real run needs `GEMINI_API_KEY` (or an alias above) exported; treat that
> run as the live verification and fix anything it surfaces.

## Procedure

Run all commands from the distillery repo root.

### 1. Read the artifact (your judgment)

Open `<artifact-dir>/artifact.json`. The prompt must come from the
artifact's **headline + body** (and `quote`, if present) — not from
generic vibes.

If you are batch-illustrating many artifacts, pass `--skip-existing` in
step 3 so already-illustrated artifacts are not regenerated (and not
re-billed).

### 2. Craft the prompt (your judgment)

This is the step that decides quality. The proven style (from
pulse-radio's image pipeline, which went through real reject/accept
cycles):

- **Concrete-noun literal scenes, never abstract metaphors.** Abstract
  briefs ("a representation of strategic asymmetry") consistently fail;
  literal scenes of recognizable objects work. Pretend you are
  illustrating a children's-book metaphor of the headline. If the concept
  is too abstract to draw, pick the closest *physical* metaphor and draw
  THAT.
- **Recognizable objects + physical relationships**: locks, keys, hands,
  signal towers, books, knobs, switches, clouds, pipes, puzzle pieces,
  ladders, doors — one thing connecting to / growing out of / breaking
  through / pointing at another.
- **Editorial illustration aesthetic**: flat, confident, slightly retro,
  magazine-quality. Saturated retro primary colors (orange, cobalt, kelly
  green, signal red, sun yellow) on a warm off-white background. No
  photorealism, no 3D-render look.
- **Single clear subject**, balanced composition, ample whitespace.
- **Hard rules — state them verbatim in every prompt:**
  - NO text, words, letters, numbers, logos, or brand marks of any kind,
    anywhere in the image
  - NO realistic faces or identifiable real people (silhouettes / generic
    figures are OK)
  - NO realistic depictions of specific named products or company logos

#### Worked examples

**Headline: "Usage-based pricing aligns revenue with value"**

- ✅ Good: *"Flat editorial illustration, retro primary colors on warm
  off-white. A water meter feeding a clear glass pipe into a jar; next to
  the jar, a stack of coins rises to exactly the same height as the water
  level. Single clear subject, ample whitespace. No text, words, letters,
  numbers, or logos anywhere. No realistic faces. No photorealism."*
- ❌ Bad: *"An abstract representation of the alignment between customer
  value and company revenue, with flowing gradients symbolizing
  fairness."* — nothing concrete to draw; gradients aren't the flat
  editorial style; "alignment" is not a noun you can point at.

**Headline: "Only one engineer understands the deploy pipeline"**

- ✅ Good: *"Flat editorial illustration, retro primary colors on warm
  off-white. One generic silhouette figure holding a single oversized key
  in front of a wall of identical locked doors; three other silhouettes
  wait in line behind. Single clear subject. No text or letters anywhere,
  no realistic faces, no logos."*
- ❌ Bad: *"A glowing neural network visualizing asymmetric knowledge
  distribution across a team, with the words 'bus factor' overlaid."* —
  abstract metaphor AND text in the image (hard-rule violation).

**Headline: "Ship the demo before the deck"**

- ✅ Good: *"Flat editorial illustration, retro primary colors on warm
  off-white. A small paper boat sliding down a launch ramp toward water,
  ahead of a stack of still-wrapped presentation easels left behind on the
  dock. Single clear subject, ample whitespace. No text, letters, numbers,
  or logos anywhere. No realistic faces."*
- ❌ Bad: *"A motivational poster that says 'Ship It' in bold type."* —
  the image model garbles text and the hard rule forbids it anyway.

### 3. Generate (script)

```sh
bun skills/illustrate-card/scripts/illustrate.ts \
  --artifact-dir artifacts/insight-card/<slug> \
  --prompt "..." \
  [--prompt-file prompt.txt] [--aspect 16:9] [--note "..."] [--skip-existing]
```

- `--prompt` or `--prompt-file` (exactly one). Use a file for long
  prompts.
- `--aspect` defaults to `16:9` (card hero format).
- `--note` is appended to `quality.notes` on this generation (use it on
  retries to record what was wrong with the previous attempt).
- `--skip-existing` exits cleanly without generating when the artifact
  already has a hero image on disk — use for batch runs.

The script validates `artifact.json` against the contract first, writes
`hero.<ext>` (extension from the response mimeType), removes a stale hero
file if the extension changed, sets `hero_image`, appends to
`quality.notes`, and exits non-zero on any failure. Never edit
`hero_image` by hand.

### 4. Quality loop — view and judge (your judgment, mandatory)

You can read image files. **View the generated hero image** and judge it
against the artifact:

1. **Does the scene depict the insight?** Someone seeing the card should
   feel the headline in the picture without reading a caption.
2. **Any text artifacts?** Letters, garbled pseudo-words, numbers, or
   logo-like marks anywhere → reject. **Zoom-inspect any region containing
   panels, pages, screens, or labels before accepting** — that's where
   garbled pseudo-text hides at full-image zoom.
3. **Any garbled elements?** Mangled hands/objects, incoherent
   composition, muddy non-editorial style → reject.

Benign model embellishments (an extra cloud, a small prop you didn't ask
for) are acceptable as long as the metaphor still reads clearly — judge
the scene, not prompt-conformance.

If sub-bar, refine the prompt — simplify to ONE subject, swap to a more
literal physical metaphor, restate the hard rules — and rerun step 3 with
`--note "retry: <what was wrong>"`. **Retries overwrite `hero.<ext>` in
place** — if you want to compare attempts side by side, copy the current
one aside (e.g. to `/tmp`) before rerunning.
**Max 2 retries** (3 generations total); past that, keep the best attempt.

### 5. Record the outcome (script)

After accepting (or exhausting retries), record the final verdict:

```sh
bun skills/illustrate-card/scripts/illustrate.ts \
  --artifact-dir artifacts/insight-card/<slug> \
  --annotate "hero reviewed: matches insight, no text artifacts (accepted on attempt 2)"
```

`--annotate` appends to `quality.notes` without generating. Be honest: if
you kept a flawed best-of-three, say what's still wrong with it.

## Output contract

The artifact folder ends up as:

```
artifacts/<type>/<slug>/
  artifact.json    hero_image: "hero.png", quality.notes includes the loop outcome
  hero.png         (or hero.jpg / hero.webp per the model's mimeType)
```

`hero_image` is always a file name relative to the artifact's own folder,
per the contract in `skills/_shared/lib/artifact.ts`.
