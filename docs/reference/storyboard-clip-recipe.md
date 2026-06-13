# Storyboard → Clip recipe (the "BAD TASTE" three-prompt pipeline)

**Source:** https://x.com/aimikoda/status/2065185818332053911 (Kōda,
@aimikoda), captured verbatim 2026-06-12. Tweet posted 2026-06-11.

The recipe is a three-stage prompt chain that turns one styled identity
image into a continuity-locked 15-second video clip:

1. **Stage 1 — identity/reference image** (GPT Image 2): one saturated,
   highly stylized image establishing the characters, palette, and style.
2. **Stage 2 — storyboard SHEET image** (GPT Image 2): a single 16:9 image
   containing a 6-panel 3x2 grid of monochrome sketch panels plus a
   "director strip" of animatic tracks. Machine-readable continuity
   contract, not a human deliverable.
3. **Stage 3 — video** (Seedance 2.0, reference-to-video): both images are
   passed as references; the prompt tells the model the storyboard is the
   authoritative blueprint and the identity image is the authoritative
   character reference.

The three prompts are reproduced **verbatim** below, followed by an anatomy
commentary.

---

## Stage 1 — Identity / reference image prompt (GPT Image 2)

> Actually, I used an image replication system I created for Nano Banana
> Pro to generate a prompt that recreates a visual I found on Pinterest
> with different characters, and I used that prompt in GPT Image 2.

```
CHARACTER = skinny teenage scavenger with cyan twin-tail hair
CREATURE = colossal stitched kaiju plush guardian
PALETTE = electric cyan, neon pink, acid yellow, deep violet
BACKGROUND = flat turquoise sky

DO:
  Place CHARACTER standing in the foreground with a tired, annoyed expression.
  Give CHARACTER a unique silhouette separate from CREATURE.
  Add worn streetwear, oversized geometric shirt, bandages, scratches, patched sleeves, and cyberpunk accessories.
  Position CREATURE looming behind CHARACTER, towering over her like a living mountain.
  Design CREATURE as a gigantic patchwork beast, not humanoid.
  Give CREATURE a bulky asymmetrical body, mismatched horns, stitched seams, fabric patches, exposed stuffing, and oversized claws.
  Create huge glowing yellow eyes with different shapes and proportions.
  Open CREATURE's massive mouth behind CHARACTER as a dramatic backdrop.
  Fill the mouth with broken stone-like teeth and deep shadow.
  Show signs of age through tears, repairs, stitches, and patched fabric.
  Make CREATURE feel protective rather than aggressive.
  Use sketchy linework, rough fabric folds, and graphic shapes throughout.
  Push the color contrast with bold cyan, pink, and yellow accents.

STYLE: punk anime illustration, street-art poster, graphic novel cover, hand-drawn ink lines, flat cel shading, highly stylized

CAMERA: low-angle medium-full shot, centered composition, slight wide lens

MOOD: lonely, rebellious, strange friendship, post-apocalyptic whimsy

RULES:
  CHARACTER and CREATURE must have completely different silhouettes.
  CHARACTER must feel human and fragile.
  CREATURE must feel ancient, gigantic, and plush-like.
  CREATURE occupies most of the frame.
  Colors remain highly saturated and graphic.
  No realistic rendering.

NO: matching facial features, matching proportions, humanoid monster, photorealism, cinematic lighting, gradients, text, logos, watermarks, extra characters
```

---

## Stage 2 — Storyboard-sheet image prompt (GPT Image 2)

> Then I created a storyboard from that image (Shared the storyboard skill
> with my subscribers.)

