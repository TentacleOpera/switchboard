# A Failed Claim-Clear Reports Through `alert()`, Which Is a No-Op

## Goal

Route the failed claim-clear through the host-notification bridge, so the failure is reported somewhere a user can see.

### Problem analysis

`src/webview/connections.js:576` — the only `alert(` in the file:

```js
alert(`Failed to clear claim: ${res.error || 'unknown error'}`);
```

`alert()` is a silent no-op in a VS Code webview, the same class as `confirm()` (which CLAUDE.md bans outright for this reason). So a failed claim-clear is reported nowhere: the user sees nothing and assumes it worked.

This feature already owns the host-notification bridge, which is why the item was routed here rather than fixed in place.

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Feature:** a5b14f2e-1f48-4eed-b5a6-6b04afaffbc0
**Complexity:** 2
**Tags:** bugfix, ui

## User Review Required

No.

## Proposed Changes

### `src/webview/connections.js:576`
- **Logic:** replace the `alert(` with this feature's host-notification path, so the error surfaces as a toast.
- **Edge case:** not a confirm gate and must not become one — it reports a failure that already happened.

## Verification Plan

### Goal Invariants

1. `alert(` is absent from `src/webview/connections.js`. *(Paired: the failed-claim-clear path emits a host notification carrying the error text, so the report moved rather than disappeared.)*
