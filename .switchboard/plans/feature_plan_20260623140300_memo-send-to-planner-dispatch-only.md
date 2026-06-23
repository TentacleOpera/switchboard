# Memo "Send to Planner" Should Dispatch Only, Not Copy + Dispatch

## Goal (Problem analysis + Root Cause with cited file:line)

The Memo sidebar tab's two buttons currently have overlapping behavior:

- **Copy Prompt** — builds the planner prompt and writes it to the clipboard.
- **Send to Planner** — builds the planner prompt, writes it to the clipboard, **and** dispatches it to the planner terminal.

This is inconsistent with the rest of the extension, where "Send to Planner" / dispatch-style actions only do the terminal dispatch and never touch the clipboard. The standard dispatch path, `dispatchCustomPromptToRole` → `_dispatchExecuteMessage`, performs no clipboard write (`src/services/TaskViewerProvider.ts:2507-2519`). Only the **Copy** action should own the clipboard.

### Root cause

In the `memoGeneratePrompt` handler (now in `TaskViewerProvider` after the sidebar-tab relocation), the clipboard write is unconditional — it runs for **both** the `copy` and `send` actions before the dispatch branch:

- `src/services/TaskViewerProvider.ts:9261` — `await vscode.env.clipboard.writeText(prompt);` runs for every action, including `send`.
- `src/services/TaskViewerProvider.ts:9263-9266` — only after the clipboard write does the `send` branch additionally call `this.dispatchCustomPromptToRole('planner', prompt, workspaceRoot)`.

The fix: scope the clipboard write to the `copy` action only, so `send` performs dispatch only. The success-message strings (`src/services/TaskViewerProvider.ts:9276-9280`) already correctly say "Sent … to planner" for `send` success and "Prompt copied to clipboard" for failure — both remain accurate after the fix (see Edge-Case Audit). No intro text change is needed: the sidebar intro (`src/webview/implementation.html:1624-1627`) does not describe clipboard behavior and is already accurate.

Note: the failure path legitimately still copies to clipboard as a manual-paste fallback (the failure result string at `src/services/TaskViewerProvider.ts:9280` says "Prompt copied to clipboard. Memo preserved for retry."). That fallback-copy-on-failure is intentional and is preserved — see Edge-Case Audit.

### What changed from the original plan

The memo was relocated from a Kanban modal (`kanban.html` + `KanbanProvider.ts`) to a sidebar tab (`implementation.html` + `TaskViewerProvider.ts`) by `feature_plan_20260623140600_memo-implementation-sidebar-tab.md`. The original plan's proposed change #2 (fixing intro text in `kanban.html:3030-3032` that said "Send to Planner copies it and dispatches it") is **moot** — that intro text was deleted with the modal. The new sidebar intro does not describe clipboard behavior. Only the logic fix (proposed change #1) remains, retargeted from `KanbanProvider.ts` to `TaskViewerProvider.ts`.

## Metadata

**Complexity:** 2/10
**Tags:** bugfix, ui, ux

## User Review Required

No — this is a pure behavior-consistency fix with no schema, migration, or product-scope impact. The change narrows a side-effect (clipboard write) to the correct action and preserves the failure fallback. Safe to proceed directly to implementation.

## Complexity Audit

### Routine
- Scoping the clipboard write to the `copy` action (move one line inside a conditional + add failure fallback for `send`).
- Single-file change (`TaskViewerProvider.ts`); no webview/HTML edit required.

### Complex / Risky
- None. No state/schema changes, no persisted format changes, no migrations. The behavior change is purely which side-effect runs for the `send` button; nothing on disk changes.

## Edge-Case & Dependency Audit

1. **Copy action must still copy.** The clipboard write moves into the `copy` branch — verify Copy Prompt still populates the clipboard.
2. **Send-success no longer copies.** After this change, a successful Send to Planner leaves the clipboard untouched. This is the intended new behavior and matches every other dispatch in the extension.
3. **Send-FAILURE fallback copy is preserved.** When dispatch fails (`sendSucceeded === false`), the existing UX is to copy the prompt to the clipboard so the user can paste manually. `dispatchCustomPromptToRole` shows `showErrorMessage("No agent assigned to role 'planner'…")` on failure (`src/services/TaskViewerProvider.ts:2512`), and the failure result string at `:9280` says "Prompt copied to clipboard. Memo preserved for retry." To keep that promise truthful, the failure path must still write the clipboard. The implementation below writes the clipboard for `copy` up-front, and for `send` only writes it inside the failure branch — so the success path is clipboard-free while the failure fallback remains intact.
4. **Memo-clear behavior unchanged.** The memo is still cleared on success for both actions (`src/services/TaskViewerProvider.ts:9268-9271`); the intro text already states this and stays accurate.
5. **No entries case unchanged** (`src/services/TaskViewerProvider.ts:9253-9258`) — returns early before any clipboard/dispatch.
6. **No confirmation dialogs** are added or present. (Per repo rule.)
7. **No webview rebuild required for the logic fix** — only `TaskViewerProvider.ts` changes. The intro text in `implementation.html` is already correct and needs no edit.

