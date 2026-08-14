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
verb engine — **287** `seams().ui.show*` call sites plus **107** `showTemporaryNotification` call sites
(re-measured at HEAD, 2026-08-14):

| File | `seams().ui.show*` calls |
| :--- | :--- |
| `src/services/TaskViewerProvider.ts` | 104 |
| `src/services/KanbanProvider.ts` | 80 |
| `src/services/PlanningPanelProvider.ts` | 45 |
| `src/services/TicketsPanelProvider.ts` | 24 |
| `src/services/DesignPanelProvider.ts` | 20 |
| `src/services/SetupPanelProvider.ts` | 11 |
| `src/services/sharedUtilityVerbs.ts` | 3 |

The exact totals drift as arms are added; they are here to establish **order of magnitude**, which is
the argument for capture-at-the-seam over per-arm edits. Do not gate anything on these numbers.

Only two panels have any client-side toast of their own — `project.js` (`showToast`, 16 uses) and
`kanban.html` (`showStatusMessage`). `tickets.js`, `design.js`, `terminals.js`, `connections.js`,
`memo.js` and `setup.html` have **zero**, so in those panels the host notification is the only feedback
that ever existed.

### Root cause

Both browser hosts serve panel verbs through `LocalApiServer` (standalone constructs one too), and both
drop the notification — for *different* reasons:

> **Line numbers below were re-verified at HEAD on 2026-08-14 and several had drifted.** Corrected
> throughout; the symbols are the durable anchors, so `grep` the symbol if a number has moved again.

**1. Extension-served browser — notification fires at the wrong surface.**
`npx switchboard` detects the running extension via `api-server-port.txt` and points the browser at the
extension's `LocalApiServer`. `POST /tickets/verb/copyDiagramPrompt` →
`_handleTicketsVerb` (`src/services/LocalApiServer.ts:2075`) → `ticketsVerb`
(`src/services/TaskViewerProvider.ts:2367`) → `TicketsPanelProvider.handleServiceVerb`
(`:139`) → `_handleMessage` → `handleCopyDiagramPrompt` → `VscodeHostUI.showTemporaryNotification`
(`src/services/hostSeams.ts:378`) → `vscode.window.withProgress`. The toast renders **in the VS Code
window** the user is not looking at. The HTTP response body carries no trace of it.

**2. Standalone (`npx` with no extension) — notification dies in the shim.**

**Get the live path right before editing anything.** Standalone injects
`createVscodeHostSeams(workspaceRoot, secretStorage)` (`src/standalone/bootstrap.ts:659`) — the
*vscode-backed* bundle — and `webpack.config.js:147-152` aliases the `vscode` module to
`src/standalone/vscodeShim.ts`. So standalone runs `VscodeHostUI`, and the dead end is the shim:

```ts
// src/standalone/vscodeShim.ts:133-135  ← THE LIVE STANDALONE PATH
export async function showInformationMessage(_message: string, ..._items: any[]): Promise<any> { return undefined; }
export async function showWarningMessage(_message: string, ..._items: any[]): Promise<any> { return undefined; }
export async function showErrorMessage(_message: string, ..._items: any[]): Promise<any> { console.error('[headless]', _message); return undefined; }
```

`showTemporaryNotification` reaches `vscode.window.withProgress`, which the shim implements
(`:146-148`) by running the task and reporting nothing. The notice never leaves the process.

**`hostServices.ts` is NOT this path.** `createHeadlessHostSeams` (`hostServices.ts:371`) has **zero
callers** — re-confirmed at HEAD by `grep -rn "createHeadlessHostSeams" src/`, whose only hits are the
definition plus three comments saying it is not what standalone injects (`bootstrap.ts:664`,
`bootstrap.ts:817`, `vscodeShim.ts:235`) and one in a test explaining the same thing
(`tickets-auto-refresh-on-file-change.test.js:154`). It is a ~90-line literal that reads exactly like the
live standalone implementation, and editing it changes nothing at runtime. Wire the shim; treat the dead
bundle as described in change #4.

**3. `transport.js` has a failure-only toast and no success channel.**
The browser shim already renders host problems:

