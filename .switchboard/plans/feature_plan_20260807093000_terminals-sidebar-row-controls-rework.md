# Rework the Terminals Sidebar Row Controls: Inline ×, Edit Pencil, and a Real Clear Button

## Goal

Rework every control on a Terminals sidebar row in one pass over `renderTerminalRow`, so the row's visual weight matches what each control actually does:

1. **Replace the non-interactive status dot with an inline × close button** in the same slot, and delete the `close` text link from the action strip.
2. **Move rename behind an edit pencil sitting beside the terminal name**, and delete the `rename` text link.
3. **Promote `clear` from a near-invisible ghost link to a visible bordered button** — the strip's only remaining entry.
4. **Re-encode the exited state as text** (`<handle> (exited)` plus a dimmed row), since removing the dot removes the sidebar's only exited indicator.

### Problem analysis and root cause

`renderTerminalRow` (`src/webview/terminals.js:1039`) builds each sidebar row as `.terminal-item-top` (an `.item-info` column + a status dot) above `.item-actions` (three text buttons: `clear` / `rename` / `close`). Three separate defects compound into one incoherent row.

**Defect 1 — a state pip owns the row's best target.**

```js
const dot = document.createElement('div');
dot.className = 'status-dot' + (item.status === 'exited' ? ' exited' : '');
```
— `terminals.js:1109-1110`, styled at `src/webview/terminals.html:370-378` as a 7px circle, green normally and red when exited. No listener, no `title`, no accessible name.

It earns nothing. The signal is redundant and weakly encoded: green means "active", which is the state of essentially every row the operator ever looks at — a signal that is almost always the same value carries almost no information. The one case that matters (exited) is conveyed by a 7px colour change with no text, no tooltip and no shape difference: the least legible way to say something important. And it occupies the row's best target — `.terminal-item-top` is `justify-content: space-between` (`terminals.html:314-319`), so the dot owns the right edge, the position a close affordance conventionally occupies and the easiest place to hit.

**Defect 2 — `rename` is displaced from its object.**

Renaming acts on the terminal *name*, rendered at the top of the row as `.item-name` (`terminals.js:1052-1061`). Its control lives in a strip below, textually indistinguishable from two other verbs. The panel already knows the right interaction — double-clicking `.item-name` starts an inline rename via a delegated listener (`terminals.js:478-486` → `beginInlineRename`, `terminals.js:3711`) — but double-click is an undiscoverable gesture with no visual affordance. The `rename` button is just a second, equally undiscoverable entry point to the same function.

**Defect 3 — one flat style for three verbs of very different frequency.**

`clear` (`terminals.js:1120-1129`), `rename` (`1131-1139`) and `close` (`1141-1149`) all wear `.locate-btn`:

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
— `src/webview/terminals.html:262-274`. At `--text-secondary` on a dark panel that is close to invisible. The comment at `terminals.html:257-261` records the intent — "Ports `.locate-btn` from the extension sidebar: text labels, not glyphs, and always visible rather than revealed on hover" — but *always present in the DOM* is not the same as *visible*, and the port carried over a style tuned for a different, narrower surface. So `close` — the row's most consequential action, it ends the process — is a 10px borderless word sitting third in a strip of three lookalikes, and `clear` (send `/clear` to reset the agent's context), the highest-frequency per-terminal action in a session, reads as the lowest-priority thing in the row.

**Root cause.** The row's hierarchy is inverted and its action strip is a bucket. A non-interactive state pip got the prime slot; the process-ending action got a word in link soup; the name-scoped action got filed away from its object; and one flat style flattened three verbs of very different frequency into the same visual weight. The fix is a single pass: give the prime slot to the destructive action, move the name-scoped action to the name, and give what remains a weight matching how often it is used.

### Why this is one plan, not two

This was previously split into two subtask plans (see **Consolidated From** below). They are one unit of work:

- **Same function, same two files, interleaved statements.** Both rewrite `renderTerminalRow` and both edit the same CSS region of `terminals.html`. The project PRD's orchestration discipline is explicit — *"One agent stream per provider file. Same-file parallel edits collide."* They could never have run in parallel.
- **Each depended on the other's end state.** Both claimed `.item-actions` would end up holding exactly one button, and each staked its own layout decisions on that. Landing only the pencil/clear plan would have produced a bordered `clear` sitting next to a ghost `close` link — two button languages in one strip, which is precisely the incoherence this work exists to remove. A single owner resolves `.item-actions`'s final form once.
- **Combined it is one normal card**: ~70 lines of JS in one function and ~80 lines of CSS.

