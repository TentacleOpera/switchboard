# Memo Modal — Persistence Clarity & Reset on Consume

## Metadata

**Tags:** [frontend, backend, ui, ux, bugfix]
**Complexity:** 4
<!-- Single-repo session — no Repo: line per session directive -->

## User Review Required

Yes — before implementation, confirm:
1. The memo file SHOULD be reset (truncated to empty) after a successful "Send to Planner" or "Copy Prompt" action. This treats those buttons as "consume" operations. If you prefer entries to persist after send/copy (re-sendable), say so and the plan will be adjusted to only update the UI text instead.
2. The status message after consume should explicitly state the memo was cleared (e.g. "Sent 3 issue(s) to planner. Memo cleared.").
3. If "Send to Planner" fails (no planner terminal available, or dispatch rejected), the memo should NOT be cleared — entries must survive for retry. Confirm this is the desired behavior.

## Goal

Make the Memo modal's persistence behavior explicit in the UI, and fix the bug where the memo file (`.switchboard/memo.md`) is NOT reset after the user presses "Send to Planner" or "Copy Prompt" — even though the user expects those buttons to consume the entries.

### Problem & Background

The Memo modal (kanban.html:2963-2986) auto-saves textarea content to `.switchboard/memo.md` via a debounced 800ms save (`debouncedMemoSave`, kanban.html:3638-3646). The file is loaded back on modal open (`memoLoad` → `memoContent`, KanbanProvider.ts:6866-6875). This persistence works correctly.

However, two issues exist:

1. **UI does not communicate persistence.** The only descriptive text (kanban.html:2971-2973) reads: *"Jot down bugs, thoughts, or issues. Each line/paragraph is treated as a separate issue when sent to the planner."* It never tells the user that entries are saved to disk and will survive modal close/reopen. Users may assume closing the modal discards content, leading to surprise when old entries reappear.

2. **Memo file is not reset on consume.** The `memoGeneratePrompt` handler (KanboardProvider.ts:6893-6917) parses entries, builds a planner prompt, copies it to the clipboard, optionally dispatches to the planner, and posts a status message — but it NEVER clears `.switchboard/memo.md` or the textarea. Only the explicit "Clear" button (KanboardProvider.ts:6886-6891) truncates the file. As a result, after pressing "Send to Planner" or "Copy Prompt", the entries silently remain on disk and will reappear next time the modal opens, creating confusion and risk of duplicate re-sends.

### Root Cause

The original `memo-bug-report-jot-modal.md` plan specified three actions (Send / Copy / Clear) but did not define "Send" and "Copy" as consuming operations. The implementation followed that spec literally — only "Clear" resets the file. The persistence guarantee was also never surfaced in the UI copy, so users have no way to know entries are durable.