### Race Conditions
- None. The handler is sequential (`await` chain): build prompt → (copy | dispatch) → clear memo → post result. No concurrent access to the clipboard or memo file.

### Security
- None. No secrets, credentials, or sensitive data are involved. The prompt is built from user-entered memo entries and dispatched to a local terminal.

### Side Effects
- **Clipboard side-effect narrowed:** `send` success no longer overwrites the clipboard. This is the intended fix. The `copy` action and `send`-failure fallback retain their clipboard write.
- **Memo file clear on success:** unchanged for both actions.
- **Terminal focus:** `dispatchCustomPromptToRole` calls `vscode.commands.executeCommand('switchboard.focusTerminalByName', …)` (`:2516`) — unchanged.

### Dependencies & Conflicts
- Depends on the sidebar-tab relocation plan `feature_plan_20260623140600_memo-implementation-sidebar-tab.md` having landed (the handler must already be in `TaskViewerProvider.ts`, not `KanbanProvider.ts`). Verified: the handler is at `TaskViewerProvider.ts:9247-9282`.
- No conflicts with other features — the `memoGeneratePrompt` handler is self-contained.

## Dependencies

- `feature_plan_20260623140600_memo-implementation-sidebar-tab.md` — Memo sidebar-tab relocation (handler moved from `KanbanProvider.ts` to `TaskViewerProvider.ts`). This plan retargets the clipboard fix to the new location.

## Adversarial Synthesis

Key risks: (1) the failure-fallback clipboard copy could be accidentally dropped if the `send` failure branch is refactored, breaking the "Prompt copied to clipboard" promise in the failure message; (2) a future third action value could bypass both the copy and dispatch branches. Mitigations: the failure-branch clipboard write is explicitly commented and tested in the verification plan; the action is normalized to `'send' | 'copy'` at line 9251, so no third value can reach the branch.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — scope clipboard write to `copy`, preserve failure fallback for `send`

**Before** (lines 9260-9266):

```ts
                        const prompt = this._buildMemoPlannerPrompt(issues, workspaceRoot);
                        await vscode.env.clipboard.writeText(prompt);

                        let sendSucceeded = action !== 'send';
                        if (action === 'send') {
                            sendSucceeded = await this.dispatchCustomPromptToRole('planner', prompt, workspaceRoot);
                        }
```

**After:**

```ts
                        const prompt = this._buildMemoPlannerPrompt(issues, workspaceRoot);

                        let sendSucceeded = action !== 'send';
                        if (action === 'send') {
                            // Send to Planner dispatches only — it must NOT copy to clipboard
                            // on success, matching every other dispatch action in the extension.
                            sendSucceeded = await this.dispatchCustomPromptToRole('planner', prompt, workspaceRoot);
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

**No edit required to the message block** (lines 9274-9281) — the success message for `send` ("Sent … to planner. Memo cleared.") already makes no clipboard claim, and the failure message's "Prompt copied to clipboard" remains true because the failure branch above still copies. The only logic edit is the clipboard-scoping block.

## Verification Plan

### Automated Tests

No automated tests required for this session. The test suite will be run separately by the user. (Per session directive: skip compilation and automated tests.)

### Manual Verification

1. **Code inspection:** Confirm `src/services/TaskViewerProvider.ts` now writes the clipboard only in the `copy` branch and in the `send` failure branch — never on `send` success.
2. **Manual — Copy Prompt:** Open the sidebar Memo tab, enter 2 entries, click **Copy Prompt**. Verify the clipboard contains the prompt and the status reads "Prompt for 2 issue(s) copied to clipboard. Memo cleared."
3. **Manual — Send to Planner (success):** With a planner terminal assigned, enter entries, put unrelated text on the clipboard first, click **Send to Planner**. Verify: prompt is dispatched to the planner terminal, status reads "Sent 2 issue(s) to planner. Memo cleared.", and the clipboard still contains the unrelated text (i.e. it was NOT overwritten).
4. **Manual — Send to Planner (failure fallback):** With no planner terminal assigned, click **Send to Planner**. Verify the error message fires, the memo is preserved, and the prompt IS on the clipboard (failure fallback intact) with status "Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry."
5. **No confirm dialogs** were introduced.

---

**Recommendation:** Complexity 2/10 → **Send to Intern.**
