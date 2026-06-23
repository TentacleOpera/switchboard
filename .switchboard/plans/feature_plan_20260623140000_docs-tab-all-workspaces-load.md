# Docs Tab: Load Content at "All Workspaces" (Don't Require Selecting a Specific Workspace)

## Goal

The Docs tab in `planning.html` defaults its workspace dropdown to **"All Workspaces"** (`<option value="">All Workspaces</option>`, `src/webview/planning.html:3363-3365`). The reported symptom is that at startup the docs sidebar shows nothing (or "Loading docs…") under "All Workspaces" and only populates once the user picks a *specific* workspace from the dropdown. Changing the dropdown is what makes content appear; the default empty selection does not.

The desired behaviour is that "All Workspaces" loads and shows the union of all configured workspaces' docs/tickets immediately on open, the same way picking a single workspace shows that workspace's subset.

### Root Cause

There are two distinct issues; the fix must cover both because either one alone reproduces the symptom.

**(1) The "All Workspaces" render path depends on a state value that is reset out from under it, with no re-render guaranteed in the right order.**

- `state.docsWorkspaceRootFilter` defaults to `''` (all workspaces) at `src/webview/planning.js:34`.
- On startup the webview posts `fetchRoots` then `refreshSource:local-folder` (`src/webview/planning.js:8771-8772`). The backend replies with `workspaceItemsUpdated`, `restoredTabState`, `localDocsReady`, and `onlineDocsReady`.
- `restoredTabState` restores a *persisted* docs root into `state.docsWorkspaceRootFilter` (`src/webview/planning.js:3357-3365`). If a stale/previous specific root was persisted, the filter is now non-empty even though the visible dropdown still reads "All Workspaces" (the dropdown only has the static "All Workspaces" option until `workspaceItemsUpdated` repopulates it).
- `handleLocalDocsReady` then *resets* `state.docsWorkspaceRootFilter` back to `''` only **if** the stale root is absent from `msg.workspaceItems` (`src/webview/planning.js:2399-2402`). If the stale root still exists in the workspace list but the user expected "All", state and UI silently disagree.
- The same reset/`populateWorkspaceDropdown` logic is duplicated in `handleOnlineDocsReady` (`src/webview/planning.js:2435-2439`) and in `updateDropdown` for the `docs` tab (`src/webview/planning.js:72-80`), and these run at non-deterministic times relative to each other. The net effect is an ordering window where the first render uses a value that does not match what the dropdown shows, so "All Workspaces" can render an empty/partial tree until a manual `change` event (the only path that unconditionally sets the filter from the dropdown and re-renders — `src/webview/planning.js:985-990`) forces a correct re-render.

**(2) The local-docs filter uses strict equality on `metadata.root`, which is fragile, and is the mechanism by which a "wrong" non-empty filter yields a blank tree.**

- The local render filters nodes with `n.metadata?.root === state.docsWorkspaceRootFilter` (`src/webview/planning.js:2280-2282`). When the filter is `''` it (correctly) keeps all nodes; when it is a non-empty stale/mismatched root it keeps **zero** nodes.
- `metadata.root` is stamped from `f._root` (`src/services/PlanningPanelProvider.ts:5997-6002`), and `_sendLocalDocsReady` tags each file with only the **first** root that scans it because of cross-root dedup via `seenFilePaths` (`src/services/PlanningPanelProvider.ts:6042-6049`). So a folder shared/registered under multiple roots gets its files tagged to one arbitrary root. A strict `===` filter against a different root then shows nothing — and the "loads when I pick a workspace" behaviour the user sees is really "the workspace I happened to pick matches the tag."

Online sources are *not* the cause: `_sendOnlineDocsReady` sends workspace-independent global adapters with empty `nodes` (`src/services/PlanningPanelProvider.ts:6126-6158`), and the webview lazily fetches their containers on every `rerenderUnifiedDocs` whenever `nodes.length === 0` (`src/webview/planning.js:2208-2210`). They render regardless of the workspace filter. The fix therefore targets the local-docs filter + the startup/state-vs-UI synchronization.

## Metadata
**Complexity:** 4
**Tags:** frontend, ux, bug, planning-panel, docs-tab

## Complexity Audit

### Routine
- Making "All Workspaces" the deterministic startup state for the Docs tab and ensuring the dropdown's displayed value always matches `state.docsWorkspaceRootFilter`.
- Guaranteeing a render happens after both `localDocsReady` and `onlineDocsReady` arrive (the handlers already call `rerenderUnifiedDocs`; we only need the filter value to be correct at that point).

