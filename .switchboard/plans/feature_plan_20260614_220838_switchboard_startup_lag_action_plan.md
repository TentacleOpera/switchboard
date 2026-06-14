# Switchboard Startup Lag — Action Plan

THis plan is to implement the biggest problems identified in this startup lag report: /Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/plans/brain_92a7d86813580f01d466c4043a857b7b29576e6933a45c2e9abfc5eee2a4c104.md

## Goal
Reduce VS Code extension startup lag by eliminating redundant per-plan file I/O, blocking terminal PID resolution, and unnecessary eager activation. The root cause is a 2,130-line `activate()` that serially awaits heavy operations: a recursive plan-file scan + DB upsert per file (executed twice), a 5-second terminal PID timeout, and unconditional `onStartupFinished` activation that boots everything before the user interacts with Switchboard.

## Metadata
- **Tags:** performance, backend
- **Complexity:** 6

## User Review Required
- **P3 Lazy activation events** — Changing from `onStartupFinished` to view/command-triggered activation changes when background timers (plan scanner, integration auto-pull) start. Confirm acceptable UX for users who rely on background plan ingestion before opening the sidebar.

## Complexity Audit

### Routine
- Add mtime short-circuit gate in `_handlePlanFile` after the existing-plan lookup.
- Remove dead 3× JSON-parse retry loop in terminal sync (`_syncTerminalRegistryWithStateImpl`).
- Reduce PID resolution timeout from 5000 ms → 1000 ms.
- Add `console.time` / `timeLog` checkpoints around heavy ops in `activate()`.
- Convert `syncTerminalRegistryWithState` to a fire-and-forget call in `activate()`.

### Complex / Risky
- Convert terminal registry sync off the legacy `state.json` bridge to direct DB reads of `runtime.terminals`.
- Swap `activationEvents` to lazy triggers (`onView`, `onCommand`) — risks breaking background services and command discoverability if any command is omitted from the activation list.
- Defer heavy top-level imports (`jsdom`, `sql.js`, API wrappers) into `resolveWebviewView()` or deeper call sites; requires verifying no eager code path loads them earlier.

## Edge-Case & Dependency Audit

### Race Conditions
- **mtime TOCTOU:** `fs.stat` and `fs.readFile` are not atomic. A file edited between stat and read will be parsed with stale metadata, but the file watcher will fire a second event with the new mtime, correcting the DB on the next pass.
- **DB-only update vs disk edit in same second:** `updatedAt` stores ISO-8601 millisecond strings; `mtime` is a filesystem `Date`. Normalise both to millisecond integers before comparison to avoid precision drift.
- **Concurrent DB writers (multi-window):** sql.js uses whole-file persist (last-writer-wins). If another VS Code window updates a plan and this window skips due to unchanged local mtime, the DB may diverge until a subsequent scan or watcher event.

### Security
- No new attack surface. Skipping file reads reduces I/O exposure.

### Side Effects
- **Lazy activation:** `startPlanScanner()` and `initializeIntegrationAutoPull()` currently live inside `activate()`. With deferred activation they will not run until the sidebar opens or a listed command runs. If background polling is required even when the panel is closed, lazy activation is inappropriate unless those timers are moved to a separate always-on contribution point (not available in this extension).
- **Deferred imports:** Moving `import('jsdom')` into `resolveWebviewView` delays parsing until first sidebar open, but any code path that parses HTML before the webview resolves (e.g., CLI-driven plan imports) must dynamic-import at the call site instead.

### Dependencies & Conflicts
- P2 assumes `stateConfigBridge` already redirects `state.json` to the `config` table (confirmed in `src/services/stateConfigBridge.ts`).
- P3 may conflict with commands not explicitly listed in `activationEvents`. All commands that must be available before sidebar open need to be enumerated in `package.json`.
- P1 and P2 are independent; P3 depends on verifying P1/P2 do not regress startup behaviour.

## Dependencies
- None identified.

## Adversarial Synthesis
Key risks: (1) mtime string comparison may silently fail due to ISO-8601 vs Date precision mismatches, causing false skips or redundant re-parses; (2) chaining terminal sync inside `deregisterAllTerminals.then()` would sync an empty registry because deregistration wipes `state.terminals`; (3) lazy activation without an exhaustive command list will surface "command not found" errors for infrequently used commands. Mitigations: normalise timestamps to integer ms, keep terminal sync as a standalone fire-and-forget call with an early-exit on empty state, and audit all registered commands before changing `activationEvents`.

