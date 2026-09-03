# Replace Mission Control Rail Icon: UFO → Pixel Jet

## Goal

The Mission Control rail icon in the shell (`shell.html` / `shell.js`) is currently a UFO/saucer with blinking lights and a tractor beam. The user previously asked for a **pixel jet** — the same top-down interceptor seen in the switchboard-site sibling repo's `agent-fleet-air-combat-detailed.svg` (the second animated SVG on the landing page). This plan replaces the UFO with that pixel jet.

### Problem & Background

- The rail icon is inlined as SVG in `shell.js` `createMissionControlIcon()` (lines 338–407). It depicts a UFO saucer with a cyan glow filter, a tractor-beam gradient, six blinking lights (`.light-a` / `.light-b`), and four stars.
- The CSS in `shell.html` (lines 245–306) animates the lights when the Mission Control session is active and freezes + grays them when dimmed.
- Tests in `shell-terminal-strip.test.js` (lines 728–761) assert the inlined SVG structure, including UFO-specific elements (`sb-mc-beam`, `.light-a`/`.light-b`).
- The target jet art is `<g id="afc-jet">` in `switchboard-site/public/assets/agent-fleet-air-combat-detailed.svg` (lines 9–13): a top-down pixel-art interceptor in three cyan tones (`#00e5ff` body, `#7ff3ff` highlights, `#00b8cc` shadows), with engine-glow trails.

### Root Cause

The original request for a jet icon was not delivered — a UFO was implemented instead. This is a correction, not a new feature.

## Metadata

**Tags:** [frontend, ui, refactor]
**Complexity:** 4

## User Review Required

- The engine-glow trail rects described in Changes §1 are **custom art added for visual character** — they are not part of the source `afc-jet` group in the site SVG (the site renders trails via a separate `<g id="afc-vec">` element, not inside the jet definition). If you want the rail icon to match the site jet exactly with no additions, tell the coder to drop the trail rects and use a `0 0 56 40` viewBox instead.
- The background description above states the site jet has "engine-glow trails." Strictly, `afc-jet` itself (lines 9–13) does not contain trail rects — the trails live in a sibling element `afc-vec` (line 14) and the scene-level composition. This is a minor imprecision in the background, not a plan-blocking error. Flagged here for accuracy; the implementation copies `afc-jet` coordinates verbatim and adds its own trail.

## Design Decisions (user-approved)

- **Active state: static.** No blinking lights, no animation. The jet simply renders at full cyan with glow when active; the existing `.mission-control-dimmed` opacity+grayscale handles the inactive state.
- **Orientation: top-down, nose up.** Same view as the site jet, nose pointing upward.
- **Glow filter: retained.** Keep `sb-mc-cyan-glow` for the cyan glow on the jet body.
- **Scope: rail icon only.** The terminals panel's separate "dispatch curtain" UFO icon (`terminals.js` `getUfoIconUri()`, external SVG files in `icons/switchboard-ufo*.svg`) is out of scope.

## Complexity Audit

### Routine

- Replacing one inlined SVG string literal with another (same `innerHTML` pattern, same `shape-rendering`, same `aria-hidden`).
- Removing CSS animation rules (`@keyframes`, `.light-a`/`.light-b` selectors) that no longer have corresponding SVG sub-elements.
- Updating test assertions to match the new SVG structure (remove beam/light assertions, keep glow/inline assertions).
- Updating comments referencing UFO/saucer/beam/stars to reference the jet.

### Complex / Risky

- **Glow filter scaling.** The `sb-mc-cyan-glow` filter uses `stdDeviation="3"` in user units. The old viewBox was `0 0 320 180` (stdDeviation ≈ 1.7% of width); the new viewBox is `0 0 56 54` (stdDeviation ≈ 5.4% of width — 3× proportionally larger). The glow may render too strong, blurring the crisp pixel-art jet into a blob. The coder should visually verify and, if needed, reduce `stdDeviation` to ~1.5–2 for the smaller coordinate space. This is the single biggest visual risk.
- **Pixel-art legibility at 28px.** The jet's 4px rects (in a 56px-wide viewBox) render at ~2px on screen when scaled to 28px wide. Detail may be lost. The original UFO had the same challenge in a 320×180 space, so this is comparable, not new — but the jet has finer detail (wing-tip rects at x=-28/x=28) that may disappear.

## Edge-Case & Dependency Audit

**Race Conditions:** None. The icon is static (no animation, no async state). The click handler is unchanged.

**Security:** No new innerHTML injection surface. The SVG is a hardcoded string literal, same as the existing UFO. No user input flows into it.

**Side Effects:** Removing `.light-a`/`.light-b` CSS rules and `sb-mc-beam` gradient. Grep confirms these classes/IDs are referenced only in the three files this plan touches (`shell.js`, `shell.html`, `shell-terminal-strip.test.js`). No other code depends on them.

