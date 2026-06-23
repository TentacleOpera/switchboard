# Memo "Send to Planner" Should Dispatch Only, Not Copy + Dispatch

## Goal (Problem analysis + Root Cause with cited file:line)

The Memo modal's two buttons currently have overlapping behavior:

- **Copy Prompt** — builds the planner prompt and writes it to the clipboard.
- **Send to Planner** — builds the planner prompt, writes it to the clipboard, **and** dispatches it to the planner terminal.

This is inconsistent with the rest of the extension, where "Send to Planner" / dispatch-style actions only do the terminal dispatch and never touch the clipboard. The standard dispatch path, `dispatchCustomPromptToRole` → `_dispatchExecuteMessage`, performs no clipboard write (`src/services/TaskViewerProvider.ts:2495-2507`). Only the **Copy** action should own the clipboard.

The intro text in the modal also describes this non-standard behavior literally:

> "**Copy Prompt** copies a planner prompt to your clipboard; **Send to Planner** copies it _and_ dispatches it to your planner agent."
> (`src/webview/kanban.html:3030-3032`)

### Root cause

In the `memoGeneratePrompt` handler, the clipboard write is unconditional — it runs for **both** the `copy` and `send` actions before the dispatch branch:

- `src/services/KanbanProvider.ts:6986` — `await vscode.env.clipboard.writeText(prompt);` runs for every action, including `send`.
- `src/services/KanbanProvider.ts:6988-6991` — only after the clipboard write does the `send` branch additionally call `_dispatchMemoToPlanner(...)`.

The fix: scope the clipboard write to the `copy` action only, so `send` performs dispatch only. The success-message strings (`src/services/KanbanProvider.ts:7002-7009`) and the intro text (`src/webview/kanban.html:3030-3035`) must be updated to match.

Note: the failure path legitimately still copies to clipboard as a manual-paste fallback (`_dispatchMemoToPlanner` shows "copied to clipboard … paste it manually" messages at `src/services/KanbanProvider.ts:7084-7102`, and the failure result string at `7008`). That fallback-copy-on-failure is intentional and is preserved — see Edge-Case Audit.

## Metadata

**Complexity:** 2/10
**Tags:** memo, kanban, planner-dispatch, ui-copy, consistency

## Complexity Audit

### Routine
- Scoping the clipboard write to the `copy` action (move one line inside a conditional).
- Updating the `send` success message string to drop "copied to clipboard" wording.
- Rewriting two sentences of intro HTML text in the modal.
- Rebuild via `npm run compile`.

### Complex/Risky
- None. No state/schema changes, no persisted format changes, no migrations. This is unreleased-or-not, the behavior change is purely which side-effect runs for the `send` button; nothing on disk changes. (Even so, no `*.migrated.bak` concerns apply — no files are touched by this change.)

## Edge-Case & Dependency Audit

1. **Copy action must still copy.** The clipboard write moves into the `copy` branch — verify Copy Prompt still populates the clipboard.
2. **Send-success no longer copies.** After this change, a successful Send to Planner leaves the clipboard untouched. This is the intended new behavior and matches every other dispatch in the extension.
3. **Send-FAILURE fallback copy is preserved.** When dispatch fails (`sendSucceeded === false`), the existing UX is to copy the prompt to the clipboard so the user can paste manually. `_dispatchMemoToPlanner` already shows "copied to clipboard … paste manually" messages (`src/services/KanbanProvider.ts:7084-7102`) and the failure result string says the same (`7008`). To keep that promise truthful, the failure path must still write the clipboard. The implementation below writes the clipboard for `copy` up-front, and for `send` only writes it inside the failure branch — so the success path is clipboard-free while the failure fallback remains intact.
4. **Memo-clear behavior unchanged.** The memo is still cleared on success for both actions (`src/services/KanbanProvider.ts:6993-7000`); intro text already states this and stays accurate.
5. **No entries case unchanged** (`src/services/KanbanProvider.ts:6978-6984`) — returns early before any clipboard/dispatch.
6. **No confirmation dialogs** are added or present. (Per repo rule.)
7. **Webview rebuild required** — the intro text lives in `src/webview/kanban.html`; `dist/` must be rebuilt.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — scope clipboard write to `copy`, preserve failure fallback for `send`

**Before** (lines 6985-6991):

