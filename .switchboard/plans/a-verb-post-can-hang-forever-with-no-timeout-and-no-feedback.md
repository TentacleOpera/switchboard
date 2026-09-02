# A verb POST has no timeout, so a stalled request is indistinguishable from a working one — forever, with no log and no UI change

## Goal

Bound every verb request the browser transport makes, and make a request that does not
complete **visible** — to the operator as a failed action it can retry, and to the console as
a diagnosable event. Today an unresolved POST is silent and permanent: the button appears
dead, no error is logged, and only a page reload restores the panel.

This plan fixes the **feedback defect**. It does not claim to fix the underlying stall (see
*Non-goals*) — but it is the change that will identify it.

### Problem Analysis

**The reported symptom.** Over the tailnet in Chrome, the "copy prompt" buttons and the kanban
status messages stop working together, intermittently. A page reload restores them. Reported
2026-09-01.

**Both symptoms share one code path, and it is HTTP — not the WebSocket.** The browser
transport sends every verb as a `fetch` POST (`src/webview/transport.js:365`). The clipboard
write happens in that response chain (`:373`), and so does the status-message dispatch
(`:390`). One unresolved request starves both. This is the whole explanation for why they
fail as a pair.

**The chain has a `.catch()`, and that is the key evidence.** `:412` logs
`[transport] postMessage fetch failed:` via `console.error`. So a request that **rejects**
leaves a trace. A failure that leaves *no* trace is therefore not a rejection — it is a
request that never settles at all.

**And nothing bounds it.** There is no `AbortController`, no `signal`, no timeout on that
fetch. A stalled POST stays pending indefinitely: the `.then()` never runs, the `.catch()`
never runs, no clipboard write, no status message, no log, no UI change. The panel is not
broken — it is waiting, forever, and says nothing.

**The codebase already learned this lesson one layer down.** `transport.js:182-192` carries a
comment that an unhealthy socket can hang "minutes to hours", that "Firefox self-heals here at
~20s (`network.websocket.timeout.open`); Chromium" does not — which is why
`HANDSHAKE_TIMEOUT_MS` exists for the WebSocket handshake. **The same reasoning was never
applied to the HTTP verb path.** That is the gap this plan closes.

**Operator-supplied constraints (2026-09-01), which narrow the cause but do not settle it:**

- **It never happens on a local Switchboard — only against the remote server.** Loopback has
  no path that can go stale mid-connection; a tailnet path does.
- **The session does not die.** A 401 starving the response chain is ruled out.
- **A reload gets it working again** — consistent with fresh connections being opened, though
  a reload also coincides with time passing, so it is suggestive rather than conclusive.

**The leading hypothesis, recorded as a hypothesis.** A POST issued on a stale keep-alive
connection whose network path changed underneath it stalls rather than failing. That fits
remote-only, silent, both-symptoms and reload-recovers. **It is unverified**, and this plan
deliberately does not depend on it: an unbounded request in an interactive UI is a defect
whatever makes it hang.

**Why the panel recovers without a reload after abort.** When `AbortController.abort()` fires
on a fetch stalled on a stale keep-alive connection, the browser closes that TCP connection
(it is not returned to the keep-alive pool). The next fetch opens a fresh connection. This is
why the UAT check "the panel keeps working afterwards without a reload" is expected to hold —
it is not wishful thinking, it is the documented behavior of fetch abort: the underlying
connection is terminated, not recycled.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, ux, bugfix, reliability
- **Files touched:** `src/webview/transport.js`, `src/test/verb-transport-timeout-contract.test.js` (new file)
- **Risk:** Medium, and it lives entirely in the timeout value. Too aggressive and legitimate
  slow verbs are aborted mid-flight, which is a worse bug than the one being fixed. The
  two-stage design below exists specifically to avoid trading one failure for another.

## User Review Required

None. The two-stage timing below is a decision, not a question: a "still working" signal at
5 s and an abort at 60 s.

## Non-goals

- **This does not fix whatever makes the request stall.** It converts an invisible permanent
  hang into a visible, retryable, logged failure. If the stall has a root cause worth removing,
  the diagnostics added here are what will name it.
