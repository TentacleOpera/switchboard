# A Batch Dispatch Clears One Card and Leaves Its Siblings Lit

## Goal

Settle whether a batch stamps N rows or one, so a fanned-out dispatch does not leave five of six cards lit until a stale sweep retires them.

### Problem analysis

`LocalApiServer.ts:4028-4046` states the design in its own comment: *"This POST clears exactly ONE of them… the sibling rows have no second POST to clear them"*, and deliberately does not gate on `remaining === 0`.

So a batch that fans out to six cards clears one on completion and leaves five lit. They stay that way until the stale sweep retires them, which is a timeout, not a signal.

The nearest existing card, *A column move orphans the dispatch holder*, is about `dispatched_at` being nulled — a different predicate, and not this.

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Complexity:** 5
**Tags:** bugfix, reliability

## User Review Required

**Decided 2026-09-15 by the operator: clear every row stamped to the seat.**

The shipped standing order is one POST per *turn* — *"Do NOT post after finishing individual
parts"* — so the stamped set **is** the turn, and clearing all of it on the turn boundary is
consistent with the directive the seat was given. "Stop stamping N rows" is the better data model
but it is a refactor of the fan-out, not a fix for the stuck lights.

## Settled Design

- **Clear every row stamped to that seat** when the completion POST arrives.
- **Do NOT gate on `remaining === 0`.** The comment at `LocalApiServer.ts:7143-7152` already rules
  this out with reasons, and they still hold: the sibling rows have no second POST (mtime completion
  is retired and the ingestion clear seam is dormant), so a batch would never announce at all; and
  the same callback carries the board refresh in both hosts, so a row would go clean in the DB while
  its card stayed lit — the exact stuck light this work exists to remove.
- **`remaining` stays display-only.** It renders as `"<title> +N more"` in the completion toast and
  must not become a gate.
- **The one risk to guard:** a seat legitimately holding two unrelated dispatches would have both
  cleared. Scope the clear to the rows belonging to the completing dispatch if that is
  distinguishable; if it is not, record that limitation rather than leaving it implicit.

## Proposed Changes

### `src/services/LocalApiServer.ts:4028-4046`
- **Logic:** apply the recorded decision. If clearing all: clear every row stamped to that seat on completion. If stamping one: the batch records a single holder and the siblings are never stamped.
- **Edge case:** whichever branch, an in-flight sibling must not be cleared early — a seat still running must keep its holder.

## Verification Plan

### Goal Invariants

1. Per the recorded decision: no in-flight sibling is cleared while that seat is still running, **or** exactly one row is stamped per dispatch. *(Paired: a completed batch leaves no card lit that has no running seat.)*
