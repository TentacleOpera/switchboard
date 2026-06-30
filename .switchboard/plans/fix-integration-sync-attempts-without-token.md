# Fix: Integration sync attempts without an API token

## Goal

Prevent Linear/ClickUp sync services from attempting network calls (and throwing noisy `Linear API token not configured` / `ClickUp API token not configured` errors) when an integration config says `setupComplete: true` + `realTimeSyncEnabled: true` but no API token exists in VS Code SecretStorage. Add a cheap, cached token-presence check at every sync guard point so the missing-token case bails silently instead of scheduling a debounce, doing issue-ID lookups, and failing at the final network call.

### Core problem
When a Switchboard integration (Linear or ClickUp) has `setupComplete: true` and `realTimeSyncEnabled: true` in its config file but **no API token** in VS Code SecretStorage, every kanban column move and plan-file edit triggers a full sync attempt that throws a noisy `Linear API token not configured` / `ClickUp API token not configured` error deep in the call stack. The errors spam the developer console on every card move to a mapped column.

### Background / root cause
The config file (`~/.switchboard/integration-config.json`, global, persists across machines and reinstalls) and the API token (VS Code SecretStorage / OS keychain, per-machine) are stored in **two separate stores** that can diverge:

- The token lives in the OS keychain and is machine-local. It is lost on machine change, OS user reset, keychain wipe, or extension reinstall that clears secrets.
- The config file is global and survives those events.

The sync-trigger guards only ever inspect the **config file** (`setupComplete`, `realTimeSyncEnabled`). The token check is buried inside the lowest-level network method (`graphqlRequest` for Linear at `LinearSyncService.ts:1705-1706`, `httpRequest` for ClickUp at `ClickUpSyncService.ts:2228-2229`). So a config that says "fully set up, realtime on" with no backing token sails through every guard, schedules a debounced timer, does issue-ID lookups, and only fails at the final network call — producing the logged error and a wasted 500ms debounce on every move.

A compounding factor: `realTimeSyncEnabled` defaults to `setupComplete === true` when the field is missing (`LinearSyncService.ts:235-237`), so even an old config that predates that field implicitly has realtime sync on.

This affects **both** providers symmetrically — Linear and ClickUp share the identical guard pattern and the identical deep token check.

## Metadata

**Tags:** [backend, bugfix, reliability]
**Complexity:** 4

## User Review Required

Yes — before implementation, review the **Cache-staleness from external token-store paths** edge case (see Edge-Case & Dependency Audit). There are 6 call sites in `TaskViewerProvider.ts` and `extension.ts` that store the Linear/ClickUp token directly via `context.secrets.store` without going through the sync service's `completeSetup`. If the `_tokenPresentCache` is already `false` when one of these fires, syncs will be silently skipped until extension reload. Decide whether to (a) wire `clearApiTokenCache()` into those external paths, or (b) accept staleness with self-correction on next reload.

## Complexity Audit

### Routine
- Adding a `private _tokenPresentCache: boolean | null = null` field and a small `async hasApiToken()` method to two services — identical pattern in both.
- Inserting a one-line `if (!(await X.hasApiToken())) { return ...; }` bail after each existing `setupComplete`/`realTimeSyncEnabled` guard. Six files, ~10 insertion points, all following the same shape as the existing guards.
- Invalidating the cache to `true` inside `completeSetup` after the existing `_secretStorage.store(...)` call — one line per service.
- Unit-test additions mirror the existing stub-SecretStorage pattern already used throughout the integration test suite.

