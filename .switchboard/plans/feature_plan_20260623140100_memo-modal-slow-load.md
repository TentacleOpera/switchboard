# Memo Modal Slow Load — Decouple Memo Capture from the Kanban Panel Boot

## Goal (Problem analysis + Root Cause with cited file:line)

**Reported symptom:** The memo modal "takes a long time to load, even though it is just rendering a markdown file."

**Finding #1 — there is no markdown rendering.** The memo is a plain `<textarea>`, not a rendered markdown view. The modal markup is a textarea plus buttons (`src/webview/kanban.html:3018`–`3046`), and `memoContent` simply assigns the raw file text into `textarea.value` with no parsing or markdown library involved (`src/webview/kanban.html:6438`–`6447`). The host-side load is a single `fs.promises.readFile` of `.switchboard/memo.md` (`src/services/KanbanProvider.ts:6942`–`6953`). The file read itself is trivially fast and is **not** the bottleneck. So the user's mental model ("just a markdown file") is correct, which is exactly why the slowness is surprising — the cost is not in the memo at all.

**Root cause — the memo is welded to the entire KANBAN webview lifecycle.** The status-bar button and hotkey both fire `switchboard.openMemo`:

```ts
// src/extension.ts:752-755
const openMemoDisposable = vscode.commands.registerCommand('switchboard.openMemo', async () => {
    await kanbanProvider!.open();
    kanbanProvider!.postMessage({ type: 'openMemoModal' });
});
```

`kanbanProvider.open()` (`src/services/KanbanProvider.ts:865`–`917`) has two slow paths, **both** of which gate the memo:

1. **Cold open (panel closed):** `open()` builds the full Kanban webview — `createWebviewPanel` + `_getHtml()` reads and string-templates a **9,087-line** `kanban.html` (`wc -l src/webview/kanban.html`), injecting CSP, shared defaults, and ~dozens of icon URIs (`src/services/KanbanProvider.ts:7220`+). The webview then has to parse and execute the entire kanban script bundle before it posts `ready` (`src/webview/kanban.html:8442`), which in turn triggers `switchboard.fullSync` — a full file→DB board sync (`src/services/KanbanProvider.ts:4278`–`4281`). Only after all of that does the webview's message listener exist and the memo modal can show. The user waits for an entire project board to boot just to jot a note.

2. **Warm open (panel already open):** `open()` still does `await vscode.commands.executeCommand('switchboard.fullSync')` **before returning** (`src/services/KanbanProvider.ts:872`). That is a full `taskViewerProvider.fullSync()` (`src/extension.ts:917`–`920`) — re-scanning sessions/plans and re-syncing the DB — which blocks `openMemo` before `postMessage({type:'openMemoModal'})` is even sent. So opening the memo on top of an already-open board re-runs a heavyweight sync every time.

**Root cause — a message race that can make a cold open show nothing.** On a cold open, `postMessage({type:'openMemoModal'})` (`src/extension.ts:754`) fires synchronously right after `open()` resolves. But `open()` returns before the freshly created webview has loaded and registered its `message` listener (the listener is wired inside the webview script that runs after HTML parse). `postMessage` has no buffering — it is a bare `this._panel.webview.postMessage(message)` (`src/services/KanbanProvider.ts:1322`–`1326`). So the `openMemoModal` message is frequently **dropped** on first open, meaning the modal either appears only after the long boot completes and the message happens to land, or doesn't appear at all and the user clicks again — perceived as "very slow / flaky."

**Summary:** The memo is fast; the Kanban panel it is bolted onto is not. The fix is to stop routing memo capture through a full Kanban panel boot + full board sync, and to make `openMemoModal` survive the cold-open race.

## Metadata
**Complexity:** 4
**Tags:** `performance`, `webview`, `memo`, `kanban`, `ux`, `message-race`

## Complexity Audit

### Routine
- Removing the unconditional `fullSync` from the memo open path (warm-open case). Memo load does not need a board sync — it reads `memo.md` independently via `memoLoad`.
- Buffering a single pending `openMemoModal` (or generic pending message) until the webview reports `ready`, so the cold-open message is never dropped.

### Complex/Risky
- We must **not** regress the normal "open the board" UX (`switchboard.openKanban` / its `open()` callers) — `fullSync` on board open is intentional there. The change must be scoped so only the *memo* entry point skips the sync, OR `open()` gains an option to skip the sync while board-open callers keep it.
- `retainContextWhenHidden: true` (`src/services/KanbanProvider.ts:886`) means a once-opened panel stays mounted, so warm-open is the common case for active users — the warm-open `fullSync` removal is the highest-value fix and must be precise so we don't strip sync from genuine board reveals.

