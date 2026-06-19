# Fix Copy Chat Prompt Toast Notification and Restyle Status Messages to Teal

## Goal

Replace the persistent VS Code toast fired by the **kanban sub-bar** CHAT PROMPT button with the existing timed in-panel flash (`#status-message`), and restyle non-error flash messages from grey (`--text-secondary`) to the accent colour (`--accent-teal`) so they are readable.

### Problem

Clicking the **CHAT PROMPT** button in the kanban sub-bar fires a persistent VS Code toast notification ("Planning chat prompt copied to clipboard") that hangs until manually dismissed. The correct behaviour — a timed flash in the `#status-message` element already present in the same sub-bar — is already implemented and working for other actions (e.g. `copyChatWorkflow` at `KanbanProvider.ts:5350`, batch-move at `:5319`) but was never wired up for this one. Additionally, flash messages render in `--text-secondary` (grey `#888888`), which is barely readable against the panel background. They should use `--accent-teal` for consistency with all other active UI elements.

> **Clarification — two buttons, two routes (verified, not assumed):**
> There are **two** distinct `#btn-chat-copy-prompt` buttons, on two different webviews, hitting two different code paths:
> - **Route A — Kanban sub-bar** (`kanban.html:2267`, listener `kanban.html:6687`): posts `chatCopyPrompt` → handled in `KanbanProvider.ts:5323`, which fires the offending toast at **`KanbanProvider.ts:5344`**. **This is the reported bug.** The kanban webview already has the `showStatusMessage` handler (`kanban.html:5615`) and the `#status-message` element (`kanban.html:2268`), so it can flash.
> - **Route B — Project panel** (`project.html:1034`, listener `project.js:837`): posts `copyChatPrompt` → `PlanningPanelProvider.ts:2123` → executes the `switchboard.copyChatPrompt` command (`extension.ts:905`) → toast at `extension.ts:913`. The Project webview has **no** `showStatusMessage` handler and **no** status element, so it has no in-panel flash to fall back to.

---

## Metadata

**Tags:** frontend, bugfix, ui
**Complexity:** 4

---

## User Review Required

- **Route B (Project panel) feedback.** The original plan proposed removing the toast from the `switchboard.copyChatPrompt` command "with no replacement." That command is the **only** feedback channel for the Project-panel CHAT PROMPT button (`project.html:1034`), which has no in-panel flash mechanism. Removing it silently would make that button give zero feedback on click — a regression.
  - **Recommended decision (taken below): keep the toast on the `switchboard.copyChatPrompt` command (do NOT change `extension.ts:913`).** This fixes the reported kanban bug with no regression and no net-new scope. If you later want the Project panel to flash instead of toast, that is a separate change (add a `#status-message` element + `showStatusMessage` handler to `project.html`/`project.js`) and out of scope here.
  - Confirm this is acceptable, or state that you want the Project-panel button to (a) stay silent, or (b) get a new flash element.

---

## Complexity Audit

### Routine
- Single-line message-channel swap in `KanbanProvider.ts` (toast → existing `postMessage`/`showStatusMessage`), reusing the pattern already present three lines below at `:5350`.
- Two single-token colour swaps in `kanban.html` (CSS default + JS inline override), both `--text-secondary` → `--accent-teal`.
- No state, no migration, no schema, no clipboard logic touched.

### Complex / Risky
- **Regression trap in the original Step 2:** the `switchboard.copyChatPrompt` command is wired to a live Project-panel button; naively deleting its toast removes that button's only feedback. Handled by the decision above (leave the command's toast intact).

---

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `showStatusMessage` already self-manages its timer — it clears any prior `_statusTimeoutId` and restarts the flash animation via reflow (`kanban.html:5623-5635`). Rapid repeated clicks simply restart the 5s timer; no leak, no overlap.
- **Security:** None. The flashed string is `Planning chat prompt copied${planWord}.` where `planWord` is derived from an integer count (`for ${count} plan(s)`), assigned via `textContent` (`kanban.html:5618`), so no HTML/script injection surface.
- **Side Effects:**
  - Error messages remain unaffected — the `isError` branch keeps `--vscode-errorForeground` (`kanban.html:5620`); only the non-error branch turns teal.
  - The `.sub-bar-status` CSS class (line 177) is used by exactly one element, `#status-message` (`kanban.html:2268`) — verified via grep — so the CSS colour change at line 183 has no unintended spillover. The inline style at `:5621` overrides the CSS at runtime, which is why **both** must change.
  - Cosmetic (pre-existing, out of scope): the flash animation `statusFlash` runs 3s (`kanban.html:190`, opacity returns to 0 at 100%) while the text is not cleared until 5s (`:5631`); the message is visually faded but DOM-present for the final 2s. Not introduced by this change.
