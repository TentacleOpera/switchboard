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

## User Review Required

Yes — this plan introduces a new `ClickUpRemoteProvider` class that does not exist today. While the plan is behavior-preserving, the architectural decision to bring ClickUp behind the `RemoteProvider` interface (as a push-only implementor) should be reviewed before implementation. Specifically: the `RemoteProvider.kind` type must be extended from `'linear' | 'notion'` to include `'clickup'`, and the pull methods on `ClickUpRemoteProvider` will be stub implementations that return empty results (since ClickUp is pull-`false` by design). Confirm this approach is acceptable.

## Complexity Audit

### Routine
- Adding `capabilities` field and `pushState` / `pushContent` methods to the `RemoteProvider` interface (`src/services/remote/RemoteProvider.ts:40`)
- Declaring `Linear { pull:true, push:true }` and `Notion { pull:true, push:false }` on existing provider classes
- Wiring `LinearRemoteProvider.pushState` / `pushContent` to delegate to the existing `LinearSyncService.syncPlan` (`:1902`) / `syncPlanContent` (`:1953`) — pure delegation, no logic change
- Preserving the `realTimeSyncEnabled` and `completeSyncEnabled` gates exactly where they are (inside the delegated `syncPlan` methods)

### Complex / Risky
- **Creating `ClickUpRemoteProvider`** — a new class that implements `RemoteProvider` for a provider that has never been behind this interface. ClickUp's `syncPlan` (`ClickUpSyncService.ts:2525`) takes a full `KanbanPlanRecord` (not just `remoteId + column`), uses `columnMappings` (not `columnToStateId`), and has a `isSyncInProgress` loop guard. The adapter must bridge the signature mismatch between `pushState(remoteId, column)` and ClickUp's `syncPlan(record)`.
- **Extending `RemoteProviderKind`** from `'linear' | 'notion'` to `'linear' | 'notion' | 'clickup'` — touches the type definition, `RemoteControlService` provider factory (`KanbanProvider.ts:1445`), and all downstream switch/conditional logic.
- **Debounce relocation** — `debouncedSync` currently lives on the concrete services (`LinearSyncService`, `ClickUpSyncService`). The trigger sites (`_queueLinearSync` `:1924`, `_queueClickUpSync` `:1892`) call `debouncedSync` directly. Routing through `provider.pushState` bypasses this debounce. The debounce must either stay at the trigger site (wrapping the `provider.pushState` call) or be moved into the provider implementation.
- **`ContinuousSyncService` provider resolution** — today it picks Linear vs ClickUp by checking `plan.clickupTaskId` / `plan.linearIssueId` (`:483-493`) and calls the concrete service directly. Rerouting through the provider registry means `ContinuousSyncService` needs access to the registry and must resolve the provider from the plan's remote IDs, not from hardcoded service getters.

## Edge-Case & Dependency Audit

### Race Conditions
- **Debounce + provider dispatch**: If debounce stays at the trigger site (wrapping `provider.pushState`), rapid column moves will coalesce correctly. If it moves into the provider, the trigger site must not add a second debounce layer. Pick one location, not both.
- **ClickUp `isSyncInProgress` loop guard** (`ClickUpSyncService.ts:2527`): This guard lives inside `syncPlan`. As long as `pushState` delegates to `syncPlan`, the guard is preserved. If the adapter bypasses `syncPlan`, the guard is lost.
- **Concurrent push + pull**: A column move triggers `pushState` while `RemoteControlService._poll()` is mid-cycle. The echo guard (column equality, `RemoteControlService.ts:295`) handles the inbound echo. No new race introduced — this is the existing Linear bidirectional pattern.

### Security
- No new credential handling. Provider implementations reuse existing service instances (`LinearSyncService`, `ClickUpSyncService`, `NotionFetchService`) which already manage tokens via `SecretStorage`.

### Side Effects
- **`RemoteProviderKind` type expansion**: Adding `'clickup'` to the union may cause TypeScript exhaustiveness errors in switch statements that handle `'linear' | 'notion'` without a default case. Search for all `RemoteProviderKind` consumers and ensure exhaustiveness.
- **Provider factory in `KanbanProvider.getProvider`** (`:1445`): Currently handles `'notion'` and falls through to Linear. Must add explicit `'clickup'` branch returning a `ClickUpRemoteProvider` instance.
- **`_indexByRemoteId` in `RemoteControlService`**: Indexes plans by `linearIssueId` or Notion page ID. ClickUp plans are indexed by `clickupTaskId`. The provider `kind` determines which ID field is used — must add `'clickup'` to this logic.