```js
// src/webview/transport.js:377-405 (verbatim at HEAD — note the quiet-list)
if (result && typeof result === 'object' && result.success === false) {
    // A typed, EXPECTED miss (e.g. readLocalTicketFile for a subtask whose file
    // has not been downloaded yet) is not a transport failure — the panel's own
    // handler owns the recovery UI. Suppress the generic toast for quiet-listed
    // reasons, but still fall through to dispatchMessage below.
    const EXPECTED_QUIET = new Set(['not-imported']);
    if (!EXPECTED_QUIET.has(result.reason)) {
        const text = result.error || ('Action failed: ' + verb);
        console.warn('[transport] verb failed:', verb, text);
        if (STATUS_MESSAGE_PANELS[panel]) {
            dispatchMessage({ type: 'showStatusMessage', message: text, isError: true });
        } else {
            showTransportError(text);
        }
    }
    // A TYPED failure body is an ADDRESSED reply: it still falls through to
    // dispatchMessage so the panel can clear its own loading state. Only an
    // UNTYPED failure — which no handler could route — stops here.
    if (typeof result.type !== 'string') {
        return;
    }
}
```

So the plumbing and the DOM host (`#sb-transport-error`, `src/webview/transport.js:324-342`) exist —
there is simply no path for an *informational* notice, and a verb that succeeds returns a body with
nothing to render. `copyDiagramPrompt` returning bare `{ success: true }` hits exactly that hole.

**Two behaviours in that block are load-bearing and must survive this change** (an earlier draft of this
plan quietly dropped both while restructuring the handler):
- the `EXPECTED_QUIET` suppression, which keeps `not-imported` misses from popping a spurious toast, and
- the typed-failure fall-through to `dispatchMessage`, without which a panel's spinner runs forever
  behind a transient toast.

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
- **First `AsyncLocalStorage` use in the repo** (`grep -rn "AsyncLocalStorage\|async_hooks" src/` → still
  no hits at HEAD). It is a Node builtin, so the VSIX's no-`node_modules` constraint is not a factor.

  *The original "webpack may not resolve `node:async_hooks`" worry has been checked and largely
  discharged:* both bundles set `target: 'node'` (`webpack.config.js:14`, `:129`) and the repo is on
  webpack `^5.105.4`, which resolves `node:`-prefixed builtins as externals natively. This is now a
  one-line confirmation during the first build, not a design risk. If it does fail, the fallback is
  `require('async_hooks')` without the prefix — no design change.
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
- The standalone clipboard no-op. Separate defect, separate plan — and that plan **ships first**, because
  a toast saying "copied to clipboard" over an empty clipboard is worse than no toast. See Cross-Subtask
  Reconciliation.
- The standalone memo verb fork (`bootstrap.ts:1638-1700` reimplements `memoLoad`/`memoSave`/`memoClear`/
  `memoGeneratePrompt` outside the provider). Those four arms never reach `VscodeHostUI`, so this plan's
  capture does not cover them; they are also a standing PRD contract #1 divergence. Pre-existing, known,
  out of scope for both subtasks.

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
12. **`_handleTerminalVerb` is not a single dispatch line — do not wrap it like the other six.**

    *(Correcting this plan's original text, which described a `delegatesAwait` long-poll answered from a
    `req.on('close')` handler. Neither symbol exists anywhere in `src/` at HEAD — `grep -rn
    "delegatesAwait" src/` and `grep -rn "req.on('close'" src/services/LocalApiServer.ts` are both
    empty. The hazard is real, but its shape is different:)*

    `_handleTerminalVerb` (`:1828`) is ~180 lines with **many hand-built exits** — it writes `503` for a
    missing dispatcher, `400` for a missing verb, `404` twice for unknown relay endpoints, `502` for a
    delivery failure, `500` on catch, and a hand-assembled `200 {success:true, delivered:to}` on the
    relay path. It also makes **nested verb calls inside one request** (`terminalVerb('ptyListTerminals',
    …)` then `terminalVerb('ptySendPrompt', …)`), plus the binary `ptyPasteImage` branch that bypasses
    JSON entirely.

    A single `_runVerbWithNotices` wrapper around "the dispatch line" therefore covers almost none of it,
    and notices raised by the nested calls would be captured into a store whose body is built by hand and
    never carries `__notices`. **Handling:** wrap only the terminal rail's normal JSON completion path,
    leave the binary and hand-built error exits on the native path, and confirm no captured notice is
    lost by asserting the wrapper is not entered for `ptyPasteImage`. If that proves awkward, exclude
    `_handleTerminalVerb` from this change entirely and cover the remaining six rails — terminal verbs
    are driven from the Terminals panel, whose feedback is the terminal output itself, so it is the
    lowest-value rail of the seven. **Excluding it is an acceptable outcome; a wrapper that silently eats
    notices is not.**

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

