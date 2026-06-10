# Skill: make-podcast

Distill meeting/conversation transcripts into a **micro-podcast artifact**:
a 2–5 minute episode — tight script plus synthesized audio — built around
ONE compelling through-line. Works on a single transcript or a collection
(file paths or directories — always passed in, never assumed).

Same division of labor as every distillery skill: **scripts do
deterministic plumbing** (parsing, TTS call, WAV assembly, validation,
persistence); **you — the agent — do the judgment** (picking the episode
angle, writing the script, critiquing it).

## Prerequisites

- bun installed.
- `GEMINI_API_KEY` resolvable from env for the synthesize step only
  (`GOOGLE_AI_API_KEY` | `GEMINI_API_KEY` | `GOOGLE_API_KEY`, in that
  order). Copy the key from the TinyCloud Secret Manager into `.env` for
  now. Digest, verify, and save need no key.

## ⚠️ Until live-verified

The Gemini TTS request shape used by `synthesize.ts` and
`skills/_shared/lib/tts.ts` was built from Google's official docs —
https://ai.google.dev/gemini-api/docs/speech-generation (read 2026-06-10) —
but has **not yet been verified against the live API** (no key on the
build machine). On the first real run, start with the smallest possible
script (one or two sentences) to confirm the request/response shape and
audio format cheaply before synthesizing a full episode. If the API has
drifted, fix `tts.ts` (the only TTS surface) and remove this warning.

Documented surface (same doc): models `gemini-2.5-flash-preview-tts`
(our default), `gemini-2.5-pro-preview-tts`, `gemini-3.1-flash-tts-preview`;
output is raw PCM s16le, 24 kHz, mono, which `synthesize.ts` wraps into a
playable WAV; 30 prebuilt voices (Kore, Puck, Zephyr, Charon, Fenrir,
Leda, ...); max 2 speakers in multi-speaker mode; ~32k-token context;
no streaming.

## Procedure

Run all commands from the distillery repo root. Use a scratch dir (e.g.
`/tmp`) for intermediates; only `save.ts` writes into `artifacts/`.

### 1. Digest — parse + chunk (script)

```sh
bun skills/make-podcast/scripts/digest.ts <transcript-path>... [--max-chunk 8000] [--out digest.json]
```

Accepts .md/.txt files or directories (recursed). Emits JSON:
`{ transcripts: [{path, title, date, participants, duration, summary?}], chunks: [...] }`.

### 2. Pick ONE through-line (your judgment)

Survey the digest and choose a single compelling through-line for the
episode: a decision and its reasoning, a tension that resolved, a theme
recurring across meetings, a piece of knowledge one person holds. One
episode = one idea — do not stitch together a grab-bag recap.

**Zero episodes is a valid result.** If nothing clears the "would someone
replay this for a teammate?" bar, stop and say so rather than synthesizing
filler. TTS costs real money; spend it on nothing rather than noise.

### 3. Write the script (your judgment)

Write `script.md` — the exact text that will be spoken. Quality rules:

- **Hook in the first two sentences.** Open inside the idea, not around it.
- **Conversational, not corporate.** Written for the ear: short sentences,
  contractions, no slideware language.
- **Every factual claim traceable to the source transcripts.** If you can't
  point at the line that supports it, cut it. Collect the anchoring
  verbatim quotes now for `source_quotes` (step 4 verifies them).
- **No filler.** No "welcome back to another episode...", no
  "in today's fast-paced world", no outro fluff.
- **End with one concrete takeaway** the listener can act on or repeat.
- **Target 350–750 words** (~2–5 minutes at speaking pace).

Formats — the file content is sent to TTS verbatim:

- **Monologue:** plain prose. Optionally open with a one-line style
  direction (e.g. `Say in a warm, conversational tone:`) — the docs say
  natural-language prompts steer style, pace, and tone.
- **Dialogue (two hosts):** every line is a `Name: text` turn, exactly two
  names, and the names must match the `--speaker` labels in step 5, e.g.

  ```
  Alex: So the team killed seat-based pricing this week. I didn't see it coming.
  Sam: I did — power users were getting punished for caring.
  ```

Also draft the artifact JSON per `skills/_shared/lib/artifact.ts`:
`type: "podcast"`, a sharp `headline` (becomes the slug), `body` = a
2–3 sentence episode description (not the script), `tags`,
`source_transcripts` (the input paths), and `source_quotes` — exact
verbatim transcript quotes anchoring each factual claim in the script.

### 4. Critic pass (your judgment — mandatory, BEFORE any TTS spend)

Re-read the script as a skeptical editor. Would a busy teammate listen
past sentence two? Is every claim actually supported by the transcripts?
Does it earn its runtime, or does it pad? Is the takeaway concrete?
**Rewrite or kill — do not synthesize a script that didn't survive the
critic.** Set `quality.critic_pass: true` only on the survivor, with
`quality.notes` recording what was cut/changed and why.

Then verify the quote anchors (script — mandatory):

```sh
bun skills/make-podcast/scripts/verify-quotes.ts <artifact.json>
```

Fix or drop failures; only after it passes set
`quality.quotes_verified: true`. Never hand-set that flag.

### 5. Synthesize (script — needs GEMINI_API_KEY)

Monologue:

```sh
bun skills/make-podcast/scripts/synthesize.ts script.md --voice Kore --out episode.wav
```

Dialogue (speaker names must match the script's `Name:` labels; pick two
distinct voices):

```sh
bun skills/make-podcast/scripts/synthesize.ts script.md \
  --speaker "Alex=Kore" --speaker "Sam=Puck" --out episode.wav
```

Optional: `--model gemini-2.5-pro-preview-tts` for higher quality.
The script wraps the raw PCM response into a playable WAV.

### 6. Sanity-check the output (your judgment)

`synthesize.ts` prints the bytes written, the duration implied by the
byte/byte-rate math, and the words-per-minute pace, and warns when either
is implausible. Confirm: the file exists and is non-trivial in size, the
duration is plausibly 2–5 minutes, and pace is roughly 110–220 wpm. If
anything looks off (truncated audio, absurd pace), re-synthesize before
saving — never save an episode you wouldn't press play on.

### 7. Save (script)

```sh
bun skills/make-podcast/scripts/save.ts <artifact.json> --audio episode.wav --script script.md [--out-dir artifacts]
```

Validates against the contract and writes
`<out-dir>/podcast/<slug>/artifact.json` with `episode.wav` and
`script.md` alongside (`audio` is set to the audio file name
automatically). Validation errors are printed; fix the JSON rather than
bypassing the script.

## Output contract

Every artifact lands at `artifacts/podcast/<slug>/` containing
`artifact.json` + the audio file + `script.md`. See
`skills/_shared/lib/artifact.ts` for the full type; the required
`quality { critic_pass, quotes_verified, notes? }` block must reflect
steps 4 above — keep the JSON strictly contract-valid.