- **This does not touch the WebSocket backoff.** `maxReconnectDelay` of 30 s with no connection
  indicator is a real and separate defect affecting live push updates. It is not the cause of
  the reported symptom — verbs do not travel over the socket — and merging the two would make
  both harder to verify.
- **This does not change the emitted origin.** See
  `the-tailnet-url-never-offers-a-secure-origin.md`, which is justified by Home Screen install
  and explicitly disclaims this bug.
- **No retry-on-abort.** A verb is not known to be idempotent; silently re-POSTing a dispatch
  could double-dispatch. Surface the failure and let the operator choose.

## Complexity Audit

### Routine

- Adding an `AbortController` and `signal` to a single `fetch()` call (`:365-370`).
- Naming two timeout constants next to `HANDSHAKE_TIMEOUT_MS` (`:61`).
- Distinguishing `AbortError` from network failure in the existing `.catch()` (`:415-417`).
- Adding diagnostic fields to the catch's `console.error` call.
- Writing a source-level contract test that asserts every `fetch(` in `transport.js` has a
  `signal` property (same pattern as `tailscale-bind-contract.test.js`).

### Complex / Risky

- **The still-waiting signal is a new UI state that must clear on every exit path.** A stuck
  "Working…" indicator reproduces the original defect with a spinner attached. Four exit paths
  must clear it: success, typed failure, untyped failure, and abort.
- **Timer arming ordering.** The `PANEL_SWITCH_VERBS` early return (`:357`) exits before the
  fetch. Timers must be armed AFTER that guard, not before, or a switch verb arms a timer it
  will never clear.
- **The catch handler needs new UI surfacing wiring.** The existing catch (`:415-417`) only
  logs — it does not call `showTransportError` or `showStatusMessage`. The surfacing functions
  exist (`:325-343`, `:386-392`) but are wired to the `.then()` chain, not the catch. Extending
  the catch to call them is new wiring, not "one line of existing UI."

## Edge-Case & Dependency Audit

1. **Legitimately slow verbs.** Dispatch and large plan fetches can exceed 5 s. That is why 5 s
   only *signals* and 60 s aborts. Before shipping, measure the slowest verb on the home lab
   and confirm 60 s clears it with margin; raise the constant if not.
2. **Abort must not be reported as a server failure.** `err.name === 'AbortError'` is a client
   timeout and must read differently from a rejected request, or the operator will chase the
   server for a network problem.
3. **The still-waiting signal must clear on every exit path** — success, typed failure, untyped
   failure, and abort. A stuck "working…" indicator would reproduce the original defect with a
   spinner attached.
4. **`PANEL_SWITCH_VERBS` returns early** (`:357`) without issuing a fetch. It must not arm a
   timer it will never clear. Arm the controller and timers AFTER the early-return guard.
5. **Concurrent verbs.** Multiple POSTs can be in flight; each needs its own controller and
   timer. A single shared controller would abort unrelated requests.
6. **The clipboard write is already independently caught** (`:374`) and must stay that way — a
   clipboard failure is a quality-of-life issue and must not be conflated with a transport
   failure.
7. **`credentials: 'same-origin'` is unchanged.** This plan does not touch auth, the session
   cookie, or the origin.

## Composition Roots — both hosts

`src/webview/transport.js` is the **browser/standalone transport shim**: it installs
`window.acquireVsCodeApi` (`:21`, `:431`) so panels written for the editor run unmodified in a
browser. In the extension the real VS Code webview API is used and the provider pushes
responses back over `postMessage` — there is no `fetch`, so there is no unbounded request and
nothing to bound.

**Verified 2026-09-01.** The extension's verb path uses `onDidReceiveMessage`
(`KanbanProvider.ts:1766`, `PlanningPanelProvider.ts:697`, `DesignPanelProvider.ts:711`,
`SetupPanelProvider.ts:248`, `TicketsPanelProvider.ts:1186`, `ConnectionsPanelProvider.ts:86`)
— the VS Code webview message channel. The webview's `postMessage` is fire-and-forget; the
provider pushes results back asynchronously via `webview.postMessage()`. The webview never
awaits a response — it listens for incoming messages via `window.addEventListener('message',
...)`. There is no unbounded request pattern. The extension does not have this bug.