## Proposed Changes

### `src/services/GlobalPlanWatcherService.ts`
**Context:** `_handlePlanFile` (line 436) reads, parses, and upserts every plan file unconditionally, even when the DB already holds the identical content. `triggerScan` (line 594) recursively walks `.switchboard/plans/` and calls `_handlePlanFile` for every `.md` on every startup.

**Logic:** After `getPlanByPlanFile` returns an existing plan (line 458), compare `stats.mtime.getTime()` with `new Date(plan.updatedAt).getTime()`. If `mtime <= updatedAt`, skip `readFile`, `parsePlanMetadata`, `upsertPlans`, and ClickUp sync. New files (no DB row) fall through to insert unchanged.

**Implementation:**
1. Move the existing `fs.promises.stat()` block (currently lines 475–486) to execute *before* `fs.promises.readFile()` (line 459).
2. After the `plan` lookup (line 458) and before reading file content, add:
   ```ts
   if (plan && new Date(fileMtime).getTime() <= new Date(plan.updatedAt).getTime()) {
       this._outputChannel?.appendLine(`[GlobalPlanWatcher] Plan unchanged, skipping: ${relativePath}`);
       return;
   }
   ```
3. Keep the legacy absolute-path fallback (lines 462–473) but ensure it runs after the mtime guard for the relative-path hit.

**Edge Cases:**
- `stat()` failure (e.g., file deleted mid-process) falls back to current time and continues to read/parse, preserving existing error handling.
- DB-only edits (Kanban column moves) bump `updated_at` past disk mtime, so they are never skipped.
- Plans created between VS Code sessions have no DB row → `plan` is null → skip logic never fires → file is imported correctly.
- Dropped earlier idea of gating `triggerScan` on `hasActivePlans` is preserved as out-of-scope here; the mtime gate makes the unconditional scan cheap enough.

### `src/extension.ts`
**Context:** `syncTerminalRegistryWithState()` (line 1502) is awaited on the critical startup path and contains a 5-second PID timeout. It currently reads legacy `state.json` through the bridge, including a dead 3× JSON-parse retry loop (lines 1631–1643).

**Logic:** Remove the blocking `await` on startup; run sync fire-and-forget inside the existing `deregisterAllTerminals(true).then()` chain (line 638) **only if** `state.terminals` is non-empty. Convert the sync implementation to read `runtime.terminals` directly from the DB config table instead of the bridge, delete the retry loop, and lower the PID timeout.

**Implementation:**
1. In `activate()` around line 638, change:
   ```ts
   void taskViewerProvider.deregisterAllTerminals(true).then(() => {
       outputChannel?.appendLine('[Startup] Auto-reset agent terminals completed.');
       // Fire-and-forget terminal reclaim after deregistration completes
       const runtimeStateRoot = resolveEffectiveStateRoot(workspaceRoot) || workspaceRoot;
       void syncTerminalRegistryWithState(runtimeStateRoot);
   }).catch(...);
   ```
   Remove the standalone `await syncTerminalRegistryWithState(runtimeStateRoot)` at line 1527.
2. In `_syncTerminalRegistryWithStateImpl` (line 1624):
   - Replace `const statePath = ...` and `fs.existsSync / fs.readFileSync` block with direct DB read:
     ```ts
     const db = KanbanDatabase.forWorkspace(workspaceRoot);
     await db.ensureReady();
     const stateTerminals = await db.getConfigJson('runtime.terminals', {}) as Record<string, any>;
     if (Object.keys(stateTerminals).length === 0) return;
     ```
   - Delete the `parseAttempts` retry loop (lines 1631–1643).
   - Change `waitWithTimeout(t.processId, 5000, undefined)` to `1000` (line 1668).
3. Keep the cross-IDE gate, PID-map pre-resolution, and name-match fallback unchanged.

