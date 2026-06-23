# Move Memo from Kanban Modal to a Third Sidebar Tab in implementation.html

## Goal (Problem analysis + Root Cause with cited file:line)

**Problem.** The Memo is currently a modal that lives only in `kanban.html`. It is opened by a board icon button (`src/webview/kanban.html:2429`, `#btn-open-memo`) and rendered as a modal overlay (`src/webview/kanban.html:3018-3049`, `#memo-modal`). The host-side handlers that load/save/clear the memo and generate the planner prompt live in `KanbanProvider` (`src/services/KanbanProvider.ts:6942-7104`).

Two consequences:
1. **Unavailable when kanban.html is closed.** The Memo only exists inside the Kanban panel webview. If the user is working in the sidebar (the `implementation.html` view) and the Kanban tab is closed, there is no way to jot a quick note. The `switchboard.openMemo` command (`src/extension.ts:752-756`) *force-opens* the Kanban panel (`await kanbanProvider!.open()`) just to show the modal, which yanks the user away from whatever they were doing.
2. **Forced context switch.** Even when Kanban is open, the user must switch to it and dismiss the modal to get back to work.

**Root cause.** The Memo was implemented as Kanban-panel-only UI. The sidebar view (`implementation.html`, served by `TaskViewerProvider` — `src/services/TaskViewerProvider.ts`) is the always-present surface the user actually works in, and it already has a sub-tab bar pattern (Agents / Terminals at `src/webview/implementation.html:1602-1605`) that the Memo should join as a third sub-tab.

**Fix.** Add a third sidebar sub-tab "Memo" inside `#panel-agents` in `implementation.html`, mirroring the existing Agents/Terminals sub-tab pattern (`src/webview/implementation.html:1602-1605`, switch logic at `src/webview/implementation.html:2576-2598`). Move the memo content, JS, and host handlers so the Memo is served from `TaskViewerProvider` instead of `KanbanProvider`. Remove the Kanban board icon (`#btn-open-memo`) and the `#memo-modal` markup + JS from `kanban.html`. Retarget the `switchboard.openMemo` command to the sidebar. The underlying storage (`.switchboard/memo.md`, `src/services/KanbanProvider.ts:7019-7021`) is unchanged, so existing memo content persists.

## Metadata

**Complexity:** 7/10
**Tags:** webview, memo, sidebar-tab, implementation.html, kanban-cleanup, refactor, planner-dispatch

## Complexity Audit

### Routine
- Adding a third sub-tab button in `implementation.html` and a matching panel `<div>` (HTML mirroring lines 1602-1620).
- Extending `switchAgentTab()` (`src/webview/implementation.html:2576-2598`) and the `tabs` map to include `memo`.
- Extending the persisted sub-tab whitelist in both the webview (`src/webview/implementation.html:2206`) and host (`src/services/TaskViewerProvider.ts:8994`) from `['agents','terminals']` to `['agents','terminals','memo']`.
- Deleting the modal markup, the board icon, and the modal-only JS from `kanban.html`.

### Complex / Risky
- **Host-handler relocation.** The memo load/save/clear/generate handlers and four private helpers (`_getMemoPath`, `_parseMemoEntries`, `_buildMemoPlannerPrompt`, `_dispatchMemoToPlanner`) currently live in `KanbanProvider` (`src/services/KanbanProvider.ts:6942-7104`). They must be reachable from the `TaskViewerProvider` message switch (`src/services/TaskViewerProvider.ts:7900`). `dispatchCustomPromptToRole` already lives in `TaskViewerProvider` (`src/services/TaskViewerProvider.ts:2495`), so the planner-dispatch path is actually *simpler* there (no `this._taskViewerProvider` indirection needed). Risk: getting the workspace-name lookup right — `KanbanProvider` uses `this._getWorkspaceItems()` which `TaskViewerProvider` does not have; fall back to `path.basename(workspaceRoot)`.
- **fs API parity.** `KanbanProvider` uses Node `fs.promises`. `TaskViewerProvider` imports `fs` as `stateFs` from `./stateConfigBridge` (`src/services/TaskViewerProvider.ts:3`), which exposes `fs.promises.{readFile,writeFile,mkdir}` (confirmed in use at `src/services/TaskViewerProvider.ts:613-644`). The relocated handlers must use that aliased `fs`, not a fresh `import * as fs from 'fs'`.
- **Command retarget.** `switchboard.openMemo` (`src/extension.ts:752-756`) currently opens the Kanban panel and posts `openMemoModal`. It must instead reveal the sidebar view and post a "switch to memo sub-tab" message. Risk: revealing the sidebar view requires the view to be resolved; if it is not yet created, posting a message is a no-op. Use the existing view-reveal path (see Proposed Changes).
- **Keydown / Escape handler.** The modal had an Escape-to-close handler (`src/webview/kanban.html:3747-3752`). A sidebar tab is not a modal, so this is dropped (not relocated) — removing it must not leave a dangling reference.