### Dependencies & Conflicts
- **No external dependencies** — pure internal refactor.
- **`RemoteControlService._poll()`** (`:192`) calls `this._deps.getProvider(config.provider)` — if `config.provider` is ever `'clickup'`, the poll will get a `ClickUpRemoteProvider` whose `fetchStateDeltas` / `fetchCommentDeltas` return empty (pull is `false`). This is safe but must be verified: the poll should no-op gracefully, not error.
- **`ContinuousSyncService`** currently has no access to the provider registry — it uses `_getLinearService` / `_getClickUpService` directly. The registry must be injected into `ContinuousSyncService` or the trigger sites must resolve the provider and pass it through.

## Dependencies

- None. This is the first plan; plans 2 and 3 depend on it.

## Adversarial Synthesis

Key risks: (1) ClickUp has no `RemoteProvider` implementation today — the plan implicitly requires creating one, which expands scope beyond "pure delegation"; (2) the `pushState(remoteId, column)` signature doesn't match ClickUp's `syncPlan(KanbanPlanRecord)` or Linear's `syncPlan({planFile, topic, complexity}, newColumn)`, requiring non-trivial adapter logic; (3) relocating debounce from concrete services to the dispatch path risks double-debounce or lost debounce. Mitigations: keep `debouncedSync` at the trigger site wrapping `provider.pushState`; have `pushState` implementations internally look up the full plan record from `remoteId` (the services already do this via `getIssueIdForPlan` / `_findTaskByPlanId`); stub ClickUp pull methods to return empty deltas.

## Proposed Changes

### `src/services/remote/RemoteProvider.ts`
- **Context**: The interface at `:40-80` defines pull-only methods. No capabilities concept exists. `kind` is `'linear' | 'notion'`.
- **Logic**: 
  1. Extend `kind` to `'linear' | 'notion' | 'clickup'`.
  2. Add `capabilities: { pull: boolean; push: boolean }` as a readonly property.
  3. Add `pushState(remoteId: string, column: string): Promise<void>` — push a column change to the remote.
  4. Add `pushContent(remoteId: string, markdown: string): Promise<void>` — push plan body to the remote description/body.
- **Edge Cases**: Make `pushState` / `pushContent` optional via a separate `PushCapable` interface or guard callers with `provider.capabilities.push`. If kept on the main interface, stub implementations on pull-only providers should throw or no-op with a log. **Recommendation**: keep on main interface with stub implementations that log and return — simpler for callers, and the `capabilities.push` flag is the real gate.

### `src/services/remote/LinearRemoteProvider.ts` (`:25`)
- **Context**: Implements `RemoteProvider`, delegates to `LinearSyncService`. Has `_stateIdToColumn` reverse map built from `columnToStateId` (`:40-42`).
- **Logic**:
  1. Add `capabilities = { pull: true, push: true } as const`.
  2. Implement `pushState(remoteId, column)`: delegate to `this._linear.syncPlan(...)` — but `syncPlan` (`LinearSyncService.ts:1902`) takes `{ planFile, topic, complexity }` + `newColumn`, not `remoteId`. **Adapter**: `pushState` must look up the plan by `remoteId` (Linear issue ID) to get `planFile` / `topic` / `complexity`. The service already has `getIssueIdForPlan(planFile)` — add a reverse lookup or pass through `KanbanDatabase` to find the plan record by `linearIssueId`. Alternatively, change the trigger site to pass the full plan record and have `pushState` accept it (see KanbanProvider changes below).
  3. Implement `pushContent(remoteId, markdown)`: delegate to `this._linear.syncPlanContent(remoteId, markdown)` (`:1953`). This maps directly — `syncPlanContent` already takes `issueId` + `markdownContent`.
