# Interchange pipeline animation for the landing page

> **SUPERSEDED (2026-07-19)** by `landing-remote-animation-wotw.md`. The interchange section now ships the inline animated SVG `interchange-pipeline-detailed.svg`; the animated-webm approach this plan describes was dropped in favour of inline animated SVGs. No further work.

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

## Completion Report (2026-07-18)

Implemented the full clip in-house: a Python/PIL frame generator (168 frames @30fps, 5.6s seamless loop, 320×180 pixel grid upscaled ×4 to 1280×720) renders the three-zone scene — Claude starburst avatar + `.md` stack pulled up the UFO's tractor beam, glow cards blinking onto the kanban board in a left-to-right cascade, and the Spy-vs-Spy agent dashing in to snatch the third card the moment it lands. Encoded with ffmpeg-static to `interchange.webm` (VP9, 59KB) and `interchange.mp4` (H.264 +faststart, 97KB), both yuv420p 16:9; poster (frame 94, all three zones active, 5KB PNG-64) saved to `public/assets/posters/interchange.png`. Wired `data-webm`/`data-mp4` onto the interchange `.clip` in `src/pages/index.astro` plus a `poster` attribute on the video for the reduced-motion fallback; generator kept at `scripts/gen-interchange-clip.py` with regen instructions, and `scripts/frames` gitignored. Loop-seam integrity audited (all animation periods divide 168; frame-167 state matches frame 0) and decoded frames from both containers inspected for compression blur — crisp. Issues: no ffmpeg on the machine (used npm ffmpeg-static); one mid-implementation bug (card invisible for 3 frames between board and agent's hands during the snatch) caught in frame review and fixed. Files changed: `switchboard-site/src/pages/index.astro`, `.gitignore`, new `scripts/gen-interchange-clip.py`, `public/assets/clips/interchange.{webm,mp4}`, `public/assets/posters/interchange.png` — all uncommitted, per-user visual approval pending.

### v2 (2026-07-18, after user review)

User rejected v1: too massive, didn't reuse the existing UFO animation, avatar wasn't the real Claude starburst, quality below the site's SVG pixel art, and the video-in-a-window presentation was wrong. v2 replaces the medium entirely: `public/assets/interchange-pipeline-detailed.svg` — a single inline animated SVG in the exact house style (640-scale 4px grid, crispEdges, CSS steps() keyframes, cyan-glow filter), composed from the *verbatim* UFO geometry/animations from `switchboard-ufo-detailed.svg`, the verbatim board and spy from `docs-kanban-spy-agent-detailed-v2.svg` (spy mirrored per direction), and the Claude Code critter (chunky coral pixel creature, white eyes, stub legs) with `.md` docs being pulled out of it up the beam. Same story on a 6s master timeline: three docs rise → three cards blink in → spy dashes in, snatches the col-3 card, runs off → board resets. `index.astro` now shows it as a plain inline `<img>` (window chrome removed); reduced-motion is handled inside the SVG like the other assets. v1 video assets left in place unused, per user. Verified via headless-Chrome freeze-frames at six timeline points (negative animation-delay technique — virtual-time-budget does not advance compositor animations). Follow-up passes per user review: avatar corrected to the Claude Code critter (coral pixel creature), timeline tightened 8s→6s, spy leg run-cycles, marching beam dashes, then a detail pass (richer docs, board leg feet, ground texture/shadows, beam core, absorb sparkles, pixel moon), conveyor doc timing (overlapping rises, fade pinned at saucer), running-only gates for wind/dust/leg-cycle, a faithful Clawd sprite (web-researched: #DE886D slab, four legs, slit eyes), Spy vs Spy beak/hat upgrade in both the animation and docs-kanban-spy-agent-detailed-v2.svg, and landing restructure (single h1: intro copy → animation → flow cards → CTA; hero UFO img and window chrome removed). Page later split into three matching set pieces (pipeline / ship-from-board / no-lock-in), six differ boxes redistributed 3+3. Set-piece 2 visual: first attempt (bucket sort + complexity routing to terminals, board-feature-routing-detailed.svg) rejected — user's concept is a LIVING board in steady state, not a one-shot story. Rebuilt as board-feature-sorting-detailed.svg: 8s conservation loop (end state = start state, no visible reset) — cards stream in from off-board, fly from intake queue into purple feature slots, two rows trade features mid-loop (crossing paths), dependency bracket flashes between rows, a row's text redraws (revision), done rows tick green and clear. Real board colors (#7c3aed features, complexity pips #98c379/#d29922/#da3633). Set-piece 3 slot still placeholder. Living-board loop also shelved by user ("better, but needs a new concept") — final set-piece 2 visual is work-in-flight-detailed.svg, continuing the piece-1 story: spy sprints in place (infinite-runner ground scroll) balancing his stolen card; the UFO flies in overhead, drops a second card down the beam onto his stack (stagger + impact sparkle), holds, extracts it again and banks off right — 8s loop, verbatim piece-1 sprites. Intro copy rewritten from hierarchy hook to in-flight orchestration ("An agent runner fires a process and forgets it...") to match. All three earlier attempts kept on disk unused. Set-piece 3 (NO LOCK-IN) completed same day: middle card was a repeat of piece 1's intake story — replaced with "Your repo is the database" (files + git, uninstall and keep everything). Visual = spy-tool-select-detailed.svg, a Spy vs Spy weapon-select homage (user's concept): spy runs in, a trapulator-style menu offers bomb/terminal/browser/editor/clipboard; the bomb gets a red X, the terminal gets picked → mini board appears in his hands; cursor jumps to browser → SAME board; he sprints off with it. 8s loop, verbatim sprite, run/stand gates. All three landing set pieces now have animations.
