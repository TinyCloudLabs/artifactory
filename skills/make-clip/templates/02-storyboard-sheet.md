# Template — Stage 2: storyboard-SHEET image prompt

**Target:** GPT Image 2 (fal.ai). **Output:** ONE 16:9 image — a 6-panel 3x2
grid of MONOCHROME sketch panels + a director strip. **Consumed by the video
model, not by humans.** It looks like a director's document because that
genre forces the image model to be unambiguous; its audience is Seedance.

**This image answers WHAT-HAPPENS / WHERE / WHEN — the staging + continuity
authority.** Generate it independently from the identity image; re-roll it
independently. The video stage passes it as **@Image2**.

**The sheet is the INTERMEDIATE REPRESENTATION that over-constrains the video
model so it can't drift.** Every section below is a LOCK against one axis of
drift. Iterate HERE (cheap: ~$0.25, ~3min) — front-load all legibility debt
into the sheet before the expensive video roll.

## THE LOCKS LIBRARY (the named, reusable checklist — apply every one)

- [ ] **SPATIAL-CONTINUITY LOCK** — one locked camera, one lens, zero
      movement, zero cuts; named anchors (a center floor mark, the ground
      line, the antagonist's chin line, frame edges); plus an explicit
      WHITELIST of what is allowed to change. The whitelist is the clever
      part — give the model permitted degrees of freedom so it doesn't take
      forbidden ones.
- [ ] **MASTER-SHOT RULE** — Panel 01 establishes the full geography; every
      later panel INHERITS it. "Panel 01's exact composition is traced and
      reused for all six panels. No panel is a new establishing shot."
- [ ] **SIGNATURE-EFFECT LOCK + per-panel STATE MACHINE** — ONE key effect
      (a beam, drool, a glow), with its physics fixed (e.g. "hard-edged cone,
      never soft bloom") AND its state enumerated per panel so the model
      can't reset it. Consistent look across every firing.
- [ ] **EXACT-COUNT language for countable props** — "exactly three on the
      pedestal; exactly one in the beam mid-air; exactly two remain." Counts
      stated in EVERY panel of the state machine.
- [ ] **SCALE ANCHOR** — "the antagonist's whole head fits in frame, crown
      near the top edge, chin well above the pedestal, identical eye-line and
      face-width in all six panels; do not zoom, push in, or enlarge." Trace
      panel 01's composition.
- [ ] **DIM LOCK — value change only, and specify WHAT dims** — dimming is
      LOCAL to the actor that loses power (its face + pupils darken one
      value step); the sky, ground, props, and protagonist NEVER darken.
      Scene-wide dark flashes are unattributable — never use them.
- [ ] **BODY-LANGUAGE DISAMBIGUATION LOCK** — when two opposite beats look
      alike (protective-cradling vs eating; placing-down vs picking-up), pin
      the distinguishing staging explicitly: "cradling at the belly pouch,
      far below the face; mouth stays closed; never chewing/biting/near the
      face."
- [ ] **STORYBOARD PURITY** — panels are grayscale, low-detail, annotation-
      free; render glows/beams as plain white/light-gray shapes; NO color,
      labels, arrows, captions inside panels (labels go in the header strip).
      Style is carried by the identity ref, not the sketches.
- [ ] **SAMPLE THE FINAL PANEL AFTER THE CLIMAX RESOLVES** — P06 is the held
      button (the reopened reveal, the bare pedestal + steady glow), NOT a
      mid-action frame.

## Metaphor-distance dial

Set referential distance deliberately in the MICRO BRIEF + iconography:
`literal` / `grounded-allegory` / `pure-allegory`. The further toward pure
allegory, the more "translation tax" the viewer pays (felt as "abstract").
Counter it with ICONOGRAPHY LOCKS in the EFFECT LOCK: make the symbol carry
its meaning (data objects render as memory-fragments/photos/documents, not
generic glowing orbs). Referential distance is a KNOB you set, not an
accident.

## Skeleton (fill ALL-CAPS slots; keep every section header)

```
Create a 16:9 image.

[PROJECT CARD]
Create a compact designed masthead, not a table.
TITLE: <SHORT TITLE>
META LINE: <one-line genre + "locked-off single take">
PRIORITY: identical fixed framing across all panels; every causal link is physically visible inside one unmoving frame
MICRO BRIEF: <2-3 sentences: the whole gesture as ONE escalating transformation; set metaphor distance via the iconography you name>

[CONTINUITY HEADER]
SEQUENCE ID: <ID>
REFERENCE PRIORITY: identity reference controls character identity; this storyboard controls staging, motion, geography, continuity.

[SCENE PACKET]
PREMISE: <one sentence — the locked-camera gesture>
LOCATION: <flat ground + the single key prop at frame center; plain backdrop; antagonist fills upper background>
START -> END: <first-frame state> -> <last-frame state, frame otherwise unchanged>
ACTION CHAIN: <causal beats joined by "->", every link physically on screen>
PROP / EFFECT STATE: <the SIGNATURE EFFECT + counts, enumerated per panel P01..P06 — this is the state machine>
MUST READ: the camera never moves; <the effect is always drawn as a complete visible cause>; counts are exact in every panel; <the disambiguation, e.g. the protective beat is gentle, never eating>.

[CHARACTER SANITIZATION]
C1: <protagonist — only traits that can appear in a sketch panel; name the finale prop>
C2: <antagonist — its only actions are X, Y, Z>
<EFFECT/PROP>: <exactly N exist in the whole story, never more; their look; what happens to each>
Remove contradictory traits, invisible psychology, excessive costume detail, and backstory that cannot appear in a panel.

[IDENTITY CONSISTENCY]
Identity reference controls face, body, texture, and proportions for both characters; keep C1/C2 IDs, silhouettes, key props, and screen positions consistent across all panels; the <props> never change size; counts follow the per-panel state exactly.

[STORYBOARD PURITY]
Panel images are visual-only low-detail monochrome light-gray rough sketches, strictly grayscale: render <every glow/beam> as plain white/light-gray shapes; absolutely no <palette colors>, no color cast, no tint inside any panel; <the antagonist's> dimming reads as a darker gray value on its face only, never on the rest of the panel. Put panel numbers, beat names, and lens tags in the header strip OUTSIDE each panel image. No color, labels, arrows, captions, subtitles, logos, watermarks, timing marks, diagrams, UI, ghost poses, duplicate bodies, or technical overlays inside panels.

[MASTER SHOT RULE]
Panel 01 is the master: <full geography — center prop, protagonist beside it with its finale prop plainly visible, antagonist filling the upper background, clear margin>. Every later panel keeps this exact geography.

[EMOTIONAL ARC]
<phase -> phase -> phase ...>; read through C1's posture, C2's <eye brightness>, the <effect> state, and the <count/glow> state in an unchanging frame.

[STYLE LOCKS]
STYLE LOCK: final video style is punk anime illustration, street-art poster, graphic novel cover: hand-drawn ink lines, bold dark linework, flat cel shading, saturated <PALETTE>, <textures per character>, flat solid backdrop, flat graphic lighting with minimal shading, no photorealism, no gradients.
EFFECT LOCK: <the ICONOGRAPHY — the signature effect's exact look, e.g. data glow reads as a solid core with one flat halo ring, never soft bloom; the symbol carries its meaning>.
<SIGNATURE-EFFECT> LOCK: <the effect is the ONLY way X happens; nothing ever vanishes/teleports without the effect visibly causing it; identical look every firing>.
DIM LOCK: dimming is local to <C2> only: its pupils and surface lines lose brightness and its face darkens by one value step; the sky, ground, prop, and C1 never darken; there is no scene-wide lighting change anywhere.
<DISAMBIGUATION> LOCK: <the opposite-beat staging pinned, e.g. C1's handling is cradling/tucking at the belly, far from the face; mouth stays closed; never eating>.
ENVIRONMENT LOCK: flat ground plane, single <prop>, plain flat backdrop only; no set redesign, no added props; same prop position and ground line in every panel.

[SPATIAL CONTINUITY LOCK]
P01 through P06 share one identical locked-off camera setup: same low wide frontal angle, same lens, same framing, same ground line, same prop position, zero camera movement, zero cuts. <C2's> face is drawn at the exact same scale and screen position in every panel: whole head in frame, crown near top edge, chin well above the prop, identical eye-line height, identical chin line, identical face width in all six panels; C1 and the prop are the identical size and position in every panel; do not zoom, push in, crop closer, or enlarge any element between panels; panel 01's exact composition is traced and reused for all six panels. No panel is a new establishing shot. Locked anchors: <the prop at frame center, the ground line, C2's chin line, frame edges>. Only allowed changes: <the WHITELIST — C2's eye brightness, the effect appearing/disappearing, prop counts per the state track, C1's pose and finale-prop state, glow state>.

[DIRECTOR STRIP]
Bottom animatic track board aligned to panel columns. Tracks: BEAT LINE, CAMERA PATH, ACTION PATH, RHYTHM TRACK, ESCALATION MAP, STATE TRACK, STYLE TRACK. Use shot chips, thin lines, rhythm blocks, small intensity bars, one-to-three-word labels. No seconds or timestamps.
RHYTHM TRACK format: `RHY P##: [hold|slow reveal|build|burst|impact|pause|recover|final hit] / [short block|medium block|long block] / [clean beat|match beat|smash beat|held beat|whip beat]`.
ESCALATION MAP format: `ESC P##: [L1 calm|L2 tension|L3 rise|L4 surge|L5 peak] / [flat|rise|spike|drop|release|unresolved]`.
PANEL HEADERS: P01 / <lens> / <beat> -> P02 / <lens> / <beat> -> ... -> P06 / <lens> / <beat>
CAMERA + LENS PLAN: P01 locked-off low wide, same-lens -> <... same locked frame, hold ...> -> P06 same locked frame, final hold
ACTION PATH: <P01 ... -> ... -> P06 ...  — every causal link physically on screen, with exact counts each panel>
RHYTHM TRACK: <P01 ... -> ... -> P06 ... — smash beat around the turn, held beat for the button>
ESCALATION MAP: <P01 L1 calm / flat -> ... -> P06 release>
STATE TRACK: <P01 ... -> ... -> P06 ... — the count/effect state per panel>
STYLE TRACK: <P01 ... -> ... -> P06 ...>

[SEQUENCE]
Grid: 6 panels in a 3x2 grid; one locked-off continuous single take sampled at six phases, identical framing in every panel, no cuts.
```

## Why the sheet is grayscale + machine-facing

Keeping panels monochrome and annotation-free stops the video model from
mistaking captions/arrows/color for scene content; the identity ref carries
style, the sheet carries staging. The sheet is the continuity COMPILER: it
compiles a narrative into a spatially explicit, panel-indexed contract.