**So this defect is standalone-only by construction, not by omission** — and the composition-root
diff confirms it. No extension-side change is needed. The finding is recorded here so the next
reader does not re-derive it.

## Dependencies

None. This plan is self-contained — it touches only `src/webview/transport.js` and adds one
new test file. No other plan or session must complete first.

## Adversarial Synthesis

Key risks: the still-waiting signal is a new UI state that must clear on all four exit paths or
it reproduces the original defect with a spinner; the catch handler needs new UI surfacing
wiring (the existing catch only logs, it does not call `showTransportError`/`showStatusMessage`);
timer arming must occur after the `PANEL_SWITCH_VERBS` early-return guard. Mitigations: name
both timeout constants (`VERB_SIGNAL_TIMEOUT_MS`, `VERB_ABORT_TIMEOUT_MS`), clear all timers
and the pending signal on every exit path, specify the signal surface as a `showTransportPending`
companion to `showTransportError` using the same fixed-position div pattern.

## Proposed Changes

### `src/webview/transport.js`

**Context.** The `postMessage` function in the `vscodeShim` object (`:345-418`) sends every
verb as an unbounded `fetch` POST. The `.then()` chain handles success and typed failures
(`:371-414`); the `.catch()` (`:415-417`) only logs. There is no timeout, no abort, no
in-flight indicator, and no UI surfacing on catch.

**Logic.**

**1. Add two named timeout constants next to `HANDSHAKE_TIMEOUT_MS` (`:61`).**

```javascript
const VERB_SIGNAL_TIMEOUT_MS = 5000;   // "still working" signal — no abort
const VERB_ABORT_TIMEOUT_MS = 60000;   // hard abort — bounds the wait
```

Both must be named constants, not literals. 5 s sits inside the normal verb latency; 60 s
sits well clear of legitimately slow verbs (dispatch, plan fetches) while being finite.

**2. Add a `showTransportPending` / `clearTransportPending` pair.**

A `showTransportPending(verb)` function using the same fixed-position div pattern as
`showTransportError` (`:325-343`), with neutral styling (muted background, not red). Shown at
5 s via `VERB_SIGNAL_TIMEOUT_MS`. Cleared on every exit path via `clearTransportPending()`.

```javascript
function showTransportPending(verb) {
    let host = document.getElementById('sb-transport-pending');
    if (!host) {
        host = document.createElement('div');
        host.id = 'sb-transport-pending';
        host.style.cssText =
            'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);' +
            'z-index:2147483647;max-width:80vw;padding:10px 16px;border-radius:4px;' +
            'background:#1a1a2e;color:#a0a0c0;border:1px solid #444466;' +
            'font-size:12px;line-height:1.4;' +
            'font-family:var(--font-family, var(--font, system-ui, sans-serif));' +
            'white-space:pre-wrap;pointer-events:none;';
        (document.body || document.documentElement).appendChild(host);
    }
    host.textContent = 'Working: ' + verb + '…';
    host.style.display = 'block';
}

function clearTransportPending() {
    const host = document.getElementById('sb-transport-pending');
    if (host) { host.style.display = 'none'; }
}
```

