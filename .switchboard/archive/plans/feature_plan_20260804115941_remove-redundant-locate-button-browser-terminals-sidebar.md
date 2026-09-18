# Remove redundant "locate" button from browser terminals.html sidebar

## Goal

The browser terminals page (`src/webview/terminals.html`, driven by `src/webview/terminals.js`) shows each terminal in the left sidebar with a stacked row of four text buttons: `locate`, `clear`, `rename`, `close`. A user testing the page asked: *"what is the point of the locate buttons in the browser terminals.html sidebar?"* — and the honest answer is **none**. The button is dead weight that confuses users.

### Problem analysis & root cause

The `locate` button was ported from the **extension sidebar** (`src/webview/implementation.html`), where it has a genuine purpose: the sidebar is a *separate surface* from the IDE's terminal panel, so clicking `locate` posts `vscode.postMessage({ type: 'focusTerminal', ... })` to reveal the terminal in the IDE. That is a real cross-surface action.

On the **browser page**, the terminal is already rendered on the same page in the pane grid. The `locate` button's click handler calls `locateTerminal(item.friendlyName)` (`terminals.js:785`), which seats the terminal in the focused pane and hands it the caret. But the **entire row** already has the identical handler bound at `terminals.js:828-830`:

```js
itemDiv.addEventListener('click', () => {
    locateTerminal(item.friendlyName);
});
```

So the `locate` button does *exactly* what clicking anywhere on the row already does. It is a 100% redundant duplicate of the row click. The other three buttons (`clear`, `rename`, `close`) each perform a distinct action not duplicated by the row click and call `e.stopPropagation()` to avoid the row handler firing — `locate` is the only one whose action is identical to the row's.

The redundancy is the root cause of the user's confusion: a button that visibly does the same thing as clicking the row reads as either broken or pointless.

### Intended outcome

Remove the `locate` button from the browser sidebar's per-terminal action row. The row click already seats + focuses the terminal, so no replacement control is needed. `clear`, `rename`, and `close` remain. The `locateTerminal()` *function* stays — it is still called by the row click handler and by the inbound `focusTerminal` message arm (`terminals.js:407`), and is asserted by `shell-terminal-strip.test.js`.

## Metadata

**Complexity:** 2
**Tags:** ui, ux, refactor
**Project:** Browser Switchboard

## User Review Required

- None. Mechanical deletion of a 100% redundant control; no design decisions, no options with meaningful trade-offs. The row click is already the canonical seat-and-focus gesture.

## Complexity Audit

**Routine.** This is a single-file deletion of one DOM-element construction block (~9 lines) in `terminals.js`. No new logic, no state changes, no API surface change. The `locateTerminal` function and its callers (row click, `focusTerminal` message arm) are untouched. The only risk surface is the existing static test `shell-terminal-strip.test.js`, which references `locateTerminal` (the function) but not the `locate` button — confirmed by reading the test; it asserts on the function body and the message arm, neither of which this plan touches.

## Edge-Case & Dependency Audit

- **`locateTerminal` function must remain.** It is called by the row click handler (`terminals.js:829`) and the `focusTerminal` inbound message arm (`terminals.js:407`). Do NOT remove the function — only the button DOM element + its click listener.
- **`clear`/`rename`/`close` buttons must remain.** They each perform a distinct action (`clearTerminal`, `beginInlineRename`, `closeTerminal`) and already call `e.stopPropagation()` so the row click does not double-fire. Only `locate` is the duplicate.
- **CSS `.locate-btn` class stays.** `clear`, `rename`, and `close` all reuse the `.locate-btn` class for styling (they were ported together from the extension sidebar). Removing the class would break their styling. Only the `locate` *button element* is removed, not the class.
- **`focusTerminal` inbound message path unaffected.** The message arm at `terminals.js:399-411` calls `locateTerminal()` directly — it does not go through the button. Inbound focus requests from the board still work after this change.
- **No migration concern.** This is unreleased browser-page UI; no shipped state references the button. No user data, settings, or persisted state involved.
- **`itemDiv` row click is the canonical "locate" gesture on the browser page.** After removal, clicking the row is the single, obvious way to seat + focus a terminal — which is already the documented behavior in the row handler.
- **Groups mode interaction (feature-level reconciliation).** When the Terminal Sidebar Groupings subtask lands, `renderGroupSidebar` replaces these per-terminal rows while groups exist. The button removal here applies to the flat/structural list, which remains reachable via the "show all terminals" toggle — so this cleanup stays meaningful, not dead code.