### Complex / Risky
- **Cache-staleness from external token-store paths**: `TaskViewerProvider.ts` (lines 4767, 4934, 4972, 5011) and `extension.ts` (lines 1307, 1433) store the token directly via `context.secrets.store` without touching the sync service. If `_tokenPresentCache` was already populated as `false` (from a prior card move with no token), these external stores do NOT invalidate it → syncs silently skipped until extension reload. This is a **new** failure mode (syncs that should happen, don't) distinct from the plan's original "cache stays `true` after external delete" analysis. See Edge-Case & Dependency Audit for mitigation options.
- **No existing token-deletion path**: the original plan instructs "Search for `_secretStorage.delete('switchboard.linear.apiToken')` and invalidate there." There is **no** `_secretStorage.delete` call for Linear or ClickUp tokens anywhere in the codebase (verified — the only secret deletion is for the Notion token in `TaskViewerProvider.ts:5609`). So the only invalidation point that exists today is `completeSetup`. The `clearApiTokenCache()` method is still worth adding for future-proofing and for the external-store-path mitigation above, but it has no existing caller.

## Edge-Case & Dependency Audit

**Race Conditions**
- `hasApiToken()` is async and reads `_tokenPresentCache` without a lock. Two concurrent sync triggers could both miss the cache and both call `getApiToken()` simultaneously. This is harmless — both get the same answer and both populate the cache. SecretStorage reads are idempotent.
- The cache is per-service-instance. `KanbanProvider`/`ContinuousSyncService` obtain service instances via `_getLinearService`/`_getClickUpService` — if those factory methods return fresh instances per call (rather than cached singletons), the `_tokenPresentCache` provides no benefit. **Verification needed**: confirm `_getLinearService`/`_getClickUpService` return cached instances. If they don't, the cache is useless (but not harmful — it just degrades to a per-call `getApiToken()` read, which is still cheap).

**Security**
- `hasApiToken()` only checks token **presence** (`!!token`), never logs or exposes the token value. No new secret surface.

**Side Effects**
- Converting a thrown error into a silent skip changes observable behavior: any caller currently catching the `Linear API token not configured` error (e.g. for telemetry or a "reconfigure" prompt) will no longer see it. Verified the catch sites: `syncPlan` (Linear) catches and re-throws at line 2003-2005; `ContinuousSyncService._syncToLinear`/`_syncToClickUp` catch and warn. None of these use the specific error string to trigger UX — they all fail-open. Safe.
- The stall watchdog (`_isEligibleForLiveSync`) will no longer treat a tokenless-but-configured plan as "actively syncing," so it won't try to recover/stall-report it. This is correct behavior — there's nothing to sync.

**Dependencies & Conflicts**
- No new dependencies. Reuses existing `getApiToken()` (Linear `LinearSyncService.ts:1650`, ClickUp `ClickUpSyncService.ts:2142`).
- The `clearApiTokenCache()` method (new) must be wired into the external token-store paths in `TaskViewerProvider.ts` and `extension.ts` IF the user chooses mitigation (a) above. Those files obtain the sync service via `_getClickUpService`/`_getLinearService` helpers — confirm those helpers expose the service instance so `clearApiTokenCache()` can be called.

## Dependencies

- None. This is a self-contained bugfix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) cache-staleness when tokens are stored via external paths that bypass `completeSetup`, causing silent sync skipping until reload; (2) the `_tokenPresentCache` is useless if `_getLinearService`/`_getClickUpService` return fresh instances per call instead of cached singletons; (3) no existing token-deletion path means the only invalidation point is `completeSetup`. Mitigations: confirm service-instance caching before relying on the cache; wire `clearApiTokenCache()` into the 6 external store paths (or accept reload-self-correction); the `clearApiTokenCache()` method is still added for future-proofing.

## Approach

Add a single cheap, cached token-presence check to each sync service and call it at every guard point that currently only checks `setupComplete`/`realTimeSyncEnabled`. When the token is absent, bail **silently** (return early / return a skip result) — do not throw, do not log a warning. This converts a noisy stack-trace error into a zero-cost no-op.

The check must be cheap because it runs on every column move: `getApiToken()` is already an async SecretStorage read, but SecretStorage access is fast and cached by the VS Code runtime. To avoid even that on the hot path, add a small in-memory `_hasToken` cache on each service that is populated lazily and invalidated only when the token is written or deleted.

### Why not auto-disable `setupComplete`/`realTimeSyncEnabled` in the config?
Considered and rejected as the primary mechanism: writing the global config file from inside a sync guard introduces a new write-on-every-move race and would silently mutate user-visible setup state from a background path. The Setup UI should be the authority on "is Linear configured." The token-presence bail is a safety net that stops the noise without rewriting user settings. (An optional one-time self-healing toast that nudges the user to re-run Setup is included as a stretch item.)