**Edge Cases:**
- `db.ensureReady()` may be slow on first call, but this now runs off the critical path.
- If `deregisterAllTerminals` throws, the `.catch()` handler still runs; consider adding the sync in a `.finally()` instead so reclaim is attempted even after partial failure.
- Empty `state.terminals` early-exits before any IPC, eliminating the 5-second stall when no agents were previously registered.

### `package.json`
**Context:** The extension activates on every window open via `"activationEvents": ["onStartupFinished"]` (line 26). This forces all heavy init before the user interacts with Switchboard.

**Logic:** Replace with view- and command-triggered activation. The user must open the Switchboard sidebar or explicitly run a Switchboard command for the extension to load.

**Implementation:**
1. Replace line 25–27 with:
   ```json
   "activationEvents": [
       "onView:switchboard-view",
       "onCommand:switchboard.openKanban",
       "onCommand:switchboard.setup"
   ]
   ```
2. **Clarification:** Before shipping, audit all commands registered in `extension.ts` (lines 660–2520). Any command not covered by the three events above must be added to `activationEvents` or it will return "command not found" when invoked from the command palette before the sidebar has been opened.

**Edge Cases:**
- Background timers (`startPlanScanner`, `initializeIntegrationAutoPull`) start only after activation. Users who never open Switchboard will not get automatic plan ingestion from external IDE folders. If that is required, keep `onStartupFinished` and instead defer heavy init inside `activate()` with `setImmediate`.

### `src/services/TaskViewerProvider.ts`
**Context:** `TaskViewerProvider.ts` imports `JSDOM`, `ClickUpSyncService`, `LinearSyncService`, `NotionFetchService`, and other heavy modules at the top level (lines 1–60). These are parsed during module load even when the user never opens the sidebar.

**Logic:** Defer heavy imports into `resolveWebviewView()` or the specific functions that need them, so module parsing cost is only paid on first sidebar open.

**Implementation:**
1. In `resolveWebviewView` (line 7607), before the Phase-1 / Phase-2 init, dynamic-import heavy dependencies:
   ```ts
   const [{ JSDOM }, { ClickUpSyncService }, { LinearSyncService }] = await Promise.all([
       import('jsdom'),
       import('./ClickUpSyncService'),
       import('./LinearSyncService'),
       // ... etc
   ]);
   ```
   Then inject them into the provider instance or pass them into the functions that consume them.
2. Alternatively, if those classes are used inside `_getHtmlForWebview` or `_syncFilesAndRefreshRunSheets`, add `await import(...)` at the entry of those methods instead.

**Edge Cases:**
- Dynamic imports return promises; ensure any synchronous code that expects the classes to be available awaits the import.
- Webpack may code-split dynamic imports; verify the extension bundle still loads correctly in VS Code's webview environment.
- `sql.js` is loaded via `KanbanDatabase.ensureReady()`; that path is already lazy but the `sql.js` top-level import in `KanbanDatabase.ts` still pays parse cost. Full fix requires moving `import('sql.js')` inside `ensureReady()`, which is out of scope of this plan but noted as follow-up.

## Verification Plan

### Automated Tests
- **GlobalPlanWatcherService:** Add unit test verifying `_handlePlanFile` skips read/upsert when `mtime <= updatedAt` and proceeds when `mtime > updatedAt`. Test DB-only update (future `updatedAt`) to ensure skip fires.
- **Extension startup path:** Add integration test measuring `activate()` duration; assert `syncTerminalRegistryWithState` is not awaited and `deregisterAllTerminals.then()` resolves without blocking.
- **Terminal sync:** Add test for `_syncTerminalRegistryWithStateImpl` early-exit when `runtime.terminals` config is empty, and confirm PID timeout reduced to 1000 ms.
- **Activation events:** Manual verification — install extension in a clean VS Code window, do not open Switchboard, confirm `activate()` does not run (no `switchboard.activate` timer in console). Then run `Switchboard: Open AUTOBAN` from command palette and confirm activation triggers.
- **Plan scanner / integration auto-pull:** With lazy activation, open sidebar, wait 10 s, confirm plan scanner interval registered and integration auto-pull fires (if configs exist).

## Suggested order
P1 + P2 first (safe, high ROI, no activation-semantics change) → P3 (high impact,
more testing) → P4 folded in.

## Recommendation
Send to Coder.