- **Edge Cases**: The `completeSyncEnabled` gate (`LinearSyncService.ts:1916`) stays inside `syncPlan` — no change needed. The `realTimeSyncEnabled` gate currently checked at the trigger site (`KanbanProvider.ts:1931`) should stay at the trigger site, not move into the provider (it's a per-service config, not a provider capability).

### `src/services/remote/NotionRemoteProvider.ts` (`:36`)
- **Context**: Implements `RemoteProvider`, pull-only today. `stateKeyToColumn` (`:138-143`) is identity mapping (the `Kanban Column` select option name IS the column name).
- **Logic**:
  1. Add `capabilities = { pull: true, push: false } as const` (push flips to `true` in Plan 2).
  2. Add stub `pushState` / `pushContent` that log "Notion push not yet implemented" and return. These are placeholders for Plan 2 to fill.
- **Edge Cases**: None — stubs are no-ops.

### `src/services/remote/ClickUpRemoteProvider.ts` (NEW FILE)
- **Context**: ClickUp has never been behind the `RemoteProvider` interface. `ClickUpSyncService` (`:2525`) handles push with a full `KanbanPlanRecord`, `columnMappings`, and an `isSyncInProgress` loop guard.
- **Logic**:
  1. Create `ClickUpRemoteProvider implements RemoteProvider` with `kind = 'clickup' as const` and `capabilities = { pull: false, push: true } as const`.
  2. Constructor takes `ClickUpSyncService` + deps (`db`, `getWorkspaceId`, `getPlansDir`, `log`) — mirroring `LinearRemoteProvider`'s constructor pattern.
  3. Pull methods (`fetchStateDeltas`, `fetchCommentDeltas`, `stateKeyToColumn`, `refreshLocalPlanFromRemote`, `importRemotePlan`) return empty/no-op results — ClickUp is pull-`false` by design.
  4. `pushState(remoteId, column)`: delegate to `this._clickup.syncPlan(planRecord)`. **Adapter challenge**: `syncPlan` takes a full `KanbanPlanRecord`, not `(remoteId, column)`. Must look up the plan record by `clickupTaskId` (the `remoteId`) from `KanbanDatabase`, set its `kanbanColumn` to the target column, then call `syncPlan`. The `columnMappings` lookup and `completeSyncEnabled` gate (`:2540`) stay inside `syncPlan`.
  5. `pushContent(remoteId, markdown)`: delegate to `this._clickup.syncPlanContent(remoteId, markdown)` (`:2588`). Maps directly.
- **Edge Cases**: The `isSyncInProgress` loop guard (`:2527`) stays inside `syncPlan` — preserved via delegation. The `columnMappings` unmapped-column skip (`:2537-2547`) stays inside `syncPlan` — preserved.

### `src/services/KanbanProvider.ts`
- **Context**: Push trigger sites at `_queueLinearSync` (`:1924`) and `_queueClickUpSync` (`:1892`) call concrete services directly. Provider factory at `:1445` handles `'notion'` and falls through to Linear.
- **Logic**:
  1. **Provider factory** (`:1445-1459`): Add `'clickup'` branch that returns `new ClickUpRemoteProvider(this._getClickUpService(resolved), { db, getWorkspaceId, getPlansDir, log })`.
  2. **`_queueLinearSync`** (`:1924-1940`): Replace `linear.debouncedSync(plan.planFile, {...}, targetColumn)` with a debounced call to `provider.pushState(plan.linearIssueId, targetColumn)`. Keep the `realTimeSyncEnabled` gate (`:1931`) and `setupComplete` check at this trigger site. Keep the debounce — wrap the `provider.pushState` call in a debounce keyed by `plan.planFile` (reuse the existing debounce mechanism or keep calling `linear.debouncedSync` which internally calls `syncPlan` — see Implementation note below).
  3. **`_queueClickUpSync`** (`:1892-1922`): Same pattern — replace `clickup.debouncedSync(...)` with debounced `provider.pushState(plan.clickupTaskId, targetColumn)`. Keep `realTimeSyncEnabled` gate (`:1904`).
- **Implementation note (debounce)**: The simplest behavior-preserving approach is to keep `debouncedSync` on the concrete services and have `pushState` delegate to `syncPlan` — i.e., the trigger site still calls `linear.debouncedSync(...)` / `clickup.debouncedSync(...)`, but the provider's `pushState` is the canonical interface method that wraps the same call. The trigger site can call either; the key change is that the **provider registry** is the single source for "which provider handles this board," and `pushState` / `pushContent` are the canonical interface methods. The trigger sites should resolve the provider from the registry and call `provider.pushState`, with debounce applied at the call site. **Clarification**: The debounce can remain on the concrete service's `debouncedSync` if `pushState` delegates to `syncPlan` — the debounce wraps `syncPlan`, and `pushState` calls `syncPlan`, so calling `debouncedSync` → `syncPlan` is equivalent to calling `debouncedSync` → `pushState` → `syncPlan`. The important part is that the dispatch goes through the provider, not that the debounce moves.

### `src/services/ContinuousSyncService.ts`
- **Context**: `_syncToLinear` (`:874`) and `_syncToClickUp` (`:847`) call concrete services directly. Provider selection at `:483-493` checks `plan.clickupTaskId` / `plan.linearIssueId`.
- **Logic**:
  1. Inject the provider registry (or a `getProvider` function) into `ContinuousSyncService`'s constructor or deps.
  2. Replace `_syncToLinear` / `_syncToClickUp` with a unified `_syncToRemote` that resolves the provider from the plan's remote ID and calls `provider.pushContent(remoteId, markdown)`.
  3. Keep the `realTimeSyncEnabled` gate — but it currently lives on the per-service config (`LinearSyncService.ts:228`, `ClickUpSyncService.ts:295`). The gate must be checked before calling `provider.pushContent`. **Option A**: check `realTimeSyncEnabled` at the trigger site in `ContinuousSyncService` by loading the service config (as today). **Option B**: move the gate into `provider.pushContent` implementation. **Recommendation**: Option A (keep gate at trigger site) — it's a per-service config flag, not a provider capability, and Plan 3 will consolidate it.
- **Edge Cases**: The `plan.clickupTaskId` / `plan.linearIssueId` priority logic (`:483-493`) must be preserved — if a plan has both, ClickUp is prioritized. The unified dispatch must replicate this priority.

### `src/services/RemoteControlService.ts`
- **Context**: `_poll()` (`:192`) calls `this._deps.getProvider(config.provider)`. `_indexByRemoteId` indexes plans by provider kind.
- **Logic**:
  1. `_indexByRemoteId`: add `'clickup'` branch indexing by `clickupTaskId` (alongside existing `linearIssueId` and Notion page ID).
  2. If `config.provider === 'clickup'`: `_poll` gets a `ClickUpRemoteProvider` whose `fetchStateDeltas` returns empty deltas. The poll no-ops gracefully. Verify this doesn't log errors or crash.
- **Edge Cases**: ClickUp should never be set as `config.provider` in `remote.config` (it's not a pull provider). But defensive coding requires the poll to handle it gracefully.

## Verification Plan

### Automated Tests
- **Skipped per session directive** — the test suite will be run separately by the user.

### Manual Verification
- **Behavior-preserving check**: After the refactor, existing Linear push (column move → Linear state update) and ClickUp push (column move → ClickUp list move) must work identically to before. Verify by:
  1. Moving a Linear-linked card locally → confirm Linear issue state updates.
  2. Moving a ClickUp-linked card locally → confirm ClickUp task list updates.
  3. Editing a Linear-linked plan file → confirm Linear issue description updates.
  4. Editing a ClickUp-linked plan file → confirm ClickUp task description updates.
  5. Confirm `completeSyncEnabled = false` still suppresses terminal-column pushes for both Linear and ClickUp.
- **TypeScript compilation**: Skipped per session directive.
- **No-op check for Notion**: Moving a Notion-linked card locally → confirm nothing is pushed (Notion push is `false` until Plan 2). The stub `pushState` / `pushContent` should log and return.
- **Provider registry check**: Verify that `KanbanProvider.getProvider('clickup')` returns a `ClickUpRemoteProvider` instance and that `getProvider('linear')` / `getProvider('notion')` still return their respective providers.

## Uncertain Assumptions

None — all code paths, method signatures, and config flag locations have been verified against the current source. The ClickUp `RemoteProvider` creation is an architectural decision (not a factual uncertainty) and is flagged in **User Review Required**.

## Non-goals

- **No new behavior.** This plan must be a no-op for existing Linear/ClickUp users; verify against current behavior.
- **No Notion push** (plan 2).
- **No config consolidation or UI change** (plan 3).
- **ClickUp is NOT promoted to a pull/control provider** — push-only is the intended role; the matrix is deliberately ragged.

## Dependencies

- None. This is the first plan; plans 2 and 3 depend on it.

## Source

Derived from `docs/remote_sync_architecture_refactor_analysis.md` (Decision: refactor-first → Sequencing → Plan 1). Base-level plan — run `/improve-plan` to deepen before execution.

## Recommendation

Complexity 6 → **Send to Coder**. The refactor is multi-file but behavior-preserving, with the main risk concentrated in the ClickUp adapter and debounce relocation. A coder with the architectural context from this plan can execute it safely.