**Do NOT edit `createHeadlessHostSeams` in `hostServices.ts:371` (the UI literal at `:422-434`).** It has
zero callers (see Root cause 2); an edit there is dead code that will read like a completed fix to the
next auditor.

**Feature-level decision (made once, for both subtasks — do not re-litigate per plan): keep the function,
add a header comment.** Deleting it is tempting but it is referenced by name in four comments and a test
(`bootstrap.ts:664`, `:817`, `vscodeShim.ts:235`,
`tickets-auto-refresh-on-file-change.test.js:154`), all of which exist to explain that it is *not* the
injected bundle — deleting the function turns those into dangling references to a symbol that no longer
exists, which is a worse signpost than the one we have. So:

```ts
/**
 * NOT INJECTED ANYWHERE. Standalone uses `createVscodeHostSeams` + `vscodeShim.ts`
 * (bootstrap.ts:659). This bundle reads like the live headless implementation and
 * is not — editing it changes nothing at runtime. Kept only because several
 * comments and a test reference it by name to say exactly this.
 */
```

That header is the whole change to this file. The `[headless notification]` log line inside it stays
dead; see Verification step 10 for why it must not be used as evidence of anything.

### 5. `src/services/LocalApiServer.ts` — wrap the verb rails, attach `__notices`

One private helper, then a one-line change in each of the verb rails. Line numbers re-verified at HEAD
(2026-08-14 — all seven had drifted):

| Method | Line | Wrap? |
| :--- | ---: | :--- |
| `_handleTerminalVerb` | 1828 | **Special — see Edge Case 12.** Many hand-built exits + nested verb calls; wrap only the normal JSON path, or exclude |
| `_handleKanbanVerb` | 2008 | yes |
| `_handlePlanningVerb` | 2047 | yes (also serves `/project/verb/*` and `/memo/verb/*` — Edge Case 11) |
| `_handleTicketsVerb` | 2075 | yes |
| `_handleDesignVerb` | 2103 | yes |
| `_handleSetupVerb` | 2139 | yes |
| `_handleTaskViewerVerb` | 2183 | yes |

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

**This retires the `#sb-transport-error` element id — and one existing test pins it.** Every *caller*
keeps working (`showTransportError` survives as a wrapper), but the singleton node is replaced by
children of `#sb-transport-notices`. Checked at HEAD, `grep -rn "sb-transport-error" src/` returns three
hits: the two in `transport.js` this change rewrites, and

```js
// src/test/headless-feature-management-contract.test.js:405
assert.ok(transportSrc.includes("'sb-transport-error'"));
```

a **source-text** assertion that goes red the moment the id changes. Update it in the same commit to
assert on `'sb-transport-notices'` (or, better, on `showTransportError` being defined — the durable
contract is that the function exists, not the id it happens to use). No panel CSS or JS references the
id; it is created and styled entirely inline by `transport.js`, so test code is the only exposure. The
sibling subtask's new JSDOM test must likewise assert on behaviour rather than the id.

In the `postMessage` response handler, render notices before the failure fallback and let captured
errors replace it.

> ⚠️ **This handler is a shared surface.** The sibling subtask
> ("Finish the prompt-copy return-body retrofit") rewrites the clipboard block at the top of this same
> function and **lands first**. The snippet below shows the reconciled end-state *after* that plan.
> The clipboard lines are marked DO-NOT-TOUCH: pasting this plan's original draft — which showed the
> pre-retrofit `navigator.clipboard` call as `/* unchanged */` — would silently **revert** the sibling's
> entire client-side fix. Add only the notice block.

