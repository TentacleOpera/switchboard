# Bridge host notifications to the browser panels so verb buttons stop looking dead

## Goal

Make every host-side notification raised while serving a browser panel verb (`showTemporaryNotification`,
`showInformationMessage`, `showWarningMessage`, `showErrorMessage`) surface as a toast **inside the
browser panel that triggered it**, so buttons like Tickets → **Diagram** confirm their action instead of
appearing to fail silently.

### Problem

In the VS Code extension, a verb arm's success feedback is a native editor notification. Example — the
Tickets **Diagram** button:

```js
// src/webview/tickets.js:5216
vscode.postMessage({ type: 'copyDiagramPrompt', prompt });
```

```ts
// src/services/sharedUtilityVerbs.ts:70-83  (handleCopyDiagramPrompt)
await deps.seams().clipboard.writeText(prompt);
deps.seams().ui.showTemporaryNotification('Diagram prompt copied to clipboard');
return { success: true };
```

In the editor that pops a progress-notification toast. In the browser/standalone cockpit the same click
produces **nothing visible**: the prompt is copied, the verb returns `{ success: true }`, and the toast is
either thrown at the wrong surface or discarded.

This is not one button. The notification seam is the *primary* success-feedback channel for the whole
verb engine — 284 `seams().ui.show*` call sites plus 114 `showTemporaryNotification` call sites:

| File | `seams().ui.show*` calls |
| :--- | :--- |
| `src/services/TaskViewerProvider.ts` | 104 |
| `src/services/KanbanProvider.ts` | 78 |
| `src/services/PlanningPanelProvider.ts` | 45 |
| `src/services/TicketsPanelProvider.ts` | 22 |
| `src/services/DesignPanelProvider.ts` | 20 |
| `src/services/SetupPanelProvider.ts` | 11 |
| `src/services/sharedUtilityVerbs.ts` | 3 |

Only two panels have any client-side toast of their own — `project.js` (`showToast`, 16 uses) and
`kanban.html` (`showStatusMessage`). `tickets.js`, `design.js`, `terminals.js`, `connections.js`,
`memo.js` and `setup.html` have **zero**, so in those panels the host notification is the only feedback
that ever existed.

### Root cause

Both browser hosts serve panel verbs through `LocalApiServer` (`src/standalone/bootstrap.ts:1688`
constructs one too), and both drop the notification — for *different* reasons:

**1. Extension-served browser — notification fires at the wrong surface.**
`npx switchboard` detects the running extension via `api-server-port.txt` and points the browser at the
extension's `LocalApiServer`. `POST /tickets/verb/copyDiagramPrompt` →
`_handleTicketsVerb` (`src/services/LocalApiServer.ts:2006`) → `ticketsVerb`
(`src/services/TaskViewerProvider.ts:2367`) → `TicketsPanelProvider.handleServiceVerb`
(`:139`) → `_handleMessage` → `handleCopyDiagramPrompt` → `VscodeHostUI.showTemporaryNotification`
(`src/services/hostSeams.ts:378`) → `vscode.window.withProgress`. The toast renders **in the VS Code
window** the user is not looking at. The HTTP response body carries no trace of it.

**2. Standalone (`npx` with no extension) — notification dies in the shim.**

**Get the live path right before editing anything.** Standalone injects
`createVscodeHostSeams(workspaceRoot, secretStorage)` (`src/standalone/bootstrap.ts:603`) — the
*vscode-backed* bundle — and `webpack.config.js:149-150` aliases the `vscode` module to
`src/standalone/vscodeShim.ts`. So standalone runs `VscodeHostUI`, and the dead end is the shim:

```ts
// src/standalone/vscodeShim.ts:133-135  ← THE LIVE STANDALONE PATH
export async function showInformationMessage(_message: string, ..._items: any[]): Promise<any> { return undefined; }
export async function showWarningMessage(_message: string, ..._items: any[]): Promise<any> { return undefined; }
export async function showErrorMessage(_message: string, ..._items: any[]): Promise<any> { console.error('[headless]', _message); return undefined; }
```

