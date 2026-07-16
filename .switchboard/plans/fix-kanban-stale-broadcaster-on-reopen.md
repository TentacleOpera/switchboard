# Fix Kanban Webview Loses Workspaces on Tab Reopen Under Memory Pressure

## Goal

Fix the Kanban panel's host→webview message delivery so that closing and
reopening the Kanban tab under VS Code memory pressure does not silently lose
all workspaces — the board must reload correctly without requiring a full IDE
restart.

### Problem

When VS Code is under memory pressure, closing and reopening the Kanban tab
causes the board to completely break — it cannot load workspaces, and a full
IDE restart is required to recover. The bug does not manifest under normal
conditions because `retainContextWhenHidden: true` keeps the webview alive
across tab switches; it only surfaces when VS Code overrides that setting
under memory pressure and destroys the webview.

### Background

The Kanban panel's host→webview message delivery has two branches in
`KanbanProvider.postMessage()`:

- **Branch A — `_broadcaster` exists:** delegates to `BroadcastHub.push()`,
  which sends to `_target.webview` (the webview captured at broadcaster
  creation time).
- **Branch B — no `_broadcaster`:** sends directly to `this._panel.webview`,
  with a `_pendingWebviewMessages` queue for pre-ready ordering.

The `_broadcaster` is a singleton field that outlives the panel. It is
created in `_initKanbanService()` and captures `this._panel.webview` at that
moment. The bug is a lifecycle mismatch between panel disposal/recreation
and broadcaster webview reference updates.

### Root Cause

1. **`_broadcaster` is created** during `deserializeWebviewPanel()` (panel
   restore on extension reload) or `handleServiceVerb()` (an HTTP verb
   request). It captures the webview reference at creation time.

2. **Panel is closed** (memory pressure destroys the webview) → `onDidDispose`
   fires. It sets `_panel = undefined` and clears dedup caches, but **does
   NOT clear the broadcaster's webview reference**. The broadcaster still
   points at the dead webview.

3. **Panel is reopened via `open()`** — this creates a fresh panel but
   **never calls `_initKanbanService()`**, unlike `deserializeWebviewPanel()`
   which does call it. So the broadcaster is never updated with the new
   webview reference.

4. **All host→webview messages are silently lost.** The webview sends
   `ready`, the host runs `fullSync` → `_refreshBoard` →
   `postMessage({type: 'updateWorkspaceSelection', ...})`, but that goes
   through `_broadcaster.push()` → the dead webview. The new webview never
   receives workspace data, so it cannot load workspaces.

### Why a full restart fixes it

A restart triggers `deserializeWebviewPanel()`, which calls
`_initKanbanService()`, which calls `_broadcaster.setWebview(newWebview)`.
The broadcaster is now aligned with the live panel, and messages flow
correctly.

## Metadata
**Complexity:** 3
**Tags:** bugfix, ui, reliability

## User Review Required

- **Project pin removed:** The original plan pinned `**Project:** switchboard`,
  but `switchboard` is the workspace/repo name, not a user-created project.
  Per the Switchboard pinning protocol, workspace-name pins are silently
  dropped by the importer. The pin has been removed; the plan lands
  unassigned and can be reassigned on the board.
- **Placement refinement:** The `_initKanbanService()` call in `open()` has
  been moved to after `_resolveWorkspaceRoot()` (see Superseded callout in
  Proposed Changes). Confirm this placement is acceptable.
- **Systemic issue flagged:** Four other providers (`SetupPanelProvider`,
  `PlanningPanelProvider`, `TaskViewerProvider`, `DesignPanelProvider`) use
  the same `BroadcastHub` singleton-outlives-panel pattern and may have the
  same latent bug. A follow-up plan is recommended — do NOT expand this
  plan's scope to cover them.

## Complexity Audit

### Routine
- Single-file change (`src/services/KanbanProvider.ts`)
- Mirrors an existing proven pattern (`deserializeWebviewPanel()` already calls `_initKanbanService()`)
- Two localized edits: one method call addition in `open()`, one line in each of two `onDidDispose` blocks
- No new architectural patterns, no data consistency risks
- Low risk, small scope

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:**
- Messages sent between `onDidDispose` (Change 2 clears broadcaster webview)
  and `open()` (Change 1 re-inits broadcaster) are queued in the
  broadcaster's `_pendingWebviewMessages` and flushed when the new webview is
  set. No race — the queue bridges the gap.
