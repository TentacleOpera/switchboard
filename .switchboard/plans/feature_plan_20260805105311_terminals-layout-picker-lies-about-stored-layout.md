# Terminals Panel: The Layout Picker Lies — It Shows "1" While Rendering the Stored Layout

## Goal

Make the layout picker's highlighted button always reflect the layout actually in effect, so opening the Terminals panel (and opening a terminal into an empty panel) produces the grid the picker claims.

### Problem Analysis & Root Cause

The reported symptom is that opening a terminal from the sidebar when no terminals exist produces a 2×2 grid while the picker shows `1` selected. The user's own diagnosis is correct: **the picker is lying, and the stored layout is what actually renders.**

The picker's initial highlight is hardcoded in markup (`src/webview/terminals.html:1096` — the `data-layout="1"` button inside `.layout-picker`):

```html
<button type="button" class="btn-layout active" data-layout="1">1</button>
```

At boot, `init()` calls `loadLayoutSettings()`, which restores the persisted layout into JS state:

```js
async function loadLayoutSettings() {
    const savedMode = await loadSetting('terminals.layoutMode', '1');
    …
    if (LAYOUT_MODES.includes(savedMode)) {
        currentLayout = savedMode;
    }
    effectiveLayout = currentLayout;
    …
}
```

`loadLayoutSettings` **never touches the DOM's active class.** The only function that does is `setLayoutMode` (`terminals.js`):

```js
document.querySelectorAll('.layout-picker .btn-layout').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-layout') === mode);
});
```

and `setLayoutMode` has exactly one caller — the picker's own click handler. So the class is only ever corrected by a *user click*. On every fresh load:

- `currentLayout` / `effectiveLayout` = the persisted value (e.g. `'2x2'`)
- `renderPaneGrid()` renders from `effectiveLayout` → a 2×2 grid
- the picker still shows `1` highlighted, because nothing moved the class

There is **no** code path that bumps the layout when a terminal is created — the grep for `setLayoutMode(` finds only the click handler and the definition. So the "opens in a 2×2 grid even though 1 is selected" report is not an over-eager auto-layout: it is the persisted 2×2 rendering correctly against a picker that never updated.

