# Workspace Scoping 1: Shared Infrastructure — workspaceItems Broadcast + Per-Root Persistence Service

## Metadata
- **Tags:** backend, frontend, infrastructure
- **Complexity:** 4
- **Part of:** `per-tab-workspace-scoping-and-persistence.md` (sub-plan 1)
- **Depends on:** none — foundation for sub-plans 2–5

## Goal
Two reusable pieces both panels need:
1. A single `workspaceItems` (`{ workspaceRoot, label }[]`) broadcast sent to each webview on init and on workspace-folder changes, usable by every tab's workspace dropdown.
2. A per-root persisted tab-state service backed by `context.globalState`, with `persistTabState` / `restoredTabState` messages, so tab selections and navigation survive panel close, reload, and VS Code restart.

This sub-plan adds infrastructure only — no tab behavior changes. Sub-plans 2–5 consume it.

## Background
- `PlanningPanelProvider` already builds workspace items for kanban (`_buildKanbanWorkspaceItems()`, `PlanningPanelProvider.ts:908`, items shaped at :978-984 using folder name labels) but only sends them with kanban plans (`workspaceItems` consumed at `planning.js:4098`).
- `DesignPanelProvider` tags files with `_root` (`DesignPanelProvider.ts:313, 365`) but has no items broadcast.
- Persistence today is `vscode.setState()` only — dies with the panel (panels are `createWebviewPanel`, `PlanningPanelProvider.ts:266`, no serializer).
- Why `globalState` keyed by resolved root (not `workspaceState`): state must follow the repo regardless of whether it's opened standalone or in a multi-root workspace, and must not leak between repos. Dev-only project — no migration from old setState data; just stop using it where superseded.

## Proposed Changes

### 1. Shared `PanelStateStore` helper
**New file:** `src/services/PanelStateStore.ts`

```typescript
import * as vscode from 'vscode';
import * as path from 'path';

export class PanelStateStore {
    constructor(private memento: vscode.Memento, private panelKey: string) {}

    // Per-root state (e.g. tickets navigation for a specific repo)
    getRootState<T>(tabKey: string, root: string): T | undefined {
        const map = this.memento.get<Record<string, T>>(this._key(tabKey)) || {};
        return map[path.resolve(root)];
    }
    async setRootState<T>(tabKey: string, root: string, value: T): Promise<void> {
        const key = this._key(tabKey);
        const map = { ...(this.memento.get<Record<string, T>>(key) || {}) };
        map[path.resolve(root)] = value;
        await this.memento.update(key, map);
    }

    // Panel-level state (e.g. which root a tab's dropdown points at)
    getPanelState<T>(tabKey: string): T | undefined {
        return this.memento.get<T>(this._key(tabKey + '.panel'));
    }
    async setPanelState<T>(tabKey: string, value: T): Promise<void> {
        await this.memento.update(this._key(tabKey + '.panel'), value);
    }

    private _key(tabKey: string) { return `switchboard.panelState.${this.panelKey}.${tabKey}`; }
}
```

Instantiate in `extension.ts` with `context.globalState` — one store per panel (`'planning'`, `'design'`) — and pass into `PlanningPanelProvider` / `DesignPanelProvider` constructors (follow the existing constructor-injection pattern used for `_getWorkspaceRoot`, `PlanningPanelProvider.ts:104`).

### 2. `workspaceItems` broadcast (both providers)
- Extract the items-building logic from `_buildKanbanWorkspaceItems()` (`PlanningPanelProvider.ts:908-984` region) into a shared function (e.g. `buildWorkspaceItems()` in a small util, or duplicate the ~15 lines in DesignPanelProvider — preference: shared util in `src/services/`).
- On webview init (where each provider posts its initial payload after `panel.webview.html` is set), post `{ type: 'workspaceItemsUpdated', items }`.
- Subscribe to `vscode.workspace.onDidChangeWorkspaceFolders` in both providers (dispose with panel) and re-post on change.
- Keep the existing kanban-specific delivery intact (kanban reads `msg.workspaceItems` from the plans payload, `planning.js:4098`) — do not break it; the new broadcast is additive.

### 3. Persistence messages (both providers)
Message protocol:
- Webview → provider: `{ type: 'persistTabState', tabKey, workspaceRoot?, state }` — if `workspaceRoot` present → `setRootState`, else → `setPanelState`. Fire-and-forget, no reply.
- Provider → webview on init, in the same initial payload as `workspaceItemsUpdated`: `{ type: 'restoredTabState', panel: { [tabKey]: value }, byRoot: { [tabKey]: { [root]: value } } }`. Send the whole map per tabKey so webviews can switch roots without round-trips.

### 4. Webview-side helpers
- **planning.js:** a generic `populateWorkspaceDropdown(selectEl, items, selectedRoot, includeAllOption)` — generalize from the kanban population loop (`planning.js:4004-4011`) and the existing `populateWorkspaceDropdown` usage at `planning.js:1468` (reconcile: if one already exists, extend it with the `includeAllOption` flag instead of adding a second).
- **design.js:** port the same helper.
- Both webviews: store `restoredTabState` payload in a module-level `_restoredPanelState` object and handle `workspaceItemsUpdated` by re-populating any registered dropdowns, preserving current selections when the root still exists.
- A tiny `persistTab(tabKey, state, workspaceRoot?)` postMessage wrapper, debounced 300ms per tabKey (search inputs will call it on every keystroke in sub-plan 2).

## Edge Cases
- Roots are keyed via `path.resolve()` everywhere (consistent with `PlanningPanelProvider.ts:927`).
- `onDidChangeWorkspaceFolders` removing a root that a dropdown points at: webview falls back to its tab default; the globalState entry is left alone (repo may return).
- Ordering: `restoredTabState` + `workspaceItemsUpdated` must arrive before tabs first fetch — include both in the same initial payload the provider already sends on webview ready.

## Verification
- `npm run compile`.
- Temporary smoke check (manual, no tab changes yet): from devtools console of the planning webview, confirm `workspaceItemsUpdated` and `restoredTabState` messages arrive on panel open; post a `persistTabState` and confirm it round-trips after a full panel close/reopen and after a VS Code reload.
- Kanban tab still populates its workspace filter (existing path untouched).

## Review Findings

- **Files changed:** `src/webview/design.js` — removed a stale duplicate `populateWorkspaceDropdown` (line ~378) that overwrote the new generic helper at line 55, breaking `includeAllOption` and DOM-element first-arg support for registered dropdowns.
- **Validation:** Verified all direct callers of `populateWorkspaceDropdown` in both `planning.js` and `design.js` are compatible with the surviving generic signature (`selectElOrId`, `workspaceItems`, `selectedValue`, `includeAllOption = true`). The `_registeredDropdowns` update path in `design.js` now works correctly, including `registerWorkspaceDropdown('stitch-workspace-filter', 'stitch.root', false)`.
- **Remaining risks:** `PlanningPanelProvider.open()` does not proactively broadcast `workspaceItemsUpdated` + `restoredTabState` on panel creation; it waits for the webview's `fetchRoots` handshake. This matches the existing pattern and is harmless today, but should be refactored if the webview init sequence ever changes.
