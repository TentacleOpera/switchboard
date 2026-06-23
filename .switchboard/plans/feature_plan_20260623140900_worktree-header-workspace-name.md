# Show the Active Workspace Name in the Worktree Tab's "Create New Worktree" Header

## Goal (Problem analysis + Root Cause with cited file:line)

In the kanban board's WORKTREES tab, the "Create New Worktree" form operates against the workspace currently open in the kanban board, but nothing in the UI communicates that scoping. A user with multiple workspaces/repos open cannot tell which workspace a new worktree will be created in.

The header is a static string:

- `src/webview/kanban.html:8583` — `stateTitle.textContent = 'CREATE NEW WORKTREE';` inside `createWorktreesPanel(config)` (function starts at `src/webview/kanban.html:8533`).

**Root cause:** the header text is hard-coded and never references the active workspace. The webview already tracks the active workspace path, so the fix is purely presentational: derive a friendly workspace name and inject it into the header, then keep it in sync when the workspace changes.

**Where the active workspace name is available (client-side, no host change needed):**

- `currentWorkspaceRoot` — the active workspace's absolute path. Declared at `src/webview/kanban.html:3653`, seeded from `document.body.dataset.initialWorkspaceRoot` at `src/webview/kanban.html:3655-3656`, and reassigned by the host's `updateWorkspaceSelection` message at `src/webview/kanban.html:5946`.
- `getWorkspaceItemRepoScope(item)` at `src/webview/kanban.html:4000-4004` already derives a friendly name (the last path segment of a `workspaceRoot`). We will reuse the same "last path segment" logic to turn `currentWorkspaceRoot` into a display name.
- `workspaceItems` (`src/webview/kanban.html:3660`, populated at `src/webview/kanban.html:5949`) optionally carries richer labels via `buildWorkspaceOptionLabel` (`src/webview/kanban.html:4006-4017`), but for a concise header the bare repo-scope name (last path segment) is the right choice.

**Where workspace changes are handled (must re-render to keep header in sync):**

- `updateWorkspaceSelection` message handler at `src/webview/kanban.html:5944-5959`. This currently updates `currentWorkspaceRoot`, the project dropdown, and the filter badge, but does **not** re-render the worktrees tab — so a workspace switch while the tab is open leaves a stale header. This is the sync gap to close.
- The tab is (re)rendered on activation at `src/webview/kanban.html:3843-3847` (`renderWorktreesTab()`), on the `worktreeConfig` message at `src/webview/kanban.html:6035-6038`, and via `renderWorktreesTab()` at `src/webview/kanban.html:8498-8507` which rebuilds the panel by calling `createWorktreesPanel(lastWorktreeConfig)`.

## Metadata

**Complexity:** 2
**Tags:** webview, kanban, worktrees, ui-copy, workspace-scoping

## Complexity Audit

### Routine
- Deriving a display name from `currentWorkspaceRoot` (last path segment) — mirrors the existing `getWorkspaceItemRepoScope` helper.
- Changing one `textContent` assignment to an interpolated string.
- Adding a re-render call in the existing `updateWorkspaceSelection` handler, guarded so it only fires when the worktrees tab is active.

### Complex/Risky
- None. This is a presentational, fully client-side change. No host (`KanbanProvider.ts`) changes, no message-shape changes, no persisted state, no migrations.

## Edge-Case & Dependency Audit