### Complex/Risky
- The docs workspace filter value is computed in three places (`updateDropdown` for `docs` at `planning.js:72-80`, `handleLocalDocsReady` at `2399-2402`, `handleOnlineDocsReady` at `2435-2439`) plus restored in the `restoredTabState` handler (`3357-3365`). They must agree. Centralizing into a single helper avoids a future regression but touches several call sites.
- Persistence: the docs root is persisted via `persistTab('docs.root', …)` (`planning.js:988`) and restored on open. We must not break the legitimate case where a user *deliberately* selected a specific workspace and expects it restored next session — only fix the "stale value silently overrides the visible 'All Workspaces'" failure. The safe rule: the restored value wins **only if it still exists in `workspaceItems`**; otherwise fall back to `''`, and always sync the dropdown's `.value` to the resolved filter.

## Edge-Case & Dependency Audit

- **Stale persisted root no longer present** (workspace closed/removed): already handled by the existing `!workspaceItems.some(...)` reset (`planning.js:2399-2401`); keep this.
- **Stale persisted root still present but user expects "All"**: this is the core bug — when restoring, if the dropdown DOM value and `state.docsWorkspaceRootFilter` disagree, the visible "All Workspaces" must win at first paint. Resolution below keeps persisted value but always writes it back to the dropdown so they never disagree.
- **Files tagged to only one root via dedup** (`PlanningPanelProvider.ts:6042-6049`): "All Workspaces" must show them all (it does, via the `''` branch). No backend change required for the all-workspaces fix; documented as a known limitation of the per-workspace subset, not in scope to re-architect dedup.
- **Online sources** (ClickUp/Linear/Notion): unaffected; they fetch containers on every render irrespective of workspace filter (`planning.js:2208-2210`).
- **Antigravity sessions**: rendered from `_lastLocalDocsMsg` independent of the workspace filter (`planning.js:2262-2263`); unaffected.
- **Multiple `rerenderUnifiedDocs` calls**: idempotent (it rebuilds `treePane.innerHTML` each time, `planning.js:1876`), so extra renders are safe.
- **Migration concern**: `docs.root` has shipped (it is persisted/restored today). Do **not** drop or rename the key. Preserve persisted specific-root selections; only correct the display/filter desync. No data migration needed.
- **No confirmation dialogs** anywhere (project rule) — N/A here, but noted.
- **Build dependency**: webview changes require `npm run compile` (webpack) before they take effect from `dist/`.

## Proposed Changes

### File: `src/webview/planning.js`

**Change A — Centralize the docs-root resolution so state and dropdown can never disagree.**

Add a single helper near `updateDropdown` (after `src/webview/planning.js:82`) that resolves the effective docs filter from the persisted/restored value against the current `_workspaceItems`, writes it to `state.docsWorkspaceRootFilter`, and syncs the dropdown's `.value`:

```js
// NEW helper — single source of truth for the Docs tab workspace filter.
// Restored/persisted specific roots win only if still present; otherwise "All Workspaces" ('').
function resolveDocsWorkspaceFilter(workspaceItems) {
    const restored = _restoredPanelState.panel['docs.root'] || '';
    const valid = restored === '' || (workspaceItems || []).some(item => item.workspaceRoot === restored);
    state.docsWorkspaceRootFilter = valid ? restored : '';
    const dropdown = document.getElementById('docs-workspace-filter');
    if (dropdown) dropdown.value = state.docsWorkspaceRootFilter;
    return state.docsWorkspaceRootFilter;
}
```

**Change B — Use the helper in `updateDropdown` for the `docs` tab** (replace the inline block at `src/webview/planning.js:72-80`):

Before:
```js
        } else if (tabKey === 'docs') {
            const restoredDocsRoot = _restoredPanelState.panel['docs.root'] || '';
            if (restoredDocsRoot === '' || _workspaceItems.some(item => item.workspaceRoot === restoredDocsRoot)) {
                state.docsWorkspaceRootFilter = restoredDocsRoot;
            } else {
                state.docsWorkspaceRootFilter = '';
            }
            currentVal = state.docsWorkspaceRootFilter;
        }
```
After:
```js
        } else if (tabKey === 'docs') {
            currentVal = resolveDocsWorkspaceFilter(_workspaceItems);
        }
```

**Change C — Use the helper in `handleLocalDocsReady`** (replace `src/webview/planning.js:2399-2402`):

Before:
```js
        if (state.docsWorkspaceRootFilter && !(msg.workspaceItems || []).some(item => item.workspaceRoot === state.docsWorkspaceRootFilter)) {
            state.docsWorkspaceRootFilter = '';
        }
        populateWorkspaceDropdown('docs-workspace-filter', msg.workspaceItems || [], state.docsWorkspaceRootFilter);
```
After:
```js
        resolveDocsWorkspaceFilter(msg.workspaceItems || []);
        populateWorkspaceDropdown('docs-workspace-filter', msg.workspaceItems || [], state.docsWorkspaceRootFilter);
```

**Change D — Use the helper in `handleOnlineDocsReady`** (replace `src/webview/planning.js:2435-2439`):