`showTemporaryNotification` reaches `vscode.window.withProgress`, which the shim implements
(`:146-148`) by running the task and reporting nothing. The notice never leaves the process.

**`hostServices.ts:422-434` is NOT this path.** `createHeadlessHostSeams` (`hostServices.ts:370`) has
**zero callers** — confirmed by `grep -rn "createHeadlessHostSeams" src/`, whose only hits are the
definition and two comments saying it is not what standalone injects (`bootstrap.ts:752`,
`vscodeShim.ts:235`). It is a ~90-line literal that reads exactly like the live standalone
implementation, and editing it changes nothing at runtime. Wire the shim; treat the dead bundle as
described in change #4.

**3. `transport.js` has a failure-only toast and no success channel.**
The browser shim already renders host problems:

```js
// src/webview/transport.js:377-384
if (result && typeof result === 'object' && result.success === false) {
    const text = result.error || ('Action failed: ' + verb);
    if (STATUS_MESSAGE_PANELS[panel]) {
        dispatchMessage({ type: 'showStatusMessage', message: text, isError: true });
    } else {
        showTransportError(text);
    }
```

So the plumbing and the DOM host (`#sb-transport-error`, `src/webview/transport.js:324-342`) exist —
there is simply no path for an *informational* notice, and a verb that succeeds returns a body with
nothing to render. `copyDiagramPrompt` returning bare `{ success: true }` hits exactly that hole.

### Fix shape

Capture notifications per HTTP request and return them in the response body; render them in
`transport.js` with the failure toast's own machinery. Chosen over the two alternatives:

- **Per-verb return fields** (`{ notice: '...' }`) would mean editing ~400 call sites and would
  re-break on every new arm. Rejected.
- **`BroadcastHub`/`wsHub` push** cannot address the originating client — `transport.js` ignores
  `msg.surface`, so every push fans out to all panel iframes. A toast is a reply to one click, not
  board state. Rejected.

Request-scoped `AsyncLocalStorage` capture needs **zero** changes at the 400 call sites, is precise to
the requesting client, and leaves the VS Code webview path (`_handleMessage` called directly from
`webview.onDidReceiveMessage`, `src/services/TicketsPanelProvider.ts:1007`) completely untouched — no
ALS context is ever established there, so editor toasts keep working exactly as today.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, backend, ui, ux, bugfix, reliability
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- `transport.js` toast rendering — generalising `showTransportError` into a kind-aware notice stack is
  contained, self-styled DOM work in a file that already does exactly this.
- Attaching a reserved `__notices` key to verb response bodies. Extra keys are already harmless:
  `dispatchMessage(result)` (`src/webview/transport.js:401-403`) switches on `result.type` and ignores
  unknown fields.
- Wiring the standalone `ui` seam object — a 6-line literal in one file.

**Complex / risky**
- **First `AsyncLocalStorage` use in the repo** (`grep -rn "AsyncLocalStorage\|async_hooks" src/` → no
  hits). It is a Node builtin, so the VSIX's no-`node_modules` constraint is not a factor, but webpack's
  `externals` handling of `node:async_hooks` must be confirmed at build time, not assumed.
- **Suppression semantics.** When a notice is captured, the native toast must be skipped — otherwise a
  browser click pops a phantom notification in the editor. But suppression must never *lose* a notice:
  any notice raised after the response has flushed has to fall back to the native path. This is the one
  place a bug here can silently delete user feedback that works today.
- **Touching `src/utils/showTemporaryNotification.ts`** changes behaviour for all 114 call sites at once,
  including the 19 direct imports in `DesignPanelProvider.ts` that bypass the seam. That breadth is the
  point (it is why the fix is small), but it means the guard has to be exactly right.
- **Ratcheted CI gates** watch this area: `scripts/check-push-routing.js`,
  `scripts/check-standalone-push-parity.js` (message-type gap baseline is **0**), and
  `scripts/check-verb-return-contract.js`. Adding a response-body key is not a push and not a `break`,
  so no baseline should move — but this must be verified, not assumed.