**Dependencies & Conflicts:** The test file must be updated in lockstep with `shell.js` — if the SVG changes but tests don't, the build breaks. The plan handles this in Changes §3. No external library or API dependencies.

## Dependencies

- `switchboard-site/public/assets/agent-fleet-air-combat-detailed.svg` — source of the `afc-jet` pixel art (lines 9–13). Read-only reference; not modified.

## Adversarial Synthesis

Key risks: (1) the glow filter's `stdDeviation=3` is 3× proportionally larger in the new 56×54 viewBox, potentially blurring the pixel jet into a blob; (2) the invented engine-glow trail rects are custom art not present in the source `afc-jet`, which may or may not match user intent; (3) pixel-art detail at 28px render width may lose wing-tip rects. Mitigations: coder visually verifies the glow strength and adjusts `stdDeviation` if needed; trail is flagged in User Review Required for user to accept or reject; legibility is comparable to the existing UFO icon.

## Proposed Changes

### `src/webview/shell.js` — `createMissionControlIcon()` (lines 338–407)

**Context:** The function builds the Mission Control rail button with an inlined UFO SVG. The SVG is inlined (not `<img>`) so the glow filter `sb-mc-cyan-glow` is self-contained and the existing CSS can reach sub-elements.

**Logic:** Replace the UFO SVG markup with the pixel jet SVG, copied from the site's `afc-jet` group.

**Implementation:**
- **Keep:** `aria-hidden="true"`, `class="strip-mc-icon"`, `shape-rendering="crispEdges"`, the `sb-mc-cyan-glow` filter definition, the click handler (unchanged — lit → navigate, dimmed → POST `/mission-control/start`).
- **Remove:** `sb-mc-beam` gradient + beam path, `.light-a`/`.light-b` rects, `.star-a`/`.star-b` rects, the UFO saucer body rects.
- **Add:** The pixel jet body — three `<g>` groups (`#00e5ff`, `#7ff3ff`, `#00b8cc`) with the site's rect coordinates (from `afc-jet`, lines 10–12), wrapped in a `<g transform="translate(28,16)">` to center them in the viewBox (jet spans x:-28..28, y:-16..24 → translated to x:0..56, y:0..40). Add 3 engine-glow trail rects below the jet (fading cyan, `opacity` .32/.2/.1) for character — these are custom art, not from `afc-jet`; see User Review Required.
- **viewBox:** `0 0 56 54` (jet spans 56×40 + 14px trail below).
- **Glow filter note:** If the glow is too strong at the new scale, reduce `stdDeviation` from `3` to ~`1.5`–`2`. Visually verify.
- **Update the comment block** (lines 285–301, 346–354): replace all UFO/saucer/beam/stars/blinking-lights references with jet descriptions. Line 353's class list (`.ufo, .beam, .light-a, .light-b, .star-a, .star-b`) must be removed or replaced — none of these classes exist in the new SVG.

### `src/webview/shell.html` — CSS (lines 245–306)

**Context:** The CSS block animates UFO blinking lights and handles dimmed/active states. With a static jet, the animation rules are dead code.

**Logic:** Remove all animation rules; keep dimmed/active state styling.

