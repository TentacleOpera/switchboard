# Replace the Terminals Sidebar Status Dot With an Inline Close (×) Button

## Goal

Every row in the Terminals sidebar carries a coloured status dot on its right edge. It is dead weight: it encodes one bit the row already implies, it is not clickable, and it occupies the most reachable spot in the row. Replace it with an **× close button** in that position, and delete the `close` text link from the row's action strip — so closing a terminal becomes a single obvious target instead of a word buried in a row of four lookalike links.

### Problem analysis and root cause

`renderTerminalRow` (`src/webview/terminals.js:1000`) builds each sidebar row as `.terminal-item-top` (info + dot) above `.item-actions` (clear / rename / close). The dot:

```js
const dot = document.createElement('div');
dot.className = 'status-dot' + (item.status === 'exited' ? ' exited' : '');
```
— `terminals.js:1070-1071`, styled at `src/webview/terminals.html:370-378` as a 7px circle, green normally and red when exited. No listener, no title, no aria text.

Why it earns nothing:

- **The signal is redundant and weakly encoded.** Green means "active", which is the state of essentially every row the operator ever looks at — a signal that is almost always the same value carries almost no information. The one case that matters (exited) is conveyed by a 7px colour change with no text, no tooltip and no shape difference: the least legible way to say something important.
- **It occupies the row's best target.** `.terminal-item-top` is `justify-content: space-between` (`terminals.html:314-319`), so the dot owns the right edge — the position a close affordance conventionally occupies and the easiest place to hit.
- **Meanwhile `close` is a 10px, `opacity: 0.7`, borderless text link** (`.locate-btn`, `terminals.html:262-274`) sitting third in a strip of three near-identical links (`terminals.js:1102-1110`). It is the most consequential action in the row (it ends the process) and the hardest to pick out.

Root cause: the row's visual hierarchy is inverted — a non-interactive state pip got the prime slot and the process-ending action got a word in a link soup.

### Preserving the exited signal, properly

Removing the dot removes the only exited indicator in the sidebar row. Do not drop it — re-encode it in text, matching what the **pane header** already does: it appends ` (exited)` to the handle (`terminals.js:2288-2292`). The row's subline gains the same suffix and the row gains an `is-exited` class for dimming. That is strictly more legible than the red pip it replaces.

The × stays **enabled** for exited rows: closing an exited terminal is how its row is cleared, and `ptyCloseTerminal` handles a dead handle (`fleet.kill` returns false, the row disappears on the next list fetch).

Per project rule: the × closes **immediately**. No confirm gate, no two-click pattern — and in a VS Code webview `window.confirm()` is a silent no-op anyway, which would make the button do literally nothing.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, ux
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- Swap one `div.status-dot` for one `button.item-close-btn` in `renderTerminalRow`.
- Delete the `closeBtn` block from `.item-actions`.
- One new CSS rule; delete two.
- Add the `(exited)` suffix and `is-exited` class.

### Complex / Risky
- **Click must not fall through to row selection.** The whole row has a click listener that seats the terminal in the focused pane (`terminals.js:1119-1121`). The × sits *inside* the row, so it needs `e.stopPropagation()` — the existing action buttons all do this (`terminals.js:1086`, `1097`, `1107`) and the new one must too, or closing a terminal also seats it a frame before it dies.
- **Deleting the only exited indicator.** Removing the dot without re-encoding the state is a silent information loss. The `(exited)` suffix is not optional polish; it is what makes the removal safe.

## Edge-Case & Dependency Audit

- **Race Conditions:** `closeTerminal` (`terminals.js:3697`) posts `ptyCloseTerminal` then refetches the list. Double-clicking the × sends a second close for a name that no longer exists; the verb returns `{success: false}` and the handler already ignores the result. No new window — same as today's `close` link.
- **Security:** No new verb, no new payload field. `ptyCloseTerminal` is already reachable from this panel and is already bound to a button in this exact row.
- **Side Effects:**
  - The × ends the agent process. That is what the `close` link did, from the same row, with the same call — no new capability, only a better target. The project's no-confirm rule is explicit that delete-class buttons fire immediately and are made hard to misclick instead; the × is therefore sized 16×16 with a 4px inset from the row edge and coloured danger-red only on hover, so it reads as destructive without being twitchy.
  - `.item-actions` drops from three buttons to two. Combined with other in-flight sidebar work it may end at one; the `flex-wrap` on `.item-actions` (`terminals.html:383-388`) means neither count needs a layout change.
  - Screen readers lose nothing: the dot had no accessible name at all. The × gets `aria-label="Close <name>"` and the exited state moves into visible text.
- **Dependencies & Conflicts:**
  - Files: `src/webview/terminals.js`, `src/webview/terminals.html`.
  - **Overlaps a companion change** that converts the row's `rename` link into an edit icon and restyles `clear` as a visible button. Both edit `renderTerminalRow`'s action strip. They are textually adjacent but independent: this plan removes the `closeBtn` block (`terminals.js:1102-1110`) and the `dot` block (`1070-1071`); that one removes `renameBtn` (`1092-1100`) and restyles `clearBtn` (`1081-1090`). Apply either order; if both land, `.item-actions` ends up holding only the `clear` button. Neither depends on the other.
  - No migration: purely presentational, no persisted state, no settings key.

## Proposed Changes

### 1. `src/webview/terminals.js` — replace the dot with a close button

Replace lines 1070-1071:

