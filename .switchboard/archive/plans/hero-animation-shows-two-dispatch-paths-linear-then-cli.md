# The HOW IT WORKS Animation Shows Only One Dispatch Path — Add the CLI

## Goal

The landing page now claims two ways to dispatch a card. The animation shows one. Extend
`remote-loop-detailed.svg` so the loop plays **two beats**: a card forwarded from Linear on a phone,
then a card forwarded from a terminal by the LABCOM CLI.

Hero copy as shipped (`switchboard-site` `src/pages/index.astro`, hero `<p class="body-lg hero__sub">`):

> …move a kanban card on your phone and work starts at home, on your own box. **Or forward the
> highest-priority card yourself, from any terminal, with the LABCOM CLI.**

The CLI half of that sentence is currently unillustrated.

### Why it needs a hand, not a patch

This is an art task. The asset is **hand-authored** — there is no generator and no source file:

- `switchboard-site/public/assets/remote-loop-detailed.svg`, **112 KB**, `viewBox="0 0 1280 440"`
- CSS-animated inside the SVG: **41 `@keyframes`**, a **6 s** master loop (`steps(1)`), plus a
  1.2 s cursor blink (`rl-cur`)
- no scene `id`s and no `<text>` at all — every glyph is drawn pixels
- `scripts/gen-interchange-clip.py` does **not** produce this file; it emits PNG frames for the
  separate Claude/UFO/kanban clip

It was attempted from the Pi and abandoned deliberately: no SVG renderer is installed there
(`rsvg-convert`, `inkscape`, `convert`, `resvg`, `cairosvg` all absent), and chromium costs ~850 MB
against ~1.4 GB free while a fleet is running. Editing pixel art blind produces art that animates
correctly and looks wrong. **Do this on a machine that can render it.**

### What the loop shows today

Per the current `alt`:

> a mission card dragged from Staging to Coding in the Linear app on a phone, a signal arcing across
> to a Raspberry Pi, and four agent terminals beside it, the team lead acknowledging the card

## Metadata

**Complexity:** 3
**Tags:** site, art, animation
**Dependencies:** none. Repo is `github.com/TentacleOpera/switchboard-site` (private); the landing copy
it illustrates is committed there — pull before starting, the page was substantially rewritten and
shortened on 2026-09-09.

## User Review Required

None on the mechanics. The operator will judge the result visually; the beats and their order are
specified below and are not open questions.

## Proposed Changes

### 1. Add a second dispatch beat: the CLI forwards a card

- **Beat A (exists):** phone/Linear — card dragged Staging → Coding, signal arcs to the Pi, a seat
  picks it up.
- **Beat B (new):** a terminal — a prompt line runs **`lc next`**, a card is forwarded, the same
  signal arcs to the Pi, a seat picks it up. The point the art must land is that **no phone and no
  board UI is involved** — a bare terminal did it.
- **Render the command as drawn pseudo-text, not `<text>`.** Decided: match the existing style, where
  every glyph in the asset is drawn pixels. It does not need to be character-accurate at a glance —
  it needs to read as a command being typed.
- **The command is `lc next`.** Decided 2026-09-09: a subcommand of `lc`, not a hyphenated shim.
  This is a *forthcoming* rename — the CLI in the tree today is `switchboard next`
  (`src/standalone/cli.ts:4169`). The CLI has not been released, so there is no old name to preserve.
  Draw `lc next`.
- **Order:** A then B, in one continuous loop. Beat B must read as an *alternative* to A, not a
  consequence of it.

### 2. Timing

- The master loop is 6 s. Two beats need roughly 9–10 s, or the existing beat has to compress. Prefer
  extending the loop over speeding beat A up — the current pacing is legible and a faster drag reads
  as a glitch.
- Keep it seamless: the file uses `steps(1)` throughout, so the last frame must equal the first.
- Keep the 1.2 s `rl-cur` cursor blink independent of the master loop; it is a texture, not a beat.

### 3. Style constraints

- Same pixel grid and nearest-neighbour discipline as the existing art. No anti-aliased shapes.
- Palette already in the file, by frequency: `#00e5ff` (cyan accent, 39 uses), `#e0b34a`,
  `#9df6ff`, `#5e6ad2` (the Linear blue-violet), `#6cc04a`, `#f2c94c`, `#6b7280`, `#c51a4a` (the
  Raspberry Pi crimson). Draw the terminal from this set — do not introduce a new hue.
- The terminal should read as a terminal at a glance at 1280 px wide and still parse when the image is
  scaled down on a phone. It is competing with a phone, a Pi and four agent windows already in frame,
  so composition matters more than detail.
- File size: 112 KB now. Keep the result in the same order of magnitude; this is a landing-page asset
  on a self-hosted box.

### 4. Update the `alt` text with the art

- `src/pages/index.astro:73`. The current text describes only beat A. It is both the accessible
  description and the SEO text, so it must name both dispatch paths once the art shows both.

## Verification Plan

### Manual

1. Render the loop and step through it — both beats read without a caption.
2. The loop closes seamlessly; no jump at the wrap.
3. At phone width the terminal is still identifiable as a terminal.
4. `alt` names both paths and matches what the art shows.
5. Build the site (`npm run build`) and check the asset still loads at
   `/switchboard-site/assets/remote-loop-detailed.svg` — the file is referenced by path, so a rename
   breaks the page silently.

### Goal Invariants

- The hero's CLI sentence has a matching beat in the animation.
- No new colours outside the existing palette.
- Loop remains seamless and the file remains a single self-contained SVG with no external references.

## Outstanding Questions

None on the art.

### Related: the site copy names two different commands

Not part of this card, but it will look wrong next to the new art, so it should be sequenced with the
rename rather than discovered later. The landing page currently says:

- `REMOTE CONTROL` beat 2: `switchboard next` (in a `<code>` tag) — accurate today, wrong once the
  rename lands
- the CTA: `sudo apt install labcom` on a Pi, `npx labcom` on macOS and Windows

So a reader is told to install `labcom` and then to run `switchboard`. Once the CLI is `lc-*`, both
the beat and any docs example need updating in the same pass. The hero deliberately says only "with
the LABCOM CLI" and names no command, so it needs no change.