```ts
                const prompt = this._buildMemoPlannerPrompt(issues, workspaceRoot);
                await vscode.env.clipboard.writeText(prompt);
                
                let sendSucceeded = action !== 'send';
                if (action === 'send') {
                    sendSucceeded = await this._dispatchMemoToPlanner(prompt, workspaceRoot);
                }
```

**After:**

```ts
                const prompt = this._buildMemoPlannerPrompt(issues, workspaceRoot);

                let sendSucceeded = action !== 'send';
                if (action === 'send') {
                    // Send to Planner dispatches only — it must NOT copy to clipboard
                    // on success, matching every other dispatch action in the extension.
                    sendSucceeded = await this._dispatchMemoToPlanner(prompt, workspaceRoot);
                    if (!sendSucceeded) {
                        // Failure fallback: copy so the user can paste manually
                        // (the failure message below promises this).
                        await vscode.env.clipboard.writeText(prompt);
                    }
                } else {
                    // Copy Prompt owns the clipboard.
                    await vscode.env.clipboard.writeText(prompt);
                }
```

**Before** (success message, lines 7002-7009):

```ts
                this._panel?.webview.postMessage({
                    type: 'memoPromptResult',
                    message: sendSucceeded
                        ? (action === 'send'
                            ? `Sent ${issues.length} issue(s) to planner. Memo cleared.`
                            : `Prompt for ${issues.length} issue(s) copied to clipboard. Memo cleared.`)
                        : `Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry.`
                });
```

**After** (the `send` success string already correctly says "Sent … to planner" with no clipboard mention — no change needed there; the failure string still mentions clipboard, which is now accurate because we copy in the failure branch). This block stays as-is:

```ts
                this._panel?.webview.postMessage({
                    type: 'memoPromptResult',
                    message: sendSucceeded
                        ? (action === 'send'
                            ? `Sent ${issues.length} issue(s) to planner. Memo cleared.`
                            : `Prompt for ${issues.length} issue(s) copied to clipboard. Memo cleared.`)
                        : `Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry.`
                });
```

> No edit required to the message block — the success message for `send` ("Sent … to planner. Memo cleared.") already makes no clipboard claim, and the failure message's "Prompt copied to clipboard" remains true because the failure branch above still copies. The only logic edit is the clipboard-scoping block.

### 2. `src/webview/kanban.html` — fix the intro text

**Before** (lines 3030-3032):

```html
                    <strong>Copy Prompt</strong> copies a planner prompt to your clipboard; <strong>Send to Planner</strong>
                    copies it <em>and</em> dispatches it to your planner agent. In both cases the prompt instructs the agent to
                    <strong>create a separate plan file for each issue</strong> in <code>.switchboard/plans/</code>.
```

**After:**

```html
                    <strong>Copy Prompt</strong> copies a planner prompt to your clipboard; <strong>Send to Planner</strong>
                    dispatches it directly to your planner agent. In both cases the prompt instructs the agent to
                    <strong>create a separate plan file for each issue</strong> in <code>.switchboard/plans/</code>.
```

The "saved automatically / cleared after Copy Prompt or Send to Planner" sentence (lines 3034-3035) remains accurate and is unchanged.

## Verification Plan

1. **Build:** `npm run compile` — confirm webpack builds `dist/` with no TypeScript errors.
2. **Code inspection:** Confirm `src/services/KanbanProvider.ts` now writes the clipboard only in the `copy` branch and in the `send` failure branch — never on `send` success.
3. **Manual — Copy Prompt:** Open Memo (Cmd+Shift+Alt+M), enter 2 entries, click **Copy Prompt**. Verify the clipboard contains the prompt and the status reads "Prompt for 2 issue(s) copied to clipboard. Memo cleared."
4. **Manual — Send to Planner (success):** With a planner terminal assigned, enter entries, put unrelated text on the clipboard first, click **Send to Planner**. Verify: prompt is dispatched to the planner terminal, status reads "Sent 2 issue(s) to planner. Memo cleared.", and the clipboard still contains the unrelated text (i.e. it was NOT overwritten).
5. **Manual — Send to Planner (failure fallback):** With no planner terminal assigned, click **Send to Planner**. Verify the warning fires, the memo is preserved, and the prompt IS on the clipboard (failure fallback intact) with status "Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry."
6. **Intro text:** Reopen the Memo modal and confirm the intro reads "…**Send to Planner** dispatches it directly to your planner agent" with no "copies it and dispatches it" wording.
7. **No confirm dialogs** were introduced.
