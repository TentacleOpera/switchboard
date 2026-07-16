# Fix Setup Panel Stale Broadcaster After Verb-Triggered Initialization

## Goal

Fix the narrow stale-broadcaster bug in `SetupPanelProvider` where an
HTTP verb request initializes the `_broadcaster` singleton, and
subsequent routine tab close/reopen cycles (which the Setup panel does
on EVERY tab hide, since `retainContextWhenHidden: false`) leave the
broadcaster pointing at a dead webview — silently losing all
`postMessage()` calls until an IDE restart.

### Problem

`SetupPanelProvider` has `retainContextWhenHidden: false` (line 164) —
the webview is destroyed on every tab hide, by design. The panel has no
`registerWebviewPanelSerializer`, so it never restores via
`deserializeWebviewPanel()` after an IDE restart; it is always recreated
fresh via `open()`.

In the normal flow, `_broadcaster` stays `undefined` because `open()`
never calls `_initSetupService()`. `postMessage()` takes the `else`
branch → direct `this._panel?.webview.postMessage()` → works. The `ready`
handler calls `postSetupPanelState()` which rehydrates everything.

The bug manifests in a narrow window: **if an HTTP verb request
(`handleServiceVerb`) fires while the panel is open**, it calls
`_initSetupService()` (line 45), which creates the broadcaster and
captures the current panel's webview. After that, a routine tab-close
destroys the webview, but `onDidDispose` (line 178) only nulls `_panel`
— it does NOT clear the broadcaster's webview reference. On the next
`open()`, the broadcaster still exists with its stale webview reference.
All `postMessage()` calls now route through `_broadcaster.push()` → dead
webview → silently lost. And it doesn't self-heal — `open()` never calls
`_initSetupService()`, so the stale broadcaster persists across all
future open/close cycles until another verb call or IDE restart.

### Background

The Setup panel's `_broadcaster` is a `BroadcastHub` singleton field
that outlives the panel. It is created in `_initSetupService()` (line
68) and captures `this._panel?.webview` at creation time.
`_initSetupService()` is only called from `handleServiceVerb()` (line
45) — `open()` never calls it.

`postMessage()` (line 183) has two branches:
- **Branch A — `_broadcaster` exists:** delegates to
  `_broadcaster.push()`, which sends to the captured webview.
- **Branch B — no `_broadcaster`:** sends directly to
  `this._panel?.webview.postMessage()`.

The bug is that once Branch A is activated (by a verb call), it never
reverts to Branch B on panel disposal/recreation.

### Root Cause

1. **Verb request fires** while panel is open → `handleServiceVerb()`
   calls `_initSetupService()` → broadcaster created, captures current
   webview.

2. **Tab hidden** (routine — `retainContextWhenHidden: false`) →
   `onDidDispose` fires, nulls `_panel`, but does NOT clear the
   broadcaster's webview reference.

3. **Tab reopened** via `open()` → creates a fresh panel but never
   calls `_initSetupService()`. Broadcaster still points at the dead
   webview.

4. **All `postMessage()` calls silently lost.** `ready` fires →
   `postSetupPanelState()` → `postMessage()` → `_broadcaster.push()` →
   dead webview. Panel appears blank.

### Why it's narrow

