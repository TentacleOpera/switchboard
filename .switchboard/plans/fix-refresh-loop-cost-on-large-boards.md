# Fix: Make the kanban refresh loop O(1) when nothing changed (large-board cost)

## Goal

Make a *no-op* kanban refresh cost a constant-time integer comparison instead of O(card-count), so that a high-frequency refresh trigger (the known refresh storm, or any future one) can no longer pin the single-threaded extension host on a large board. This is a **cost-reduction / blast-radius** fix, not a trigger fix — it makes the loop survivable regardless of how many plans exist, and keeps the board responsive independent of plan count.

### Core problem

On a large board (observed live at 990 cards: 816 `CODE REVIEWED` + 100 completed), every invocation of the refresh path (`TaskViewerProvider._refreshRunSheetsImpl` → `KanbanProvider.refreshWithData`) does O(card-count) work **even when the board data is byte-identical to the last push**:

- runs the full DB query (`[refreshRunSheets] DB returned 891 active, 100 completed …`),
- builds ~990 card objects,
- `JSON.stringify({ cards, epicWorktrees })` over the **entire board** and sha256-hashes it (`KanbanProvider.ts:1367`) — purely to *decide* whether to skip,
- fires ~10 auxiliary `postMessage`s unconditionally (`KanbanProvider.ts:1378-1429`) plus `_getAgentNames`, `getWorktrees`, `_postEpicWorkflowModeState`.

When a refresh trigger fires repeatedly (confirmed live: the `refreshRunSheets DB returned …` triplet repeats with a **byte-identical** column distribution hundreds of times back-to-back), this O(card-count) work runs on every tick. On the single-threaded ext host it saturates the event loop and starves the in-memory singletons — the LocalApiServer (kanban routing dies) and the terminal registry (implementation sidebar empties). Symptom: "everything goes dead, reload fixes it." It is a **wedge, not a crash** (no exception, empty output channel).

### Background / root cause

- The existing identical-snapshot skip (`KanbanProvider.ts:1359-1376`) only gates the final `updateBoard` post. To compute the comparison it still pays the full O(card-count) cost above on every tick. So a no-op refresh is cheap on *bandwidth* (skips one post) but not on *CPU* (still queries, builds, stringifies, hashes, and posts ~10 aux messages).
- The single-flight coalescing guard shipped in 1.7.5 (`_refreshRunSheetsInFlight` / `_refreshRunSheetsQueued`, confirmed present in the installed `dist/extension.js`) does **not** help here: it collapses *concurrent/overlapping* calls, but the storm is *serial* re-triggering — each refresh runs to completion, then the next fires. Coalescing was the wrong layer.
- There is currently **no cheap signal** for "did the board data actually change since the last push." The board is driven entirely by `KanbanDatabase`'s in-memory image. Every board-data write funnels through a single choke point — `_persist()` (called from `updateColumnByPlanFile:1456`, `updatePlanFile:1865`, `insertFileDerivedPlan:1333`, and the other write methods at `:1228/:1265/:1312/:1397/:1538/:1801/:1831`). The other way the in-memory image changes is a reload-from-disk in `_reloadIfStale` (the swap at `KanbanDatabase.ts:4146`, which is how an externally-written `kanban.db` — another window, an agent CLI — reaches this instance).

Because both of those are the *only* moments board content can change, a monotonic version counter bumped at both points gives an exact "did anything change" signal. An early-out keyed on that counter skips the entire refresh between real changes — which is precisely the storm's redundant ticks — while never skipping a refresh that would surface a genuine change.

**Responsiveness note (explicit):** this does **not** make new-plan detection slower. Creating/registering a plan writes the DB via `insertFileDerivedPlan` → `_persist()` → the counter bumps → the next refresh sees a changed version and runs in full → the card appears with no added delay. The early-out adds *zero latency* — it only avoids redundant work, never delays a refresh that has real changes. In practice the board becomes *more* responsive, because the real refresh is no longer queued behind hundreds of no-op ticks on a pinned host.

## Metadata

**Tags:** [backend, performance, reliability]
**Complexity:** 5

## User Review Required

None. All decisions below are technical and are made in this plan. The trigger-source fix (what re-calls the refresh) is explicitly out of scope and tracked separately (see Non-Goals).

## Complexity Audit