## Proposed Changes

### `src/services/LinearSyncService.ts`
**Context**: The Linear sync service. `getApiToken()` is at line 1650; `graphqlRequest` (the deep token check) at 1698; `completeSetup` stores the token at line 1893; `syncPlan` guard at 1965; `syncPlanContent` guard at 2017.

**Logic**: Add a cached token-presence helper and bail at every guard point.

**Implementation**:
- Add field near other private state: `private _tokenPresentCache: boolean | null = null;`
- Add method (place near `getApiToken`, ~line 1655):
  ```ts
  async hasApiToken(): Promise<boolean> {
    if (this._tokenPresentCache !== null) { return this._tokenPresentCache; }
    const token = await this.getApiToken();
    this._tokenPresentCache = !!token;
    return this._tokenPresentCache;
  }
  ```
- Add `clearApiTokenCache()` (public, for external invalidation):
  ```ts
  clearApiTokenCache(): void { this._tokenPresentCache = null; }
  ```
- In `completeSetup` after `await this._secretStorage.store('switchboard.linear.apiToken', token);` (line 1893): add `this._tokenPresentCache = true;`
- In `syncPlan` (line 1963): after `if (!config?.setupComplete) { return; }` (line 1965), add:
  ```ts
  if (!(await this.hasApiToken())) { return; }
  ```
- In `syncPlanContent` (line 2014): after `if (!config?.setupComplete) { return { success: false, error: 'Linear not set up' }; }` (line 2017), add:
  ```ts
  if (!(await this.hasApiToken())) { return { success: false, error: 'Linear API token not configured' }; }
  ```

**Edge Cases**: No token-deletion path exists in this service (verified — no `_secretStorage.delete` for the Linear token anywhere in `src/`). The `clearApiTokenCache()` method has no existing caller but is provided for the external-store-path mitigation and future disconnect flows.

### `src/services/ClickUpSyncService.ts`
**Context**: ClickUp mirror. `getApiToken()` at line 2142; `httpRequest` (deep token check) at 2221; `completeSetup` stores token at line 2441; `syncPlan` guard at 2543; `syncPlanContent` guard at 2601.

**Logic**: Mirror the Linear pattern exactly.

**Implementation**:
- Add `private _tokenPresentCache: boolean | null = null;`
- Add `async hasApiToken(): Promise<boolean>` (same body as Linear, placed near `getApiToken` ~line 2148).
- Add `clearApiTokenCache(): void { this._tokenPresentCache = null; }`
- In `completeSetup` after `await this._secretStorage.store('switchboard.clickup.apiToken', token);` (line 2441): add `this._tokenPresentCache = true;`
- In `syncPlan` (line 2535): after `if (!config || !config.setupComplete) { return { success: false, error: 'ClickUp not set up' }; }` (line 2543), add:
  ```ts
  if (!(await this.hasApiToken())) { return { success: false, error: 'ClickUp API token not configured' }; }
  ```
- In `syncPlanContent` (line 2598): after `if (!config?.setupComplete) { return { success: false, error: 'ClickUp not set up' }; }` (line 2601), add:
  ```ts
  if (!(await this.hasApiToken())) { return { success: false, error: 'ClickUp API token not configured' }; }
  ```

**Edge Cases**: Same as Linear — no token-deletion path exists.

### `src/services/KanbanProvider.ts`
**Context**: The queue entry points. `_queueClickUpSync` at line 1962 (guard at 1969); `_queueLinearSync` at line 1989 (guard at 1996). These call `debouncedSync` which schedules the 500ms timer — the earliest and cheapest bail point.

**Logic**: Guard before scheduling the debounce.

**Implementation**:
- In `_queueClickUpSync` (line 1962): after `if (!config?.setupComplete || config.realTimeSyncEnabled !== true) { return; }` (line 1969), add:
  ```ts
  if (!(await clickUp.hasApiToken())) { return; }
  ```
