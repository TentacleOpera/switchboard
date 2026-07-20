# Fix Setup Panel Stale Broadcaster After Verb-Triggered Initialization

## Goal

Fix the narrow stale-broadcaster bug in `SetupPanelProvider` where an
HTTP verb request initializes the `_broadcaster` singleton, and
subsequent routine tab close/reopen cycles (which the Setup panel does
on EVERY tab hide, since `retainContextWhenHidden: false`) leave the
broadcaster pointing at a dead webview — silently losing all
`postMessage()` calls until an IDE restart.

### Problem

`SetupPanelProvider` has `retainContextWhenHidden: false` (line 185) —
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
destroys the webview, but `onDidDispose` (line 199) only nulls `_panel`
— it does NOT clear the broadcaster's webview reference. On the next
`open()`, the broadcaster still exists with its stale webview reference.
All `postMessage()` calls now route through `_broadcaster.push()` → dead
webview → silently lost. And it doesn't self-heal — `open()` never calls
`_initSetupService()`, so the stale broadcaster persists across all
future open/close cycles until another verb call or IDE restart.

### Background

The Setup panel's `_broadcaster` is a `BroadcastHub` singleton field
that outlives the panel. It is created in `_initSetupService()` (line
72) and captures `this._panel?.webview` at creation time.
`_initSetupService()` is only called from `handleServiceVerb()` (line
45) — `open()` never calls it.

`postMessage()` (line 204) has two branches:
- **Branch A — `_broadcaster` exists:** delegates to
  `_broadcaster.push()`, which sends to the captured webview.
- **Branch B — no `_broadcaster`:** sends directly to
  `this._panel?.webview.postMessage()`.

The bug is that once Branch A is activated (by a verb call), it never
reverts to Branch B on panel disposal/recreation.

### Root Cause

1. **Verb request fires** while panel is open → `handleServiceVerb()`
   calls `_initSetupService()` → broadcaster created, captures current
   webview. `_hostSeams` and `_setupService` are now set, so the guard
   at `handleServiceVerb` line 44 (`if (!this._setupService && !this._hostSeams)`)
   means every subsequent verb call SKIPS `_initSetupService()` — the
   verb path can never re-point the broadcaster after the first call.

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

## User Review Required

Yes — this plan corrects a defect in the original approach discovered
during the improve pass (the `_initSetupService()` early-return guard
makes a bare "call `_initSetupService()` in `open()`" a no-op in the
exact bug scenario). Reviewer should confirm the corrected Change 1
(modify the early-return to re-point the webview) is acceptable before
coding.

## Complexity Audit

### Routine
- Single-file change (`src/services/SetupPanelProvider.ts`)
- Three localized edits: (1) re-point webview in `_initSetupService()`
  early-return branch, (2) call `_initSetupService()` in `open()` after
  panel creation, (3) `setWebview(null)` in `onDidDispose`
- Mirrors the proven KanbanProvider fix pattern (`_initKanbanService()`
  always re-points the broadcaster; `setWebview(null)` in dispose
  handlers at lines 1415 and 1513)
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
  eagerly (even without a verb request) when a workspace root resolves.
  This is a behavior change: the normal flow now uses Branch A
  (`_broadcaster.push()`) instead of Branch B (direct `postMessage`).
  This is safe — `BroadcastHub.push()` with a live webview is
  functionally equivalent to direct `postMessage()`, plus it mirrors to
  WS clients (an improvement, not a regression). The pending-queue
  behavior is identical. When no workspace root resolves, `_broadcaster`
  stays `undefined` and Branch B is used — no unconditional switch.
- Modifying the `_initSetupService()` early-return branch to call
  `setWebview(this._panel?.webview)` affects the `handleServiceVerb`
  call site too. This is safe: when a verb fires with the panel open,
  `this._panel?.webview` is the current live webview, so re-pointing is
  a no-op. When a verb fires with no panel, `this._panel?.webview` is
  `undefined`, so `setWebview(undefined)` clears the ref (harmless —
  `push()` will queue until a panel opens).
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

Key risks: (1) the original "just call `_initSetupService()` in `open()`"
approach is a no-op in the bug scenario because of the early-return guard
at line 75-77 — corrected by re-pointing the webview inside the
early-return branch; (2) modifying the shared `_initSetupService()` method
affects the `handleServiceVerb` call site, but re-pointing to the current
live webview is a no-op there; (3) `_getCurrentWorkspaceRoot()` returning
null leaves `_broadcaster` undefined and `postMessage()` on Branch B —
self-mitigating. No root-recovery subsystem needed (unlike KanbanProvider)
because `_getCurrentWorkspaceRoot()` is synchronous.

## Proposed Changes

### `src/services/SetupPanelProvider.ts`

**Context:** `open()` (line 158) never calls `_initSetupService()`. The
broadcaster is only initialized via `handleServiceVerb()` (line 45).
Once a verb call initializes it, routine tab close/reopen leaves the
broadcaster pointing at the dead webview. Additionally,
`_initSetupService()` has an early-return guard at line 75-77
(`if (this._hostSeams) return;`) that skips the `setWebview()` call —
so even calling `_initSetupService()` from `open()` would NOT re-point
the broadcaster after a verb call already set `_hostSeams`. KanbanProvider's
`_initKanbanService()` (line 6753) has no such guard and always re-points;
this plan makes SetupPanelProvider match that shape.