### Routine
- Adding a monotonic `_dataVersion` integer field and `getDataVersion()` accessor to `KanbanDatabase` — one field, one method, one-line increment in `_persist()`.
- Adding a `_configEpoch` integer and `_markConfigDirty()` helper to `KanbanProvider` — straightforward counter increment.
- Building the composite early-out key from already-held filter fields (`_projectFilter`, `_repoScopeFilter`) plus the two counters — pure string concatenation + integer compare.
- Retaining the existing sha256 snapshot skip unchanged as defense-in-depth (no modification, just repositioning in the call order).
- Instrumentation log (throttled/debug-gated) — a single `console.log` behind a flag.

### Complex / Risky
- **Enumerating every config mutator for `_markConfigDirty()`** — the ~10 auxiliary messages trace back to scattered setters/handlers across `KanbanProvider`; a missed setter means a config change is silently dropped by the early-out (stale UI). This is the highest-effort, highest-risk task.
- **The `_db.run` bypass audit (Task 1)** — confirmed that `migrateDeprecatedColumns` (`:1516`) writes to the `plans` table WITHOUT calling `_persist()`, so it would NOT bump `_dataVersion` and the board would not refresh to reflect the migration. This must be routed through `_persist()` (which also fixes a latent persistence bug — the migration change is currently lost on reload) or given an explicit bump.
- **Resetting the push key on panel disposal** — the new `_lastPushKey` is a singleton field that outlives the panel; if not reset at the two panel-dispose blocks (`:988-989`, `:1037-1038`), reopening the kanban panel skips the first refresh and renders an empty board (the exact bug the existing `_lastBoardSnapshotKey` reset was added to prevent).
- **Bump placement in `_reloadIfStale`** — must go after the successful-reload exit point (`:4162`, post-migration, post-rollback-guard), not at the swap line (`:4146`, inside the try, pre-migration). Bumping at `:4146` risks a false positive if the reload fails and rolls back, and misses migration-induced changes that run at `:4152`.

## Decisions (made — do not re-litigate during implementation)

1. **Board-data version counter.** Add `private _dataVersion = 0` to `KanbanDatabase`; bump it (a) once inside `_persist()` (the single write choke point — covers every board-data mutation including new plans), and (b) after the successful-reload exit point in `_reloadIfStale` (`:4162`, AFTER the swap + migrations + rollback-guard, not at the swap line `:4146` — covers external/reloaded changes without false-positiving on a failed reload). Expose `getDataVersion(): number`. The migration-meta direct write at `:1264` is bookkeeping, not board data — exclude it (it does not call `_persist`).
   - **Confirmed bypass:** `migrateDeprecatedColumns` (`:1516`) writes to the `plans` table but does NOT call `_persist()` (returns at `:1518` without persisting). It must be routed through `_persist()` (preferred — also fixes a latent persistence bug where the migration change is lost on reload) or given an explicit `this._dataVersion++`. This is the one board-data write that bypasses the choke point.
   - **Overbroad-bump note (accepted):** `_persist()` is also called by non-board-data writes (`imported_docs`, `config`, `linear_issue_links`, `projects`, worktree `agents_open_with_grid`). Bumping in `_persist()` will cause occasional unnecessary full refreshes for those writes. This is intentional and safe — a false positive (unnecessary refresh) is caught by the sha256 skip, while a false negative (missed bump) causes a stale board. The conservative overbroad approach is preferred over per-method bumping, which would recreate the exact class of bug `migrateDeprecatedColumns` exposes.
