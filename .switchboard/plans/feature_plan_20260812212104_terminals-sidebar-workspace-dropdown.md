# Terminals sidebar stacks every workspace as a header tier — replace it with the workspace dropdown every other panel uses

## Goal

The Terminals panel is the only Switchboard surface that presents workspaces as a stack of collapsible headers in a 220px sidebar. Every other panel selects a workspace from a dropdown. Bring the Terminals sidebar into line: a workspace `<select>` at the top of the sidebar, and — when one workspace is picked — its terminals rendered directly, one tier shallower.

### Problem analysis

`renderSidebarList()` (`src/webview/terminals.js:2951`) builds a three-tier tree on every render: **workspace → worktree → terminal**. The workspace tier comes from `parentsList` (populated at `src/webview/terminals.js:1497` from the fleet-list response's `parents`), and each parent becomes a `.parent-group` with a `.parent-group-header` carrying a chevron, the name, a count badge, and a `+` that spawns into that workspace (`src/webview/terminals.js:3128-3160`).

The rest of the product does not do this. `kanban.html:2765` declares:

```html
<select id="workspace-project-select" class="workspace-project-select" data-tooltip="Select workspace and project" style="min-width:280px;"></select>
```

The Terminals panel *itself* already uses the dropdown idiom internally — the kanban pane header builds a combined workspace/project `<select>` from `buildWorkspaceList()` (`src/webview/terminals.js:4652`, picker at `src/webview/terminals.js:4879`). So the helper, the data, and the pattern all exist in this file already; only the sidebar was never converted.

### Root cause

The sidebar tree predates the panel's workspace-aware features. It was written when the sidebar's only job was "show me the fleet, grouped by where it came from", and the header tier was the cheapest way to attach a per-workspace spawn `+`. Once `buildWorkspaceList()` arrived for the kanban pane, the sidebar became the outlier — but converting it needed the spawn `+` to find a new home, and nobody did that work. The cost lands squarely on the narrowest column in the panel: with three workspaces open, the operator burns three header rows plus their vertical margins before a single terminal is listed, and every workspace name is competing for 220px against a chevron, a badge, and a button.

### Decisions

- **A `<select>` at the top of the sidebar, above the ops block.** Styled with the panel's existing `.link-select` treatment so it matches the modal selects already in this file.
- **`All workspaces` is the first option and the default.** Unlike the board, the Terminals fleet is genuinely cross-workspace — the pane grid seats terminals from any root — so a single-workspace-only dropdown would make other workspaces' terminals unreachable from the sidebar. `All workspaces` preserves today's behaviour as the default, which also makes this change additive rather than a behaviour break.
- **Picking a specific workspace removes the header tier.** Its terminals render at the top level of the list, worktree sub-groups preserved. This is where the vertical space is won.
- **The `+` follows the selection.** In single-workspace mode, a `+` sits beside the dropdown and spawns into the selected root. In `All workspaces` mode, the existing per-header `+` buttons stay exactly as they are.
- **The selection persists** as `terminals.sidebarWorkspace` (the resolved `parentFolder` absolute path, or `''` for all), alongside the other `terminals.*` settings.
- **`Unmapped` is an option only when non-empty** — it is a real bucket in the current tree (`src/webview/terminals.js:3057`) and must stay reachable.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, ux, refactor
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine**

- Building a `<select>` from `buildWorkspaceList()` — the exact call the kanban pane header already makes.
- Persisting one string through the existing `saveSetting`/`loadSetting` pair.
- Filtering the bucketing pass by `parentRoot`.

**Complex / Risky**

- **`renderSidebarList()` re-runs on every fleet poll (5s).** Rebuilding a `<select>` on each pass slams an open dropdown shut and drops keyboard focus — a defect this file has already hit and solved for the kanban pane, which rebuilds only when a signature changes (`src/webview/terminals.js:4864-4867`). The sidebar picker must use the same signature guard: recompute options only when the workspace set changes; otherwise update `.value` only.
- **A saved workspace can vanish** (mapping removed, folder closed). The stored root must be validated against the live list on every render and fall back to `All workspaces` — never render an empty sidebar because the saved root no longer exists.
- **The role picker mounts into header elements.** `pickerState.key` is `'parent:' + id` for workspace headers and `'worktree:' + path` for worktree headers, and the picker is appended *between* the header and the items container so a collapsed group cannot hide it (`src/webview/terminals.js:3164-3169`). In single-workspace mode there is no parent header to mount under — the `parent:*` picker must mount under the **dropdown row** instead, and the picker garbage-collect at the tail of the function (`src/webview/terminals.js:3283`) must still see it as rendered or it will null `pickerState` on the next poll.
- **`collapsedGroups` holds `parent:*` keys.** They stay meaningful in `All workspaces` mode and are simply unused in single-workspace mode. Do not prune them — an operator toggling back to `All` expects their collapse state intact.
- **The synthetic `Workspace Root` fallback** (`src/webview/terminals.js:3043-3050`) exists when `parentsList` is empty. With zero real parents the dropdown has nothing to offer; it must hide itself entirely rather than render a one-option select.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Zero/one real workspace | Dropdown hidden. Tree renders as today. A single-workspace user sees no new chrome. |
| Two or more workspaces | Dropdown visible, defaulting to `All workspaces`. |
| `All workspaces` selected | Byte-identical to today's rendering: workspace headers, their `+`, their collapse state. |
| Specific workspace selected | No workspace headers. Worktree sub-groups render at the top level. A `+` beside the dropdown spawns into that root. |
| Selected workspace has zero terminals | The `(no terminals — + to open)` notice renders at the top level, so the sidebar is never blank. |
| Saved workspace no longer in `parentsList` | Falls back to `All workspaces` and rewrites the setting. |
| Unmapped terminals exist | `Unmapped` appears as a trailing option; selecting it lists exactly those terminals with no spawn `+` (there is no root to spawn into). |
| Unmapped bucket empty | No `Unmapped` option. |
| Role picker open when the selection changes | The picker is scoped to a header that may no longer render. On selection change, clear `pickerState` before re-rendering — an orphaned picker is worse than a dismissed one. |
| Fleet poll while the dropdown is open | Options are not rebuilt (signature unchanged), so the open dropdown survives. |
| Solo mode | Sidebar is hidden by `body.is-solo`; the dropdown inherits that. No extra rule. |
| Panel opened in a second browser window | `terminals.sidebarWorkspace` is a shared setting; both windows land on the same selection. Acceptable and consistent with every other `terminals.*` key. |

**Dependencies:** `buildWorkspaceList()` (already in `src/webview/terminals.js`), `parentsList` (already populated), `saveSetting`/`loadSetting` (already in use). No backend, verb, or schema change. One new persisted key.

## Proposed Changes

### `src/webview/terminals.html`

**1. Picker row between the header and the ops block (~line 1832).**

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

**2. CSS beside `.sidebar-ops` (~line 129).**

```css
        .sidebar-workspace-row {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 10px 10px 0;
        }
        .sidebar-workspace-row[hidden] { display: none; }
        .sidebar-workspace-row .link-select { min-width: 0; flex: 1; }
```

### `src/webview/terminals.js`

**1. State + handles (~line 182 / 189).**

```js
    // '' = All workspaces. Otherwise a parent's resolved `parentFolder`.
    let sidebarWorkspace = '';
    const sidebarWsRowEl = document.getElementById('sidebar-workspace-row');
    const sidebarWsSelectEl = document.getElementById('sidebar-workspace-select');
    const sidebarWsNewEl = document.getElementById('sidebar-workspace-new');
```

**2. Load + save alongside the other `terminals.*` keys (~line 1378 / 1474).**

```js
        const savedSidebarWs = await loadSetting('terminals.sidebarWorkspace', '');
        sidebarWorkspace = typeof savedSidebarWs === 'string' ? savedSidebarWs : '';
```

```js
        saveSetting('terminals.sidebarWorkspace', sidebarWorkspace);
```

**3. Picker renderer, signature-guarded.** Called from the top of `renderSidebarList()`.

```js
    /** Build/refresh the sidebar workspace picker. Options are rebuilt ONLY when
     *  the workspace set changes — this runs on every 5s fleet poll, and
     *  recreating the <select> each tick slams an open dropdown shut and drops
     *  keyboard focus (the same defect the kanban pane header solves with a
     *  signature guard at :4864). */
    function renderSidebarWorkspacePicker(hasUnmapped) {
        if (!sidebarWsRowEl || !sidebarWsSelectEl) { return; }
        const workspaces = buildWorkspaceList();

        // Fewer than two real roots: nothing to choose between. Hide the row and
        // force All so the tree renders exactly as it did before this existed.
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

**5. Filter the render.** After the parent/worktree bucketing is built and `activeGroupsToRender` is assembled (~line 3099), narrow it and flatten one tier:

```js
        const hasUnmapped = unmappedGroup.direct.length > 0 || unmappedGroup.worktreesMap.size > 0;
        renderSidebarWorkspacePicker(hasUnmapped);

        const allRenderable = [
            ...parentGroups,
            ...(hasUnmapped ? [unmappedGroup] : [])
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

Then, inside the per-group loop, skip the header when flattening and mount the picker under the dropdown row instead:

```js
            const parentDiv = document.createElement('div');
            parentDiv.className = 'parent-group' + (!flattenHeaders && isParentCollapsed ? ' collapsed' : '');

            if (!flattenHeaders) {
                ... existing headerEl construction, +, and collapse handler ...
                parentDiv.appendChild(headerEl);
            }

            // The picker mounts between the header and the items so a collapsed
            // group cannot hide it. With the header gone it mounts at the top of
            // the group instead — still outside .parent-group-items, still
            // counted by pickerRendered so the tail garbage-collect does not
            // null pickerState on the next poll.
            if (pickerState && pickerState.key === parentKey) {
                parentDiv.appendChild(mountRolePicker(pickerState.targetSpec));
                pickerRendered = true;
            }
```

## Verification Plan

1. **Build + install:** `npm run compile`, package and install the VSIX, open the Terminals panel in a browser window with **two or more** workspace mappings configured.
2. **Dropdown present and defaulted:** confirm a workspace `<select>` renders under the `Agents` header reading `All workspaces`, with one option per workspace and no `+` beside it.
3. **All-workspaces parity:** confirm the tree below is identical to the pre-change rendering — workspace headers, their `+`, their collapse state.
4. **Single-workspace mode:** pick a workspace. Confirm its terminals render with **no** workspace header row, worktree sub-groups intact, and a `+` beside the dropdown.
5. **Spawn from the dropdown `+`:** click it, pick a role, confirm the terminal spawns into the selected workspace (check its row's `parentRoot` attribution by switching back to `All workspaces`).
6. **Empty workspace:** select a workspace with no terminals. Confirm `(no terminals — + to open)` renders and the sidebar is not blank.
7. **Persistence:** reload the panel. Confirm the selection is restored.
8. **Stale root:** with a specific workspace selected, remove that workspace mapping in Setup and reload. Confirm the sidebar falls back to `All workspaces` rather than rendering empty.
9. **Unmapped:** produce an unmapped terminal (spawn in a directory outside every mapping). Confirm an `Unmapped` option appears, selecting it lists exactly that terminal, and no `+` renders beside the dropdown.
10. **Poll stability:** open the dropdown and hold it open for 15s (≥3 fleet polls). Confirm it does not close and the highlighted option does not reset.
11. **Picker not orphaned:** open the role picker from a workspace header in `All workspaces` mode, then change the dropdown. Confirm the picker is dismissed cleanly with no stray element and no console error, and that a subsequent `+` click opens it again.
12. **Single-workspace install:** with only one workspace mapped, confirm the dropdown row is hidden entirely and the panel looks exactly as it did before this change.
13. **Solo mode:** enter solo. Confirm the sidebar and dropdown are hidden and no console error fires.
