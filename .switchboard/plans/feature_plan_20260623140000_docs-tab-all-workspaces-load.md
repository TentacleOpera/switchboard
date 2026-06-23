# Docs Tab: Load Content at "All Workspaces" (Don't Require Selecting a Specific Workspace)

## Goal

The Docs tab in `planning.html` defaults its workspace dropdown to **"All Workspaces"** (`<option value="">All Workspaces</option>`, `src/webview/planning.html:3363-3365`). The reported symptom is that at startup the docs sidebar shows nothing (or "Loading docs…") under "All Workspaces" and only populates once the user picks a *specific* workspace from the dropdown. Changing the dropdown is what makes content appear; the default empty selection does not.

The desired behaviour is that "All Workspaces" loads and shows the union of all configured workspaces' docs/tickets immediately on open, the same way picking a single workspace shows that workspace's subset.

### Root Cause

There are two distinct issues; the fix must cover both because either one alone reproduces the symptom.

**(1) The "All Workspaces" render path depends on a state value that is reset out from under it, with no re-render guaranteed in the right order.**

- `state.docsWorkspaceRootFilter` defaults to `''` (all workspaces) at `src/webview/planning.js:34`.
- On startup the webview posts `fetchRoots` then `refreshSource:local-folder` (`src/webview/planning.js:8916-8917`). The backend replies with `workspaceItemsUpdated`, `restoredTabState`, `localDocsReady`, and `onlineDocsReady`.
- `restoredTabState` restores a *persisted* docs root into `state.docsWorkspaceRootFilter` (`src/webview/planning.js:3418-3426`). If a stale/previous specific root was persisted, the filter is now non-empty even though the visible dropdown still reads "All Workspaces" (the dropdown only has the static "All Workspaces" option until `workspaceItemsUpdated` repopulates it).
- `handleLocalDocsReady` then *resets* `state.docsWorkspaceRootFilter` back to `''` only **if** the stale root is absent from `msg.workspaceItems` (`src/webview/planning.js:2460-2462`). If the stale root still exists in the workspace list but the user expected "All", state and UI silently disagree.
- The same reset/`populateWorkspaceDropdown` logic is duplicated in `handleOnlineDocsReady` (`src/webview/planning.js:2496-2500`) and in `updateDropdown` for the `docs` tab (`src/webview/planning.js:72-80`), and these run at non-deterministic times relative to each other. The net effect is an ordering window where the first render uses a value that does not match what the dropdown shows, so "All Workspaces" can render an empty/partial tree until a manual `change` event (the only path that unconditionally sets the filter from the dropdown and re-renders — `src/webview/planning.js:1046-1051`) forces a correct re-render.

**(2) The local-docs filter uses strict equality on `metadata.root`, which is fragile, and is the mechanism by which a "wrong" non-empty filter yields a blank tree.**

- The local render filters nodes with `n.metadata?.root === state.docsWorkspaceRootFilter` (`src/webview/planning.js:2341-2343`). When the filter is `''` it (correctly) keeps all nodes; when it is a non-empty stale/mismatched root it keeps **zero** nodes.
- `metadata.root` is stamped from `f._root` (`src/services/PlanningPanelProvider.ts:5990-6001`), and `_sendLocalDocsReady` tags each file with only the **first** root that scans it because of cross-root dedup via `seenFilePaths` (`src/services/PlanningPanelProvider.ts:6044-6049`). So a folder shared/registered under multiple roots gets its files tagged to one arbitrary root. A strict `===` filter against a different root then shows nothing — and the "loads when I pick a workspace" behaviour the user sees is really "the workspace I happened to pick matches the tag."

Online sources are *not* the cause: `_sendOnlineDocsReady` sends workspace-independent global adapters with empty `nodes` (`src/services/PlanningPanelProvider.ts:6126-6158`), and the webview lazily fetches their containers on every `rerenderUnifiedDocs` whenever `nodes.length === 0` (`src/webview/planning.js:2269-2271`). They render regardless of the workspace filter. The fix therefore targets the local-docs filter + the startup/state-vs-UI synchronization.

### Message Ordering Trace