### Preserving the exited signal, properly

Removing the dot removes the only exited indicator in the sidebar row. Do not drop it — re-encode it in text, matching what the **pane header** already does: it appends ` (exited)` to the handle (`terminals.js:2308-2312`, whose comment reads *"Status suffixes attach to the HANDLE: 'planner-2 (exited)' is meaningful, 'CLAUDE CLI (exited)' is not"*). The row gains the same suffix plus an `is-exited` class for dimming. That is strictly more legible than the red pip it replaces.

Which element carries the suffix depends on the row. `.item-name` shows `agentLabel || item.friendlyName` (`terminals.js:1059`) and the subline shows `${friendlyName} · ${role}` only when there *is* an agent label, otherwise just `item.role` (`terminals.js:1083-1085`). So the handle renders in the subline when an agent label exists and in the name line when it does not — the suffix must follow it. See Proposed Changes §2.

The × stays **enabled** for exited rows: closing an exited terminal is how its row is cleared, and `closeTerminal` (`terminals.js:3735`) handles a dead handle — the verb returns `{success:false}`, the handler ignores the result, and the row disappears on the next `fetchTerminalList()`.

Per project rule, the × closes **immediately**. No confirm gate, no two-click pattern — and in a VS Code webview `window.confirm()` is a silent no-op anyway, which would make the button do literally nothing.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux
**Project:** Browser Switchboard
**Feature:** b56fd78d-e0eb-4458-ba16-daab432df3aa
**Consolidated From:** `feature_plan_20260807090300_terminals-sidebar-status-dot-becomes-close-button.md`, `feature_plan_20260807090400_terminals-sidebar-rename-becomes-edit-icon-clear-becomes-button.md`

## User Review Required

None.

## Complexity Audit

### Routine
- Swap one `div.status-dot` for one `button.item-close-btn` in `renderTerminalRow`; append it where `dot` was.
- Delete the `renameBtn` and `closeBtn` blocks from `.item-actions`.
- Wrap `.item-name` and a new pencil button in a flex row; point the pencil at the existing `beginInlineRename`.
- Restyle `clear` with a new `.item-clear-btn` class modelled on the panel's existing `.btn-unassign-pane`.
- Delete two CSS rules (`.status-dot`, `.status-dot.exited`); add four; amend one.

### Complex / Risky

- **Every in-row control must `stopPropagation`.** The whole row seats the terminal in the focused pane on click (`terminals.js:1159-1161`). The ×, the pencil and `clear` all sit *inside* the row, so each needs `e.stopPropagation()` — the three existing action buttons all do (`terminals.js:1126`, `1136`, `1146`) and the two new ones must too, or closing a terminal also seats it a frame before it dies.

- **Deleting the only exited indicator.** Removing the dot without re-encoding the state is a silent information loss. The `(exited)` suffix is not optional polish; it is what makes the removal safe.

- **Appending `(exited)` to `.item-name` is only safe because the rename path reads `dataset`.** `.item-name`'s textContent is display text; the delegated dblclick handler reads `nameEl.dataset.friendlyName` and *not* `textContent` (`terminals.js:480-483`, with a comment recording exactly this trap). The `dataset.friendlyName` stamp at `terminals.js:1060` must stay untouched — with it, a suffixed name line still renames the right terminal; without it, `renameTerminal('planner-2 (exited)', next)` would target a key that does not exist.

- **`beginInlineRename` replaces the name node in its parent.** It does `nameEl.parentNode.replaceChild(input, nameEl)` and restores it on commit (`terminals.js:3711-3733`). Introducing the wrapper changes what that parent *is*: the input now lands inside `.item-name-row` as a sibling of the pencil. That works, but `.item-name-input` is `width: 100%` (`terminals.html:245-256`), so inside a flex row it needs `min-width: 0` / `flex: 1` / `width: auto` or it will overflow the 220px sidebar and push the pencil out.

- **The pencil's click vs. the input's blur-commit.** `beginInlineRename` commits on `blur` (`terminals.js:3728`). Clicking the pencil while an inline edit is already open fires the input's `blur` on *mousedown*, which commits the edit and swaps the name node back, and only then does the pencil's `click` fire. The handler must therefore re-read the live `.item-name` element at click time rather than closing over the one captured at render — otherwise it acts on a node that has just been detached.