```
Create a 16:9 image.

[PROJECT CARD]
Create a compact designed masthead, not a table.
TITLE: BAD TASTE
META LINE: absurd dread -> slapstick horror-comedy / locked-off single take
PRIORITY: identical fixed framing across all panels; the gag reads through change inside one unmoving frame
MICRO BRIEF: a girl stands alone in a locked frame; a giant plush monster rises behind her, swallows her whole, fails to digest her, and spits her back out drenched in drool.

[CONTINUITY HEADER]
SEQUENCE ID: GULP-01
REFERENCE PRIORITY: identity reference controls character identity; this storyboard controls staging, motion, geography, continuity.

[SCENE PACKET]
PREMISE: a locked camera watches a girl get swallowed whole by a giant patchwork plush monster and spat back out when his stomach rebels.
LOCATION: flat open cracked stone ground, empty flat backdrop, no walls, no props; usable surfaces are ground plane only; the monster occupies the full background when present.
START -> END: C1 stands alone at frame center, bored posture, monster absent -> C2 slumps queasy in background, C1 sprawled in foreground center soaked in thick drool strands, frame otherwise unchanged.
ACTION CHAIN: empty calm -> C2 rises from behind ground line filling background -> jaws lunge down and engulf C1 in one gulp -> mouth closed, throat and belly bulge as C2 works to swallow -> C2's face sours, cheeks balloon, body heaves with nausea -> C2 retches and ejects C1 forward; C1 lands dripping, drool strands connecting her to the open mouth.
PROP / EFFECT STATE: drool/saliva is the key effect: absent P01-P02, strands inside jaws P03, dribble from sealed lips P04, leaking heavily P05, massive spray plus strands and puddle around C1 in P06; C1's clothing dry P01-P03, soaked and matted P06.
MUST READ: the camera never moves; only the monster and the girl change inside one identical fixed frame.

[CHARACTER SANITIZATION]
C1: young woman, slim small silhouette, very long twin-tail hair, oversized boxy graphic tee over shorts, mismatched tall socks, chunky platform sneakers, adhesive bandages on face and legs, slouched deadpan posture, light loose movement.
C2: colossal round patchwork plush monster, body wider than frame, mismatched stitched fabric patches, two stubby striped horns, one flat button left eye, one wide slit-pupil right eye, enormous mouth of large blunt jagged teeth, stubby clawed paws, heavy lumbering movement.
Remove contradictory traits, invisible psychology, excessive costume detail, and backstory that cannot appear in a panel.

[IDENTITY CONSISTENCY]
Identity reference controls face, body, wardrobe, and proportions for both characters; keep C1 and C2 IDs, silhouettes, wardrobe, key props, and screen positions consistent across all panels; C1 stays frame center, C2 fills the background; do not redesign or merge characters.

[STORYBOARD PURITY]
Panel images are visual-only low-detail monochrome light-gray rough sketches. Put panel numbers, beat names, and lens tags in the header strip outside each panel image. No color, labels, arrows, captions, subtitles, logos, watermarks, timing marks, diagrams, UI, ghost poses, duplicate bodies, or technical overlays inside panels.

[MASTER SHOT RULE]
Panel 01 is the master: full geography of the locked frame, C1 small at center on the ground line, empty background, generous headroom where C2 will later rise. Every later panel keeps this exact geography.

[EMOTIONAL ARC]
bored stillness -> looming dread -> violent engulfment -> uneasy strained swallowing -> rising disgust and nausea -> messy comic rejection; read through C1's slack posture vanishing into scale contrast, C2's eye and cheek changes, and the growing drool state in an unchanging frame.

[STYLE LOCKS]
STYLE LOCK: final video style is vibrant patchwork anime illustration: bold dark linework, saturated cyan-magenta-purple-yellow palette, stitched-fabric texture on the monster, grungy distressed detail, flat solid cyan backdrop, flat graphic lighting with minimal shading.
EFFECT LOCK: drool reads as thick glossy viscous strands and ropes with soft highlights, stretchy and heavy, never mist or spray particles; consistent thickness and stringy behavior across panels.
ENVIRONMENT LOCK: flat cracked stone ground plane and plain flat backdrop only; no set redesign, no added props, no horizon change; same ground cracks in every panel.

[SPATIAL CONTINUITY LOCK]
P01 through P06 share one identical locked-off camera setup: same low wide frontal angle, same lens, same framing, same ground line, same crack pattern, zero camera movement, zero cuts. No panel is a new establishing shot. Locked anchors: C1's center floor mark, ground cracks, flat backdrop, frame edges. Only allowed changes: C2 entering/filling the background, character poses, mouth open/closed state, drool state, C1 visible/inside/ejected, damage and wetness on C1.

[DIRECTOR STRIP]
Bottom animatic track board aligned to panel columns. Tracks: BEAT LINE, CAMERA PATH, ACTION PATH, RHYTHM TRACK, ESCALATION MAP, STATE TRACK, STYLE TRACK. Use shot chips, thin lines, rhythm blocks, small intensity bars, one-to-three-word labels. No seconds or timestamps.
RHYTHM TRACK format: `RHY P##: [hold|slow reveal|build|burst|impact|pause|recover|final hit] / [short block|medium block|long block] / [clean beat|match beat|smash beat|held beat|whip beat]`.
ESCALATION MAP format: `ESC P##: [L1 calm|L2 tension|L3 rise|L4 surge|L5 peak] / [flat|rise|spike|drop|release|unresolved]`.
PANEL HEADERS: P01 / 24mm wide / Empty master -> P02 / 24mm wide / Monster rises -> P03 / 24mm wide / One-gulp swallow -> P04 / 24mm wide / Straining to digest -> P05 / 24mm wide / Nausea turn -> P06 / 24mm wide / Spit-out finale
CAMERA + LENS PLAN: P01 locked-off low wide, same-lens -> P02 same locked frame, hold -> P03 same locked frame, hold -> P04 same locked frame, hold -> P05 same locked frame, hold -> P06 same locked frame, final hold
ACTION PATH: P01 C1 stands slack at center, alone -> P02 C2 looms up from behind ground line, filling background above C1, jaws parting -> P03 C2's open jaws crash down over C1, swallowing her in one gulp, drool strands snapping -> P04 mouth sealed, C2 upright, throat and belly bulging as he gulps and grinds -> P05 C2's cheeks balloon, eyes wince and water, body buckles forward in nausea, drool leaking through teeth -> P06 C2 retches and ejects C1 forward; C1 lands sprawled at center foreground coated in drool, thick strands stretching back to C2's hanging-open mouth
RHYTHM TRACK: P01 RHY: hold / medium block / held beat -> P02 RHY: slow reveal / medium block / held beat -> P03 RHY: burst / short block / smash beat -> P04 RHY: pause / long block / held beat -> P05 RHY: build / medium block / match beat -> P06 RHY: final hit / short block / smash beat
ESCALATION MAP: P01 ESC: L1 calm / flat -> P02 ESC: L2 tension / rise -> P03 ESC: L4 surge / spike -> P04 ESC: L3 rise / flat -> P05 ESC: L4 surge / rise -> P06 ESC: L5 peak / release
STATE TRACK: P01 C1 dry, frame empty behind -> P02 C2 enters background, C1 unaware -> P03 C1 inside jaws, drool strands active -> P04 C1 hidden, bulge state, lip dribble -> P05 bulge high, heavy leak, queasy face -> P06 C1 ejected soaked, drool puddle, C2 slumped sick
STYLE TRACK: P01 flat cyan calm -> P02 looming patchwork mass -> P03 jaw spike -> P04 strained bulge -> P05 queasy green tint cue -> P06 glossy drool finale