The startup sequence posts `fetchRoots` and `refreshSource:local-folder` at line 8916-8917. The backend sends four messages in a non-deterministic order. The two critical orderings:

**(a) `restoredTabState` arrives before `workspaceItemsUpdated`:**
1. `restoredTabState` sets `_restoredPanelState.panel['docs.root']` and calls `resolveDocsWorkspaceFilter(_workspaceItems)`. Since `_workspaceItems` is still empty (`[]`), a non-empty restored root resolves to `''` (All Workspaces). The dropdown syncs to `''`.
2. `workspaceItemsUpdated` arrives, populates `_workspaceItems`, and calls `updateDropdown` for each registered dropdown. `resolveDocsWorkspaceFilter` re-runs with populated items. If the restored root is valid, the filter switches to it and the dropdown syncs. If invalid, stays at `''`.
3. `localDocsReady` arrives, calls `resolveDocsWorkspaceFilter(msg.workspaceItems)` and `rerenderUnifiedDocs`. The filter is now correct and the tree renders.

**(b) `workspaceItemsUpdated` arrives before `restoredTabState`:**
1. `workspaceItemsUpdated` populates `_workspaceItems` and calls `updateDropdown`. `resolveDocsWorkspaceFilter` reads `_restoredPanelState.panel['docs.root']` which is still `undefined` → `''`. Filter is `''` (All Workspaces). Dropdown syncs to `''`.
2. `restoredTabState` arrives, sets `_restoredPanelState.panel`, and calls `resolveDocsWorkspaceFilter(_workspaceItems)`. Now the restored root is checked against populated items. If valid, filter switches to it; if not, stays at `''`.
3. `localDocsReady` arrives and renders with the correct filter.

In both orderings, the first `rerenderUnifiedDocs` that runs after `localDocsReady` uses a correct filter value. The brief window where the filter is `''` before switching to a valid restored root is acceptable — it shows "All Workspaces" content (the union), which is strictly better than the current blank tree.

## Metadata
**Complexity:** 4
**Tags:** frontend, ux, bugfix, docs

## User Review Required

No. The fix preserves all existing user-facing behaviour (persisted workspace selection is still restored when valid; "All Workspaces" still shows the union). The only behavioural change is that "All Workspaces" now loads content on first paint without requiring a manual dropdown change, which is the stated goal. No new settings, no data migration, no API changes.

## Complexity Audit

### Routine
- Making "All Workspaces" the deterministic startup state for the Docs tab and ensuring the dropdown's displayed value always matches `state.docsWorkspaceRootFilter`.
- Guaranteeing a render happens after both `localDocsReady` and `onlineDocsReady` arrive (the handlers already call `rerenderUnifiedDocs`; we only need the filter value to be correct at that point).
- Adding a single helper function and replacing inline logic at four call sites with calls to it — all within one file (`src/webview/planning.js`).

### Complex / Risky
- The docs workspace filter value is computed in three places (`updateDropdown` for `docs` at `planning.js:72-80`, `handleLocalDocsReady` at `2460-2463`, `handleOnlineDocsReady` at `2496-2500`) plus restored in the `restoredTabState` handler (`3418-3426`). They must agree. Centralizing into a single helper avoids a future regression but touches several call sites.
- Persistence: the docs root is persisted via `persistTab('docs.root', …)` (`planning.js:1049`) and restored on open. We must not break the legitimate case where a user *deliberately* selected a specific workspace and expects it restored next session — only fix the "stale value silently overrides the visible 'All Workspaces'" failure. The safe rule: the restored value wins **only if it still exists in `workspaceItems`**; otherwise fall back to `''`, and always sync the dropdown's `.value` to the resolved filter.
- Behavioural change in `restoredTabState` handler: the original code preserves a non-empty restored root when `_workspaceItems` is empty (condition: `_workspaceItems.length === 0 || ...`). The helper instead resolves to `''` in that case. This is intentional — it ensures "All Workspaces" shows content on first paint rather than a potentially stale root. When `workspaceItemsUpdated` arrives later, the helper re-validates and switches to the restored root if valid. See Change E note.

