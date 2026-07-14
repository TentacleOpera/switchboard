# Fix Kanban Webview Loses Workspaces on Tab Reopen Under Memory Pressure

## Metadata
**Complexity:** 3
**Tags:** bugfix, ui, reliability
**Project:** switchboard

## Goal

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

## Implementation

### Change 1: `open()` — update broadcaster after creating a new panel

In `KanbanProvider.open()`, after the panel is created and the HTML is set
(around line 1300, after `this._panel.webview.html = html`), call
`this._initKanbanService()`. This mirrors what `deserializeWebviewPanel()`
already does at line 1359.

This ensures the broadcaster's webview reference is updated to the new live
panel whenever a panel is created via `open()`.

**Location:** `src/services/KanbanProvider.ts`, `open()` method, after the
`onDidReceiveMessage` registration (line ~1306).

### Change 2: `onDidDispose` — clear broadcaster's webview reference

In both `onDidDispose` callbacks (the one in `open()` at line 1308 and the
one in `deserializeWebviewPanel()` at line 1376), add
`this._broadcaster?.setWebview(null)` to clear the stale reference.

This is defense-in-depth: any messages sent between dispose and reopen will
be queued in the broadcaster's `_pendingWebviewMessages` (which is flushed
when `setWebview` is called with the new webview) rather than silently
dropped to a dead webview.

**Location:** `src/services/KanbanProvider.ts`, both `onDidDispose` blocks.

## Verification Plan

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