- **`withClearingFeedback`'s `restoreLabel` must stay byte-identical to the button's text.** `withClearingFeedback` (`terminals.js:3805-3814`) sets the button to `clearing` for 600 ms and then restores the third argument verbatim. The call site passes the literal `'clear'` (`terminals.js:1127`). If the visible-button label is changed to anything else (e.g. `Clear`), that third argument must change with it, or the button silently restores to the wrong text after every use.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - `closeTerminal` (`terminals.js:3735`) posts `ptyCloseTerminal` then refetches the list. Double-clicking the × sends a second close for a name that no longer exists; the verb returns `{success:false}` and the handler already ignores the result. No new window — same as today's `close` link.
  - `renderSidebarList` re-renders rows on every fleet poll, so an inline rename in progress lives in DOM the next render replaces. That hazard exists today (the `rename` button and the double-click path share it) and is unchanged by moving the trigger — the same is true of the pencil-while-editing case, where the blur-commit's `renameTerminal` → `fetchTerminalList()` re-render will eventually discard a second edit opened in the same gesture. **Not in scope**; recorded so it is not mistaken for a regression introduced here.
  - `withClearingFeedback` bails on `if (btn.disabled) { return; }` (`terminals.js:3806`), so its trailing `btn.disabled = false` can never resurrect a `clear` button that was disabled at render for an exited terminal. The exited-disabled treatment is safe as written.

- **Security:** No new verb, no new payload field, no schema change. `ptyCloseTerminal`, `ptyRenameTerminal` and `ptyClearTerminal` are all already bound to controls in this exact row.

- **Side Effects:**
  - The × ends the agent process. That is what the `close` link did, from the same row, with the same call — no new capability, only a better target. The project's no-confirm rule is explicit that delete-class buttons fire immediately and are made hard to misclick instead; the × is therefore a fixed 16×16 box coloured danger-red only on hover, so it reads as destructive without being twitchy.
  - `.item-actions` drops from three buttons to one. Its `margin-left: -6px` (`terminals.html:387`) existed to pull ghost links back into optical alignment; kept, it would hang a bordered button 6px outside the row's padding box. It must go.
  - Screen readers gain, not lose: the dot had no accessible name at all. The × gets `aria-label="Close <name>"`, the pencil `aria-label="Rename <name>"`, and the exited state moves into visible text.
  - Double-click-to-rename on `.item-name` keeps working: the delegated listener is on `listEl` and matches via `closest('.item-name')` (`terminals.js:480`), which is unaffected by the new wrapper. Two entry points to rename is fine when one is discoverable and one is a power gesture — the defect was having two *equally* undiscoverable ones.
  - The pencil is an extra ~20px of horizontal claim in a 220px sidebar. `.item-name` already ellipsizes (`terminals.html:336-342`); the wrapper must preserve that (`min-width: 0` on the flex child) so the name shortens instead of the row overflowing.
  - The × stays pinned at the right edge for the same reason the dot does today: `.item-info` sets `overflow: hidden` (`terminals.html:330-335`), which makes its flex `min-width: auto` resolve to `0`, so it is the shrinking side of `.terminal-item-top`'s `space-between`. Do not add `overflow: visible` to `.item-info`.
  - `.terminal-item.assigned .item-name { color: var(--text-primary); }` (`terminals.html:790`) sets colour; the new `is-exited` rule sets `opacity`. They compose — an exited assigned row is dimmed, not recoloured.
  - Exited rows already sort last (`terminals.js:1268-1269`); unaffected.

- **Do not delete `.locate-btn` or `.locate-btn.is-danger`.** Both survive this change: `renderGroupSidebar` still uses them for the saved-group `switch` (`terminals.js:1221`) and `delete` (`terminals.js:1230`) buttons. This plan removes their last *row-level* users, not their last users.

- **The `×` glyph is proven in this panel.** The font stack is `'Hanken Grotesk', Menlo, Consolas, sans-serif` (`terminals.html:33`), which carries no exotic symbol glyphs — but `×` (U+00D7, Latin-1 Supplement) already renders here as `.toast-close`'s label (`terminals.js:4874`). No tofu risk, and no need for an SVG.

