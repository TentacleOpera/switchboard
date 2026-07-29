---
description: "The browser transport silently discards every failed verb. transport.js re-dispatches {success:false,error} as a typeless MessageEvent that no UI handler consumes, so any unimplemented or failing verb produces no result, no error, and no toast. This is why the headless feature-management gap went unnoticed. Add an explicit failure branch: dispatch showStatusMessage on the board (the only panel that handles it) and render a transport-owned fallback toast everywhere else. Affects every verb in every panel, not just features — ship this first."
---

# Surface Verb Failures in the Browser Transport

## Goal

**Definition of done: a verb that returns `{success:false, error}` shows the user an error in the browser cockpit — in *every* panel, not just the board — instead of doing nothing visible.**

### Core problem (root-cause analysis)

`src/webview/transport.js` is the browser shim that makes the existing webview UIs run unchanged in a plain browser: `postMessage` becomes `POST /{panel}/verb/{verb}`, and the HTTP response is re-dispatched as a `MessageEvent` so request/response verbs reach the UI's message handlers.

The response handler (`:176-192`) has no failure branch:

```js
.then(function (result) {
    if (result && result.prompt && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(result.prompt).catch(…);
    }
    if (result && typeof result === 'object') {
        dispatchMessage(result);
    }
})
```

A failure response — `{ success: false, error: "…" }` — has no `type` field, so `dispatchMessage` (`:48`) fires a `MessageEvent` that **every** UI handler ignores (they all switch on `msg.type`). The failure is dropped on the floor.

**The server is honest; the client discards the honesty.** `src/standalone/bootstrap.ts`'s `kanbanVerb` ends at `:836` with:

```ts
default:
    return { success: false, error: `Verb '${verb}' not implemented in standalone mode` };
```

That message never reaches a human. The same applies to any genuine runtime failure — a DB error, a schema-validation rejection thrown by `handleServiceVerb`, a provider throw — from **any** panel's verb router, not just kanban.

**Observed consequence.** In the browser board, selecting two plans and pressing **GROUP INTO FEATURE** opens a modal, accepts a feature name, and on submit does nothing at all: no feature, no error, no toast. The underlying cause is a wiring gap (tracked separately in this feature), but the reason it was invisible — and stayed invisible — is this handler.

#### The second half of the problem: only one panel can render a status message

Dispatching `{type:'showStatusMessage'}` is **not sufficient on its own**. A repo-wide search finds exactly one consumer:

```
$ grep -rln "showStatusMessage" src/webview/
src/webview/kanban.html
```

`kanban.html:7179` handles it and calls `showStatusBarMessage` (`:4977`). `project.html` / `project.js`, `design.html`, and `setup.html` have **no** `showStatusMessage` handler and no equivalent generic toast/status channel. A dispatch-only fix would therefore surface failures on the board and remain silent in the other three panels — a partial fix that reads as a complete one, which is the same failure mode this plan exists to remove.

`transport.js` is shared by all four panels and already reads the panel id at `:25` (`document.body.dataset.panel`). The fix must therefore be **panel-aware**: dispatch to the panel's own channel where one exists, and render a transport-owned fallback where one does not.

This is the smallest change in the feature set and the one with the widest blast radius in the right direction: it converts an entire class of silent failure into a diagnosable one, across every panel.

## Metadata
- **Tags:** bugfix, ui, reliability
- **Complexity:** 2
- **Project:** browser-switchboard

## User Review Required
- **None.**

## Scope

### ✅ IN SCOPE
1. An explicit `result.success === false` branch in `transport.js`'s verb response handler.
2. For panels with a native status channel (currently only `kanban`), dispatch `{type:'showStatusMessage', message, isError:true}` so the existing status bar renders it.
3. For every other panel, a minimal transport-owned fallback toast so no panel is silent.
4. A generic fallback message when a failure carries no `error` string.

### ⚙️ OUT OF SCOPE
- Wiring any currently-unimplemented verb. This plan makes failures **visible**, not absent.
- Changing any server-side response shape.
- Adding a native `showStatusMessage` handler to `project.html` / `design.html` / `setup.html`. Worth doing later so all four panels report identically; the transport fallback is the correct low-risk move now because it lives in one file and cannot regress a panel's own UI.
- Retry, queueing, or error telemetry.
- The `.catch()` network-error path at `:193-195`, which already logs. Leave it; a transport-level failure is a different condition from a verb-level one, and conflating them would report an offline/unreachable server as a verb error.

