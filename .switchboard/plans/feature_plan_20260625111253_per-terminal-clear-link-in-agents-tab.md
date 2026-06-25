# Per-Terminal "clear" Link in Agents Tab Terminal List

## Goal

Add a "clear" link/button next to the existing "locate" button for each terminal card in the Agents tab of `implementation.html`. Clicking it sends the `/clear` command to **only that specific terminal**, unlike the existing "CLEAR TERMINALS" button in the Terminals tab which broadcasts `/clear` to all agent terminals simultaneously.

### Problem Analysis

**Background:** The Agents tab in `implementation.html` renders a card for each agent terminal (planner, coder, reviewer, jules, analyst, etc.). Each card has a "locate" link that focuses the corresponding VS Code terminal. The Terminals tab has a separate "CLEAR TERMINALS" button that iterates over all alive agent terminals and sends `/clear` to each one (lines 1722–1733).

**Root Cause:** There is no per-terminal clear affordance. A user who wants to reset the context of a *single* agent terminal must either use the broadcast clear (which resets all terminals) or manually type `/clear` into the terminal. This is a UX gap — the "locate" button already proves the per-terminal targeting pattern works, and the `sendToTerminal` message handler on the extension side (TaskViewerProvider.ts line 9762) already supports sending arbitrary input to a specific named terminal.

**Why now:** The user identified this during testing as a missing convenience feature. The infrastructure (`sendToTerminal` with a specific `name`) already exists and is used by the broadcast clear; we simply need a per-card UI element that invokes it for one terminal instead of looping over all.

## Metadata
- **Tags:** [frontend, ui, ux, feature]
- **Complexity:** 2

## User Review Required

No. This is a low-risk, single-file UI addition that reuses the existing `sendToTerminal` message handler (TaskViewerProvider.ts line 9762) and the existing `.locate-btn` styling pattern. No extension-side changes, no data migrations, no new APIs. The user requested this directly during testing.

## Complexity Audit

### Routine
- Adding a "clear" button element next to each "locate" button in two render functions (`createAgentRow` at lines 2774–2796, and `createAnalystRow` at line 3459)
- Reusing the existing `.locate-btn` CSS class (defined at line 601) for consistent styling
- Wiring the click handler to post a `sendToTerminal` message with `input: '/clear'` and the resolved terminal name
- Mirroring the existing disabled-state gating (`!resolvedTermName || isChatOnly`) from the locate button

### Complex / Risky
- None. The `sendToTerminal` handler (TaskViewerProvider.ts lines 9762–9813) already validates terminal name and input, resolves the terminal object (registered → open terminals fallback), and calls `sendRobustText`. No extension-side changes are needed.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Both `createAgentRow` and `createAnalystRow` rebuild the DOM from scratch on each `terminalStatuses` push (the agents tab is dynamic, unlike the terminals tab which is static HTML). The clear button is recreated each render, so no stale-state cleanup is needed. A double-click race is mitigated by briefly disabling the button on click (see Clarification below).
- **Security:** None. The `sendToTerminal` handler validates `name` (must be non-empty string) and `input` (must be string) at lines 9767–9774. The `source` field is informational only and intentionally not destructured (line 9763 comment). The webview is a trusted context.
- **Side Effects:** Sending `/clear` resets the target terminal's conversation context. This is the intended behavior and matches the existing broadcast clear. No other terminals are affected (per-terminal targeting, not a loop).
- **Dependencies & Conflicts:**
  - **Chat-only agents:** The "locate" button is disabled for chat-only non-local agents (`isChatOnly` check at line 2788). The "clear" button must follow the same gating — chat-only agents have no local terminal to send `/clear` to, so the button is disabled under the same conditions.
  - **Jules terminal:** The jules card (line 2774) has a locate button that targets `'Jules Monitor'`. Jules is not a standard CLI agent — sending `/clear` to it may not be meaningful. The clear button is added for consistency using the same terminal name (`'Jules Monitor'`). **Clarification:** The jules clear button must be disabled when no `Jules Monitor` terminal is registered/resolved, mirroring the broadcast clear's `term.role && term.alive` guard (line 1724). Without this, clicking clear on a dead/absent jules terminal hits the silent `terminal not found` error path (line 9806) — an asymmetry with the broadcast clear which intentionally skips dead terminals.
  - **No terminal resolved:** When `resolvedTermName` is falsy (terminal not yet created/registered), the clear button is disabled — identical to the locate button's `disabled = !resolvedTermName` logic (line 2789).
  - **Analyst card:** The analyst card (line 3452) uses `termName` (found by role === 'analyst' at line 3414) rather than `resolvedTermName`. The clear button uses `termName` for the analyst card.
  - **`hideLocate` co-gating:** **Clarification:** The clear button for non-jules agents is placed inside the `else if (!hideLocate)` block (line 2782), so it is intentionally hidden whenever locate is hidden. This is correct — a terminal that cannot be targeted for focus also cannot be targeted for clear.
  - **No confirmation dialog:** Per CLAUDE.md rules, the clear button must NOT use `window.confirm()` or any confirmation gate. It clears immediately on click. (`window.confirm()` is a silent no-op in VS Code webviews anyway.)