**Not in scope**
- 21 direct `vscode.window.show*Message` calls in background services (`ContinuousSyncService.ts` ×8,
  `KanbanProvider.ts` ×6, `PlanningPanelCacheService.ts` ×3, `NotionFetchService.ts` ×2,
  `MultiRepoScaffoldingService.ts` ×2, `KanbanDatabase.ts` ×2). These fire from watchers and sync loops,
  not inside a verb request, so no request context exists to capture them.
- Choice dialogs (`showWarningMessage(msg, 'Yes', 'No')`) — see Edge Cases.
- The standalone clipboard no-op. Separate defect, separate plan.

**No confirmation dialogs are added.** This plan only adds non-blocking, auto-dismissing toasts.
**No migration is needed** — nothing here reads or writes persisted state.

## Edge-Case & Dependency Audit

1. **Notice raised after the response flushed.** A verb that kicks off fire-and-forget work keeps the ALS
   context alive in its async continuation, so a late notice would be captured into an array nobody will
   ever serialise — silently deleting a toast that today appears in the editor. Handled by a `closed`
   flag set the instant the body is written; `captureNotice` returns `false` once closed, and the caller
   falls through to the native path.
2. **Choice dialogs must not be intercepted.** `showWarningMessage(message, 'Discard', 'Cancel')` awaits
   the user's pick and the caller branches on it. A browser toast cannot answer. Interception is gated on
   `items.length === 0`; with items, the native dialog runs unchanged (in the editor it blocks on the VS
   Code window — pre-existing behaviour, untouched here; standalone still returns `undefined`, also
   unchanged).
3. **Non-object response bodies.** `res.end(JSON.stringify(result ?? { success: true }))` — a `null`
   result becomes `{ success: true }` (attachable), but an array or primitive is not. Attach only to
   plain non-array objects; otherwise emit the notices to the server log and drop them, with a
   `console.warn` naming the verb so the case is discoverable rather than mysterious.
4. **Concurrent requests.** `AsyncLocalStorage` isolates per `run()` call, so two simultaneous browser
   clicks cannot cross-contaminate. Nested verb calls (`_handleMessage` recursing, e.g.
   `PlanningPanelProvider.ts:4525`) share the outer store — correct, since they share the response.
5. **Duplicate toast on failure.** A failing verb can both return `{ success: false, error }` *and* have
   raised an error notice, producing two toasts saying the same thing. When any `error`-kind notice is
   present, suppress the generic `result.error` / `'Action failed: ' + verb` fallback.
6. **Kanban routes notices differently.** `STATUS_MESSAGE_PANELS = { kanban: true }`
   (`src/webview/transport.js:322`) sends kanban's failures through its own `showStatusMessage` handler
   (`src/webview/kanban.html:7844`). Notices must follow the same split, or the board grows a second,
   inconsistent notification style.
7. **Multiple notices per request.** `#sb-transport-error` is a singleton whose `textContent` is
   overwritten (`:338`), so a second notice would erase the first. Convert it to a stack container with
   one child per notice, each on its own dismiss timer.
8. **Unbounded notice text.** Some arms interpolate file paths or error dumps. Cap each notice at 500
   chars server-side, and keep `white-space:pre-wrap` + `max-width:80vw` so a long notice wraps instead
   of spanning the viewport.
9. **VS Code webview must be unaffected.** No ALS context is established on the
   `webview.onDidReceiveMessage` path, so `captureNotice` returns `false` and every editor toast behaves
   as today. This is the primary regression risk and gets an explicit test.
10. **All 10 headless panels are covered by one change.** `injectTransportShim`
    (`src/services/headlessPanelHtml.ts:73-88`) injects `transport.js` into every panel
    (`getShellHtml`, `getBoardHtml`, `getProjectHtml`, `getPlanningHtml`, `getDesignHtml`,
    `getSetupHtml`, `getMemoHtml`, `getTerminalsHtml`, `getTicketsHtml`, `getConnectionsHtml`), so the
    toast lands everywhere without touching panel HTML. Requires no per-panel CSS — the toast is
    self-styled inline, exactly like `showTransportError` (a shared stylesheet is not an option:
    `shared-tabs.css` is dead and panels inline their own CSS).