2. **Config epoch.** Add `private _configEpoch = 0` to `KanbanProvider` and a `_markConfigDirty()` helper that increments it. Call it from the config mutators whose state the refresh pushes (the ~10 auxiliary messages: drag-drop modes, dynamic-complexity-routing toggle, allow-unknown-complexity-automove, clear-terminal-before-prompt, autoban config, pair-programming mode, visible agents, CLI triggers, live-sync states, agent names). This lets the early-out also short-circuit a no-op tick *without dropping* genuine config changes.
3. **Early-out key + placement.** The composite key is `workspaceId | projectFilter | repoScope | dataVersion | configEpoch`. Check it at **two** layers, both before the expensive work:
   - **Primary (skips the query):** in `TaskViewerProvider._refreshRunSheetsImpl`, after obtaining `workspaceId` (`:15282`) and `db` (`:15288`) but before the DB query (`:15298`), call `kanbanProvider.refreshWouldBeNoOp(workspaceId, db.getDataVersion())`; if true, return immediately. This is what stops the repeating `[refreshRunSheets] DB returned …` line during a storm.
   - **Backstop (skips build/stringify/hash/posts):** at the top of `refreshWithData`, after obtaining `workspaceId` (`:1232`) but before building cards (`:1274`), compare the same key; if unchanged, return. **Note:** `refreshWithData` currently has exactly ONE production caller (`_refreshRunSheetsImpl:15315`); the backstop is defense-in-depth for future callers, not currently load-bearing.
   - State owner is `KanbanProvider` (it already holds the filters and `_lastBoardSnapshotKey/Hash`). Record the key on every successful push via a `recordBoardPush()` step.
   - **Signature correction:** `KanbanProvider` does NOT hold `workspaceId` as a field — it is computed per-call from `db.getWorkspaceId()` (see the existing snapshot key at `:1366`). The guard signature MUST be `refreshWouldBeNoOp(workspaceId: string, dataVersion: number): boolean`, passing `workspaceId` from the caller. The backstop in `refreshWithData` has `workspaceId` available at `:1232`.
   - **Push-key reset (critical):** the new `_lastPushKey` is a singleton field that outlives the panel, exactly like `_lastBoardSnapshotKey`. It MUST be reset (to `''`) in the two panel-dispose blocks at `:988-989` and `:1037-1038`, alongside the existing `_lastBoardSnapshotKey/Hash` resets. Without this, reopening the kanban panel skips the first refresh (stale key matches) and renders an empty board — the exact bug the existing reset was added to prevent (see comment at `:983-987`).
4. **Keep the existing sha256 snapshot skip** (`:1359-1376`) as defense-in-depth. It will now rarely be reached (the version early-out fires first), and it only runs on genuine changes, so it costs nothing during a storm. It is cheap insurance against a board-data write that bypasses `_persist`.
5. **Leading-edge debounce** on the refresh entry point: fire immediately on the first call, coalesce subsequent calls within a 100 ms window into a single trailing call. Leading-edge ⇒ **zero added latency** for the first event; only bursts collapse. Window is a named constant.
6. **No migration.** This is purely in-memory runtime behavior; nothing persisted or shipped changes shape. (Per repo migration rule: no shipped state changes ⇒ no migration, no compat shim.)

## Implementation Plan (tasks)

### Task 1 — Data-version counter in `KanbanDatabase`
- Add `private _dataVersion = 0;` and `public getDataVersion(): number { return this._dataVersion; }`.
- Increment in `_persist()` (one line; covers all write methods that funnel through it).
- Increment after the successful-reload exit point in `_reloadIfStale` — at `:4162` (after `this._loadedMtime = currentMtime` and the `_lastLoadedMtimes.set(...)` call), NOT at the swap line `:4146`. This ensures the bump fires only when the reload + migrations succeed, never on a rolled-back failure, and captures migration-induced changes that run at `:4152`.
- **Audit step (required, pre-populated):** grep for direct `this._db.run(` / `this._db.exec(` writes to board-data tables (`plans`, `plan_events`, worktrees) that do **not** route through `_persist()`.
  - **CONFIRMED FINDING:** `migrateDeprecatedColumns` (`:1516`) runs `this._db.run(sql, params)` on the `plans` table and returns at `:1518` WITHOUT calling `_persist()`. Fix: add `await this._persist();` before the return (preferred — also fixes a latent persistence bug where the migration change is currently lost on disk reload) OR add `this._dataVersion++;` alongside the `_db.run`.
  - All other `_db.run` writes to `plans`/worktrees (`updateEpicStatus:1533→_persist:1538`, orphan-purge `:3620→_persist:3633`, cleanup-dedup `:3748-3848→_persist:3851`, `cleanupDuplicateLocalPlans:3912→_persist:3920`, `updateColumnWithEpicCascadeByPlanId:4010→_persist:4022`, `cascadeEpicByPlanId:4067→_persist:4080`, `_persistedUpdate:5808→_persist:5813`) route through `_persist()` ✓.
  - The migration-meta write at `:1264` is bookkeeping, not board data — excluded (it calls `_persist` anyway).
  - Record the audit result in the PR.

