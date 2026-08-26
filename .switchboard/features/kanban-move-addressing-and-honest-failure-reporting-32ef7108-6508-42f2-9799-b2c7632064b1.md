# Kanban Move Addressing and Honest Failure Reporting

**Complexity:** 5

## Goal

A card move can fail for four distinguishable reasons and today they all surface as the single string Column update failed, which reads as a refused transition when the real cause is almost always that the card was looked for in the wrong workspace database. These three plans close both halves of the addressing bug - the server guessing a root and the client sending a relative one - and widen the return channel so the reason survives to the caller. They came out of one investigation session on 2026-08-08 and share the same call chain end to end.

## How the Subtasks Achieve This

- **POST /kanban/move Silently Defaults to the First Registered Root**: resolves a card by identity across all registered roots instead of falling back to the extension's own workspace — the server-side half.
- **move-card.js Sends a Caller-Relative Workspace Root**: absolutizes the root before it crosses the process boundary, so the documented two-argument invocation targets the caller's workspace — the client-side half.
- **"Column update failed" Masks Plan Not Found**: replaces the boolean return with a reason, and fixes the prerequisite defect that `updateColumnByPlanFile` reports success on a zero-row UPDATE.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [move-card.js Sends a Caller-Relative Workspace Root Across a Process Boundary, So Its Documented Two-Argument Form Silently Targets the Wrong Database](../plans/feature_plan_20260808103000_move-card-script-sends-relative-workspace-root.md) — **CODE REVIEWED** — ID: 8e7d94af-dba3-4376-b332-e826b7b67518
- [ ] [POST /kanban/move Silently Defaults to the First Registered Root, So a Move With No workspaceRoot Fails Against the Wrong Database in Any Multi-Root Setup](../plans/feature_plan_20260808103100_kanban-move-silently-defaults-to-first-root.md) — **CODE REVIEWED** — ID: 232ba645-abc1-43b0-bdab-3f0870f66ccf
- [ ] ["Column update failed" Is Returned When the Card Was Never Found, Making an Addressing Miss Read as a Refused Transition](../plans/feature_plan_20260808103200_column-update-failed-masks-plan-not-found.md) — **CODE REVIEWED** — ID: e8891655-f3c1-4d6f-b871-79e9811c9c72
<!-- END SUBTASKS -->

## Dependencies & sequencing

The rows-modified check inside **"Column update failed" Masks Plan Not Found** is a **prerequisite for its own reason plumbing** — a `no_rows_matched` reason threaded through an unchanged `_persistedUpdate` would be dead code. Land that subtask first.

The two addressing subtasks are independent of each other and can run in parallel, but both are best verified **after** the reason plumbing lands, because the current single error string is what makes them hard to test.

~~⚠ **Cross-feature:** this feature edits `moveCardToColumn`'s signature, which is also touched by *One Board Operation Layer*.~~ **Struck 2026-08-10 (review pass).** The premise was false as built: the Architecture Decision in the reason-plumbing subtask chose **parallel `…WithReason` entry points** precisely so the signature would not change, and `KanbanProvider.moveCardToColumn` is still `(workspaceRoot, sessionId, targetColumn) => Promise<boolean>` at `:6974`. *One Board Operation Layer* is CODE REVIEWED on all three subtasks and already integrated in the same tree — its `_advanceCards` (`KanbanProvider.ts:7190-7308`) consumes `moveCardToColumnWithReason` and reports `outcome.detail`. Both features' gates pass together: `standalone-fork:check` 13/13 and `kanban-dispatch-callers:check` 5/5 alongside this feature's ratchets. No sequencing constraint remains.

**Confirmed live 2026-08-10:** `DELETE /kanban/plans?planId=...` returned `Plan not found` without an explicit `workspaceRoot` and succeeded with one, on this four-root machine. The defect is real and reachable today.

---

## Completion Report — 2026-08-10

All three subtasks implemented in a single session. Files changed: 16 (1 new).

### Subtask 1: "Column update failed" masks plan not found

**Root cause fixed:** `updateColumnByPlanFile` delegated to `_persistedUpdate`, which returns `true` unconditionally when `_db` exists — regardless of rows modified. A zero-row UPDATE (card not in this workspace) was indistinguishable from success.

**Changes:**
- `KanbanDatabase.ts`: Added `ColumnUpdateOutcome` discriminated type (`ok: true | { ok: false, reason, detail }`). New `updateColumnByPlanFileWithReason` runs the UPDATE inline (mirroring `updateFeatureStatus`), inspects `getRowsModified()`, and returns `no_rows_matched` when zero rows hit. New `updateColumnWithReason` for the deprecated session-id path. Existing boolean methods delegate to the `WithReason` siblings and return `.ok` — every current `if (moved)` / `!!moved` call site is preserved.
- `KanbanProvider.ts`: New `moveCardToColumnWithReason` and `moveCardToColumnByPlanFileWithReason` return the full outcome. Boolean methods delegate. All 10 `moveCardsFailed` sites in the webview handler switched from the generic `"couldn't save — board may be out of sync"` to `outcome.detail`. The 5 pinned-block sites (triggerAction, triggerBatchAction, promptOnDrop ×3) are untouched per the plan's pinning constraint.
- `extension.ts`: Registered `switchboard.moveKanbanCardByPlanFileWithReason` command.
- `TaskViewerProvider.ts`: `moveCard` service verb returns `{ success, error, reason }` instead of `{ success, error: 'Column update failed' }`.
- `PlanningPanelProvider.ts`: `moveKanbanPlanColumn` case calls `WithReason` command, returns payload with `reason`, posts real `detail` to webview.
- `verb-return-contract-baseline.json`: Planning ceiling lowered 154 → 152 (ratchet locked).

