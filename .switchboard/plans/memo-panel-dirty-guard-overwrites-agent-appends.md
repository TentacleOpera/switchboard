# The Memo Panel Protects Your Typing by Throwing Away Everything an Agent Appended

## Goal

Make the memo textarea merge external appends instead of dropping them, and make `memoSave` a compare-and-swap, so a user typing in the Memo tab can no longer silently overwrite risks a reviewer wrote to `memo.md`.

### The problem

Type in the Memo tab while a reviewer is appending risks, and the reviewer's entries are gone — with no error, no conflict marker, and nothing in the transcript. This is the most likely of the three memo loss paths to fire in ordinary use, because it needs nothing unusual: one user typing, one review finishing.

**Root cause: a guard that drops the update, paired with a save that writes the whole file.**

```js
// src/webview/memo.js:126-135
case 'memoUpdated':
case 'memoContent': {
    const isFocused = document.activeElement === textarea;
    if (isFocused || _memoDirty) {
        break;                       // ← the disk update is discarded entirely
    }
    textarea.value = msg.content;
}
```

The guard is correct in intent — refreshing under the cursor would destroy what the user is typing — but it is a *drop*, not a *defer*. The panel keeps a buffer it now knows to be stale and forgets that it knows. Then, on the next keystroke:

```js
// src/webview/memo.js:218-236 — debounced on every input
vscode.postMessage({ type: 'memoSave', content, workspaceRoot: _wsRoot });
```

and the server writes that buffer over the file, unconditionally:

```ts
// src/services/TaskViewerProvider.ts:14924-14930   (and src/standalone/bootstrap.ts:2501-2508)
await fs.promises.writeFile(memoPath, contentToSave, 'utf8');
```

So the sequence is: reviewer appends → watcher reads the change (`TaskViewerProvider.ts:15565-15576`) → panel receives `memoUpdated` → panel drops it because the user is typing → the user's next keystroke overwrites the file. The feature that produced the entries is on by default (`src/webview/sharedDefaults.js:177`), so this is the live path for every review that runs while the tab is open.

**Why a merge is safe here specifically.** Every non-user writer of `memo.md` appends — the reviewer directive (`agentPromptBuilder.ts:1051`), and the memo-capture agent protocol (`.claude/skills/switchboard-memo/SKILL.md:43`). So the incoming content is, in the overwhelming majority of cases, the local base plus a tail. A prefix check makes that testable rather than assumed: if the new content starts with the last-known-on-disk content, the difference is a pure tail and can be spliced in below the user's cursor with no ambiguity. If it does not, there is a genuine conflict, and the panel must say so rather than guess.

**Suspected parity gap, to confirm first.** `memoUpdated` has exactly one producer in the tree — `TaskViewerProvider.ts:15576`, armed by `_setupMemoWatcher` (`:15513`, called at `:1824` and `:8420`). The standalone host answers memo verbs from its own inline arms (`bootstrap.ts:2429-2560`) whose comment claims no `TaskViewerProvider` exists, though one is constructed at `bootstrap.ts:1083`. If the watcher is not armed under standalone, the browser memo panel never learns about an agent append at all — a strictly worse version of this bug, and the same composition-root shape as the queue-seam precedent in `CLAUDE.md`. Step 1 of implementation is to determine which is true.

**Not this plan:** the write side (`memo-append-seam-reviewer-risks-are-prompt-only.md`) and the consume-vs-clear gap (`process-memo-clears-entries-it-never-read.md`).

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, bugfix, reliability

## User Review Required

None. Note explicitly: the conflict case surfaces as a **status line**, never a dialog — no `confirm()`, no modal, per `CLAUDE.md` (and `window.confirm` is a silent no-op in VS Code webviews regardless).

## Complexity Audit

### Routine

- Tracking a base snapshot alongside the textarea value.
- Adding an optional field to the `memoSave` payload and its schema.

### Complex / Risky

- **Cursor and selection preservation.** Splicing a tail while the user types must not move the caret or drop a selection. Append at the end of the value; if the caret is at the very end, leave it after the user's own text, not after the spliced tail.
- **Backwards compatibility of the CAS.** `memoSave` is shipped state reachable from the browser transport and from HTTP. A payload with no `baseContent` must behave exactly as today, or an older browser tab silently stops saving. Per `CLAUDE.md`: it shipped, so it is compatible-or-nothing.
- **Double delivery in the browser.** `memo.js:139-152` documents that one click yields two deliveries of the same reply (WS fan-out plus the HTTP body re-dispatch). Every new branch — the merge, the conflict, the retry — must be idempotent under a second delivery. This is where a naive retry becomes an append loop.
- **Both roots.** The CAS check must exist in `TaskViewerProvider` *and* `bootstrap`; a check in one is not a check.

## Edge-Case & Dependency Audit

### Race Conditions

- Append lands between the panel's CAS read and its write: the server compares under a single read-then-write; the residual window is small but non-zero. Narrowed, not eliminated — say so rather than claiming a lock.
- Two appends between pushes: the prefix check still holds (base is still a prefix), so the whole tail splices at once.
- User clears the textarea to empty while an append is in flight: base no longer matches, CAS rejects, panel merges and shows the notice. The user's empty buffer never becomes an empty file by accident.

### Security

- No new path handling; `workspaceRoot` resolution is unchanged.

### Side Effects

