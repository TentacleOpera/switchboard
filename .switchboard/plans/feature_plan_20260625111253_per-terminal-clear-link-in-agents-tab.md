# Per-Terminal "clear" Link in Agents Tab Terminal List

## Goal

Add a "clear" link/button next to the existing "locate" button for each terminal card in the Agents tab of `implementation.html`. Clicking it sends the `/clear` command to **only that specific terminal**, unlike the existing "CLEAR TERMINALS" button in the Terminals tab which broadcasts `/clear` to all agent terminals simultaneously.

### Problem Analysis

**Background:** The Agents tab in `implementation.html` renders a card for each agent terminal (planner, coder, reviewer, jules, analyst, etc.). Each card has a "locate" link that focuses the corresponding VS Code terminal. The Terminals tab has a separate "CLEAR TERMINALS" button that iterates over all alive agent terminals and sends `/clear` to each one (lines 1722–1733).

**Root Cause:** There is no per-terminal clear affordance. A user who wants to reset the context of a *single* agent terminal must either use the broadcast clear (which resets all terminals) or manually type `/clear` into the terminal. This is a UX gap — the "locate" button already proves the per-terminal targeting pattern works, and the `sendToTerminal` message handler on the extension side (TaskViewerProvider.ts line 9762) already supports sending arbitrary input to a specific named terminal.

**Why now:** The user identified this during testing as a missing convenience feature. The infrastructure (`sendToTerminal` with a specific `name`) already exists and is used by the broadcast clear; we simply need a per-card UI element that invokes it for one terminal instead of looping over all.

## Metadata
- **Tags:** [frontend, UI, UX, agents-tab, terminals]
- **Complexity:** 2

## Complexity Audit

### Routine
- Adding a "clear" button element next to each "locate" button in two render functions (`createAgentRow` and `createAnalystRow`)
- Reusing the existing `.locate-btn` CSS class (or a sibling class) for consistent styling
- Wiring the click handler to post a `sendToTerminal` message with `input: '/clear'` and the resolved terminal name

### Complex / Risky
- None. The `sendToTerminal` handler already validates terminal name and input, resolves the terminal object (registered → open terminals fallback), and calls `sendRobustText`. No extension-side changes are needed.

## Edge-Case & Dependency Audit

- **Chat-only agents:** The "locate" button is disabled for chat-only non-local agents (`isChatOnly` check at line 2788). The "clear" button must follow the same gating — chat-only agents have no local terminal to send `/clear` to, so the button should be disabled or hidden under the same conditions.
- **Jules terminal:** The jules card (line 2774) has a locate button that targets `'Jules Monitor'`. Jules is not a standard CLI agent — sending `/clear` to it may not be meaningful. The clear button should still be added for consistency but should use the same terminal name (`'Jules Monitor'`). If jules doesn't support `/clear`, the shell will silently report "command not found", which is acceptable (same behavior as the broadcast clear which also sends to jules if `term.role && term.alive`).
- **No terminal resolved:** When `resolvedTermName` is falsy (terminal not yet created/registered), the clear button must be disabled — identical to the locate button's `disabled = !resolvedTermName` logic.
- **Analyst card:** The analyst card (line 3452) uses `termName` (found by role === 'analyst') rather than `resolvedTermName`. The clear button must use `termName` for the analyst card.
- **Re-render safety:** Both `createAgentRow` and `createAnalystRow` rebuild the DOM from scratch on each `terminalStatuses` push (the agents tab is dynamic, unlike the terminals tab which is static HTML). The clear button will be recreated each time, so no stale-state cleanup is needed.
- **No confirmation dialog:** Per CLAUDE.md rules, the clear button must NOT use `window.confirm()` or any confirmation gate. It clears immediately on click.

## Proposed Changes

### File: `src/webview/implementation.html`

#### Change 1: Add "clear" button next to "locate" in `createAgentRow` (main agent cards)

