---
description: "The browser transport silently discards every failed verb. transport.js re-dispatches {success:false,error} as a typeless MessageEvent that no UI handler consumes, so any unimplemented or failing verb produces no feature, no error, and no toast. This is why the headless feature-management gap went unnoticed. Add an explicit failure branch routing error to the status-message channel. Affects every verb, not just features — ship this first."
---

# Surface Verb Failures in the Browser Transport

## Goal

**Definition of done: a verb that returns `{success:false, error}` shows the user an error in the browser cockpit instead of doing nothing visible.**

### Core problem (root-cause analysis)

`src/webview/transport.js` is the browser shim that makes the existing webview UIs run unchanged in a plain browser: `postMessage` becomes `POST /{panel}/verb/{verb}`, and the HTTP response is re-dispatched as a `MessageEvent` so request/response verbs reach the UI's message handlers.

The response handler (`:176-189`) has no failure branch:

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

A failure response — `{ success: false, error: "…" }` — has no `type` field, so `dispatchMessage` fires a `MessageEvent` that **every** UI handler ignores (they all switch on `msg.type`). The failure is dropped on the floor.

**The server is honest; the client discards the honesty.** `src/standalone/bootstrap.ts`'s `kanbanVerb` ends with:

```ts
default:
    return { success: false, error: `Verb '${verb}' not implemented in standalone mode` };
```

That message never reaches a human. The same applies to any genuine runtime failure — a DB error, a validation rejection, a provider throw — from **any** panel's verb router, not just kanban.

**Observed consequence.** In the browser board, selecting two plans and pressing **GROUP INTO FEATURE** opens a modal, accepts a feature name, and on submit does nothing at all: no feature, no error, no toast. The underlying cause is a wiring gap (tracked separately), but the reason it was invisible — and stayed invisible — is this handler.

This is the smallest change in the feature set and the one with the widest blast radius in the right direction: it converts an entire class of silent failure into a diagnosable one.

## Metadata
- **Tags:** bugfix, ui, reliability
- **Complexity:** 2
- **Project:** browser-switchboard

## User Review Required
- **None.**

## Scope

### ✅ IN SCOPE
1. An explicit `result.success === false` branch in `transport.js`'s verb response handler that surfaces `result.error` through the existing status-message channel.
2. A generic fallback message when a failure carries no `error` string.

### ⚙️ OUT OF SCOPE
- Wiring any currently-unimplemented verb. This plan makes failures **visible**, not absent.
- Changing any server-side response shape.
- Retry, queueing, or error telemetry.
- The `.catch()` network-error path at `:190-192`, which already logs. Leave it; a transport-level failure is a different condition from a verb-level one, and conflating them would report an offline/unreachable server as a verb error.

## Implementation Steps

1. Add the failure branch to `src/webview/transport.js` in the `.then()` at `:176`.
2. Verify the message renders: `showStatusMessage` is already handled by the board (`kanban.html`) and the other panels' inline scripts.
3. Add the tests below.

## Proposed Changes

### `src/webview/transport.js` — verb response handler (`:176-189`)

- **Context.** No failure branch; failures are re-dispatched as typeless messages and ignored.
- **Logic.** Detect an explicit failure, surface it, and return before the normal dispatch.
- **Implementation.**
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
          dispatchMessage({
              type: 'showStatusMessage',
              message: result.error || ('Action failed: ' + verb),
              isError: true,
          });
          return;
      }
      if (result && typeof result === 'object') {
          dispatchMessage(result);
      }
  })
  ```
- **Edge cases.** Key on `result.success === false` **strictly**, never on `!result.success`. Many successful read verbs return a data object with no `success` field at all (the return-in-body contract requires data, not an ack) — treating those as failures would break the board. Do not fall through to `dispatchMessage(result)` on the failure path; that is what produces today's phantom typeless message.

## Complexity Audit

### Routine
- One conditional in one file.

### Complex / Risky
- **The strict-equality detail is the whole risk.** `!result.success` would misclassify every data-returning read verb as a failure and flood the UI with error toasts. This is a two-character difference between a fix and a regression.

## Edge-Case & Dependency Audit

- **Race conditions:** none. The handler is per-response.
- **Security:** `result.error` is server-generated text rendered into a status message. Confirm the status-message path escapes content rather than assigning `innerHTML`; if it does not, that is a pre-existing issue this change would newly expose to server-supplied strings.
- **Side effects:** none — the branch only adds a UI message.
- **Migration / shipped state:** `transport.js` is browser-only and is not loaded inside the VS Code webview (stated at its header, `:12-13`), so the extension's ~4,000 installs are unaffected.
- **Dependencies & conflicts:** none. Touches one file no other plan in this set edits.
- **No confirmation dialogs** are added.

## Dependencies

- None. Independently shippable, and should ship before the rest of the set.

## Verification Plan

### Automated Tests
1. A verb response of `{success:false, error:'boom'}` dispatches `showStatusMessage` with `message:'boom'` and `isError:true`, and does **not** dispatch the raw result.
2. A verb response of `{success:false}` with no `error` dispatches a generic message naming the verb.
3. A successful read verb returning a data object with **no** `success` field is dispatched normally and produces no error message. This is the regression guard for the strict-equality requirement.
4. A response of `{success:true, prompt:'…'}` still writes to the clipboard and dispatches normally.

### Manual
- In the browser cockpit, trigger any verb the standalone host does not implement and confirm the message *"Verb 'X' not implemented in standalone mode"* appears.

---

**Recommendation:** Complexity 2 → **Send to Intern.**

**Stage Complete:** CREATED