A second, smaller lie compounds it. The pane-size floor can demote what is rendered without changing what the user picked: `applyLayoutFloor` sets `effectiveLayout` below `currentLayout` and shows a banner (`fallbackBannerEl.classList.toggle('visible', effectiveLayout !== currentLayout)`). The picker should keep showing `currentLayout` (the user's pick, which the banner explains is temporarily floored) — so the sync must key on `currentLayout`, not `effectiveLayout`, or a narrow window would make the picker jump around on resize.

**Root cause:** the picker's active state is DOM-only, initialised by a hardcoded class in the HTML and mutated only by `setLayoutMode`. The restore path writes JS state and renders the grid but was never given the one-line DOM sync, so the control's appearance and the panel's behaviour diverge from the first frame.

> Note: `src/webview/terminals.js` is under active concurrent edit (it has recently gained `paneModes` / `kanbanPaneColumn` state). Anchor the changes below on the named functions, not on line numbers.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard
- **Files touched:** `src/webview/terminals.js`, `src/webview/terminals.html`
- **Risk:** Low — a DOM-sync addition. The risk is choosing the wrong source of truth (`effectiveLayout` instead of `currentLayout`), which would make the picker flicker on resize.

## User Review Required

None. Restoring the picker to match `currentLayout` is the only reading consistent with both halves of the report.

## Complexity Audit

### Routine
- Extract the active-class toggle from `setLayoutMode` into a named `syncLayoutPickerUI()`.
- Call it after `loadLayoutSettings()` resolves, before the first render.

### Complex / Risky
- **Source of truth must be `currentLayout`, not `effectiveLayout`.** The floor deliberately diverges the two, and the divergence is communicated by the fallback banner. Highlighting `effectiveLayout` would make the picker change under the user on every window resize and would contradict the banner's "requested layout" framing.
- **Solo mode forces layout `1`** in `init()` before `loadLayoutSettings()` is reached (it takes the other branch entirely and never calls it). The toolbar is hidden via `body.is-solo`, so a sync there is harmless but pointless — do not introduce a code path that writes `terminals.layoutMode` from solo mode.
- **The hardcoded `active` class must stay** as the pre-JS default: `loadLayoutSettings` is async (it awaits `POST /kanban/verb/getSetting`), so between first paint and the settings response *something* has to be highlighted. Removing the markup class would leave the picker briefly blank; the fix is to correct it once the real value is known, not to delete the default.
- **Failure path.** `loadSetting` swallows all errors and returns the default (`'1'`). If the settings fetch fails, the picker should show `1` — which is also what the grid renders. The sync must run on both success and failure so the two agree either way.

## Edge-Case & Dependency Audit

1. **Persisted layout is `1`.** Sync is a no-op; the markup default was already right. No visual change.
2. **Persisted layout is anything else.** Picker highlight moves to it before the first `renderPaneGrid`, so the user never sees the wrong button highlighted.
3. **Persisted value is invalid/absent.** `LAYOUT_MODES.includes(savedMode)` rejects it and `currentLayout` stays `'1'`; sync highlights `1`. Correct.
4. **Floor trips at boot.** `fetchTerminalList` calls `applyLayoutFloor()` on first paint ("*First paint is also the first chance to measure the grid*"). That sets `effectiveLayout` below `currentLayout` and shows the banner. The picker must keep showing `currentLayout` — the whole point of the banner. Verify by opening the panel narrow with `3x3` stored.
5. **Solo mode / pop-out.** `body.is-solo` hides the toolbar; `init()` short-circuits before `loadLayoutSettings`. No sync required and no settings write allowed (`saveSetting` already early-returns when `soloTerminalName` is set).
6. **Opening a terminal into an empty panel.** With the sync in place, the grid and the picker agree; the layout is whatever the user last chose. If the user genuinely wants `1`, they click `1` and it persists — which currently appears not to stick only because the highlight never showed their stored choice in the first place.
7. **`#btn-clear-all` no longer wears `.btn-layout`** but the selectors are still deliberately scoped to `.layout-picker .btn-layout` (per the comment on the click-handler binding). The new helper must use the same scoped selector so a future toolbar addition cannot be caught by it.
8. **No new persistence.** The sync is read-only with respect to settings; it must not call `saveLayoutSettings()` (that would write on every load and defeat the "last user choice" semantics).

## Dependencies

- None — no session dependencies. Sibling-plan relationship only: "2h/2v Labels Are Inverted" rewrites the same `.layout-picker` button block this plan annotates with a comment. The two are compatible (this plan's comment sits on the `data-layout="1"` button, which stays first in both orderings) but share lines, so land the labels plan first and apply this one on top — see the feature file's Dependencies & sequencing.

## Adversarial Synthesis

Key risks: keying the sync on `effectiveLayout` instead of `currentLayout`, which would make the picker jump on every floor-driven resize and contradict the fallback banner (mitigated by the explicit rule in the helper's docblock and a floored-layout UAT); removing the hardcoded `active` default and leaving the picker blank during the async settings fetch (mitigated by keeping the markup class and documenting why); and a merge collision with the sibling labels plan on the picker block (mitigated by the recorded landing order). The change is one extracted helper and two call sites — no persistence, no schema, no API surface.

## Proposed Changes

### `src/webview/terminals.js`

**1. Extract the DOM sync** from `setLayoutMode` into a standalone helper:

```js
/**
 * Point the layout picker's highlight at the layout the USER picked.
 *
 * Keys on currentLayout, never effectiveLayout: applyLayoutFloor deliberately
 * demotes effectiveLayout when the window is too small and explains it with the
 * fallback banner. Highlighting the floored value would make the picker jump on
 * every resize and contradict the banner.
 *
 * Scoped to .layout-picker for the same reason the click binding is: an
 * unscoped .btn-layout query used to catch #btn-clear-all.
 */
function syncLayoutPickerUI() {
    document.querySelectorAll('.layout-picker .btn-layout').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-layout') === currentLayout);
    });
}
```

**2. `setLayoutMode`** — call the helper instead of inlining the toggle:

```js
function setLayoutMode(mode) {
    if (!LAYOUT_MODES.includes(mode)) return;
    currentLayout = mode;
    effectiveLayout = mode;
    syncLayoutPickerUI();
    sanitizePaneAssignments();
    renderPaneGrid();
    applyLayoutFloor();
}
```

**3. `init()`** — sync once the persisted value is known, before the first list fetch renders anything:

```js
} else {
    // Labels before the first paint, so rows do not visibly gain their CLI
    // name a beat after appearing.
    Promise.all([loadLayoutSettings(), fetchAgentNames()]).then(() => {
        // The picker's `active` class is hardcoded on the "1" button in the HTML
        // as the pre-JS default (loadLayoutSettings is an async verb call). Nothing
        // else moved it: only setLayoutMode does, and only a user click calls that.
        // Without this the picker showed "1" while the grid rendered the stored
        // layout — the control and the panel disagreed from the first frame.
        syncLayoutPickerUI();
        fetchTerminalList();
    });
}
```

`loadSetting` swallows its own errors and returns the default, so this runs on both the success and failure paths and the picker always agrees with `currentLayout`.

### `src/webview/terminals.html`

Record why the markup class exists, so it is not "cleaned up" later (at the `data-layout="1"` button):

```html
<!-- `active` here is the PRE-JS default only: loadLayoutSettings() is an async
     verb call, so something must be highlighted on the first frame. terminals.js
     calls syncLayoutPickerUI() once the persisted layout resolves. Do not remove
     this class, and do not add `active` to any other button. -->
<button type="button" class="btn-layout active" data-layout="1">1</button>
```

## Verification Plan

> Session directive: no compilation step and no automated test runs as part of this verification. Static review plus manual UAT only.

1. **Static review:** the active-class toggle appears in exactly one place (`syncLayoutPickerUI`); `syncLayoutPickerUI` is called from `setLayoutMode` and from `init()`'s post-load continuation and nowhere else; the helper keys on `currentLayout` (never `effectiveLayout`); the hardcoded `active` class remains on the `data-layout="1"` button in the HTML with its explanatory comment. `src/webview/terminals.js` is under concurrent edit, so re-read the actual functions when applying, not the plan's line numbers.
2. **UAT — the reported symptom.** Select `2x2`, close the Terminals panel, reopen it with **no terminals running**. The picker must highlight `2x2`, and the grid must be 2×2 — they agree. Now open a terminal from the sidebar: it lands in the 2×2 grid the picker shows.
3. **UAT — "1" actually sticks.** Click `1`, reload the panel: the picker highlights `1` and a single pane renders. Open a terminal: it fills that one pane, no 2×2.
4. **UAT — every layout round-trips.** For each of `1`, `2h`, `2v`, `2x2`, `2x3`, `3x3`: select it, reload, and confirm the highlight and the grid both match.
5. **UAT — floored layout.** Store `3x3`, then narrow the window until the fallback banner appears. The picker must still highlight `3x3` (the request), the grid shows the floored layout, and the banner explains it. Widen again: the grid returns to 3×3 with no highlight flicker during the resize.
6. **UAT — settings failure.** Stop the API server (so `getSetting` fails) and open the panel: the picker highlights `1`, the grid renders one pane, and there is no mismatch or console error.
7. **UAT — solo pop-out.** Pop a terminal out (`?solo=`): the toolbar stays hidden, the single pane renders, and `terminals.layoutMode` is unchanged in settings afterwards (confirming solo wrote nothing).
8. **Static check:** the active-class toggle appears in exactly one place (`syncLayoutPickerUI`), and `syncLayoutPickerUI` is called from `setLayoutMode` and from `init()`'s post-load continuation — nowhere else.

## Completion Report

Implemented the picker sync in `src/webview/terminals.js` by extracting the active-class toggle into `syncLayoutPickerUI()` keyed on `currentLayout`, replacing the inline toggle in `setLayoutMode()`, and calling `syncLayoutPickerUI()` after `loadLayoutSettings()` resolves in the non-solo `init()` branch. Added the pre-JS default `active` comment to the `data-layout="1"` button in `src/webview/terminals.html`. The hardcoded markup default is preserved so the picker does not blank on first paint. `node --check src/webview/terminals.js` passed, and the helper is referenced from exactly the two intended call sites.