- **Dependencies & Conflicts:**
  - Files: `src/webview/terminals.js`, `src/webview/terminals.html`. Both files are edited by this plan only — no sibling subtask contends for them.
  - No migration: purely presentational. No persisted state, no settings key, no verb surface change, no schema change. Nothing here has shipped in a released version as user-visible state.
  - CSP is unchanged: the pencil is inline SVG DOM (no asset fetch), so `img-src 'self' data:` (`terminals.html:5`) needs no relaxation.

## Proposed Changes

All JS edits are inside `renderTerminalRow` (`src/webview/terminals.js:1039-1164`) unless stated otherwise. Line numbers are against the current file; apply the edits **top-to-bottom** so earlier insertions do not invalidate later references.

### 1. `src/webview/terminals.js` — add the `is-exited` row class

Amend the class computation (lines 1043-1045):

```js
        itemDiv.className = 'terminal-item'
            + (isFocused ? ' active' : '')
            + (paneIndex !== -1 ? ' assigned' : '')
            + (item.status === 'exited' ? ' is-exited' : '');
```

### 2. `src/webview/terminals.js` — re-encode the exited state as text

Insert the suffix constant just after `const agentLabel = agentLabelForRole(item.role);` (line 1050):

```js
        // "(exited)" qualifies the HANDLE, matching the pane header
        // (terminals.js:2308-2312). WHERE the handle renders depends on the row:
        // with an agent label the name line shows the CLI label and the handle
        // moves to the subline; without one the name line IS the handle. The
        // suffix follows the handle rather than living in a fixed slot.
        const exitedSuffix = item.status === 'exited' ? ' (exited)' : '';
```

Amend the name line (line 1059) — the `dataset.friendlyName` stamp on the next line is what keeps rename correct and must not move:

```js
        termNameEl.textContent = agentLabel || `${item.friendlyName}${exitedSuffix}`;
```

Amend the subline (lines 1083-1085):

```js
        roleEl.textContent = agentLabel
            ? `${item.friendlyName}${exitedSuffix} · ${item.role}`
            : item.role;
```

> Note for the coder: the superseded draft of this change proposed
> `roleEl.textContent = agentLabel ? \`${handle} · ${item.role}\` : \`${handle} · ${item.role}\`;`
> — two identical branches, which both drops the no-agent-label case's plain `item.role` and prints the handle twice in that case (once in the name line, once in the subline). Use the form above.

### 3. `src/webview/terminals.js` — name row with an edit pencil

Replace the direct `info.appendChild(termNameEl);` (line 1088) with a wrapper built after `termNameEl` is configured. Insert immediately before line 1088 (`roleRow` and its icon/`roleEl` are built above and are unchanged):

```js
        // Rename now lives NEXT TO the thing it renames. It was a `rename` word in a
        // strip of lookalike 10px links below the row, displaced from its object; the
        // only other entry point was a double-click gesture with no affordance. Both
        // still work — the delegated dblclick on .item-name (terminals.js:480) is
        // untouched.
        const nameRow = document.createElement('div');
        nameRow.className = 'item-name-row';
        nameRow.appendChild(termNameEl);

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'item-edit-btn';
        editBtn.title = 'Rename terminal';
        editBtn.setAttribute('aria-label', `Rename ${item.friendlyName}`);
        editBtn.appendChild(buildEditGlyph());
        editBtn.addEventListener('click', (e) => {
            // The row seats the terminal on click (itemDiv handler below).
            e.stopPropagation();
            // Re-read the LIVE node: beginInlineRename swaps .item-name out for an
            // input and back, and that input commits on blur — which fires on this
            // button's mousedown, before this click. Closing over the render-time
            // node would act on one that has just been detached.
            const liveNameEl = nameRow.querySelector('.item-name');
            if (!liveNameEl) { return; }
            beginInlineRename(liveNameEl, liveNameEl.dataset.friendlyName || item.friendlyName);
        });
        nameRow.appendChild(editBtn);
```

and change the assembly at line 1088:

```js
        info.appendChild(nameRow);
        info.appendChild(roleRow);
```

Add the glyph builder beside the other row helpers, after `brandIconUri` (which ends at line 1037) and before `renderTerminalRow`. It must sit **inside the file's IIFE** (`terminals.js:1` … `4916`) at the same 4-space indent as its neighbours — the other row helpers are all nested there.

