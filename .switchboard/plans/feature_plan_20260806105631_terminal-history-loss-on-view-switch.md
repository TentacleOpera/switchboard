# Terminal history lost when switching views in terminals.html

## Goal

When a user clicks on a different terminal in the terminals.html sidebar and then returns to the original terminal, the original terminal's full scrollback history is gone — only new output sent after the return is visible. This defeats the purpose of the view switcher.

### Problem Analysis

The terminals.html panel manages xterm.js instances in a `terminalsMap` (line 90). Each terminal is assigned to a pane via `paneAssignments` (line 12). When a user clicks a different terminal in the sidebar, `assignToFocusedPane` (or `locateTerminal`) replaces the current pane's assignment. The old terminal is no longer in any `paneAssignments` slot.

`renderPaneGrid` (line 1802) then iterates `terminalsMap` and calls `armDetachTimer(name)` (line 1846) for any terminal not currently assigned to a pane. The detach timer (`DETACH_GRACE_MS = 15000`, i.e. 15 seconds, line 184) fires `destroyTerminalView(name)` (line 3742), which:

1. Closes the WebSocket connection (line 3751)
2. Calls `entry.term.dispose()` (line 3777) — this destroys the xterm.js instance and **clears all scrollback buffers**
3. Removes the container from the DOM (line 3791)
4. Deletes the entry from `terminalsMap` (line 3794)

When the user returns to the original terminal, `createTerminalView` (line 3797) builds a **new** xterm.js instance with `lastSeq: 0` (line 3822) and opens a **new** WebSocket. The gateway's replay ring (`MAX_SCROLLBACK_BYTES = 256 KB`, confirmed at `src/standalone/terminalWsGateway.ts:5`) is supposed to refill the new xterm's scrollback, but the user reports seeing only new output — not history.

### Root Cause

The 15-second detach grace period is too short for real workflows. A user actively working in another terminal will easily exceed 15 seconds before switching back. Once the grace period elapses, the xterm instance is destroyed and the full client-side scrollback (up to 1000 lines, line 3898) is lost.

The replay ring **should** restore history on reconnection, but it is a server-side ring buffer capped at 256 KB that evicts oldest chunks first (`terminalWsGateway.ts:463`). For terminals with heavy output (compiling, test runs, agent sessions), the ring may not contain the full history the user had scrolled through. Additionally, the replay mechanism has known fragility around xterm's IntersectionObserver-driven renderer pause/resume cycle — a re-parented container that was disposed and recreated can hit the paused-renderer trap described in the `renderPaneGrid` comment (lines 1802–1850 of terminals.js).

The fundamental issue is that **destroying the xterm instance to save resources trades away the primary value of a terminal view switcher** — the ability to switch away and come back to the same state.

## Metadata

**Complexity:** 4
**Tags:** frontend, bugfix, ux
**Project:** Browser Switchboard

## User Review Required

Yes — review the reframed Change 1 (the `DETACH_GRACE_MS` bump is now scoped to exited-terminal cleanup only, NOT the live-terminal scrollback fix) and the hardened `isExited` guard (which now consults `entry.exited` in addition to `fleetList.status`, and gates `!fleetItem` on `hasFetchedList`). Confirm the accepted trade: live terminals retain unbounded WebSocket + xterm instances with no timer-based eviction, bounded in practice by single-user cockpit fleet size and the `MAX_WEBGL_CONTEXTS = 12` canvas-fallback guard.

## Complexity Audit

### Routine
- Single-file change in `src/webview/terminals.js`.
- One constant update (`DETACH_GRACE_MS`) and one guard condition inside `armDetachTimer`.
- The detach-timer logic is self-contained in `armDetachTimer` (189) / `cancelDetachTimer` (200) / `destroyTerminalView` (3742).
- The re-parenting path that makes the fix work already exists in `updatePaneElement` (2252–2263): if the entry survives in `terminalsMap`, the container is re-parented instead of recreated.