## Edge-Case & Dependency Audit

- **Persistence of existing memo content (CRITICAL — shipped state).** Memo content is stored at `<workspaceRoot>/.switchboard/memo.md` (`src/services/KanbanProvider.ts:7019-7021`). This is shipped, user-authored data across ~4,000 installs. The new sidebar handlers MUST read/write the **same path** (`.switchboard/memo.md`). Do not rename, move, or delete this file. No migration step is needed *because the path is preserved* — but the plan must explicitly keep `_getMemoPath` returning `path.join(workspaceRoot, '.switchboard', 'memo.md')`. The relocated handler is read-before-write (`memoLoad` reads, missing file is tolerated via try/catch) exactly as today (`src/services/KanbanProvider.ts:6946-6949`), so an empty/absent file is safe.
- **Removal of modal must not orphan handlers.** When deleting `#memo-modal` and `#btn-open-memo` from `kanban.html`, also delete every JS reference: `openMemoModal`, `closeMemoModal`, `debouncedMemoSave`, all `getElementById('memo-*')` listeners (`src/webview/kanban.html:3686-3752`), the `memoContent` / `memoPromptResult` / `openMemoModal` cases in the kanban message switch (`src/webview/kanban.html:6438-6456`), and the Escape keydown handler (`src/webview/kanban.html:3747-3752`). Leaving the `openMemoModal` message case while removing the modal would make the case a silent no-op (acceptable) but leaving the *button* without its handler removed is dead markup — remove both.
- **Decide: should KanbanProvider's memo host handlers stay or go?** Decision: **remove** them from `KanbanProvider` (`src/services/KanbanProvider.ts:6942-7104`) since nothing in `kanban.html` will post `memoLoad`/`memoSave`/`memoClear`/`memoGeneratePrompt`/`openMemoModal` anymore. Leaving dead cases is harmless but the four private helpers would become unused (lint/dead-code). Move the helpers to `TaskViewerProvider` and delete the originals.
- **Sub-tab persistence whitelist.** The webview restores the persisted sub-tab against `['agents','terminals']` (`src/webview/implementation.html:2206`) and the host clamps writes against `['agents','terminals']` (`src/services/TaskViewerProvider.ts:8994`). Both must add `'memo'`, otherwise a user who leaves the sidebar on Memo will be bounced back to Terminals on reload, and `setActiveSubTab` writes of `'memo'` will be silently rewritten to `'terminals'`.
- **workspaceRoot plumbing.** `kanban.html` auto-injected `workspaceRoot` via `postKanbanMessage` (`src/webview/kanban.html:3861-3865`). `implementation.html` has **no** such helper — each `vscode.postMessage` passes `workspaceRoot` explicitly (it tracks `currentWorkspaceRoot`, `src/webview/implementation.html:1675`, set from `initialState`/push at lines 2213 and 2320). The relocated memo JS must include `workspaceRoot: currentWorkspaceRoot` on every memo message. Host-side `_resolveWorkspaceRoot(msg.workspaceRoot)` (`src/services/TaskViewerProvider.ts:977`) then validates it — same contract as Kanban's `_resolveWorkspaceRoot`.
- **`switchboard.openMemo` external callers.** The command is also wired to a status bar item (`src/extension.ts:1862-1867`) and a panel-quick-pick (`src/extension.ts:2147-2149`, `2012`). All invoke `switchboard.openMemo`; retargeting the single command body updates all of them at once — no per-caller edits needed.
- **Memo hotkey setting unaffected.** `switchboard.memo.hotkey` (read/written in `SetupPanelProvider` at `src/services/SetupPanelProvider.ts:646-657`) just maps a keybinding to `switchboard.openMemo`. Since the command id is unchanged, the hotkey keeps working and points at the new sidebar behavior. No change required there.
- **Theme parity.** `implementation.html` already styles `.modal-textarea` (`src/webview/implementation.html:1003-1024`) and `.sub-tab-btn` including the `theme-claudify` variants (`src/webview/implementation.html:363-399`). The new Memo panel reuses `.modal-textarea` for the editor and `.sub-tab-btn` for the tab, so no new theme work is needed.
- **Build artifact.** Per CLAUDE.md, `implementation.html` and `kanban.html` are bundled into `dist/webview/` by webpack; `npm run compile` is mandatory after editing either.
- **No confirmation dialogs.** The "Clear" button must clear immediately (it already does — `src/webview/kanban.html:3721-3727`). Do not add any confirm gate when relocating.