- The status notice must not steal focus or scroll the textarea.
- `_memoDirty` semantics change subtly: after a successful merge the buffer is still dirty (the user's edits are unsaved) but the base advanced. Keep the two independent — conflating them is how the retry loops.

### Dependencies & Conflicts

- Touches the same `TaskViewerProvider.ts` / `bootstrap.ts` `memoSave` arms as both sibling plans. Land sequentially in one worktree.
- If `process-memo-clears-entries-it-never-read.md` lands first, `memo.js` already accepts a non-empty post-consume `content`; the merge path should reuse that handler rather than adding a second one.

## Dependencies

None blocking. Most valuable after the append seam lands, since a merge is only sound when incoming writes are genuinely appends.

## Proposed Changes

### Step 0 — settle the standalone watcher question

Determine whether `_setupMemoWatcher` is armed when `bootstrap.ts:1083` constructs the provider. If it is not, arm it (or push `memoUpdated` from the standalone host directly) **before** the merge work — a merge is pointless in a host that never receives the update. Record the finding in the plan file when implementing.

### `src/webview/memo.js:126-135` — merge the tail instead of dropping the push

```js
case 'memoUpdated':
case 'memoContent': {
    const textarea = document.getElementById('memo-textarea');
    if (!textarea) { break; }
    const incoming = typeof msg.content === 'string' ? msg.content : '';
    const isFocused = document.activeElement === textarea;
    if (!isFocused && !_memoDirty) {
        textarea.value = incoming;
        _baseContent = incoming;
        break;
    }
    // The user is mid-edit. Never clobber their buffer — but never drop the disk
    // update either: every non-user writer of memo.md appends, so the delta is a
    // pure tail whenever the incoming content still starts with our base.
    if (_baseContent && incoming.startsWith(_baseContent)) {
        const tail = incoming.slice(_baseContent.length);
        if (tail.trim()) {
            const sep = /\n\s*\n$/.test(textarea.value) || !textarea.value ? '' : '\n\n';
            textarea.value = textarea.value.replace(/\s+$/, '') + sep + tail.replace(/^\s*\n+/, '');
            _setMemoStatus(`${_countEntries(tail)} entry(ies) added by an agent — merged in.`);
        }
        _baseContent = incoming;
    } else {
        _conflict = true;   // a rewrite, not an append — do not guess
        _setMemoStatus('memo.md changed on disk. Your text is unsaved and kept; the next save will merge.');
    }
    break;
}
```

`_baseContent` is set on `memoLoad`/`memoContent`, after any accepted save, and after each merge. It tracks *what is on disk that our buffer derives from* — not what is in the textarea.

### `src/webview/memo.js:218-236` — send the base with every save

Include `baseContent: _baseContent` in the `memoSave` payload. On a `memoConflict` reply, run the merge above against the returned current content, then retry **once** and stop — one retry, so a double-delivered reply cannot loop.

### `src/services/TaskViewerProvider.ts:14923-14931` — compare-and-swap

```ts
case 'memoSave': {
    …
    const contentToSave = typeof data.content === 'string' ? data.content : '';
    if (typeof data.baseContent === 'string') {
        let current = '';
        try { current = await fs.promises.readFile(memoPath, 'utf8'); } catch { /* absent === '' */ }
        if (current !== data.baseContent) {
            // Someone appended since this buffer was loaded. Refuse rather than
            // overwrite; hand the panel the truth so it can splice the tail in.
            return { success: false, type: 'memoConflict', content: current };
        }
    }
    // No baseContent → legacy client, behave exactly as before (shipped surface).
    this._lastServedMemoContent = contentToSave;
    await fs.promises.writeFile(memoPath, contentToSave, 'utf8');
    return { success: true };
}
```

### `src/services/verbSchemas.ts:1752` — widen the `memoSave` schema

Add `baseContent: { type: 'string' }`. Optional by construction — absent means legacy.

### `src/standalone/bootstrap.ts:2501-2508` — identical CAS in the standalone root

Same read-compare-refuse, returning the same `{ success: false, type: 'memoConflict', content }` shape. Prefer lifting the check into `src/services/memoFile.ts` (created by either sibling plan) so there is one implementation, not two.

## Verification Plan

### Automated Tests

New `src/test/memo-merge-on-external-append-contract.test.js` (webview logic tested the way the existing `memo-*-contract` tests do):

1. **The core case.** Base `A`; user types `A + local`; `memoUpdated` arrives with `A + "\n\nB"`. Assert the textarea ends up containing the user's local text **and** `B`, and that a subsequent save writes both. Today `B` is lost.
2. **Non-prefix conflict.** Incoming content that does not start with base → textarea untouched, conflict flag set, status line set, no data written.
3. **CAS refusal.** `memoSave` with a stale `baseContent` returns `memoConflict` and leaves the file byte-identical — in both roots.
4. **Legacy payload.** `memoSave` with no `baseContent` writes as before. This is the regression guard for older browser tabs.
5. **Double delivery.** Deliver the same `memoConflict` reply twice; assert exactly one merge and one retry, and no duplicated tail.
6. **Caret preservation.** Merge with the caret mid-buffer; assert `selectionStart`/`selectionEnd` are unchanged.
7. **No confirm gate.** Assert no `confirm(`/`window.confirm(` anywhere in the new `memo.js` paths — the codebase-wide rule, enforced locally.

### Manual

- Memo tab open, cursor in the textarea, actively typing. From a terminal, `printf '\n\nprobe risk\n' >> .switchboard/memo.md`. The entry appears below the typed text; the typed text is untouched; the status line names the merge. Keep typing, wait for the debounced save, then `cat memo.md` — both must be present.
- Repeat in the browser panel against a standalone host (this is also the Step 0 check: if nothing ever appears, the watcher is not armed there).
- Repeat with a reviewer dispatched for real, **Risks to Memo** on, while typing in the tab.