## Edge-Case & Dependency Audit

### Race Conditions
- **`restoredTabState` vs `workspaceItemsUpdated` ordering:** The helper handles both orderings correctly. When items are empty, it resolves to `''` (All Workspaces); when items arrive, `updateDropdown` re-runs the helper and switches to the restored root if valid. See Message Ordering Trace above.
- **`localDocsReady` vs `restoredTabState` ordering:** `handleLocalDocsReady` calls `resolveDocsWorkspaceFilter(msg.workspaceItems)` with the workspace items from the message payload, independent of whether `restoredTabState` has arrived. If `restoredTabState` hasn't arrived yet, `_restoredPanelState.panel['docs.root']` is `undefined` → `''`, so the filter is "All Workspaces" (correct default). When `restoredTabState` arrives later, the handler re-runs the helper with `_workspaceItems` (which may now be populated) and corrects the filter.
- **Multiple `rerenderUnifiedDocs` calls:** idempotent (it rebuilds `treePane.innerHTML` each time, `planning.js:1937`), so extra renders are safe.

### Security
- No security implications. The workspace filter is a client-side UI state value derived from persisted tab state and workspace items. No user input is passed to eval, innerHTML with untrusted content, or external APIs.

### Side Effects
- **Dropdown DOM sync:** The helper writes `dropdown.value` on every call. The `docs-workspace-filter` `<select>` element is in static HTML (`planning.html`), so `document.getElementById('docs-workspace-filter')` always returns a valid element after DOM ready. The `if (dropdown)` guard handles the pre-DOM-ready edge case.
- **Persisted state:** `_restoredPanelState.panel['docs.root']` is read but never written by the helper. The only write path is the `change` event handler at `planning.js:1046-1051`, which is unchanged.

### Dependencies & Conflicts
- **Stale persisted root no longer present** (workspace closed/removed): already handled by the existing `!workspaceItems.some(...)` reset logic, preserved in the helper via the `valid` check.
- **Stale persisted root still present but user expects "All"**: this is the core bug — when restoring, if the dropdown DOM value and `state.docsWorkspaceRootFilter` disagree, the visible "All Workspaces" must win at first paint. The helper always writes the resolved value back to the dropdown so they never disagree.
- **Files tagged to only one root via dedup** (`PlanningPanelProvider.ts:6044-6049`): "All Workspaces" must show them all (it does, via the `''` branch). No backend change required for the all-workspaces fix; documented as a known limitation of the per-workspace subset, not in scope to re-architect dedup. Change F adds a fallback for the per-workspace case.
- **Online sources** (ClickUp/Linear/Notion): unaffected; they fetch containers on every render irrespective of workspace filter (`planning.js:2269-2271`).
- **Antigravity sessions**: rendered from `_lastLocalDocsMsg.antigravitySessions` independent of the workspace filter (`planning.js:2323-2324`); unaffected.
- **Migration concern**: `docs.root` has shipped (it is persisted/restored today). Do **not** drop or rename the key. Preserve persisted specific-root selections; only correct the display/filter desync. No data migration needed.
- **No confirmation dialogs** anywhere (project rule) — N/A here, but noted.
- **Build dependency**: Per `CLAUDE.md`, `npm run compile` is only needed when producing a VSIX for release. All testing is done via an installed VSIX or Extension Development Host — `dist/` is not the source of truth. No compilation step is required for verification.

## Dependencies

None. This plan is self-contained and touches only `src/webview/planning.js`.

## Adversarial Synthesis

Key risks: (1) all line numbers in the original plan were stale (off by 60-145 lines) — corrected to match current source; (2) Change E's "behaviour preserved" note was factually wrong — the helper intentionally changes the empty-`_workspaceItems` case to resolve to `''` instead of preserving a stale root, which is the desired fix but must be acknowledged; (3) the verification plan incorrectly required `npm run compile`, contradicting `CLAUDE.md` — removed. Mitigations: line numbers verified against live source, Change E note corrected, verification plan updated to use Extension Development Host testing only.

## Proposed Changes

### File: `src/webview/planning.js`

