# Terminals Panel's Kanban-Pane Copy Prompt Button Never Reaches the Clipboard in the Browser Host

## Goal

Make the Copy Prompt button in the Terminals panel's kanban pane actually populate the clipboard when Switchboard runs as a browser host, instead of reporting "Copied!" over an untouched clipboard.

### Problem

In the browser host, clicking Copy Prompt on a card in a Terminals-panel kanban pane advances the card a column and reports success, but the clipboard still holds whatever it held before. The operator pastes and gets the wrong text — or nothing — with the card already moved and no way to tell the copy never happened.

### Root cause

`src/webview/terminals.js:2677-2707` posts `/kanban/verb/promptSelected` with a **raw `fetch`**, reads `data.success`, sets the label to "Copied!", and discards `data.prompt`.

The browser host's clipboard write lives in `src/webview/transport.js:292` — it copies `result.prompt` for anything routed through `transport.postMessage`. A raw `fetch` bypasses that hook entirely. Headless has no server-side clipboard (`src/standalone/bootstrap.ts:968-969` says so explicitly), and the standalone `promptSelected` arm only returns the prompt in the response body (`bootstrap.ts:875`). So nothing, on either side, writes it.

In the extension host the button works by accident: `KanbanProvider.ts` `promptSelected` also writes the clipboard server-side via `this._seams().clipboard.writeText(prompt)` before returning the same body (`KanbanProvider.ts:9316`). The bug is therefore browser-host-only and silent — which is why it has survived.

This is also load-bearing for the paste-attribution work: the kanban pane inside the Terminals panel is the copy affordance physically closest to the panes, so it is the one an operator reaches for when pasting a prompt into a terminal.

## Metadata

**Tags:** frontend, bugfix, ui, reliability
**Complexity:** 2
**Project:** Browser Switchboard

## User Review Required

No user decision required. The fix is a straightforward client-side clipboard write with honest failure labelling. The only behavioural change an operator sees is that "Copy failed" can now appear where a silent lie used to.

## Complexity Audit

### Routine
- Single handler block in `src/webview/terminals.js:2677-2707` — add `navigator.clipboard.writeText(data.prompt)` after the response resolves.
- Label transitions: "Copying…" → "Copied!" / "Copy failed" / "Error" — all within the existing `try/catch/setTimeout` structure.
- Double-write in the extension host (server-side seam at `KanbanProvider.ts:9316` plus this client-side write) is idempotent — same string, same clipboard — so no host branch is needed.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** The 2-second `setTimeout` label reset fires from the click, not from the clipboard-write resolve. A slow clipboard write could theoretically reset the label before "Copied!" appears. In practice `navigator.clipboard.writeText` resolves in single-digit milliseconds; not worth complicating the handler.
- **Security:** `navigator.clipboard.writeText` requires a secure context (HTTPS or localhost). In a non-secure origin `navigator.clipboard` is `undefined` — `undefined.writeText` throws `TypeError`, caught by the existing `catch` block, labelled "Error". The plan's "Copy failed" path covers the rejection case; the `TypeError` case falls through to the existing `catch` → "Error" label. Both are honest failures.
- **Side Effects:** The card has already advanced (server-side `promptSelected` moves it before returning). A clipboard failure leaves the card in the next column with no way back. This is existing behaviour shared with the board panel and is explicitly a non-goal.
- **Dependencies & Conflicts:** No cross-subtask file conflict. The paste-attribution subtask touches `term.onData` at `:4107` and the DB/provider layers; this subtask touches the kanban-pane copy handler at `:2677-2707`. Different regions of the same file — sequential landing avoids any merge friction.

## Dependencies

- No prior session dependencies. This is a self-contained bugfix.

## Adversarial Synthesis

Key risks: (1) non-secure-context `TypeError` vs promise rejection — both caught, both labelled honestly, cosmetic prose imprecision only; (2) card advances before clipboard confirms — accepted non-goal, server-side verb contract change out of scope. Mitigations: the existing `try/catch` already covers both failure modes; the double-write idempotency means no host branch is needed.

## Proposed Changes