### Task 2 — Config epoch in `KanbanProvider`
- Add `private _configEpoch = 0;` and `private _markConfigDirty() { this._configEpoch++; }`.
- Call `_markConfigDirty()` from each setter / message handler that mutates state pushed by the auxiliary messages at `:1378-1429`. Enumerate them during implementation by tracing the senders of: `cliTriggersState`, `dynamicComplexityRoutingState`, `allowUnknownComplexityAutoMoveState`, `clearTerminalBeforePromptState`, `updateColumnDragDropModes`, `updateAutobanConfig`, `updatePairProgrammingMode`, `visibleAgents`, `updateAgentNames`, `liveSyncStates`.

### Task 3 — Early-out guard (primary, skips the query)
- Add `KanbanProvider.refreshWouldBeNoOp(workspaceId: string, dataVersion: number): boolean` — builds the composite key `${workspaceId}|${this._projectFilter ?? ''}|${this._repoScopeFilter ?? ''}|${dataVersion}|${this._configEpoch}` and compares to the last recorded push key (`_lastPushKey`); returns `true` when unchanged. **Note:** `workspaceId` is NOT a field on `KanbanProvider` — it must be passed from the caller (the existing snapshot key at `:1366` uses the same per-call `workspaceId`).
- In `TaskViewerProvider._refreshRunSheetsImpl`, call it after `workspaceId` (`:15282`) and `db` (`:15288`) are obtained but before the DB query (`:15298`); on `true`, return without querying.
- Confirm all refresh entry points either route through `_refreshRunSheetsImpl` or are covered by the Task 4 backstop. (Verified: `refreshWithData` has one production caller — `_refreshRunSheetsImpl:15315`.)

### Task 4 — Early-out backstop in `refreshWithData`
- At the top of `refreshWithData` (`:1212`), after obtaining `workspaceId` (`:1232`) and `db` (`:1230`) but before building cards (`:1274`), build the same composite key and compare; if unchanged, return before building cards / stringifying / posting.
- On a non-skipped push, call `recordBoardPush(workspaceId, dataVersion)` to store the current key in `_lastPushKey`. Keep the existing sha256 skip below this as the inner backstop (Decision 4).
- **Push-key reset (critical):** add `this._lastPushKey = '';` to the two panel-dispose blocks at `:988-989` and `:1037-1038`, alongside the existing `this._lastBoardSnapshotKey = '';` / `this._lastBoardSnapshotHash = null;` resets. Without this, reopening the panel skips the first refresh and renders an empty board.

### Task 5 — Leading-edge debounce (DEFERRED — implement after Tasks 1-4 are measured)
- Wrap the refresh entry (the function the trigger calls) in a leading-edge debounce, 100 ms window, as a named constant. First call fires synchronously; trailing burst coalesces to one call.
- **Rationale for deferral:** the version early-out (Tasks 1-4) already makes every no-op tick an O(1) integer compare. The debounce would collapse N O(1) checks into fewer calls — marginal benefit for added `setTimeout`/`clearTimeout` machinery and a trailing-call lifecycle. Implement Tasks 1-4 first, measure on the large board (the repeating `[refreshRunSheets] DB returned …` triplet should collapse to ~zero idle ticks). If residual storm cost remains, add this task; if not, skip it. This matches the plan's own Edge-Case note that "the version early-out alone delivers the bulk of the win with literally zero added latency."

### Task 6 — Instrumentation & verification
- Add a single throttled (or debug-flag-gated) log when the primary early-out fires, so dev-tools confirms storm ticks are being skipped (the repeating identical `[refreshRunSheets] DB returned …` triplet should collapse to ~zero while idle).
- Manual verification on the large board:
  1. **Idle:** the identical-distribution refresh triplet stops repeating.
  2. **New plan (this window):** create a plan file → card appears promptly (proves `_persist` bump path).
  3. **External change:** modify `kanban.db` from another window / agent → card updates after `_reloadIfStale` (proves the reload bump path).
  4. **Config toggle:** flip dynamic-complexity-routing (or any aux setting) → it propagates immediately (proves `_configEpoch`).
  5. **Filter switch:** change project filter / repo scope → full re-push (proves the key includes filters).