- If `_currentWorkspaceRoot` is null when `_initKanbanService()` is called,
  the broadcaster is set to `undefined` and `postMessage()` falls back to
  Branch B (direct `_panel.webview` with provider-level pending queue).
  Messages are still delivered. Placing the call after `_resolveWorkspaceRoot()`
  minimizes this window.

**Security:**
- No security implications. The fix only affects internal message routing
  between the extension host and the webview.

**Side Effects:**
- Stale messages queued in the broadcaster's pending queue between dispose
  and reopen will be flushed to the new webview. These are overwritten by
  the fresh `ready` → `fullSync` → `refresh()` flow. Cosmetic flicker risk
  is transient and bounded.
- `onDidDispose` clearing the broadcaster webview reference does NOT destroy
  the broadcaster itself — it remains alive with a null webview. This is
  intentional: `_initKanbanService()` updates it via `setWebview()` on
  reopen.

**Dependencies & Conflicts:**
- No external dependencies. The fix uses existing methods (`_initKanbanService()`,
  `setWebview()`) already proven in `deserializeWebviewPanel()`.
- No conflicts with other plans or in-flight work.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) `_initKanbanService()` called before `_resolveWorkspaceRoot()`
could destroy the broadcaster if `_currentWorkspaceRoot` is null — mitigated
by placing the call after workspace resolution; (2) four other providers share
the same singleton-outlives-panel pattern — flagged as a follow-up, not
expanded into this plan; (3) stale queued messages flushed to the new webview
are overwritten by the fresh sync flow — cosmetic, bounded. The fix mirrors
the proven `deserializeWebviewPanel()` initialization pattern and adds
defense-in-depth via dispose-time webview reference clearing.

## Proposed Changes

### `src/services/KanbanProvider.ts`

**Context:** The `open()` method creates a new webview panel but, unlike
`deserializeWebviewPanel()`, never calls `_initKanbanService()`. This leaves
the `_broadcaster` singleton pointing at the previous (now-dead) webview.
All host→webview messages after reopen are silently lost.

**Logic:** Mirror the `deserializeWebviewPanel()` initialization pattern:
call `_initKanbanService()` after the panel is created and the workspace root
is resolved, so the broadcaster's webview reference is updated to the new
live panel. Additionally, clear the broadcaster's webview reference in
`onDidDispose` as defense-in-depth — any messages sent between dispose and
reopen are queued in the broadcaster's `_pendingWebviewMessages` and flushed
when the new webview is set.

**Implementation:**

#### Change 1: `open()` — call `_initKanbanService()` after workspace resolution

In `KanbanProvider.open()`, after the workspace root is resolved and
`applyLiveSyncConfig` completes (after line 1329, before the
`onDidChangeViewState` registration at line 1331), call
`this._initKanbanService()`.

This mirrors what `deserializeWebviewPanel()` already does at line 1359, with
the improvement that the call is placed AFTER `_resolveWorkspaceRoot()` so
`_currentWorkspaceRoot` is set before the broadcaster is initialized.

> **Superseded:** In `open()`, after the panel is created and the HTML is set
> (around line 1300, after `this._panel.webview.html = html`), call
> `this._initKanbanService()`. Location: after the `onDidReceiveMessage`
> registration (line ~1306).
> **Reason:** Placing the call before `_resolveWorkspaceRoot()` (line 1325)
> means `_currentWorkspaceRoot` may still be null. If it is,
> `_initKanbanService()` sets `_broadcaster = undefined` (line 6605) and
> returns — destroying the broadcaster. `_resolveWorkspaceRoot()` may then
> auto-select a workspace (line 990), but `_initKanbanService()` is never
> called again, leaving the broadcaster dead and WS fan-out silently lost.
> `deserializeWebviewPanel()` has the same latent ordering issue; placing the
> call after workspace resolution in `open()` avoids replicating it.
> **Replaced with:** Call `this._initKanbanService()` after the
> `_resolveWorkspaceRoot()` + `ensureReady()` + `applyLiveSyncConfig()` block
> (after line 1329), before the `onDidChangeViewState` registration (line
> 1331). This ensures `_currentWorkspaceRoot` is resolved before the
> broadcaster is initialized or updated.

