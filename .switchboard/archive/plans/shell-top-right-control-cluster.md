# A Top-Right Control Cluster For The Shell's Non-Navigational Controls

## Goal

Add a floating control cluster at the top-right of the shell, above the panel frames,
holding the four controls that are not left-rail navigation: the Agent Dock toggle,
Setup, Memo, and Connections. The dock toggle in particular stops living on the opposite
side of the screen from the thing it opens.

### The problem, and the root cause

The shell has exactly three flex children — `#strip` (48px rail), `#content`, and
`#agent-dock` (`src/webview/shell.html:604-616`). There is no top-level chrome region at
all, so every control the shell owns has had one available home: the left rail. That is
why the Agent Dock toggle is there. `buildDockToggle` (`shell.js:657`) even carries a
comment explaining that its glyph had to differ from Terminals' because two identical
icons with different actions is an unresolvable affordance — a symptom of a control
being parked somewhere it does not belong rather than an icon problem.

The rail is a navigational surface: pick a destination, it becomes the active panel.
The dock toggle is not that — it opens a second surface *beside* the current panel and
leaves the active panel alone. Setup, Memo and Connections are also not really
destinations in the same sense: Memo is already `presentation: 'modal'`
(`headlessPanelHtml.ts:565`), i.e. an overlay over whatever you were doing, and Setup and
Connections are configuration you visit and leave. Four controls with an affordance the
rail cannot express.

## Metadata
- **Complexity:** 6
- **Tags:** frontend, ui, ux, feature
- **Feature:** 4c1323fb-a025-467f-b289-88f50b1f8347

## User Review Required

No user review required — plan is in PLAN REVIEWED status and ready for dispatch.

## Complexity Audit

### Routine
- Creating `<div id="top-right-cluster">` in `shell.html` with `position: fixed; top: 6px; right: 6px; z-index: 40`.
- Moving `buildDockToggle`'s button creation into the cluster (verbatim, including `aria-expanded` and `.dock-toggle-btn` class).
- Adding Setup, Memo, and Connections buttons using `buildMaskedGlyph` and `.strip-icon` sizing.
- Registering Setup and Connections in the `icons` map for `.is-active` painting.
- Writing `--dock-width` CSS variable on `:root` from `setDockOpen` and the splitter drag handler.

### Complex / Risky
- The tab-band assumption — every panel's top ~34px of right edge must be tab-strip whitespace, not controls. This is the one assumption the whole placement rests on, and a future panel without a tab bar breaks it. Verification pins this per panel.
- Tooltip positioning for right-edge buttons — the existing helper assumes a rail on the left edge. Must add a `position: 'left'` mode or inline the positioning for cluster buttons, or long tooltip text overflows the viewport.
- `--dock-width` tracking — both `setDockOpen` (`shell.js:747`) and the splitter drag handler must write the variable. The splitter drag runs continuously, so this is one extra property write in an existing handler, but missing either write site leaves the cluster overlapping the dock.

## Edge-Case & Dependency Audit

**Race Conditions:**
- None. The cluster is static chrome; the dock toggle's `aria-expanded` state is set synchronously in `setDockOpen`.

**Security:**
- No new attack surface. The cluster is in the shell document and cannot be pushed around by panel iframes.

**Side Effects:**
- `popoutWindows` (`shell.js:672`) opens panels in bare browser windows with no shell — those get no cluster (correct, they also have no rail).
- The cluster must repaint on `switchboardThemeChanged` — it is in the shell document so it follows `body.className` automatically, but verify under both themes.

**Dependencies & Conflicts:**
- Depends on the rail restructure plan for the dock toggle's removal from the left rail. The rail restructure deletes `buildDockToggle()`; this plan moves the button into the cluster. If this plan lands first, the dock toggle exists in both places temporarily — acceptable but confusing.
- The `.dock-toggle-btn` class name is preserved verbatim because `setDockOpen` and `updateDockViableGating` (`shell.js:939`) both query it. Do not rename.

## Dependencies

- **Rail restructure** — must have deleted `buildDockToggle()` from the rail. This plan reuses the button's creation logic in the cluster; the rail deletion and the cluster addition can land in either order, but both must land before the feature ships.

## Adversarial Synthesis