### src/webview/terminals.js — kanban-pane Copy Prompt handler (`:2677-2707`)

- **Context:** The click handler at `:2681` posts `/kanban/verb/promptSelected` via raw `fetch`, reads `data.success`, and sets the label to "Copied!" while discarding `data.prompt`. In the browser host nothing writes the clipboard because the raw `fetch` bypasses `transport.js:292`.
- **Logic:** After the response resolves, if `data.success` and `typeof data.prompt === 'string'`, `await navigator.clipboard.writeText(data.prompt)` and only then set the label to "Copied!". If the clipboard write rejects, set the label to "Copy failed". If `data.success` is true but `data.prompt` is absent, treat it as a failure for labelling purposes — that combination means the server arm changed shape and the button can no longer do its job.
- **Implementation:**
  ```javascript
  const data = await res.json();
  if (data.success) {
      if (typeof data.prompt === 'string') {
          try {
              await navigator.clipboard.writeText(data.prompt);
              copyBtn.textContent = 'Copied!';
          } catch {
              copyBtn.textContent = 'Copy failed';
          }
      } else {
          copyBtn.textContent = 'Copy failed';
      }
      // Refresh this pane's list (the card advanced out).
      fetchBoardCardsForPane(index);
  } else {
      copyBtn.textContent = 'Failed';
  }
  ```
- **Edge Cases:** No confirm dialog, no retry modal, no two-click pattern (hard project rule). The existing 2-second label reset stays as-is. The extension-host double-write (server-side seam + this client-side write) is idempotent.

### Non-goals

`promptSelected` advancing the card before the clipboard write is existing behaviour shared with the board and is not changed here.

## Verification Plan

### Automated Tests

- Contract test in the static-source idiom of `src/test/terminal-sidebar-groupings-contract.test.js`: assert the kanban-pane copy handler block references both `data.prompt` and `clipboard.writeText`, so a future refactor back to a bare `fetch` is caught at test time rather than on paste.

### Manual UAT

- Browser host, installed VSIX (not `dist/`): open the Terminals panel, add a kanban pane, click Copy Prompt on a card, paste into a scratch buffer and confirm the full dispatch prompt is present, and that the label read "Copied!".
- Deny clipboard permission (or load the page over a non-secure origin so `navigator.clipboard` is undefined/rejects) and confirm the label reads "Copy failed" (rejection) or "Error" (TypeError) and nothing claims success.
- Extension-host regression: the same button still copies, and the card still advances exactly one column.

## Recommendation

Complexity 2 → **Send to Intern**.

## Completion Report

Implemented the browser-host clipboard write in the Terminals panel kanban-pane Copy Prompt handler. The handler now awaits `navigator.clipboard.writeText(data.prompt)` and labels the button "Copied!" only after a successful client-side write; it shows "Copy failed" when the prompt is missing or the clipboard rejects and falls through to the existing "Error" label for `TypeError`. Touched only `src/webview/terminals.js` in the kanban-pane copy button block. No issues encountered; the existing extension-host server-side clipboard write remains in place and is idempotent with the new client-side write.

## Review Findings

Reviewed the implementation against the plan requirements. The clipboard write at `src/webview/terminals.js:2814-2823` correctly checks `typeof data.prompt === 'string'`, awaits `navigator.clipboard.writeText(data.prompt)`, and labels "Copied!" / "Copy failed" / "Error" honestly. No CRITICAL or MAJOR issues found in the handler logic itself. The contract test (`src/test/paste-attribution-contract.test.js:43-48`) correctly asserts the handler references both `data.prompt` and `clipboard.writeText`. One MAJOR gate-wiring gap found and fixed: `test:contract:paste-attribution` was defined in `package.json` but not invoked by CI — wired into `.github/workflows/integration-tests.yml` during this review pass. All automated checks pass: `test:contract:paste-attribution` (7/7), `catalog:check`, `parity:check`, `verb-returns:check`, `push-routing:check`, `lint` (0 errors). Remaining risk: manual UAT (browser-host clipboard write over non-secure origin) not exercised in this review pass.
