# Template — Stage 3: video prompt (Seedance 2.0, reference-to-video)

**Target:** Seedance 2.0 `reference-to-video` (fal.ai), ~15s, with TWO image
references attached by `generate-video.ts`:

- **@Image1** = the stage-1 IDENTITY image (authoritative for WHO).
- **@Image2** = the stage-2 STORYBOARD SHEET (authoritative for everything
  else: staging, geography, prop state, continuity, escalation).

**This stage is just the binding.** It tells the model which reference wins
on which axis and re-states the beats in text so the model has the same
information in two modalities. It is the EXPENSIVE stage (~$4.50, ~4.5min) —
arrive here with clean refs; do not iterate the story here.

## Authoring rules

- **Use the @Image1 / @Image2 placeholders literally** — `generate-video.ts`
  uploads identity FIRST (so it is @Image1) and storyboard SECOND (@Image2).
- **"Do not render the storyboard sheet itself"** — the most embarrassing
  failure is a video OF a storyboard. Keep this line.
- **"Do not invent alternative coverage"** — prevents re-cutting.
- **Re-state the CAUSALITY RULES + the signature-effect physics + the
  disambiguation lock in prose** — the model gets it in both modalities.
- **AUDIO is diegetic-only** — no music/score (kills score-slop); foley +
  ambience + silence that TRACKS the action beats. Audio is free
  (`generate_audio=true`) and often carries causation the visuals rush.
- **15 seconds is a GESTURE, not a story.** Structure = setup -> turn ->
  button. ~4 beats max (here mapped over 6 panels with the turn given a
  panel-pair). The held emotional BUTTON (real acting on the final beat) is
  what lets a viewer LEAVE WITH A FEELING, not a decoded proposition. Don't
  cram 5-6 panels of new action — that kills dwell time and reads abstract.
- **No text/captions in frame** — caption is a post-process (caption.ts).

## Skeleton (fill ALL-CAPS slots; keep the structure + the @Image refs)

```
Use @Image2 as the authoritative director-approved storyboard blueprint for the sequence. Treat every storyboard panel as a consecutive phase within a single cinematic sequence. Follow panel order exactly and do not invent alternative coverage. Do not render the storyboard sheet itself. Preserve camera placement, framing, lens intent, shot scale, character staging, screen direction, environmental geography, prop placement, action choreography, continuity and emotional escalation shown by the storyboard. The storyboard is the primary source of truth for visual storytelling. Recreate the filmed sequence implied by the panels rather than the physical storyboard artwork.
The entire video is one continuous locked-off shot with no visible cuts; the camera never moves, pans, zooms, or shakes; each panel is a sampled phase of the same unmoving frame.
Use one virtual lens / same-lens locked camera.
Use @Image1 as the authoritative character reference for C1, <PROTAGONIST one-line>, and C2, <ANTAGONIST one-line>.

ENVIRONMENT: <flat ground, the single prop at frame center, plain flat backdrop, no other props; the prop never moves; C2 fills the upper background in every frame; only its eye brightness, pupils, and effect change>.

CAUSALITY RULES: exactly <N> <props> exist; nothing ever vanishes or teleports — the ONLY way a <prop> moves toward C2 is inside its visible <SIGNATURE EFFECT>; exactly <how many leave> and exactly <how many are saved>; <the disambiguation: C1 never eats/bites — it cradles and tucks them into its <pouch>, far below its closed mouth>; all dimming is local to C2's own face and pupils — the sky, ground, prop, and C1 never darken.

<SIGNATURE EFFECT>: <its exact look — a flat hot-magenta cone with hard graphic edges, identical both firings; it hums while active and visibly fizzles when it fails>.

EMOTIONAL GUIDANCE: Valence: <phase -> phase -> ... -> the button>. Arousal: <low/busy, spiking at the turn, dropping to dead calm for the final held button>; shown through C1's posture, C2's eye brightness and effect state, and the prop/glow state while the frame stays still.

VISUAL STYLE: punk anime illustration matching @Image1: street-art poster, graphic novel cover energy, hand-drawn ink lines, bold dark linework, flat cel shading, saturated <PALETTE>, <textures per character>, flat graphic lighting, minimal shading, no photorealism, no gradients, no cinematic light. <The signature effect's iconography restated>. No text, captions, letters, or logos anywhere in the frame.

AUDIO: No background music or score. Only diegetic ambience, foley, texture, and silence: <room-tone hum, glassy chimes when props move, a rising whine while the effect is active, a soft pop on completion, fabric rustle, a straining crackle, a sputtering fizzle on failure, a low power-down sigh as C2 dims, the final button beat, then held stillness>.

PANEL BEATS:
P01: <setup — C1 tends exactly N props; C2 calm above; the finale prop plainly visible; ambience>.
P02: <the turn begins — C2 flares; the effect snaps on; exactly one prop moves inside it; C1 reacts; rising whine>.
P03: <the turn resolves — the effect retracts; the prop is gone; exactly M remain; C1 alarmed; whine cuts>.
P04: <protective beat — C1 gathers the remaining props and tucks them into its <pouch>, mouth closed, far from the face; the <pouch> glows; the pedestal empties; rustle>.
P05: <failed second attempt — C2 flares again; the same effect strains against the glowing <pouch> and HOLDS; C1 braced; crackle into fizzle>.
P06: <THE BUTTON — C2 dims one shade, defeated, sky/ground unchanged; C1 unmoved, pats its glowing <pouch>, deadpan to camera; held beat, power-down sigh, stillness>.
```

## Fix-routing (when the blind-test gate fails, route by failure type)

- **Identity drift** (character melts/changes) -> re-roll STAGE 1 (identity).
- **Staging / causality / legibility** (effect invisible, counts wrong,
  geography reset, the misread returns) -> re-roll STAGE 2 (storyboard sheet).
- **Pacing / audio / dwell** (too rushed, button doesn't land, audio slop)
  -> re-roll STAGE 3 (video) — adjust beats/audio, same refs.

Iterate on the CHEAP stages; arrive at this expensive stage with clean refs.