**Logic:** Three edits in one file: (1) fix the `_initSetupService()`
early-return to re-point the broadcaster webview before returning, so the
method always re-points regardless of entry path; (2) call
`_initSetupService()` in `open()` after the panel is created and the
message handler is registered; (3) add `_broadcaster?.setWebview(null)`
in `onDidDispose` so messages between dispose and reopen queue instead of
dropping to a dead webview.

**Implementation:**

#### Change 1: `_initSetupService()` — re-point webview in the early-return branch

> **Superseded:** The original plan's Change 1 was "call
> `_initSetupService()` in `open()` after panel creation" with no
> modification to `_initSetupService()` itself, on the assumption that
> this mirrors KanbanProvider's `_initKanbanService()`.
> **Reason:** `_initSetupService()` has an early-return guard at line
> 75-77 (`if (this._hostSeams) return;`) that KanbanProvider's
> `_initKanbanService()` does NOT have. After a verb call sets
> `_hostSeams`, every subsequent `_initSetupService()` call returns at
> line 76 WITHOUT reaching the `setWebview()` call at line 89. So the
> original Change 1 is a no-op in the exact bug scenario it targets
> (verb already fired → `_hostSeams` set → reopen calls
> `_initSetupService()` → early return → broadcaster still stale). The
> "mirrors KanbanProvider" claim was true at the call site but false at
> the method body.
> **Replaced with:** Modify the early-return branch in
> `_initSetupService()` to re-point the broadcaster webview before
> returning, so the method always re-points like KanbanProvider's does.
> This is the root-cause fix; Change 1b below is the call-site change
> that exercises it.

In `_initSetupService()` (line 72), the early-return branch at lines
75-77 currently reads:

```ts
if (this._hostSeams) {
    return;
}
```

Replace with:

```ts
if (this._hostSeams) {
    // Seams already derived (prior verb call or test-harness injection).
    // Do NOT re-derive workspace root, but DO re-point the broadcaster
    // at the current panel webview — otherwise a tab close/reopen cycle
    // leaves the broadcaster pointing at a dead webview and every
    // postMessage() silently drops. Mirrors KanbanProvider's
    // _initKanbanService(), which has no early-return and always re-points.
    this._broadcaster?.setWebview(this._panel?.webview);
    return;
}
```

**Location:** `src/services/SetupPanelProvider.ts`, `_initSetupService()`
method, lines 75-77.

**Safety:**
- `handleServiceVerb` call site: when a verb fires with the panel open,
  `this._panel?.webview` is the current live webview — `setWebview` to
  the same ref is a no-op. When a verb fires with no panel, the webview
  arg is `undefined` — `setWebview(undefined)` clears the ref, and
  `push()` queues until a panel opens. Both safe.
- Test-seam path: test harnesses inject `_hostSeams` without a panel;
  `this._panel?.webview` is `undefined`, `setWebview(undefined)` is a
  no-op. Safe.

#### Change 1b: `open()` — call `_initSetupService()` after panel creation

In `SetupPanelProvider.open()`, after the panel is created, HTML is set,
and `onDidReceiveMessage` is registered (after line 197, before the
`onDidDispose` registration at line 199), call `this._initSetupService()`.

This ensures the broadcaster's webview reference is updated to the new
panel on every open, regardless of whether a verb request has fired.
With Change 1 in place, `_initSetupService()` re-points the broadcaster
even when `_hostSeams` is already set.

**Location:** `src/services/SetupPanelProvider.ts`, `open()` method,
after line 197 (`onDidReceiveMessage` registration), before line 199
(`onDidDispose` registration).

**Note on the `open()` early-return branch:** `open()` has an early
return at lines 163-171 when `this._panel` already exists (panel is
open — just reveal). This branch does NOT need `_initSetupService()`
because the panel and its webview are already live, so the broadcaster
ref is already live (or undefined). Do NOT add `_initSetupService()` to
this branch — it would be redundant and could confuse future readers.

#### Change 2: `onDidDispose` — clear broadcaster's webview reference

In the `onDidDispose` callback in `open()` (lines 199-201), add
`this._broadcaster?.setWebview(null)` after `this._panel = undefined`.

This is defense-in-depth: any messages sent between dispose and reopen
will queue in the broadcaster's `_pendingWebviewMessages` (flushed on
the next `setWebview`) rather than being silently dropped to the dead
webview.

**Location:** `src/services/SetupPanelProvider.ts`, `open()` method,
line 200 (inside the `onDidDispose` callback), after
`this._panel = undefined`.

The resulting callback:

```ts
this._panel.onDidDispose(() => {
    this._panel = undefined;
    this._broadcaster?.setWebview(null);
}, null, this._disposables);
```

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
  broadcaster is now created on first open (when a workspace root
  resolves), not just on verb requests. This switches the normal flow
  from Branch B to Branch A. This is safe:
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

2. **Verify the fix** (after applying all three changes):
   - Same reproduction steps as above.
   - Confirm: Setup panel loads correctly on reopen, all sections
     functional, integration states render.
   - Confirm: no IDE restart required.
   - Confirm: the broadcaster's webview ref was re-pointed (not still
     pointing at the disposed panel's webview). A quick way to sanity-
     check: after reopen, trigger another setup verb and confirm the
     response reaches the webview.

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

7. **Regression check — `handleServiceVerb` path unchanged:**
   - With the panel open, hit a setup verb endpoint.
   - Confirm: verb response reaches the webview as before (the
     early-return re-point is a no-op when the webview is already
     current).

---

**Recommendation:** Complexity 2 → Send to Intern.