Key risks: (1) the tab-band assumption is a documentation guard, not a structural one — a future panel without a tab bar ships a dead control under the cluster. (2) Tooltip overflow for right-edge buttons needs explicit left-anchor positioning logic, not a hand-wave. (3) `--dock-width` must be written by both `setDockOpen` and the splitter drag. Mitigations: (1) add a comment in `shell.html` naming the reserved band, verify per panel; (2) specify the positioning mode change; (3) plan names both write sites.

## No migration

Clean break. `sb.agentDock` localStorage state (`shell.js:DOCK_STATE_KEY`) is reused
unchanged — the toggle moves, its persistence does not. No other persisted state. Do not
add compat shims; CLAUDE.md's migration rule is waived for this release.

## Design decision: floating overlay, not a top bar

A 32px top bar spanning `#content` would be collision-free but taxes every panel's
vertical space permanently, including the board — the surface the operator stares at.
The cluster is instead absolutely positioned over `#content`'s top-right corner.

**This is safe because every panel's own content starts below a tab bar.** The panels
that carry right-aligned toolbars — `terminals.html:2470` (`.toolbar-actions`),
`planning.html:339`, `tickets.html:374`, `design.html:353`,
`mission-control.html:152` — all sit *below* a `shared-tabs.css` tab row
(`padding: 8px 16px 0`, `:5`), so the top ~34px of every panel's right edge is tab-strip
whitespace, not controls. The cluster occupies that band.

Verification below pins this per panel rather than trusting it, because it is the one
assumption the whole placement rests on, and a future panel without a tab bar breaks it.

## Implementation

1. **New region in `shell.html`.** A `<div id="top-right-cluster">` as a child of
   `body`, `position: fixed; top: 6px; right: 6px; z-index: 40`. Fixed, not absolute:
   no ancestor here establishes a containing block, and this is the same idiom
   `#tooltip-overlay` and `#dock-role-menu` already use (`shell.html:534`). `z-index`
   below the modal host so a Memo overlay covers it.
2. **Right offset tracks the dock.** When the dock is open the cluster must sit left of
   it, not over it: `right: calc(var(--dock-width, 0px) + 6px)`, with `setDockOpen`
   (`shell.js:747`) and the splitter drag both writing `--dock-width` on `:root`. The
   splitter drag already runs continuously, so this is one extra property write in an
   existing handler.
3. **Four buttons**, reusing `.strip-icon` sizing and `buildMaskedGlyph`
   (`shell.js:221`) so the glyphs stay single-colour and theme-following:
   - Agent Dock — moved verbatim from `buildDockToggle`, including `aria-expanded` and
     the `.dock-toggle-btn` class that `setDockOpen` and `updateDockViableGating`
     (`shell.js:939`) both query. Keep the class name; those two call sites are the
     reason it exists.
   - Setup — `selectPanel('setup')`.
   - Memo — `toggleModal('memo')`; it stays `presentation: 'modal'`.
   - Connections — `selectPanel('connections')`.
4. **Active state.** Setup and Connections are panels, so they must show selection the
   same way rail icons do (`.is-active`, `shell.html:100`) — `selectPanel` paints from
   the `icons` map, so these buttons must be registered in it. Memo and the dock toggle
   are toggles and use `aria-expanded` plus their own pressed styling instead.
5. **Tooltips.** `data-tooltip`, never `title` — `shell.js` is asserted free of native
   title tooltips (`shell-terminal-strip.test.js:395`) and a native one double-fires
   beside the styled overlay. The overlay positions to the left for these buttons; the
   existing helper assumes a rail on the left edge and will paint off-screen otherwise.
6. **Narrow-viewport behaviour.** `DOCK_VIABLE_MIN` (980px, `shell.js:56`) already
   disables the dock below the viewport that fits rail + dock + board floor. The cluster
   respects the same gate for the dock button; the other three stay live.

## Edge cases

- **Panels are iframes.** The cluster is in the shell document and cannot be pushed
  around by any panel's CSS. If a panel ever renders a control in the top-right band it
  will sit *under* the cluster and be unclickable. Add a comment in `shell.html` naming
  the reserved band so the next panel author knows.
- **Pop-out windows.** `popoutWindows` (`shell.js:672`) opens panels in bare browser
  windows with no shell. Those get no cluster — correct, they also have no rail.
