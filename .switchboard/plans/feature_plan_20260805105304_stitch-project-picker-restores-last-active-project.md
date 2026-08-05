# Design Panel: Stitch Project Picker Must Restore the Last Active Project Instead of Opening Empty

## Goal

Make the STITCH tab's project picker open on the last project the user had selected in that workspace (falling back to the most recently updated project), so the tab shows that project's screens from the local cache instead of an empty gallery on every load.

### Problem Analysis & Root Cause

Opening the Design panel's STITCH tab always lands on `Select Project...` with the gallery hidden and the "no project" empty state showing. Three separate defects compose to guarantee that, and all three are in the restore path — not in the write path, which works fine.

**Defect 1 — the webview's restore is commented out and hard-overridden.** Both places that would re-establish the selection for a workspace root explicitly discard it (`src/webview/design.js:3118-3121` and `:3167-3170`):

```js
// Restore project selection for this root — DISABLED per initialization requirements
// const rootState = getRestoredState('stitch.projectId', state.stitchWorkspaceRoot);
// state.selectedStitchProjectId = rootState || '';
state.selectedStitchProjectId = '';
```

**Defect 2 — the provider never ships the key, so un-commenting alone would return `undefined`.** `DesignPanelProvider`'s `ready` handler restores a fixed key list (`DesignPanelProvider.ts:2499`):

```js
const tabKeys = ['stitch', 'html-preview', 'images', 'design', 'html.root',
                 'claude.root', 'design.root', 'stitch.root', 'images.root',
                 'activeTab', 'previews.source'];
```

`'stitch.projectId'` is absent — and `PanelStateStore.getAllStates` iterates only the keys it is handed (`PanelStateStore.ts:27-43`). The webview *writes* `persistTab('stitch.projectId', projectId, root)` in four places (`design.js:2704`, `:2735`, `:3741`, and the Stitch-HTML sibling at `:2389`), so the value is being stored and then never read back. The state is write-only.

**Defect 3 — `populateStitchProjects` refuses to auto-select anything.** `design.js:2750-2752`:

```js
// Only select if there's an explicit in-memory selection
// Do NOT auto-select defaultProjectId or first project
const current = state.selectedStitchProjectId || '';
```

The provider *does* send a `defaultProjectId` (read from the `stitch.defaultProjectId` config, `DesignPanelProvider.ts:3330`) on every `stitchProjectsReady`, and it is accepted as a parameter and then ignored.

**Consequence.** With no in-memory selection (fresh panel load), no restored selection (defects 1 and 2), and no default fallback (defect 3), `state.selectedStitchProjectId` is always `''` at first paint. `switchTab('stitch')` then takes its defensive branch (`design.js:231-241`) and hides the pane, strip and gallery, showing the empty state. The screens are on disk — `stitchGetProjectScreens` reads the cache — but nothing asks for them.

**Root cause:** the selection is persisted per workspace root but the restore path was deliberately disabled at the webview and never wired at the provider, and no fallback default was allowed to fill the gap.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, backend, ui, bugfix
- **Project:** Browser Switchboard
- **Files touched:** `src/webview/design.js`, `src/services/DesignPanelProvider.ts`
- **Risk:** Medium-low — restoring a previously-disabled behaviour. The main hazard is auto-selecting a project id that no longer exists remotely, which must degrade to the empty picker rather than to a stuck spinner.

## User Review Required

None. "Default to the most recent active project if one is available" defines the fallback order: last-selected for this workspace, else the most recently updated project in the list.

## Complexity Audit

### Routine
- Add `'stitch.projectId'` (and `'stitchHtml.projectId'`) to the provider's restored `tabKeys`.
- Re-enable the two commented restore reads in `design.js`.

