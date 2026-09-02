# The Agent Dock Opens Below The Top-Right Cluster Instead Of Displacing It

## Goal

Stop the top-right control cluster (Agent Dock, Setup, Memo, Connections) from moving when the agent dock opens. The cluster stays anchored to the shell's right edge at all times; the dock opens **below** it, reserving the cluster's band rather than sharing a row with it.

### Problem Analysis & Root Cause

**The cluster's horizontal position is wired to the dock's width.** `src/webview/shell.html:183`:

```css
#top-right-cluster {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 6px);
    right: calc(var(--dock-width, 0px) + env(safe-area-inset-right, 0px) + 6px);
    z-index: 40;
}
```

`--dock-width` is written to `documentElement` by `shell.js` at four points (`506`, `510`, `674`, `699`) — on open, on close, and continuously while the splitter is dragged. So every pixel of dock width, including mid-drag, displaces the cluster horizontally. The controls the user is reaching for slide out from under the cursor while the dock is being resized.

**Why it was built this way.** `#agent-dock` (`shell.html:315`) is a flex child of the shell row, beside `#content`:

```css
#agent-dock { flex: 0 0 auto; width: 648px; min-width: 648px; ... }
```

Being a full-height column pinned to the right, it occupies the exact corner the fixed-position cluster sits in. Rather than reserving vertical space for the cluster, the layout slides the cluster sideways to keep clear of it. That is the decision being reversed: the cluster is a fixed overlay on the shell's right edge and should not be a function of the dock at all.

**This is test-locked — treat it as a design reversal, not a forgotten case.** `src/test/shell-terminal-strip.test.js:1120`:

```js
assert.ok(/#top-right-cluster\s*\{[^}]*calc\(var\(--dock-width,\s*0px\)\s*\+\s*6px\)/.test(shellHtml),
    '#top-right-cluster right offset must track --dock-width');
```

The coupling is asserted by a contract test. Any fix turns that test red, and the test must be rewritten to assert the new invariant rather than deleted.

**`--dock-width` has exactly one reader.** A grep across `src/` for non-writer references returns only `shell.html:186` and the two test assertions. So the variable exists solely to push the cluster. Once decoupled it is dead, apart from `shell-terminal-strip.test.js:1131` asserting that it is written at all.

**The reserved band is documented at the wrong size.** The comment at `shell.html:177` says:

> *Reserved band: the top ~34px of every panel's right edge is tab-strip whitespace.*

The cluster's buttons are `.strip-icon` at **36×36** (`shell.html:79`), offset `6px` from the top. The band is at least **42px**, not 34. Anything that reserves space using the documented figure will be 8px short and the cluster will clip the dock's header — `#dock-header` is `flex: 0 0 32px` (`shell.html:334`), so it fits entirely inside the miscalculated band.

**The collision the fix must handle.** Once the cluster stops moving, it overlays the dock's top-right corner. The dock's header — title, chips, start button, icon buttons — would sit underneath it. Decoupling the cluster without reserving the band trades a moving-controls bug for an occluded-header bug.

**The dock header's right edge carries the close button.** `#dock-header` (`shell.html:491`) is a flex row: `#dock-tabs` (Agent/Kanban), `#dock-title` (`flex: 1 1 auto`), then `#dock-close` (`.dock-icon-btn`, `shell.html:497`) pushed to the right edge. The cluster is ~156px wide (4 buttons × 36px + 3 × 4px gap) and 36px tall, sitting 6px from the top-right. If the reserved band is undersized, the cluster clips `#dock-close`. The band must clear the cluster's full 42px height (6 + 36) so the 32px dock header starts strictly below it.

**The splitter is a separate flex sibling with the same top.** `#dock-splitter` (`shell.html:326`, `flex: 0 0 4px`) sits between `#content` and `#agent-dock` in the body's row flex container. With the default `align-items: stretch`, it runs the full height from the content-box top — the same origin as the dock. Any top offset applied to the dock MUST be applied to the splitter too, or the 4px drag handle rises 46px above the dock behind the cluster's `z-index: 40`, leaving its top ungrabbable and producing a visible 4px×46px notch.