**Implementation:**
- **`.strip-mc-icon`** (lines 291–296): change sizing from `width: 28px; height: 16px` to `width: 28px; height: 27px` (matches the jet's 56:54 aspect ratio at 28px wide; fits the 36px button).
- **Remove** the `.light-a`/`.light-b` animation rules (lines 274–290): `@keyframes sb-mc-light-a`, `@keyframes sb-mc-light-b`, the `.mission-control-active .light-a/.light-b` rules, and the `.mission-control-dimmed .light-a/.light-b` freeze rule.
- **Remove** the reduced-motion guard for `.light-a`/`.light-b` (lines 301–306) — no animation to guard.
- **Keep:** `.mission-control-dimmed` (opacity 0.35 + grayscale 0.8), `.mission-control-active` (cursor: pointer), the `:only-child` separator suppression (lines 240–243).
- **Update all comments** referencing UFO, saucer, beam, stars, blinking lights (lines 226–253, 271–273, 281–282, 297–300). Line 237 mentions "a lone dimmed UFO" — update to "jet".

### `src/test/shell-terminal-strip.test.js` — Mission Control tests (lines 728–761)

**Context:** Tests assert the inlined SVG structure. Several assertions check UFO-specific elements that will no longer exist.

**Logic:** Remove UFO-specific assertions; keep structural assertions that still hold.

**Implementation:**
- **Line 728:** update section header from `(UFO)` to `(jet)`.
- **Lines 755–757:** remove `sb-mc-beam` assertions. Keep the `sb-mc-cyan-glow` assertion (glow filter is retained). The combined assertion becomes `assert.ok(/sb-mc-cyan-glow/.test(fn), ...)` and `assert.ok(/url\(#sb-mc-cyan-glow\)/.test(fn), ...)`.
- **Lines 760–761:** remove `.light-a`/`.light-b` class-name assertions (no blinking lights — static icon).
- **Lines 740–744:** update the explanatory comment — the SVG is still inlined (for the self-contained glow filter and consistency with the existing pattern), but the reason is no longer `.light-a`/`.light-b` selector access.
- **Lines 750–751:** the negative assertion `!/mission-control-ufo\.svg/.test(fn)` still passes (the jet SVG doesn't reference that file), but the comment ("the file is deleted") is stale — update the comment to reflect that the icon is a jet, not a UFO file reference.
- **Keep:** all other assertions (inline `<svg>`, `aria-hidden`, `class="strip-mc-icon"`, no `<img>`, no file reference, click behavior, ensure/idempotency).

## Out of Scope

- **Terminals panel dispatch curtain** (`terminals.js` `getUfoIconUri()`, `terminals.html` `.is-ufo` CSS, `icons/switchboard-ufo*.svg` files): a separate UFO icon used as an `<img>` in the terminal curtain overlay. Confirmed via grep — these are in `terminals.js` (lines 2502–2662) and `dispatch-curtain-and-ufo-contract.test.js`, not touched by this plan. If the user wants it changed to a jet too, that's a follow-up plan.

## Verification Plan

### Automated Tests

1. Run `npm test` — `shell-terminal-strip.test.js` must pass with updated assertions.
2. Run `npm run compile` — webpack build must succeed (no syntax errors in shell.js/shell.html).
3. Visual check: install the VSIX, open the shell, confirm the Mission Control rail icon shows a pixel jet (nose up, cyan with glow), dimmed when inactive, full cyan when active. No blinking animation. Verify the glow is not overpowering the pixel detail — if it is, reduce `stdDeviation`.

### Goal Invariants

- Assert `shell.js` `createMissionControlIcon()` contains `class="strip-mc-icon"` and `viewBox="0 0 56 54"`.
- Assert `shell.js` `createMissionControlIcon()` does NOT contain `sb-mc-beam` or `class="light-a"` or `class="light-b"`.
- Assert `shell.html` does NOT contain `@keyframes sb-mc-light-a` or `@keyframes sb-mc-light-b`.
- Assert `shell.html` `.strip-mc-icon` rule has `height: 27px` (not `16px`).
- Assert `shell-terminal-strip.test.js` does NOT assert `sb-mc-beam` or `class="light-a"`.

## Completion Summary

The dedicated Mission Control rail icon (UFO button, blinking light animations, beam, and relay) was superseded and removed during the cockpit rail restructure in commit 8a77aa1f, which established the new tabbed agent dock and team slot model. Contract tests in `shell-terminal-strip.test.js` already explicitly enforce the complete removal of `createMissionControlIcon`, `ensureMissionControlIcon`, and associated CSS. All remaining orphaned comment remnants in `src/webview/shell.js` were cleaned up. No active UFO rail icon or dead animation code remains in the codebase.

## Review Findings

Confirmed as a no-op and correctly so: commit `8a77aa1f`'s rail restructure had already removed `createMissionControlIcon`, `ensureMissionControlIcon`, the `sb-mc-beam` gradient, the `.light-a`/`.light-b` rects and their `@keyframes`, and `shell-terminal-strip.test.js` now asserts their *absence* rather than their structure; the commit under review cleaned the one orphaned comment left in `src/webview/shell.js`. No file changed for this subtask. Verification: `npm run test:contract:shell-terminal-strip` (66 passed, 0 failed) and `npm run icons:parity` (pass). The plan's Goal Invariants (`viewBox="0 0 56 54"`, `.strip-mc-icon { height: 27px }`, no `@keyframes sb-mc-light-a`) are only half-checkable — the negative ones hold, the positive ones describe an element that no longer exists on any surface. Remaining risk: the shell rail now has no Mission Control affordance at all, which is a live gap for the sibling dock plan rather than for this one.

## Deferred Findings

- MAJOR — the plan's positive Goal Invariants (`viewBox="0 0 56 54"`, `.strip-mc-icon` at `height: 27px`) cannot be satisfied because the Mission Control rail icon was deleted by `8a77aa1f`; the jet now lives only as the team-button fallback and the teams-tab portrait. `src/webview/shell.js:296`
- NIT — the terminals-panel dispatch-curtain UFO (`terminals.js` `getUfoIconUri()`, `icons/switchboard-ufo*.svg`) is untouched and still a saucer; the plan scoped it out, so the two surfaces now disagree on the brand mark. `src/webview/terminals.js`