**Change A — Centralize the docs-root resolution so state and dropdown can never disagree.**

Add a single helper near `updateDropdown` (after `src/webview/planning.js:82`) that resolves the effective docs filter from the persisted/restored value against the current workspace items, writes it to `state.docsWorkspaceRootFilter`, and syncs the dropdown's `.value`:

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

> Note: The `docs-workspace-filter` `<select>` element is in static HTML (`planning.html`), so `document.getElementById` returns a valid element after DOM ready. The `if (dropdown)` guard handles the pre-DOM-ready edge case.

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

**Change C — Use the helper in `handleLocalDocsReady`** (replace `src/webview/planning.js:2460-2463`):

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

**Change D — Use the helper in `handleOnlineDocsReady`** (replace `src/webview/planning.js:2496-2500`):

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

**Change E — Make the `restoredTabState` handler use the helper** (replace `src/webview/planning.js:3418-3426`):

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

> **Behaviour intentionally changed:** The original code preserved a non-empty restored root when `_workspaceItems.length === 0` (the `_workspaceItems.length === 0 ||` clause made the condition true). The helper instead resolves to `''` when items are empty and the restored root is non-empty, because `valid = restored === '' || (workspaceItems || []).some(...)` is `false` for a non-empty restored with empty items. This is the desired fix: it ensures "All Workspaces" shows content on first paint rather than a potentially stale root that yields a blank tree. When `workspaceItemsUpdated` arrives later, `updateDropdown` re-runs the helper with populated items and switches to the restored root if valid. The net effect is a brief "All Workspaces" flash before settling on the persisted workspace — strictly better than the current blank-tree bug.

**Change F — Harden the local-docs filter against tag mismatches** (replace `src/webview/planning.js:2341-2343`).

This keeps "All Workspaces" showing everything (unchanged) and makes the specific-workspace branch resilient: match on `metadata.root` OR on the node's `metadata.sourceFolder` belonging to a folder configured under the selected root, so a dedup-mistagged file still appears under the workspace that actually configures its folder.

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
>
> Note: `state.localFolderPathsByRoot` is populated in `handleLocalDocsReady` at line 2458 from `msg.folderPathsByRoot`, and `rerenderUnifiedDocs` is called at line 2465 after that, so the map is available when the filter runs. The `Set` is constructed once per filter call (not per node), which is acceptable for a docs sidebar.

## Verification Plan

### Automated Tests

Automated tests are skipped for this session per session directives. The test suite will be run separately by the user.

### Manual Verification

1. **Cold open, no persisted root:** Launch the Extension Development Host (F5), open the Planning panel, go to the **DOCS** tab without touching the dropdown. Confirm the dropdown reads "All Workspaces" and the sidebar populates with local docs from every configured workspace plus online sources (ClickUp/Linear/Notion sections appear and load their containers) — no need to pick a workspace first.
2. **Persisted specific root still present:** Select a specific workspace, reload the panel. Confirm it restores that specific workspace AND the dropdown visibly shows that workspace (state/UI agree), with the correct subset of docs. (Note: there may be a brief "All Workspaces" flash before the restored root is applied if `restoredTabState` arrives before `workspaceItemsUpdated` — this is expected and acceptable.)
3. **Persisted root removed:** With a specific workspace selected, close that workspace folder, reopen the panel. Confirm it falls back to "All Workspaces" and shows the union (no blank tree).
4. **Multi-root shared folder:** Configure the same docs folder under two workspace roots. Confirm: (a) "All Workspaces" shows the docs once (dedup), and (b) selecting *either* workspace still shows those docs (Change F fallback), not a blank list.
5. **Switch back to All Workspaces:** After picking a specific workspace, choose "All Workspaces" from the dropdown; confirm the full union re-renders immediately (existing `change` handler at `planning.js:1046-1051`).
6. **Regression — online lazy load:** Confirm ClickUp/Linear/Notion sections still fetch containers on first render at "All Workspaces" (placeholder "Loading…" then content), and that search filtering and antigravity sessions are unaffected.

---

**Recommendation:** Complexity is 4 → **Send to Coder**.
