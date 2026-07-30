# Browser Memo Panel: Clear the Memo on Copy/Send and Confirm the Clipboard Copy

## Goal

Make the browser cockpit's Memo panel behave like the sidebar Memo tab: after **Copy Prompt** or **Send to Planner**, the textarea empties (matching the memo file the host already cleared) and the panel states plainly that the prompt is on the clipboard.

"Confirm" here means **acknowledge**, not perform. The clipboard write already works — the extension host writes the system clipboard itself, verified in use. The defect is that the browser panel is never told the action completed, so it neither clears nor says anything.

### Problem

In the browser cockpit (`http://127.0.0.1:<port>/memo`), pressing **Copy Prompt**:

- leaves the captured text sitting in the textarea, while the memo file on disk has already been emptied — so the panel and `.switchboard/memo.md` disagree until a reload silently discards what is on screen; and
- gives no acknowledgement at all: no status line, no button feedback, nothing to distinguish "prompt copied" from "click did nothing".

**Send to Planner** has the same missing clear and the same silence.

### Root cause

The host side already does the right thing; **only the notification back to the browser is broken**.

1. **The file *is* cleared.** The extension arm writes `''` to the memo path and pushes an empty `memoContent` ([TaskViewerProvider.ts:12043-12047](../../src/services/TaskViewerProvider.ts#L12043-L12047)); the standalone arm writes `''` too (bootstrap.ts:966-967). So the visible symptom is a UI that never learned about a state change that already happened.

2. **The HTTP-response channel is untyped.** `transport.js:274-280` re-dispatches the verb's response body as a `MessageEvent` precisely so request/response verbs work in the browser. The extension arm returns `{ success: sendSucceeded, message: msg }` (TaskViewerProvider.ts:12058) with **no `type`**, so `memo.js`'s `switch (msg.type)` (memo.js:18-47) matches nothing. Neither the status nor a clear arrives. This is the direct cause of the reported symptom.

3. **`memo.js` has no clear logic at all.** Even a perfectly-routed message would not empty the textarea: the `memoPromptResult` case (memo.js:37-41) sets `#memo-status`'s text and nothing else. The sidebar gets its clear from a different channel entirely — the `memoContent: ''` push, handled by `implementation.html`'s own memo JS — which is why the two surfaces diverge.

4. **The WebSocket push channel is dead for this provider**, so the sidebar's mechanism cannot reach the browser either. `TaskViewerProvider.postMessage` routes through `_broadcaster.push` (TaskViewerProvider.ts:3136-3142) → `mirrorToWs` → `apiServer.broadcastWs`, which is how a push reaches browser clients. But the hub is constructed **lazily with `apiServer: null`**:

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

   `_initTaskViewerService()` is called from exactly one site — `handleServiceVerb` (TaskViewerProvider.ts:295-297), i.e. lazily on the **first HTTP verb** — which is always *after* the API server started during activation (the wiring attempt at TaskViewerProvider.ts:1966 is the same optional-chained no-op). Net effect: the hub that gets built has `apiServer: null` forever, and **no TaskViewer push ever reaches a WS/browser client in the extension host**. `BroadcastHub.mirrorToWs` is guarded by `if (this._target.apiServer)` (broadcastHub.ts:88-93), so the drop is silent. Every sibling provider avoids this by persisting the server and re-applying it at init — `PlanningPanelProvider.ts:137/141/150`, `KanbanProvider.ts:7086/7125`, `DesignPanelProvider.ts:107/183`, `SetupPanelProvider.ts:136`. `TaskViewerProvider` is the one that does not. `scripts/check-push-routing.js` passes because the *call site* uses the transport correctly; the ratchet cannot see missing wiring.

> **Superseded:** "The clipboard is written on the wrong machine, with no signal back. The extension arm copies host-side via `this._seams().clipboard.writeText(prompt)` (TaskViewerProvider.ts:12036/12040) — the VS Code clipboard — and returns no `prompt` field, so `transport.js`'s browser clipboard branch (transport.js:249-253) never fires."
> **Reason:** the premise is wrong, confirmed both in use and by research. In the extension host the cockpit and VS Code run on the **same machine**, so the VS Code clipboard *is* the system clipboard — the host-side `writeText` already puts the prompt where the user pastes from, and Copy Prompt's clipboard behaviour is not broken. Returning `prompt` in the body to trigger a second, browser-side write would be redundant on the working path and actively worse on others: WebKit rejects `navigator.clipboard.writeText()` called after a `fetch()` boundary with `NotAllowedError` (it enforces a call-stack user-gesture requirement, unlike Chromium/Gecko which keep transient activation alive for ~5s across promise ticks), so a Safari cockpit would start reporting copy failures for an operation that had already succeeded host-side.
> **Replaced with:** the extension arm does **not** return `prompt` and `transport.js` is not touched. Only the *notification* is fixed — the response body gains a `type` so it routes, and a `memoCleared` flag so the panel knows to empty the textarea. The entire clipboard-failure recovery path (a `clipboardWriteFailed` message, a `_lastClearedContent` restore buffer, a recovery `memoSave`) is removed with it: it existed only to protect against a browser-side write this plan no longer performs.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, backend, bugfix, reliability
- **Project:** Browser Switchboard

## User Review Required

1. **The broadcaster wiring is no longer required to fix the reported symptom.** Change 2 (typing the response) fixes the clear on its own. The wiring in change 1 is kept because it brings `TaskViewerProvider` in line with all four sibling providers, makes the sidebar and the browser panel agree (press Clear in one, the other follows), and is a hard prerequisite for subtask 3's workspace-switch handling. If you would rather ship the minimal fix first, change 1 can move to subtask 3 — say so and I will move it.
2. **Standalone host clipboard is unchanged and carries a known WebKit limitation.** The `npx` host has no VS Code clipboard, so it must return `prompt` and let `transport.js` write the browser clipboard — which it already does today (bootstrap.ts:968-973). Per the research, that write happens after a `fetch()` boundary and will therefore fail in Safari with `NotAllowedError`. This is pre-existing behaviour on a path nobody has reported broken; the remedy (build a `ClipboardItem` with an unresolved promise and call `navigator.clipboard.write()` synchronously in the click handler) is recorded in Edge Cases for a future plan rather than built here.

## Complexity Audit

### Routine

- Typing the response body (`type`, `memoCleared`, `isError`, `action`, `error`) — additive fields on an arm that already returns.
- The standalone parity field (`memoCleared`).
- The `memo.js` handler work: clear-on-flag, the affirmation flash, the in-flight status.
- The `.is-copied` CSS rule.

### Complex / Risky

- **The broadcaster wiring change is provider-wide, not memo-scoped.** Persisting `_apiServer` on `TaskViewerProvider` turns on WS fan-out for *every* TaskViewer push (`memoContent`, `memoError`, `openMemoTab`, `workspaceChanged`, status/settings pushes — 580 push sites are catalogued repo-wide, dozens of them TaskViewer's). That is the documented intent of the push-routing feature, and browser clients currently go stale on all of them, but it means a browser cockpit will start receiving pushes it has never received before. Panels ignore unknown `type`s (`switch` with no `default`), so the blast radius is bounded — but it must be verified rather than assumed.
- **Two independent delivery paths will now both fire** (the WS `memoContent: ''` push *and* the typed response body). The clear must be idempotent — clearing an already-empty textarea twice is a no-op, but the guard must treat "already empty" as success rather than as a mismatch, or the second path silently cancels the first.
- **The clear must not be routed through `memoContent`.** It is tempting to let change 1 alone fix this — with the WS wired, the sidebar's own mechanism (`memoContent: ''`) would reach the browser. But `memo.js:29-32` ignores `memoContent` while the textarea is focused, and clicking a `<button>` does **not** move focus off the textarea in WebKit. That would leave the original bug intact in Safari and fixed in Chrome — the worst possible outcome to debug. The explicit `memoCleared` flag on the addressed reply is the deterministic path.
- **Do not clear text the user typed after clicking.** Between the click and the response the user may keep typing — that is new capture, not the copied batch.

No schema/allowlist changes: `verbSchemas.memoGeneratePrompt` validates request payloads only (verbSchemas.ts:1426-1432) and `memoGeneratePrompt` stays in `TASKVIEWER_VERBS`.

## Edge-Case & Dependency Audit

### Race Conditions

- **`memoContent`'s guard will swallow a WS-delivered clear.** `memo.js:29-32` ignores `memoContent` when the textarea is focused or `_memoDirty`. So the clear must be driven by an explicit flag on `memoPromptResult`, not by relying on the `memoContent` push.
- **`memoContent: ''` may arrive before the HTTP body.** Once change 1 lands, the success path pushes `memoContent: ''` (TaskViewerProvider.ts:12046) *and* returns the typed body, with no ordering guarantee between them. If the push lands first and the textarea is unfocused and clean, it clears the textarea; the later `memoCleared` branch then finds `textarea.value !== _submittedContent`. The guard must therefore accept an empty textarea as already-satisfied, or the two correct paths combine into a no-op.
- **Do not clear text the user typed *after* clicking.** `memo.js` must remember the exact string it submitted and clear only if the textarea still holds it (or is already empty); otherwise leave the newer text alone and let the debounced save persist it.

### Security

- No new network surface, no new verb, no schema change, no new response field carrying content. `prompt` is deliberately **not** returned to the browser (see the superseded callout), so the generated prompt never crosses the HTTP boundary in the extension host — a small reduction in exposure relative to the original design.
- `transport.js` is not modified, so no change to the generic transport behaviour of any other panel.

### Side Effects

- **`Send to Planner` failure must not clear.** The existing contract preserves the memo when dispatch fails and copies the prompt for manual paste (TaskViewerProvider.ts:12033-12037, 12053). `memoCleared` must therefore be `sendSucceeded`, never a hardcoded `true`. Because the host still copies host-side on that branch, the failure message's promise ("Prompt copied to clipboard") remains true.
- **The failure body now raises a transport toast as well as the panel status.** `STATUS_MESSAGE_PANELS = { kanban: true }` (transport.js:200), so for the memo panel a `success: false` body calls `showTransportError(result.error || 'Action failed: ' + verb)` (transport.js:255-261) and *then* falls through to `dispatchMessage` because the body is typed. Without an `error` field the floating toast would read the useless `Action failed: memoGeneratePrompt` while the panel's own status line reads the real message. Change 2 adds `error: msg` so both surfaces say the same true thing.
- **`Send to Planner` is hidden in the standalone host.** `baseStandaloneCapabilities.terminalDispatch = false` (bootstrap.ts:384-391) and `transport.js:343` hides `#memo-send-btn`; the standalone arm degrades every action to copy (bootstrap.ts:964-973). So the send path only needs live verification in the extension host.
- **Standalone clipboard, WebKit.** The `npx` host has no VS Code clipboard seam, so it returns `prompt` and `transport.js:249-253` writes the browser clipboard — after a `fetch()` boundary. Per the research this succeeds in Chromium and Gecko (transient user activation survives promise ticks for ~5s) and **fails in WebKit/Safari** with `NotAllowedError`, because WebKit requires the clipboard call to be on the user-gesture call stack. Pre-existing, out of scope here. The remedy for a future plan: in the click handler, build `new ClipboardItem({ 'text/plain': fetchPromise.then(t => new Blob([t], {type:'text/plain'})) })` and call `navigator.clipboard.write([item])` **synchronously**, so WebKit holds the write open while the round trip resolves.
- **In the editor webview nothing changes.** The real VS Code bridge discards verb return values, so the sidebar path is driven entirely by the existing pushes and is untouched by the new response fields.

### Dependencies & Conflicts

- **Subtask 1 must land first.** This plan adds `.is-copied` to `src/webview/memo.html` and uses `var(--accent-green)` / `var(--accent-red)` — both defined by *Restyle the Browser Memo Panel to Switchboard's Panel Design Language*, which also rewrites this file's markup wholesale. Editing `memo.html` before that lands guarantees a conflict.
- **Subtask 3 depends on change 1.** *Browser Memo Panel Writes to the Wrong Workspace* adds a `workspaceChanged` handler to `memo.js` that can only ever receive that message over the WS fan-out change 1 switches on. That is now the **only** dependency subtask 3 has on this plan — it no longer needs a `prompt` field in the response body (it asserts on the clipboard seam recorder instead).
- **Same file as subtask 3, twice.** Both edit `src/services/TaskViewerProvider.ts` (this plan the arm's return, subtask 3 the same arm's project resolution) and `src/webview/memo.js`. Per the project PRD's orchestration discipline — one agent stream per provider file — these serialise. Subtask 3 owns the `WS_ROOT` → `_wsRoot` conversion in `memo.js`; this plan adds no `workspaceRoot` payload site, so there is no contention over it.
- **`protocol-catalog.json` records push sites with file *line numbers*.** Editing `TaskViewerProvider.ts` shifts them, so `npm run catalog:check` will fail until `npm run catalog:generate` is re-run and the regenerated catalog committed.
- **`scripts/verb-return-contract-baseline.json`** counts arms that don't return in the body (`TaskViewer: 1`). Adding fields to an arm that already returns leaves the count unchanged; `npm run verb-returns:check` must stay green without touching the baseline.
- **`scripts/check-push-routing.js`** allows exactly 1 raw `.webview.postMessage(` in `TaskViewerProvider.ts` (the fallback inside `postMessage`). Do not add another; route everything through `postMessage`/the broadcaster.
- **Serving dependency.** `memo.js` is served from `/static/webview/memo.js` with `Cache-Control: no-cache` (LocalApiServer.ts:818-822) — a hard reload of the cockpit tab is enough for JS, but the extension itself must be rebuilt and synced to its install folder for the TypeScript change to be live.

## Dependencies

- None — no prior agent session output is required.
- **Intra-feature ordering:** subtask 2 of 3 in *Browser Memo Panel*. Lands after subtask 1 (shares `memo.html`) and before subtask 3 (which needs change 1's WS fan-out wiring).

## Adversarial Synthesis

**Risk summary.** With the clipboard path out of scope this is a small, well-bounded change, and the two remaining risks are both about *paths combining* rather than about any single edit. First, the clear now has two possible arrivals — the WS `memoContent: ''` push and the typed response body — with no ordering guarantee, so a guard that demands the textarea still hold the submitted text turns two correct signals into a silent no-op; it must accept "already empty" as satisfied. Second, the temptation to drop change 2 and let the WS wiring alone deliver the clear would fix Chrome and leave Safari broken, because `memo.js` ignores `memoContent` while the textarea is focused and WebKit does not move focus to a clicked button. Mitigations: keep the explicit `memoCleared` flag as the deterministic path, make the clear idempotent, and keep `memoCleared` mirroring `sendSucceeded` so a failed dispatch never discards the memo.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — persist the API server so pushes reach browser clients

**Context.** `_initTaskViewerService()` runs lazily on the first HTTP verb, which is always after `_startLocalApiServer()` has already called `setApiServer`. Because `setApiServer` only forwards to a possibly-undefined `_broadcaster`, the server reference is discarded and the hub is later built with `apiServer: null`.

**Logic.** Mirror the sibling providers: store the server in a field, and apply it whenever the hub is built or rebound.

**Implementation.**

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

**Edge cases.** Line 1966 (`this._broadcaster?.setApiServer(this._localApiServer)`) becomes redundant but harmless — keep it, and route it through `this.setApiServer(this._localApiServer)` so it also populates the stored field. `initHeadlessVerbServing` (TaskViewerProvider.ts:363-369) assigns `_broadcaster` directly from the standalone host, which supplies its own already-wired hub; leave that path alone. This change is **not** what fixes the reported clear (change 2 is) — it is sibling-provider parity, two-surface sync, and subtask 3's prerequisite.

### 2. `src/services/TaskViewerProvider.ts` — type the `memoGeneratePrompt` response

**Context.** The arm ends with `return { success: sendSucceeded, message: msg }` (line 12058) — no `type` for `transport.js` to route, no flag telling the panel the memo was cleared, no `error` for the failure surface.

**Logic.** Return a body that is routable, states whether the memo was cleared, names the action that produced it, and satisfies the return-in-body contract on the failure branch.

**Implementation.** Replace the return at the end of the `case 'memoGeneratePrompt'` arm (lines 12049-12058):

```ts
                        const msg = sendSucceeded
                            ? (action === 'send'
                                ? `Sent ${issues.length} issue(s) to planner. Memo cleared.`
                                : `Prompt for ${issues.length} issue(s) copied to clipboard. Memo cleared.`)
                            : `Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry.`;
                        this.postMessage({ type: 'memoPromptResult', message: msg, memoCleared: sendSucceeded, isError: !sendSucceeded, action });
                        // TYPED body: in the browser the HTTP response IS the push
                        // (transport.js re-dispatches it as a MessageEvent), and without
                        // a `type` memo.js's switch matches nothing — the panel never
                        // learns the memo file was emptied. `prompt` is deliberately NOT
                        // returned: the host already wrote the system clipboard via the
                        // clipboard seam, and a second browser-side write would be
                        // redundant here and rejected by WebKit after the fetch boundary.
                        return {
                            success: sendSucceeded,
                            type: 'memoPromptResult',
                            message: msg,
                            memoCleared: sendSucceeded,
                            isError: !sendSucceeded,
                            action,
                            // Contract #4: a failure body carries `error`. It is also what
                            // transport.js puts in its toast — without it the toast reads
                            // the useless "Action failed: memoGeneratePrompt" while the
                            // panel's own status line reads the real message.
                            ...(sendSucceeded ? {} : { error: msg }),
                        };
```

> **Superseded:** the returned body included `prompt` and, on the failure branch, omitted `error`.
> **Reason:** two separate problems. (a) `prompt` was there to make `transport.js` write the browser clipboard — unnecessary in the extension host (the host-side seam write already reaches the same system clipboard, confirmed in use) and harmful in WebKit, which rejects a clipboard write issued after a `fetch()` boundary. (b) The project PRD's return-in-body contract (#4) requires failure branches to return `{success:false, error}`, and `transport.js:255-260` builds its toast from `result.error || ('Action failed: ' + verb)` with `memo` absent from `STATUS_MESSAGE_PANELS` — so a send failure would raise a toast reading `Action failed: memoGeneratePrompt` over the panel's correct red status line.
> **Replaced with:** the body above — no `prompt`, and `...(sendSucceeded ? {} : { error: msg })` so the toast and the status line agree. `action` is added so the panel can flash the button that was actually pressed (change 5c).

**Edge cases.** `verb-returns:check` counts arms that fail to return, so adding fields leaves the ratchet baseline untouched. The host-side `clipboard.writeText` calls at lines 12036/12040 are unchanged — they are what actually puts the prompt on the clipboard.

### 2a. `src/services/TaskViewerProvider.ts` — type the empty-memo early return

**Context.** Lines 12016-12022 return `{ success: false, message: 'No entries to process.' }` — untyped, so `transport.js` shows a generic toast and `return`s before `dispatchMessage`, and `#memo-status` never updates. Same defect as the main report, same arm.

**Logic.** Make it routable and stop calling a no-op a failure. An empty memo is not a system error, and reporting `success: false` would raise a redundant toast over the panel's own status line.

**Implementation.**

```ts
                        if (issues.length === 0) {
                            this.postMessage({ type: 'memoPromptResult', message: 'No entries to process.', memoCleared: false });
                            // TYPED and success:true — an empty memo is a no-op, not a
                            // failure. An untyped body makes transport.js return before
                            // dispatchMessage, so the panel never showed this at all.
                            // Matches the standalone arm (bootstrap.ts:959-961).
                            return { success: true, type: 'memoPromptResult', message: 'No entries to process.', memoCleared: false };
                        }
```

**Edge cases.** This changes `success` from `false` to `true` for this branch. Nothing keys off it: the sidebar webview discards verb return values, and no test asserts on it (`grep -rn "No entries to process" src/test` returns nothing). It brings the two hosts into agreement, which is the point.

### 3. `src/standalone/bootstrap.ts` — parity flags on the standalone arm

**Context.** The standalone arm already returns `type` and `prompt` (bootstrap.ts:968-973) — and it *must* keep `prompt`, because this host has no VS Code clipboard and the browser write is the only clipboard it has. It has no `memoCleared`, so the panel cannot tell a clear from a no-op.

**Implementation.** In the `memoGeneratePrompt` return (lines 968-973), add `memoCleared: true` and `action: 'copy'`:

```ts
            return {
                success: true,
                type: 'memoPromptResult',
                message: `Prompt for ${issues.length} issue(s) copied to clipboard. Memo cleared.`,
                memoCleared: true,
                action: 'copy',
                prompt,   // KEEP: no VS Code clipboard here — transport.js is the only writer
            };
```

**Edge cases.** `action: 'copy'` is hardcoded because this host has no planner terminal — `transport.js:343` hides `#memo-send-btn` entirely, and the arm degrades a `send` payload to a copy. Add `memoCleared: false` to the empty-memo return at bootstrap.ts:959-961 for field parity. The WebKit clipboard limitation on this path is documented in Edge Cases and deliberately not addressed here.

### 4. `src/webview/memo.js` — clear on the flag, affirm the click

**Context.** `memo.js` is a single IIFE with its state (`_memoDirty`, `_memoSaveTimer`) declared after the message listener that reads it — legal because the listener runs asynchronously. Follow the same shape but declare new state near the top so the clear invariant is readable in one place.

#### 4a. Track what was submitted, and which button

```js
    // What we sent with the most recent memoGeneratePrompt — guards the clear so
    // text the user typed AFTER clicking is never discarded.
    let _submittedContent = null;
    // Which button to flash — 'copy' or 'send'.
    let _submittedAction = null;
```

In both the copy and send click handlers, before `postMessage`:

```js
        _submittedContent = document.getElementById('memo-textarea')?.value || '';
        _submittedAction = 'copy';   // 'send' in the send handler
```

#### 4b. Handle the typed result

Extend the `memoPromptResult` case (lines 37-41):

```js
            case 'memoPromptResult': {
                const statusEl = document.getElementById('memo-status');
                if (statusEl) {
                    statusEl.textContent = msg.message || '';
                    statusEl.style.color = msg.isError ? 'var(--accent-red)' : 'var(--text-secondary)';
                }
                if (msg.memoCleared) {
                    const textarea = document.getElementById('memo-textarea');
                    // Only clear what we submitted: the user may have kept typing
                    // between the click and this reply — that text is new capture.
                    // An already-empty textarea (the memoContent:'' WS push beat us
                    // here) is success, not a mismatch — both paths are correct and
                    // the guard must not turn the pair into a no-op.
                    if (textarea && (_submittedContent === null || textarea.value === _submittedContent || textarea.value === '')) {
                        textarea.value = '';
                        if (_memoSaveTimer) { clearTimeout(_memoSaveTimer); _memoSaveTimer = null; }
                        _memoDirty = false;
                    }
                }
                if (!msg.isError) { _flashAction(msg.action || _submittedAction); }
                _submittedContent = null;
                break;
            }
```

#### 4c. Affirm the click

**Logic.** An immediate, local signal is what makes the click feel acknowledged — the "no indication it copied" half of the report. Flash the button that was actually pressed.

```js
    function _flashAction(action) {
        const isSend = action === 'send';
        const btn = document.getElementById(isSend ? 'memo-send-btn' : 'memo-copy-btn');
        if (!btn || btn.dataset.flashing === '1') return;
        const original = btn.textContent;
        btn.dataset.flashing = '1';
        btn.textContent = isSend ? 'Sent ✓' : 'Copied ✓';
        btn.classList.add('is-copied');
        setTimeout(() => {
            btn.textContent = original;
            btn.classList.remove('is-copied');
            btn.dataset.flashing = '0';
        }, 1600);
    }
```

> **Superseded:** `_flashCopied()`, which always flashed `#memo-copy-btn` with the text `Copied ✓`, called as `if (!msg.isError) { _flashCopied(); }`.
> **Reason:** it fires on a successful **Send to Planner** too, so pressing *Send to Planner* flashed `Copied ✓` on the *Copy Prompt* button — feedback on a control the user did not touch, describing something that did not happen (a successful send deliberately does **not** copy, TaskViewerProvider.ts:12029-12031).
> **Replaced with:** `_flashAction(action)`, driven by the `action` field now returned in the response body (change 2), falling back to the locally-recorded `_submittedAction`.

Also set an immediate in-flight status on click so a slow response is never mistaken for a dead button:

```js
        // in both the copy and send handlers, right after postMessage:
        const statusEl = document.getElementById('memo-status');
        if (statusEl) { statusEl.textContent = 'Building prompt…'; statusEl.style.color = 'var(--text-secondary)'; }
```

> **Superseded:** a `clipboardWriteFailed` case in `memo.js`, a `_lastClearedContent` restore buffer, a recovery `memoSave`, and a corresponding change to `src/webview/transport.js` that dispatched `clipboardWriteFailed` on a rejected browser clipboard write.
> **Reason:** all of it existed to protect against a browser-side clipboard write that change 2 no longer performs. With `prompt` absent from the extension host's response body, `transport.js`'s clipboard branch never fires for this panel, there is no rejection to catch, and there is nothing to restore — the memo file is only ever emptied after a clipboard write that already succeeded host-side. Keeping the machinery would have meant maintaining a recovery path for an impossible failure, and `transport.js` is a shared file touched by every panel.
> **Replaced with:** nothing. `transport.js` is not modified by this plan.

### 5. `src/webview/memo.html` — style the affirmation state

**Context.** Subtask 1 defines `--accent-green: #4ec9b0` on `:root`, so this rule needs no literal fallback.

```css
        .is-copied {
            color: var(--accent-green) !important;
            border-color: var(--accent-green) !important;
        }
```

> **Superseded:** `var(--accent-green, #4ec9b0)` here, and `var(--accent-red, #f85149)` in the `memo.js` status colours.
> **Reason:** the literal fallbacks were needed only because subtask 1's token block omitted the two tokens. Subtask 1 now declares both on `:root` (values from `setup.html:29-30`), so a hardcoded hex here would re-introduce exactly the private-palette divergence subtask 1 removes.
> **Replaced with:** bare `var(--accent-green)` / `var(--accent-red)`.

**Edge cases.** `!important` is required to beat `.secondary-btn.is-teal`'s own `color` / `border-color`.

### 6. `src/test/memo-browser-clear-and-copy-contract.test.js` — new contract test

```js
'use strict';
/**
 * Contract: the browser Memo panel's copy/send round trip clears the panel and
 * says so.
 *
 * The regression this locks down: the memo file was emptied host-side while the
 * browser panel kept the text and said nothing, because the response body
 * carried no `type` for transport.js to route and memo.js had no clear logic.
 * The clipboard itself was never broken — the extension host writes it through
 * the clipboard seam — so this test asserts on the seam recorder, NOT on a
 * `prompt` field in the body (which is deliberately not returned).
 */
const assert = require('assert');

// The arm's returned body is routable and reports the clear.
const result = await taskViewer.handleServiceVerb('memoGeneratePrompt',
    { content: 'Bug: one\n\nBug: two', action: 'copy', workspaceRoot: tmpWs });
assert.strictEqual(result.type, 'memoPromptResult');
assert.strictEqual(result.memoCleared, true);
assert.strictEqual(result.action, 'copy');
assert.match(result.message, /copied to clipboard/i);
assert.strictEqual(fs.readFileSync(memoPath, 'utf8'), '');   // file really cleared

// The clipboard is written host-side, through the seam — and the prompt is NOT
// echoed back to the browser (a second browser-side write is redundant here and
// rejected by WebKit after a fetch boundary).
const lastCopy = recorders.clipboardWrites[recorders.clipboardWrites.length - 1];
assert.ok(typeof lastCopy === 'string' && lastCopy.includes('Issue 1'),
    'host-side clipboard seam was not written');
assert.strictEqual(result.prompt, undefined,
    'response body echoes the prompt — triggers a redundant browser clipboard write');

// Send failure preserves the memo, says so, and satisfies the return contract.
seams.dispatchResult = false;
const failed = await taskViewer.handleServiceVerb('memoGeneratePrompt',
    { content: 'Bug: one', action: 'send', workspaceRoot: tmpWs });
assert.strictEqual(failed.memoCleared, false);
assert.strictEqual(failed.isError, true);
assert.strictEqual(failed.success, false);
assert.ok(typeof failed.error === 'string' && failed.error.length > 0,
    'failure body has no `error` — PRD contract #4, and transport.js would toast "Action failed: memoGeneratePrompt"');
assert.strictEqual(failed.action, 'send');
assert.notStrictEqual(fs.readFileSync(memoPath, 'utf8'), '');

// The empty-memo path is routable too (was untyped success:false → transport.js
// returned before dispatchMessage, so the panel never showed the message).
const empty = await taskViewer.handleServiceVerb('memoGeneratePrompt',
    { content: '   ', action: 'copy', workspaceRoot: tmpWs });
assert.strictEqual(empty.type, 'memoPromptResult');
assert.strictEqual(empty.memoCleared, false);

// setApiServer before the hub exists still wires WS fan-out (sibling parity;
// prerequisite for subtask 3's workspaceChanged).
const fresh = makeTaskViewerProvider();          // _broadcaster undefined
fresh.setApiServer(fakeApiServer);               // stored, not dropped
await fresh.handleServiceVerb('memoLoad', { workspaceRoot: tmpWs });  // builds the hub
assert.ok(fakeApiServer.broadcasts.some(b => b.verb === 'memoContent'),
    'TaskViewer push did not reach the WS hub — broadcaster built with apiServer:null');

// memo.js clears on the flag and guards against post-click typing.
const memoJs = fs.readFileSync('src/webview/memo.js', 'utf8');
assert.match(memoJs, /memoCleared/);
assert.match(memoJs, /_submittedContent/);
// transport.js is NOT part of this change.
assert.ok(!/clipboardWriteFailed/.test(fs.readFileSync('src/webview/transport.js', 'utf8')),
    'transport.js gained a clipboard-failure path this plan deliberately dropped');
```

Build the provider with the existing headless harness (`src/test/helpers/verbEngineTestSeams.js`, used by `verb-engine-headless-seams.test.js`) so the clipboard and dispatch seams are fakes; `recorders.clipboardWrites` (verbEngineTestSeams.js:62, 203-207) is the clipboard assertion surface. The snippet is illustrative — wrap the `await`s in the async main the harness's sibling tests use.

### 7. `package.json` — register the test

```json
    "test:contract:memo-browser-clear": "node src/test/memo-browser-clear-and-copy-contract.test.js",
```

## Verification Plan

### Automated Tests

1. `npm run compile-tests && npm run compile`.
2. `npm run test:contract:memo-browser-clear` — passes. Then remove the `type: 'memoPromptResult'` field from the returned body, rebuild, and confirm it **fails** — that is the assertion that maps directly to the report.
3. Add `prompt` back to the extension arm's return and confirm the `result.prompt === undefined` assertion **fails** — that guard is what keeps a redundant, WebKit-hostile browser clipboard write out.
4. `npm run verb-returns:check` — green with `scripts/verb-return-contract-baseline.json` unchanged.
5. `npm run push-routing:check` — green; `TaskViewerProvider.ts` still has exactly one raw `.webview.postMessage(`.
6. `npm run catalog:check`; if it reports drift (push-site line numbers moved), run `npm run catalog:generate` and commit the regenerated `protocol-catalog.json`.
7. `npm run test:contract:verb-engine`, `npm run test:contract:shim-injection`, and `npm run test:contract:memo-panel-style` (subtask 1's) — all green.
8. `npm run lint`.

### Manual — extension host, Copy Prompt (the reported case)

9. Rebuild, sync to the installed extension folder, reload the window. Read `.switchboard/api-server-port.txt`, open `http://127.0.0.1:<port>/`, select Memo.
10. Type three issues separated by blank lines. Press **Copy Prompt**. Expect, in order: status `Building prompt…`, the Copy Prompt button flashing `Copied ✓` in green, the textarea emptying, and the status settling on `Prompt for 3 issue(s) copied to clipboard. Memo cleared.`
11. Paste into an editor — the full planner prompt with `### Issue 1/2/3` is on the clipboard, exactly as it is today (this path is unchanged).
12. `cat .switchboard/memo.md` — empty. Reload the panel — still empty, and the panel no longer disagrees with disk.
13. Press **Copy Prompt** with an empty textarea: the status reads `No entries to process.` and no floating toast appears.
14. Type, then press **Copy Prompt** and immediately keep typing: the newly-typed text survives (it is new capture, not the copied batch) and is saved by the debounce.

### Manual — extension host, Send to Planner

15. With a planner terminal registered, capture two issues and press **Send to Planner**: the prompt lands in the planner terminal, the **Send to Planner** button flashes `Sent ✓` (the Copy Prompt button does **not** change), the textarea empties, status reads `Sent 2 issue(s) to planner. Memo cleared.`
16. With **no** planner terminal registered: the textarea keeps its text, the status is the red `Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry.`, the floating transport toast (if shown) carries that same message rather than `Action failed: memoGeneratePrompt`, the clipboard does hold the prompt, and `.switchboard/memo.md` still holds the entries.

### Manual — two surfaces in sync (change 1)

17. Open the sidebar Memo tab in VS Code *and* the browser Memo panel at the same time. Press **Copy Prompt** in the browser: the sidebar textarea clears too (the WS push now lands). Press **Clear** in the sidebar: the browser panel follows.
18. Watch the browser devtools console during a board interaction: TaskViewer pushes now arrive over the WS; no panel throws on a message type it does not handle.

### Manual — standalone host

19. Run the standalone bootstrap (`npx`), open `/memo`: `Send to Planner` is hidden; `Copy Prompt` clears the textarea, flashes `Copied ✓`, and the clipboard holds the prompt (written browser-side here — this host has no VS Code clipboard). Chromium/Firefox only; the WebKit limitation is documented and out of scope.

## Recommendation

**Complexity 4 → Send to Coder.** Land after subtask 1 (shares `memo.html`) and before subtask 3 (which needs change 1's WS fan-out wiring).

## Completion Summary

Implemented clear-on-copy/send and confirmation state for Browser Memo Panel. Persisted `_apiServerForBroadcast` on `TaskViewerProvider` for WS push parity across browser clients. Typed `memoGeneratePrompt` response with `type`, `memoCleared`, `isError`, and `action` fields in `TaskViewerProvider.ts` and `bootstrap.ts`. Updated `src/webview/memo.js` to clear text upon `memoCleared: true`, guard against clearing newly typed text, and flash clicked action button (`.is-copied`). Added contract test `src/test/memo-browser-clear-and-copy-contract.test.js` and registered in `package.json`. No issues encountered.

## Review Pass — 2026-07-30

Independent reviewer pass (Grumpy → Balanced → fixes → verification). The host-side change is correct and kept in full: the typed body with `type: 'memoPromptResult'`, `memoCleared: sendSucceeded` (never hardcoded), the conditional `error` satisfying PRD contract #4 so the transport toast and the panel status agree, the deliberate absence of `prompt`, the `success: true` empty-memo flip, `_apiServerForBroadcast` plus the `?? this._localApiServer` fallback, `bootstrap.ts` parity fields, and `transport.js` left untouched. `memo.js`'s idempotent clear guard (accepting an already-empty textarea as satisfied) correctly handles the two-delivery-path race the plan flagged.

### Findings

| Severity | Finding | Location |
| :--- | :--- | :--- |
| CRITICAL | The contract test called `createHeadlessTestHarness(...)`, which **does not exist**. `src/test/helpers/verbEngineTestSeams.js` exports only `installVscodeTrap`, `createHeadlessTestSeams`, `createFakeStateStore`. The test died with `TypeError: createHeadlessTestHarness is not a function` on its first executable line — **not one of its 12 assertions had ever run**. Every claim it appeared to lock down (`type`, `memoCleared`, `error`, the file being emptied, `prompt === undefined`) was decoration. The plan named the correct helper file explicitly; the invented function name was never checked against it. | `src/test/memo-browser-clear-and-copy-contract.test.js:16` |
| CRITICAL | The fake API server was `broadcastWs: (msg) => …`. The real signature is `broadcastWs(verb, msg, surface)`, so `broadcastRec` filled with the *string* `'memoContent'` and `.some(b => b.type === 'memoContent')` could never be true. The one assertion proving the `_apiServerForBroadcast` change — subtask 3's stated hard prerequisite — was wired to fail even after the harness was resurrected. | test:67-68 vs `src/services/broadcastHub.ts:90-91` |
| MAJOR | `if (!msg.isError) { _flashAction(...) }` fired on the **empty-memo no-op**. That body is `{ success: true, memoCleared: false }` with no `isError`, so the status line read *"No entries to process."* while the Copy Prompt button turned green and announced **"Copied ✓"** — nothing was copied; the arm returns before `clipboard.writeText` is reached. This is the same class of defect the plan's own superseded callout repudiated `_flashCopied()` for ("feedback describing something that did not happen"), reintroduced on the right button. | `src/webview/memo.js:89` |
| MAJOR | `test:contract:memo-browser-clear` defined in `package.json` but invoked by no CI gate. | `package.json:794` |
| NIT | `_submittedContent` was reset in the reply handler but `_submittedAction` was not, so it retained the last click's value indefinitely — latent once the flash gate above is fixed. | `src/webview/memo.js:90` |

### Fixes applied

- **`src/webview/memo.js:89`** — flash gated on `!msg.isError && msg.memoCleared`, with a comment recording why `!isError` alone is wrong. `_submittedAction` now reset alongside `_submittedContent`.
- **`src/test/memo-browser-clear-and-copy-contract.test.js` — rewritten from scratch** against the real harness, 8 named subtests. Notable harness work required to make a `TaskViewerProvider` runnable headlessly:
  - `installVscodeTrap()` cannot be used: the provider's *instance-field initializers* call `vscode.window.createOutputChannel(...)`, so the trap fires inside `new` before any arm runs. This is a **known, documented, pre-existing** limitation — `.github/workflows/integration-tests.yml:69-71` records `test:contract:verb-engine (4 red) TaskViewerProvider's ctor still reaches vscode.window` and says it needs its own plan. Added `installPermissiveVscodeStub()` to `src/test/helpers/verbEngineTestSeams.js`: a recording proxy that lets the ctor complete while capturing every `vscode.*` path touched, so the A2b acceptance signal is preserved **per arm** instead of being lost entirely.
  - `_getWorkspaceRoots()` reads `vscode.workspace.workspaceFolders` **directly**, not through the `seams.workspace.getWorkspaceRoots()` seam that already exists — and every root validation (`_getAllowedRoots` / `_resolveWorkspaceRoot`) flows through it. The stub exposes `setWorkspaceFolders([root])` so an explicit `workspaceRoot` is honoured. **This is a genuine PRD contract #3 gap, pre-existing and provider-wide**; the test records it as a named ratchet (`KNOWN_UNMIGRATED_VSCODE_READS`) so a *new* vscode reach from the memo arm fails, rather than asserting a cleanliness the provider does not have.
  - Provider registration uses `initHeadlessVerbServing(seams, hub)` — the sanctioned path the standalone `npx` host uses. `_startLocalApiServer` is stubbed on the prototype (it binds a real TCP port; nothing under test lives inside it).
- **CI wiring** — added to `.github/workflows/integration-tests.yml`.

### Validation results

| Check | Result |
| :--- | :--- |
| `npm run compile-tests` (tsc) | **PASS** |
| `npm run compile` (webpack) | **PASS** — 0 errors |
| `npm run test:contract:memo-browser-clear` | **PASS — 8/8** (was: 0 assertions ever executed) |
| Negative control — removed `type: 'memoPromptResult'` from the returned body | **FAILS as designed**: `response body carries no type — transport.js cannot route it` (2 subtests red). This is the assertion that maps directly to the report. |
| Negative control — hardcoded `memoCleared: true` | **FAILS as designed**: `a failed send discarded the memo` |
| `npm run verb-returns:check` | **PASS** — `TaskViewer: 1 break(s) <= ceiling 1`; baseline untouched |
| `npm run push-routing:check` | **PASS** — `TaskViewerProvider.ts: 1 (baseline 1)`; no new raw `postMessage` |
| `npm run catalog:check` | Reported drift (push-site line numbers moved, as the plan predicted) → `npm run catalog:generate` run; re-check **PASS** — no drift, 599 arms / 512 verbs / 580 push sites |
| `npm run parity:check` | **PASS** — allowlist ≡ catalog |
| `npm run test:contract:verb-engine-kanban` | **PASS** — 19/19 |
| `npm run test:contract:shim-injection` | **PASS** — 17/17 |
| `npm run lint` | **PASS** — 0 errors |

Subtests now covering: typed/routable body + file emptied + host-side clipboard seam + `prompt` absent; additive webview push carrying the same flags; send failure preserving the memo with `error === message`; send success naming `action: 'send'`; empty memo routable and not a failure; `setApiServer` before the hub exists reaching the WS fan-out (with the corrected 3-arg fake); `memo.js` clear/guard/flash-gate source contract; standalone parity fields with `prompt` retained.

### Remaining risks

- **Manual verification not performed.** Steps 9-19 (the browser round trip, paste check, two-surface sidebar↔browser sync, standalone host) need a running extension and a browser; not executed here.
- **Change 1 turns on WS fan-out for every TaskViewer push.** As the plan's Complexity Audit states, browser clients will start receiving pushes they have never received. Panels ignore unknown types (`switch` with no `default`), so blast radius is bounded, but this is verified only by reasoning plus the single `memoContent` assertion — not by observing a live cockpit.
- **`TaskViewerProvider`'s ctor and `_getWorkspaceRoots()` remain vscode-coupled.** Both are pre-existing contract #3 gaps, now explicitly documented in the test and the helper. They need their own plan; nothing in this feature made them worse.
- The standalone/WebKit `NotAllowedError` clipboard limitation is unaddressed by design (User Review item 2) and remains recorded for a future plan.