```js
        // Was a .status-dot: a non-interactive 7px pip in the row's most reachable
        // slot, encoding a bit that is "active" on virtually every row. The exited
        // state it carried now lives in the subline text and the row's is-exited
        // class (see above), which is strictly more legible than a red circle.
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'item-close-btn';
        closeBtn.textContent = '×';
        closeBtn.title = 'Close terminal (ends the process)';
        closeBtn.setAttribute('aria-label', `Close ${item.friendlyName}`);
        closeBtn.addEventListener('click', (e) => {
            // The whole row seats the terminal on click (listener below). Without
            // this, closing also seats it a frame before it dies.
            e.stopPropagation();
            closeTerminal(item.friendlyName);
        });
```

Update the `topRow` assembly (line 1112-1116) to append `closeBtn` where `dot` was:

```js
        const topRow = document.createElement('div');
        topRow.className = 'terminal-item-top';
        topRow.appendChild(info);
        topRow.appendChild(closeBtn);
```

Delete the old action-strip close block (lines 1102-1110) entirely, and amend the comment above `clearBtn` (line 1076-1079) which currently reads "clear/rename/close remain because they do things the row click does not":

```js
        // No "locate" button: clicking the row already seats the terminal in the
        // focused pane and hands it the caret (itemDiv click handler below).
        // `close` moved OUT of this strip to the × at the row's right edge — it is
        // the row's most consequential action and was its least visible control.
```

### 2. `src/webview/terminals.js` — re-encode the exited state

In the row class computation (line 1004-1007):

```js
        itemDiv.className = 'terminal-item'
            + (isFocused ? ' active' : '')
            + (paneIndex !== -1 ? ' assigned' : '')
            + (item.status === 'exited' ? ' is-exited' : '');
```

In the subline (line 1043-1045), mirroring the pane header's treatment at `terminals.js:2288`:

```js
        // Status suffix attaches to the HANDLE, matching the pane header:
        // "planner-2 (exited)" is meaningful, "CLAUDE CLI (exited)" is not.
        const handle = item.status === 'exited'
            ? `${item.friendlyName} (exited)`
            : item.friendlyName;
        roleEl.textContent = agentLabel ? `${handle} · ${item.role}` : `${handle} · ${item.role}`;
```

### 3. `src/webview/terminals.html` — CSS

Delete `.status-dot` and `.status-dot.exited` (lines 370-378). Add in their place:

```css
        /* Row close. Occupies the slot the status dot held — the row's most
           reachable point — because ending the process is the row's most
           consequential action and used to be its least visible control (a 10px
           borderless `close` link, third in a strip of three lookalikes).
           Fires immediately on click: this codebase does not gate destructive
           buttons behind confirms, it makes them hard to misclick instead —
           hence the fixed 16px box, the 4px inset, and danger colour on hover
           only. */
        .item-close-btn {
            flex-shrink: 0;
            width: 16px;
            height: 16px;
            margin-right: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: none;
            border: none;
            border-radius: 3px;
            color: var(--text-secondary);
            font-size: 14px;
            line-height: 1;
            font-family: inherit;
            cursor: pointer;
            opacity: 0.6;
            transition: all 0.15s;
        }
        .item-close-btn:hover {
            opacity: 1;
            color: #f85149;
            background: color-mix(in srgb, #f85149 14%, transparent);
        }
        /* Exited rows: the state the deleted red dot used to carry, now in the
           subline text plus this dimming. */
        .terminal-item.is-exited .item-name,
        .terminal-item.is-exited .item-role { opacity: 0.55; }
```

## Verification Plan

1. **Dot is gone.** Open `/terminals` with several terminals. No sidebar row shows a coloured pip; each shows a `×` at its right edge.
2. **`close` link is gone.** The row's action strip no longer contains the word `close`.
3. **× closes.** Click the × on an active terminal. The process ends immediately — no dialog, no second click — the row disappears from the sidebar on the next list fetch, and if it was seated its pane reverts to the empty placeholder.
4. **× does not seat.** Seat terminal A in the focused pane, then click the × on terminal B. Confirm B closes and the focused pane still holds A — B must not be seated on its way out (this is the `stopPropagation` test).
5. **Row click still works.** Click anywhere in a row *other* than the ×. The terminal seats into the focused pane and takes the caret, exactly as before.
6. **Exited state is visible.** Kill a terminal's process from outside the panel (or run `exit` in it). Confirm the row's subline reads `<name> (exited)` and the row's name/subline dim — without needing a tooltip or a colour-vision judgement.
7. **× on an exited row.** Click the × on the exited row. It clears from the sidebar (this is how a dead row is dismissed) with no console error.
8. **Hover affordance.** Hover the ×: it brightens to `#f85149` with a faint red wash, and its tooltip reads `Close terminal (ends the process)`.
9. **Accessibility.** Inspect the ×: it is a real `<button>` with `aria-label="Close <name>"`. Tab to it with the keyboard and press Enter — the terminal closes.
10. **Layout at width.** With a long agent label (e.g. `Antigravity CLI`) and a `📌P1` chip and a badge on the same row, confirm the × stays pinned at the right edge and the name ellipsizes rather than pushing the × out of the 220px sidebar.
11. **Groups view.** Switch to the saved-groups sidebar view and confirm rows there render the × identically (same `renderTerminalRow`) and closing from a group row works.
12. **No confirm gate anywhere.** Grep the diff for `confirm(` and confirm there is none — per project rule, and because it would be a silent no-op in a webview.