**Safe-area composition rule.** The cluster is `position: fixed`, so its `top` already includes `env(safe-area-inset-top)` (`shell.html:185`). The dock and splitter are in normal flow inside `body`, which already applies `padding-top: env(safe-area-inset-top)` (`shell.html:61`). Therefore `--cluster-band` must be the **6px + 36px + gap only** — it must NOT include the safe-area inset. Adding safe-area to the band would double-count it and push the dock 2× too low on notched viewports.

## Metadata
**Topic:** Top-right cluster stays fixed; the agent dock opens beneath it
**Tags:** frontend, ui, bugfix

**Complexity:** 3

## User Review Required

None.

## Complexity Audit

### Routine
- Editing one CSS declaration (`#top-right-cluster` `right`) to a constant offset.
- Defining one custom property (`--cluster-band`) and consuming it in two rules.
- Removing four `--dock-width` writer lines in `shell.js` (`506`, `510`, `674`, `699`).
- Rewriting two assertions in one test file.
- Fixing a stale prose comment.

### Complex / Risky
- None. All changes are localized to `shell.html`, `shell.js`, and `shell-terminal-strip.test.js`; no data, no new patterns, no breaking interface changes.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The `--dock-width` writers fired on every splitter drag tick (`shell.js:674`); removing them removes the only continuous-write path. There is no reader left to race.
- **Security:** None. CSS layout only; no credential, transport, or CSP surface touched.
- **Side Effects:** Removing `--dock-width` deletes a `documentElement` custom property that was previously live-updated mid-drag. Confirmed via grep to have no reader outside the cluster's `right` and the test assertions — no panel, no iframe, no script reads it.
- **Dependencies & Conflicts:** The contract test `shell-terminal-strip.test.js:1116-1132` currently asserts both the coupling (line 1120) and that `--dock-width` is written (line 1130-1131). Both must be rewritten in the same change or the test goes red. No other test or plan depends on this plan.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) the splitter is a separate flex sibling that needs the same `margin-top: var(--cluster-band)` as the dock or its drag handle rises behind the cluster and becomes ungrabbable; (2) `--cluster-band` must exclude `env(safe-area-inset-top)` because the dock is in normal flow inside the already-padded body — including it double-counts on notched viewports; (3) the band must be a literal calc (`calc(6px + 36px + 4px)` = 46px), not prose, so the 32px dock header starts strictly below the 42px cluster. Mitigations: apply the band to both dock and splitter, pin the number, state the safe-area rule in the CSS comment, and rewrite the contract test to assert the negative (no `--dock-width` in the cluster's `right`) paired with the positive (`--cluster-band` consumed by dock and splitter).

## Proposed Changes

**1. Anchor the cluster to the shell's right edge.** `shell.html:186` becomes a constant offset:

```css
right: calc(env(safe-area-inset-right, 0px) + 6px);
```

No `--dock-width`, no dependence on dock state.

**2. Define `--cluster-band` once and consume it for BOTH the dock and the splitter's top offset.** Define the property on `:root` as a literal calc derived from the real geometry — **not** including the safe-area inset (the dock is in normal flow inside the already-padded body, so safe-area is already applied; adding it here double-counts):

```css
:root {
    --cluster-band: calc(6px + 36px + 4px); /* 6px top offset + 36px button + 4px gap = 46px */
}
```

Then apply it to `#agent-dock` and `#dock-splitter` so both start below the cluster. In the body's row flex container (default `align-items: stretch`), `margin-top` is respected on the cross axis and reduces the stretched height, so the dock/splitter top moves down by the band while the bottom stays pinned:

```css
#agent-dock { margin-top: var(--cluster-band); }
#dock-splitter { margin-top: var(--cluster-band); }
```

Both elements are `display: none` when the dock is closed, so the band is only consumed when `.is-open` — no dead space appears at the top of the right edge when there is no dock. Do not write the number twice; the 34-vs-42 discrepancy above is what happens when it is duplicated in prose.

**3. Fix the stale comment** at `shell.html:177-182`. State the band's real size (46px, derived from `--cluster-band`), note that it excludes the safe-area inset (applied by the body padding), and remove the "right offset tracks `--dock-width`" line since the coupling is gone.

**4. Remove `--dock-width` and its writers — do not keep them.** With its only reader gone (line 186), the variable is dead. Remove:
- The four writers in `shell.js`: `506`, `510`, `674`, `699`.
- The test assertion at `shell-terminal-strip.test.js:1130-1131` that asserts `--dock-width` is written to `documentElement`.

Do not leave four writers feeding nothing; "keep and comment" is a tombstone, not engineering.

**5. Rewrite the contract test, do not delete it.** `shell-terminal-strip.test.js:1116-1132` must assert the new invariants:
- **Negative:** `#top-right-cluster`'s `right` declaration contains no `--dock-width` reference (the old coupling is gone).
- **Positive:** `#agent-dock` and `#dock-splitter` both consume `--cluster-band` (e.g. `margin-top: var(--cluster-band)`).
- **Positive:** `--cluster-band` is defined on `:root` as a calc containing `36px` (the button height) so a future button-size change is forced through the variable.
- Remove the assertion that `--dock-width` is written to `documentElement` (line 1130-1131).

A deleted assertion leaves the regression unguarded — this behaviour was deliberate once and could be reintroduced by someone reading the old comment.

**6. Nothing about dock sizing changes.** The 648px minimum and its justification (`shell.html:313` — 80 columns at the worst-case mono advance, below which the agent CLI folds its own diffs) is untouched. This plan moves where the dock starts vertically, not how wide it is.

## Verification Plan

### Automated Tests
- `node src/test/shell-terminal-strip.test.js` — the rewritten assertions pass, AND the rewritten negative assertion fails if the `--dock-width` coupling is put back into `#top-right-cluster`'s `right`.
- *(Compilation and the full automated test suite are skipped this run per session directives; the checks remain written here for the implementing coder.)*

### Goal Invariants
- Assert `#top-right-cluster`'s `right` declaration in `src/webview/shell.html` contains no `--dock-width` token (negative — the coupling is gone).
- Assert `#top-right-cluster`'s `right` declaration in `src/webview/shell.html` contains `env(safe-area-inset-right` (positive — still anchored to the right edge with safe-area).
- Assert `--cluster-band` is defined on `:root` in `src/webview/shell.html` and its value contains `36px`.
- Assert `#agent-dock` in `src/webview/shell.html` has `margin-top: var(--cluster-band)`.
- Assert `#dock-splitter` in `src/webview/shell.html` has `margin-top: var(--cluster-band)`.
- Assert `src/webview/shell.js` contains zero occurrences of `--dock-width` (the writers are removed).
- Assert `src/test/shell-terminal-strip.test.js` contains no assertion that `--dock-width` is written to `documentElement`.

### Manual Checks
1. **The cluster does not move.** Note its on-screen position with the dock closed. Open the dock. It is in the identical position — same pixel, not merely nearby.
2. **Drag the splitter across its full range.** The cluster stays put throughout. This is the worst case: `shell.js:674` previously updated `--dock-width` continuously during the drag; with the writers removed there is no live variable, but any residual coupling would show as the controls sliding under the cursor.
3. **The dock opens below the cluster.** Its header — title, chips, start button, `#dock-close` — is fully visible and clickable with the dock open. Click every control in `#dock-header` to prove none is occluded.
4. **The cluster's own buttons still work with the dock open**, including the dock toggle itself, which sits inside the cluster and closes what is beneath it.
5. **Band size is right.** Measure the gap between the cluster's bottom edge and the dock's top edge in devtools. It matches `--cluster-band` (46px), and no part of the dock is under the cluster.
6. **Safe-area insets.** Check on a viewport with a non-zero `env(safe-area-inset-top/right)` — the offsets compose rather than double-count (the dock starts at safe-area + 46px, not safe-area + safe-area + 46px).
7. **Dock closed** — no reserved band is visible as dead space at the top of the right edge when there is no dock (the dock and splitter are `display: none`, so `margin-top` is not consumed).
8. **Splitter top is grabbable.** With the dock open, the 4px splitter handle starts at `--cluster-band` from the top, not at the content-box top. Confirm the top of the handle is below the cluster and draggable.
9. **Every panel.** Switch through all rail panels with the dock open; the cluster overlays none of their controls, which is what the reserved-band comment exists to guarantee.
10. **Both hosts.** The shell serves the browser cockpit; confirm the VS Code webview path is unaffected, since only the browser shell has this cluster.