## Dependencies

None. This plan has no dependencies on other plans or sessions.

## Adversarial Synthesis

Key risks: (1) the jules clear button lacks an alive/resolved guard, creating an asymmetry with the broadcast clear's `term.alive` check; (2) no click feedback leaves the user unsure whether `/clear` fired, and permits double-click double-dispatch; (3) the `hideLocate` co-gating is correct but undocumented. Mitigations: add a `disabled` guard to the jules clear button, add a brief click-debounce/visual flicker on all clear buttons, and document the `hideLocate` co-gating inline. All mitigations are one-line additions within the existing pattern — complexity remains 2.

## Proposed Changes

### File: `src/webview/implementation.html`

#### Change 1: Add "clear" button next to "locate" in `createAgentRow` (main agent cards)

**Location:** Lines 2774–2796, inside the `if (roleId === 'jules') { ... } else if (!hideLocate) { ... }` block.

Add a "clear" button immediately after each "locate" button append. The clear button uses the same `.locate-btn` class for visual consistency, is disabled under the same conditions as locate, and sends `/clear` to the resolved terminal name. A brief click-debounce disables the button for ~600ms to prevent double-click double-dispatch and gives visual feedback.

**For the jules branch (after line 2781):**
```javascript
// Clear Button (per-terminal) — disabled when no Jules Monitor terminal is registered
const clearBtn = document.createElement('button');
clearBtn.className = 'locate-btn';
clearBtn.innerText = 'clear';
clearBtn.style.marginLeft = '6px';
// Clarification: gate on Jules Monitor being registered, mirroring broadcast clear's term.alive guard
const julesTerm = lastTerminals['Jules Monitor'];
clearBtn.disabled = !(julesTerm && julesTerm.alive);
clearBtn.onclick = () => {
    if (clearBtn.disabled) return;
    clearBtn.disabled = true;
    clearBtn.innerText = 'clearing';
    vscode.postMessage({
        type: 'sendToTerminal',
        name: 'Jules Monitor',
        input: '/clear',
        paced: false,
        source: { actor: 'switchboard-ui', tool: 'clear-terminal', allowBroadcast: false }
    });
    setTimeout(() => { clearBtn.disabled = !(julesTerm && julesTerm.alive); clearBtn.innerText = 'clear'; }, 600);
};
header.appendChild(clearBtn);
```