### Complex / Risky
- **Validating the restored id against the loaded list.** `populateStitchProjects` assigns `stitchProjectSelect.value = current` directly (`design.js:2781-2786`); an id with no matching `<option>` resolves to the empty option, so state and UI silently disagree and the gallery stays hidden with `setStitchBusy(true)` never cleared. Every restored id must be validated against `state.stitchProjects` and dropped if absent.
- **Ordering against the `stitchProjectsReady` round-trip.** The restore lands in `restoredTabState` / `workspaceItemsUpdated`, both of which fire before the project list arrives. The auto-load of screens must therefore be driven from the `stitchProjectsReady` arm (which already has the `else if (state.selectedStitchProjectId)` branch at `design.js:3750-3757` that fetches screens) — not from the restore handler.
- **The "most recent" fallback.** `populateStitchProjects` already sorts by `updateTime` descending (`design.js:2752-2758`), so "most recent" is `sortedProjects[0]`. Selecting it must be a *fallback* only — never an override of a valid restored or in-memory id — and must not fire when the sorted list is empty.
- **Two disabled sites, not one.** `workspaceItemsUpdated` (`:3118`) and `restoredTabState` (`:3167`) both reset the selection; fixing only one leaves whichever message arrives second clobbering the restore.
- **Shipped persisted state.** `stitch.projectId` values were written by released versions, so the restore must tolerate any string (including ids for deleted projects) without throwing. Validation, never trust.

## Edge-Case & Dependency Audit