```js
    /** Codicon-shaped pencil, built as inline SVG DOM so it inherits currentColor
     *  and follows the theme. No asset fetch, so no img-src dependency (the panel
     *  CSP is `img-src 'self' data:`, terminals.html:5). */
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

### 4. `src/webview/terminals.js` — replace the dot with a close button

Replace lines 1109-1110:

```js
        // Was a .status-dot: a non-interactive 7px pip in the row's most reachable
        // slot, encoding a bit that is "active" on virtually every row. The exited
        // state it carried now lives in the subline/name text and the row's
        // is-exited class (§1-2), which is strictly more legible than a red circle.
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

Stays enabled when `item.status === 'exited'` — closing is how a dead row is dismissed.

### 5. `src/webview/terminals.js` — amend the action-strip comment

Replace the comment at lines 1115-1118, whose last line currently reads "clear/rename/close remain because they do things the row click does not":

```js
        // No "locate" button: clicking the row already seats the terminal in the
        // focused pane and hands it the caret (itemDiv click handler below). The
        // locate button duplicated that exactly, which is why it read as pointless.
        // `close` moved OUT of this strip to the × at the row's right edge and
        // `rename` moved to the pencil beside the name, leaving `clear` — which is
        // the strip's highest-frequency action and now wears a weight to match.
```

### 6. `src/webview/terminals.js` — promote `clear` to a visible button

Replace lines 1120-1129:

```js
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        // NOT .locate-btn: that style is borderless, 10px, opacity 0.7 — near
        // invisible on this panel. `clear` is the highest-frequency per-terminal
        // action in a session and now wears the panel's existing
        // small-visible-button treatment (same language as .btn-unassign-pane).
        clearBtn.className = 'item-clear-btn';
        clearBtn.textContent = 'clear';
        clearBtn.title = 'Send /clear to this terminal (resets its context)';
        clearBtn.disabled = item.status === 'exited';
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Third arg is the label to restore after the transient 'clearing'
            // feedback — it must stay byte-identical to the textContent set above
            // (withClearingFeedback, terminals.js:3805).
            withClearingFeedback(clearBtn, () => clearTerminal(item.friendlyName), 'clear');
        });
        actions.appendChild(clearBtn);
```

### 7. `src/webview/terminals.js` — delete the `rename` and `close` links

Delete the `renameBtn` block (lines 1131-1139) and the `closeBtn` action-strip block (lines 1141-1149) in full. `.item-actions` is left holding only `clearBtn`.

### 8. `src/webview/terminals.js` — append the × where the dot was

Amend the `topRow` assembly (lines 1151-1154):

```js
        const topRow = document.createElement('div');
        topRow.className = 'terminal-item-top';
        topRow.appendChild(info);
        topRow.appendChild(closeBtn);
```

### 9. `src/webview/terminals.html` — name row and pencil CSS

Add after `.item-name` (lines 336-342):

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

### 10. `src/webview/terminals.html` — replace the status-dot CSS with the close button

Delete `.status-dot` and `.status-dot.exited` (lines 370-378). Add in their place:

```css
        /* Row close. Occupies the slot the status dot held — the row's most
           reachable point — because ending the process is the row's most
           consequential action and used to be its least visible control (a 10px
           borderless `close` link, third in a strip of three lookalikes).
           Fires immediately on click: this codebase does not gate destructive
           buttons behind confirms, it makes them hard to misclick instead — hence
           the fixed 16px box and danger colour on hover only. No margin: the dot
           sat flush against the row's 10px padding edge and the × keeps that
           alignment. */
        .item-close-btn {
            flex-shrink: 0;
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
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
           name/subline text plus this dimming. Opacity, not colour — it must
           compose with `.terminal-item.assigned .item-name` (line 790), which
           sets colour. */
        .terminal-item.is-exited .item-name,
        .terminal-item.is-exited .item-role { opacity: 0.55; }
```

### 11. `src/webview/terminals.html` — the visible `clear` button

Add after `.locate-btn.is-danger:hover:not(:disabled)` (lines 284-287). **`.locate-btn` and `.locate-btn.is-danger` both stay** — `renderGroupSidebar` still uses them for the saved-group `switch`/`delete` buttons (`terminals.js:1221`, `1230`).

```css
        /* Small visible button. Deliberately the SAME language as
           .btn-unassign-pane (line 734) rather than a third button style: a
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

### 12. `src/webview/terminals.html` — amend `.item-actions`

Replace lines 383-388. Drop the negative margin, which existed to pull ghost links back into optical alignment and would now hang a bordered button outside the row's padding box:

```css
        /* Always visible. Hover-reveal put a destructive action underneath a cursor
           that was already moving, and hid it from anyone who never hovered. Now a
           single bordered `clear`; `rename` moved to the pencil beside the name and
           `close` to the × at the row's right edge. */
        .item-actions {
            display: flex;
            gap: 4px;
            flex-wrap: wrap;
        }