## Edge-Case & Dependency Audit

- **Missed bump → stale board.** The single real risk. Mitigated by: (a) `_persist()` is the verified single write choke point; (b) the `_reloadIfStale` bump covers external writes; (c) the Task 1 audit for `_db.run` writes that bypass `_persist` (pre-populated: `migrateDeprecatedColumns:1516` is the one confirmed bypass — fix by routing through `_persist()`); (d) the retained sha256 backstop. If a bypassing write is ever added later, the sha256 skip still catches it on the next genuine refresh from any other trigger.
- **Cross-window writes (sql.js last-writer-wins).** Another VS Code window writing `kanban.db` reaches this instance only via `_reloadIfStale` — which now bumps the version (at `:4162`, post-successful-reload). This is parity with today's behavior (the board already only reflects external writes after a reload); no regression.
- **Config-only changes.** Covered by `_configEpoch` so they are never dropped by the version-only check.
- **Panel reopen → empty board.** The new `_lastPushKey` is a singleton field that outlives the panel. If not reset on panel dispose (`:988-989`, `:1037-1038`), the first refresh after reopening matches the stale key and is skipped, rendering an empty board. Mitigated by resetting `_lastPushKey = ''` in the same two blocks that reset `_lastBoardSnapshotKey/Hash` (Task 4).
- **Overbroad `_persist()` bump.** Non-board-data writes (`imported_docs`, `config`, `linear_issue_links`, `projects`, worktree `agents_open_with_grid`) also call `_persist()` and bump `_dataVersion`, causing occasional unnecessary full refreshes. Not a correctness bug — the sha256 skip catches the unchanged snapshot. Accepted as the safe trade-off (false positive > false negative).
- **Debounce latency.** Leading-edge ⇒ the first event in any quiet period fires with no delay; only a rapid burst is coalesced (≤100 ms trailing). Imperceptible for a board; if even that is undesirable, the version early-out alone (Tasks 1-4) delivers the bulk of the win with literally zero added latency, and the debounce can be dropped. (Task 5 is now deferred — see task rationale.)
- **Concurrency.** The counter is a plain integer on the single-threaded ext host; no lock needed. The early-out is a pure read/compare.

## Non-Goals

- **Fixing the storm's trigger** (what re-calls the refresh). Separate work: instrument `console.log('[refreshRunSheets] caller:', new Error().stack)` at the top of `_refreshRunSheetsImpl`, identify the repeating frame (suspected plan-mirror / watcher feedback loop), and break it. This plan makes the loop *cheap*; that plan makes it *stop*. They are complementary; this one stands alone and is the higher-leverage blast-radius reduction.
- **Delta board updates** (sending only changed cards instead of the whole board). Would make *legit* refreshes cheap too, but it is a larger webview refactor and is not needed to defang the storm. Out of scope.
- **Reducing card count** (archiving). User-side data cleanup, tracked separately.

## Files

- `src/services/KanbanDatabase.ts` — `_dataVersion`, bump in `_persist()` (`:5768`) + after successful reload in `_reloadIfStale` (`:4162`), `getDataVersion()`; fix `migrateDeprecatedColumns` bypass (`:1516` → route through `_persist()`); `_db.run` bypass audit (pre-populated).
- `src/services/KanbanProvider.ts` — `_configEpoch` + `_markConfigDirty()`, `_lastPushKey` field + `refreshWouldBeNoOp(workspaceId, dataVersion)` / `recordBoardPush(workspaceId, dataVersion)`, early-out backstop in `refreshWithData` (after `:1232`, before `:1274`), reset `_lastPushKey` on panel dispose (`:988-989`, `:1037-1038`), retain sha256 skip (`:1359-1376`), deferred debounce on the refresh entry.
- `src/services/TaskViewerProvider.ts` — `_refreshRunSheetsImpl`: primary early-out after `workspaceId`/`db` (`:15288`) before DB query (`:15298`); deferred leading-edge debounce wrapper on the refresh entry point.

## Dependencies

None new. Reuses the existing `KanbanDatabase` ↔ `KanbanProvider` ↔ `TaskViewerProvider` wiring and the existing `crypto` import used by the snapshot skip.

## Adversarial Synthesis

