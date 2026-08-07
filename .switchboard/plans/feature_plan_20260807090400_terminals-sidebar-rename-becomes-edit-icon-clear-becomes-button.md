# Move Rename to an Edit Icon Beside the Terminal Name and Promote Clear to a Real Button

## Goal

The Terminals sidebar row puts `rename` in a strip of near-invisible 10px text links, far from the thing it renames, while `clear` — the action the operator actually reaches for repeatedly during a session — is styled identically and is equally hard to see. Fix both: put **rename behind a pencil icon sitting next to the terminal name**, and leave `clear` as the strip's only entry, restyled as a **visible bordered button** instead of a ghost link.

### Problem analysis and root cause

`renderTerminalRow` (`src/webview/terminals.js:1000`) builds an action strip of `.locate-btn` text buttons — `clear` (1081-1090), `rename` (1092-1100), `close` (1102-1110) — all sharing one style:

```css
.locate-btn {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 10px;
    opacity: 0.7;
    ...
}
```
— `src/webview/terminals.html:262-274`.

Two distinct defects:

1. **`rename` is displaced from its object.** Renaming acts on the terminal *name*, which is rendered at the top of the row as `.item-name` (`terminals.js:1015-1022`). The control for it lives in a strip below, textually indistinguishable from two other verbs. The panel already knows the right interaction — double-clicking `.item-name` starts an inline rename via a delegated listener (`terminals.js:454-462` → `beginInlineRename`, `terminals.js:3673`) — but double-click is an undiscoverable gesture with no visual affordance. The `rename` button is just a second, worse entry point to the same function.

2. **`clear` is styled as decoration.** `background: none; border: none; font-size: 10px; opacity: 0.7` at `--text-secondary` on a dark panel is close to invisible. The comment at `terminals.html:257-261` records the intent — "Ports `.locate-btn` from the extension sidebar: text labels, not glyphs, and always visible rather than revealed on hover" — but "always present in the DOM" is not the same as "visible", and porting the extension sidebar's treatment carried over a style tuned for a different, narrower surface. `clear` (send `/clear` to reset the agent's context) is the highest-frequency per-terminal action in a session and reads as the lowest-priority thing in the row.

Root cause: one flat style applied to three verbs of very different frequency and different object. The strip needs to stop being a bucket — the name-scoped action moves to the name, and what remains gets a weight matching how often it is used.

The panel already has the right style for a small visible button: `.btn-unassign-pane` (`terminals.html:727-747`) — transparent fill, `1px solid var(--border-color)`, teal border+text on hover. Reuse that treatment rather than inventing a third button language.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, ux
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- Wrap `.item-name` and a new pencil button in a flex row.
- Delete the `renameBtn` block; point the pencil at the existing `beginInlineRename`.
- Restyle `clear` with a new `.item-clear-btn` class modelled on `.btn-unassign-pane`.

### Complex / Risky
- **`beginInlineRename` replaces the name node in its parent.** It does `nameEl.parentNode.replaceChild(input, nameEl)` and restores it on commit (`terminals.js:3673-3695`). Introducing a wrapper changes what that parent *is*: the input now lands inside `.item-name-row` as a sibling of the pencil. That works, but `.item-name-input` is `width: 100%` (`terminals.html:245-256`), so inside a flex row it needs `min-width: 0` / `flex: 1` or it will overflow the 220px sidebar and push the pencil out.
- **The pencil's click vs. the input's blur-commit.** `beginInlineRename` commits on `blur` (`terminals.js:3690`). Clicking the pencil while an inline edit is already open blurs the input first, committing the edit, and then the handler would try to rename a node that has just been swapped back. The handler must re-read the live `.item-name` element at click time rather than closing over the one captured at render.
- **`stopPropagation` on both new controls.** The whole row seats the terminal on click (`terminals.js:1119-1121`); every in-row control must stop propagation or editing/clearing also seats the terminal. The three existing buttons all do (`terminals.js:1086`, `1097`, `1107`).

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - `renderSidebarList` re-renders rows on every fleet poll. An inline rename in progress lives in DOM the next render replaces — that hazard exists today (the `rename` button and the double-click path share it) and is unchanged by moving the trigger. Not in scope; noted so it is not mistaken for a regression introduced here.
  - `withClearingFeedback` (`terminals.js:3767`) temporarily rewrites the clear button's label and restores it via `restoreLabel`. The call site passes the literal `'clear'` (`terminals.js:1088`). If the visible-button label is changed to anything else (e.g. `Clear`), that third argument must change with it, or the button silently restores to the wrong text after every use.
