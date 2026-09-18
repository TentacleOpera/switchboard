# Stop Memo Entries Being Overwritten by implementation.html Refresh

## Goal

While a user is actively typing in the Memo sidebar textarea, their in-progress text gets silently overwritten by the file-on-disk content whenever the webview re-renders. The user loses what they were writing. This must stop — once the user has focus in the textarea (or has unsaved edits in flight), no asynchronous `memoContent` reload should clobber the field.

### Problem analysis & root cause

The Memo tab lives in `src/webview/implementation.html`. The textarea is `#memo-textarea` (line ~1628). Saving is debounced at 800 ms via `debouncedMemoSave()` (line ~2669), which posts `memoSave` to the host, which writes `.switchboard/memo.md`.

The reload path that clobbers the textarea:

1. The host frequently posts `terminalStatuses` messages (terminal liveness polling, dispatch readiness, etc.).
2. The webview's `message` handler calls `renderAgentList()` on every `terminalStatuses` message (line ~2274).
3. `renderAgentList()` ends by calling `switchAgentTab(currentAgentTab)` (line ~3100, and also line ~2982 in the onboarding-guard path).
4. `switchAgentTab('memo')` posts `memoLoad` to the host (line ~2622).
5. The host reads `.switchboard/memo.md` and posts back `memoContent` (`TaskViewerProvider.ts` ~9220–9228).
6. The `memoContent` handler **unconditionally** sets `textarea.value = message.content` (line ~2238).

Because the save is debounced 800 ms, the on-disk file is stale while the user is mid-keystroke. The unconditional reload therefore replaces the user's current typing with older content. The same race exists on any other code path that calls `switchAgentTab('memo')` while the user is editing (e.g. the `openMemoTab` message handler at line ~2246, and the initialState restore at line ~2232).

**Root cause:** the `memoContent` handler treats every inbound reload as authoritative and overwrites the textarea without checking whether the user is actively editing it. The reload is also fired redundantly on every `renderAgentList()` re-render, not just on an explicit user tab switch.

## Metadata

- **Tags:** frontend, ui, ux, bugfix
- **Complexity:** 4/10
- **Primary files:** `src/webview/implementation.html`
- **User-facing review items:** Memo textarea no longer loses in-progress text during background refreshes.

## User Review Required

- [ ] Confirm that ignoring background reloads while the textarea is focused or dirty matches the expected UX (no "merge" or "conflict" prompt — just silently preserve user text).
- [ ] Confirm that the `memoGeneratePrompt` success round-trip (`memoContent: ''` from host) correctly clears the textarea in the common case (user clicks Send/Copy, focus moves to button, `memoDirty` is cleared by the handler).

## Complexity Audit

### Routine
- Add an "is the user editing?" guard in the `memoContent` message handler so an inbound reload is ignored when the textarea is focused or has a pending (unflushed) debounced save.
- Track a `memoDirty` flag set on every `input` event and cleared once the save has actually been posted; clear it in the Clear / Copy / Send handlers.
- Stop `switchAgentTab()` from re-firing `memoLoad` on every re-render when the memo tab is already active and was previously loaded.

