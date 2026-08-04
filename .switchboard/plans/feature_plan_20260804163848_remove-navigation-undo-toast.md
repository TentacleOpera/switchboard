# Remove the undo toast on terminal switching

## Goal

When the user clicks a terminal in the sidebar of `terminals.html` and that click seats the terminal into a pane that already held a different terminal, the webview shows a "Pane N: old → new" toast with an Undo button. Rapid terminal switching is the central interaction of the pane design, so this toast fires on nearly every click and reads as nagging ("clippy questioning my navigation"). The user wants it gone for navigation moves.

### Problem analysis & root cause

- **Symptom:** A toast popup (`#pane-toast`) with an Undo button appears on every sidebar click that displaces an occupied pane.
- **Location:** `src/webview/terminals.js`, inside `assignToFocusedPane(terminalName)`.
- **Root cause:** At <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/terminals.js" lines="1146-1178" /> the function unconditionally snapshots the pre-mutation layout into `undoSnapshot` (line 1147) and, when a pane was displaced, calls `showPaneToast(\`Pane ${target + 1}: ${displaced} → ${terminalName}\`, undoLastAssignment)` (line 1173). Because the pane grid is usually full during active use, almost every navigation click displaces something and trips the toast.
- **Why it's wrong here:** Undo of a navigation move is a near-zero-value action — the user can just click the other terminal again. The toast's cost (visual interruption on the primary interaction) vastly outweighs its benefit. This is distinct from the unassign-button undo (a deliberate destructive action on an explicit button) and the all-pinned informational toast (which explains a dead click rather than offering undo) — both of those stay.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, ux, bugfix
**Project:** Browser Switchboard

## User Review Required

This plan removes a user-visible affordance (the navigation Undo toast). The product call — that navigation undo is near-zero-value and the toast reads as nagging — is a UX judgment already captured in the Goal. No further review gate is required beyond the standard plan-approval step; the change is reversible via git and the toast infrastructure is retained for the unassign-button undo and the all-pinned informational toast.

## Complexity Audit

### Routine
- Localized deletion inside one function (`assignToFocusedPane`): remove one `undoSnapshot = {...}` literal and one `showPaneToast(...)` call.
- One-line relaxation of a contract test count assertion (`>= 2` → `>= 1`) plus its message string.
- No new logic, no state-machine changes, no persistence changes.
- The toast infrastructure (`showPaneToast`, `hidePaneToast`, `#pane-toast` element, `undoLastAssignment`) is retained because the unassign-button undo and the all-pinned informational toast still use it.

### Complex / Risky
- None. The change reduces shared-state complexity: after it lands, `undoSnapshot` has exactly one producer (the unassign-button handler, line 1449) and one consumer path (`undoLastAssignment`, line 1186) instead of two producers. The `sanitizePaneAssignments` invalidation (lines 700-713) and the rename-follows-snapshot logic (lines 2160-2164) now only ever apply to the unassign snapshot — a simplification, not a risk.

## Edge-Case & Dependency Audit