11. **`/project/verb/*` and `/memo/verb/*` both route to `_handlePlanningVerb`**
    (`src/services/LocalApiServer.ts:3712-3717`), and `/connections/verb/*` splits across Setup and
    Planning. Wrapping the handler methods (not the route table) covers all of these once.
12. **`_handleTerminalVerb` holds `delegatesAwait` open indefinitely** (`:1856-1871`) and can answer from
    a `req.on('close')` path. The capture wrapper must not assume a single write, and must not keep a
    context alive across a long-held join. Simplest correct handling: wrap only the terminal verb's
    normal completion path, and treat the abort path as closed.

## Proposed Changes

### 1. `src/services/hostNoticeContext.ts` — new file

Request-scoped notice capture. Host-agnostic; imports nothing from `vscode`.

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export type HostNoticeKind = 'info' | 'warning' | 'error' | 'success';

export interface HostNotice {
    kind: HostNoticeKind;
    message: string;
}

interface NoticeStore {
    notices: HostNotice[];
    /**
     * Set the moment the response body is serialised. A notice raised after this
     * point can never reach the client, so `captureNotice` must decline it and let
     * the caller fall through to the native host path — otherwise fire-and-forget
     * work started by a verb would silently lose feedback that works today.
     */
    closed: boolean;
}

const MAX_NOTICE_CHARS = 500;
const MAX_NOTICES_PER_REQUEST = 8;

const storage = new AsyncLocalStorage<NoticeStore>();

/**
 * Run `fn` with a notice-capture context active. Returns the fn's result plus
 * every notice raised inside it, and closes the store so late notices fall back
 * to the native path.
 */
export async function runWithNoticeCapture<T>(
    fn: () => Promise<T>
): Promise<{ result: T; notices: HostNotice[] }> {
    const store: NoticeStore = { notices: [], closed: false };
    try {
        const result = await storage.run(store, fn);
        return { result, notices: store.notices };
    } finally {
        store.closed = true;
    }
}

/**
 * Record a notice against the active request, if any.
 *
 * @returns true when the notice was captured — the caller MUST then skip its
 *   native notification (the clicker is in a browser, not the editor). false
 *   means no live context: behave exactly as before.
 */
export function captureNotice(kind: HostNoticeKind, message: string): boolean {
    const store = storage.getStore();
    if (!store || store.closed) { return false; }
    const text = String(message ?? '').trim();
    if (!text) { return false; }
    if (store.notices.length >= MAX_NOTICES_PER_REQUEST) { return true; }
    store.notices.push({ kind, message: text.slice(0, MAX_NOTICE_CHARS) });
    return true;
}

/** True when a notice-capture context is live (used by seams to decide suppression). */
export function isCapturingNotices(): boolean {
    const store = storage.getStore();
    return !!store && !store.closed;
}
```

### 2. `src/utils/showTemporaryNotification.ts` — capture before touching vscode

One guard here covers all 114 call sites, including `DesignPanelProvider`'s 19 direct imports and
`VscodeHostUI.showTemporaryNotification` (`src/services/hostSeams.ts:378`).

```ts
import * as vscode from 'vscode';
import { captureNotice } from '../services/hostNoticeContext';