## Proposed Changes

### 1. `src/webview/implementation.html` — add the third sub-tab + panel

**(a) Sub-tab bar — add the Memo button.** At `src/webview/implementation.html:1602-1605`:

```html
<!-- BEFORE -->
<div class="sub-tab-bar">
    <button class="sub-tab-btn" data-tab="agents">Agents</button>
    <button class="sub-tab-btn is-active" data-tab="terminals">Terminals</button>
</div>
```
```html
<!-- AFTER -->
<div class="sub-tab-bar">
    <button class="sub-tab-btn" data-tab="agents">Agents</button>
    <button class="sub-tab-btn is-active" data-tab="terminals">Terminals</button>
    <button class="sub-tab-btn" data-tab="memo">Memo</button>
</div>
```

**(b) Memo panel content.** Immediately after the `#agent-list-terminals` block closes (`src/webview/implementation.html:1620`, before the `</div>` that closes `#panel-agents` at line 1621), insert a memo panel that mirrors the modal body/footer but uses the sidebar's existing `.agent-list` / `.modal-textarea` styling:

```html
<!-- AFTER the closing </div> of #agent-list-terminals (line 1620), before #panel-agents closes -->
<div id="agent-list-memo" class="agent-list hidden">
    <div class="memo-tab-content" style="padding: 10px; display: flex; flex-direction: column; gap: 8px;">
        <p style="font-size: 11px; color: var(--text-secondary); margin: 0 0 4px;">
            Jot down bugs, thoughts, or issues — one per line or paragraph. Each entry becomes a
            <strong>separate issue</strong>. Saved automatically; cleared after Copy Prompt / Send to Planner.
        </p>
        <textarea id="memo-textarea" class="modal-textarea"
                  placeholder="Bug: login button overlaps on mobile&#10;Thought: maybe cache the user profile&#10;Issue: API returns 500 on empty payload..."
                  style="width: 100%; min-height: 240px; resize: vertical; font-family: var(--font-mono, monospace); font-size: 13px;"></textarea>
        <span id="memo-status" style="font-size: 11px; color: var(--text-secondary); min-height: 14px;"></span>
        <button id="memo-clear-btn" class="secondary-btn w-full">Clear</button>
        <button id="memo-copy-btn" class="secondary-btn is-teal w-full">Copy Prompt</button>
        <button id="memo-send-btn" class="secondary-btn is-teal w-full">Send to Planner</button>
    </div>
</div>
```

**(c) Sub-tab switch logic.** In `switchAgentTab()` (`src/webview/implementation.html:2576-2598`), add `memo` to the `tabs` map and trigger a load when entering the tab:

```js
// BEFORE (line 2579)
const tabs = { agents: agentListStandard, terminals: agentListTerminals };
```
```js
// AFTER
const tabs = {
    agents: agentListStandard,
    terminals: agentListTerminals,
    memo: document.getElementById('agent-list-memo')
};
```
And inside the same function, after the existing `if (tab === 'terminals') { ... }` block (ends `src/webview/implementation.html:2594`), add:

```js
if (tab === 'memo') {
    vscode.postMessage({ type: 'memoLoad', workspaceRoot: currentWorkspaceRoot });
}
```

**(d) Persisted sub-tab whitelist (restore).** At `src/webview/implementation.html:2206`:

```js
// BEFORE
const validSubTabs = ['agents', 'terminals'];
```
```js
// AFTER
const validSubTabs = ['agents', 'terminals', 'memo'];
```

**(e) Memo JS (relocated from kanban.html).** Add a memo script block alongside the other sub-tab handlers (e.g. just after the `.sub-tab-btn` click wiring at `src/webview/implementation.html:2622-2624`). This is the kanban memo JS (`src/webview/kanban.html:3686-3739`) rewritten to use `vscode.postMessage` with explicit `currentWorkspaceRoot` (replacing `postKanbanMessage`) and the new element ids:

```js
// === Memo (sidebar tab) ===
let memoSaveTimer = null;
function debouncedMemoSave() {
    if (memoSaveTimer) clearTimeout(memoSaveTimer);
    memoSaveTimer = setTimeout(() => {
        const content = document.getElementById('memo-textarea')?.value || '';
        vscode.postMessage({ type: 'memoSave', content, workspaceRoot: currentWorkspaceRoot });
        const statusEl = document.getElementById('memo-status');
        if (statusEl) { statusEl.textContent = 'Saved'; setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1500); }
    }, 800);
}
document.getElementById('memo-textarea')?.addEventListener('input', debouncedMemoSave);
document.getElementById('memo-clear-btn')?.addEventListener('click', () => {
    const textarea = document.getElementById('memo-textarea');
    if (textarea) textarea.value = '';
    vscode.postMessage({ type: 'memoClear', workspaceRoot: currentWorkspaceRoot });
    const statusEl = document.getElementById('memo-status');
    if (statusEl) statusEl.textContent = 'Cleared';
});
document.getElementById('memo-copy-btn')?.addEventListener('click', () => {
    if (memoSaveTimer) clearTimeout(memoSaveTimer);
    const content = document.getElementById('memo-textarea')?.value || '';
    vscode.postMessage({ type: 'memoGeneratePrompt', content, action: 'copy', workspaceRoot: currentWorkspaceRoot });
});
document.getElementById('memo-send-btn')?.addEventListener('click', () => {
    if (memoSaveTimer) clearTimeout(memoSaveTimer);
    const content = document.getElementById('memo-textarea')?.value || '';
    vscode.postMessage({ type: 'memoGeneratePrompt', content, action: 'send', workspaceRoot: currentWorkspaceRoot });
});
```

**(f) Inbound message cases.** In the `switch (message.type)` block (`src/webview/implementation.html:2201`), add cases for the host replies (mirroring `src/webview/kanban.html:6438-6453`, minus the modal title) and a command-driven tab switch:

```js
case 'memoContent': {
    const textarea = document.getElementById('memo-textarea');
    if (textarea) textarea.value = typeof message.content === 'string' ? message.content : '';
    break;
}
case 'memoPromptResult': {
    const statusEl = document.getElementById('memo-status');
    if (statusEl) statusEl.textContent = message.message || '';
    break;
}
case 'openMemoTab': {
    switchAgentTab('memo');
    break;
}
```

### 2. `src/services/TaskViewerProvider.ts` — host handlers (relocated from KanbanProvider)

**(a) Message cases.** In the webview message switch (`src/services/TaskViewerProvider.ts:7900`), add `memoLoad` / `memoSave` / `memoClear` / `memoGeneratePrompt` cases. These are the bodies from `src/services/KanbanProvider.ts:6942-7015`, adapted: use `this._view?.webview.postMessage` (the sidebar webview ref), drop the `_getWorkspaceItems()` lookup (use `path.basename`), and call `this.dispatchCustomPromptToRole(...)` directly (it already exists at line 2495) instead of via `_dispatchMemoToPlanner` indirection. Example for `memoLoad`:

```js
case 'memoLoad': {
    const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
    if (!workspaceRoot) break;
    const memoPath = this._getMemoPath(workspaceRoot);
    let content = '';
    try { content = await fs.promises.readFile(memoPath, 'utf8'); } catch { /* no file yet */ }
    this._view?.webview.postMessage({ type: 'memoContent', content });
    break;
}
```
`memoSave`, `memoClear`, `memoGeneratePrompt` follow `src/services/KanbanProvider.ts:6956-7010` verbatim except for the same three adaptations. For `memoGeneratePrompt`, the clear-after-success and `memoContent` reset must be preserved exactly (`src/services/KanbanProvider.ts:6993-6999`).

**(b) Helpers.** Add `_getMemoPath`, `_parseMemoEntries`, `_buildMemoPlannerPrompt` to `TaskViewerProvider` as private methods, copied verbatim from `src/services/KanbanProvider.ts:7019-7080`. `_dispatchMemoToPlanner` is **not** copied — its sole job was to reach `this._taskViewerProvider.dispatchCustomPromptToRole`; in `TaskViewerProvider` the `memoGeneratePrompt` handler calls `this.dispatchCustomPromptToRole('planner', prompt, workspaceRoot)` directly with the same try/catch + fallback messaging.

**(c) Sub-tab clamp.** At `src/services/TaskViewerProvider.ts:8994`:

```js
// BEFORE
const validSubTabs = ['agents', 'terminals'];
```
```js
// AFTER
const validSubTabs = ['agents', 'terminals', 'memo'];
```

**(d) Reveal-and-switch entry point.** Add a public method so the `switchboard.openMemo` command can reveal the sidebar and select the Memo tab, e.g.:

```js
public async openMemoTab(): Promise<void> {
    if (this._view) {
        this._view.show?.(true); // reveal the sidebar view if collapsed
    }
    this._view?.webview.postMessage({ type: 'openMemoTab' });
}
```
(If the view is not yet resolved, follow whatever existing pattern `TaskViewerProvider` uses to reveal itself — e.g. the same `executeCommand` used elsewhere to focus the view container — then post `openMemoTab`.)