- **Security:** No new verb, no new payload. `ptyRenameTerminal` and `ptyClearTerminal` are already bound to controls in this exact row.
- **Side Effects:**
  - Double-click-to-rename on `.item-name` keeps working: the delegated listener is on `listEl` and matches via `closest('.item-name')` (`terminals.js:455`), which is unaffected by the new wrapper. Two entry points to rename is fine when one is discoverable and one is a power gesture — the defect was having two *equally undiscoverable* ones.
  - The pencil is an extra 16px of horizontal claim in a 220px sidebar. `.item-name` already ellipsizes (`terminals.html:336-342`); the wrapper must preserve that (`min-width: 0` on the flex child) so the name shortens instead of the row overflowing.
  - `.item-actions` ends up holding a single button. Its `flex-wrap` (`terminals.html:383-388`) and `margin-left: -6px` were tuned for a ghost-link row; the negative margin must go, or a bordered button will hang 6px outside the row's padding box.
- **Dependencies & Conflicts:**
  - Files: `src/webview/terminals.js`, `src/webview/terminals.html`.
  - **Overlaps a companion change** that replaces the row's status dot with an × close button and deletes the `close` link from the strip. Both edit `renderTerminalRow`'s action strip; the edits are disjoint statements (`renameBtn` + `clearBtn` here, `dot` + `closeBtn` there) and neither depends on the other. If both land, `.item-actions` holds exactly the one visible `clear` button — which is the end state each plan assumes for its own layout claims.
  - No migration: presentational only, no persisted state, no settings key, no verb surface change.

## Proposed Changes

### 1. `src/webview/terminals.js` — name row with an edit pencil

Replace the direct `info.appendChild(termNameEl)` (line 1048) with a wrapper, and build the pencil next to it. Insert after `termNameEl` is configured (line 1022):

```js
        // Rename now lives NEXT TO the thing it renames. It was a `rename` word in a
        // strip of lookalike 10px links below the row, displaced from its object; the
        // only discoverable alternative was a double-click gesture with no affordance.
        // Both still work — the delegated dblclick on .item-name is untouched.
        const nameRow = document.createElement('div');
        nameRow.className = 'item-name-row';
        nameRow.appendChild(termNameEl);

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'item-edit-btn';
        editBtn.title = 'Rename terminal';
        editBtn.setAttribute('aria-label', `Rename ${item.friendlyName}`);
        editBtn.innerHTML = '';
        editBtn.appendChild(buildEditGlyph());
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Re-read the live node: beginInlineRename swaps .item-name out for an
            // input and back, and the input commits on blur — so clicking this while
            // an edit is already open would otherwise act on a detached node.
            const liveNameEl = nameRow.querySelector('.item-name');
            if (!liveNameEl) { return; }
            beginInlineRename(liveNameEl, liveNameEl.dataset.friendlyName || item.friendlyName);
        });
        nameRow.appendChild(editBtn);
```

and change the assembly at line 1048:

```js
        info.appendChild(nameRow);
        info.appendChild(roleRow);
```

Add the glyph builder beside the other row helpers (near `brandIconUri`, line 975). Built as inline SVG DOM rather than an `<img>`: it inherits `currentColor` so it follows the theme, and it needs no asset fetch or `img-src` allowance (the panel CSP is `img-src 'self' data:`, `terminals.html:5`).

```js
/** Codicon-shaped pencil, built as inline SVG so it inherits currentColor and
 *  follows the theme. No asset fetch, no img-src dependency. */
function buildEditGlyph() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '11');
    svg.setAttribute('height', '11');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M13.23 1a1.2 1.2 0 0 1 .85.35l.57.57a1.2 1.2 0 0 1 0 1.7l-8.4 8.4-3.4 1.13a.4.4 0 0 1-.5-.5l1.13-3.4 8.4-8.4A1.2 1.2 0 0 1 13.23 1Zm0 1.2-.7.7 1.07 1.07.7-.7-1.07-1.07ZM4.3 11.02l.68.68-1.2.4.52-1.08Zm.44-.86 6.9-6.9 1.07 1.07-6.9 6.9-1.07-1.07Z');
    svg.appendChild(path);
    return svg;
}
```

Delete the `renameBtn` block (lines 1092-1100) in full.

### 2. `src/webview/terminals.js` — promote `clear` to a visible button

Replace lines 1081-1090:

```js
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        // NOT .locate-btn: that style is borderless, 10px, opacity 0.7 — near
        // invisible on this panel. `clear` is the highest-frequency per-terminal
        // action in a session and now wears the panel's existing small-visible-button
        // treatment (same language as .btn-unassign-pane).
        clearBtn.className = 'item-clear-btn';
        clearBtn.textContent = 'clear';
        clearBtn.title = 'Send /clear to this terminal (resets its context)';
        clearBtn.disabled = item.status === 'exited';
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Third arg is the label to restore after the transient feedback — it must
            // stay byte-identical to the textContent set above (withClearingFeedback,
            // terminals.js:3767).
            withClearingFeedback(clearBtn, () => clearTerminal(item.friendlyName), 'clear');
        });
        actions.appendChild(clearBtn);
```

### 3. `src/webview/terminals.html` — CSS

Add after `.item-name` (line 336-342):