export function showTemporaryNotification(message: string, durationMs: number = 2500): void {
    // Browser-served verb: the clicker is in a browser tab, so the notice rides
    // home in the HTTP response body instead of popping in an editor window the
    // user is not looking at.
    if (captureNotice('success', message)) { return; }
    void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: message, cancellable: false },
        async () => { await new Promise(resolve => setTimeout(resolve, durationMs)); }
    );
}
```

### 3. `src/services/hostSeams.ts` — `VscodeHostUI` intercepts item-free notifications

```ts
export class VscodeHostUI implements HostUI {
    async showWarningMessage(message: string, ...items: string[]): Promise<string | undefined> {
        // Only item-free calls are pure notifications. With items the caller awaits
        // a choice, which a browser toast cannot answer — those keep the native dialog.
        if (items.length === 0 && captureNotice('warning', message)) { return undefined; }
        return await vscode.window.showWarningMessage(message, ...items);
    }
    async showInformationMessage(message: string, ...items: string[]): Promise<string | undefined> {
        if (items.length === 0 && captureNotice('info', message)) { return undefined; }
        return await vscode.window.showInformationMessage(message, ...items);
    }
    async showErrorMessage(message: string, ...items: string[]): Promise<string | undefined> {
        if (items.length === 0 && captureNotice('error', message)) { return undefined; }
        return await vscode.window.showErrorMessage(message, ...items);
    }
    // showModalWarningMessage is deliberately NOT intercepted — it is always a
    // decision dialog, never a notification.
```

### 4. `src/standalone/vscodeShim.ts` — the live standalone dead end

Changes #2 and #3 already cover standalone, because `VscodeHostUI` is the bundle standalone injects and
`utils/showTemporaryNotification` is what it calls. This change closes the *direct* route: the 21
provider call sites that reach `vscode.window.show*Message` without going through a seam (8 in
`ContinuousSyncService.ts`, 6 in `KanbanProvider.ts`, 3 in `PlanningPanelCacheService.ts`, 2 each in
`NotionFetchService.ts`, `MultiRepoScaffoldingService.ts`, `KanbanDatabase.ts`).

```ts
// src/standalone/vscodeShim.ts:133-135
export async function showInformationMessage(message: string, ...items: any[]): Promise<any> {
    if (items.length === 0 && captureNotice('info', message)) { return undefined; }
    return undefined;
}
export async function showWarningMessage(message: string, ...items: any[]): Promise<any> {
    if (items.length === 0 && captureNotice('warning', message)) { return undefined; }
    return undefined;
}
export async function showErrorMessage(message: string, ...items: any[]): Promise<any> {
    if (items.length === 0 && captureNotice('error', message)) { return undefined; }
    console.error('[headless]', message);
    return undefined;
}
```

Most of those 21 sites fire from watchers and sync loops with no request context, so `captureNotice`
returns `false` and behaviour is unchanged — but the handful that *are* verb-reachable get covered for
free, and the shim stops being a silent floor.

**Do NOT edit `hostServices.ts:422-434`.** `createHeadlessHostSeams` has zero callers (see Root cause 2);
an edit there is dead code that will read like a completed fix to the next auditor. Either leave it
untouched or delete the function — but decide deliberately, and if it stays, add a one-line header
saying it is not injected, so it stops impersonating the live path. This plan does not require choosing;
it requires not mistaking it for the fix.

### 5. `src/services/LocalApiServer.ts` — wrap the verb rails, attach `__notices`

One private helper, then a one-line change in each of the seven `_handle*Verb` methods
(`_handleTerminalVerb` :1825, `_handleKanbanVerb` :1939, `_handlePlanningVerb` :1978,
`_handleTicketsVerb` :2006, `_handleDesignVerb` :2034, `_handleSetupVerb` :2070,
`_handleTaskViewerVerb` :2114):

```ts
/**
 * Run a verb with host-notification capture and fold the captured notices into
 * the JSON body under the reserved `__notices` key. transport.js renders them as
 * toasts in the browser panel that made the request; the VS Code webview path
 * never establishes a context, so editor notifications are unchanged.
 */
private async _runVerbWithNotices<T>(verb: string, fn: () => Promise<T>): Promise<any> {
    const { result, notices } = await runWithNoticeCapture(fn);
    const body: any = result ?? { success: true };
    if (notices.length === 0) { return body; }
    if (typeof body !== 'object' || Array.isArray(body)) {
        // Nothing to attach to — say so rather than dropping feedback invisibly.
        console.warn(`[LocalApiServer] verb '${verb}' returned a non-object body; ${notices.length} notice(s) not delivered`);
        return body;
    }
    return { ...body, __notices: notices };
}
```

Each handler's dispatch line becomes, e.g. in `_handleTicketsVerb`:

```ts
const result = await this._runVerbWithNotices(verb, () => ticketsVerb(verb, body, workspaceRoot));
const ok = !result || result.success !== false;
res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
res.end(JSON.stringify(result));
```

The `?? { success: true }` default moves into the helper, so the existing `res.end(JSON.stringify(result ?? { success: true }))`
shape collapses to `JSON.stringify(result)`. `_handleTerminalVerb`'s `ptyPasteImage` binary branch and
its `req.on('close')` abort reply keep their current shape — neither is a notification-bearing path.

### 6. `src/webview/transport.js` — kind-aware notice stack + render `__notices`

Generalise the existing error host into a stack, keeping `showTransportError` as a thin wrapper so the
current failure path is untouched:

```js
const NOTICE_STYLES = {
    error:   'background:#5d2424;color:#ffb0b0;border:1px solid #8a3838;',
    warning: 'background:#4a3a18;color:#f0cf8a;border:1px solid #7a6228;',
    success: 'background:#1e4030;color:#8fdab0;border:1px solid #2e6a4a;',
    info:    'background:#22262b;color:#d6dae0;border:1px solid #3a4048;',
};

// Self-styled on purpose: transport.js is shared by all 10 headless panels and
// cannot depend on any panel's stylesheet (only project.html defines
// .toast-notification). Palette mirrors project.html:892-916 so the browser
// toast reads as the same component as the editor one.
function showTransportNotice(text, kind) {
    let stack = document.getElementById('sb-transport-notices');
    if (!stack) {
        stack = document.createElement('div');
        stack.id = 'sb-transport-notices';
        stack.style.cssText =
            'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);' +
            'z-index:2147483647;display:flex;flex-direction:column;gap:6px;' +
            'align-items:center;pointer-events:none;';
        (document.body || document.documentElement).appendChild(stack);
    }
    const node = document.createElement('div');
    node.style.cssText =
        'max-width:80vw;padding:10px 16px;border-radius:4px;font-size:12px;line-height:1.4;' +
        'font-family:var(--font-family, var(--font, system-ui, sans-serif));white-space:pre-wrap;' +
        (NOTICE_STYLES[kind] || NOTICE_STYLES.info);
    node.textContent = text;
    stack.appendChild(node);
    setTimeout(function () { node.remove(); }, kind === 'error' ? 8000 : 4000);
}

function showTransportError(text) { showTransportNotice(text, 'error'); }
```

In the `postMessage` response handler, render notices before the failure fallback and let captured
errors replace it:

```js
.then(function (result) {
    if (result && result.prompt && navigator.clipboard && navigator.clipboard.writeText) { /* unchanged */ }

    var notices = (result && Array.isArray(result.__notices)) ? result.__notices : [];
    var sawHostError = false;
    for (var i = 0; i < notices.length; i++) {
        var n = notices[i] || {};
        var kind = n.kind || 'info';
        if (kind === 'error') { sawHostError = true; }
        // Kanban owns its own notification surface (kanban.html:7844) — route
        // there so the board keeps one style, matching the failure split below.
        if (STATUS_MESSAGE_PANELS[panel]) {
            dispatchMessage({ type: 'showStatusMessage', message: String(n.message || ''), isError: kind === 'error' });
        } else {
            showTransportNotice(String(n.message || ''), kind);
        }
    }
    if (result && typeof result === 'object' && result.__notices) { delete result.__notices; }

    if (result && typeof result === 'object' && result.success === false) {
        // A captured host error already said this — do not say it twice.
        if (!sawHostError) {
            var text = result.error || ('Action failed: ' + verb);
            console.warn('[transport] verb failed:', verb, text);
            if (STATUS_MESSAGE_PANELS[panel]) {
                dispatchMessage({ type: 'showStatusMessage', message: text, isError: true });
            } else {
                showTransportError(text);
            }
        }
        if (typeof result.type !== 'string') { return; }
    }
    if (result && typeof result === 'object') { dispatchMessage(result); }
})
```

The `__notices` delete keeps the key out of panel message handlers — no handler switches on it, but the
body is re-dispatched as a `MessageEvent` and leaving a transport-private field in it invites
confusion later.

### 7. `src/test/browser-host-notice-bridge.test.js` — new contract test

Following `src/test/memo-browser-clear-and-copy-contract.test.js`'s structure (headless
`TaskViewerProvider` + `createHeadlessTestSeams`, with `_startLocalApiServer` neutralised):

- Inside `runWithNoticeCapture`, call `TicketsPanelProvider.handleServiceVerb('copyDiagramPrompt', { prompt: 'x' })`
  and assert the captured notices contain `'Diagram prompt copied to clipboard'`.
- Call the same verb **outside** any context and assert the seam recorder saw the native
  `showTemporaryNotification` — this is the VS Code webview regression guard.
- Assert `captureNotice` returns `false` after `runWithNoticeCapture` resolves (the `closed` flag), and
  that the native path then runs.
- Assert `showWarningMessage(msg, 'A', 'B')` is **not** captured.
- JSDOM: load `src/webview/transport.js`, feed a fetch response body with two `__notices` entries, and
  assert two children appear under `#sb-transport-notices` with distinct kind styling; feed
  `{ success: false, error: 'boom', __notices: [{kind:'error',message:'boom'}] }` and assert exactly one
  node (dedup).

Register as `test:contract:host-notice-bridge` in `package.json` and add it to
`.github/workflows/integration-tests.yml` alongside the other contract gates.

## Verification Plan

**Build & static gates**
1. `npm run compile-tests` — TypeScript clean (new module + seam signature changes).
2. `npm run compile` — confirms webpack resolves `node:async_hooks` as a Node builtin and does not try
   to bundle it. This is the one build-level unknown; if the import fails, switch to
   `require('async_hooks')` and re-run.
3. `npm run lint`.
4. `node scripts/check-push-routing.js`, `node scripts/check-standalone-push-parity.js`,
   `node scripts/check-verb-return-contract.js` — all three are ratchets; none of their baselines may
   move. `__notices` is a response-body key, not a push and not a `break`, so all three must stay green
   **without** editing a baseline. Editing one is the signal the design drifted.

**Automated**
5. `npm run test:contract:host-notice-bridge` (new) — all assertions above.
6. `npm run test:contract:verb-engine`, `:verb-engine-tickets`, `:verb-engine-planning`,
   `:verb-engine-kanban` — the seam-recorder suites are the direct regression net for the
   `hostSeams.ts` / `hostServices.ts` edits.
7. `npm run test:contract:memo-browser-clear` — the closest existing precedent for a browser verb's
   round trip; it asserts on the seam recorder, so a wrongly-suppressed notification shows up here.
8. Note the five pre-existing red regression tests at HEAD: run each of the above on a clean stash
   first, so a failure inherited from HEAD is not attributed to this change.

**Manual (browser, both hosts)**
9. **Extension-served:** with the extension running, `npx switchboard` → Tickets panel → select a ticket
   → overflow → **Diagram**. Expect a green "Diagram prompt copied to clipboard" toast in the browser,
   and **no** notification in the VS Code window. Paste to confirm the clipboard actually holds the
   prompt (the extension host writes the real system clipboard).
10. **Standalone:** stop the extension, `npx switchboard` fresh, repeat step 9. Expect the same toast.
    The clipboard will still be empty in this mode — that is the separate standalone-clipboard defect,
    not a failure of this plan; confirm the server log no longer prints
    `[headless notification] Diagram prompt copied to clipboard` (proof the notice was routed, not
    swallowed).
11. **Editor unchanged:** in VS Code, open the Tickets panel webview and click **Diagram**. Expect the
    native editor toast exactly as before, and no console warning about undelivered notices.
12. **Multi-notice + long text:** trigger a verb that raises several notices (e.g. a Setup panel save
    that warns and confirms) and confirm they stack rather than overwrite, and that a long
    path-bearing message wraps inside `max-width:80vw`.
13. **Failure dedup:** force a verb failure (e.g. Diagram with an empty prompt, which hits
    `handleCopyDiagramPrompt`'s `showErrorMessage` + `{ success: false }`) and confirm exactly **one**
    red toast appears.
14. **Kanban split:** trigger a board verb that notifies and confirm the message renders through the
    board's own `showStatusMessage` strip, not a floating toast.
15. Spot-check two panels with no client-side toast of their own — Design and Connections — to confirm
    the shared transport toast reaches them (per-panel CSS is deliberately not involved).