### 3. `src/webview/kanban.html` — remove modal + board icon + JS

- **Delete the board icon button** (`src/webview/kanban.html:2429-2433`, `#btn-open-memo`).
- **Delete the modal markup** (`src/webview/kanban.html:3018-3049`, the entire `#memo-modal` block).
- **Delete the memo JS block** (`src/webview/kanban.html:3686-3752`): `memoSaveTimer`, `openMemoModal`, `closeMemoModal`, `debouncedMemoSave`, all `getElementById('memo-*')` and `#btn-open-memo` listeners, the overlay-click-close handler, and the Escape keydown handler.
- **Delete the inbound cases** in the kanban message switch (`src/webview/kanban.html:6438-6456`): `memoContent`, `memoPromptResult`, and `openMemoModal`.

After these deletions, grep `kanban.html` for `memo` should return zero hits.

### 4. `src/services/KanbanProvider.ts` — remove relocated handlers

- **Delete the message cases** `memoLoad`, `memoSave`, `memoClear`, `memoGeneratePrompt`, `openMemoModal` (`src/services/KanbanProvider.ts:6942-7015`).
- **Delete the now-unused private helpers** `_getMemoPath`, `_parseMemoEntries`, `_buildMemoPlannerPrompt`, `_dispatchMemoToPlanner` (`src/services/KanbanProvider.ts:7019-7104`).
- Verify no other `KanbanProvider` code references these (the planner-dispatch helpers in `TaskViewerProvider` are independent — see `src/services/TaskViewerProvider.ts:4759`, `4771`).

### 5. `src/extension.ts` — retarget the command

At `src/extension.ts:752-756`:

```js
// BEFORE
const openMemoDisposable = vscode.commands.registerCommand('switchboard.openMemo', async () => {
    await kanbanProvider!.open();
    kanbanProvider!.postMessage({ type: 'openMemoModal' });
});
```
```js
// AFTER
const openMemoDisposable = vscode.commands.registerCommand('switchboard.openMemo', async () => {
    await taskViewerProvider!.openMemoTab();
});
```
Confirm `taskViewerProvider` is in scope at this point in `activate()` (the symbol that owns `implementation.html`). If it is created later than line 752, move the command registration after its construction, or capture the reference. The status-bar item (`src/extension.ts:1862-1867`) and quick-pick (`src/extension.ts:2147-2149`) need no change — they invoke the command id.

## Verification Plan

1. **Build:** `npm run compile` — must succeed with no TypeScript errors (the relocated helpers, the deleted KanbanProvider methods, and the new `openMemoTab` must all type-check; confirm `taskViewerProvider` scope in `extension.ts`).
2. **Dead-reference sweep:** `grep -in memo src/webview/kanban.html` returns nothing; `grep -n "_dispatchMemoToPlanner\|_buildMemoPlannerPrompt\|_parseMemoEntries\|_getMemoPath\|memoLoad\|openMemoModal" src/services/KanbanProvider.ts` returns nothing.
3. **Persistence (CRITICAL):** With an existing `<workspaceRoot>/.switchboard/memo.md` containing text, open the sidebar, click the **Memo** tab — the existing content must appear in the textarea (proves the shipped file path is preserved and read).
4. **Save round-trip:** Type into the textarea, wait ~1s ("Saved" appears), reload the window, reopen the Memo tab — text persists. Inspect `memo.md` on disk to confirm it was written.
5. **Clear:** Click **Clear** — textarea empties immediately (no confirm dialog), `memo.md` becomes empty.
6. **Copy Prompt:** Enter 2 entries, click **Copy Prompt** — clipboard holds a planner prompt referencing 2 issues and `.switchboard/plans/`; memo clears; status shows the count message.
7. **Send to Planner:** With a planner terminal available, click **Send to Planner** — prompt dispatches to the planner role and memo clears; without one, it falls back to clipboard + a "paste manually" message and preserves the memo for retry (mirrors `src/services/KanbanProvider.ts:7008`).
8. **Sub-tab persistence:** Leave the sidebar on the Memo tab, reload — it re-opens on Memo (not Terminals), proving both whitelist edits (`implementation.html:2206` and `TaskViewerProvider.ts:8994`).
9. **Command / hotkey / status bar:** Run `switchboard.openMemo` via the command palette, the configured hotkey (`switchboard.memo.hotkey`), and the status-bar comment-discussion icon — each reveals the sidebar and selects the Memo tab. The Kanban panel must NOT be force-opened.
10. **Kanban regression:** Open the Kanban board — the memo board icon is gone, no modal exists, no console errors, and other board icons/tabs work.
