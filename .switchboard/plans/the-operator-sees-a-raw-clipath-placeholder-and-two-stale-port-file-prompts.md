# The Operator Sees a Raw `<cliPath>` Placeholder, and Two Prompts Still Gate on the Port File

## Goal

Remove a placeholder the operator is invited to 'fix' by hand, and two instructions pointing at a retired liveness check.

### Problem analysis

**The placeholder.** `terminals.js:11803`, `:12210` and `:12263` carry the raw `<cliPath>` token in the panel's own prompt text. Every `substituteCliPath` call site is server-side, so the token is never replaced in these strings — the operator reads a literal `<cliPath>` and reasonably tries to correct it.

**The stale liveness check.** `TaskViewerProvider.ts:7273` and `tickets.html:4631` both still tell the reader to check `.switchboard/api-server-port.txt` to decide whether the extension is running. A port file is not liveness — the documented test is `GET /health` — and this board carries a stale `api-server.pid` proving the point.

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Complexity:** 2
**Tags:** bugfix, docs, ui

## User Review Required

No.

## Proposed Changes

### `terminals.js:11803`, `:12210`, `:12263`
- **Logic:** substitute client-side, or drop the token from panel-authored text.

### `TaskViewerProvider.ts:7273` and `tickets.html:4631`
- **Logic:** replace the port-file instruction with the health check. Two-line text fix, or fold into the server-discovery work if that lands first.

## Verification Plan

### Goal Invariants

1. The raw `<cliPath>` token is absent from `terminals.js` panel prompt text. *(Paired: the prompts still name a CLI path, resolved rather than templated.)*
2. Neither `TaskViewerProvider.ts` nor `tickets.html` instructs the reader to check `.switchboard/api-server-port.txt`.
