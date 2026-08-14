# Terminals sidebar stacks every workspace as a header tier — replace it with the workspace dropdown every other panel uses

## Goal

The Terminals panel is the only Switchboard surface that presents workspaces as a stack of collapsible headers in a 220px sidebar. Every other panel selects a workspace from a dropdown. Bring the Terminals sidebar into line: a workspace `<select>` at the top of the sidebar, and — when one workspace is picked — its terminals rendered directly, one tier shallower.

### Problem analysis

`renderSidebarList()` (`src/webview/terminals.js:3032`) builds a three-tier tree on every render: **workspace → worktree → terminal**. The workspace tier comes from `parentsList` (populated at `src/webview/terminals.js:1561` from the fleet-list response's `parents`), and each parent becomes a `.parent-group` with a `.parent-group-header` carrying a chevron, the name, a count badge, and a `+` that spawns into that workspace (`src/webview/terminals.js:3208-3245`).

The rest of the product does not do this. `kanban.html:2765` declares:

```html
<select id="workspace-project-select" class="workspace-project-select" data-tooltip="Select workspace and project" style="min-width:280px;"></select>
```

The Terminals panel *itself* already uses the dropdown idiom internally — the kanban pane header builds a combined workspace/project `<select>` from `buildWorkspaceList()` (`src/webview/terminals.js:4839`, picker construction at `src/webview/terminals.js:5048-5111`). So the helper, the data, and the pattern all exist in this file already; only the sidebar was never converted.

### Root cause

The sidebar tree predates the panel's workspace-aware features. It was written when the sidebar's only job was "show me the fleet, grouped by where it came from", and the header tier was the cheapest way to attach a per-workspace spawn `+`. Once `buildWorkspaceList()` arrived for the kanban pane, the sidebar became the outlier — but converting it needed the spawn `+` to find a new home, and nobody did that work. The cost lands squarely on the narrowest column in the panel: with three workspaces open, the operator burns three header rows plus their vertical margins before a single terminal is listed, and every workspace name is competing for 220px against a chevron, a badge, and a button.

### Decisions

- **A `<select>` at the top of the sidebar, above the ops block.** Styled with the panel's existing `.link-select` treatment (`src/webview/terminals.html:1792`) so it matches the modal selects already in this file.
- **`All workspaces` is the first option and the default.** Unlike the board, the Terminals fleet is genuinely cross-workspace — the pane grid seats terminals from any root — so a single-workspace-only dropdown would make other workspaces' terminals unreachable from the sidebar. `All workspaces` preserves today's behaviour as the default, which also makes this change additive rather than a behaviour break.
- **Picking a specific workspace removes the header tier.** Its terminals render at the top level of the list, worktree sub-groups preserved. This is where the vertical space is won.
- **The `+` follows the selection.** In single-workspace mode, a `+` sits beside the dropdown and spawns into the selected root. In `All workspaces` mode, the existing per-header `+` buttons stay exactly as they are.
- **The selection persists** as `terminals.sidebarWorkspace` (the resolved `parentFolder` absolute path, or `''` for all), alongside the other `terminals.*` settings.
- **`Unmapped` is an option only when non-empty** — it is a real bucket in the current tree (`src/webview/terminals.js:3140-3147`) and must stay reachable.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, ux, refactor
- **Project:** Browser Switchboard

## Feature context — this is subtask 3 of 5

Feature: **Terminals Panel Sidebar & Group Selection UX**. Lands **last of the three `renderSidebarList()` plans**, after the badge removal and the group filter, because it is the only one that restructures the render's *control flow* rather than its content — rebasing it onto the other two is far cheaper than the reverse.

**Reconciled contracts with the siblings:**

1. **Filter order is fixed: group filter → bucket → workspace filter.** The group-filter sibling narrows `fleetList` to `sidebarItems` *before* the bucketing loop; this plan narrows the *bucket list* after it. Both may be active, and the result is an intersection.
2. **`hasUnmapped` must be probed from the UNFILTERED fleet — this is a real defect if implemented naively.** If `hasUnmapped` is derived from the buckets (which are built from the group-filtered `sidebarItems`), then locking a group whose members are all mapped empties the unmapped bucket → the `Unmapped` option disappears → the stale-selection fallback below fires → `sidebarWorkspace` is reset to `''` **and persisted**. A group-lock gesture would silently destroy the operator's saved workspace selection. The reconciled end-state is in Proposed Changes §5: probe `fleetList`, not the buckets.
3. **The header block this plan makes conditional is already badge-free** once the badge-removal sibling lands. Do not reintroduce `.worktree-count` while restructuring. The **worktree sub-header keeps its header in both modes** — this plan flattens only the workspace tier, so the worktree badge is removed by the sibling, not by this plan's `flattenHeaders` branch.
4. **The group filter's empty-notice branch is the one that renders in flattened mode.** In single-workspace mode exactly one bucket renders, so exactly one notice can appear. When a lock is also active, the group-specific text wins — the dropdown already names the workspace on screen, so the notice's job is to explain the *other* filter.

## Complexity Audit (Routine vs Complex/Risky)

**Routine**

- Building a `<select>` from `buildWorkspaceList()` — the exact call the kanban pane header already makes.
- Persisting one string through the existing `saveSetting`/`loadSetting` pair (`src/webview/terminals.js:1378`/`:1395`).
- Filtering the bucketing pass by `parentRoot`.

**Complex / Risky**

- **`renderSidebarList()` re-runs on every fleet poll (5s).** Rebuilding a `<select>` on each pass slams an open dropdown shut and drops keyboard focus — a defect this file has already hit and solved for the kanban pane, which rebuilds only when a signature changes (`src/webview/terminals.js:5048`, `:5063`, `:5111`). The sidebar picker must use the same `dataset.sig` guard: recompute options only when the workspace set changes; otherwise update `.value` only.
- **A saved workspace can vanish** (mapping removed, folder closed). The stored root must be validated against the live list on every render and fall back to `All workspaces` — never render an empty sidebar because the saved root no longer exists. **But the validation input must be poll-stable** — see the `hasUnmapped` contract above; a fallback driven by a transient input is worse than no fallback, because it *writes*.
- **The `activeGroupsToRender` declaration is replaced, not shadowed.** `const activeGroupsToRender = [...]` already exists at `src/webview/terminals.js:3180`. The change rewrites that statement in place; adding a second `const` of the same name in the same block is a `SyntaxError` that takes the whole panel down at parse time, and the panel is a plain `<script>` with no build step to catch it.
- **The role picker mounts into header elements.** `pickerState.key` is `'parent:' + id` for workspace headers (`src/webview/terminals.js:3194`) and `'worktree:' + path` for worktree headers, and the picker is appended *between* the header and the items container so a collapsed group cannot hide it (`src/webview/terminals.js:3254-3259`). In single-workspace mode there is no parent header to mount under — the `parent:*` picker must still be appended to `parentDiv` (which is now the first thing in the list, immediately under the dropdown row, so it reads as attached to the dropdown's `+`), and it must still set `pickerRendered = true` or the garbage-collect at the tail (`src/webview/terminals.js:3367`) will null `pickerState` on the next poll.
- **`collapsedGroups` holds `parent:*` keys.** They stay meaningful in `All workspaces` mode and are simply unused in single-workspace mode. Do not prune them — an operator toggling back to `All` expects their collapse state intact. Concretely: `parentDiv.className` must not apply `collapsed` when flattening, or a workspace the operator collapsed in `All` mode renders as an empty list when selected directly.
- **The synthetic `Workspace Root` fallback** (`src/webview/terminals.js:3121-3128`) exists when `parentsList` is empty. It carries `parentFolder: ''`, which `buildWorkspaceList()` already filters out (`src/webview/terminals.js:4843`), so the dropdown has nothing to offer; it must hide itself entirely rather than render a one-option select.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Zero/one real workspace | Dropdown hidden. Tree renders as today. A single-workspace user sees no new chrome. |
| Two or more workspaces | Dropdown visible, defaulting to `All workspaces`. |
| `All workspaces` selected | Byte-identical to today's rendering: workspace headers, their `+`, their collapse state. |
| Specific workspace selected | No workspace headers. Worktree sub-groups render at the top level. A `+` beside the dropdown spawns into that root. |
| Selected workspace has zero terminals | The `(no terminals — + to open)` notice renders at the top level, so the sidebar is never blank. |
| Selected workspace collapsed in `All` mode, then selected directly | Renders expanded. `collapsedGroups` retains the key but `flattenHeaders` suppresses the `collapsed` class — otherwise selecting a workspace shows nothing and the only way out is a chevron that is no longer on screen. |
| Saved workspace no longer in `parentsList` | Falls back to `All workspaces` and rewrites the setting. |
| Unmapped terminals exist | `Unmapped` appears as a trailing option; selecting it lists exactly those terminals with no spawn `+` (there is no root to spawn into). |
| Unmapped bucket empty | No `Unmapped` option. |
| Group locked while `Unmapped` is the selection | Option list is computed from the **unfiltered** fleet, so `Unmapped` persists and the selection is not rewritten. Only the rows narrow. |
| Role picker open when the selection changes | The picker is scoped to a header that may no longer render. On selection change, clear `pickerState` before re-rendering — an orphaned picker is worse than a dismissed one. |
| Fleet poll while the dropdown is open | Options are not rebuilt (signature unchanged), so the open dropdown survives. |
| Solo mode | Sidebar is hidden by `body.is-solo` (`src/webview/terminals.html:1903`); the dropdown inherits that. No extra rule. |
| Panel opened in a second browser window | `terminals.sidebarWorkspace` is a shared setting; both windows land on the same selection. Acceptable and consistent with every other `terminals.*` key. |

**Dependencies:** `buildWorkspaceList()` (already in `src/webview/terminals.js:4839`), `parentsList` (already populated), `saveSetting`/`loadSetting` (already in use). No backend, verb, or schema change. One new persisted key.

**Migration:** none required. `terminals.sidebarWorkspace` is a brand-new key read through `loadSetting(key, default)`, which supplies `''` on every install that has never written it. No shipped state changes shape, nothing is deleted, and no prior key is reinterpreted.

## Proposed Changes

### `src/webview/terminals.html`

**1. Picker row between the header and the ops block (`~1935`).**

```html
        <div class="sidebar-header">
            <span class="sidebar-title">Agents</span>
        </div>
        <!-- Workspace picker. Every other panel selects a workspace from a
             dropdown (kanban.html:2765); this sidebar was the last surface
             stacking them as collapsible headers. Hidden entirely when there
             is fewer than two workspaces to choose between. -->
        <div id="sidebar-workspace-row" class="sidebar-workspace-row" hidden>
            <select id="sidebar-workspace-select" class="link-select" title="Filter the agent list by workspace"></select>
            <button type="button" id="sidebar-workspace-new" class="btn-group-new" title="Spawn terminal in the selected workspace">+</button>
        </div>
```

**2. CSS beside `.sidebar-ops` (`~129`).**

```css
        .sidebar-workspace-row {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 10px 10px 0;
        }
        /* Both the row and the + are toggled by the `hidden` attribute. The row
           needs the explicit rule because `display: flex` above would otherwise
           beat the UA `[hidden] { display: none }`. .btn-group-new declares no
           `display` (terminals.html:597), so the UA rule is sufficient for it. */
        .sidebar-workspace-row[hidden] { display: none; }
        .sidebar-workspace-row .link-select { min-width: 0; flex: 1; }
```

### `src/webview/terminals.js`

**1. State + handles (`~182` / `~189`).**

```js
    // '' = All workspaces. Otherwise a parent's resolved `parentFolder`, or the
    // reserved '__unmapped__' sentinel.
    let sidebarWorkspace = '';
    const sidebarWsRowEl = document.getElementById('sidebar-workspace-row');
    const sidebarWsSelectEl = document.getElementById('sidebar-workspace-select');
    const sidebarWsNewEl = document.getElementById('sidebar-workspace-new');
```

**2. Load + save alongside the other `terminals.*` keys (`~1407-1445` / `~1501`).**

```js
        const savedSidebarWs = await loadSetting('terminals.sidebarWorkspace', '');
        sidebarWorkspace = typeof savedSidebarWs === 'string' ? savedSidebarWs : '';
```

```js
        saveSetting('terminals.sidebarWorkspace', sidebarWorkspace);
```

**3. Picker renderer, signature-guarded.** Called from inside `renderSidebarList()` (see §5).

```js
    /** Build/refresh the sidebar workspace picker. Options are rebuilt ONLY when
     *  the workspace set changes — this runs on every 5s fleet poll, and
     *  recreating the <select> each tick slams an open dropdown shut and drops
     *  keyboard focus (the same defect the kanban pane header solves with a
     *  dataset.sig guard at :5048).
     *
     *  hasUnmapped MUST be probed from the unfiltered fleet by the caller. A
     *  group lock narrows the buckets, and deriving it from them would make the
     *  Unmapped option vanish under a lock, trip the stale-selection fallback
     *  below, and PERSIST the reset — losing the operator's selection on a
     *  gesture that has nothing to do with workspaces. */
    function renderSidebarWorkspacePicker(hasUnmapped) {
        if (!sidebarWsRowEl || !sidebarWsSelectEl) { return; }
        const workspaces = buildWorkspaceList();

        // Fewer than two real roots: nothing to choose between. Hide the row and
        // force All so the tree renders exactly as it did before this existed.
        // Not persisted — the roots may come back on the next fleet response,
        // and writing '' here would erase a still-valid saved selection.
        if (workspaces.length < 2 && !hasUnmapped) {
            sidebarWsRowEl.hidden = true;
            sidebarWorkspace = '';
            return;
        }
        sidebarWsRowEl.hidden = false;

        // A saved root that no longer resolves must not blank the sidebar.
        if (sidebarWorkspace && sidebarWorkspace !== '__unmapped__'
            && !workspaces.some(w => w.root === sidebarWorkspace)) {
            sidebarWorkspace = '';
            saveSetting('terminals.sidebarWorkspace', sidebarWorkspace);
        }
        if (sidebarWorkspace === '__unmapped__' && !hasUnmapped) {
            sidebarWorkspace = '';
            saveSetting('terminals.sidebarWorkspace', sidebarWorkspace);
        }

        const sig = workspaces.map(w => `${w.root}|${w.label}`).join('~') + (hasUnmapped ? '~U' : '');
        if (sidebarWsSelectEl.dataset.sig !== sig) {
            sidebarWsSelectEl.dataset.sig = sig;
            sidebarWsSelectEl.textContent = '';
            const allOpt = document.createElement('option');
            allOpt.value = '';
            allOpt.textContent = 'All workspaces';
            sidebarWsSelectEl.appendChild(allOpt);
            for (const ws of workspaces) {
                const opt = document.createElement('option');
                opt.value = ws.root;
                opt.textContent = ws.label;
                sidebarWsSelectEl.appendChild(opt);
            }
            if (hasUnmapped) {
                const opt = document.createElement('option');
                opt.value = '__unmapped__';
                opt.textContent = 'Unmapped';
                sidebarWsSelectEl.appendChild(opt);
            }
        }
        sidebarWsSelectEl.value = sidebarWorkspace;

        // The + spawns into the SELECTED root. Unmapped has no root to spawn into.
        const spawnable = !!sidebarWorkspace && sidebarWorkspace !== '__unmapped__';
        sidebarWsNewEl.hidden = !spawnable;
    }
```

**4. Wire the two controls once, at init.**

```js
    if (sidebarWsSelectEl) {
        sidebarWsSelectEl.addEventListener('change', () => {
            sidebarWorkspace = sidebarWsSelectEl.value || '';
            // An open role picker is scoped to a header that may no longer render
            // under the new selection. Dismiss rather than orphan it.
            pickerState = null;
            saveSetting('terminals.sidebarWorkspace', sidebarWorkspace);
            renderSidebarList();
        });
    }
    if (sidebarWsNewEl) {
        sidebarWsNewEl.addEventListener('click', (e) => {
            e.stopPropagation();
            onNewTerminalClicked({ parentRoot: sidebarWorkspace }, 'parent:' + sidebarWorkspace);
        });
    }
```

> Note: the picker key here is `'parent:' + sidebarWorkspace` (a root path), while the per-header key is `'parent:' + parentGroup.id` (a parent **id**). In flattened mode the header does not render, so the two never collide — but the mount test in §5 keys on `parentKey`, so the dropdown `+` must pass a key the flattened branch will match. Use `'parent:' + parentGroup.id` semantics by resolving the selected root's parent id at click time, or key both sites off the root consistently. Pick one and apply it to both — a mismatch produces a `+` that opens nothing.

**5. Filter the render.** Replace the existing `const activeGroupsToRender = [...]` statement at `src/webview/terminals.js:3180` (do **not** add a second declaration — same block, same name, `SyntaxError`):

```js
        // Probed from the UNFILTERED fleet, never from the buckets: a group lock
        // narrows the buckets, and an option list that flickers with the lock
        // would trip the stale-selection fallback and persist a reset.
        const hasUnmapped = fleetList.some(t => {
            const mapped = parentGroups.some(p => p.fullPath && p.fullPath === t.parentRoot);
            const soleSynthetic = parentGroups.length === 1
                && (parentGroups[0].id === 'workspace-root' || !parentGroups[0].fullPath);
            return !mapped && !soleSynthetic;
        });
        renderSidebarWorkspacePicker(hasUnmapped);

        const allRenderable = [
            ...parentGroups,
            ...(unmappedGroup.direct.length > 0 || unmappedGroup.worktreesMap.size > 0 ? [unmappedGroup] : [])
        ];
        // Single-workspace mode: one bucket, and its header tier is dropped —
        // the dropdown IS the header now. All-workspaces mode is unchanged.
        const flattenHeaders = !!sidebarWorkspace;
        const activeGroupsToRender = sidebarWorkspace
            ? allRenderable.filter(g => sidebarWorkspace === '__unmapped__'
                ? g.id === 'unmapped'
                : g.fullPath === sidebarWorkspace)
            : allRenderable;
```

Note `allRenderable` still gates the *rendered* unmapped bucket on the (possibly group-filtered) bucket contents — that is correct: the option should exist whenever unmapped terminals exist, but the bucket should only render when it has rows to show.

Then, inside the per-group loop (`~3193`), skip the header when flattening:

```js
            const parentDiv = document.createElement('div');
            // No `collapsed` class when flattened: collapsedGroups keeps its
            // parent:* keys (an operator toggling back to All expects them), but
            // applying one here would render the selected workspace as an empty
            // list with no chevron on screen to reopen it.
            parentDiv.className = 'parent-group'
                + (!flattenHeaders && isParentCollapsed ? ' collapsed' : '');

            if (!flattenHeaders) {
                ... existing headerEl construction, +, and collapse handler ...
                parentDiv.appendChild(headerEl);
            }

            // The picker mounts between the header and the items so a collapsed
            // group cannot hide it. With the header gone it mounts at the top of
            // the group — which in flattened mode is the top of the list, directly
            // under the dropdown row, so it still reads as attached to the + that
            // opened it. Still outside .parent-group-items, and still counted by
            // pickerRendered so the tail garbage-collect does not null pickerState
            // on the next poll.
            if (pickerState && pickerState.key === parentKey) {
                parentDiv.appendChild(mountRolePicker(pickerState.targetSpec));
                pickerRendered = true;
            }
```

## Verification Plan

> Testing is done against an **installed VSIX**, not the repo's `dist/`. No compilation or automated-test step is part of this plan.

1. **Install + open:** install the current VSIX and open the Terminals panel in a browser window with **two or more** workspace mappings configured.
2. **Dropdown present and defaulted:** confirm a workspace `<select>` renders under the `Agents` header reading `All workspaces`, with one option per workspace and no `+` beside it.
3. **All-workspaces parity:** confirm the tree below is identical to the pre-change rendering — workspace headers, their `+`, their collapse state.
4. **Single-workspace mode:** pick a workspace. Confirm its terminals render with **no** workspace header row, worktree sub-groups intact, and a `+` beside the dropdown.
5. **Collapse-state trap:** in `All workspaces` mode, collapse workspace A. Now select A from the dropdown. Confirm its terminals **render** (not an empty list). Switch back to `All` and confirm A is still collapsed.
6. **Spawn from the dropdown `+`:** click it, pick a role, confirm the terminal spawns into the selected workspace (check its row's attribution by switching back to `All workspaces`).
7. **Empty workspace:** select a workspace with no terminals. Confirm `(no terminals — + to open)` renders and the sidebar is not blank.
8. **Persistence:** reload the panel. Confirm the selection is restored.
9. **Stale root:** with a specific workspace selected, remove that workspace mapping in Setup and reload. Confirm the sidebar falls back to `All workspaces` rather than rendering empty.
10. **Unmapped:** produce an unmapped terminal (spawn in a directory outside every mapping). Confirm an `Unmapped` option appears, selecting it lists exactly that terminal, and no `+` renders beside the dropdown.
11. **Unmapped survives a lock (cross-subtask regression):** with `Unmapped` selected, lock a group whose members are all mapped. Confirm the `Unmapped` option is **still in the list**, the selection is **not** rewritten, and reloading the panel still restores `Unmapped`. This is the persisted-reset defect the `hasUnmapped` probe exists to prevent.
12. **Poll stability:** open the dropdown and hold it open for 15s (≥3 fleet polls). Confirm it does not close and the highlighted option does not reset.
13. **Picker not orphaned:** open the role picker from a workspace header in `All workspaces` mode, then change the dropdown. Confirm the picker is dismissed cleanly with no stray element and no console error, and that a subsequent `+` click opens it again.
14. **Single-workspace install:** with only one workspace mapped, confirm the dropdown row is hidden entirely and the panel looks exactly as it did before this change.
15. **Solo mode:** enter solo. Confirm the sidebar and dropdown are hidden and no console error fires.