- **Workspace switching keeps header in sync:** The `updateWorkspaceSelection` handler (`src/webview/kanban.html:5944`) sets `currentWorkspaceRoot` but does not re-render the worktrees panel. Fix: after updating `currentWorkspaceRoot`, if the worktrees tab is currently active, call `renderWorktreesTab()` so the header reflects the new workspace. Guard on the tab being active to avoid needless DOM work (the tab also re-renders itself on activation at `src/webview/kanban.html:3843-3847`, so an inactive tab will pick up the new name when next opened).
- **No workspace selected / empty path:** `currentWorkspaceRoot` can be `''` (initial value, `src/webview/kanban.html:3653`). The derive helper must return `''` for empty/whitespace input. When the name is empty, fall back to the original static header `'CREATE NEW WORKTREE'` (no trailing "IN ").
- **Long workspace names:** Workspace names can be long. The header lives in a flex column (`actionSection`, `src/webview/kanban.html:8577-8579`); to prevent overflow/wrapping issues, the header element gets `word-break: break-word;` (it currently has no wrapping rule at `src/webview/kanban.html:8582`). Text wraps gracefully within the dashed-border section.
- **Path separator portability:** Windows paths use `\`; the derive helper must split on both `/` and `\` (same regex `/[\\/]/` already used at `src/webview/kanban.html:4002` and `src/webview/kanban.html:4927`).
- **No host dependency:** `worktreeConfig` (`src/services/KanbanProvider.ts:7422-7431`) does not carry a workspace name and does not need to — the webview derives the name from `currentWorkspaceRoot` it already holds. No backend change required, so no risk to the published install base and no migration concern.
- **No confirmation dialogs introduced** (per project rules). This change adds no dialogs of any kind.

## Proposed Changes

### File: `src/webview/kanban.html`

#### 1. Add a small helper to derive a display name from the active workspace root

Place this helper near the existing `getWorkspaceItemRepoScope` (after `src/webview/kanban.html:4004`) so the two related helpers sit together.

Before (`src/webview/kanban.html:4000-4004`):
```js
        function getWorkspaceItemRepoScope(item) {
            const raw = String(item && item.workspaceRoot || '');
            const parts = raw.split(/[\\/]/).filter(Boolean);
            return parts.length > 0 ? parts[parts.length - 1] : '';
        }
```

After:
```js
        function getWorkspaceItemRepoScope(item) {
            const raw = String(item && item.workspaceRoot || '');
            const parts = raw.split(/[\\/]/).filter(Boolean);
            return parts.length > 0 ? parts[parts.length - 1] : '';
        }

        // Friendly name for the active kanban workspace (last path segment of currentWorkspaceRoot).
        // Returns '' when no workspace is known, so callers can fall back to a plain label.
        function getActiveWorkspaceDisplayName() {
            const raw = String(currentWorkspaceRoot || '').trim();
            const parts = raw.split(/[\\/]/).filter(Boolean);
            return parts.length > 0 ? parts[parts.length - 1] : '';
        }
```

#### 2. Inject the workspace name into the "Create New Worktree" header

Before (`src/webview/kanban.html:8581-8584`):
```js
            const stateTitle = document.createElement('div');
            stateTitle.style.cssText = 'font-size: 11px; font-weight: bold; color: var(--text-muted);';
            stateTitle.textContent = 'CREATE NEW WORKTREE';
            actionSection.appendChild(stateTitle);
```

After:
```js
            const stateTitle = document.createElement('div');
            stateTitle.style.cssText = 'font-size: 11px; font-weight: bold; color: var(--text-muted); word-break: break-word;';
            const wsName = getActiveWorkspaceDisplayName();
            stateTitle.textContent = wsName
                ? `CREATE NEW WORKTREE IN ${wsName.toUpperCase()}`
                : 'CREATE NEW WORKTREE';
            actionSection.appendChild(stateTitle);
```

Notes:
- `wsName.toUpperCase()` keeps the header visually consistent with the existing all-caps label style. (If a mixed-case name reads better, drop `.toUpperCase()` — the header is the only consumer.)
- `textContent` (not `innerHTML`) is used, so the workspace name cannot inject markup — safe by construction.

#### 3. Keep the header in sync when the active workspace changes

The worktrees panel is fully rebuilt by `renderWorktreesTab()` (`src/webview/kanban.html:8498-8507`), which re-runs `createWorktreesPanel` and therefore re-derives the header. We just need to call it when the workspace switches while the tab is open.

Before (`src/webview/kanban.html:5944-5959`):
```js
                case 'updateWorkspaceSelection': {
                    const previousRoot = currentWorkspaceRoot;
                    currentWorkspaceRoot = msg.workspaceRoot || '';
                    activeWorkspaceFilter = msg.activeFilter || null;
                    activeProjectFilter = msg.projectFilter ?? null;
                    workspaceItems = Array.isArray(msg.workspaces) ? msg.workspaces : [];
                    currentControlPlaneMode = msg.controlPlaneMode || msg.mode || 'none';

                    if (msg.allWorkspaceProjects && typeof msg.allWorkspaceProjects === 'object') {
                        allWorkspaceProjects = msg.allWorkspaceProjects;
                    }

                    const explicitChange = previousRoot !== '' && previousRoot !== currentWorkspaceRoot;
                    updateWorkspaceProjectDropdown(explicitChange ? currentWorkspaceRoot : null);
                    updateWorkspaceFilterBadge();
                    break;
                }
