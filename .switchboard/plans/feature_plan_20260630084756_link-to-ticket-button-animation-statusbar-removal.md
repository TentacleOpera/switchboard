# Fix "Link to Ticket" Button Animation & Remove Status Bar Message on Tickets Tab Sidebar Cards

## Goal

### Problem Analysis

The per-card "Link to ticket" buttons in the Tickets tab sidebar (rendered in `planning.js` for both Linear and ClickUp issue cards) exhibit two annoying behaviors that deviate from the established UX patterns used everywhere else in the extension (notably `kanban.html`):

1. **Sudden wording change on click.** When clicked, the button text is swapped from "Link to ticket" to "Copied!" and the button is disabled for ~2 seconds, then reverted. This is implemented via `flashCopyBtn()` (planning.js:9288), which mutates `btn.textContent`. Every other action button on the same card ("Add to kanban", "Refine", "Open") uses `flashIconBtn()` (planning.js:9306), which only toggles a `.flash` CSS class for a 0.3s scale/opacity animation — **no text change, no disable**. The kanban.html board uses `flashIconBtn` exclusively for all button clicks (kanban.html:9510-9516 global listener). The "Link to ticket" button is the sole outlier that rewrites its label.

2. **Confusing bottom status bar message.** On a successful copy, the `ticketLinkCopied` message handler (planning.js:4407-4419) calls `showTicketsStatus("Copied N ticket link(s) ✓")`, which surfaces a transient footer bar (`#tickets-status-footer`, planning.html:3700) at the bottom of the Tickets tab. This status bar is disorientating — it appears unexpectedly, takes up vertical space, and communicates nothing the user needs (the clipboard already has the link; the button flash already confirms success). No other card action ("Add to kanban", "Refine") triggers this footer for its success case.

### Root Cause

Both behaviors share a single code path. The per-card click handler (planning.js:7768-7772) calls `handleLinkToTicket()` (planning.js:9313), which sends a `copyToClipboard` message and stashes the button in `_lastLinkTicketBtn`. The backend replies with `ticketLinkCopied`, handled at planning.js:4407. That handler:
- Calls `showTicketsStatus(...)` → the unwanted status bar message (line 4414).
- Calls `flashCopyBtn(_lastLinkTicketBtn)` → the unwanted text mutation (line 4417).

The fix is to make the `ticketLinkCopied` handler use `flashIconBtn` (the kanban.html-established pattern) instead of `flashCopyBtn`, and to drop the `showTicketsStatus` success message entirely.

## Metadata

- **Tags:** frontend, ui, ux, bugfix
- **Complexity:** 2/10
- **Files touched:** `src/webview/planning.js`
- **Risk:** Low — single message-handler case, no data/state changes, no backend changes.

## User Review Required

**Approve before implementation:**

- **Partial-success warning suppression (judgment call).** The fix removes *both* `showTicketsStatus` calls in the `ticketLinkCopied` case — the success message AND the partial-success warning (`missingCount > 0` branch, line 4408-4412). This means: if a user clicks "Link all" and some tickets have no local file, the clipboard receives the available links but **no warning is shown** that some were skipped. This is intentional (the plan title says "Remove Status Bar Message"), but it converts a previously-visible warning into a silent partial success. The total-failure path (`ticketLinkFailed`, line 4421-4426) is preserved and still surfaces errors. **Confirm you accept losing the partial-success warning.**

## Complexity Audit

### Routine
- Single message-handler case (`ticketLinkCopied`) in one file (`src/webview/planning.js`).
- Swapping one function call (`flashCopyBtn` → `flashIconBtn`) — both already exist, no new code.
- Removing two `showTicketsStatus(...)` calls — pure deletion, no logic change.
- No backend changes; the `copyToClipboard` → `ticketLinkCopied` round-trip is unchanged.
- No state machines, no persistence, no migrations, no CSS additions (`.flash` / `iconFlash` already exist at planning.html:1801-1808).

### Complex / Risky
- Silent suppression of partial-success warnings on "Link all" (see User Review Required) — a deliberate UX scope decision, not a code-complexity risk.

## Edge-Case & Dependency Audit

- **"Link all" button shares the same handler.** The "Link all" toolbar button (planning.js:7377-7392) also sets `_lastLinkTicketBtn` and therefore also receives `flashCopyBtn` + `showTicketsStatus` on success. Applying the same fix to the shared `ticketLinkCopied` handler means "Link all" will also switch to `flashIconBtn` and lose its status bar message. This is **desirable** — it unifies both buttons with the kanban flash pattern and removes the footer message consistently. The "Link all" button is a `.strip-btn`-style toolbar button (planning.html:3639); `flashIconBtn` adds the `.flash` class which triggers the `iconFlash` scale animation on any element, so it applies cleanly (the text label will briefly scale — visually acceptable).
- **Error case (`ticketLinkFailed`).** The failure handler (planning.js:4421-4426) calls `showTicketsStatus(msg.error, true)` to surface errors. This is **kept** — error feedback is genuinely useful and is not the "confusing/disorientating" success message the user is complaining about. The user's complaint is specifically about the normal-click success path.
- **`flashCopyBtn` is still used by the Refine button** (planning.js:7797). The `flashCopyBtn` function is NOT deleted — only the link-to-ticket call site is changed. The Refine button's "Copied!" behavior is out of scope for this plan.
- **`.copied` CSS class** (planning.html:1779-1782) remains in the stylesheet for the Refine button's use. No CSS changes needed.
- **Missing-file partial-success case** (planning.js:4408-4412): Currently shows a warning status when some tickets have no local file. This is an error-class message (`isError = true`). Per the user's "remove entirely" intent for the success status bar, the clean success branch (line 4413-4415) is removed. The partial-success warning branch (line 4408-4412) is also removed to fully eliminate the status bar from this action — the user wants the footer gone for link-to-ticket, and a partial copy still succeeds (the clipboard has the available links). **Decision: remove both `showTicketsStatus` calls in the `ticketLinkCopied` case** so the footer never appears for this action. See **User Review Required** above — this suppresses a previously-visible warning.
- **Race Conditions:** None. The `ticketLinkCopied` handler is synchronous and single-threaded in the webview. `_lastLinkTicketBtn` is set before the message is sent and cleared in the handler; rapid double-clicks would just re-flash the same button.
- **Security:** None. No secrets, no auth, no data exposure.
- **Side Effects:** None beyond the visual change. Clipboard contents are unchanged (backend behavior is untouched).
- **Dependencies & Conflicts:** None. No other module references the `ticketLinkCopied` case. `flashIconBtn` and `flashCopyBtn` are independent.