**Location:** `src/services/KanbanProvider.ts`, `open()` method, after line
1329 (after the `if (workspaceRoot) { ... }` block), before line 1331.

#### Change 2: `onDidDispose` — clear broadcaster's webview reference

In both `onDidDispose` callbacks (the one in `open()` at line 1308 and the
one in `deserializeWebviewPanel()` at line 1376), add
`this._broadcaster?.setWebview(null)` to clear the stale reference.

This is defense-in-depth: any messages sent between dispose and reopen will
be queued in the broadcaster's `_pendingWebviewMessages` (which is flushed
when `setWebview` is called with the new webview) rather than silently
dropped to a dead webview.

**Location:** `src/services/KanbanProvider.ts`, both `onDidDispose` blocks
(lines 1308–1323 and 1376–1391). Add the call after the existing
`this._pendingWebviewMessages = []` line in each block.

**Edge Cases:**
- If `_broadcaster` is undefined (no workspace root was ever resolved),
  `this._broadcaster?.setWebview(null)` is a no-op. Safe.
- If `_currentWorkspaceRoot` is null when `_initKanbanService()` is called
  in `open()`, the broadcaster is set to undefined and `postMessage()`
  falls back to Branch B (direct `_panel.webview`). Messages are still
  delivered via the provider's own `_pendingWebviewMessages` queue, flushed
  on `ready`. The WS fan-out is lost in this edge case, but the webview
  still loads workspaces — the primary goal is met.
- Stale messages in the broadcaster's pending queue (queued between dispose
  and reopen) are flushed to the new webview on `setWebview(newWebview)`.
  These are overwritten by the fresh `ready` → `fullSync` → `refresh()`
  flow. Transient cosmetic flicker is possible but bounded.

## Verification Plan

### Automated Tests

Automated tests and compilation are skipped per session directive. All
verification is manual.

### Manual Verification

1. **Reproduce the original bug** (before the fix):
   - Open the Kanban panel.
   - Simulate memory pressure disposal: close the Kanban tab, then trigger
     VS Code's memory cleanup (or temporarily set `retainContextWhenHidden:
     false` to force disposal on tab close).
   - Reopen the Kanban tab via the command palette / Switchboard command.
   - Confirm: workspaces do not load (the bug).

2. **Verify the fix** (after applying both changes):
   - Same reproduction steps as above.
   - Confirm: workspaces load correctly on reopen.
   - Confirm: board cards render, dropdowns populate, all tabs functional.

3. **Regression check — normal flow (no disposal):**
   - Open Kanban, switch to another tab, switch back.
   - Confirm: board remains populated, no flicker or data loss.

4. **Regression check — extension reload:**
   - Open Kanban, reload the VS Code window.
   - Confirm: panel restores via `deserializeWebviewPanel`, workspaces load.

5. **Regression check — LocalApiServer verbs:**
   - With the API server running, hit a kanban verb endpoint after a
     panel close/reopen cycle.
   - Confirm: the verb response reaches the webview (broadcaster path
     works after the fix).

6. **Edge case — first open with auto-select:**
   - Clear persisted workspace selection. Open Kanban for the first time
     with `autoSelectFirstWorkspace` enabled.
   - Confirm: workspaces load (broadcaster initialized after
     `_resolveWorkspaceRoot` auto-selects the workspace).

---

**Recommendation:** Complexity 3 → Send to Intern.

## Completion Report

Implemented both changes in `src/services/KanbanProvider.ts`. Change 1: added `this._initKanbanService()` call in `open()` after the `_resolveWorkspaceRoot()` + `ensureReady()` + `applyLiveSyncConfig()` block (before `onDidChangeViewState` registration), mirroring the proven `deserializeWebviewPanel()` pattern so the `_broadcaster` singleton's webview reference is updated to the freshly created panel on reopen. Change 2: added `this._broadcaster?.setWebview(null)` in both `onDidDispose` callbacks (in `open()` and `deserializeWebviewPanel()`) as defense-in-depth, so messages sent between dispose and reopen queue in the broadcaster's `_pendingWebviewMessages` instead of being silently dropped to a dead webview. No issues encountered; compilation and tests skipped per session directive. Red-team review confirmed all edge cases (race during `await`, null workspace root, undefined broadcaster, stale queue flush) are mitigated by existing queue/fallback behavior.