**For the non-jules branch (after line 2795, inside the `else if (!hideLocate)` block):**
```javascript
// Clear Button (per-terminal) — co-gated with locate via hideLocate; disabled for chat-only/ unresolved terminals
const clearBtn = document.createElement('button');
clearBtn.className = 'locate-btn';
clearBtn.innerText = 'clear';
clearBtn.style.marginLeft = '6px';
clearBtn.disabled = !resolvedTermName || isChatOnly;
if (isChatOnly) clearBtn.style.opacity = '0.3';
clearBtn.onclick = () => {
    if (!resolvedTermName) return;
    clearBtn.disabled = true;
    clearBtn.innerText = 'clearing';
    vscode.postMessage({
        type: 'sendToTerminal',
        name: resolvedTermName,
        input: '/clear',
        paced: false,
        source: { actor: 'switchboard-ui', tool: 'clear-terminal', allowBroadcast: false }
    });
    setTimeout(() => { clearBtn.disabled = !resolvedTermName || isChatOnly; clearBtn.innerText = 'clear'; }, 600);
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
    clearBtn.disabled = true;
    clearBtn.innerText = 'clearing';
    vscode.postMessage({
        type: 'sendToTerminal',
        name: termName,
        input: '/clear',
        paced: false,
        source: { actor: 'switchboard-ui', tool: 'clear-terminal', allowBroadcast: false }
    });
    setTimeout(() => { clearBtn.disabled = !termName; clearBtn.innerText = 'clear'; }, 600);
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

> **Note:** Compilation and automated tests are skipped per session directives. The project is assumed pre-compiled; the test suite is run separately by the user.

### Automated Tests

Skipped per session directive — no unit/integration/e2e tests will be run as part of this plan. The user will run the test suite separately.

### Manual Verification

1. **Visual check:** Open the implementation panel in VS Code, navigate to the Agents tab. Confirm each agent card (planner, coder, reviewer, jules, analyst) shows a "clear" link to the right of the "locate" link.
2. **Disabled state:** When a terminal is not yet created (no terminal resolved), confirm the "clear" link is disabled (greyed out, non-clickable) — same as "locate".
3. **Chat-only agents:** For chat-only non-local agents, confirm the "clear" link is disabled at 0.3 opacity — same as "locate".
4. **Jules alive-gating:** When no `Jules Monitor` terminal is registered or it is not alive, confirm the jules "clear" link is disabled. When jules is alive, confirm it is enabled.
5. **`hideLocate` co-gating:** For any agent where the "locate" link is hidden (`hideLocate` true), confirm the "clear" link is also absent.
6. **Per-terminal clear:** Open one or more agent terminals. Click "clear" on a single agent card. Confirm only that terminal receives `/clear` (its context resets) while other terminals are unaffected. Confirm the button briefly shows "clearing" and re-enables after ~600ms.
7. **No confirmation dialog:** Confirm clicking "clear" immediately sends the command with no `window.confirm()` or modal popup.
8. **Double-click safety:** Rapidly double-click "clear" on a single card. Confirm only one `/clear` is dispatched (button is disabled during the debounce window).
9. **Broadcast clear still works:** Switch to the Terminals tab, click "CLEAR TERMINALS", and confirm it still broadcasts `/clear` to all agent terminals (unchanged behavior).

---

**Recommendation:** Complexity 2 → **Send to Intern**.

## Reviewer Pass (2026-06-25)

### Stage 1 — Grumpy Principal Engineer

*Cracks knuckles. Stares at the diff.*

**MAJOR — None.** I went looking for a smoking gun and found a water pistol. The jules alive-gating (`clearBtn.disabled = !(julesTerm && julesTerm.alive)`, line 2785) actually mirrors the broadcast clear's `term.role && term.alive` guard (line 1721). The asymmetry the Adversarial Synthesis *warned* about was already mitigated in the implementation. Color me surprised — someone read their own plan.

**NIT — non-jules onclick guard is asymmetric with jules.** The jules branch defends itself with `if (clearBtn.disabled) return;` (line 2787). The non-jules branch (line 2822) and analyst branch (line 3506) only guard with `if (!resolvedTermName) return;` / `if (!termName) return;` — they never re-check `isChatOnly` or the disabled flag. Is this a bug? **No.** Disabled buttons don't dispatch click events, and `disabled` is set to `!resolvedTermName || isChatOnly` at render time, so a chat-only button is unclickable. The guard is belt-and-suspenders that's missing one suspender. It's cosmetic, not load-bearing.

**NIT — stale closure in the 600ms restore.** `julesTerm`, `resolvedTermName`, and `isChatOnly` are captured at render time and reused inside `setTimeout`. If terminal state changes mid-debounce, the restore writes the *old* disabled state. But the whole row is rebuilt on the next `terminalStatuses` push, which replaces the DOM node entirely — so the stale closure is garbage-collected before it can lie to anyone. The plan documents this explicitly (Edge-Case Audit, line 36). Non-issue.

**NIT — jules clear button has no `isChatOnly` opacity override.** Moot — jules is never a chat-only agent, so the `if (isChatOnly) opacity = 0.3` branch (line 2820) would be dead code if copied here. Correctly omitted.

**PRAISE — Change 3 (optional) was chosen over inline `marginLeft`.** The implementer added `.locate-btn + .locate-btn { margin-left: 6px; }` (line 617) instead of inline `style.marginLeft` on every button. This is the *better* choice: no inline-style duplication, automatically applies to any future sibling `.locate-btn` pair, and keeps the JS clean. The plan offered it as optional; the implementer picked the cleaner path. Good judgment.

### Stage 2 — Balanced Synthesis

| Finding | Severity | Verdict |
|---|---|---|
| jules alive-gating | — | Already correct in implementation. Keep. |
| non-jules/analyst onclick guard asymmetry | NIT | Defer — harmless due to disabled-gating; adding it is cosmetic and would deviate from the plan's specified onclick body. |
| stale closure in 600ms restore | NIT | Defer — self-correcting via row rebuild on next push. Documented in plan. |
| jules missing isChatOnly opacity | NIT | Won't fix — jules is never chat-only. |
| CSS `.locate-btn + .locate-btn` chosen over inline marginLeft | — | Keep — cleaner than plan's primary proposal. |

**No CRITICAL or MAJOR findings. No code fixes required.** The implementation is a faithful, clean realization of the plan. All three changes (jules clear, non-jules clear, analyst clear) are present and correct. The optional CSS approach (Change 3) was adopted in preference to inline styles — an improvement.

### Files Changed (Verified in working tree)

- `src/webview/implementation.html`
  - Lines 617–619: added `.locate-btn + .locate-btn { margin-left: 6px; }` CSS rule (Change 3, optional — adopted).
  - Lines 2779–2799: jules clear button in `createAgentRow` (Change 1, jules branch).
  - Lines 2815–2834: non-jules clear button in `createAgentRow` (Change 1, non-jules branch).
  - Lines 3500–3518: analyst clear button in `createAnalystRow` (Change 2).
- `src/services/TaskViewerProvider.ts` — **no changes** (handler at lines 9891–9942 reused as-is; confirmed validates `name`/`input`, resolves terminal, calls `sendRobustText`).

### Validation Results

- **Compilation:** Skipped per session directive.
- **Automated tests:** Skipped per session directive.
- **Static verification (performed):**
  - `grep` confirms all three clear buttons present with correct `sendToTerminal` payload (`type`, `name`, `input: '/clear'`, `paced: false`, `source.tool: 'clear-terminal'`, `allowBroadcast: false`).
  - `sendToTerminal` handler (TaskViewerProvider.ts:9891) confirmed unchanged and validates `name`/`input`.
  - `lastTerminals` (line 1934) confirmed in scope for both `createAgentRow` and `createAnalystRow`.
  - Disabled-state CSS (`.locate-btn:disabled`, line 611) confirmed present — disabled clear buttons render at 0.25 opacity; chat-only override at 0.3 matches locate.
  - No `window.confirm()` / confirmation gate present — complies with CLAUDE.md hard rule.
  - Broadcast clear (lines 1719–1730) confirmed unchanged and still uses `allowBroadcast: true` / `tool: 'clear-terminals'`.
  - Only two row-creator functions exist (`createAgentRow`, `createAnalystRow`); both received clear buttons. No missed render path.

### Remaining Risks

1. **Manual UX verification not run in this session** — the 9-step manual checklist (lines 165–173) requires a live VS Code webview session. The static checks confirm the code is wired correctly, but visual/interaction confirmation (disabled states, per-terminal isolation, double-click debounce) is deferred to the user.
2. **Jules `/clear` semantics** — sending `/clear` to `Jules Monitor` is added "for consistency" per the plan. Whether the Jules monitor terminal meaningfully honors `/clear` is a runtime behavior question outside this code review's scope. The button is correctly alive-gated so a dead jules terminal is a no-op.
3. **NIT (deferred):** onclick guard asymmetry between jules (`if (clearBtn.disabled) return;`) and non-jules/analyst (`if (!resolvedTermName) return;`). Harmless; flagged for awareness only.
