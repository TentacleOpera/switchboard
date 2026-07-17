# Fix Planning & Design Panels Lose Messages on Tab Reopen Under Memory Pressure

## Goal

Apply the same stale-broadcaster fix from the KanbanProvider plan
(`fix-kanban-stale-broadcaster-on-reopen.md`) to the two other major
providers that share the identical bug: `PlanningPanelProvider` and
`DesignPanelProvider`. Both use `retainContextWhenHidden: true`, so the
bug is latent under normal conditions but surfaces when VS Code destroys
the webview under memory pressure — the panel reopens but all
host→webview messages are silently lost to the dead broadcaster.

### Problem

Both `PlanningPanelProvider` and `DesignPanelProvider` have a
`_broadcaster?: BroadcastHub` singleton field that outlives the panel.
The broadcaster is created in `_initPlanningService()` /
`_initDesignService()` and captures `this._panel?.webview` at creation
time. These init methods are **only called from `handleServiceVerb()`**
(the HTTP verb entry point) — neither `open()` nor
`deserializeWebviewPanel()` calls them.

Once a verb request initializes the broadcaster, it captures the current
panel's webview. When the panel is later destroyed (memory pressure) and
reopened, the broadcaster still points at the dead webview. All
`postMessageToWebview()` / `postMessage()` calls route through
`_broadcaster.push()` → dead webview → messages silently lost. The panel
appears blank or frozen.

### Background

The bug is identical in structure to the KanbanProvider bug. The fix
pattern is proven: add `_init*Service()` after panel creation in both
`open()` and `deserializeWebviewPanel()`, and add
`_broadcaster?.setWebview(null)` in `onDidDispose` as defense-in-depth.

**Key difference from KanbanProvider:** These providers do NOT have a
`_resolveWorkspaceRoot()` method with auto-select logic. Their
`_getWorkspaceRoot()` is an injected function (constructor parameter)
that returns `string | undefined`. If it returns undefined at init time,
`_init*Service()` sets `_broadcaster = undefined` and returns —
`postMessage()` then falls back to direct `this._panel?.webview.postMessage()`,
which works. So the null-root edge case is self-mitigating: no
root-recovery subsystem is needed (unlike KanbanProvider).

### Root Cause

1. **Broadcaster initialized** via `handleServiceVerb()` → captures
   `this._panel?.webview` at that moment.

2. **Panel destroyed** (memory pressure) → `onDidDispose` fires, nulls
   `_panel`, but does NOT clear the broadcaster's webview reference.

3. **Panel reopened** via `open()` or `deserializeWebviewPanel()` →
   creates a fresh panel but never calls `_init*Service()`. The
   broadcaster still points at the dead webview.

4. **All host→webview messages silently lost.** `postMessageToWebview()`
   / `postMessage()` routes through `_broadcaster.push()` → dead webview.

### Why a full restart fixes it

A restart triggers `deserializeWebviewPanel()`, which (after this fix)
calls `_init*Service()` → `_broadcaster.setWebview(newWebview)`. The
broadcaster is aligned with the live panel, and messages flow correctly.

## Metadata
**Complexity:** 3
**Tags:** bugfix, ui, reliability

## User Review Required

Yes — review the corrected `_pushTo()` rationale (Change 2 and the
PlanningPanelProvider Edge Cases) and the idempotency Clarification below
before dispatch. The fix scope and approach are unchanged from the prior
version; only the reasoning behind the `!isProject` guard was corrected
(the conclusion stands). No new product scope added.

## Complexity Audit

### Routine
- Two-file change (`PlanningPanelProvider.ts`, `DesignPanelProvider.ts`)
- Mirrors the proven KanbanProvider fix pattern exactly
- Each provider gets: one `_init*Service()` call in `open()`, one in
  `deserializeWebviewPanel()`, and `setWebview(null)` in each
  `onDidDispose` block