- **`undoSnapshot` is shared across two call sites.** It is written by `assignToFocusedPane` (navigation, line 1147) and by the unassign-button handler (line 1449). Removing only the navigation write leaves the unassign undo fully functional. `undoLastAssignment` (line 1186) and the rename-follows-snapshot logic (lines 2160-2164) remain valid because the unassign path still populates `undoSnapshot`.
- **`sanitizePaneAssignments` undo-invalidation (lines 700-713).** This clears `undoSnapshot` when a name it would restore dies. With the navigation snapshot removed, the only remaining snapshot producer is the unassign handler; the invalidation logic still applies to it and must be left intact.
- **The `else` branch `hidePaneToast()` at line 1177.** Its job is to retract a stale toast from a *previous* mutation when the current click displaces nothing. With navigation no longer producing toasts, the only stale toast it could retract is from the unassign button. Keeping the call is harmless and preserves that behavior — do not remove it.
- **All-pinned toast (line 1142).** Informational, passes `null` onUndo so the Undo button is hidden. Out of scope — keep.
- **No other `undoLastAssignment` entry point (verified).** A grep across `src/` confirms `undoLastAssignment` is referenced only at lines 1173 (the navigation toast callback, being removed) and 1450 (the unassign toast callback, kept). There is no keyboard shortcut, no `postMessage` handler, and no command registration that invokes it. Removing the navigation toast therefore removes the only navigation-triggered undo entry point — no dangling caller is left calling a no-op `undoLastAssignment`.
- **Contract test `terminal-pane-pinning-contract.test.js`.** The test "every undoSnapshot literal in the file carries a pins key" (lines 172-192) asserts `count >= 2` (navigation + unassign). After removing the navigation literal, only the unassign literal remains, so `count` becomes 1. The assertion must be relaxed to `count >= 1` and its message string updated to reflect the new reality (the unassign handler is now the only producer). The "undoLastAssignment restores pins" test (lines 164-170) stays green because the function is unchanged. The "hide (unassign) handler" test (lines 196-208) stays green.
- **No persistence / migration impact.** `undoSnapshot` is in-memory only; `saveLayoutSettings` persists `paneAssignments`/`pinnedPanes`, neither of which is touched.

## Dependencies

None. This plan is self-contained and touches no other in-flight plan.

## Adversarial Synthesis

Key risks: (1) a stale unassign toast lingering on a non-displacing nav click if the `else`-branch `hidePaneToast()` retraction were also removed — mitigated by keeping the call; (2) a future reader misled by the old `else`-branch comment that references a snapshot write that no longer happens — mitigated by replacing the comment (see Superseded callout in Proposed Changes); (3) a dangling `undoLastAssignment` entry point expecting a navigation snapshot — verified absent (only toast-button callbacks invoke it). Net risk: very low. The change reduces shared-state complexity (one `undoSnapshot` producer instead of two).

## Proposed Changes

### `src/webview/terminals.js` — `assignToFocusedPane`

Remove the navigation undo snapshot and the displacement toast. Keep the `else`-branch `hidePaneToast()` to retract any lingering unassign toast.

**Before** (lines 1146-1178):
```js
        const displaced = paneAssignments[target] || null;
        undoSnapshot = { slots: paneAssignments.slice(), pins: pinnedPanes.slice(), name: terminalName, displaced, paneIndex: target };

        if (existingIndex !== -1) {
            // ... vacate parked slot ...
            paneAssignments[existingIndex] = null;
            pinnedPanes[existingIndex] = false;
        }

        paneAssignments[target] = terminalName;
        focusedPaneIndex = target;
        activeTerminalName = terminalName;
        if (terminalBadges.has(terminalName)) {
            terminalBadges.delete(terminalName);
        }
        postFleetStateToShell();

        if (displaced) {
            showPaneToast(`Pane ${target + 1}: ${displaced} → ${terminalName}`, undoLastAssignment);
        } else {
            // Nothing was destroyed, but undoSnapshot was just replaced — retract any
            // toast still on screen from the previous mutation.
            hidePaneToast();
        }
```

> **Superseded:** The original `else`-branch comment — `// Nothing was destroyed, but undoSnapshot was just replaced — retract any toast still on screen from the previous mutation.`
> **Reason:** After removing the `undoSnapshot = {...}` write above, the snapshot is *not* "just replaced" on the navigation path. The comment would describe a write that no longer happens and mislead future readers into hunting for a missing snapshot.
> **Replaced with:** `// No navigation toast. Still retract any stale toast from a prior unassign.` — accurately describes the new behavior: navigation no longer toasts, and the `hidePaneToast()` call retracts any lingering unassign-button toast.