- In `_queueLinearSync` (line 1989): after `if (!config?.setupComplete || config.realTimeSyncEnabled !== true) { return; }` (line 1996), add:
  ```ts
  if (!(await linear.hasApiToken())) { return; }
  ```

**Edge Cases**: None. This is the hottest path (fires on every card move to a mapped column) and the most valuable bail.

### `src/services/ContinuousSyncService.ts`
**Context**: Live-sync paths. `_syncToClickUp` at line 847 (guards at 858, 861); `_syncToLinear` at line 874 (guards at 885, 888); `_isEligibleForLiveSync` (the stall-watchdog eligibility check — the plan calls this `_isLiveSyncActive`) computes `linearOK` at line 260 and `clickupOK` at line 267; the conflict-check probe calls `graphqlRequest` at lines 727-732.

**Logic**: Fold `hasApiToken()` into each guard so live-sync and the watchdog treat a tokenless plan as inactive.

**Implementation**:
- In `_syncToClickUp` (line 847): after `if (config.realTimeSyncEnabled !== true) { return { skipped: true, reason: 'Real-time sync disabled' }; }` (line 861), add:
  ```ts
  if (!(await clickup.hasApiToken())) { return { skipped: true, reason: 'ClickUp API token not configured' }; }
  ```
- In `_syncToLinear` (line 874): after `if (config.realTimeSyncEnabled !== true) { return { skipped: true, reason: 'Real-time sync disabled' }; }` (line 888), add:
  ```ts
  if (!(await linear.hasApiToken())) { return { skipped: true, reason: 'Linear API token not configured' }; }
  ```
- In the conflict-check probe (lines 723-732): the existing guard at line 726 (`if (config?.setupComplete === true && config.realTimeSyncEnabled === true)`) wraps the `graphqlRequest` call. Add `&& (await linear.hasApiToken())` to that condition so the probe is skipped, not errored. Apply the same to the ClickUp probe guard at line 710 (`&& (await clickup.hasApiToken())`).
- In `_isEligibleForLiveSync` (~line 245): fold `hasApiToken()` into `linearOK` (line 260) and `clickupOK` (line 267):
  ```ts
  linearOK = linearConfig?.setupComplete === true && linearConfig.realTimeSyncEnabled === true && (await linear.hasApiToken());
  // ...
  clickupOK = clickupConfig?.setupComplete === true && clickupConfig.realTimeSyncEnabled === true && (await clickup.hasApiToken());
  ```

**Edge Cases**: `_isEligibleForLiveSync` already guards on `plan.linearIssueId`/`plan.clickupTaskId` existence before loading config, so `hasApiToken()` is only called when there's a linked issue. The cache makes the added cost negligible.

### `src/services/GlobalPlanWatcherService.ts`
**Context**: File-change sync. The ClickUp real-time sync block is at lines 686-705; guard at line 690.

**Logic**: Guard before calling `debouncedSync`.

**Implementation**:
- In the ClickUp block (line 690): change the guard to also check the token:
  ```ts
  if (clickUpConfig?.setupComplete === true && clickUpConfig.realTimeSyncEnabled === true && (await clickUp.hasApiToken())) {
  ```

**Edge Cases**: No Linear block exists here currently — only ClickUp is wired to the plan-watcher. If a Linear block is added later it should follow the same pattern.

### `src/services/LinearAutomationService.ts`
**Context**: Automation execution. `runAutomation` loads config at line 274; guard at 275. The service holds `this._linearService` (line 37).

**Logic**: Bail before automation rules fire network calls with no token.

**Implementation**:
- In `runAutomation` (line 274): after `if (!config?.setupComplete) { return result; }` (line 275), add:
  ```ts
  if (!(await this._linearService.hasApiToken())) { return result; }
  ```

**Edge Cases**: `result` is the empty result object initialized at lines 268-272. Returning it early is the same shape as the existing `setupComplete` bail.

### (Conditional) `src/services/TaskViewerProvider.ts` + `src/extension.ts` — external token-store invalidation
**Context**: 6 call sites store the Linear/ClickUp token directly via `context.secrets.store` without going through the sync service: `TaskViewerProvider.ts:4767, 4934, 4972, 5011` and `extension.ts:1307, 1433`.