- **Dock closed, cluster overlapping the dock splitter.** `#dock-splitter` is 4px and
  only `display: block` when open; with the `--dock-width` offset the cluster clears it.
- **Focus order.** The cluster is late in DOM order but visually top-right. Tab order
  after the rail and before panel content is the least surprising; do not tabindex-hack
  it into the middle.
- **Reduced motion / theme.** The cluster must repaint on `switchboardThemeChanged`
  like the rail does. It is in the shell document so it follows `body.className`
  automatically — verify under both `theme-claudify` and `cyber-theme-enabled`.

## Verification plan

1. `npm run compile` clean.
2. **The tab-band assumption, panel by panel.** Open each of Kanban, Mission Control,
   Agent Control, Terminals, Linear, Project, Artifacts, Tickets, Design at 1280px and
   at 1920px and confirm no panel control sits under the cluster. Terminals is the
   tightest case (`.toolbar-actions` — KANBAN / NEW WINDOW); confirm both buttons are
   fully clickable.
3. Open the dock; confirm the cluster shifts left and never sits over `#agent-dock`.
   Drag the splitter across its full range and confirm it tracks continuously.
4. Toggle the dock from the cluster; confirm `sb.agentDock.open` persists across reload
   and the dock reopens at its saved width.
5. Resize below 980px; confirm the dock button gates off and the other three still work.
6. Open Memo from the cluster; confirm the modal covers the cluster and Escape returns
   focus correctly (`modalReturnFocus`, `shell.js:41`).
7. Both hosts — extension VSIX and standalone `npx`.

### Goal Invariants

- Assert `#top-right-cluster` exists in `src/webview/shell.html` as a child of `body` with `position: fixed`.
- Assert `#top-right-cluster` contains exactly four buttons: Agent Dock, Setup, Memo, Connections.
- Assert `buildDockToggle` is absent from `src/webview/shell.js` (moved to the cluster, not duplicated).
- Assert `.dock-toggle-btn` class is present on the cluster's dock button (queried by `setDockOpen` and `updateDockViableGating`).
- Assert `--dock-width` CSS variable is written by both `setDockOpen` and the splitter drag handler in `src/webview/shell.js`.
- Assert `#top-right-cluster` is absent from any pop-out window (pop-out windows have no shell chrome).
- Assert no panel control in the top-right band is occluded by the cluster at 1280px or 1920px width.

## Implementation Summary

Added a floating fixed control cluster `#top-right-cluster` at the top right of the shell containing the Agent Dock toggle, Setup, Memo, and Connections controls. The right offset tracks the `--dock-width` CSS custom property, updated dynamically on dock toggle, resize, and splitter drag. Setup and Connections are registered in the `icons` map for active state highlights, while tooltips on cluster buttons flip to the left to avoid viewport overflow. Memo overlays elevate stacking context to cover the cluster cleanly when active.


## Review Findings

Reviewed against commit 8a77aa1f. `#top-right-cluster` is a body-level `position: fixed` region at `top: 6px; right: calc(var(--dock-width, 0px) + 6px)` with `z-index: 40`; `--dock-width` is written by `setDockOpen`, the resize handler and the splitter drag's `onMove`, so the offset tracks continuously. `.dock-toggle-btn` is preserved verbatim for `setDockOpen` and `updateDockViableGating`, Setup and Connections are registered in the `icons` map for `.is-active`, tooltips use `data-tooltip` with a real left-anchor branch for cluster buttons (`showStripTooltip`, `el.closest('#top-right-cluster')`), and only the dock button gates off below `DOCK_VIABLE_MIN`. One MAJOR defect fixed: the cluster fabricated an enabled button for any panel missing from the manifest, so a host that disabled Setup would render a control that selects a frame that was never built. Files changed: `src/webview/shell.js`. Validation: `test:contract:shell-terminal-strip` 66/66, typecheck clean.

## Deferred Findings

- NIT `src/webview/shell.html:44` — the reserved-band assumption is documented in a comment as the plan required, but nothing enforces it; a future panel with a top-right control will sit under the cluster and be unclickable with every gate green.
- NIT `src/webview/shell.js` — cluster buttons are appended after the rail in DOM order, which gives the intended tab order, but no test pins it.