**Location:** Lines 2774–2796, inside the `if (roleId === 'jules') { ... } else if (!hideLocate) { ... }` block.

Add a "clear" button immediately after each "locate" button append. The clear button uses the same `.locate-btn` class for visual consistency, is disabled under the same conditions as locate, and sends `/clear` to the resolved terminal name.

**For the jules branch (after line 2781):**
```javascript
// Clear Button (per-terminal)
const clearBtn = document.createElement('button');
clearBtn.className = 'locate-btn';
clearBtn.innerText = 'clear';
clearBtn.style.marginLeft = '6px';
clearBtn.onclick = () => {
    vscode.postMessage({
        type: 'sendToTerminal',
        name: 'Jules Monitor',
        input: '/clear',
        paced: false,
        source: { actor: 'switchboard-ui', tool: 'clear-terminal', allowBroadcast: false }
    });
};
header.appendChild(clearBtn);
```

**For the non-jules branch (after line 2795, inside the `else if (!hideLocate)` block):**
```javascript
// Clear Button (per-terminal)
const clearBtn = document.createElement('button');
clearBtn.className = 'locate-btn';
clearBtn.innerText = 'clear';
clearBtn.style.marginLeft = '6px';
clearBtn.disabled = !resolvedTermName || isChatOnly;
if (isChatOnly) clearBtn.style.opacity = '0.3';
clearBtn.onclick = () => {
    if (!resolvedTermName) return;
    vscode.postMessage({
        type: 'sendToTerminal',
        name: resolvedTermName,
        input: '/clear',
        paced: false,
        source: { actor: 'switchboard-ui', tool: 'clear-terminal', allowBroadcast: false }
    });
};
header.appendChild(clearBtn);
```

#### Change 2: Add "clear" button next to "locate" in `createAnalystRow`

**Location:** Line 3459, immediately after the locate button append.

```javascript
// Clear Button (per-terminal)
const clearBtn = document.createElement('button');
clearBtn.className = 'locate-btn';
clearBtn.innerText = 'clear';
clearBtn.style.marginLeft = '6px';
clearBtn.disabled = !termName;
clearBtn.onclick = () => {
    if (!termName) return;
    vscode.postMessage({
        type: 'sendToTerminal',
        name: termName,
        input: '/clear',
        paced: false,
        source: { actor: 'switchboard-ui', tool: 'clear-terminal', allowBroadcast: false }
    });
};
header.appendChild(clearBtn);
```

#### Change 3 (optional): Add `.clear-btn` spacing via CSS

If inline `marginLeft` is not preferred, add a small CSS rule near the `.locate-btn` block (line 601):

```css
.locate-btn + .locate-btn {
    margin-left: 6px;
}
```

This avoids inline styles and automatically applies spacing whenever two `.locate-btn` elements are siblings.

## Verification Plan

1. **Build:** Run `npm run compile` to confirm no webpack errors.
2. **Visual check:** Open the implementation panel in VS Code, navigate to the Agents tab. Confirm each agent card (planner, coder, reviewer, jules, analyst) shows a "clear" link to the right of the "locate" link.
3. **Disabled state:** When a terminal is not yet created (no terminal resolved), confirm the "clear" link is disabled (greyed out, non-clickable) — same as "locate".
4. **Chat-only agents:** For chat-only non-local agents, confirm the "clear" link is disabled at 0.3 opacity — same as "locate".
5. **Per-terminal clear:** Open one or more agent terminals. Click "clear" on a single agent card. Confirm only that terminal receives `/clear` (its context resets) while other terminals are unaffected.
6. **No confirmation dialog:** Confirm clicking "clear" immediately sends the command with no `window.confirm()` or modal popup.
7. **Broadcast clear still works:** Switch to the Terminals tab, click "CLEAR TERMINALS", and confirm it still broadcasts `/clear` to all agent terminals (unchanged behavior).