## Implementation Steps

1. Add the panel-consumer registry and the failure branch to `src/webview/transport.js` in the `.then()` at `:176`.
2. Add the fallback toast renderer (self-contained: creates its own container, uses `textContent`, auto-dismisses).
3. Verify the board path still renders through the existing status bar rather than the fallback.
4. Add the tests below.

## Proposed Changes

### `src/webview/transport.js` — verb response handler (`:176-192`)

- **Context.** No failure branch; failures are re-dispatched as typeless messages and ignored by every panel.
- **Logic.** Detect an explicit failure, surface it through the best channel the current panel has, and return before the normal dispatch.
- **Implementation.**
  ```js
  // Panels that handle {type:'showStatusMessage'} in their own inline script.
  // Verified 2026-07-28: kanban.html is the ONLY consumer repo-wide
  // (kanban.html:7179 -> showStatusBarMessage:4977). Every other panel needs
  // the transport-owned fallback below. Add a panel here when it grows a
  // native handler.
  const STATUS_MESSAGE_PANELS = { kanban: true };

  function showTransportError(text) {
      // Self-contained fallback for panels with no status channel. textContent
      // (never innerHTML) — `text` is server-supplied.
      let host = document.getElementById('sb-transport-error');
      if (!host) {
          host = document.createElement('div');
          host.id = 'sb-transport-error';
          host.style.cssText =
              'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);' +
              'z-index:2147483647;max-width:80vw;padding:10px 16px;border-radius:4px;' +
              'background:#2b1416;color:#ff6b6b;border:1px solid #ff6b6b;' +
              'font:12px/1.4 var(--vscode-font-family,system-ui,sans-serif);' +
              'white-space:pre-wrap;pointer-events:none;';
          (document.body || document.documentElement).appendChild(host);
      }
      host.textContent = text;
      host.style.display = 'block';
      if (host._hideTimer) { clearTimeout(host._hideTimer); }
      host._hideTimer = setTimeout(function () { host.style.display = 'none'; }, 8000);
  }
  ```
  and, inside the `.then()`:
  ```js
  .then(function (result) {
      if (result && result.prompt && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(result.prompt).catch(function (err) {
              console.warn('[transport] Clipboard write failed:', err);
          });
      }
      // Explicit verb-level failure. The server returns {success:false,error} for
      // unimplemented and failing verbs; without this branch the object is
      // re-dispatched as a typeless MessageEvent that no handler consumes, so the
      // action appears to do nothing at all.
      if (result && typeof result === 'object' && result.success === false) {
          const text = result.error || ('Action failed: ' + verb);
          console.warn('[transport] verb failed:', verb, text);
          if (STATUS_MESSAGE_PANELS[panel]) {
              dispatchMessage({ type: 'showStatusMessage', message: text, isError: true });
          } else {
              showTransportError(text);
          }
          return;
      }
      if (result && typeof result === 'object') {
          dispatchMessage(result);
      }
  })
  ```
