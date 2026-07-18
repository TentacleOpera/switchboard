# Interchange pipeline animation for the landing page

## Goal

Produce the animated pixel-art "interchange" clip for the switchboard-site landing page and wire it into the already-scaffolded slot, replacing the placeholder.

### Problem Analysis

The landing page's lead visual is the "Before the first line" interchange section, whose `.clip` slot currently shows only a placeholder ("ANIMATION — BEAM · BOARD · AGENT"). The slot is already wired for `data-webm`/`data-mp4` (with a reduced-motion fallback), but no asset exists yet. This clip carries the core "Switchboard connects the tools you already use" story and sits above the fold, so it's the single highest-value missing asset on the site.

## Dependencies

The landing slot scaffold already exists (the interchange `<section>` in `index.astro`; the `.clip` contract in `landing.js`; `.clip img/video` styling in `global.css`). Asset production is external (another model/tool).

## Metadata

**Tags:** design, frontend, marketing, asset
**Complexity:** 2
**Project:** switchboard site

## User Review Required

Approve the animation before it ships — this is a visual-taste call.

## Proposed Changes

### The animation — one continuous scene, seamless ~5–6s loop, action left → right
1. **Left (intake):** a Claude avatar emits `.md` files; the Switchboard UFO pulls them up in a cyan tractor beam.
2. **Center (board lights up):** each absorbed `.md` blinks in as a glowing cyan plan card on the kanban board, timed to the beam.
3. **Right (pickup):** a Spy vs Spy–style agent dashes in from the right edge, grabs one glowing card, and runs back out.
4. Loop resets (board dims, agent gone, Claude's stack replenished).

### Style
Chunky retro pixel art, `image-rendering: pixelated`. Dark background `#0b0f0f` → `#141818`; cyan `#00f2fe`/`#00e5ff` for the beam, card glows, and connective sparkle. Match existing characters for continuity: `public/assets/switchboard-ufo-detailed.svg` (UFO) and `public/assets/docs-kanban-spy-agent-detailed-v2.svg` (agent).

### Output + wiring
- **16:9**, `object-fit: cover` — keep the three zones clear of the extreme edges.
- Deliver **`interchange.webm`** (VP9) + **`interchange.mp4`** (H.264), muted, seamless loop, 1280×720 or 1920×1080, few-hundred-KB webm.
- A **static poster PNG** (same 16:9) showing all three zones, for the reduced-motion fallback.
- Drop assets into `public/assets/clips/`; add `data-webm`/`data-mp4` to the interchange `.clip` in `index.astro` (a comment there marks the exact spot). Wire the poster if used.

### Repo
switchboard-site.

## Definition of Done
The animation plays in the interchange slot; the poster shows under reduced-motion; the site build stays green; assets live in `public/assets/clips/`.