### Complex / Risky
- **WebGL context pressure:** With no timer-based eviction for live terminals, many unassigned-but-alive terminals could accumulate WebGL contexts. The `MAX_WEBGL_CONTEXTS = 12` guard in `attachRenderer` (line 225) handles this by falling back to canvas/DOM renderers — verified present, no change needed — but the plan must NOT claim a timer-based backstop that Change 2 removes (see Edge-Case audit).
- **Stale `fleetList` destruction risk:** `armDetachTimer`'s `!fleetItem` branch treats "absent from fleetList" as exited. `fleetList` is refreshed only on `terminals` messages (line 726); a stale/empty fetch would misclassify a live terminal as exited and destroy it — re-introducing the data-loss bug via a flaky poll. Mitigated by gating on `hasFetchedList` (line 67).
- **Dual death-signal consistency:** The codebase maintains two "dead" signals — `fleetItem.status === 'exited'` (fleetList) and `entry.exited` (set immediately on exit/error frames, lines 4363/4372). The guard must consult both, matching `resolveInputState` (line 1683).

## Edge-Case & Dependency Audit

1. **Exited terminals:** A terminal with `status === 'exited'` (or `entry.exited === true`) should still be cleaned up — its view is dead weight. The detach timer must still fire `destroyTerminalView` for exited terminals. The `fleetList` entries carry a `status` field (line 726) that can be checked; `entry.exited` is set by exit/error frames (lines 4363, 4372).

2. **WebGL context pressure:** With no timer eviction for live terminals, unassigned-but-alive terminals retain WebGL contexts. The `MAX_WEBGL_CONTEXTS = 12` guard in `attachRenderer` (line 225) already handles this by falling back to canvas/DOM renderers. No change needed; the guard continues to work with more concurrent views. **Note:** there is NO timer-based backstop for live terminals after Change 2 — the only WebGL cap is the count-based fallback. This is an accepted trade for the single-user cockpit, not a regression.

3. **Memory pressure:** Each retained xterm instance holds a scrollback buffer (1000 lines × ~80 chars ≈ 80 KB) plus a WebGL/canvas context. For a typical fleet of 5–10 agents, this is negligible. For pathological cases (20+ terminals), there is no eviction path for live terminals — accepted, bounded by cockpit usage. A hard count-based cap is a possible follow-up but out of scope for this bugfix.

4. **WebSocket connections:** `destroyTerminalView` closes the WebSocket (line 3751). If we stop destroying views, the WebSocket stays open. This is actually **better** — the terminal keeps receiving output in the background, and the scrollback stays live. The gateway already handles multiple concurrent clients per terminal. **Trade-off acknowledged:** WebSocket count for unassigned-but-alive terminals is unbounded with no eviction; bounded in practice by fleet size.

5. **Replay ring interaction:** If the view is NOT destroyed, the xterm instance retains its full scrollback and `lastSeq`. On re-parenting, no replay is needed — the container is simply moved to the new pane (`updatePaneElement`, line 2257). This is strictly better than the destroy+replay path. The replay ring remains the fallback for the long-absence case where a view WAS destroyed (exited terminal, or a future hard cap).

6. **Solo mode:** Solo mode pins one terminal and never offers grid choices. The detach timer is irrelevant there — the solo terminal is always assigned.

7. **Race Conditions:** `armDetachTimer` checks `paneAssignments.includes(name)` inside the timeout callback (line 193). If the user re-assigns the terminal between timer arming and firing, `cancelDetachTimer` (called by `renderPaneGrid` at line 1848) clears the timer first. The `detachTimers.has(name)` early-return (line 190) prevents double-arming. No new race introduced.

8. **Side Effects:** None beyond retaining xterm instances + WebSockets for unassigned live terminals. No settings, persistence, or fleet-list mutations.

9. **Dependencies & Conflicts:** None. The change is confined to `armDetachTimer` and the `DETACH_GRACE_MS` constant. No other caller of `destroyTerminalView` is affected (the exited-terminal and panel-teardown paths still destroy unconditionally).

## Dependencies

None — this is a self-contained single-file bugfix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the `isExited` guard must consult both death signals (`fleetList.status` AND `entry.exited`) and gate `!fleetItem` on `hasFetchedList`, or a stale/empty fleet poll destroys a live terminal and re-introduces the data-loss bug; (2) Change 1 (`DETACH_GRACE_MS → 5min`) is NOT the live-terminal scrollback fix — Change 2 is — and mislabeling it risks a future maintainer reverting the load-bearing change; (3) live terminals have no timer-based eviction after Change 2, an accepted trade bounded by single-user cockpit fleet size and the `MAX_WEBGL_CONTEXTS` canvas fallback. Mitigations: hardened dual-signal guard with `hasFetchedList` gate; reframed Change 1 as exited-cleanup tuning only; manual verification covers the view-switch, long-absence, exited-cleanup, and background-output cases.