```

## Verification Plan

Manual UAT against a running Terminals panel. No compile step and no automated tests are part of this plan.

**The × close button**

1. **Dot is gone.** Open `/terminals` with several terminals. No sidebar row shows a coloured pip; each shows a `×` at its right edge, in the slot the dot occupied.
2. **`close` link is gone.** The action strip below each row no longer contains the word `close`.
3. **× closes.** Click the × on an active terminal. The process ends immediately — no dialog, no second click — the row disappears from the sidebar on the next list fetch, and if it was seated its pane reverts to the empty placeholder.
4. **× does not seat.** Seat terminal A in the focused pane, then click the × on terminal B. B closes and the focused pane still holds A — B must not be seated on its way out (the `stopPropagation` test).
5. **× on an exited row.** Click the × on an exited row. It clears from the sidebar with no console error.
6. **Hover affordance.** Hover the ×: it brightens to `#f85149` with a faint red wash, and its tooltip reads `Close terminal (ends the process)`.
7. **Glyph renders.** The × is a real multiplication sign, not a tofu box (compare against the toast close button, which uses the same character).

**The exited signal**

8. **Exited state is visible, agent row.** Kill the process of a terminal that has an agent CLI label (or run `exit` in it). Its subline reads `<friendlyName> (exited) · <role>` and the row's name and subline dim — without needing a tooltip or a colour-vision judgement.
9. **Exited state is visible, no-agent row.** Do the same for a terminal with no agent assigned. Its **name line** reads `<friendlyName> (exited)` and its subline still reads just the role — the suffix must not appear twice and the subline must not gain a duplicate handle.
10. **Exited row still renames correctly.** With that suffixed row, double-click its name and rename it. Confirm the rename lands (the request carries the bare `friendlyName`, not `"… (exited)"`) — this is the `dataset.friendlyName` check.

**The edit pencil**

11. **Pencil is present and placed.** Each sidebar row shows a small pencil immediately to the right of the terminal name, on the same line.
12. **Pencil renames.** Click the pencil. The name turns into a text input pre-filled with the terminal's `friendlyName` (not its CLI label) and selected. Type a new name, press Enter. The row, the pane header and any saved-group entry all show the new name.
13. **Pencil does not seat.** Seat terminal A, then click terminal B's pencil. B enters rename mode and the focused pane still holds A.
14. **Escape cancels.** Click the pencil, type, press Escape. The original name returns and no rename request is sent (check the network tab: no `ptyRenameTerminal`).
15. **Pencil while already editing.** Click the pencil, then click it again without committing. The blur commits the first edit and the second click re-opens an edit on the live node — no console error, no detached-node exception.
16. **Input does not overflow.** Rename a terminal to a 40-character name and enter edit mode. The input stays inside the 220px sidebar and the pencil remains visible (the `min-width: 0` / `flex: 1` fix).
17. **`rename` link is gone.** The action strip no longer contains the word `rename`.
18. **Double-click still works.** Double-click a terminal's name (not the pencil). Inline rename opens as before — the delegated `listEl` handler must be unaffected by the new wrapper.

**The `clear` button**

19. **`clear` is visibly a button.** The `clear` control has a visible 1px border and reads as pressable without hovering. Hover turns border and text teal.
20. **`clear` works and restores its label.** Click `clear` on a live agent terminal. The terminal receives `/clear`, the button shows its transient `clearing` state, and it returns to exactly `clear` afterwards — not `Clear`, not blank (the `withClearingFeedback` third-argument check).
21. **`clear` disabled on exited.** Kill a terminal. Its `clear` button is disabled at 0.4 opacity, clicking it does nothing, and it is **still** disabled 600 ms later (`withClearingFeedback` must not resurrect it).
22. **`clear` does not seat.** Seat terminal A, click terminal B's `clear`. B clears; the focused pane still holds A.
23. **Strip alignment.** The `clear` button's left edge lines up with the row's text (the `-6px` margin removal) and does not bleed past the row's padding or the `.terminal-item.active` border.

**Layout, theme, and the rest of the panel**