- **Dependencies & Conflicts:**
  - `--accent-teal` resolves to `#00e5ff` (default theme, `kanban.html:25-26`) and `#D97757` (Claudify theme, `:35`). The variable name says "teal" but is the project accent token; both renderings are intended. No action needed — just don't be alarmed that it isn't literally teal.
  - **Build dependency:** per `CLAUDE.md`, webview edits (`src/webview/*`) require `npm run compile` to take effect (extension serves from `dist/webview/`). Compile is deferred to the user this session (see Verification Plan).

---

## Dependencies

None — no upstream session work required.

---

## Adversarial Synthesis

**Risk Summary:** The only real risk is the original Step 2, which would have silently broken the Project-panel CHAT PROMPT button — that command is its sole feedback channel and the Project webview has no in-panel flash. Mitigation: leave the `switchboard.copyChatPrompt` toast intact; only the kanban route (Route A) changes to a flash. The teal restyle is safe provided both the CSS default (`:183`) and the inline JS override (`:5621`) are changed, since the inline style wins at runtime.

---

## Proposed Changes

### `src/services/KanbanProvider.ts` (Route A — the actual bug)

- **Context:** The `chatCopyPrompt` message handler (`:5323`) builds the prompt, writes it to the clipboard (`:5341`), then fires a persistent toast at **`:5344`** (the original plan cited `:5335`, which is mid-`.map()` — corrected here).
- **Logic:** Swap the toast for the existing in-panel flash, matching the sibling `copyChatWorkflow` handler at `:5350`.
- **Implementation:**
  Replace (`KanbanProvider.ts:5344`):
  ```ts
  vscode.window.showInformationMessage(`Planning chat prompt copied to clipboard${planWord}.`);
  ```
  With:
  ```ts
  this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Planning chat prompt copied${planWord}.`, isError: false });
  ```
- **Edge Cases:** `planWord` is `''` when no plans are selected (general chat consultation) and ` for N plan(s)` otherwise (`:5343`) — message reads correctly in both cases. `this._panel?.` is optional-chained, so a closed panel is a safe no-op.

### `src/extension.ts` (Route B — DO NOT remove the toast)

- **Context:** `switchboard.copyChatPrompt` (`:905`) is executed by the Project-panel button via `PlanningPanelProvider.ts:2125`. Its toast at `:913` is that button's only feedback.
- **Decision:** **Leave `extension.ts:913` unchanged.** The original plan's premise ("this command is not triggered by the button") is incorrect — it is. The secondary claim ("the command already returns the prompt string to the caller") is also incorrect: the callback (`:905-917`) assigns `prompt` locally and returns `undefined`. Removing the toast would leave the Project-panel button silent with no fallback flash.
- **Implementation:** No change.
- **Edge Cases:** N/A (no change). Revisit only if the Project panel gains its own flash mechanism (see User Review Required).

### `src/webview/kanban.html` (teal restyle — both locations)

- **Context:** Non-error flash text is grey and hard to read. Two places set the colour; the inline style (b) overrides the CSS (a) at runtime, so both must change.
- **Logic:** Replace `--text-secondary` with `--accent-teal` in both.
- **Implementation:**
  **a. CSS rule (`kanban.html:183`)** on `.sub-bar-status`:
  ```css
  /* before */
  color: var(--text-secondary);
  /* after */
  color: var(--accent-teal);
  ```
  **b. JS `showStatusMessage` inline override (`kanban.html:5621`)**:
  ```js
  // before
  : 'var(--text-secondary)';
  // after
  : 'var(--accent-teal)';
  ```
- **Edge Cases:** Error branch (`isError === true`) is untouched and stays red (`:5620`). `.sub-bar-status` styles only `#status-message`, so no spillover.

### Rebuild

```
npm run compile
```
Required for the `kanban.html` changes to reach `dist/webview/` (per `CLAUDE.md`). Deferred to the user this session per the SKIP COMPILATION directive.

---

## Verification Plan

> Per session directives, compilation and the automated test suite are run separately by the user; the steps below describe what to confirm, not commands to execute now.

### Automated Tests
- No existing automated coverage targets the flash-message colour or the `chatCopyPrompt` toast; these are webview-rendering concerns. No new automated tests are warranted for a copy-swap and two colour-token changes.

### Manual Verification (post-`npm run compile`)
1. **Kanban sub-bar CHAT PROMPT, no selection:** click → `#status-message` flashes "Planning chat prompt copied." in teal/accent for ~5s and auto-clears; **no** VS Code toast appears.
2. **Kanban sub-bar CHAT PROMPT, with N plans selected:** click → flash reads "Planning chat prompt copied for N plan(s)."; selection clears; no toast.
3. **Colour:** confirm the flashed text renders in the accent colour (`#00e5ff` default, `#D97757` Claudify), not grey.
4. **Error path unaffected:** trigger any `isError: true` status message → still renders red.
5. **Project panel CHAT PROMPT (regression guard):** click the Project-panel button (`project.html`) → its existing toast still appears (confirming Route B feedback was preserved).

---

## Recommendation

**Complexity 4 → Send to Coder.** The edits are mechanically small, but the Route B regression trap (the original Step 2) requires judgment to avoid silently breaking the Project-panel button — more than a rote find-and-replace.