[SEQUENCE]
Grid: 6 panels in a 3x2 grid; one locked-off continuous single take sampled at six phases, identical framing in every panel, no cuts.
```

---

## Stage 3 — Video prompt (Seedance 2.0, both images as references)

> After that, I used both the original image and the storyboard image to
> generate the video with the following prompt:

```
Use @[storyboard ref] as the authoritative director-approved storyboard blueprint for the sequence. Treat every storyboard panel as a consecutive shot within a single cinematic sequence. Follow panel order exactly and do not invent alternative coverage. Do not render the storyboard sheet itself. Preserve camera placement, framing, lens intent, shot scale, character staging, screen direction, environmental geography, prop placement, action choreography, continuity and emotional escalation shown by the storyboard. The storyboard is the primary source of truth for visual storytelling. Recreate the filmed sequence implied by the panels rather than the physical storyboard artwork.
The entire video is one continuous locked-off shot with no visible cuts; the camera never moves, pans, zooms, or shakes; each panel is a sampled phase of the same unmoving frame.
Use one virtual lens / same-lens locked camera.
Use @[ref image] as the authoritative character reference for C1, the cyan twin-tail girl, and C2, the giant patchwork plush monster.

ENVIRONMENT: flat cracked stone ground, plain solid cyan backdrop, no props; C1's floor mark stays at frame center, same ground cracks throughout; C2 fills the background when present.