## Edge-Case & Dependency Audit

- **No migration concerns.** This changes runtime open/render flow only. No state schema, no settings, no files-on-disk format change. Per project migration rule: nothing shipped is being deleted or restructured, so no migration needed.
- **No confirmation dialogs introduced** (project hard rule). N/A here.
- **Webview build:** `kanban.html` lives in `src/webview/` and is served from `dist/webview/` after webpack. Any edit to `kanban.html` requires `npm run compile` (per CLAUDE.md). Host-side `.ts` edits also require recompile.
- **Race buffer must be drained exactly once and cleared on dispose** so a stale pending message can't fire into a later, unrelated panel. `onDidDispose` already nulls `_panel` (`src/services/KanbanProvider.ts:902`–`905`); clear the pending message there too.
- **Memo content freshness:** removing `fullSync` from the memo path does not stale the memo — the memo modal always issues its own `memoLoad` on open (`src/webview/kanban.html:3694`), which re-reads `memo.md` from disk (`src/services/KanbanProvider.ts:6948`). Board cards may be slightly staler when the memo is the thing that first opened the panel, but the next real board interaction / Sync Board refreshes them; acceptable trade for instant memo.
- **Tab state:** memo open must not disturb `_pendingTab` handling. The memo modal is an overlay, independent of the active tab, so no `switchToTab` is needed for memo.
- **Concurrent `/memo` skill writes:** documented v1 last-write-wins limitation (`src/webview/kanban.html:3741`–`3745`). Unchanged by this plan.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — add a sync-skip option to `open()` and a pending-message buffer

**1a. Skip the warm-open `fullSync` when the caller only needs the panel revealed (e.g. memo).**

Before (`src/services/KanbanProvider.ts:865`–`878`):
```ts
public async open(tab?: string) {
    if (tab) {
        this._pendingTab = tab;
    }
    if (this._panel) {
        this._panel.reveal(vscode.ViewColumn.One);
        // Trigger unified refresh so the board gets fresh data
        await vscode.commands.executeCommand('switchboard.fullSync');
        if (this._pendingTab) {
            this._panel.webview.postMessage({ type: 'switchToTab', tab: this._pendingTab });
            this._pendingTab = undefined;
        }
        return;
    }
```

After:
```ts
public async open(tab?: string, opts?: { skipSync?: boolean }) {
    if (tab) {
        this._pendingTab = tab;
    }
    if (this._panel) {
        this._panel.reveal(vscode.ViewColumn.One);
        // Trigger unified refresh so the board gets fresh data.
        // Skipped for lightweight reveals (e.g. opening the memo overlay),
        // which do not depend on a full board sync — the memo reads memo.md
        // independently via 'memoLoad'.
        if (!opts?.skipSync) {
            await vscode.commands.executeCommand('switchboard.fullSync');
        }
        if (this._pendingTab) {
            this._panel.webview.postMessage({ type: 'switchToTab', tab: this._pendingTab });
            this._pendingTab = undefined;
        }
        return;
    }
```

**1b. Buffer a pending message across the cold-open boot so `openMemoModal` is never dropped.**

Add a field near `_panel` (`src/services/KanbanProvider.ts:106`):
```ts
    private _panel?: vscode.WebviewPanel;
    /** Messages queued before the webview reported 'ready'; drained on 'ready'. */
    private _pendingWebviewMessages: any[] = [];
    private _webviewReady = false;
```

Update `postMessage` (`src/services/KanbanProvider.ts:1322`–`1326`):
```ts
public postMessage(message: any): void {
    if (!this._panel) return;
    if (this._webviewReady) {
        this._panel.webview.postMessage(message);
    } else {
        // Webview not mounted yet (cold open). Queue and flush on 'ready'
        // so messages like 'openMemoModal' aren't lost into a webview
        // whose message listener doesn't exist yet.
        this._pendingWebviewMessages.push(message);
    }
}
```

Drain on `ready` (`src/services/KanbanProvider.ts:4278`–`4290`), add after the existing `await vscode.commands.executeCommand('switchboard.fullSync');`:
```ts
            case 'ready':
                this._webviewReady = true;
                // Initial load: trigger full file→DB sync to ensure DB is populated,
                // then kanbanProvider.refresh() is called by fullSync after syncing.
                await vscode.commands.executeCommand('switchboard.fullSync');
                {
                    const currentTheme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
                    this._panel?.webview.postMessage({ type: 'switchboardThemeNameSetting', theme: currentTheme });
                }
                if (this._pendingTab) {
                    this._panel?.webview.postMessage({ type: 'switchToTab', tab: this._pendingTab });
                    this._pendingTab = undefined;
                }
                // Flush anything queued before the webview was ready.
                if (this._pendingWebviewMessages.length) {
                    const queued = this._pendingWebviewMessages;
                    this._pendingWebviewMessages = [];
                    for (const m of queued) {
                        this._panel?.webview.postMessage(m);
                    }
                }
                break;
```