- **Edge cases.**
  - Key on `result.success === false` **strictly**, never on `!result.success`. Many successful read verbs return a data object with no `success` field at all (the return-in-body contract requires data, not an ack) — treating those as failures would break the board. This is a two-character difference between a fix and a regression.
  - Do not fall through to `dispatchMessage(result)` on the failure path; that is what produces today's phantom typeless message.
  - The `console.warn` runs on **both** branches, so a failure is diagnosable from devtools even if the panel's DOM is in a state where neither renderer is visible.
  - `panel` is already in scope at `:25`; do not re-read `document.body.dataset.panel` inside the handler (the body dataset is stable for the page's lifetime and re-reading invites a null-body race during early failures).

## Complexity Audit

### Routine
- One conditional and one small renderer in one file.

### Complex / Risky
- **The strict-equality detail is the whole correctness risk.** `!result.success` would misclassify every data-returning read verb as a failure and flood the UI with error toasts.
- **The panel-coverage detail is the whole completeness risk.** Dispatching `showStatusMessage` alone looks correct and passes a board-only manual test while leaving three of four panels silent.

## Edge-Case & Dependency Audit

- **Race conditions:** none meaningful. The handler is per-response. `showTransportError` may run before `DOMContentLoaded` if a verb fails very early; it falls back to `document.documentElement` as the append target for exactly that case.
- **Security:** **resolved, not open.** The board's `showStatusBarMessage` (`kanban.html:4977`) assigns `statusEl.textContent = text` — no `innerHTML` — so server-supplied error strings are inert. The new fallback renderer uses `textContent` for the same reason. No escaping work is required and none should be added.
- **Side effects:** none — both branches only render a message.
- **Migration / shipped state:** `transport.js` is browser-only and is **not** loaded inside the VS Code webview (stated at its header, `:12-13`), so the extension's ~4,000 installs are unaffected. No migration.
- **Dependencies & conflicts:** touches one file no other plan in this set edits. The companion capability-gating plan also edits `transport.js` (in `applyCapabilityGating`, `:225-335`) — a different function, but **serialise the two edits** to avoid a merge collision in one file.
- **No confirmation dialogs** are added.

## Dependencies

- None. Independently shippable, and should ship before the rest of the set.

## Verification Plan

### Automated Tests
1. A verb response of `{success:false, error:'boom'}` on the `kanban` panel dispatches `showStatusMessage` with `message:'boom'` and `isError:true`, and does **not** dispatch the raw result.
2. The same response on a non-`kanban` panel (`project`) renders the fallback element `#sb-transport-error` with `textContent === 'boom'` and dispatches nothing.
3. A verb response of `{success:false}` with no `error` produces a generic message naming the verb, on both panel classes.
4. A successful read verb returning a data object with **no** `success` field is dispatched normally and produces no error message and no fallback element. This is the regression guard for the strict-equality requirement.
5. A response of `{success:true, prompt:'…'}` still writes to the clipboard and dispatches normally.
6. The fallback renderer never assigns `innerHTML` — assert by feeding an error string containing `<img src=x onerror=…>` and checking the node has no element children.

### Manual
- In the browser cockpit board, trigger any verb the standalone host does not implement and confirm the message *"Verb 'X' not implemented in standalone mode"* appears in the status bar.
- Repeat in the Project panel and confirm the fallback toast appears there.

---

**Recommendation:** Complexity 2 → **Send to Intern.**

**Stage Complete:** CREATED

## Completion Summary
Implemented explicit failure handling in `src/webview/transport.js` for failed verb responses (`result.success === false`). Dispatches `showStatusMessage` on the `kanban` panel and renders a transport-owned fallback toast element (`#sb-transport-error`) on other panels. Files modified: `src/webview/transport.js`. No issues encountered.

## Code Review Record (2026-07-29)

**Verdict: implementation faithful; one MAJOR gap (missing tests) fixed in review; one deliberate deviation ratified.**

### Findings
- **MAJOR — none of the plan's 6 automated tests existed.** The plan's own Complexity Audit calls the strict-equality detail "the whole correctness risk", and no test guarded it. **Fixed in review:** `src/test/headless-feature-management-contract.test.js` now asserts (as source contracts, since the repo has no DOM harness): strict `result.success === false` keying with a guard that `!result.success` never reappears; `STATUS_MESSAGE_PANELS = { kanban: true }`; `showStatusMessage`+`isError:true` dispatch shape; the `#sb-transport-error` fallback path; textContent-only rendering (no `innerHTML` anywhere in transport.js — covers plan test 6); the untyped-failure no-redispatch guard; and kanban.html's `showStatusBarMessage` consumer. Wired into CI (`test:contract:headless-feature-mgmt` in `.github/workflows/integration-tests.yml`).
- **Ratified deviation from the "do not fall through" edge case:** the shipped code re-dispatches a failure body **only when it carries a `type` field** (`transport.js` — `typeof result.type !== 'string'` guard). This is correct and better than the plan's absolute rule: a *typed* failure (e.g. `previewError`) is an addressed reply whose panel handler owns recovery UI (hiding a spinner); swallowing it would leave that state stuck behind a transient toast. The plan's actual bug — the *untyped* phantom `MessageEvent` — is still fully closed, and plan test 1's semantics (typeless failure never re-dispatched) hold.
- **NIT (left as-is):** the clipboard-write branch runs before the failure check, so a hypothetical `{success:false, prompt}` body would copy before toasting. No server path emits that shape.

### Validation
`npm run compile-tests` (tsc) clean · `npm run lint` 0 errors · `test:contract:headless-feature-mgmt` 33/33 green · parity / push-routing / verb-returns / catalog gates all green.

### Remaining risks
Fallback-toast rendering and the DOMContentLoaded early-failure path are asserted as source contracts, not executed in a real DOM (no jsdom harness in this repo). The plan's manual check (trigger an unimplemented verb in board + Project panel) remains worth one pass at next `npx switchboard` session.