- No new architectural patterns, no root-recovery subsystem needed
- Low risk, small scope

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:**
- Messages sent between `onDidDispose` (clears broadcaster webview) and
  `open()` (re-inits broadcaster) are queued in the broadcaster's
  `_pendingWebviewMessages` and flushed when the new webview is set. No
  race — the queue bridges the gap.
- If `_getWorkspaceRoot()` returns undefined when `_init*Service()` is
  called, the broadcaster is set to `undefined` and `postMessage()` /
  `postMessageToWebview()` falls back to direct
  `this._panel?.webview.postMessage()`. Messages are still delivered.
  No root-recovery needed — the injected `_getWorkspaceRoot()` is a
  simple synchronous lookup, not an async resolver with a startup race.

**Security:**
- No security implications. The fix only affects internal message
  routing between the extension host and the webview.

**Side Effects:**
- Stale messages queued in the broadcaster's pending queue between
  dispose and reopen will be flushed to the new webview. These are
  overwritten by the fresh `ready` → state rehydration flow. Cosmetic
  flicker risk is transient and bounded.
- `onDidDispose` clearing the broadcaster webview reference does NOT
  destroy the broadcaster itself — it remains alive with a null webview.
  `_init*Service()` updates it via `setWebview()` on reopen.

**Dependencies & Conflicts:**
- No external dependencies. The fix uses existing methods
  (`_init*Service()`, `setWebview()`) already proven in
  `handleServiceVerb()`.
- No conflicts with other plans or in-flight work.
- Depends on the KanbanProvider fix being merged first (same pattern,
  same `BroadcastHub` class — the Kanban fix validated the approach).

## Dependencies

- The KanbanProvider fix (`fix-kanban-stale-broadcaster-on-reopen.md`)
  should be merged first. It validates the same fix pattern against the
  same `BroadcastHub` class. This plan reuses the proven approach.

## Adversarial Synthesis

Key risks: (1) null-root at init time sets `_broadcaster = undefined` —
self-mitigating via the direct `this._panel?.webview.postMessage()`
fallback, and the injected `_getWorkspaceRoot()` is synchronous (no
startup race like KanbanProvider's async `_resolveWorkspaceRoot()`);
(2) PlanningPanelProvider's `onDidDispose` calls full `dispose()` (line
9758, tears down `_disposables`) while DesignPanelProvider's does not —
but the broadcaster is NOT in `_disposables` in either provider, so it
survives both paths and `setWebview(null)` ordering is safe either way;
(3) the `!isProject` guard is required because `_initPlanningService()`
binds the broadcaster to `this._panel` (the main-panel field), not the
`panel` argument — calling it during project hydration would misbind.
Mitigations: idempotent create-once-then-`setWebview` broadcaster init
(verified in code), explicit-webview `pushTo()` delivery for the project
panel, and the merged KanbanProvider fix proving the same pattern.

> **Superseded:** The project panel uses `_pushTo()` which calls
> `pushTo(panel.webview, ...)` directly, so it is NOT affected by the
> stale broadcaster.
> **Reason:** `_pushTo()` (PlanningPanelProvider.ts lines 992-997) does
> NOT bypass the broadcaster — it calls `this._broadcaster.pushTo(panel?.webview, surface, message)` when the broadcaster exists, only
> falling back to direct `panel?.webview.postMessage()` when
> `_broadcaster` is undefined. The project panel's webview delivery is
> unaffected by a stale BOUND webview because `BroadcastHub.pushTo()`
> (broadcastHub.ts line 94) delivers to the EXPLICIT webview argument
> and ignores the bound `_target.webview` — not because the broadcaster
> is bypassed.
> **Replaced with:** The project panel's webview delivery is unaffected
> by a stale bound webview because `broadcaster.pushTo()` routes to the
> explicit project-panel webview argument. The `!isProject` guard on
> `_initPlanningService()` is required for a different reason:
> `_initPlanningService()` binds the broadcaster to `this._panel?.webview`
> (the main-panel field), not the `panel` argument passed to
> `_hydratePanel()` — calling it during project hydration would misbind
> the broadcaster to the main panel's (possibly stale/undefined) webview.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`