Reset the flag/buffer on dispose. Both dispose handlers (`src/services/KanbanProvider.ts:902`–`905` and `:940`–`943`) currently do:
```ts
        this._panel.onDidDispose(() => {
            this._panel = undefined;
            this._lastColumnsSignature = null;
        }, null, this._disposables);
```
After (apply to both occurrences):
```ts
        this._panel.onDidDispose(() => {
            this._panel = undefined;
            this._lastColumnsSignature = null;
            this._webviewReady = false;
            this._pendingWebviewMessages = [];
        }, null, this._disposables);
```

> Note: `deserializeWebviewPanel` (`:919`) also creates a panel that will post `ready`; the flag starts `false` and flips on `ready`, so restored panels are handled by the same path. No extra change needed there beyond the dispose reset above.

### 2. `src/extension.ts` — open the memo without forcing a board sync

Before (`src/extension.ts:752`–`755`):
```ts
    const openMemoDisposable = vscode.commands.registerCommand('switchboard.openMemo', async () => {
        await kanbanProvider!.open();
        kanbanProvider!.postMessage({ type: 'openMemoModal' });
    });
```

After:
```ts
    const openMemoDisposable = vscode.commands.registerCommand('switchboard.openMemo', async () => {
        // Reveal the panel but skip the full board sync — the memo only needs
        // its own memo.md (loaded via 'memoLoad' on modal open). postMessage()
        // queues 'openMemoModal' if the webview is still booting (cold open),
        // so the modal reliably appears without waiting on the board.
        await kanbanProvider!.open(undefined, { skipSync: true });
        kanbanProvider!.postMessage({ type: 'openMemoModal' });
    });
```

> The cold-open path still has to build the Kanban webview once (unavoidable while the memo lives inside it), but: (a) the dropped-message race is fixed so the modal reliably appears the moment the webview mounts, and (b) the warm-open path — the common case for active users given `retainContextWhenHidden` — becomes near-instant because it no longer blocks on `fullSync`.

### 3. (Optional, larger follow-up — NOT required for this fix) Extract memo into a standalone lightweight webview

If cold-open latency is still unacceptable after #1/#2, the durable fix is to give the memo its own tiny `WebviewPanel` (a few-KB HTML: one textarea + Clear/Copy/Send buttons) reusing the existing `memoLoad`/`memoSave`/`memoClear`/`memoGeneratePrompt` host handlers (`src/services/KanbanProvider.ts:6942`–`7015`) unchanged. This removes the 9,087-line `kanban.html` boot from the memo path entirely. Scoped out of this plan to keep the change low-risk; #1 + #2 deliver the bulk of the win (instant warm open, no dropped messages).

## Verification Plan

1. **Build:** `npm run compile` (webpack) — rebuilds `dist/extension.js` and `dist/webview/kanban.html`. Required because both a `.ts` host file and behavior depending on `kanban.html`'s `ready`/message flow changed.
2. **Warm open (primary win):** Open the KANBAN panel, let it finish loading, switch focus elsewhere, then press the memo hotkey (`Cmd/Ctrl+Shift+Alt+M`). The memo modal must appear effectively instantly with no board re-sync churn. Compare against current `main` (which blocks on `fullSync`).
3. **Cold open (race fix):** Fully close the Kanban panel. Press the memo hotkey once. Confirm the memo modal opens by itself as soon as the webview mounts — no second press needed, no silent no-show. Repeat several times to confirm the message is never dropped.
4. **Memo content correctness:** With existing text in `.switchboard/memo.md`, open the memo and confirm the textarea is populated and the title shows `MEMO — <WORKSPACE>` (`memoLoad` → `memoContent`, `src/services/KanbanProvider.ts:6948`–`6953`).
5. **Memo write paths unaffected:** Type (debounced save), Clear, Copy Prompt, and Send to Planner all still work (`memoSave` / `memoClear` / `memoGeneratePrompt`).
6. **Board open unaffected (regression guard):** Open the board via its normal command/button. Confirm the board still performs its full sync and renders cards — i.e. `skipSync` did NOT leak into the board-open path (only `switchboard.openMemo` passes `skipSync`).
7. **Status-bar button parity:** With `switchboard.statusBar.showMemoButton` enabled, click the status-bar memo button (`src/extension.ts:1862`–`1867`) and confirm identical fast behavior to the hotkey.
8. **No confirmation dialogs introduced** anywhere in the changed paths (project hard rule).