Key risks: (1) a board-data write that bypasses `_persist()` (`migrateDeprecatedColumns:1516`, now pre-populated and fixed) would not bump `_dataVersion` and stale the board; (2) the new `_lastPushKey` singleton field must be reset on panel dispose or reopening renders an empty board; (3) the `_reloadIfStale` bump must fire after the successful-reload exit (`:4162`), not at the swap (`:4146`), to avoid false positives on rolled-back failures. Mitigations: the `migrateDeprecatedColumns` bypass is routed through `_persist()` (also fixes a latent persistence bug); `_lastPushKey` is reset at `:988-989` and `:1037-1038`; the retained sha256 skip (`:1359-1376`) remains as defense-in-depth catching any future bypass. The `_configEpoch` enumeration is the highest-effort risk (a missed setter drops a config change) — mitigated by tracing all ~10 auxiliary message senders. Task 5 (debounce) is deferred: the version early-out alone makes no-op ticks O(1) with zero added latency.

## Proposed Changes

### `src/services/KanbanDatabase.ts`
- **Context:** The in-memory SQLite (sql.js) image is the board's source of truth. Every board-data write funnels through `_persist()` (`:5768`), which exports the image to disk. External writes (another window) reach this instance via `_reloadIfStale` (`:4108`), which swaps in a fresh image from disk.
- **Logic:**
  - Add `private _dataVersion = 0;` near the other private fields. Add `public getDataVersion(): number { return this._dataVersion; }`.
  - In `_persist()` (`:5768`), add `this._dataVersion++;` as the first statement inside the method body (before `const data = this._db.export();`). This covers every write method that funnels through `_persist()`.
  - In `_reloadIfStale`, add `this._dataVersion++;` at `:4162` (after `KanbanDatabase._lastLoadedMtimes.set(this._dbPath, currentMtime);`), i.e. after the successful reload + migrations + rollback-guard, before the outer catch block. Do NOT place it at the swap line `:4146`.
  - **Fix `migrateDeprecatedColumns` bypass:** at `:1516-1518`, add `await this._persist();` before `return migrated;` (change the method to `async` if not already — it is already `async`). This routes the `plans` table write through the choke point and bumps `_dataVersion`. It also fixes a latent persistence bug (the migration change was previously lost on disk reload).
- **Edge Cases:** The overbroad bump (non-board-data writes also bump) is accepted — false positives are caught by the sha256 skip. The migration-meta write at `:1264` is excluded (bookkeeping, not board data; it calls `_persist` anyway).

### `src/services/KanbanProvider.ts`
- **Context:** `KanbanProvider` is the singleton that owns the webview panel, the filter state (`_projectFilter`, `_repoScopeFilter`), and the existing identical-snapshot skip (`_lastBoardSnapshotKey/Hash` at `:159-160`). `refreshWithData` (`:1212`) is the method that builds ~990 card objects, stringifies + hashes the board, and posts ~10 auxiliary messages.
- **Logic:**
  - Add `private _configEpoch = 0;` and `private _lastPushKey = '';` near `:159-160` (alongside the existing snapshot fields).
  - Add `private _markConfigDirty() { this._configEpoch++; }`.
  - Add `public refreshWouldBeNoOp(workspaceId: string, dataVersion: number): boolean` — builds `${workspaceId}|${this._projectFilter ?? ''}|${this._repoScopeFilter ?? ''}|${dataVersion}|${this._configEpoch}` and returns `this._lastPushKey === key`.
  - Add `public recordBoardPush(workspaceId: string, dataVersion: number): void` — sets `this._lastPushKey` to the same composite key.
  - **Backstop in `refreshWithData`:** after `const workspaceId = await db.getWorkspaceId();` (`:1232`) and obtaining `db` (`:1230`), but before `filterGhostPlans`/card building (`:1240+`), build the composite key with `db.getDataVersion()`; if it equals `_lastPushKey`, return early. On a non-skipped run, call `this.recordBoardPush(workspaceId, db.getDataVersion())` at the end of the successful path (before the `console.log` at `:1431`). Keep the existing sha256 skip (`:1359-1376`) below this as the inner backstop.
  - **Panel-dispose reset:** add `this._lastPushKey = '';` at `:989` and `:1038` (the two `onDidDispose` blocks), alongside `this._lastBoardSnapshotKey = '';`.
  - **Config-epoch wiring:** call `this._markConfigDirty()` from each setter/handler that mutates state pushed by the auxiliary messages at `:1378-1429`. Trace the senders of: `cliTriggersState`, `dynamicComplexityRoutingState`, `allowUnknownComplexityAutoMoveState`, `clearTerminalBeforePromptState`, `updateColumnDragDropModes`, `updateAutobanConfig`, `updatePairProgrammingMode`, `visibleAgents`, `updateAgentNames`, `liveSyncStates`.