```js
.then(function (result) {
    // ─── OWNED BY THE SIBLING SUBTASK — DO NOT MODIFY ────────────────────────
    // The clipboard write does NOT happen here. The sibling claims the clipboard
    // synchronously ABOVE the fetch() call, because WebKit refuses a clipboard
    // write once the network turn has broken the user-gesture call stack. What
    // remains here is only the failure route and the key cleanup. Re-introducing
    // a write at this point silently re-breaks Safari.
    if (clipboardClaim) {
        clipboardClaim.catch(function (err) {
            console.warn('[transport] clipboard claim failed:', err);
            var text = pickCopyText(result);
            if (text) { offerManualCopy(text, err); }
        });
    }
    if (result && typeof result === 'object' && '__clipboard' in result) { delete result.__clipboard; }
    // ─────────────────────────────────────────────────────────────────────────

    // ─── ADDED BY THIS PLAN ──────────────────────────────────────────────────
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
    // ─────────────────────────────────────────────────────────────────────────

    if (result && typeof result === 'object' && result.success === false) {
        // PRESERVED VERBATIM — the quiet-list keeps `not-imported` misses from
        // popping a spurious toast. Losing it is a regression on a shipped fix.
        const EXPECTED_QUIET = new Set(['not-imported']);
        // `!sawHostError` is the ONLY change inside this block: a captured host
        // error already said this, so do not say it twice.
        if (!EXPECTED_QUIET.has(result.reason) && !sawHostError) {
            var text = result.error || ('Action failed: ' + verb);
            console.warn('[transport] verb failed:', verb, text);
            if (STATUS_MESSAGE_PANELS[panel]) {
                dispatchMessage({ type: 'showStatusMessage', message: text, isError: true });
            } else {
                showTransportError(text);
            }
        }
        // PRESERVED VERBATIM — a typed failure body still falls through to
        // dispatchMessage so the panel can clear its own loading state.
        if (typeof result.type !== 'string') { return; }
    }
    if (result && typeof result === 'object') { dispatchMessage(result); }
})
```

The diff this plan actually introduces inside the failure block is **one conjunct** (`&& !sawHostError`).
Everything else in it is existing behaviour reproduced so the edit is legible — if a coder's diff shows
more than that changing, they have rewritten the block instead of extending it.

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
- **JSDOM quiet-list guard:** feed `{ success: false, reason: 'not-imported', type: 'localTicketMiss' }`
  and assert **zero** notice nodes rendered *and* that `dispatchMessage` still ran. This is the
  behaviour an earlier draft of this plan deleted while restructuring the handler; a test is the only
  thing that stops it happening again on the next edit to this function.
- **JSDOM clipboard co-existence:** feed `{ success: true, prompt: 'abc', __notices: [{kind:'success',message:'Copied'}] }`
  and assert **both** that the clipboard write was attempted with `'abc'` and that one notice rendered.
  This is the regression net for the merge hazard in Cross-Subtask Reconciliation: if a coder re-pastes
  the pre-sibling clipboard block, the clipboard half of this assertion fails.
- Assert `__notices` is stripped from the body before `dispatchMessage` receives it.

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
10. **Standalone:** stop the extension, `npx switchboard` fresh, repeat step 9. Expect the same toast,
    **and** the prompt actually on the clipboard (the sibling subtask ships first — see Cross-Subtask
    Reconciliation).

    *Correcting this plan's original step 10, which asked the verifier to confirm the server log no
    longer prints `[headless notification] Diagram prompt copied to clipboard`.* That string exists at
    exactly one place in the tree — `src/standalone/hostServices.ts:428`, inside
    `createHeadlessHostSeams`, the bundle with **zero callers** that this plan's own Root Cause section
    warns against mistaking for the live path. It therefore never prints today, and "it still doesn't
    print" would pass whether or not the fix works. The step proved nothing; this plan fell into the
    trap it documents.

    **Replacement check:** with the standalone server running in a terminal, confirm the toast appears in
    the browser and that stdout shows no unhandled-notice `console.warn` from
    `_runVerbWithNotices` (Proposed Change 5) naming the verb. That warning is the real "notice was
    dropped" signal, and unlike the log line above it is reachable.
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
16. **Quiet-list regression:** trigger a `not-imported` miss (open a subtask ticket whose local file has
    not been downloaded) and confirm **no** toast appears while the panel still falls back to the live
    view. This is the behaviour an earlier draft of this plan silently deleted; it deserves its own step.

## Cross-Subtask Reconciliation

This plan and its sibling — **"Finish the prompt-copy return-body retrofit"** — both edit
`src/webview/transport.js`, and both touch `src/standalone/vscodeShim.ts` and
`src/services/sharedUtilityVerbs.ts`. The reconciled contract:

| Surface | Sibling (lands **first**) | This plan (lands **second**) |
| :--- | :--- | :--- |
| `transport.js` — **above** the `fetch()` | Adds a synchronous `ClipboardItem` claim (WebKit refuses post-`await` writes) | Does not touch it |
| `transport.js` clipboard block `:372-376` | **Removes the write from the `.then()`**; leaves `clipboardClaim.catch(...)` + key cleanup | **Do not touch.** Extend the handler below it; never re-paste the old lines — a write here re-breaks Safari |
| Manual-copy fallback surface | Adds it (required: Safari over a LAN address has no `navigator.clipboard` at all) | Must not collide with the notice stack — see below |
| `transport.js` `EXPECTED_QUIET` block | Untouched | Adds exactly one conjunct (`&& !sawHostError`); everything else preserved verbatim |
| `transport.js` error surface | Uses `showTransportError` as-is | Generalises it into a `#sb-transport-notices` stack; `showTransportError` survives as a wrapper |
| Reserved body keys | Adds `__clipboard` | Adds `__notices` — same `__` transport-private convention |
| `#sb-transport-error` id | Still exists; sibling's test must **not** assert on it | Retired — also update `headless-feature-management-contract.test.js:405` |
| `vscodeShim.ts` | Clipboard no-op `:292-295` stays a no-op | Edits `show*Message` `:133-135` — a different hunk, no conflict |
| `sharedUtilityVerbs.ts` `handleCopyDiagramPrompt` | Adds `prompt`, widens the signature | Reads it in a contract test; does not edit it |
| `hostServices.ts` `createHeadlessHostSeams` | Not edited | Header comment only (decision recorded in Proposed Change 4) |

**Why this plan ships second.** Landing it alone gives standalone a green "Diagram prompt copied to
clipboard" toast over an **empty** clipboard — a louder, more convincing version of the `Copied!` lie the
sibling exists to fix. Every toast this plan adds is only truthful once the body carries the prompt.
Landing both together is equally acceptable; landing this one first is not.

**Merge-order consequence.** Because the sibling rewrites the top of the same function, this plan's
`transport.js` edit should be applied to the post-sibling file rather than rebased mechanically — a
three-way merge will not catch a reverted clipboard block, since both sides are "valid" JavaScript.
Re-read `transport.js` before editing rather than trusting the snippet in Proposed Change 6.

**New surface collision introduced by the sibling's redesign — resolve it here.** The sibling's
manual-copy fallback is a fixed-position overlay carrying a focused `<textarea>`; this plan's notice
stack is a fixed-position overlay at `bottom:16px; left:50%` with `z-index:2147483647` and
`pointer-events:none`. Two constraints follow:

- **Never stack them at the same anchor.** A toast covering the textarea the user is being told to press
  `Cmd+C` in is a self-defeating UI. Give the manual-copy surface the bottom-centre anchor (it is
  interactive and needs focus) and move the notice stack out of its way while it is open — simplest
  correct approach: the manual surface sets a flag the notice stack reads to offset itself, or the stack
  renders above it in the same flex column.
- **`pointer-events:none` must not be inherited by the manual surface.** The notice stack is
  deliberately click-through; the manual surface must be clickable and focusable. They must not share a
  container, and the manual surface needs its own `pointer-events:auto`.

Whichever subtask lands second owns making these two coexist; since this plan lands second, it owns it.
Verification step 15 (Design/Connections spot-check) should be run with a forced copy failure so both
surfaces are on screen together at least once.

## Resolved Assumptions

**No web research is required for this plan. Treat this section as authoritative — do not re-open it.** Everything it asserts about this repo — the shim's live
paths, the zero-caller dead bundle, the call-site counts, the seven verb rails and their line numbers,
the `EXPECTED_QUIET` block, the existing `sb-transport-error` test assertion, the webpack target and
version — was verified against HEAD by reading the code.

Two items were considered and deliberately **not** escalated:

- **`AsyncLocalStorage` propagation.** ALS propagates across `await`, promise chains, and timer/immediate
  callbacks by definition, and `sql.js` is synchronous WASM (a synchronous call cannot lose the context).
  There is no propagation gap to research. If a future arm introduces a genuinely untracked async
  boundary, `captureNotice` returns `false` and the notice falls back to the native path — a degradation,
  never a lost notice, by the `closed`-flag design in Proposed Change 1.
- **webpack externalising `node:async_hooks`.** A one-line build check, not a research question: both
  bundles set `target: 'node'` and the repo is on webpack `^5.105.4`, which resolves `node:`-prefixed
  builtins natively. Confirm on the first `npm run compile`; the fallback is `require('async_hooks')`
  with no design impact. Tracked in the Verification Plan, not here.

The sibling subtask *does* carry two genuinely external browser-behaviour uncertainties (WebKit clipboard
permissions and `execCommand` viability). They are recorded in its own plan and the user has been advised
to research them there — they do not affect this plan's design.