```css
        /* Name + inline edit affordance. min-width:0 on the name is load-bearing:
           it is what lets the name ellipsize instead of pushing the pencil out of
           the 220px sidebar. */
        .item-name-row {
            display: flex;
            align-items: center;
            gap: 4px;
            min-width: 0;
        }
        .item-name-row .item-name { min-width: 0; flex: 1; }
        /* beginInlineRename swaps .item-name for .item-name-input in this row, and
           that input is width:100% — it needs the same flex treatment or it
           overflows and displaces the pencil mid-edit. */
        .item-name-row .item-name-input { min-width: 0; flex: 1; width: auto; }
        .item-edit-btn {
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 16px;
            height: 16px;
            padding: 0;
            background: none;
            border: none;
            border-radius: 3px;
            color: var(--text-secondary);
            cursor: pointer;
            opacity: 0.55;
            transition: all 0.15s;
        }
        .item-edit-btn:hover {
            opacity: 1;
            color: var(--accent-teal);
            background: color-mix(in srgb, var(--accent-teal) 12%, transparent);
        }
```

Add after `.locate-btn.is-danger:hover` (line 284-287) — `.locate-btn` itself stays, it is still referenced elsewhere in the panel:

```css
        /* Small visible button. Deliberately the SAME language as
           .btn-unassign-pane (line 727) rather than a third button style: a
           bordered box that reads as pressable at 10px on a black panel, which
           .locate-btn does not. */
        .item-clear-btn {
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
            font-size: 10px;
            font-family: inherit;
            letter-spacing: 0.5px;
            line-height: 1;
            padding: 3px 8px;
            border-radius: 3px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .item-clear-btn:hover:not(:disabled) {
            color: var(--accent-teal);
            border-color: var(--accent-teal);
        }
        .item-clear-btn:disabled {
            opacity: 0.4;
            cursor: default;
        }
```

Amend `.item-actions` (line 383-388) — drop the negative margin, which existed to pull ghost links back into optical alignment and would now hang a bordered button outside the row's padding:

```css
        .item-actions {
            display: flex;
            gap: 4px;
            flex-wrap: wrap;
        }
```

## Verification Plan

1. **Pencil is present and placed.** Open `/terminals` with several terminals. Each sidebar row shows a small pencil immediately to the right of the terminal name, on the same line.
2. **Pencil renames.** Click the pencil. The name turns into a text input pre-filled with the terminal's `friendlyName` (not its CLI label) and selected. Type a new name, press Enter. The row, the pane header and any saved-group entry all show the new name.
3. **Pencil does not seat.** Seat terminal A in the focused pane, then click terminal B's pencil. B enters rename mode and the focused pane still holds A.
4. **Escape cancels.** Click the pencil, type, press Escape. The original name returns and no rename request is sent (check the network tab: no `ptyRenameTerminal`).
5. **Pencil while already editing.** Click the pencil, then click it again without committing. The blur commits the first edit and the second click re-opens an edit on the live node — no console error, no detached-node exception.
6. **Input does not overflow.** Rename a terminal to a 40-character name and enter edit mode. The input stays inside the 220px sidebar and the pencil remains visible (this is the `min-width: 0` / `flex: 1` fix).
7. **Long names still ellipsize.** With a long CLI label (`Antigravity CLI`) plus a `📌P1` chip, confirm the name ellipsizes and the pencil is not pushed out of the row.
8. **`rename` link is gone.** The action strip below the row no longer contains the word `rename`.
9. **Double-click still works.** Double-click a terminal's name (not the pencil). Inline rename opens as before — the delegated `listEl` handler must be unaffected by the new wrapper.
10. **`clear` is visibly a button.** The `clear` control has a visible 1px border and reads as pressable without hovering. Hover turns border and text teal.
11. **`clear` works and restores its label.** Click `clear` on a live agent terminal. The terminal receives `/clear`, the button shows its transient feedback, and it returns to exactly `clear` afterwards — not `Clear`, not blank (this is the `withClearingFeedback` third-argument check).
12. **`clear` disabled on exited.** Kill a terminal. Its `clear` button is disabled at 0.4 opacity and clicking it does nothing.
13. **`clear` does not seat.** Seat terminal A, click terminal B's `clear`. B clears; the focused pane still holds A.
14. **Strip alignment.** Confirm the `clear` button's left edge lines up with the row's text (the `-6px` margin removal) and does not bleed past the row's padding or the `.terminal-item.active` border.
15. **Theme.** Switch to the Claudify theme. The pencil hover and the clear button hover both render terracotta (they derive from `--accent-teal`, which the theme overrides), not cyan.
16. **Accessibility.** Both controls are real `<button>` elements with `aria-label` / `title`; the pencil's SVG is `aria-hidden`. Tab to each and activate with Enter.
17. **Groups view.** Switch to the saved-groups sidebar and confirm rows there render the pencil and the bordered `clear` identically (same `renderTerminalRow`), and both work.