### Complex / Risky
- **Initial restore interaction (change #3):** Line 2231 pre-sets `currentAgentTab = restoredSubTab` BEFORE calling `switchAgentTab(currentAgentTab)` at line 2232. With the `isChanging` guard, if the restored tab is `'memo'`, `isChanging` evaluates to `false` and `memoLoad` never fires — memo content would not load on cold open when memo was the last active sub-tab. Fix: remove the `currentAgentTab = restoredSubTab;` pre-assignment at line 2231; `switchAgentTab` already sets `currentAgentTab = tab` internally at line 2611, and nothing between lines 2231–2232 reads `currentAgentTab`.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - **Focus-based guard edge case — user tabs away then back.** If the guard is "skip reload while focused", a user who clicks away (blur) and back will correctly accept the reload on re-focus because focus was lost. This is the desired behaviour: the reload only matters when the user is *not* looking at/editing the field.
  - **Pending debounced save.** Even when not focused, if a save is still pending in the 800 ms debounce window, an inbound reload could still race. Track a `memoDirty` flag set on every `input` event and cleared once the save has actually been posted; skip reloads while `memoDirty` is true. This covers the "typed then immediately clicked elsewhere" case.
  - **`memoGeneratePrompt` success round-trip.** The host's `memoGeneratePrompt` handler (`TaskViewerProvider.ts` lines 9277–9280) writes empty to disk AND posts `memoContent: ''` back to the webview on success. With the guard, this clear is allowed because: (a) the Send/Copy handlers clear `memoDirty` before posting, and (b) the button (not the textarea) has focus after the click. Edge case: if the async `dispatchCustomPromptToRole` takes time and the user re-focuses the textarea and starts typing, `memoDirty` becomes true and the clear is blocked — but this is correct: the user's new content is preserved, and the old content was already sent and cleared on disk.
- **Security:** No security implications. Memo content is local text only.
- **Side Effects:**
  - **Clear handler should also clear `memoSaveTimer`.** The current Clear handler (lines 2679–2685) does not clear `memoSaveTimer`. If a debounced save is in flight, it fires 800 ms later and writes `''` to disk — harmless (same result as `memoClear`) but a redundant write that races with the host's `memoClear` handler. Add `if (memoSaveTimer) clearTimeout(memoSaveTimer);` alongside `memoDirty = false;` in the Clear handler.
- **Dependencies & Conflicts:**
  - **Explicit user tab switch to Memo.** The very first time the user switches to the Memo tab, the textarea is empty/unfocused and `memoDirty` is false, so the reload proceeds normally and restores saved content. The guard must not block this initial load.
  - **`openMemoTab` message (line ~2246).** This is an explicit user-intent switch (e.g. from another panel). It calls `switchAgentTab('memo')` which fires `memoLoad`. With the dirty/focus guard in the `memoContent` handler, if the user happened to be mid-edit this would still skip — but `openMemoTab` is an explicit navigation, so it should force a load. Simplest correct approach: keep the guard in the `memoContent` handler only (not in `switchAgentTab`), so explicit loads still request content but the handler decides whether to apply it. Since `openMemoTab` implies the user is navigating *to* memo (not already editing it), the guard will naturally allow it. If the user is already on the memo tab, `isChanging` is false and `memoLoad` does not fire — which is fine because content is already loaded.
  - **`renderAgentList` redundant reload.** The cleanest fix is to make `switchAgentTab` only fire `memoLoad` when the tab is actually *changing* to `memo` (i.e. `currentAgentTab !== 'memo'` before the assignment), not when it is being re-asserted to the already-active memo tab. This eliminates the vast majority of spurious reloads at the source. Combined with the handler guard, this is belt-and-suspenders.
  - **No migration.** Memo content is a single text file re-read on demand; no schema, no shipped-state change. Safe for all ~4,000 installs.

## Dependencies

- None. This is a self-contained client-side fix in `src/webview/implementation.html`. No host-side (`TaskViewerProvider.ts`) changes are required — the host already correctly reads/writes the file and posts `memoContent`.

## Adversarial Synthesis

Key risks: (1) the `isChanging` guard in `switchAgentTab` breaks initial memo restore because line 2231 pre-sets `currentAgentTab` before the call — fix by removing the pre-assignment; (2) the `memoGeneratePrompt` success round-trip posts `memoContent: ''` which could be blocked by the guard if the user re-focuses the textarea mid-dispatch — acceptable because new content is preserved; (3) the Clear handler doesn't clear `memoSaveTimer`, causing a redundant late write. Mitigations: remove the pre-assignment, clear `memoDirty` and `memoSaveTimer` in all three action handlers (Clear/Copy/Send), and document the round-trip interaction for the implementer.

## Proposed Changes

### 1. `src/webview/implementation.html` — `memoContent` handler (~2236–2240)

Add a guard so an inbound reload is ignored while the user is focused on the textarea or has a pending dirty save:

```js
case 'memoContent': {
    const textarea = document.getElementById('memo-textarea');
    if (textarea) {
        // Don't clobber in-progress editing. A reload that arrives while the
        // user is focused on the field, or while a debounced save is still
        // pending, would replace current typing with stale on-disk content.
        const isFocused = document.activeElement === textarea;
        if (isFocused || memoDirty) {
            break;
        }
        textarea.value = typeof message.content === 'string' ? message.content : '';
    }
    break;
}
```

### 2. `src/webview/implementation.html` — track `memoDirty` (~2668–2678)

Add a `memoDirty` flag, set it on every `input`, and clear it once the debounced save has actually been posted:

```js
let memoSaveTimer = null;
let memoDirty = false;
function debouncedMemoSave() {
    memoDirty = true;
    if (memoSaveTimer) clearTimeout(memoSaveTimer);
    memoSaveTimer = setTimeout(() => {
        const content = document.getElementById('memo-textarea')?.value || '';
        vscode.postMessage({ type: 'memoSave', content, workspaceRoot: currentWorkspaceRoot });
        memoDirty = false;
        const statusEl = document.getElementById('memo-status');
        if (statusEl) { statusEl.textContent = 'Saved'; setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1500); }
    }, 800);
}
```

Also clear `memoDirty` (and `memoSaveTimer` where applicable) in the Clear / Copy / Send handlers (lines ~2679–2695) since those explicitly synchronise state:

```js
// clear handler — after textarea.value = '':
if (memoSaveTimer) clearTimeout(memoSaveTimer);
memoDirty = false;

// copy & send handlers — after clearTimeout(memoSaveTimer):
memoDirty = false;
```

**Why clearing `memoDirty` in Copy/Send is load-bearing:** The host's `memoGeneratePrompt` success path (`TaskViewerProvider.ts` line 9280) posts `memoContent: ''` back to the webview to clear the textarea. If `memoDirty` were still true when that message arrives, the guard would block the clear and the textarea would retain already-sent content. Clearing `memoDirty` in the Copy/Send handlers ensures the round-trip clear is accepted.

### 3. `src/webview/implementation.html` — `switchAgentTab` only fires `memoLoad` on actual tab change (~2610–2623)

```js
function switchAgentTab(tab) {
    const isChanging = currentAgentTab !== tab;
    currentAgentTab = tab;
    vscode.postMessage({ type: 'setActiveSubTab', tab: tab });
    // ...existing tab visibility toggling...
    if (tab === 'memo' && isChanging) {
        vscode.postMessage({ type: 'memoLoad', workspaceRoot: currentWorkspaceRoot });
    }
    // ...
}
```

This stops the redundant `memoLoad` fired by `renderAgentList()`'s tail call to `switchAgentTab(currentAgentTab)` when the memo tab is already active.

### 4. `src/webview/implementation.html` — fix initial restore path (~2229–2232)

**Critical:** Line 2231 currently pre-sets `currentAgentTab = restoredSubTab` BEFORE calling `switchAgentTab(currentAgentTab)` at line 2232. With the `isChanging` guard from change #3, this would cause `isChanging` to be `false` on initial restore (since `currentAgentTab` is already set to the restored tab), and `memoLoad` would never fire — breaking initial memo content loading.

Fix: remove the `currentAgentTab = restoredSubTab;` pre-assignment at line 2231. `switchAgentTab` already sets `currentAgentTab = tab` internally at line 2611, and nothing between lines 2231–2232 reads `currentAgentRoot`.

Before:
```js
const restoredSubTab = (message.activeSubTab && validSubTabs.includes(message.activeSubTab)) ? message.activeSubTab : 'terminals';
currentAgentTab = restoredSubTab;
switchAgentTab(currentAgentTab);
```

After:
```js
const restoredSubTab = (message.activeSubTab && validSubTabs.includes(message.activeSubTab)) ? message.activeSubTab : 'terminals';
switchAgentTab(restoredSubTab);
```

## Verification Plan

### Automated Tests

Automated tests are skipped per session directive. The test suite will be run separately by the user.

### Manual Verification

1. **Repro the bug first (pre-fix):** open the Memo tab, start typing, and trigger frequent `terminalStatuses` updates (e.g. open/close agent terminals or wait for polling). Observe the textarea content reverting to older text. Confirm this is the race being fixed.
2. **Post-fix manual:** with the fix applied, repeat the above. The textarea must retain the user's in-progress text through arbitrary numbers of background refreshes while focused.
3. **Initial load still works:** switch to the Memo tab from another tab with no editing in progress; saved `.switchboard/memo.md` content must load into the textarea as before.
4. **Cold open with memo as last active tab:** close and reopen the extension (or reload the webview) when the persisted active sub-tab is `memo`. The memo content must load into the textarea on initial restore. (This verifies change #4 — the initial restore fix.)
5. **Tab-away/tab-back:** type some text, click elsewhere (blur), then click back into the textarea — content must still be present (the debounced save will have flushed it to disk, so any subsequent reload is consistent).
6. **Clear/Copy/Send:** confirm all three still work and leave the textarea empty (or cleared) as before, with `memoDirty` and `memoSaveTimer` reset so a later reload is accepted.
7. **`openMemoTab` navigation:** trigger an `openMemoTab` from another panel while not editing memo; confirm content loads correctly.
8. **Send to Planner round-trip:** click "Send to Planner" with memo content; confirm the textarea clears after successful dispatch (the `memoContent: ''` round-trip is accepted by the guard because `memoDirty` was cleared by the send handler).

---

**Recommendation:** Complexity is 4/10 → **Send to Coder**.

---

## Reviewer Pass — 2026-06-24

**Verdict:** Implementation complete and faithful to all four proposed changes. No CRITICAL/MAJOR findings. No code fixes required.

### Changes verified in `src/webview/implementation.html`

1. **`memoContent` guard** (`2236–2246`) — reload skipped when `isFocused || memoDirty`; otherwise applies `message.content`. Matches change #1.
2. **`memoDirty` tracking** — declared `2616`; set `true` at start of `debouncedMemoSave` (`2678`); cleared `false` when the debounced save posts (`2683`). Matches change #2.
3. **`switchAgentTab` `isChanging` gate** (`2618`, `2629`) — `memoLoad` fires only on actual change to `memo`, suppressing the redundant reloads from `renderAgentList`'s tail calls at `2996` and `3114`. Matches change #3.
4. **Cold-open restore fix** (`2232`) — the `currentAgentTab = restoredSubTab;` pre-assignment was removed; `switchAgentTab(restoredSubTab)` is now called with `currentAgentTab` still at its initial `'terminals'`, so `isChanging === true` and `memoLoad` correctly fires on cold open. The exact landmine flagged in the Complexity Audit is disarmed. Matches change #4.
5. **Clear/Copy/Send handlers** (`2692–2693`, `2699–2700`, `2705–2706`) — all clear `memoDirty` (Clear also clears `memoSaveTimer`), so the host's `memoGeneratePrompt` → `memoContent: ''` round-trip is accepted. Matches the "load-bearing" requirement in §2.

### Findings by severity

- **CRITICAL:** None.
- **MAJOR:** None.
- **NIT — `memoDirty` cleared at post-time, not write-confirm-time** (`implementation.html:2683`): the flag flips on `postMessage`, not on host write-ack. A reload arriving between post and disk flush could theoretically apply stale content. Not exploitable in practice — reloads now only originate from explicit tab changes (human-speed) and file writes are sub-millisecond. Not worth write-ack plumbing. Deferred.
- **NIT — TDZ false alarm** (`2240` refs `memoDirty` declared at `2616`): safe; the `memoContent` handler is an async message callback that runs only after full script execution.
- **NIT — `openMemoTab` while already on memo is a no-op** (`2252`): correct (content already loaded), as reasoned in §Dependencies.

### Validation

- Compilation: **skipped per session directive.**
- Automated tests: **skipped per session directive** (to be run separately by the user).
- Static review of the diff confirms surgical, correctly-scoped edits; no stray `confirm()` gates introduced; no other writers to `#memo-textarea.value` bypass the guard.

### Code fixes applied

None — implementation required no changes.

### Remaining risks

- The post-time `memoDirty` clear leaves a vanishingly small disk-write-ordering window (NIT above). Pre-existing class of I/O race, not introduced or worsened by this change.
- Manual verification steps 1–8 (above) remain to be exercised by the user, particularly step 4 (cold-open with memo as last active sub-tab) and step 8 (Send to Planner round-trip clear).