**Logic**: If the user chooses mitigation (a) from the User Review Required section, call `clearApiTokenCache()` on the relevant sync service after each of these external stores so the `_tokenPresentCache` doesn't stay `false`.

**Implementation**: After each `await this._context.secrets.store('switchboard.{linear|clickup}.apiToken', ...)` call, obtain the sync service via the existing `_getLinearService`/`_getClickUpService` helper and call `.clearApiTokenCache()`. (If mitigation (b) is chosen — accept staleness — skip this section entirely; the cache self-corrects on next extension reload.)

**Edge Cases**: This is a Clarification of an existing-requirement implication, not new product scope. The original plan did not identify these external paths.

## Verification Plan

### Automated Tests
- **Unit test** (`src/test/integrations/linear/linear-sync-service.test.js`): add a case where `setupComplete: true`, `realTimeSyncEnabled: true`, but `getApiToken()` returns `null` → assert `syncPlan` returns silently (no throw, no `graphqlRequest` call) and `debouncedSync`'s timer callback does not error.
- **Unit test** (`src/test/integrations/clickup/clickup-sync-service.test.js`): mirror for ClickUp — `syncPlan` with no token returns `{ success: false }` or skips without calling `httpRequest`.
- **Regression**: existing tests that stub a token in SecretStorage must still pass — verify the cache invalidation in `completeSetup` sets `_tokenPresentCache = true` so post-setup syncs proceed.
- **Manual**: remove the Linear token from keychain while keeping `setupComplete: true`, move a kanban card to a mapped column, confirm no console error and no sync attempt.

> Note: Per session directives, automated tests and compilation are NOT run as part of this plan. The test suite will be run separately by the user.

## Risks & edge cases

- **Cache staleness (token deleted externally)**: if the token is deleted externally (e.g. user clears keychain via OS settings) while the extension is running, `_tokenPresentCache` stays `true` until the next `completeSetup` or explicit invalidation. Mitigation: the worst case is one failed network call per sync (the original behavior) — the cache only ever over-optimistically skips the bail, never causes a new failure. Acceptable, and self-corrects on next extension reload.
- **Cache staleness (token stored externally while cache is `false`)**: if `_tokenPresentCache` was populated as `false` and a token is then stored via an external path (`TaskViewerProvider.ts`/`extension.ts`) that bypasses `completeSetup`, the cache stays `false` and syncs are silently skipped until reload. This is a **new** failure mode. Mitigation: wire `clearApiTokenCache()` into those external paths (see Proposed Changes §7), or accept reload-self-correction. **User decision required.**
- **Service-instance caching**: `_tokenPresentCache` is per-instance. If `_getLinearService`/`_getClickUpService` return fresh instances per call, the cache provides no benefit (degrades to per-call `getApiToken()`, still cheap). Verify instance caching before relying on the cache.
- **SecretStorage read cost**: `hasApiToken()` calls `getApiToken()` once per cache miss. VS Code SecretStorage is backed by the OS keychain and is fast (<5ms typical). With caching, the cost is paid once per extension lifetime per provider. No measurable hot-path impact.
- **Test harnesses**: tests that stub `vscode.SecretStorage` with a synchronous in-memory map already work with `getApiToken()`; `hasApiToken()` adds no new surface.

## Out of scope

- Merging the token into the config file (would require a migration and weakens secret storage — not worth it).
- Auto-resetting `setupComplete` to `false` when the token is missing (mutates user-visible state from a background path; the Setup UI should remain the authority).
- The `realTimeSyncEnabled` defaulting-to-`setupComplete` behavior at `LinearSyncService.ts:235-237` — a separate concern; the token bail makes it harmless.

## Recommendation

**Complexity: 4 → Send to Coder.** Multi-file (6 files) but every change is a small, identical-pattern guard insertion. No architectural changes, no data-consistency risk, no breaking changes. The one decision point (external-store-path invalidation) is flagged for user review.
