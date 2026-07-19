# Act 5 remote animation (WOTW radio tower) + remaining landing visual slots

## Goal

Produce the Act 5 "remote control" animated pixel-art SVG — the *Vast of Night* WOTW radio-tower homage — and drop it into the scaffolded slot. Also settle the remaining landing visual slots: Act 4 (Artifacts) as a real screenshot/clip rather than a pixel animation, and the hero board screenshot.

### Problem Analysis / background

The landing page is a five-act pixel comic strip. Three set-piece SVGs already ship (`interchange-pipeline`, `work-in-flight`, `spy-tool-select`). Two act slots plus the hero remain as placeholders:

- **Act 5 (Remote)** needs an animation. Chosen concept: the **WOTW** radio tower (the name *Switchboard* traces to *The Vast of Night*, whose station is WOTW) broadcasting into the night; the Switchboard UFO drifts over; a **momentary short-out flips the broadcast to cyan** — "the switch." It's atmospheric homage, not a diagram — the two Act 5 cards carry the functional claims, so the art is mood.
- **Act 4 (Artifacts)** is deliberately **not** a pixel animation. It's a look-and-feel / interaction story (polished viewer, highlight-to-prompt) — concrete UI that reads badly at low-res pixel and is best shown as itself. Its "renders like the docs site" claim is already self-proven by the docs page + the "See the Artifacts panel →" link, so Act 4 gets a real screenshot (or short screen-capture) of the panel.
- **Hero** needs the board screenshot (already scaffolded; the webm is a temporary stand-in).

**This plan supersedes `pixel-interchange-animation.md`**, which is obsolete: the interchange section now uses a shipped animated SVG, and the animated-webm approach was dropped in favour of inline animated SVGs.

## Dependencies

The landing slots are already scaffolded in switchboard-site (`index.astro`: Act 5 `interchange__art--placeholder`, hero `.clip` slot; `global.css` placeholder styling). Asset production happens in switchboard-site, same branch. No blocking dependency.

## Metadata

**Tags:** design, frontend, marketing, asset, animation
**Complexity:** 3
**Project:** switchboard site

## User Review Required

Approve the WOTW animation and the Act 4 screenshot before they ship — visual-taste calls.

## Proposed Changes

### A. Act 5 — WOTW radio-tower animation (primary deliverable)

Animated pixel-art SVG, **1280×440**, **transparent background** (no field/grid — it rides over the page's bg-grid like the other set-pieces), seamless ~5–6s loop. File: `public/assets/remote-control-detailed.svg`.

Sequence (left → right, seamless loop):
1. A pixel **radio tower** with a small call-sign plate reading **WOTW**, pulsing concentric signal rings in a muted warm/white tone.
2. The **UFO** (on-model with `switchboard-ufo-detailed.svg`) drifts in and passes over the mast.
3. **Short-out** (brief — a few frames): tower light flickers, rings stutter/break, a spark.
4. **The switch:** broadcast snaps back on in **cyan** (`#00f2fe`) — rings pulse outward, brighter. This is the beat.
5. **Reset:** UFO drifts out; rings ease back to the warm tone; loop returns to frame 1 seamlessly.

Style: chunky pixel, `image-rendering: pixelated`, transparent bg, subject only (tower, UFO, rings, WOTW plate). Reduced motion: `prefers-reduced-motion` guard like the other SVGs — freeze on the post-switch cyan frame. Easter egg: the WOTW plate; optionally a blinking 1950s call-sign light.

Drop-in: in Act 5, replace the `interchange__art--placeholder` div with `<img class="interchange__art" src={\`${import.meta.env.BASE_URL}assets/remote-control-detailed.svg\`} alt="..." width="1280" height="440" loading="lazy" />` — the exact line is already in a comment in `index.astro`.

### B. Act 4 — Artifacts: real screenshot/clip, not pixel

Capture a screenshot (or short screen-capture) of the Artifacts panel — a rendered doc/design in the polished viewer, ideally showing a highlight-to-prompt action. Rationale: concrete UI; the polished-render claim is self-proven; pixel can't render legible document text. Swap Act 4's dashed placeholder for the screenshot `<img>` (or a `.clip` webm/mp4 if it's a capture).

### C. Hero — board screenshot

Real board screenshot into the hero `.clip` slot (the webm is a temporary stand-in). Static `<img>`.

### D. Cleanup

Close `pixel-interchange-animation.md` as superseded (interchange uses a shipped animated SVG; the webm approach was dropped).

### Repo

switchboard-site (art + markup). This plan is tracked on the switchboard board.

## Definition of Done
- `remote-control-detailed.svg` produced (transparent, WOTW plate, short-out → cyan switch, reduced-motion guard) and wired into Act 5.
- Act 4 shows a real Artifacts-panel screenshot/clip.
- Hero shows the real board screenshot.
- `pixel-interchange-animation.md` closed as superseded.
- Site build stays green.