**Context:** `open()` (line 684) and `deserializeWebviewPanel()` →
`_hydratePanel()` (line 822) never call `_initPlanningService()`. The
broadcaster is only initialized via `handleServiceVerb()` (line 80).
After a verb call initializes the broadcaster and the panel is later
destroyed + reopened, the broadcaster points at the dead webview.

**Clarification — idempotency (verified in code):** `_initPlanningService()`
(lines 100-113) is safe to call on every open/deserialize. The broadcaster
branch is `if (!this._broadcaster) { this._broadcaster = new BroadcastHub({ webview: this._panel?.webview, apiServer: null }); } else { this._broadcaster.setWebview(this._panel?.webview); }` — create-once, then
update the webview on subsequent calls. The broadcaster is NEVER pushed
into `this._disposables`, so `dispose()` (line 9758) does not tear it
down — it survives with a null webview after `setWebview(null)`, exactly
as the defense-in-depth intends. `_hostSeams` is rebuilt each call, but
this is existing behavior (`handleServiceVerb()` already rebuilds it on
every verb request) and seams are a stateless function bundle, not a
disposable registration — no leak introduced. This matches the merged
KanbanProvider fix, which uses the identical pattern.

**Logic:** Mirror the KanbanProvider fix: call
`_initPlanningService()` after the panel is created in both `open()` and
`_hydratePanel()`, and add `_broadcaster?.setWebview(null)` in each
`onDidDispose` block.

**Implementation:**

#### Change 1: `open()` — call `_initPlanningService()` after panel creation

In `PlanningPanelProvider.open()`, after the panel is created, HTML is
set, and `onDidReceiveMessage` is registered (after line 728, before the
`onDidDispose` registration at line 730), call
`this._initPlanningService()`.

This ensures the broadcaster's webview reference is updated to the new
panel on every open, not just when a verb request happens to fire.

**Location:** `src/services/PlanningPanelProvider.ts`, `open()` method,
after line 728 (`onDidReceiveMessage` registration), before line 730
(`onDidDispose` registration).

#### Change 2: `_hydratePanel()` — call `_initPlanningService()` for the planning panel only

In `_hydratePanel()`, after the panel's HTML is set and
`onDidReceiveMessage` is registered (after line 851), call
`this._initPlanningService()` — but ONLY when `!isProject` (the planning
panel).

> **Superseded:** The project panel uses `_pushTo()` which bypasses the
> broadcaster for webview delivery, so it does not need broadcaster
> initialization.
> **Reason:** `_pushTo()` (lines 992-997) does NOT bypass the
> broadcaster — it calls `this._broadcaster.pushTo(panel?.webview, surface, message)` when the broadcaster exists. The project panel's
> webview delivery is unaffected by a stale BOUND webview because
> `BroadcastHub.pushTo()` delivers to the explicit webview argument, not
> the bound `_target.webview`.
> **Replaced with:** The `!isProject` guard is required because
> `_initPlanningService()` binds the broadcaster to `this._panel?.webview`
> (the main-panel field), NOT the `panel` argument passed to
> `_hydratePanel()`. Calling it during project hydration would misbind
> the broadcaster to the main panel's (possibly stale or undefined)
> webview. The project panel does not need its own broadcaster init
> because its delivery path (`_pushTo()` → `broadcaster.pushTo(projectWebview, ...)`) uses the explicit project webview and is
> independent of the bound webview.

**Location:** `src/services/PlanningPanelProvider.ts`, `_hydratePanel()`
method, after line 851, guarded by `if (!isProject)`.

#### Change 3: `open()` `onDidDispose` — clear broadcaster's webview reference

In the `onDidDispose` callback in `open()` (line 730-736), add
`this._broadcaster?.setWebview(null)` BEFORE `this.dispose()` is called.
This ensures the broadcaster reference is cleared while the provider
state is still intact, before `dispose()` tears down `_disposables`.