A secondary root cause for the race condition (see Proposed Change #4) is that the debounced save timer (`memoSaveTimer`) is never cancelled by the send/copy button handlers, unlike the Clear button which synchronously clears the textarea before any timer can fire.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Memo Modal (kanban.html)                           │
│  ┌─────────────────────────────────────┐            │
│  │  Textarea (auto-saves to            │            │
│  │  .switchboard/memo.md,              │            │
│  │  debounced 800ms via memoSaveTimer) │            │
│  │  ↑ NEW: helper text explains        │            │
│  │    persistence                      │            │
│  └─────────────────────────────────────┘            │
│  [Clear]  [Copy Prompt]  [Send to Planner]          │
│      │         │              │                     │
│      │  NEW: cancel timer     │  NEW: cancel timer  │
│      ▼         ▼              ▼                     │
│  memoClear   memoGeneratePrompt (action: copy/send) │
│  (resets)    ↑ NEW: also resets file + textarea     │
│              ↑ NEW: gate clear on successful send   │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│  KanbanProvider.ts                                  │
│  memoGeneratePrompt:                                │
│   1. Parse entries                                  │
│   2. Build prompt, copy to clipboard                │
│   3. If send → dispatch to planner (capture result) │
│   4. NEW: if copy OR send-succeeded:                │
│      a. truncate .switchboard/memo.md               │
│      b. post memoContent { content: '' }            │
│   5. Post memoPromptResult (updated message)        │
└─────────────────────────────────────────────────────┘
```

---

## Complexity Audit

### Routine
- Updating static HTML description text in the memo modal (kanban.html:2971-2973).
- Truncating the memo file via `fs.promises.writeFile(memoPath, '', 'utf8')` — same pattern already used by `memoClear` (KanbanProvider.ts:6886-6891).
- Posting `memoContent { content: '' }` to clear the textarea — the webview handler already supports this (kanban.html:6372-6375).
- Updating status message strings to include "Memo cleared."

### Complex / Risky
- **Race condition fix**: Cancelling the debounced `memoSaveTimer` in the send/copy button handlers (kanban.html:3664-3672). Without this, a pending 800ms timer can fire after the extension truncates the file but before the webview receives the `memoContent` clear message, re-writing old content to disk. Requires understanding the async round-trip between webview and extension.
- **Dispatch-failure gating**: For "send" action, the memo must only be cleared if `_dispatchMemoToPlanner` actually succeeded. If it fails (no terminal, dispatch rejected), entries must survive for retry. Requires capturing the dispatch result and branching the clear logic.

---

## Edge-Case & Dependency Audit

**Race Conditions:**
- **Debounced save timer vs. consume**: The 800ms `memoSaveTimer` (kanban.html:3624, 3638-3646) can fire after the extension truncates the file but before the webview processes the `memoContent { content: '' }` message. The timer reads `textarea.value` at fire time — if the textarea hasn't been cleared yet, it writes the old content back to disk, undoing the truncate. The Clear button avoids this by synchronously setting `textarea.value = ''` before the timer can fire. **Fix (Proposed Change #4)**: Cancel `memoSaveTimer` in the send/copy button handlers via `if (memoSaveTimer) clearTimeout(memoSaveTimer)`.

**Security:**
- No security implications. The memo file is local user content with no elevated privileges.

**Side Effects:**
- Truncating `.switchboard/memo.md` is irreversible — once consumed, entries cannot be recovered. This is the intended behavior (consume semantics), but the dispatch-failure gating (Proposed Change #5) ensures entries survive if the send itself fails.
- Clipboard is always written (even on failed send) — this is existing behavior and acceptable as a fallback.

**Dependencies & Conflicts:**
- No dependencies on other plans or sessions.
- No conflicts with existing functionality — all changes are additive within the memo modal subsystem.
- The `_dispatchMemoToPlanner` method (KanboardProvider.ts:6990) currently returns `Promise<void>`. Proposed Change #5 changes it to `Promise<boolean>` so the caller can gate the memo clear on successful dispatch. The method already checks a `dispatched` boolean internally (line 6998) — it just needs to return it.

---

## Dependencies

None — this plan is self-contained within the memo modal subsystem.

---

## Adversarial Synthesis

Key risks: (1) A debounced save timer race condition can resurrect cleared memo content by re-writing old text to disk after the extension truncates the file — mitigated by cancelling `memoSaveTimer` in the send/copy button handlers. (2) A failed planner dispatch silently consumes entries, leaving the user with no recovery path — mitigated by gating the file clear on successful dispatch for "send" action only. Both fixes are small (2-4 lines each) but require understanding the async webview↔extension round-trip.

---

## Proposed Changes

### 1. `src/webview/kanban.html` — Update modal description text

**Location**: kanban.html:2971-2973 (the `<p>` inside the memo modal body).

Replace the current description with copy that explicitly states persistence AND the consume-on-send/copy behavior:

```html
<p style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">
    Jot down bugs, thoughts, or issues. Entries are <strong>saved automatically</strong>
    and persist until you press <strong>Send to Planner</strong> or <strong>Copy Prompt</strong>
    (which clears the memo) or <strong>Clear</strong>. Each line/paragraph is treated as a
    separate issue when sent to the planner.
</p>
```

This makes three things explicit:
- Inputs are saved automatically (persistence).
- Inputs persist until consumed by Send/Copy (or manually cleared).
- Send/Copy clears the memo (sets expectations for the bugfix below).

### 2. `src/services/KanbanProvider.ts` — Reset memo file on consume (with dispatch-failure gating)

**Location**: `memoGeneratePrompt` case, KanbanProvider.ts:6893-6917.

After a successful prompt generation (i.e. `issues.length > 0`), truncate the memo file and notify the webview to clear the textarea — but ONLY if the action is "copy" (always safe) or "send" AND the dispatch actually succeeded.

First, capture the dispatch result for "send" action. Replace the existing dispatch block (KanbanProvider.ts:6908-6910):

```typescript
// Existing:
if (action === 'send') {
    await this._dispatchMemoToPlanner(prompt, workspaceRoot);
}
```

With:

```typescript
// NEW: capture dispatch success — only consume if send actually worked
let sendSucceeded = action !== 'send'; // copy always "succeeds"
if (action === 'send') {
    sendSucceeded = await this._dispatchMemoToPlanner(prompt, workspaceRoot);
}
```

> **Clarification**: `_dispatchMemoToPlanner` (KanbanProvider.ts:6990) currently returns `Promise<void>`. It needs to return `Promise<boolean>` — `true` if dispatched successfully, `false` if no terminal or dispatch rejected. The method already checks `dispatched` internally (line 6998); just return that boolean instead of void.

Then, insert the consume block (gated on success) immediately before the `memoPromptResult` postMessage:

```typescript
// Consume: clear the memo file so entries don't reappear on next open
// Only clear if the operation succeeded (copy always succeeds; send only if dispatched)
if (sendSucceeded) {
    const memoPath = this._getMemoPath(workspaceRoot);
    await fs.promises.writeFile(memoPath, '', 'utf8');
    this._panel?.webview.postMessage({ type: 'memoContent', content: '' });
}
```

Then update the success message to reflect the clear (or failure):

```typescript
this._panel?.webview.postMessage({
    type: 'memoPromptResult',
    message: sendSucceeded
        ? (action === 'send'
            ? `Sent ${issues.length} issue(s) to planner. Memo cleared.`
            : `Prompt for ${issues.length} issue(s) copied to clipboard. Memo cleared.`)
        : `Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry.`
});
```

**Edge case — empty memo**: If `issues.length === 0`, the handler already early-breaks with a "No entries to process." message and must NOT clear the file (no consume happened). The existing early-break at KanbanProvider.ts:6899-6904 already handles this correctly — no change needed.

**Edge case — send fails**: If `_dispatchMemoToPlanner` returns `false` (no terminal available or dispatch rejected), the memo file is NOT truncated and the textarea is NOT cleared. The status message reads "Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry." The user can retry or use Copy Prompt instead.

### 3. `src/webview/kanban.html` — Clear textarea on `memoContent` with empty string

**Location**: kanban.html:6372-6375 (`memoContent` handler).

The existing handler already sets `textarea.value = msg.content || ''`, so posting `{ content: '' }` will correctly clear the textarea. No code change needed here — verified for correctness.

### 4. `src/webview/kanban.html` — Cancel debounced save timer on send/copy (race condition fix)

**Location**: kanban.html:3664-3672 (memo-copy-btn and memo-send-btn click handlers).

The debounced `memoSaveTimer` (declared at kanban.html:3624) can fire after the extension truncates the file but before the webview receives the `memoContent` clear message, re-writing old content to disk. The Clear button avoids this by synchronously clearing the textarea. The send/copy buttons must cancel the pending timer instead.

Update the copy button handler (kanban.html:3664-3667):

```javascript
document.getElementById('memo-copy-btn')?.addEventListener('click', () => {
    if (memoSaveTimer) clearTimeout(memoSaveTimer);  // NEW: prevent stale save from resurrecting content
    const content = document.getElementById('memo-textarea')?.value || '';
    postKanbanMessage({ type: 'memoGeneratePrompt', content, action: 'copy' });
});
```

Update the send button handler (kanban.html:3669-3672):

```javascript
document.getElementById('memo-send-btn')?.addEventListener('click', () => {
    if (memoSaveTimer) clearTimeout(memoSaveTimer);  // NEW: prevent stale save from resurrecting content
    const content = document.getElementById('memo-textarea')?.value || '';
    postKanbanMessage({ type: 'memoGeneratePrompt', content, action: 'send' });
});
```

### 5. `src/services/KanbanProvider.ts` — Make `_dispatchMemoToPlanner` return boolean

**Location**: KanbanProvider.ts:6990+ (`_dispatchMemoToPlanner` method).

Change the return type from `Promise<void>` to `Promise<boolean>` and return the dispatch result:

```typescript
private async _dispatchMemoToPlanner(prompt: string, workspaceRoot: string): Promise<boolean> {
    if (!this._taskViewerProvider) {
        vscode.window.showInformationMessage(
            'Memo prompt copied to clipboard. No planner terminal available — paste it manually.'
        );
        return false;  // NEW: signal failure so memo is preserved
    }
    try {
        const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('planner', prompt, workspaceRoot);
        if (!dispatched) {
            vscode.window.showWarningMessage(
                // ... existing warning message ...
            );
            return false;  // NEW: signal failure
        }
        return true;  // NEW: signal success
    } catch {
        // ... existing error handling ...
        return false;  // NEW: signal failure
    }
}
```

> **Clarification**: The exact error-handling lines at 7000+ should be read by the implementer to preserve existing catch-block behavior. The only change is adding `return false` / `return true` statements — no existing logic is removed.

---

## Verification Plan

### Automated Tests

No automated tests required — the memo modal is a UI-only feature with no unit-testable backend logic beyond file I/O (which is already covered by the existing `memoClear` pattern). Manual verification is sufficient.

> Per session directives: compilation (`npm run compile`) and automated tests are skipped for this session. The user will run these separately.

### Manual Verification

1. **Persistence text**: Open the memo modal (kanban board button or `Cmd+Shift+Alt+M`). Confirm the new description text appears and mentions auto-save, persistence, and that Send/Copy clears the memo.
2. **Persistence behavior (unchanged)**: Type a few lines, close the modal, reopen it — entries should reappear (loaded from `.switchboard/memo.md`).
3. **Send to Planner reset**: Type entries, press "Send to Planner". Confirm:
   - Status reads "Sent N issue(s) to planner. Memo cleared."
   - Textarea is emptied immediately.
   - Close and reopen the modal — textarea should be empty (file was truncated).
   - Verify `.switchboard/memo.md` is empty on disk.
4. **Copy Prompt reset**: Type entries, press "Copy Prompt". Confirm:
   - Status reads "Prompt for N issue(s) copied to clipboard. Memo cleared."
   - Textarea is emptied immediately.
   - Reopen modal — empty.
5. **Empty memo guard**: Open modal with empty textarea, press "Send to Planner". Confirm status reads "No entries to process." and the file is NOT cleared (no spurious consume).
6. **Clear button (unchanged)**: Type entries, press "Clear". Confirm textarea empties and file is truncated — behavior unchanged.
7. **Race condition — rapid send**: Type entries, then immediately (within 800ms of last keystroke) press "Send to Planner". Confirm the memo is cleared and stays cleared after reopening the modal (no resurrection from the debounced timer).
8. **Race condition — rapid copy**: Same as above but with "Copy Prompt".
9. **Failed send preserves memo**: If no planner terminal is available, press "Send to Planner". Confirm:
   - Status reads "Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry."
   - Textarea is NOT emptied.
   - Reopen modal — entries still present.
10. **No confirm dialogs**: Per `CLAUDE.md`, no `confirm()` gates are added. All buttons act immediately.

---

**Recommendation**: Complexity is 4 → **Send to Coder**. The changes span 2 files with one race condition fix and one error-handling gating change, but both are well-scoped and follow existing patterns. No architectural decisions required.