## Dependencies

- None. (No session IDs cited; IDs are assigned on import.) Sequencing within the feature: land before the branding subtask so the branding diff rebases onto the settled three-button action row in `renderTerminalRow`.

## Adversarial Synthesis

**Risk summary.** Very low risk: a pure deletion of one DOM block whose action is byte-identical to the row click handler. The only real trap is over-deletion — removing the `locateTerminal` function or the `.locate-btn` CSS class along with the button — both explicitly retained because the row click, the `focusTerminal` message arm, and the three sibling buttons still depend on them.

## Proposed Changes

### `src/webview/terminals.js` — remove the `locate` button block in `renderTerminalRow`

In `renderTerminalRow` (`terminals.js:730-833`), delete the `locateBtn` construction block (`:779-787`). The `actions` container is then populated starting with `clearBtn`.

**Before** (`terminals.js:776-789`):
```js
const actions = document.createElement('div');
actions.className = 'item-actions';

const locateBtn = document.createElement('button');
locateBtn.className = 'locate-btn';
locateBtn.textContent = 'locate';
locateBtn.title = 'Show this terminal in the focused pane and put the cursor in it';
locateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    locateTerminal(item.friendlyName);
});
actions.appendChild(locateBtn);

const clearBtn = document.createElement('button');
```

**After**:
```js
const actions = document.createElement('div');
actions.className = 'item-actions';

// No "locate" button: clicking the row already seats the terminal in the
// focused pane and hands it the caret (itemDiv click handler below). The
// locate button duplicated that exactly, which is why it read as pointless.
// clear/rename/close remain because they do things the row click does not.

const clearBtn = document.createElement('button');
```

### No other file changes

- `terminals.html`: The `.locate-btn` CSS class is retained (used by `clear`/`rename`/`close`). No HTML edit needed — the buttons are created in JS, not in the static HTML.
- `implementation.html`: Untouched. The IDE sidebar's `locate` button has a real cross-surface purpose (`vscode.postMessage focusTerminal`) and must stay.
- `shell-terminal-strip.test.js`: Untouched. Its assertions target the `locateTerminal` *function* and the `focusTerminal` message *arm*, both of which remain.

## Verification Plan

> Session note (improve-feature review, 2026-08-04): compilation and automated tests were NOT run as part of this planning pass per session directive. The checks below are the coder's verification gates, to be executed at implementation time. Line numbers were re-verified against the working tree on 2026-08-04 (`terminals.js` is now 3046 lines).

1. **Static test suite:** `npm test` (or the project's test command) — confirm `shell-terminal-strip.test.js` still passes. It asserts `locateTerminal` seats + focuses; the function is unchanged, so it must pass.
2. **Build check:** `npm run compile` — confirm webpack builds cleanly with no new errors (the deletion is inside a function body; no import/export surface changes).
3. **Manual smoke test on the browser terminals page:**
   - Open the browser terminals page with at least one live terminal.
   - Confirm the sidebar row shows only `clear`, `rename`, `close` (no `locate`).
   - Click anywhere on the row (not on a button) → terminal seats into the focused pane and receives the caret (typing works). This verifies the row click still performs the old "locate" action.
   - Click `clear` → `/clear` is sent to the terminal. Click `rename` → inline rename works. Click `close` → terminal closes. None of these should also trigger a row-seat (they call `e.stopPropagation()`).
   - Trigger an inbound `focusTerminal` message from the board (e.g. click a terminal entry on the shell strip) → the terminal is still seated + focused in the cockpit. This verifies the message arm path is intact.
4. **Visual check:** Confirm `clear`/`rename`/`close` still render with the `.locate-btn` styling (no broken layout from the missing sibling).

## Review Findings

Implementation verified clean: `locateBtn` block deleted from `renderTerminalRow` (comment at `terminals.js:960-963` marks the spot), `locateTerminal` function retained (called by row click at `:1004` and `focusTerminal` message arm), `.locate-btn` CSS class retained (used by `clear`/`rename`/`close`), no orphaned `locateBtn` references remain. `clear`/`rename`/`close` buttons each call `e.stopPropagation()`. Verification: `test:contract:shell-terminal-strip` passes (2 pre-existing failures unrelated to this change — CSS margin-top and Setup icon placement), compile passes. No issues found.
