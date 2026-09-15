# Only Two Routes Validate `workspaceRoot` Before Opening a Database

## Goal

Extend the existing root resolver to every route that opens a database from a caller-supplied path.

### Problem analysis

`_resolveKnownRoot` has exactly two call sites — `LocalApiServer.ts:7921` and `:8243`. `_handleKanbanTaskComplete` passes the raw string straight to `getKanbanDatabase`.

Scope this as *extend the existing resolver to every route*. The original memo's blanket claim that **no** route validates is wrong — two do, and the resolver already exists; what is missing is its application.

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Complexity:** 4
**Tags:** security, backend

## User Review Required

No.

## Proposed Changes

### Every route calling `getKanbanDatabase(workspaceRoot)`
- **Logic:** route each through `_resolveKnownRoot` first. Start with `_handleKanbanTaskComplete`, then sweep.
- **Edge case:** a route that legitimately accepts an unknown root (if any) must say so in a comment, so the exception is deliberate rather than a miss.

## Verification Plan

### Goal Invariants

1. No route calls `getKanbanDatabase(` with a caller-supplied path that has not passed `_resolveKnownRoot`. *(Paired: the two existing call sites still resolve, so the sweep extended the guard rather than replacing it.)*