Before:
```js
        if (state.docsWorkspaceRootFilter && !_workspaceItems.some(item => item.workspaceRoot === state.docsWorkspaceRootFilter)) {
            state.docsWorkspaceRootFilter = '';
        }

        populateWorkspaceDropdown('docs-workspace-filter', msg.workspaceItems || _workspaceItems, state.docsWorkspaceRootFilter);
```
After:
```js
        resolveDocsWorkspaceFilter(msg.workspaceItems || _workspaceItems);
        populateWorkspaceDropdown('docs-workspace-filter', msg.workspaceItems || _workspaceItems, state.docsWorkspaceRootFilter);
```

**Change E — Make the `restoredTabState` handler use the helper** (replace `src/webview/planning.js:3357-3365`):

Before:
```js
                // Restore Docs workspace filter
                const restoredDocsRoot = _restoredPanelState.panel['docs.root'] || '';
                if (_workspaceItems.length === 0 || restoredDocsRoot === '' || _workspaceItems.some(item => item.workspaceRoot === restoredDocsRoot)) {
                    state.docsWorkspaceRootFilter = restoredDocsRoot;
                } else {
                    state.docsWorkspaceRootFilter = '';
                }
                const docsDropdown = document.getElementById('docs-workspace-filter');
                if (docsDropdown) docsDropdown.value = state.docsWorkspaceRootFilter;
```
After:
```js
                // Restore Docs workspace filter (single source of truth; "All Workspaces" by default)
                resolveDocsWorkspaceFilter(_workspaceItems);
```

> Note: `resolveDocsWorkspaceFilter` already mirrors the `length === 0 → ''` outcome because when `_workspaceItems` is empty, a non-empty `restored` is not "present", so it resolves to `''` (all). An empty restored value also resolves to `''`. Behaviour preserved.

**Change F — Harden the local-docs filter against tag mismatches** (replace `src/webview/planning.js:2280-2282`).

This keeps "All Workspaces" showing everything (unchanged) and makes the specific-workspace branch resilient: match on `metadata.root` OR on the node's `metadata.sourceFolder`/`absolutePath` belonging to a folder configured under the selected root, so a dedup-mistagged file still appears under the workspace that actually configures its folder.

Before:
```js
            nodes: state.docsWorkspaceRootFilter
                ? (state._lastLocalDocsMsg.nodes || []).filter(n => n.metadata?.root === state.docsWorkspaceRootFilter)
                : (state._lastLocalDocsMsg.nodes || []),
```
After:
```js
            nodes: state.docsWorkspaceRootFilter
                ? (state._lastLocalDocsMsg.nodes || []).filter(n => {
                    if (n.metadata?.root === state.docsWorkspaceRootFilter) return true;
                    // Fallback: file may be tagged to a different root by cross-root dedup,
                    // but its sourceFolder is configured under the selected root.
                    const rootFolders = new Set(state.localFolderPathsByRoot?.[state.docsWorkspaceRootFilter] || []);
                    return rootFolders.has(n.metadata?.sourceFolder);
                  })
                : (state._lastLocalDocsMsg.nodes || []),
```

> The empty-filter (`''` = All Workspaces) branch is intentionally left untouched — it already returns all nodes, which is exactly the desired "load at All Workspaces" behaviour. Changes A–E ensure the filter is reliably `''` at startup so this branch actually runs on first paint.

## Verification Plan

1. **Build:** run `npm run compile` (webpack) — required because the extension serves the webview from `dist/webview/`; edits to `src/webview/planning.js` have no effect until rebuilt.
2. **Cold open, no persisted root:** Launch the Extension Development Host (F5), open the Planning panel, go to the **DOCS** tab without touching the dropdown. Confirm the dropdown reads "All Workspaces" and the sidebar populates with local docs from every configured workspace plus online sources (ClickUp/Linear/Notion sections appear and load their containers) — no need to pick a workspace first.
3. **Persisted specific root still present:** Select a specific workspace, reload the panel. Confirm it restores that specific workspace AND the dropdown visibly shows that workspace (state/UI agree), with the correct subset of docs.
4. **Persisted root removed:** With a specific workspace selected, close that workspace folder, reopen the panel. Confirm it falls back to "All Workspaces" and shows the union (no blank tree).
5. **Multi-root shared folder:** Configure the same docs folder under two workspace roots. Confirm: (a) "All Workspaces" shows the docs once (dedup), and (b) selecting *either* workspace still shows those docs (Change F fallback), not a blank list.
6. **Switch back to All Workspaces:** After picking a specific workspace, choose "All Workspaces" from the dropdown; confirm the full union re-renders immediately (existing `change` handler at `planning.js:985-990`).
7. **Regression — online lazy load:** Confirm ClickUp/Linear/Notion sections still fetch containers on first render at "All Workspaces" (placeholder "Loading…" then content), and that search filtering and antigravity sessions are unaffected.