**Location:** `src/services/PlanningPanelProvider.ts`, `open()` method,
line 731 (inside the `onDidDispose` callback), before `this.dispose()`.

#### Change 4: `_hydratePanel()` planning `onDidDispose` — clear broadcaster's webview reference

In the planning panel's `onDidDispose` callback in `_hydratePanel()`
(line 886-888), add `this._broadcaster?.setWebview(null)` before
`this.dispose()`.

**Location:** `src/services/PlanningPanelProvider.ts`, `_hydratePanel()`
method, line 887 (inside the `else` branch `onDidDispose`), before
`this.dispose()`.

**Edge Cases:**
- If `_broadcaster` is undefined (no verb request ever initialized it),
  `this._broadcaster?.setWebview(null)` is a no-op. Safe.
- If `_getWorkspaceRoot()` returns undefined when
  `_initPlanningService()` is called, the broadcaster is set to
  undefined and `postMessageToWebview()` falls back to direct
  `this._panel?.webview.postMessage()`. Messages are still delivered.
- The project panel (`isProject === true`) is NOT touched by this fix.
  Its delivery path is `_pushTo()` → `this._broadcaster.pushTo(panel?.webview, surface, message)` (lines 992-997), which delivers to the
  EXPLICIT project-panel webview argument — independent of the
  broadcaster's bound `_target.webview`. A stale bound webview therefore
  cannot poison project-panel delivery. (When `_broadcaster` is
  undefined, `_pushTo()` falls back to direct `panel?.webview.postMessage()`, losing the WS mirror but still delivering to the
  webview — this is existing behavior the fix does not change.) The
  project panel has its own `onDidDispose` (line 862) that clears
  `_projectPanel` and related state — no broadcaster change needed there.

---

### `src/services/DesignPanelProvider.ts`

**Context:** `open()` (line 430) and `deserializeWebviewPanel()` (line
534) never call `_initDesignService()`. The broadcaster is only
initialized via `handleServiceVerb()` (line 65). Same stale-broadcaster
bug as PlanningPanelProvider.

**Clarification — onDidDispose asymmetry (verified in code):** Unlike
PlanningPanelProvider, DesignPanelProvider's `onDidDispose` (lines
462-466 and 563-567) does NOT call `dispose()`. It nulls `_panel`, calls
`disposeWatchers()`, and `_stopExternalFilePoll()`. The full `dispose()`
method exists (line 646) but is not invoked from `onDidDispose`. This
asymmetry is harmless to the fix: the broadcaster is not in `_disposables`
in either provider, so it survives both dispose paths. The plan adds
`setWebview(null)` after `this._panel = undefined` in both
DesignPanelProvider `onDidDispose` blocks, consistent with the actual
code (which does not call `dispose()`). Flagged here so the asymmetry is
explicit, not implicit.

**Logic:** Mirror the same fix: call `_initDesignService()` after panel
creation in both `open()` and `deserializeWebviewPanel()`, and add
`_broadcaster?.setWebview(null)` in each `onDidDispose` block.

**Implementation:**

#### Change 1: `open()` — call `_initDesignService()` after panel creation

In `DesignPanelProvider.open()`, after the panel is created, HTML is
set, and `onDidReceiveMessage` is registered (after line 460, before the
`onDidDispose` registration at line 462), call
`this._initDesignService()`.

**Location:** `src/services/DesignPanelProvider.ts`, `open()` method,
after line 460 (`onDidReceiveMessage` registration), before line 462
(`onDidDispose` registration).

#### Change 2: `deserializeWebviewPanel()` — call `_initDesignService()` after panel restoration

In `deserializeWebviewPanel()`, after the panel's HTML is set and
`onDidReceiveMessage` is registered (after line 561), call
`this._initDesignService()`.

**Location:** `src/services/DesignPanelProvider.ts`,
`deserializeWebviewPanel()` method, after line 561
(`onDidReceiveMessage` registration), before line 563 (`onDidDispose`
registration).