## Dependencies

- None — this plan is self-contained and touches only `src/webview/planning.js`.

## Adversarial Synthesis

Key risks: (1) Silent suppression of the partial-success warning on "Link all" — a deliberate scope decision that the user must consciously approve (surfaced in User Review Required). (2) No regression test asserts the new behavior (`showTicketsStatus` absent from `ticketLinkCopied`, `flashIconBtn` used instead of `flashCopyBtn`) — a future test addition is recommended but not required this session. Mitigations: partial-success decision is explicitly called out for user approval; total-failure path (`ticketLinkFailed`) is preserved so hard errors still surface.

## Proposed Changes

### File: `src/webview/planning.js`

**Change 1 — Replace `flashCopyBtn` with `flashIconBtn` in the `ticketLinkCopied` handler (line 4407-4420).**

Current (planning.js:4407-4420):
```js
            case 'ticketLinkCopied':
                if (msg.missingCount && msg.missingCount > 0) {
                    showTicketsStatus(
                        `Copied ${msg.count} of ${msg.requestedCount} ticket links — ${msg.missingCount} have no local file. Click "Refetch" to import them.`,
                        true  // isError = true, shows as warning
                    );
                } else {
                    showTicketsStatus(`Copied ${msg.count} ticket link${msg.count > 1 ? 's' : ''} ✓`, false);
                }
                if (_lastLinkTicketBtn) {
                    flashCopyBtn(_lastLinkTicketBtn);
                    _lastLinkTicketBtn = null;
                }
                break;
```

Proposed:
```js
            case 'ticketLinkCopied':
                if (_lastLinkTicketBtn) {
                    flashIconBtn(_lastLinkTicketBtn);
                    _lastLinkTicketBtn = null;
                }
                break;
```

This:
- Removes both `showTicketsStatus(...)` calls → the bottom status bar no longer appears for link-to-ticket success or partial-success.
- Replaces `flashCopyBtn(_lastLinkTicketBtn)` with `flashIconBtn(_lastLinkTicketBtn)` → the button gets the 0.3s `.flash` scale/opacity animation (the kanban.html-established pattern) instead of having its text rewritten to "Copied!" and being disabled.

**No other files need changes.** The `flashIconBtn` function already exists (planning.js:9306) and the `.flash` CSS keyframe (`iconFlash`) already exists in planning.html (line 1801-1808). The `flashCopyBtn` function (planning.js:9288) is left in place for the Refine button's continued use.

## Verification Plan

### Automated Tests

**Existing regression test (run by user separately — not run this session per directive):**
- `node src/test/tickets-link-to-ticket-regression.test.js` — confirms the following invariants remain satisfied after the fix:
  - `case 'ticketLinkCopied':` exists in planning.js ✓ (unchanged — the case label is preserved)
  - `handleLinkToTicket` does NOT call `flashCopyBtn` synchronously ✓ (unchanged — it never did; the call was in the message handler, not the function)
  - `msg.error ||` appears in planning.js ✓ (unchanged — still in `ticketLinkFailed` handler at line 4422)
  - `PlanningPanelProvider.ts` posts `ticketLinkCopied` and `ticketLinkFailed` messages ✓ (unchanged — no backend changes)

**Recommended future test addition (not required this session):**
- Add an assertion to `tickets-link-to-ticket-regression.test.js` that the `ticketLinkCopied` case block in planning.js does NOT contain `showTicketsStatus` and DOES contain `flashIconBtn`. This would lock in the new behavior and catch silent regressions. (Out of scope for this plan per the skip-tests directive, but noted for follow-up.)

### Manual Verification (installed VSIX)

1. Open the Tickets tab, load a Linear or ClickUp project with issue cards.
2. Click "Link to ticket" on a sidebar card.
   - **Confirm:** The button plays the brief `.flash` scale animation (same as "Add to kanban" and "Refine" buttons). The button text stays "Link to ticket" — it does NOT change to "Copied!" and the button is NOT disabled.
   - **Confirm:** No bottom status bar (`#tickets-status-footer`) appears. The footer stays hidden (`display: none`).
   - **Confirm:** The clipboard still receives the ticket link (paste into an editor to verify).
3. Click "Link all" in the toolbar — same behavior: flash animation, no text change, no status bar.
4. **Error path still works:** If a ticket has no local file, clicking "Link to ticket" triggers `ticketLinkFailed`. Confirm the error still surfaces in the footer (this path is intentionally preserved at line 4421-4426).

---

**Recommendation:** Complexity is 2/10 → **Send to Intern**.