- Requires a verb request to fire while the panel is open (uncommon for
  the Setup panel — it's config UI, not a high-traffic verb target).
- The Setup panel is lower-stakes: it rehydrates from
  `postSetupPanelState()` on `ready`, so if the broadcaster were
  re-pointed, recovery is automatic.
- An IDE restart clears it (no serializer → fresh `open()` → broadcaster
  stays undefined until the next verb call).

But once triggered, it persists across every subsequent open/close cycle
— the panel is permanently broken until restart. That's a real UX bug
worth fixing.

## Metadata
**Complexity:** 2
**Tags:** bugfix, ui, reliability

## Complexity Audit

### Routine
- Single-file change (`src/services/SetupPanelProvider.ts`)
- Two localized edits: one `_initSetupService()` call in `open()`, one
  `setWebview(null)` in `onDidDispose`
- Mirrors the proven KanbanProvider fix pattern
- No new architectural patterns, no root-recovery subsystem needed
- Lowest risk, smallest scope of the three provider fixes

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:**
- Messages sent between `onDidDispose` (clears broadcaster webview) and
  `open()` (re-inits broadcaster) are queued in the broadcaster's
  `_pendingWebviewMessages` and flushed when the new webview is set. No
  race.
- If `_getCurrentWorkspaceRoot()` returns null when
  `_initSetupService()` is called, the broadcaster is set to `undefined`
  and `postMessage()` falls back to direct
  `this._panel?.webview.postMessage()`. Messages are still delivered.
  `_getCurrentWorkspaceRoot()` delegates to
  `this._kanbanProvider?.getCurrentWorkspaceRoot()` with a fallback to
  the first workspace folder — synchronous, no startup race.

**Security:**
- No security implications. Internal message routing only.

**Side Effects:**
- Calling `_initSetupService()` in `open()` will create the broadcaster
  eagerly (even without a verb request). This is a behavior change: the
  normal flow now uses Branch A (`_broadcaster.push()`) instead of
  Branch B (direct `postMessage`). This is safe — `BroadcastHub.push()`
  with a live webview is functionally equivalent to direct
  `postMessage()`, plus it mirrors to WS clients (an improvement, not a
  regression). The pending-queue behavior is identical.
- Stale messages queued in the broadcaster's pending queue between
  dispose and reopen will be flushed to the new webview. These are
  overwritten by the fresh `postSetupPanelState()` flow on `ready`.

**Dependencies & Conflicts:**
- No external dependencies. Uses existing methods
  (`_initSetupService()`, `setWebview()`).
- No conflicts with other plans or in-flight work.
- Same `BroadcastHub` class as the KanbanProvider / PlanningPanel /
  DesignPanel fixes — the pattern is proven.

## Dependencies

- None. This fix is independent of the other provider fixes. It can be
  merged before or after the Planning/Design plan.

## Adversarial Synthesis

Key risks: (1) Eagerly initializing the broadcaster in `open()` changes
the normal flow from Branch B to Branch A — but this is safe because
`BroadcastHub.push()` with a live webview is functionally identical to
direct `postMessage()`, and the WS mirror is a bonus, not a regression;
(2) `_getCurrentWorkspaceRoot()` could return null if
`_kanbanProvider` is not yet attached and no workspace folders exist —
but `_initSetupService()` handles this by setting `_broadcaster =
undefined`, and `postMessage()` falls back to Branch B. Self-mitigating;
(3) the Setup panel has no `deserializeWebviewPanel` — only `open()`
needs the fix, simplifying the change. No root-recovery subsystem needed
(unlike KanbanProvider) because `_getCurrentWorkspaceRoot()` is
synchronous.

## Proposed Changes

### `src/services/SetupPanelProvider.ts`

**Context:** `open()` (line 137) never calls `_initSetupService()`. The
broadcaster is only initialized via `handleServiceVerb()` (line 45).
Once a verb call initializes it, routine tab close/reopen leaves the
broadcaster pointing at the dead webview.

**Logic:** Mirror the KanbanProvider fix: call `_initSetupService()`
after the panel is created in `open()`, and add
`_broadcaster?.setWebview(null)` in `onDidDispose`.

**Implementation:**

#### Change 1: `open()` — call `_initSetupService()` after panel creation

In `SetupPanelProvider.open()`, after the panel is created, HTML is set,
and `onDidReceiveMessage` is registered (after line 176, before the
`onDidDispose` registration at line 178), call
`this._initSetupService()`.

This ensures the broadcaster's webview reference is updated to the new
panel on every open, regardless of whether a verb request has fired.

**Location:** `src/services/SetupPanelProvider.ts`, `open()` method,
after line 176 (`onDidReceiveMessage` registration), before line 178
(`onDidDispose` registration).

#### Change 2: `onDidDispose` — clear broadcaster's webview reference

In the `onDidDispose` callback in `open()` (line 178-180), add
`this._broadcaster?.setWebview(null)` after `this._panel = undefined`.

This is defense-in-depth: any messages sent between dispose and reopen
will queue in the broadcaster's `_pendingWebviewMessages` (flushed on
the next `setWebview`) rather than being silently dropped to the dead
webview.

**Location:** `src/services/SetupPanelProvider.ts`, `open()` method,
line 179 (inside the `onDidDispose` callback), after
`this._panel = undefined`.

**Edge Cases:**
- If `_broadcaster` is undefined (no verb request ever initialized it,
  and `_initSetupService()` in `open()` found no workspace root),
  `this._broadcaster?.setWebview(null)` is a no-op. Safe.
- If `_getCurrentWorkspaceRoot()` returns null when
  `_initSetupService()` is called in `open()`, the broadcaster is set
  to undefined and `postMessage()` falls back to direct
  `this._panel?.webview.postMessage()`. Messages are still delivered.
  The Setup panel rehydrates from `postSetupPanelState()` on `ready`.
- Eagerly calling `_initSetupService()` in `open()` means the
  broadcaster is now created on first open (not just on verb requests).
  This switches the normal flow from Branch B to Branch A. This is safe:
  `BroadcastHub.push()` with a live webview is functionally identical
  to direct `postMessage()`, plus it mirrors to WS clients. No
  regression.

## Verification Plan

### Automated Tests

Automated tests and compilation are skipped per session directive. All
verification is manual.

### Manual Verification

1. **Reproduce the original bug** (before the fix):
   - Open the Setup panel.
   - Trigger a verb request via LocalApiServer (e.g. any setup verb)
     while the panel is open.
   - Close the Setup tab (routine hide — `retainContextWhenHidden:
     false`).
   - Reopen the Setup tab.
   - Confirm: panel appears blank, `postSetupPanelState()` messages lost
     (the bug).

2. **Verify the fix** (after applying both changes):
   - Same reproduction steps as above.
   - Confirm: Setup panel loads correctly on reopen, all sections
     functional, integration states render.
   - Confirm: no IDE restart required.

3. **Regression check — normal flow (no verb request):**
   - Open Setup, switch to another tab, switch back.
   - Confirm: panel rehydrates correctly via `postSetupPanelState()` on
     `ready`.

4. **Regression check — extension reload:**
   - Open Setup, reload the VS Code window.
   - Confirm: panel is gone (no serializer), reopens fresh via command.
   - Confirm: Setup panel loads correctly on first open.

5. **Regression check — verb requests after reopen:**
   - With the API server running, hit a setup verb endpoint after a
     panel close/reopen cycle.
   - Confirm: the verb response reaches the webview (broadcaster path
     works after the fix).

6. **Edge case — no workspace root:**
   - Open Setup with no workspace folders mapped.
   - Confirm: `_initSetupService()` sets broadcaster to undefined,
     `postMessage()` falls back to direct `postMessage`. Panel still
     loads (Setup panel handles no-workspace state gracefully).

---

**Recommendation:** Complexity 2 → Send to Intern.
