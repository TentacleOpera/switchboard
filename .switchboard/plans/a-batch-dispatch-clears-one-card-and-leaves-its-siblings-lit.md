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

**Yes — an either/or the author must pick:** clear every row stamped to the seat, or stop stamping N rows in the first place. Both are defensible and they lead to different implementations.

## Proposed Changes

### `src/services/LocalApiServer.ts:4028-4046`
- **Logic:** apply the recorded decision. If clearing all: clear every row stamped to that seat on completion. If stamping one: the batch records a single holder and the siblings are never stamped.
- **Edge case:** whichever branch, an in-flight sibling must not be cleared early — a seat still running must keep its holder.

## Verification Plan

### Goal Invariants

1. Per the recorded decision: no in-flight sibling is cleared while that seat is still running, **or** exactly one row is stamped per dispatch. *(Paired: a completed batch leaves no card lit that has no running seat.)*