- **Edge Cases:** `workspaceId` is NOT a field on `KanbanProvider` — it must be passed from the caller. The backstop currently has one production caller (`_refreshRunSheetsImpl:15315`); it is defense-in-depth for future callers.

### `src/services/TaskViewerProvider.ts`
- **Context:** `_refreshRunSheetsImpl` (`:15262`) is the refresh implementation. It obtains `workspaceId` (`:15282`), `db` (`:15288`), reads filters (`:15295-15296`), runs the DB query (`:15298-15303`), then calls `refreshWithData` (`:15315`). The single-flight coalescing wrapper (`_refreshRunSheets`, `:15240`) collapses concurrent calls but not serial re-triggering.
- **Logic:**
  - **Primary early-out:** after `const db = await this._getKanbanDb(resolvedWorkspaceRoot);` (`:15288`) and the null-check (`:15289-15391`), but before `const repoScope = ...` (`:15295`), add:
    ```
    if (this._kanbanProvider?.refreshWouldBeNoOp(workspaceId, db.getDataVersion())) {
        return; // no-op tick — board data + config unchanged since last push
    }
    ```
    This skips the DB query, card build, stringify, hash, and all auxiliary posts — the entire O(card-count) path.
  - **Deferred debounce (Task 5):** if measured residual storm cost remains after Tasks 1-4, wrap `_refreshRunSheets` (`:15240`) in a leading-edge debounce (100 ms, named constant). First call fires synchronously; trailing burst coalesces to one call. Defer until measurement confirms need.
- **Edge Cases:** the early-out goes AFTER `db` is obtained (cheap — in-memory reference) and `workspaceId` is resolved, but BEFORE the expensive DB query. This adds zero latency to genuine changes (the key differs → full refresh runs) and skips the entire redundant path on no-op ticks.

## Verification Plan

### Automated Tests
Per session directive, automated tests (unit, integration, e2e) and compilation are NOT run as part of this plan. The existing test at `src/services/__tests__/KanbanProvider.test.ts:459` calls `refreshWithData` directly and should be reviewed for compatibility with the new backstop early-out (it may need to call `recordBoardPush` first or pass a fresh `KanbanDatabase` with a non-zero `getDataVersion()` to avoid the early-out skipping the test's expected push). The test suite will be run separately by the user.

### Manual Verification (on the large board, ~990 cards)
1. **Idle no-op:** open dev-tools output channel → the repeating `[refreshRunSheets] DB returned 891 active, 100 completed …` triplet with identical column distribution stops repeating. The throttled early-out log confirms ticks are being skipped.
2. **New plan (this window):** create a plan file → `insertFileDerivedPlan` → `_persist()` → `_dataVersion++` → next refresh sees changed version → card appears promptly. Proves the `_persist` bump path adds zero latency.
3. **External change (cross-window):** modify `kanban.db` from another VS Code window / agent CLI → `_reloadIfStale` detects mtime change → swaps image → `_dataVersion++` at `:4162` → next refresh sees changed version → board updates. Proves the reload bump path.
4. **Config toggle:** flip dynamic-complexity-routing (or any auxiliary setting) → `_markConfigDirty()` → `_configEpoch++` → next refresh sees changed epoch → setting propagates immediately. Proves `_configEpoch` is not dropped by the version-only check.
5. **Filter switch:** change project filter / repo scope → composite key changes → full re-push. Proves the key includes filters.
6. **Panel reopen:** close the kanban panel → reopen it → board renders correctly (not empty). Proves `_lastPushKey` is reset on dispose (`:988-989`, `:1037-1038`).
7. **Migration path:** trigger `migrateDeprecatedColumns` (if any deprecated-column cards exist) → board reflects the migrated columns. Proves the `:1516` bypass fix.

### Recommendation
Complexity is 5 (Mixed) → **Send to Coder**.