EMOTIONAL GUIDANCE: Valence: bored neutral to threatening to disgusted comic relief. Arousal: low and still, spiking at the swallow, simmering through digestion, surging at the nausea, releasing into deadpan calm; shown through posture, C2's eye and cheek changes, bulge motion, and drool state while the frame stays still.

VISUAL STYLE: vibrant patchwork anime illustration matching @[ref image]: bold dark linework, saturated cyan-magenta-purple-yellow palette, stitched-fabric texture on the monster, grungy distressed detail, flat graphic lighting, minimal shading; drool is thick glossy viscous strands with soft highlights.

AUDIO: No background music or score. Only diegetic ambience, foley, impacts, texture, and silence: faint wind, fabric thumps, wet gulps, gurgles, a huge retch, splattering drool.

PANEL BEATS:
P01: Locked low wide frame; C1 stands alone at center, slouched and idle, weight shifting slightly; empty backdrop; soft wind.
P02: Same frame; C2 rises silently from behind the ground line, his patchwork mass filling the background above C1; jaws begin to part; C1 does not react; low fabric creak.
P03: C2's open jaws crash down over C1 and he swallows her whole in one fast gulp; drool strands snap; mouth slams shut; heavy wet impact.
P04: C2 sits upright, mouth sealed, throat and belly bulging and shifting as he gulps and grinds; muffled gurgles; drool dribbles from his lips.
P05: His cheeks balloon, eyes wince and water, body buckles forward heaving with nausea; drool leaks through his teeth; rising groan.
P06: C2 retches and ejects C1 forward; she lands sprawled at center foreground soaked in drool, thick strands stretching back to his hanging-open mouth as he slumps queasy behind her; splatter, then still silence.
```

(The author closes the thread with: "Used my storyboard skill on Claude
Fable 5.")

---

## Anatomy commentary — why each piece exists

The whole recipe is an answer to one problem: **video models drift.** Left
alone, a 15-second generation will re-cut the scene, reinvent the
characters, move the camera, and change the environment between seconds.
Every section is a lock against a specific axis of drift.

### The pipeline shape

- **Identity image = WHO.** Stage 1 freezes character design, silhouette,
  palette, and rendering style into pixels. Pixels are a stronger contract
  than words; the video model copies what it sees.
- **Storyboard sheet = WHAT/WHERE/WHEN.** Stage 2 is a **continuity
  compiler**: it takes a narrative ("girl gets swallowed and spat out")
  and compiles it into a spatially explicit, panel-indexed contract —
  staging, geography, prop state per phase, emotional escalation per
  phase. Crucially, **the sheet is consumed by the video model, not by
  humans.** It looks like a director's document because that genre forces
  the image model to be unambiguous, but its audience is Seedance.
- **Video prompt = the binding.** Stage 3 mostly just tells the model
  which reference is authoritative for which axis (identity ref → WHO;
  storyboard ref → everything else) and re-states the beats in text so the
  model has the same information in two modalities.

### Section-by-section

| Section | Drift axis it fights |
| --- | --- |
| `CHARACTER/CREATURE/PALETTE` variables + `RULES` + `NO` (Stage 1) | Character melt: silhouettes merging, the creature going humanoid, style sliding toward photorealism. The variable=value header makes the prompt re-targetable — swap the nouns, keep the structure. |
| `[PROJECT CARD]` | Tone drift. The META LINE and MICRO BRIEF give the image model the genre so the sketches carry the right energy. |
| `[CONTINUITY HEADER]` REFERENCE PRIORITY | Authority conflicts between the two references — declares which image wins on which axis, in both Stage 2 and Stage 3. |
| `[SCENE PACKET]` (PREMISE, LOCATION, START→END, ACTION CHAIN, PROP/EFFECT STATE) | Story drift. START→END pins the first and last frame; ACTION CHAIN pins the causal order; PROP/EFFECT STATE is a per-panel state machine for the one escalating effect (here, drool) — the model can't reset the effect because each panel's state is enumerated. |
| `[CHARACTER SANITIZATION]` | Over-description. Strips every trait that can't literally appear in a sketch panel ("invisible psychology", backstory) so the image model doesn't invent visuals for them. |
| `[IDENTITY CONSISTENCY]` | Per-panel character redesign — the classic multi-panel failure where panel 4's hero has different hair. |
| `[STORYBOARD PURITY]` | Sheet pollution. Keeps panels monochrome, low-detail, annotation-free — so the video model can't mistake captions/arrows/color for scene content, and so style is carried by the identity ref, not the sketches. |
| `[MASTER SHOT RULE]` | Geography reset. Panel 01 establishes the full frame; later panels inherit it instead of re-establishing — kills the "every shot is a new establishing shot" failure. |
| `[EMOTIONAL ARC]` | Flat affect. Names the emotional phase per beat AND the visible carriers of each emotion (posture, cheeks, drool state) — emotions must be drawn, not implied. |
| `[STYLE LOCKS]` (STYLE / EFFECT / ENVIRONMENT) | Render drift mid-clip. Three sub-locks: rendering style, the physics of the signature effect (drool = viscous strands, never mist), and the set (no new props, same ground cracks). |
| `[SPATIAL CONTINUITY LOCK]` | Camera drift — the strongest lock. One camera, one lens, zero movement, named anchors (floor mark, cracks, frame edges), plus an explicit whitelist of what IS allowed to change. The whitelist is the clever part: it gives the model permitted degrees of freedom so it doesn't take forbidden ones. |
| `[DIRECTOR STRIP]` | Pacing drift. RHYTHM/ESCALATION tracks encode tempo and intensity per panel in a constrained vocabulary (hold/burst/smash beat; L1–L5) — timing direction without timestamps, which image models can't lay out reliably anyway. |
| `[SEQUENCE]` | Layout: 3x2 grid, one continuous take sampled at six phases. |
| Stage 3 opening paragraph | Meta-drift: "do not render the storyboard sheet itself" prevents the most embarrassing failure (a video OF a storyboard); "do not invent alternative coverage" prevents re-cutting. |
| Stage 3 AUDIO | Score slop. Diegetic-only audio (foley, ambience, silence) keeps the model from pasting generic music over the gag and forces sound to track the action beats. |

### Portable principles for our adaptation

1. **One gag, one frame.** The 15s budget buys exactly one escalating
   transformation inside one locked composition. The locked camera is not a
   limitation — it's what makes the change legible.
2. **One signature effect with a per-panel state machine** (drool:
   absent → strands → dribble → leak → spray). Pick ours and enumerate its
   state per panel.
3. **Two characters, opposite silhouettes, opposite scales.** Fragile-small
   vs ancient-huge is the visual engine of the gag.
4. **Beats = 6 panels = phases of one take**, with a smash beat around
   P03 and the release at P06.
5. **Saturated, flat, graphic style** survives generation better than
   cinematic realism, and the explicit STYLE LOCK is why the patchwork
   look held.