### Subtask 2: POST /kanban/move silently defaults to first root

**Root cause fixed:** When `workspaceRoot` was omitted, the route fell back to `this._options.workspaceRoot` (the extension's own root) — silently targeting the wrong database in any multi-root setup.

**Changes:**
- `LocalApiServer.ts`: Route split into explicit-root vs omitted-root paths. Omitted path: zero-DB fast path for plan-file-shaped keys (path containment), then `resolvePlanRoots` probe for UUID/sess_* keys. UUID keys stop at first hit; legacy sess_* keys probe all roots and 409 on ambiguity. Column canonicalisation now runs against the RESOLVED root (was: the default root — making custom columns in other workspaces 400). Response echoes `resolvedWorkspaceRoot` + `rootResolution`. New `resolvePlanRoots` option type.
- `TaskViewerProvider.ts`: `resolvePlanRoots` implementation using `KanbanDatabase.forWorkspace` directly (NOT `_getKanbanDb` — avoids per-root warning toasts). Probes with `hasPlan()` (pure boolean, no cold-restore write). De-duplicates by effective root.
- `switchboard-orchestration/SKILL.md`: `POST /kanban/move` row updated with the omitted-root resolution contract.

### Subtask 3: move-card.js sends relative workspace root

**Root cause fixed:** `const workspaceRoot = process.argv[5] || '.'` resolved `.` to `process.cwd()` — correct only when the caller happens to stand at the workspace root. A subdirectory invocation silently targeted the wrong database.

**Changes:**
- `_lib/workspace-root.js` (NEW): Shared `resolveWorkspaceRoot(explicit, startDir)`. Walks up from `startDir` looking for `.switchboard/kanban.db` or `.switchboard/api-server-port.txt`, skipping `~` (global config, not a workspace). Explicit non-`.` arguments are honoured verbatim. Returns `null` when no root is found.
- All 8 `kanban_operations/` scripts: Replaced `process.argv[N] || '.'` with `resolveWorkspaceRoot(process.argv[N])` + fail-loud guard (exit 1 with a actionable message naming the searched-from directory and the explicit-pass escape hatch). Graceful degradation: if `_lib/workspace-root.js` is missing (partial .agents/ sync), falls back to `path.resolve(explicit || process.cwd())`.

### Verification

- Verb-return-contract ratchet: ✅ all providers pass, Planning lowered 154→152
- Parity check: ✅ all providers pass
- Push-routing check: ✅ pass
- TypeScript `tsc --noEmit`: 5 pre-existing TS2835 errors (module resolution style), zero new errors
- `kanban-drag-confirm-before-dispatch` test: ✅ pass
- `workspace-root.js` smoke test: ✅ all 5 cases (repo root, explicit, /tmp fail, `.` fail, explicit from /tmp)
- `move-card.js` fail-loud from /tmp: ✅ exits 1 with actionable message
- `move-card.js` with explicit root from /tmp: ✅ reaches extension

---

## Review Pass — 2026-08-10

Direct in-place reviewer pass over all three subtasks. Four findings fixed (2 MAJOR in the server-side addressing subtask, 2 MAJOR in the reason-plumbing subtask, 2 NIT in the client-side script subtask):

- `verbSchemas.ts` — `moveKanbanPlanColumn` required a field the arm never reads (`column`) and omitted the two it dereferences (`planFile`, `newColumn`), so the verb route the feature exists to de-lie 400'd at the schema boundary. Now permissive and field-accurate.
- `LocalApiServer.ts` — path containment was `startsWith(root + '/')` (a permanent no-op on Windows) and a containment miss silently fell back to the default root without ever probing. Now `path.relative`-based, and a miss falls through to the identity probe.
- `TaskViewerProvider.ts` — `resolvePlanRoots` now probes plan-file-shaped keys with `hasPlanByPlanFile` (equally pure: hot SELECT then cold SELECT, no restore), so a relative plan-file key resolves by identity instead of defaulting.
- `KanbanMigration.ts` — the deliberate zero-row behaviour change would have aborted the legacy-CODED migration and permanently un-stamped the schema version on shipped installs; it now skips `no_rows_matched` only and aborts on every pre-existing failure class as before.
- Two `kanban_operations` fail-loud messages advertised `argv` layouts their scripts do not have.

Verification: `tsc --noEmit` clean apart from 5 pre-existing TS2835 dynamic-import errors; `verb-returns:check` (Planning 152 ≤ 152), `parity:check`, `push-routing:check`, `catalog:check` all green; `drag-confirm-order`, `render-guard`, `verb-engine-kanban-headless` (19/19), `verb-engine-planning-headless` (23/23), `headless-feature-management-contract` (46/46), `kanban-coded-auto-batching-regression` all pass. A behavioural harness against a live `LocalApiServer` with stubbed hooks plus a real sql.js DB confirmed all nine addressing cases, all four reason classes, no-probe-scaffolding, and the workspace-root resolver's `$HOME` trap — 17/17. `kanban-subtask-column-leak-regression` fails on assertion #7 (`kanban.html` `getAllInColumn`), verified byte-identical at HEAD — pre-existing, unrelated. `review-column-persistence-regression` MODULE_NOT_FOUND — pre-existing harness issue.

Gate-wiring audit: the only automated check named in any of the three plans' verification sections is `npm run verb-returns:check`, and it **is** invoked by CI (`.github/workflows/integration-tests.yml:50`). `parity:check` (:35), `push-routing:check` (:38), `drag-confirm-order` (:253) and `render-guard` (:243) are likewise wired. No plan defined a check that CI does not invoke — no "green while incomplete" hole.
