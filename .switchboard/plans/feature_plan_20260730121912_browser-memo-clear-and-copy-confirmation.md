# Browser Memo Panel: Clear the Memo on Copy/Send and Confirm the Clipboard Copy

## Goal

Make the browser cockpit's Memo panel behave like the sidebar Memo tab: after **Copy Prompt** or **Send to Planner**, the textarea empties (matching the memo file the host already cleared) and the panel states plainly that the prompt is on the clipboard.

### Problem

In the browser cockpit (`http://127.0.0.1:<port>/memo`), pressing **Copy Prompt**:

- leaves the captured text sitting in the textarea, while the memo file on disk has already been emptied — so the panel and `.switchboard/memo.md` disagree until a reload silently discards what is on screen; and
- gives no acknowledgement at all: no status line, no button feedback, nothing to distinguish "prompt copied" from "click did nothing".

**Send to Planner** has the same missing clear and the same silence.

### Root cause

The host side already does the right thing; **only the delivery back to the browser is broken**, on all three channels.

1. **The file *is* cleared.** The extension arm writes `''` to the memo path and pushes an empty `memoContent` ([TaskViewerProvider.ts:12043-12047](../../src/services/TaskViewerProvider.ts#L12043-L12047)); the standalone arm writes `''` too (bootstrap.ts:966-967). So the visible symptom is a UI that never learned about a state change that already happened.

2. **The WebSocket push channel is dead for this provider.** `TaskViewerProvider.postMessage` routes through `_broadcaster.push` (TaskViewerProvider.ts:3136-3142) → `mirrorToWs` → `apiServer.broadcastWs`, which is how a push reaches browser clients (`wsHub.broadcast` fans out to every connection, wsHub.ts:276-301, and `transport.js` dispatches each as a `MessageEvent`). But the hub is constructed **lazily with `apiServer: null`**:

   ```ts
   // TaskViewerProvider.ts:326-327  (inside _initTaskViewerService)
   if (!this._broadcaster) {
       this._broadcaster = new BroadcastHub({ webview: this._view?.webview, apiServer: null });
   }
   ```

   and `setApiServer` never stores the server it was handed:

   ```ts
   // TaskViewerProvider.ts:355-357
   public setApiServer(server: any): void {
       this._broadcaster?.setApiServer(server);   // no-op when _broadcaster is undefined
   }
   ```

   `_initTaskViewerService()` is called from exactly one site — `handleServiceVerb` (TaskViewerProvider.ts:295-297), i.e. lazily on the **first HTTP verb** — which is always *after* the API server started during activation (the wiring attempt at TaskViewerProvider.ts:1966 is the same optional-chained no-op). Net effect: the hub that gets built has `apiServer: null` forever, and **no TaskViewer push ever reaches a WS/browser client in the extension host**. Every sibling provider avoids this by persisting the server and re-applying it at init — `PlanningPanelProvider.ts:137/141/150`, `KanbanProvider.ts:7086/7125`, `DesignPanelProvider.ts:107/183`, `SetupPanelProvider.ts:136`. `TaskViewerProvider` is the one that does not. `scripts/check-push-routing.js` passes because the *call site* uses the transport correctly; the ratchet cannot see missing wiring.

3. **The HTTP-response fallback channel is untyped.** `transport.js:274-280` re-dispatches the verb's response body as a `MessageEvent` precisely so request/response verbs work in the browser. The extension arm returns `{ success: sendSucceeded, message: msg }` (TaskViewerProvider.ts:12058) with **no `type`**, so `memo.js`'s `switch (msg.type)` (memo.js:18-47) matches nothing. Neither the status nor the clear arrives.

4. **The clipboard is written on the wrong machine, with no signal back.** The extension arm copies host-side via `this._seams().clipboard.writeText(prompt)` (TaskViewerProvider.ts:12036/12040) — the VS Code clipboard — and returns no `prompt` field, so `transport.js`'s browser clipboard branch (transport.js:249-253) never fires. Nothing in the browser tab acknowledges anything. The standalone arm *does* return `prompt` (bootstrap.ts:968-973) — proof the in-body contract works — but it never clears the textarea either.

So: fix the wiring (2), type the response (3), return the prompt (4), and have the panel act on it (clear + affirm).

## Metadata

- **Complexity:** 5
- **Tags:** frontend, backend, bugfix, reliability
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Mixed — one routine UI change plus one small piece of shared plumbing.**

Routine: the typed return body, the standalone parity field, and the `memo.js` handler (clear + affirmation).

Needs care:

- **The broadcaster wiring change is provider-wide, not memo-scoped.** Persisting `_apiServer` on `TaskViewerProvider` turns on WS fan-out for *every* TaskViewer push (`memoContent`, `memoError`, `openMemoTab`, status/settings pushes — 580 push sites are catalogued repo-wide, dozens of them TaskViewer's). That is the documented intent of the push-routing feature, and browser clients currently go stale on all of them, but it means a browser cockpit will start receiving pushes it has never received before. Panels ignore unknown `type`s (`switch` with no `default`), so the blast radius is bounded — but it must be verified rather than assumed.
- **Two independent delivery paths will now both fire** (WS push *and* the typed response body). The clear must be idempotent — clearing an already-empty textarea twice is a no-op, but a naive "toggle" or "append" would double-apply.
- **The clipboard write must not silently fail.** `navigator.clipboard.writeText` requires a secure context. `http://127.0.0.1` and `http://localhost` qualify; a cockpit reached over a LAN IP on plain HTTP does **not**, and the write rejects. Today that rejection is a `console.warn` (transport.js:250-252) — invisible, and after the host has already emptied the memo file. The failure path needs to be real.
- **Data loss is the risk to design against, not aesthetics.** The host clears the memo file *before* the browser knows whether the clipboard write succeeded. If it failed, the captured text must survive.

No schema/allowlist changes: `verbSchemas` validates request payloads only, and `memoGeneratePrompt` stays in `TASKVIEWER_VERBS`.

## Edge-Case & Dependency Audit

- **`memoContent`'s guard will swallow a WS-delivered clear.** `memo.js:29-32` ignores `memoContent` when the textarea is focused or `_memoDirty`. So the clear must be driven by an explicit flag on `memoPromptResult`, not by relying on the `memoContent` push.
- **Do not clear text the user typed *after* clicking.** Between the click and the response the user may keep typing — that is new capture, not the copied batch. `memo.js` must remember the exact string it submitted and clear only if the textarea still holds it; otherwise leave the newer text alone (and let the debounced save persist it).
- **Clipboard failure must re-save.** If the browser copy rejects, the memo file has already been emptied host-side. `memo.js` must show a clear failure status **and** re-issue `memoSave` with the on-screen content so nothing is lost.
- **`Send to Planner` failure must not clear.** The existing contract preserves the memo when dispatch fails and copies the prompt for manual paste (TaskViewerProvider.ts:12033-12037, 12053). `memoCleared` must therefore be `sendSucceeded`, never a hardcoded `true`.
- **`Send to Planner` is hidden in the standalone host.** `baseStandaloneCapabilities.terminalDispatch = false` (bootstrap.ts:384-391) and `transport.js:343` hides `#memo-send-btn`; the standalone arm degrades every action to copy (bootstrap.ts:964-973). So the send path only needs live verification in the extension host.
- **Double clipboard write in the extension host is expected and harmless.** After this change the host writes the VS Code clipboard *and* returns `prompt` so the browser writes the same string. Same text, same machine in the normal case. In the editor webview no `prompt` is consumed at all — the real VS Code bridge discards verb return values — so the sidebar path is untouched.
- **`protocol-catalog.json` records push sites with file *line numbers*.** Editing `TaskViewerProvider.ts` shifts them, so `npm run catalog:check` will fail until `npm run catalog:generate` is re-run and the regenerated catalog committed.
- **`scripts/verb-return-contract-baseline.json`** counts arms that don't return in the body (`TaskViewer: 1`). Adding fields to an arm that already returns leaves the count unchanged; `npm run verb-returns:check` must stay green without touching the baseline.
- **`scripts/check-push-routing.js`** allows exactly 1 raw `.webview.postMessage(` in `TaskViewerProvider.ts` (the fallback inside `postMessage`). Do not add another; route everything through `postMessage`/the broadcaster.
- **Serving dependency.** `memo.js` is served from `/static/webview/memo.js` with `Cache-Control: no-cache` (LocalApiServer.ts:818-822) — a hard reload of the cockpit tab is enough for JS, but the extension itself must be rebuilt and synced to its install folder for the TypeScript change to be live.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — persist the API server so pushes reach browser clients

Mirror the sibling providers. Add a field, store the server, and apply it when the hub is built:

```ts
    private _apiServerForBroadcast: any | null = null;   // near _broadcaster (line ~368)

    public setApiServer(server: any): void {
        // Store it: _initTaskViewerService() runs LAZILY (first HTTP verb), which is
        // AFTER the API server starts, so an optional-chained call alone is a no-op
        // and the hub is later built with apiServer:null — silently dropping every
        // TaskViewer push to browser/WS clients. Matches PlanningPanelProvider.
        this._apiServerForBroadcast = server ?? null;
        this._broadcaster?.setApiServer(server);
    }
```

and in `_initTaskViewerService()` (lines 318-331):

```ts
        if (!this._broadcaster) {
            this._broadcaster = new BroadcastHub({
                webview: this._view?.webview,
                apiServer: this._apiServerForBroadcast ?? this._localApiServer ?? null,
            });
        } else {
            this._broadcaster.setWebview(this._view?.webview);
        }
        this._broadcaster.setApiServer(this._apiServerForBroadcast ?? this._localApiServer ?? null);
```

Line 1966 (`this._broadcaster?.setApiServer(this._localApiServer)`) becomes redundant but harmless — keep it, and let it also set the stored field by routing it through `this.setApiServer(this._localApiServer)`.

### 2. `src/services/TaskViewerProvider.ts` — type the `memoGeneratePrompt` response and return the prompt

Replace the return at the end of the `case 'memoGeneratePrompt'` arm (lines 12049-12058):

```ts
                        const msg = sendSucceeded
                            ? (action === 'send'
                                ? `Sent ${issues.length} issue(s) to planner. Memo cleared.`
                                : `Prompt for ${issues.length} issue(s) copied to clipboard. Memo cleared.`)
                            : `Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry.`;
                        this.postMessage({ type: 'memoPromptResult', message: msg, memoCleared: sendSucceeded, isError: !sendSucceeded });
                        // TYPED body: in the browser the HTTP response IS the push
                        // (transport.js re-dispatches it), and `prompt` is what makes
                        // transport.js write the BROWSER clipboard — the host-side
                        // vscode clipboard write above is a different clipboard when
                        // the cockpit is not the editor.
                        return {
                            success: sendSucceeded,
                            type: 'memoPromptResult',
                            message: msg,
                            memoCleared: sendSucceeded,
                            isError: !sendSucceeded,
                            prompt,
                        };
```

`prompt` is returned for both branches: the copy action owns the clipboard, and the send-failure branch already copies as its documented fallback.

### 3. `src/standalone/bootstrap.ts` — parity flag on the standalone arm

In the `memoGeneratePrompt` return (lines 968-973), add `memoCleared: true` (the standalone arm always clears, since it always degrades to copy):

```ts
            return {
                success: true,
                type: 'memoPromptResult',
                message: `Prompt for ${issues.length} issue(s) copied to clipboard. Memo cleared.`,
                memoCleared: true,
                prompt,
            };
```

### 4. `src/webview/transport.js` — make a clipboard failure visible

Replace the swallow at lines 249-253:

```js
                    if (result && result.prompt && navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(result.prompt).catch(function (err) {
                            console.warn('[transport] Clipboard write failed:', err);
                            // The panel owns recovery: the host may already have consumed
                            // (and cleared) the source content on the strength of a copy
                            // that never landed. Not a secure context (LAN IP over plain
                            // http) is the common cause.
                            dispatchMessage({ type: 'clipboardWriteFailed', verb: verb, text: result.prompt });
                        });
                    } else if (result && result.prompt) {
                        dispatchMessage({ type: 'clipboardWriteFailed', verb: verb, text: result.prompt });
                    }
```

### 5. `src/webview/memo.js` — clear on success, affirm the copy, recover on failure

Track the submitted content in the two action handlers (lines 81-98):

```js
    let _submittedContent = null;
    // in both the copy and send click handlers, before postMessage:
    _submittedContent = document.getElementById('memo-textarea')?.value || '';
```

Extend the `memoPromptResult` case (lines 37-41):

```js
            case 'memoPromptResult': {
                const statusEl = document.getElementById('memo-status');
                if (statusEl) {
                    statusEl.textContent = msg.message || '';
                    statusEl.style.color = msg.isError ? 'var(--accent-red, #f85149)' : 'var(--text-secondary)';
                }
                if (msg.memoCleared) {
                    const textarea = document.getElementById('memo-textarea');
                    // Only clear what we submitted: the user may have kept typing
                    // between the click and this reply — that text is new capture.
                    if (textarea && (_submittedContent === null || textarea.value === _submittedContent)) {
                        textarea.value = '';
                        if (_memoSaveTimer) clearTimeout(_memoSaveTimer);
                        _memoDirty = false;
                    }
                }
                if (!msg.isError) { _flashCopied(); }
                _submittedContent = null;
                break;
            }
            case 'clipboardWriteFailed': {
                const statusEl = document.getElementById('memo-status');
                if (statusEl) {
                    statusEl.textContent = 'Copy failed — memo kept on screen. Select the text and copy manually.';
                    statusEl.style.color = 'var(--accent-red, #f85149)';
                }
                // The host already emptied the memo file for a copy that never
                // landed. Put the content back so nothing is lost.
                const textarea = document.getElementById('memo-textarea');
                const restore = (textarea && textarea.value) || _submittedContent || msg.text || '';
                if (textarea && !textarea.value && restore) { textarea.value = restore; }
                if (restore) {
                    vscode.postMessage({ type: 'memoSave', content: restore, workspaceRoot: WS_ROOT });
                }
                if (textarea) { textarea.focus(); textarea.select(); }
                break;
            }
```

Add the button affirmation (the "no indication it copied" half of the report) — an immediate, local signal that does not wait on the round trip is what makes the click feel acknowledged:

```js
    function _flashCopied() {
        const btn = document.getElementById('memo-copy-btn');
        if (!btn || btn.dataset.flashing === '1') return;
        const original = btn.textContent;
        btn.dataset.flashing = '1';
        btn.textContent = 'Copied ✓';
        btn.classList.add('is-copied');
        setTimeout(() => {
            btn.textContent = original;
            btn.classList.remove('is-copied');
            btn.dataset.flashing = '0';
        }, 1600);
    }
```

Also set an immediate in-flight status on click so a slow response is never mistaken for a dead button:

```js
        // in the copy handler, right after postMessage:
        const statusEl = document.getElementById('memo-status');
        if (statusEl) { statusEl.textContent = 'Building prompt…'; statusEl.style.color = 'var(--text-secondary)'; }
```

### 6. `src/webview/memo.html` — style the affirmation state

Add a rule for the flash class alongside the existing button styles:

```css
        .is-copied {
            color: var(--accent-green, #4ec9b0) !important;
            border-color: var(--accent-green, #4ec9b0) !important;
        }
```

### 7. `src/test/memo-browser-clear-and-copy-contract.test.js` — new contract test

```js
'use strict';
/**
 * Contract: the browser Memo panel's copy/send round trip clears the panel and
 * confirms the clipboard.
 *
 * The regression this locks down: the memo file was emptied host-side while the
 * browser panel kept the text and said nothing, because (a) the response body
 * carried no `type` for transport.js to route, (b) no `prompt` for the browser
 * clipboard, and (c) TaskViewerProvider's BroadcastHub was built with
 * apiServer:null so its pushes never reached a WS client.
 */
const assert = require('assert');

// (a)+(b): the arm's returned body is routable and carries the prompt.
const result = await taskViewer.handleServiceVerb('memoGeneratePrompt',
    { content: 'Bug: one\n\nBug: two', action: 'copy', workspaceRoot: tmpWs });
assert.strictEqual(result.type, 'memoPromptResult');
assert.strictEqual(result.memoCleared, true);
assert.ok(typeof result.prompt === 'string' && result.prompt.includes('Issue 1'));
assert.match(result.message, /copied to clipboard/i);
assert.strictEqual(fs.readFileSync(memoPath, 'utf8'), '');   // file really cleared

// Send failure preserves the memo and says so.
seams.dispatchResult = false;
const failed = await taskViewer.handleServiceVerb('memoGeneratePrompt',
    { content: 'Bug: one', action: 'send', workspaceRoot: tmpWs });
assert.strictEqual(failed.memoCleared, false);
assert.strictEqual(failed.isError, true);
assert.notStrictEqual(fs.readFileSync(memoPath, 'utf8'), '');

// (c): setApiServer before the hub exists still wires WS fan-out.
const fresh = makeTaskViewerProvider();          // _broadcaster undefined
fresh.setApiServer(fakeApiServer);               // stored, not dropped
await fresh.handleServiceVerb('memoLoad', { workspaceRoot: tmpWs });  // builds the hub
assert.ok(fakeApiServer.broadcasts.some(b => b.verb === 'memoContent'),
    'TaskViewer push did not reach the WS hub — broadcaster built with apiServer:null');

// memo.js handles both new message types and guards the clear.
const memoJs = fs.readFileSync('src/webview/memo.js', 'utf8');
assert.match(memoJs, /clipboardWriteFailed/);
assert.match(memoJs, /memoCleared/);
assert.match(memoJs, /_submittedContent/);
// transport.js reports clipboard failure instead of only warning.
assert.match(fs.readFileSync('src/webview/transport.js', 'utf8'), /clipboardWriteFailed/);
```

Build the provider with the existing headless harness (`src/test/helpers/verbEngineTestSeams.js`, used by `verb-engine-headless-seams.test.js`) so the clipboard and dispatch seams are fakes.

### 8. `package.json` — register the test

```json
    "test:contract:memo-browser-clear": "node src/test/memo-browser-clear-and-copy-contract.test.js",
```

## Verification Plan

**Automated**

1. `npm run compile-tests && npm run compile`.
2. `npm run test:contract:memo-browser-clear` — passes. Then revert the `type: 'memoPromptResult'` field in the returned body, rebuild, and confirm it **fails** (the untyped-body assertion is the one that maps to the report).
3. `npm run verb-returns:check` — green with `scripts/verb-return-contract-baseline.json` unchanged.
4. `npm run push-routing:check` — green; `TaskViewerProvider.ts` still has exactly one raw `.webview.postMessage(`.
5. `npm run catalog:check`; if it reports drift (push-site line numbers moved), run `npm run catalog:generate` and commit the regenerated `protocol-catalog.json`.
6. `npm run test:contract:verb-engine` and `npm run test:contract:shim-injection` — green.
7. `npm run lint`.

**Manual — extension host, Copy Prompt (the reported case)**

8. Rebuild, sync to the installed extension folder, reload the window. Read `.switchboard/api-server-port.txt`, open `http://127.0.0.1:<port>/`, select Memo.
9. Type three issues separated by blank lines. Press **Copy Prompt**. Expect, in order: status `Building prompt…`, the button flashing `Copied ✓` in green, the textarea emptying, and the status settling on `Prompt for 3 issue(s) copied to clipboard. Memo cleared.`
10. Paste into an editor — the full planner prompt with `### Issue 1/2/3` is on the clipboard.
11. `cat .switchboard/memo.md` — empty. Reload the panel — still empty, and the panel no longer disagrees with disk.

**Manual — extension host, Send to Planner**

12. With a planner terminal registered, capture two issues and press **Send to Planner**: the prompt lands in the planner terminal, the textarea empties, status reads `Sent 2 issue(s) to planner. Memo cleared.`
13. With **no** planner terminal registered: the textarea keeps its text, the status is the red `Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry.`, and `.switchboard/memo.md` still holds the entries.

**Manual — two surfaces in sync (the wiring fix)**

14. Open the sidebar Memo tab in VS Code *and* the browser Memo panel at the same time. Press **Copy Prompt** in the browser: the sidebar textarea clears too (the WS push now lands). Press **Clear** in the sidebar: the browser panel follows.
15. Watch the browser devtools console during a board interaction: TaskViewer pushes now arrive over the WS; no panel throws on a message type it does not handle.

**Manual — standalone host**

16. Run the standalone bootstrap (`npx`), open `/memo`: `Send to Planner` is hidden; `Copy Prompt` clears the textarea, flashes `Copied ✓`, and the clipboard holds the prompt.

**Manual — clipboard failure path**

17. Open the cockpit over a non-secure origin (the machine's LAN IP over plain `http`) so `navigator.clipboard` is unavailable, and press **Copy Prompt**: the status reads the red `Copy failed — memo kept on screen…`, the text is still in the textarea and selected, and `.switchboard/memo.md` has been re-saved with that content (`cat` it) rather than left empty.