**After:**
```js
        const displaced = paneAssignments[target] || null;
        // Navigation undo removed: rapid terminal switching is the primary interaction
        // and an Undo toast on every displacing click reads as nagging. The unassign
        // button still keeps its own undo (see the unassignBtn handler in
        // createPaneElement). hidePaneToast() below retracts any lingering unassign toast.

        if (existingIndex !== -1) {
            // ... vacate parked slot ...
            paneAssignments[existingIndex] = null;
            pinnedPanes[existingIndex] = false;
        }

        paneAssignments[target] = terminalName;
        focusedPaneIndex = target;
        activeTerminalName = terminalName;
        if (terminalBadges.has(terminalName)) {
            terminalBadges.delete(terminalName);
        }
        postFleetStateToShell();

        // No navigation toast. Still retract any stale toast from a prior unassign.
        if (!displaced) {
            hidePaneToast();
        }
```

Notes:
- `displaced` is retained only to gate the `hidePaneToast()` call. If preferred, the variable can be inlined as `if (!paneAssignments[target])` evaluated *before* the seating write — but keeping `displaced` is clearer and matches the surrounding style.
- The `undoSnapshot`, `showPaneToast`, `hidePaneToast`, `undoLastAssignment`, and `#pane-toast` element are all left in place for the unassign-button undo and the all-pinned informational toast.

### `src/test/terminal-pane-pinning-contract.test.js` — relax the undoSnapshot count assertion

**Before** (line 191):
```js
    assert.ok(count >= 2, `expected at least 2 undoSnapshot literals (assignToFocusedPane + hide handler), found ${count}`);
```

**After:**
```js
    assert.ok(count >= 1, `expected at least 1 undoSnapshot literal (unassign handler; navigation undo removed), found ${count}`);
```

No other test changes are required — the all-pinned toast test, the `undoLastAssignment`-restores-pins test, and the unassign-handler test all remain valid as-is. The test *modification* above is a required implementation step (the existing assertion would otherwise fail after the navigation literal is removed); it is not a verification step.

## Verification Plan

> Per session directives: no project compilation and no automated test runs are listed as verification steps. The contract test *modification* in Proposed Changes is a required code change, not a verification step.

### Automated Tests
- Not run as part of this verification plan (session directive: SKIP TESTS). The implementer may run `node --test src/test/terminal-pane-pinning-contract.test.js` ad hoc if desired, but it is not a gate.

### Manual (installed VSIX)
1. Open the Terminals webview with 2+ terminals and a multi-pane layout.
2. Click terminals in the sidebar rapidly to displace occupied panes.
3. Confirm: **no** "Pane N: old → new" toast appears on any navigation click.
4. Confirm: the all-pinned toast still appears when every rendered pane is pinned (informational, no Undo button).
5. Confirm: clicking the unassign (hide) button on a pane still shows the "Pane N cleared (…)" toast **with** a working Undo button that restores the pane.
6. Confirm: after an unassign toast is shown, a subsequent non-displacing navigation click retracts it (no stale toast lingers).
7. **No persistence regression:** switch layouts (2h → 3x3 → 1 pane), reassign terminals, reload the webview, and confirm `paneAssignments`/`pinnedPanes` persist and restore correctly (`undoSnapshot` is in-memory only and is not persisted).

---

**Recommendation:** Complexity 2 → **Send to Intern**.

---

## Completion Report

Removed the navigation undo toast from `assignToFocusedPane` in `src/webview/terminals.js`: deleted the `undoSnapshot = {...}` literal and the `showPaneToast(...)` displacement-toast call, replaced the `else`-branch comment, and kept the `hidePaneToast()` retraction gated on `!displaced`. Relaxed the contract-test count assertion in `src/test/terminal-pane-pinning-contract.test.js` from `>= 2` to `>= 1` with an updated message. The unassign-button undo, the all-pinned informational toast, and the `undoLastAssignment`/`sanitizePaneAssignments`/rename-follows-snapshot logic are all left intact — `undoSnapshot` now has exactly one producer (the unassign handler). No issues encountered; grep confirms no dangling navigation-undo callers remain.