1. **Restored project deleted on the Stitch side.** `stitchListProjects` prunes DB rows for projects absent from a successful API fetch (`DesignPanelProvider.ts:3358-3367`), so the restored id may not be in the fresh list. Validation drops it, the picker shows `Select Project...`, and no `stitchGetProjectScreens` is issued. Do **not** clear the persisted value on a *failed* fetch — a network blip must not erase the user's selection.
2. **No Stitch API key.** `stitchListProjects` returns early with `stitchApiKeyStatus: configured:false` (`DesignPanelProvider.ts:3325-3328`), so no list arrives and no selection is applied. The tab shows its existing setup banner. Restore must not throw on the absent list.
3. **Cache-then-network double push.** `stitchProjectsReady` can fire twice (DB cache, then API when changed). The selection logic must be idempotent — the second push must not re-fetch screens for an unchanged selection, or the gallery flickers and the Stitch API is hit twice.
4. **Multi-root workspaces.** `stitch.projectId` is stored per root via `persistTab(key, value, root)` → `byRoot`. The restore must read with the root argument, and must be re-evaluated when `#stitch-workspace-filter` changes rather than carrying a foreign-workspace id.
5. **`design-system-project-select` mirrors the same state** (`design.js:2726-2737`). Restoring `selectedStitchProjectId` must also set that dropdown's value or the DESIGN SYSTEM tab's Stitch panel disagrees with the STITCH tab.
6. **`setStitchBusy` / status text.** The existing auto-load branch sets `Loading project screens…` and `setStitchBusy(true)`; `stitchScreensReady` clears both (`design.js:3763-3765`). A restored id that never produces a response would strand the busy state — one more reason to validate before fetching.
7. **First-run users with zero projects.** `sortedProjects` empty → no fallback selection, existing empty state shown. No regression.
8. **`stitch.defaultProjectId` config.** Provider already sends `defaultProjectId`. **Decision: use it as the tier between "restored" and "most recent"** — it is an explicitly configured preference and outranks a recency heuristic.
9. **Interaction with the Stitch-HTML picker.** Adding `'stitchHtml.projectId'` to the restored keys makes that write-only key readable too; wiring its restore is in scope only to the extent of making the value available (the picker's own seeding rules are unchanged here).

## Dependencies

- None

## Adversarial Synthesis

Key risks: auto-selecting a stale project id (deleted on the Stitch side) into a permanently stuck busy spinner; double-fetching screens on the cache→network double push; a failed background fetch erasing the persisted selection. Mitigations: validate every candidate against the loaded list before selecting and fetching, gate the auto-load behind a `_lastScreensFetchProjectId` idempotency guard, and never clear persisted state on a failed fetch. The provider change is in-place and additive (two keys in a restore list) — behaviour-preserving per the project's byte-compatibility contract; no verb contract, schema, or seam surface is touched. Shared surfaces with the sibling seed plan (`stitchProjectsReady` arm, `#stitch-workspace-filter` reset) — merged end-state recorded below; this plan lands first.

## Proposed Changes

### `src/services/DesignPanelProvider.ts`

Add the two project-id keys to the restored set (line 2499):

```ts
// stitch.projectId / stitchHtml.projectId are written by design.js
// (persistTab(..., workspaceRoot)) on every project change. They were absent
// here, which made them write-only: PanelStateStore.getAllStates iterates only
// the keys it is handed, so the webview's restore read returned undefined and
// the picker opened empty on every load.
const tabKeys = ['stitch', 'html-preview', 'images', 'design', 'html.root',
                 'claude.root', 'design.root', 'stitch.root', 'images.root',
                 'activeTab', 'previews.source', 'stitch.projectId',
                 'stitchHtml.projectId'];
```

### `src/webview/design.js`

**1. One validated resolver** (place near `populateStitchProjects`, ~line 2740):

```js
/**
 * Resolve which Stitch project the picker should show for `root`.
 *
 * Tiers, highest first:
 *   1. an explicit in-memory selection the user made this session
 *   2. the persisted per-root selection (stitch.projectId)
 *   3. the configured stitch.defaultProjectId
 *   4. the most recently updated project in the list
 *
 * Every candidate is validated against the loaded list. populateStitchProjects
 * assigns select.value directly, so an id with no matching <option> resolves to
 * the empty option and desyncs state from UI — with setStitchBusy(true) left on
 * if we had fetched screens for it.
 */
function resolveStitchProjectSelection(projects, defaultProjectId) {
    const ids = new Set((projects || []).map(p => p.id));
    const candidates = [
        state.selectedStitchProjectId,
        getRestoredState('stitch.projectId', state.stitchWorkspaceRoot),
        defaultProjectId,
    ];
    for (const c of candidates) {
        if (c && ids.has(c)) { return c; }
    }
    // Fallback: most recent. populateStitchProjects sorts by updateTime desc;
    // mirror that ordering here rather than trusting input order.
    const sorted = [...(projects || [])].sort((a, b) => {
        const ta = a.updateTime ? new Date(a.updateTime).getTime() : 0;
        const tb = b.updateTime ? new Date(b.updateTime).getTime() : 0;
        return tb - ta;
    });
    return sorted.length > 0 ? sorted[0].id : '';
}
```

**2. `populateStitchProjects`** (line 2740-2782) — use the resolver instead of the in-memory-only read:

```js
function populateStitchProjects(projects, defaultProjectId) {
    if (!stitchProjectSelect) return;
    const sortedProjects = [...projects].sort(/* unchanged updateTime desc */);
    const current = resolveStitchProjectSelection(sortedProjects, defaultProjectId);
    …unchanged option-building loop, comparing against `current`…
    stitchProjectSelect.value = current;
    if (designSystemProjectSelect) { designSystemProjectSelect.value = current; }
    state.selectedStitchProjectId = stitchProjectSelect.value;
}
```

**3. Re-enable both restore sites** — replace the commented block and the `= ''` override at `design.js:3118-3121` and `:3167-3170` with:

```js
// Restore the per-root project selection. Validated later by
// resolveStitchProjectSelection against the loaded list, so a stale id for a
// project deleted on the Stitch side degrades to an empty picker rather than a
// selection the dropdown cannot show.
state.selectedStitchProjectId =
    getRestoredState('stitch.projectId', state.stitchWorkspaceRoot) || '';
```

**4. `stitchProjectsReady`** (line 3724-3760) — make the auto-load idempotent so the cache→network double push does not double-fetch:

**Shared surface:** the sibling plan *Stitch HTML Source Must Default to the Project Showing in the Stitch Tab* inserts its seed attempt into this same arm, between `populateStitchProjects` and `populateStitchHtmlProjectSelect`. Apply both sets of edits to the one arm; the merged end-state is: resolver-driven `populateStitchProjects` → sibling's seed attempt → `populateStitchHtmlProjectSelect` → the idempotent auto-fetch below. This plan lands first in the feature's recommended sequence.

```js
populateStitchProjects(state.stitchProjects, msg.defaultProjectId);
populateStitchHtmlProjectSelect(state.stitchProjects);
…
if (msg.selectProjectId) {
    …unchanged create-project path…
} else if (state.selectedStitchProjectId
           && state.selectedStitchProjectId !== _lastScreensFetchProjectId) {
    _lastScreensFetchProjectId = state.selectedStitchProjectId;
    setStitchStatus('Loading project screens…', 'busy');
    setStitchBusy(true);
    vscode.postMessage({
        type: 'stitchGetProjectScreens',
        projectId: state.selectedStitchProjectId,
        workspaceRoot: state.stitchWorkspaceRoot
    });
} else if (!state.selectedStitchProjectId) {
    setStitchStatus('', 'info');
}
```

Declare `let _lastScreensFetchProjectId = '';` alongside the other module-level Stitch state, and reset it to `''` in the `#stitch-workspace-filter` change handler (`design.js:4128-4148`) so a workspace switch re-fetches. **Shared surface:** the sibling seed plan clears `state.selectedStitchHtmlProjectId` in this same handler — additive, apply both.

**5. Persist the resolved selection** so tier 3/4 fallbacks become tier 2 on the next load — add after `state.selectedStitchProjectId` is assigned in `populateStitchProjects`:

```js
if (state.selectedStitchProjectId && state.stitchWorkspaceRoot) {
    persistTab('stitch.projectId', state.selectedStitchProjectId, state.stitchWorkspaceRoot);
}
```

## Verification Plan

### Automated Tests

None run — the dispatch directive excludes compilation and automated tests from this verification. The provider edit is additive (two keys in a restore list); signal comes from the static checks and UAT below.

1. **Static check:** `grep -n "stitch.projectId" src/services/DesignPanelProvider.ts` shows it in `tabKeys`; `grep -n "DISABLED per initialization" src/webview/design.js` returns nothing.
2. **UAT — the reported symptom.** Select a Stitch project, let its screens render, close the Design panel, reopen it. The STITCH tab opens on that project with its screens showing from cache — not on `Select Project...` with an empty gallery.
3. **UAT — most-recent fallback.** Clear the persisted state (fresh workspace), open STITCH with several projects available: the picker selects the most recently updated one and loads its screens.
4. **UAT — no projects.** With an account that has zero projects, the tab shows the existing empty state; no spinner, no error.
5. **UAT — deleted project.** Persist a selection, delete that project on the Stitch side, reopen the panel: the picker falls back (default or most recent) and never sits on a busy spinner.
6. **UAT — offline.** Persist a selection, then block network / stop the Stitch API. The cached DB list still serves the picker and screens load from disk; a failed background refresh must not clear the selection.
7. **UAT — multi-root.** With two workspace roots, select project A in root 1 and project B in root 2. Switch between roots: each restores its own project, and neither offers the other's id.
8. **UAT — DESIGN SYSTEM mirror.** After restore, the DESIGN SYSTEM tab's `STITCH PROJECT:` dropdown shows the same project.
9. **UAT — single fetch.** On panel open, confirm `stitchGetProjectScreens` is issued once for the restored project even though `stitchProjectsReady` may arrive twice (cache then network).

## Review Findings

Reviewed against plan requirements: provider `tabKeys` includes `'stitch.projectId'` and `'stitchHtml.projectId'` (`DesignPanelProvider.ts:2504-2507`); `resolveStitchProjectSelection` implements the 4-tier resolver with validation against the loaded list (`design.js:2801-2819`); `populateStitchProjects` uses the resolver and persists the resolved selection (`design.js:2830,2860-2863`); both restore sites are re-enabled with no "DISABLED" comment (`design.js:3204-3205,3252-3253`); `_lastScreensFetchProjectId` idempotency guard prevents double-fetch on cache→network double push (`design.js:139,3844-3848`); workspace-filter reset clears the guard (`design.js:4237`). Files changed: `src/services/DesignPanelProvider.ts`, `src/webview/design.js`. No findings — implementation matches the plan exactly. Verification: `tsc --noEmit` (no new errors in DesignPanelProvider.ts), `design-view-state-seats-contract.test.js` (11 pass), `push-routing:check`/`parity:check`/`verb-returns:check` all pass. No remaining risks.