```

After:
```js
                case 'updateWorkspaceSelection': {
                    const previousRoot = currentWorkspaceRoot;
                    currentWorkspaceRoot = msg.workspaceRoot || '';
                    activeWorkspaceFilter = msg.activeFilter || null;
                    activeProjectFilter = msg.projectFilter ?? null;
                    workspaceItems = Array.isArray(msg.workspaces) ? msg.workspaces : [];
                    currentControlPlaneMode = msg.controlPlaneMode || msg.mode || 'none';

                    if (msg.allWorkspaceProjects && typeof msg.allWorkspaceProjects === 'object') {
                        allWorkspaceProjects = msg.allWorkspaceProjects;
                    }

                    const explicitChange = previousRoot !== '' && previousRoot !== currentWorkspaceRoot;
                    updateWorkspaceProjectDropdown(explicitChange ? currentWorkspaceRoot : null);
                    updateWorkspaceFilterBadge();

                    // Keep the worktrees tab's "CREATE NEW WORKTREE IN <workspace>" header in sync
                    // when the active workspace changes while that tab is open. (When the tab is not
                    // active it re-renders itself on next activation, so no work is needed here.)
                    if (previousRoot !== currentWorkspaceRoot) {
                        const worktreesTabActive = document
                            .querySelector('.shared-tab-btn[data-tab="worktrees"]')
                            ?.classList.contains('active');
                        if (worktreesTabActive) {
                            renderWorktreesTab();
                        }
                    }
                    break;
                }
```

Notes:
- `renderWorktreesTab()` is defined later in the same script scope (`src/webview/kanban.html:8498`) but is hoisted as a function declaration, so calling it from the message handler is safe.
- The active-tab check mirrors how tab activation is detected elsewhere (`.shared-tab-btn` with `data-tab`, e.g. `src/webview/kanban.html:5938` and `src/webview/kanban.html:3852`).
- `renderWorktreesTab()` rebuilds from `lastWorktreeConfig` (`src/webview/kanban.html:8503`); the header derives purely from `currentWorkspaceRoot`, so it is correct even before any fresh `worktreeConfig` arrives for the new workspace. The config-dependent body will refresh when the next `worktreeConfig` message lands (and `loadWorktreeConfig` is still triggered on tab activation at `src/webview/kanban.html:3845`).

## Verification Plan

1. **Build:** `npm run compile` — confirm webpack builds `dist/` with no errors (the extension serves the webview from `dist/webview/`, so the rebuild is mandatory after editing `src/webview/kanban.html`).
2. **Header shows workspace name:** Open the kanban board on a workspace (e.g. a folder named `switchboard`), open the WORKTREES tab, and confirm the form header reads `CREATE NEW WORKTREE IN SWITCHBOARD`.
3. **Sync on workspace switch:** With the WORKTREES tab open, switch the active workspace (via the workspace/project dropdown or any path that emits `updateWorkspaceSelection`). Confirm the header updates to the new workspace name without needing to leave and re-enter the tab.
4. **Re-entry sync:** Switch workspace while on a different tab (e.g. board), then open the WORKTREES tab. Confirm the header shows the now-current workspace.
5. **Empty/edge fallback:** With no resolvable workspace name (empty `currentWorkspaceRoot`), confirm the header falls back to plain `CREATE NEW WORKTREE` with no dangling "IN ".
6. **Long name:** On a workspace with a long folder name, confirm the header wraps within the dashed action section and does not overflow horizontally.
7. **No regressions:** Confirm the rest of the WORKTREES tab (suppress-main-terminals checkbox, repo select in control-plane mode, worktree list) renders and behaves as before. No confirmation dialogs were added anywhere.
