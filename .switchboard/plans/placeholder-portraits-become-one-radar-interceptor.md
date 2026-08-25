# Placeholder Portraits Become One Radar-Console Interceptor, Painted in the Theme Accent

## Goal
Retire the five placeholder head-and-torso portraits and the rail's bare-letter team
fallback, replacing both with a single flat interceptor silhouette lifted from the
site's radar-scope art. One drawing, one colour, painted `var(--accent)` so it takes
the theme on every surface. No new art commissioned, no per-role illustration.

### The problem, and the root cause
Two unrelated stand-ins are visible today, and neither reads as Switchboard.

**Teams tab.** `src/webview/kanban.html:3354` labels its own `<defs>` block
*"Placeholder art — replacing it is an edit to this block alone, no layout shift."*
Below it sit five `<symbol>` elements (`kanban.html:3367`–`3414`) — `portrait-planner`,
`-lead`, `-coder`, `-reviewer`, `-agent` — each an identical cyan head-and-torso figure
distinguished only by a 2–3 pixel mark on the chest. `teamsTabPortraitId()`
(`kanban.html:5040`) maps `headRole` onto them.

These are not a rare fallback. `agentArtSrc()` (`kanban.html:5112`) resolves
`agent-<role>.png` out of the icon palette, and **no `agent-*.png` files exist in
`icons/`** — so every render path bottoms out in the placeholder: the gallery card at
32px (`kanban.html:5254`), every flow-diagram node at 20px (`kanban.html:5485`), and
the icon-picker preview at 32px (`kanban.html:5858`). The placeholders *are* the
shipped experience.

They also hardcode `#00e5ff` / `#7ff3ff` / `#00b8cc`. Under `theme-claudify`, whose
`--accent` is terracotta `#D97757` (`shell.html:44`), that cyan is the only thing on
the surface ignoring the theme — the flow-diagram labels beside it already use
`var(--text-secondary)`.

**Shell rail.** A team button paints `team.iconUri` when the definition carries one,
and otherwise falls through to **a bare capital letter** — `glyph.textContent = roleChar`
at `shell.js:1188`, an "L" for a lead-headed team. `buildTeamsForShell` sends
`iconUri: iconUri || ''` (`terminals.js:1741`) and no team art ships, so the letter is
what is on the rail right now. Unlike agent buttons — which always get a brand mark via
`brandIconUri(iconKey) || brandIconUri('default')` (`terminals.js:1532`) — teams have no
default at all. The letter is deliberate, not accidental: the plan that built this rail
cut the head's brand mark as a fallback because it communicated the wrong identity, and
`shell-terminal-strip.test.js:891` pins that decision. It left a letter behind because
there was no team-shaped mark to use instead. This plan supplies one.

**The art already exists.** `switchboard-site/public/assets/agent-fleet-air-combat-detailed.svg`
defines `<g id="afc-jet">` — a nose-up pixel interceptor on a 4-unit grid, drawn in
three tones across a 56×40 extent. It is the second animated set piece on the site's
index page and is already the brand's picture of "an agent in flight". Transcribing its
rect union is a copy, not a commission.

## Metadata
- **Complexity:** 3
- **Tags:** frontend, ui, ux

## User Review Required
Two decisions are already settled by the requester and are recorded here so they are not
relitigated during coding:

1. **All five role portraits collapse to one jet.** Planner / lead / coder / reviewer
   stop being visually distinguishable in the teams-tab flow diagram; the text label
   under each node remains the only role cue. This was chosen explicitly over keeping a
   per-role mark on the fuselage.
2. **The rail gets the jet on team buttons only.** Individual agents should not be on
   the rail at all — that is a separate bug with its own plans in flight (see
   Dependencies). This plan must neither add an agent-button jet nor take a dependency
   on agent buttons continuing to exist.

## Complexity Audit

### Routine
- Transcribing the `afc-jet` rect union into one silhouette and saving it as
  `icons/nav-jet.svg`.
- Deleting four `<symbol>` blocks and rewriting the fifth.
- Reducing `teamsTabPortraitId()` to a single return while keeping its signature.

### Complex / Risky
- **The rail and the teams tab cannot share one SVG element.** `<use href="#id">`
  resolves only within its own document; `shell.js` and `kanban.html` are separate
  documents. This is the same constraint the pixel-art pipeline plan documented. The
  geometry is therefore duplicated: once as a file for the rail's mask path, once inline
  as a `<symbol>` for the teams tab. Both copies must carry a comment naming
  `agent-fleet-air-combat-detailed.svg#afc-jet` as their source so a future edit knows
  there are two.
- **`shell-terminal-strip.test.js:891` pins `glyph.textContent = roleChar` as the team
  fallback and will fail.** It must be rewritten to assert the jet glyph, and its
  sibling assertion — that `headTerm.iconUri` never becomes a team fallback — must be
  preserved verbatim. That guard is load-bearing and unrelated to this change.
