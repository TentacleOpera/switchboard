# Remote Sync Refactor (1/3): Declared Provider Capabilities + Unified Push Dispatch

## Goal

Make **push a first-class, provider-symmetric capability** behind the same `RemoteProvider` abstraction that already governs pull, and route every existing push trigger through one provider registry. This is a **behavior-preserving** refactor — no user-visible change for existing Linear/ClickUp users. It is the foundation the other two remote-sync plans build on.

### Core problem & background

Switchboard's remote/sync system grew in layers that were never reconciled (full analysis: `docs/remote_sync_architecture_refactor_analysis.md`). Today there are **three sync behaviors across two subsystems with two different provider abstractions**:

- **Pull/ingest** is clean and provider-agnostic: `RemoteControlService._poll()` (`src/services/RemoteControlService.ts:192`) drives state import, state mirror (`_applyStateMirror`, `:288`) and comment polling (`_pollComments`, `:316`) through the `RemoteProvider` interface (`src/services/remote/RemoteProvider.ts:40`), with Linear + Notion implementations.
- **Push** is **not** abstracted at all. Status push fires from local column moves (`KanbanProvider._queueLinearSync` `:1924` / `_queueClickUpSync` `:1892`, gated by `realTimeSyncEnabled`) → `debouncedSync` → `syncPlan`. Content push fires from the file watcher via `ContinuousSyncService` → `syncPlanContent` (`:874`/`:847`). Both reach for the **concrete** `LinearSyncService` / `ClickUpSyncService` directly.

So the `RemoteProvider` interface only ever writes back via `postComment` (dispatch acks) — it has no concept of pushing state or content. Push lives in a separate place, wired to a different provider set, behind a different config flag.

### Root cause

Remote control (pull) was bolted onto a legacy push-from-local sync system. The legacy automation was later split into bug-triage vs. remote-control, but **the push half was never folded into the provider abstraction** — it stayed cross-system. The result: a provider's capabilities are *implicit and scattered* rather than *declared*, and pull and push resolve their providers through two unrelated code paths.

## Metadata

- **Tags:** [backend, refactor, api, reliability]
- **Complexity:** 6
- **Repo:** switchboard

## Scope (base level)

1. **Declare capabilities on the provider.** Add `capabilities: { pull: boolean; push: boolean }` to `RemoteProvider`. Initial declarations: `Linear { pull:true, push:true }`, `ClickUp { pull:false, push:true }` (push-only **by design** — stakeholder visibility surface, not a control surface), `Notion { pull:true, push:false }` (push flips to true in plan 2/3).
2. **Extend the interface with push methods**, e.g. `pushState(remoteId, column)` and `pushContent(remoteId, markdown)`. Linear and ClickUp implement them by delegating to their **existing** `syncPlan` / `syncPlanContent` — no logic change, just relocation behind the interface.
3. **Introduce a single provider registry** ("get the provider for this board") shared by both the pull loop and the push triggers. Today pull builds providers inline in `KanbanProvider._getRemoteControl` while push reaches for `_getLinearService` / `_getClickUpService` separately; unify them.
4. **Reroute existing push trigger sites** — `_queueLinearSync` / `_queueClickUpSync` (column move) and `ContinuousSyncService` (file change) — to dispatch through `provider.pushState` / `pushContent` instead of hardcoding the concrete services. **Triggers stay where they fire** (local column move, file save); only the dispatch is unified. Existing gates (`realTimeSyncEnabled`, `completeSyncEnabled`) are preserved exactly.

## Non-goals

- **No new behavior.** This plan must be a no-op for existing Linear/ClickUp users; verify against current behavior.
- **No Notion push** (plan 2).
- **No config consolidation or UI change** (plan 3).
- **ClickUp is NOT promoted to a pull/control provider** — push-only is the intended role; the matrix is deliberately ragged.

## Dependencies

- None. This is the first plan; plans 2 and 3 depend on it.

## Source

Derived from `docs/remote_sync_architecture_refactor_analysis.md` (Decision: refactor-first → Sequencing → Plan 1). Base-level plan — run `/improve-plan` to deepen before execution.