#### Change 3: `open()` `onDidDispose` — clear broadcaster's webview reference

In the `onDidDispose` callback in `open()` (line 462-466), add
`this._broadcaster?.setWebview(null)` after `this._panel = undefined`.

**Location:** `src/services/DesignPanelProvider.ts`, `open()` method,
line 463 (inside the `onDidDispose` callback), after
`this._panel = undefined`.

#### Change 4: `deserializeWebviewPanel()` `onDidDispose` — clear broadcaster's webview reference

In the `onDidDispose` callback in `deserializeWebviewPanel()` (line
563-567), add `this._broadcaster?.setWebview(null)` after
`this._panel = undefined`.

**Location:** `src/services/DesignPanelProvider.ts`,
`deserializeWebviewPanel()` method, line 564 (inside the
`onDidDispose` callback), after `this._panel = undefined`.

**Edge Cases:**
- If `_broadcaster` is undefined (no verb request ever initialized it),
  `this._broadcaster?.setWebview(null)` is a no-op. Safe.
- If `_getWorkspaceRoot()` returns undefined when
  `_initDesignService()` is called, the broadcaster is set to undefined
  and `postMessage()` falls back to direct
  `this._panel?.webview.postMessage()`. Messages are still delivered.
- The `ready` handler (line 2034) fires a large barrage of
  `postMessage()` calls. After the fix, these will reach the live webview
  via the re-initialized broadcaster. Before the fix, they were all
  silently lost.

## Verification Plan

### Automated Tests

Automated tests and compilation are skipped per session directive. All
verification is manual.

### Manual Verification

1. **Reproduce the original bug** (before the fix):
   - Open the Planning panel. Trigger a verb request (e.g. via
     LocalApiServer) to initialize the broadcaster.
   - Simulate memory pressure disposal: close the Planning tab with
     `retainContextWhenHidden` overridden.
   - Reopen the Planning tab.
   - Confirm: panel appears blank, messages lost (the bug).
   - Repeat for the Design panel.

2. **Verify the fix** (after applying all changes):
   - Same reproduction steps as above.
   - Confirm: Planning panel loads correctly on reopen, all tabs
     functional, local docs / kanban plans / dev docs render.
   - Confirm: Design panel loads correctly on reopen, all tabs
     functional, stitch / html-preview / images / design render.

3. **Regression check — normal flow (no disposal):**
   - Open Planning, switch to another tab, switch back.
   - Confirm: panel remains populated, no flicker or data loss.
   - Repeat for Design panel.

4. **Regression check — extension reload:**
   - Open Planning, reload the VS Code window.
   - Confirm: panel restores via `deserializeWebviewPanel`, content
     loads.
   - Repeat for Design panel.

5. **Regression check — verb requests after reopen:**
   - With the API server running, hit a planning/design verb endpoint
     after a panel close/reopen cycle.
   - Confirm: the verb response reaches the webview (broadcaster path
     works after the fix).

6. **Regression check — Planning project panel:**
   - Open the Project panel (separate from Planning panel).
   - Close and reopen the Planning panel.
   - Confirm: Project panel is unaffected (uses `_pushTo`, not the
     broadcaster's bound webview).

---

**Recommendation:** Complexity 3 → Send to Intern.

## Completion Report

Implemented the stale-broadcaster fix in `src/services/PlanningPanelProvider.ts` and `src/services/DesignPanelProvider.ts`. Both providers now call their respective `_init*Service()` methods after panel creation in `open()` and `deserializeWebviewPanel()`/`_hydratePanel()` (planning only, guarded by `!isProject`), and clear the broadcaster’s webview reference with `_broadcaster?.setWebview(null)` in each `onDidDispose` block. The project panel path is intentionally left unchanged because `_pushTo()` delivers via the explicit project webview. No compilation or tests were run per the session skip directives. No issues encountered; the diff matches the plan exactly.