> **Superseded:** "No new UI component, no banner, no modal. The defect is silence, and the
> cure is one line of existing UI, not a new surface."
> **Reason:** The still-waiting signal at 5 s IS a new UI state — `showTransportError` and
> `showStatusMessage` are error surfaces, not neutral "in flight" indicators. The failure
> surfacing (change #3) correctly reuses existing functions, but the in-flight signal needs
> its own minimal surface. "One line of existing UI" also understates the catch-handler work:
> the existing `.catch()` only logs; it must be extended with abort detection, diagnostic
> logging, and UI surfacing — three concerns, not one line.
> **Replaced with:** A `showTransportPending`/`clearTransportPending` pair using the same
> fixed-position div pattern as `showTransportError`, plus new wiring in the catch handler to
> call the existing `showTransportError`/`showStatusMessage` functions.

**3. Bind every verb POST to an `AbortController`, two-stage, armed AFTER the `PANEL_SWITCH_VERBS` guard.**

Inside `postMessage`, after the `PANEL_SWITCH_VERBS` early-return check (`:357-360`) and before
the `fetch` (`:365`):

```javascript
const controller = new AbortController();
const startTime = Date.now();
let signalTimer = null;
let abortTimer = null;

signalTimer = setTimeout(function () {
    showTransportPending(verb);
}, VERB_SIGNAL_TIMEOUT_MS);

abortTimer = setTimeout(function () {
    controller.abort();
}, VERB_ABORT_TIMEOUT_MS);
```

Pass `signal: controller.signal` into the `fetch` options (`:365-370`).

**4. Clear timers and pending signal on all four exit paths.**

In the `.then()` chain (success and typed/untyped failure paths, `:371-414`) and in the
`.catch()` (`:415-417`), clear both timers and the pending signal:

```javascript
function cleanupVerbTimers() {
    if (signalTimer) { clearTimeout(signalTimer); signalTimer = null; }
    if (abortTimer) { clearTimeout(abortTimer); abortTimer = null; }
    clearTransportPending();
}
```

Call `cleanupVerbTimers()` at the top of the `.then()` handler and at the top of the
`.catch()` handler. This covers all four exit paths: success (`.then()` resolves), typed
failure (`.then()` with `result.success === false`), untyped failure (`.then()` with no
`result.type`), and abort/network failure (`.catch()`).

**5. Make the abort diagnosable and surface it in the catch handler.**

> **Superseded:** The `.catch()` at `:415-417` only calls `console.error` — no UI surfacing.
> **Reason:** The plan's Proposed Change #3 says "surface it through the mechanism that
> already exists for failed verbs — `showStatusMessage` for panels in `STATUS_MESSAGE_PANELS`,
> `showTransportError` otherwise (`transport.js:386-392`)." But `:386-392` is inside the
> `.then()` chain, not the `.catch()`. The existing catch does not call either function. The
> catch handler must be extended to call them — this is new wiring, not existing behavior.
> **Replaced with:** The catch handler distinguishes `AbortError` from network failure, logs
> the diagnostic payload, and calls `showTransportError`/`showStatusMessage` to surface the
> failure to the operator.

Replace the `.catch()` (`:415-417`) with:

```javascript
.catch(function (err) {
    cleanupVerbTimers();
    const elapsed = Date.now() - startTime;
    if (err && err.name === 'AbortError') {
        console.error('[transport] verb timed out:', verb,
            'elapsed=' + elapsed + 'ms',
            'onLine=' + navigator.onLine,
            'wsReadyState=' + (ws ? ws.readyState : 'null'));
        const text = 'Action timed out: ' + verb + ' (' + elapsed + 'ms). Retry.';
        if (STATUS_MESSAGE_PANELS[panel]) {
            dispatchMessage({ type: 'showStatusMessage', message: text, isError: true });
        } else {
            showTransportError(text);
        }
    } else {
        console.error('[transport] postMessage fetch failed:', verb, err,
            'elapsed=' + elapsed + 'ms',
            'onLine=' + navigator.onLine,
            'wsReadyState=' + (ws ? ws.readyState : 'null'));
        const text = 'Action failed: ' + verb;
        if (STATUS_MESSAGE_PANELS[panel]) {
            dispatchMessage({ type: 'showStatusMessage', message: text, isError: true });
        } else {
            showTransportError(text);
        }
    }
});
```

The diagnostic payload includes: verb name, elapsed time, `navigator.onLine`, and WS
`readyState`. The WS readyState tells the next debugger whether the whole network path was
dead or just the HTTP path — one extra field, zero cost.

**Edge Cases.**
- `PANEL_SWITCH_VERBS` early return (`:357`): timers are armed AFTER this guard, so a switch
  verb never arms a timer.
- Concurrent verbs: each call to `postMessage` creates its own `controller`, `signalTimer`,
  and `abortTimer` — no shared state.
- Clipboard write (`:374`): independently caught, unchanged. A clipboard failure does not
  trigger the transport catch.
- `credentials: 'same-origin'`: unchanged. No auth or session change.

### `src/test/verb-transport-timeout-contract.test.js` (new file)

**Context.** A source-level contract test in the same shape as
`tailscale-bind-contract.test.js` — reads the source and asserts structural invariants. Does
not start a server or require a browser.

**Logic.** Assert:

1. **Every `fetch(` in `transport.js` is constructed with a `signal` property.** This is the
   regression guard: the defect was an omission, and only a structural assertion prevents the
   next one.
2. **`VERB_SIGNAL_TIMEOUT_MS` and `VERB_ABORT_TIMEOUT_MS` constants exist** in `transport.js`,
   as named constants (not literals).
3. **The `.catch()` handler calls `showTransportError` or dispatches `showStatusMessage`** —
   not just `console.error`. This guards against the catch silently regressing back to
   log-only.
4. **`AbortError` is distinguished from other errors** in the catch (`err.name ===
   'AbortError'` or equivalent).

## Verification Plan

### Automated Tests

1. **Unit — a request that never settles aborts at the constant** and the `.catch()` receives
   an `AbortError`, with the verb name and elapsed time in the log payload.
2. **Unit — a fast verb never signals and never aborts**; timers are cleared on all four exit
   paths (success, typed failure, untyped failure, abort).
3. **Contract — no unbounded `fetch` in the transport.** Assert every `fetch(` in
   `transport.js` is constructed with a `signal`. This is the regression guard: the defect was
   an omission, and only a structural assertion prevents the next one.
4. **Contract — the catch handler surfaces failures to the UI.** Assert the catch calls
   `showTransportError` or dispatches `showStatusMessage`, not just `console.error`.

### Goal Invariants

- Assert `src/webview/transport.js` contains a `VERB_ABORT_TIMEOUT_MS` constant whose value is
  numeric and finite.
- Assert every `fetch(` call in `src/webview/transport.js` includes `signal:` in its options
  object.
- Assert the `.catch()` handler in `transport.js` contains a reference to `showTransportError`
  or `showStatusMessage` (i.e., the catch surfaces to the UI, not just logs).
- Assert `src/webview/transport.js` contains `AbortController` (i.e., the abort mechanism is
  present, not just the constant).

### Manual UAT

5. **Standalone UAT (home lab, over the tailnet).** Block the server mid-verb (stop the
   process, or drop the port with a firewall rule) and confirm: the panel signals at 5 s,
   reports a retryable failure at 60 s, logs the diagnostic line, and — critically — **the
   panel keeps working afterwards without a reload.** The panel recovers because
   `AbortController.abort()` closes the stale TCP connection (it is not returned to the
   keep-alive pool), so the next fetch opens a fresh connection.
6. **Extension.** The composition-root diff (recorded above) confirms the extension has no
   equivalent unbounded wait — its verb path is event-driven via `onDidReceiveMessage`, not
   HTTP fetch. No extension-side change needed.

## Settled — do not re-raise

Three theories were investigated and killed on evidence 2026-09-01. Do not revive them on a
future report of this symptom:

- **Missing `clipboardFallback.js`.** The shim injects correctly on real panel routes
  (`/terminals` serves `sharedDefaults.js`, `clipboardFallback.js`, `transport.js` in order),
  and `window.sbCopyToClipboard` has 28 call sites. The un-injected marker at
  `/static/webview/kanban.html` is the raw static path, which the shell does not load.
- **`execCommand` gesture expiry on an insecure origin.** The operator is on Chrome
  (~5 s activation window) and the round trip is 180 ms. A structural rule would fail every
  time, not intermittently.
- **The WebSocket backoff.** Real defect, wrong bug. **Verbs are HTTP POSTs**, so a dead socket
  cannot break a copy button.

And one ruled out by the operator directly: **the session does not die**, so a 401 starving the
response chain is not the cause.

---

**Recommendation:** Complexity 3 → Send to Intern.
