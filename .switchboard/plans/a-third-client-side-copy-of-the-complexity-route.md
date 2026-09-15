# A Third Client-Side Copy of the Complexity Route

## Goal

Push the routed role onto the card payload so the client stops deriving it, instead of deriving it a third time and disagreeing with the server.

### Problem analysis

`kanban.html:9013-9015` computes `leadBoundCount` from `routingMapConfig.lead` alone, while `KanbanProvider.resolveRoutedRole:1632` takes `degradeLivePool = true` and **re-routes on an empty pool**. So the client's count and the server's routing disagree exactly when the pool is empty — the case that matters.

The optimistic-move prediction at `:10097` is the second client-side copy. This would be the third.

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Complexity:** 4
**Tags:** bugfix, frontend, refactor

## User Review Required

No.

## Proposed Changes

### Card payload and `kanban.html`
- **Logic:** emit `routedRole` on the card payload and have the client read it. Delete the client-side derivation rather than adding a third.
- **Edge case:** the payload must be emitted from **both** composition roots — `src/standalone/bootstrap.ts` and `src/extension.ts` — or the standalone board silently keeps deriving.

## Verification Plan

### Goal Invariants

1. `kanban.html` reads `routedRole` from the card payload and no longer derives `leadBoundCount` from `routingMapConfig.lead`. *(Paired: both composition roots emit `routedRole`, so the read cannot resolve to undefined on one host.)*