- **Accent on a fleet button brushes against the rail's selection colour.** `shell.js`
  carries an explicit warning that `--accent` is the rail's panel-SELECTION colour and
  that an accent ring on a fleet button reads as "selected". That warning was written
  about the done ring (a border). An always-accent glyph fill is a different channel,
  and team buttons never receive `.is-active` (they are not in the `icons` map), so the
  selection cue — background plus border — stays unambiguous. Do not extend accent to
  the button's border or background.

## Edge-Case & Dependency Audit
- **Sub-pixel cells are a non-issue, because the silhouette is flat.** A 14×10-cell
  sprite at 20–22px puts each source cell near 1.5px. That would mush the three-tone
  original into noise. Flattening the three fill groups into one solid shape removes
  every internal edge, so only the outline is rendered and the mark stays legible at
  every size in play (20px flow node, 22px rail, 32px card and preview).
- **Per-role PNG art must keep winning.** `agentArtSrc()` and `resolveArt()` are
  untouched. Dropping `agent-lead.png` into `icons/` later must still override the jet
  on every surface — the jet is the bottom of the fallback chain, not a replacement for
  it. `teamsTabPortraitId(role)` keeps its `role` parameter for the same reason: it stays
  the seam where per-role art returns.
- **Exited and done states must survive.** `.strip-team-btn.strip-term-exited
  .strip-team-icon` applies `opacity: .5; filter: grayscale(1) brightness(1.7)`
  (`shell.html:401`) — that selector matches the `<img>` class only, so the new glyph
  needs its own rule or it will stay full-accent on an exited team. The done pulse and
  the queue-depth badge live on the button, not the glyph, and are unaffected.
- **The icon-picker preview label goes stale.** `teamsTabRenderIconPreview()` writes
  `'Role portrait (default)'` (`kanban.html:5867`) when no icon is set. Once roles no
  longer vary the art, that string is wrong.
- **Security:** None. One static SVG added to a directory already served at
  `/static/icons/`; no new route, no caller-supplied data in any URL.
- **No layout risk.** The teams-tab `<defs>` block's own comment guarantees a swap here
  shifts nothing; `TEAMS_TAB_CELL` and `CELL` are untouched. On the rail, the glyph is
  sized to the 22px the `<img>` it replaces already occupies.

## Dependencies
- **"No agents on the rail"** — separate in-flight work removes the ungrouped-terminal
  buttons that `renderTerminalSection` still emits (`shell.js:1236`). This plan is
  independent of it in both directions: it touches only the team-button branch, and it
  neither blocks nor is blocked by that removal. Do not fold that fix into this change.
- **Team icon picker / pixel-art pipeline** — both already landed. `resolveArt`,
  `teamIconSrc`, `TEAMS_TAB_CELL = 32` and `GET /terminals/icon-palette` all exist and
  are consumed as-is.

## Adversarial Synthesis
The change is small; the ways it goes wrong are all "touched one surface, forgot the
other". Chief risks: (1) updating the teams-tab symbols and leaving the rail on its
letter, or the reverse — the two surfaces are in different files and share no element,
so a partial landing looks complete from either side; (2) silently breaking the pinned
`headTerm.iconUri` guard while rewriting the test that sits beside it; (3) painting the
jet a hardcoded cyan out of fidelity to the source art, which reintroduces exactly the
theme-blindness this plan exists to remove. Mitigations: the verification plan below
exercises both surfaces under both themes; the test rewrite is specified as an
assertion swap with the sibling assertion held fixed; and `fill="currentColor"` is
specified at both copies so no hex ever reaches the markup.

## Proposed Changes

### `icons/nav-jet.svg` (new)
- **Context:** The rail is a separate document from `kanban.html` and paints
  single-colour marks through a CSS mask (`buildMaskedGlyph`, `shell.js:221`). It needs
  the jet as a file.
- **Logic:** Transcribe the union of the three `<g fill>` groups of
  `agent-fleet-air-combat-detailed.svg#afc-jet` as one flat shape. The source rects span
  x ∈ [-28, 28], y ∈ [-16, 24] on a 4-unit grid; copy them verbatim under
  `viewBox="-32 -28 64 64"` so the art lands centred with no coordinate rewriting.
  Single `fill="currentColor"`, `shape-rendering="crispEdges"`. Add a header comment
  naming the source file and `#afc-jet`.
- **Edge Cases:** The mask path reads alpha only, so the declared fill is irrelevant on
  the rail — `currentColor` is there for the inline copy's benefit and for any future
  `<img>` consumer. Overlapping rects in the union are harmless; do not spend effort
  merging them into a minimal path.

