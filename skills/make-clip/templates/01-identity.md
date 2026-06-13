# Template — Stage 1: identity / reference image prompt

**Target:** GPT Image 2 (fal.ai). **Output:** ONE saturated, highly stylized
image — the authoritative WHO reference for stages 2-3. It freezes character
design, silhouette, palette, and rendering style into pixels; pixels are a
stronger contract than words, and the video model copies what it sees.

**This image answers WHO, not what-happens.** Generate it independently from
the storyboard sheet; re-roll it independently. The video stage passes it as
**@Image1**.

## Authoring rules (encode these every time)

- **Two characters, opposite silhouettes, opposite scales.** Fragile-small
  protagonist vs ancient-huge antagonist (or your story's equivalent) is the
  visual engine. They must never share a silhouette.
- **PRE-STAGE EVERY PROP THE FINALE DEPENDS ON.** If the climax hinges on a
  pouch, a seam, a container, a tool — it MUST be plainly visible, correctly
  shaped, and unobstructed in THIS image. A prop the video needs but the
  identity never established will be invented inconsistently. (Prototype
  lesson: the belly POUCH had to be introduced here as an unmistakable
  stitched pocket, never a mouth-like line.)
- **EXACT COUNTS for countable props.** "Exactly three X, never more." GPT
  Image miscounts; state the exact number and where each one sits.
- **ICONOGRAPHY LOCK (metaphor-distance dial).** If a symbol IS the meaning,
  render it as legible meaning, not a generic glow. If the orbs ARE the data,
  make them read as data (memory-fragments, photos, documents) — not
  anonymous spheres. The further your narrative sits toward pure-allegory,
  the harder this iconography must work to pay the viewer's translation tax.
- **The signature effect's at-rest look is established here** (the orb glow,
  the seam, the beam's color) so the storyboard + video inherit one look.
- **No text, logos, or watermarks** — the model can't render text reliably;
  captions are a post-process (caption.ts).

## Skeleton (fill the ALL-CAPS slots; keep the structure)

```
CHARACTER = <PROTAGONIST one-line: silhouette + the finale-critical prop pre-staged>
CREATURE = <ANTAGONIST one-line: opposite silhouette, opposite scale>
PALETTE = <3-4 saturated colors, e.g. electric violet, hot magenta, acid green, deep indigo>
BACKGROUND = <flat single-color backdrop>

DO:
  Place CHARACTER <where in frame>, <posture>, <relation to the key prop — tending/holding/guarding>.
  <Pre-stage the countable prop with an EXACT count and exact placement, e.g. "Rest exactly three identical <ICONOGRAPHIC data objects> separately on the plinth; CHARACTER holds nothing.">
  Give CHARACTER a unique silhouette separate from CREATURE: <describe>.
  <Pre-stage every finale-critical prop on CHARACTER, e.g. "Give CHARACTER one prominent stitched POUCH on its belly … unmistakably a pocket for carrying things and not a mouth, fully unobstructed.">
  Position CREATURE as <scale + placement, e.g. an enormous face filling the entire upper background>.
  Design CREATURE as <form>: no body, no limbs (if a face-only antagonist).
  Give CREATURE <the feature that drives its signature action, e.g. huge wide-OPEN expressive eyes capable of flaring>.
  Make the <data objects> the brightest, most legible objects in the frame: <ICONOGRAPHY — what they literally read as>.
  Keep the <countable props> as <N> separate objects that never touch, merge, or connect; no stems, stalks, or strings.
  Use hand-drawn ink lines, bold dark linework, flat cel shading, and graphic poster shapes throughout.

STYLE: punk anime illustration, street-art poster, graphic novel cover, hand-drawn ink lines, bold dark linework, flat cel shading, saturated palette, highly stylized

CAMERA: low-angle wide shot, centered composition, slight wide lens

MOOD: <3-4 mood words capturing the emotional truth>

RULES:
  CHARACTER and CREATURE must have completely different silhouettes.
  CHARACTER must feel small, soft, and fragile (or your protagonist's quality).
  CREATURE must feel <ancient, vast, mineral, machine-still — its quality>.
  <The finale-critical prop> must read as <correct reading>, never as <the dangerous misread>.
  Exactly <N> <countable props> in the whole image, <where>, none <wrong placement>.
  Colors remain flat, saturated, and graphic, with flat graphic lighting and minimal shading.
  No realistic rendering.

NO: matching facial features, matching proportions, humanoid creature body (if applicable), <the specific misreads your story risks>, photorealism, cinematic lighting, gradients, soft gradients, text, logos, watermarks, extra characters
```

## Backported prototype tweaks (why these slots exist)

- The protagonist must hold NOTHING near its face if "eating" is a misread
  risk — a held-at-face object drove an inverted blind-test reading in v1.
- The antagonist's action-driving feature (open flaring eyes) must be
  established here, or the video can't perform the action.
- The finale prop (pouch) introduced here as an unmistakable pocket killed
  the "necklace / second mouth" misread that v1 suffered.