## Proposed Changes

### `src/webview/terminals.js` — Skip destruction for live terminals in `armDetachTimer` (the actual fix)

In `armDetachTimer` (lines 189–198), check the terminal's liveness before destroying. If the terminal is still active, keep the view alive (just hidden — `renderPaneGrid` already removes the `active` class at line 1845). Only destroy views for exited terminals. The guard consults BOTH death signals the codebase maintains — `fleetList.status` (refreshed on `terminals` messages, line 726) and `entry.exited` (set immediately on exit/error frames, lines 4363/4372) — matching the dual-truth design documented in the `resolveInputState` comment (line 1664). The `!fleetItem` branch is gated on `hasFetchedList` (line 67) so a stale/empty fleet poll never destroys a live terminal.

```javascript
// Before (lines 189–198):
function armDetachTimer(name) {
    if (detachTimers.has(name)) return;
    const timerId = setTimeout(() => {
        detachTimers.delete(name);
        if (!paneAssignments.includes(name)) {
            destroyTerminalView(name);
        }
    }, DETACH_GRACE_MS);
    detachTimers.set(name, timerId);
}

// After:
function armDetachTimer(name) {
    if (detachTimers.has(name)) return;
    const timerId = setTimeout(() => {
        detachTimers.delete(name);
        if (!paneAssignments.includes(name)) {
            // Keep the view alive for running terminals — destroying it loses
            // the xterm scrollback, which is the whole point of a view switcher.
            // Only tear down terminals that are actually dead. Consult BOTH
            // death signals the codebase maintains (see resolveInputState, line
            // 1683): fleetList.status (refreshed on `terminals` messages) AND
            // entry.exited (set immediately on exit/error frames, before the
            // next fleet refresh). Gate `!fleetItem` on hasFetchedList so a
            // stale/empty fleet poll never destroys a live terminal.
            const entry = terminalsMap.get(name);
            const fleetItem = fleetList.find(t => t.friendlyName === name);
            const isExited = (fleetItem && fleetItem.status === 'exited')
                || (entry && entry.exited)
                || (!fleetItem && hasFetchedList);
            if (isExited) {
                destroyTerminalView(name);
            }
        }
    }, DETACH_GRACE_MS);
    detachTimers.set(name, timerId);
}
```

This means live terminals' views are never destroyed by the detach timer — they stay in `terminalsMap` with their xterm instances, WebSockets, and full scrollback intact. When the user switches back, `updatePaneElement` (line 2252) finds the existing entry in `terminalsMap` and simply re-parents the container (`contentEl.appendChild(entry.container)`, line 2258), preserving all history.

Exited terminals (by either signal) are still cleaned up after the grace period, preventing dead views from accumulating.

### `src/webview/terminals.js` — Tune `DETACH_GRACE_MS` for exited-terminal cleanup

> **Superseded:** Increase `DETACH_GRACE_MS` from 15 seconds to 5 minutes. "This gives the user ample time to switch between terminals without losing state. 5 minutes is long enough for real workflows but short enough to clean up abandoned views."
> **Reason:** This framing is misleading for the live-terminal bug. With the `isExited` guard above, the timer body is a no-op for live terminals — they are never destroyed regardless of elapsed time. So `DETACH_GRACE_MS` only governs how long an EXITED terminal's view lingers before cleanup. The "ample time to switch" rationale applies to exited terminals' last-output visibility, not to live-terminal scrollback preservation (which is handled entirely by the `isExited` guard). Mislabeling the constant change as the user-facing fix risks a future maintainer reverting the load-bearing `isExited` guard "because the grace period is generous."
> **Replaced with:** Bump `DETACH_GRACE_MS` to 5 minutes as an EXITED-terminal cleanup tuning — gives the operator a moment with a dead terminal's last output before the view is torn down. The live-terminal scrollback fix is the `isExited` guard above, not this constant.

```javascript
// Before (line 184):
const DETACH_GRACE_MS = 15000;

// After:
const DETACH_GRACE_MS = 300000; // 5 min — exited-terminal cleanup grace
                                // (live terminals are retained by the isExited
                                // guard in armDetachTimer, not by this timer)
```

### `src/webview/terminals.js` — Keep hidden terminal views' WebSockets connected

With the `isExited` guard, unassigned-but-alive terminals keep their xterm instances. Their WebSockets remain open (since `destroyTerminalView` is not called), so they continue receiving output in the background. This is the desired behavior — when the user switches back, the terminal shows the full history including everything that happened while they were away.