24. **Row click still works.** Click anywhere in a row *other* than the ×, the pencil or `clear`. The terminal seats into the focused pane and takes the caret, exactly as before.
25. **Layout at width.** With a long agent label (e.g. `Antigravity CLI`), a `📌P1` chip and a badge on the same row, the × stays pinned at the right edge and the name ellipsizes rather than pushing the pencil or the × out of the 220px sidebar.
26. **Worktree sub-group rows.** `renderTerminalRow` is called from two places (`terminals.js:1470` for rows directly under a workspace parent, `terminals.js:1532` for rows nested under a worktree sub-group). Expand a worktree sub-group and confirm its rows render the ×, the pencil and the bordered `clear` identically, and that all three work there.
27. **Saved-groups view is untouched.** Switch to the saved-groups sidebar. It renders `.worktree-group-header` rows via `renderGroupSidebar` and never calls `renderTerminalRow` (`renderSidebarList` returns at `terminals.js:1322-1325`), so it must be **unchanged**: its `switch` and `delete` buttons still look and behave exactly as before. This is the regression check that `.locate-btn` and `.locate-btn.is-danger` survived.
28. **Theme.** Switch to the Claudify theme. The pencil hover and the `clear` button hover both render terracotta (they derive from `--accent-teal`, which the theme overrides at `terminals.html:64`), not cyan. The × hover stays `#f85149` in both themes — it is a fixed danger colour by design, matching `.locate-btn.is-danger`.
29. **Accessibility.** The × and the pencil are real `<button type="button">` elements with `aria-label`; the pencil's SVG is `aria-hidden`. Tab to each and activate with Enter — the terminal closes / enters rename mode respectively.
30. **No confirm gate anywhere.** Grep the diff for `confirm(` and confirm there is none — per project rule, and because it would be a silent no-op in a webview.

---

## Completion Report

Implemented all 12 edits from the plan in one pass over `renderTerminalRow` (`src/webview/terminals.js`) and the matching CSS in `src/webview/terminals.html`: replaced the non-interactive `.status-dot` with an inline `× .item-close-btn` at the row's right edge and deleted the `close` link from the action strip; wrapped `.item-name` and a new inline-SVG edit pencil (built by a new `buildEditGlyph` helper) in an `.item-name-row` flex container and deleted the `rename` link; restyled `clear` as a bordered `.item-clear-btn` reusing the panel's `.btn-unassign-pane` language; and re-encoded the exited state as a `(exited)` text suffix on the handle plus an `is-exited` dimming class. Files changed: `src/webview/terminals.js`, `src/webview/terminals.html`. No issues encountered — `node --check` passed (exit 0), no `confirm(` gate present, `.locate-btn`/`.locate-btn.is-danger` survived for `renderGroupSidebar`, and the `dataset.friendlyName` rename stamp is intact. Plan line numbers were stale (file shifted ~284 lines) but all edits applied against actual current line numbers.

## Review Findings

Reviewer pass over `src/webview/terminals.js` and `src/webview/terminals.html`: all 12 plan edits verified present and correct — every in-row control calls `stopPropagation`, the `dataset.friendlyName` stamp survives so a suffixed name still renames the right key, `renameTerminal` short-circuits `next === name` (making the pencil-double-click case a safe no-op), `withClearingFeedback`'s restore label is byte-identical `'clear'`, `.locate-btn`/`.locate-btn.is-danger` survive for `renderGroupSidebar`, no orphaned `.status-dot` reference remains in this panel, and there is no `confirm(` gate. One MAJOR fixed: `.item-clear-btn` had *copied* `.btn-unassign-pane`'s eleven declarations verbatim rather than reusing them as the plan required — the two blocks are now one grouped selector with a single `padding` override. Three NITs fixed: four stale line-number citations in the new comments, and the row's hover `title` now carries `(exited)` like the pane header's does. Deferred, not changed: `.item-name-row .item-name { flex: 1 }` right-aligns the pencil to the info column rather than to the name text whenever the subline is wider (an explicit plan decision, so flagged not overridden), and no static contract test guards any of this (plan scoped verification to manual UAT). Verification run independently despite the plan's manual-only scope: `node --check` OK, `npm run lint` 0 errors, `npm run compile` succeeded (4 pre-existing `cli.ts` warnings), and 9 terminal/panel contract suites pass — the single red in `terminal-focus-affordance` (`entry.inputDropNoticed = false`) is pre-existing and absent at HEAD too, unrelated to this plan; the plan's 30 manual UAT steps remain unexecuted.