### `src/webview/kanban.html` — the placeholder `<defs>` block (3354–3417)
- **Context:** Five near-identical symbols, hardcoded cyan, one per role.
- **Logic:** Delete `portrait-planner`, `portrait-lead`, `portrait-coder` and
  `portrait-reviewer`. Rewrite `portrait-agent` as the same flat jet geometry with
  `fill="currentColor"`, and set `color: var(--accent)` on the elements that carry it
  (`.teams-card-portrait` and the flow-node `<svg>`). Replace the block's
  "Placeholder art" comment with one naming the source sprite. Leave `portrait-glow`
  alone — it is referenced independently.
- **Edge Cases:** `<use>` resolves `currentColor` against the referencing element's
  computed colour, so the accent must be set on the host element, not inside the symbol.

### `src/webview/kanban.html` — `teamsTabPortraitId()` (5040) and the preview label (5867)
- **Context:** The role→symbol map has one destination left, and the preview label
  describes art that is no longer role-derived.
- **Logic:** Reduce the function body to `return 'portrait-agent';`, keeping the `role`
  parameter and rewriting the doc comment to say this is the seam where per-role art
  returns when `agent-<role>.png` files land. Change the preview's fallback label from
  `'Role portrait (default)'` to `'Default icon'`.
- **Edge Cases:** Do not inline the function away at its four call sites — its whole
  value now is being the one place a role could start mattering again.

### `src/webview/shell.js` — team button icon fallback (1180–1190)
- **Context:** `else { glyph.textContent = roleChar; }` puts a bare letter on the rail.
- **Logic:** Replace that arm with
  `buildMaskedGlyph('/static/icons/nav-jet.svg')`, adding `strip-team-glyph` to the
  returned span's class list. Delete the now-unused `roleChar` / `headTerm` lookup in
  that branch. Update the two-deep-fallback comment above it: team icon → jet, and the
  head's brand mark is still not a valid team fallback.
- **Edge Cases:** Touch only the team branch. `buildTerminalButton` and the ungrouped
  loop stay exactly as they are — they belong to the separate rail-scope work.

### `src/webview/shell.html` — glyph styling (near 394–402)
- **Context:** `.strip-glyph` is 20px and paints `currentColor`; the exited treatment
  targets `.strip-team-icon`, which the new glyph is not.
- **Logic:** Add `.strip-team-glyph { width: 22px; height: 22px; background-color:
  var(--accent); }` after the `.strip-glyph` rule so it wins on both size and colour,
  matching the 22px footprint of the `<img>` it stands in for. Extend the exited rule to
  `.strip-team-btn.strip-term-exited .strip-team-icon, .strip-team-btn.strip-term-exited
  .strip-team-glyph`.
- **Edge Cases:** `grayscale(1) brightness(1.7)` was tuned for dark multi-hue brand
  marks; on a single accent fill it lifts the jet to legible grey, which is the intended
  "faded, not empty" read under both themes. Confirm visually rather than assuming.

### `src/test/shell-terminal-strip.test.js` — "the team icon fallback skips the head brand mark" (880–894)
- **Context:** The test pins the letter glyph as the team fallback.
- **Logic:** Swap the `glyph.textContent = roleChar` assertion for one requiring
  `buildMaskedGlyph` with `nav-jet.svg` in the same `iconBlock`. Keep the
  `!/headTerm\.iconUri/` assertion and the test name unchanged. Add an assertion that
  `roleChar` no longer appears in the block, so the letter cannot creep back.
- **Edge Cases:** `roleChar` is also computed in `buildTerminalButton`; scope the
  negative assertion to `iconBlock`, not the whole function, or it will fail spuriously.

## Verification Plan
1. `node --test src/test/shell-terminal-strip.test.js` — passes, including the preserved
   head-brand-mark guard.
2. Rail, default theme: start a team with no icon set. Its button shows the cyan jet, not
   a letter. Tooltip is still the team name.
3. Rail, `theme-claudify`: the same jet renders terracotta, not cyan.
4. Rail states: exit the team — the jet fades and greys rather than vanishing. Complete a
   team's work — the done ring still pulses once and fades, and the queue-depth badge
   still sits on top of the glyph.
5. Rail regression: a team that *does* carry an `art:` or `pack:` icon still shows that
   PNG, unchanged.
6. Teams tab: the gallery card (32px), every flow-diagram node (20px) and the
   icon-picker preview (32px) all show the jet, in the accent colour, under both themes.
   Card grid and flow layout are pixel-identical to before.
7. Teams tab regression: drop any `agent-lead.png` into `icons/`, reload, and confirm it
   overrides the jet on the flow node — the fallback chain is intact.
8. Confirm no `#00e5ff`, `#7ff3ff` or `#00b8cc` literal survives in the rewritten
   `<defs>` block.