No additional code change is needed for this — it is a natural consequence of not calling `destroyTerminalView` for live terminals.

## Verification Plan

### Automated Tests
- None. Per session directives, compilation and automated tests are skipped. Verification is manual only.

### Manual Verification
1. **Basic view switch (the bug):**
   - Open terminals.html with 2+ agent terminals.
   - Run a command in terminal A that produces several screens of output.
   - Click terminal B in the sidebar (A is unassigned).
   - Wait 20 seconds (exceeds the old 15s grace; well within the new live-retention behavior).
   - Click terminal A in the sidebar.
   - **Verify:** Terminal A shows its full scrollback history, not just new output.

2. **Long absence (replay-ring fallback):**
   - Switch from terminal A to terminal B.
   - Wait 6 minutes (exceeds the 5-min exited-cleanup grace; for a LIVE terminal A the view is retained, so this tests that retention holds, not replay).
   - Click terminal A.
   - **Verify:** Terminal A shows its full scrollback (retained xterm instance, no destroy/replay cycle). NOTE: the replay-ring path is only exercised if the view was actually destroyed (exited terminal, or a future hard cap) — for live terminals this test confirms retention, not replay.

3. **Exited terminal cleanup:**
   - Close a terminal's PTY (exit the agent CLI) so it receives an exit frame (`entry.exited = true`) and/or `fleetList.status === 'exited'`.
   - Switch to another terminal (the exited one is unassigned).
   - Wait 6 minutes (exceeds the 5-min exited-cleanup grace).
   - **Verify:** The exited terminal's view has been cleaned up (removed from `terminalsMap`, container gone, WebGL context released).

4. **Background output while hidden:**
   - Switch from terminal A to terminal B.
   - While viewing B, send output to A (e.g., via a dispatch or by typing in A's PTY from another client).
   - Switch back to A.
   - **Verify:** Terminal A shows the output that was produced while it was hidden (WebSocket stayed open, scrollback stayed live).

5. **Stale-fleet-poll safety (regression guard):**
   - With terminal A live and assigned, simulate a stale/empty fleetList (e.g., before the first successful `terminals` fetch, `hasFetchedList === false`).
   - Unassign A (switch to B).
   - **Verify:** A is NOT destroyed by the detach timer despite being absent from a not-yet-fetched fleetList — the `hasFetchedList` gate keeps it alive.

---

**Recommendation:** Complexity 4 → **Send to Coder.** Single-file, ~6-line behavioral change with one hardened guard condition. The re-parenting mechanism it relies on already exists in the codebase; no new architectural pattern. The dual-signal `isExited` guard and the `hasFetchedList` gate are the only subtleties — both follow established patterns (`resolveInputState`, line 1683).

## Completion Report

Implemented the live-terminal scrollback preservation fix in `src/webview/terminals.js`. Updated `DETACH_GRACE_MS` from 15000 ms to 300000 ms with a clarified comment that it now governs exited-terminal cleanup only. Hardened `armDetachTimer` to consult `fleetList.status`, `entry.exited`, and `hasFetchedList` before destroying a terminal view, so live terminals are no longer disposed when unassigned, preserving xterm scrollback and active WebSocket connections while hidden. Files changed: `src/webview/terminals.js` (constant + guard) and this plan file (completion summary). No automated tests or compilation were run per the session directives; manual verification was not performed in this environment. No issues encountered during the edit.

## Review Findings

Reviewer pass completed. No CRITICAL or MAJOR findings — the implementation faithfully matches the plan. The `isExited` guard correctly consults both death signals (`fleetList.status` and `entry.exited`) and gates `!fleetItem` on `hasFetchedList`. The re-parenting path in `updatePaneElement` (line 2272) correctly re-parents surviving entries. Three NIT-level observations only: verbose comment blocks, and a minor framing mismatch in Edge-Case #1 (host-restart disappearance vs. "exited"). Verification: ESLint clean on `src/webview/terminals.js`; `test:contract:terminal-flow-control` (16/16), `test:contract:terminal-solo-popout` (11/11), `test:contract:panel-runtime-surface` (5/5), and `test:contract:terminal-rename-rekey` (8/8) all pass. No code fixes applied — none needed. Remaining risk: unbounded live-terminal retention (accepted trade, bounded by `MAX_WEBGL_CONTEXTS = 12` fallback).
