---
description: "Verb Engine subtask 4: KanbanProvider burndown — migrate its 144 arms in place onto seams with returned results, fold in the ~10 already-extracted verbs, collapse dispatch, delete shims. The board hot path: moves, dispatch, features, worktrees — byte-compatibility is the whole game."
---

# Verb Engine · 4 — KanbanProvider Burndown (144 arms)

## Goal

Make every `KanbanProvider` verb host-agnostic: all 144 arms run on injected seams, return their results in the HTTP body (push kept additive), and dispatch through the generic allowlist+schema registry; the ~10 verbs genuinely extracted during the earlier shim experiment are folded onto the same pattern; the provider's shims are deleted.

**Problem / context:** This is the board's hot path — card moves, agent dispatch, feature operations, worktree routing, batch column actions. It has the strictest byte-compatibility stakes of the five providers: reply timing, push shapes, and `workspaceRoot` resolution here are load-bearing for the shipped extension (~4,000 installs) *and* for external API consumers (`/kanban/move`, `/kanban/dispatch` are the documented orchestrator path). Many arms call the extracted command services from subtask 1 (sync, dispatch, worktrees) — this provider is where that extraction proves out. See `a2b-verb-engine-01-foundations.md` for the pattern and `a2b-genuine-verb-extraction-burndown.md` for the design record.

## Metadata
- **Tags:** backend, refactor, api, infrastructure
- **Complexity:** 7
- **Release phase:** After Verb Engine 1. Parallelizable with other provider subtasks (one agent stream per provider file).

## User Review Required
- None — contract and pattern fixed in subtask 1.

## Scope

### ✅ IN SCOPE
- Migrate all 144 arms in place: `vscode.*` / `executeCommand` / raw `postMessage` → seam / domain-service / broadcaster calls; add `return` of each arm's result without reordering side effects.
- Fold the ~10 previously-extracted Kanban verbs onto the uniform pattern (registry + schema + returned result) so there is exactly one shape.
- Dispatch-adjacent arms call the subtask-1 domain services (dispatch/sync/worktree) — no `executeCommand('switchboard.*')` left in any arm.
- Collapse the per-verb switch onto the generic registry; per-verb input schemas (move/dispatch payloads validated strictly — these are the most-called external endpoints).
- Delete `kanbanService`'s string-keyed shims; keep genuinely shared domain logic only.

### ⚙️ OUT OF SCOPE
- Other providers. Terminal backend internals (B3). New verbs or behavior changes.

## Implementation Steps
1. Batch ~20–30 arms; migrate in place per the subtask-1 recipe; `compile-tests` gate between batches; merge incrementally.
2. Migrate move/dispatch/feature/worktree arm clusters as coherent batches so cross-arm invariants (column persist before dispatch; subtask column exclusion) stay reviewable.
3. Delete shims; confirm parity gate reports Kanban at 144/144, 0 shims.

## Complexity Audit
### Routine
- Read-verb arms (board/plans/columns queries) — swap + return.
### Complex / Risky
- **Move/dispatch ordering invariants:** column persist must precede dispatch; batch operations must keep excluding feature subtasks (`kanban_column` divergence). Existing provider tests encode these — they must pass unchanged.
- **Push-shape stability** for the board webview (optimistic render, activity lights) — pushes stay byte-identical, results are additive.

## Dependencies
- Verb Engine 1 (domain services for dispatch/sync/worktrees are this provider's backbone).

## Verification Plan
### Automated
- Provider tests pass unchanged. All 144 arms pass under the test-seam bundle. Ratchet: 144/144, 0 shims.
### Manual / behavioral
- Drag a card, dispatch a plan, create/split a feature, run a worktree cleanup — identical behavior via webview and via `POST /kanban/verb/<name>` / documented endpoints, with results now readable in the HTTP body.

---

## Implementation Notes (completed 2026-07-16)

Delivered:
1. **All 144 arms migrated in place** — `_handleMessage` → `Promise<any>`; every arm swapped `vscode.*` → seams (`this._seams()` lazy accessor added, Design pattern) and `break` → `return {success, ...data}` with pushes unchanged and in order. Post-migration audit: **zero `vscode.` references and zero `break;` statements** in the switch.
2. **Seam growth (per protocol):** `HostPathConfigProvider.updateConfigGlobal` (the two `terminal.clearBeforePrompt*` global config writes) and `HostUI.showModalWarningMessage` (archiveSelected's modal feature-subtask choice) — interface + vscode impl + test-helper recorders (`configWrites`, `modalWarningResult`, plus `warningMessageResult` for choice-button flows).
3. **Folded kanbanService verbs (10)** onto the uniform pattern: arms now `return` the service result (selectPlan, openPlanByPath, refresh, scanFoldersNow, focusTerminal, fileExists, getRemoteConfig, setRemoteConfig, getSetting, saveSetting); stale vscode-coupled else-fallbacks seam-routed. kanbanService held no string-keyed shims to delete (already trimmed in subtask 1's cleanup) — only genuine domain methods remain.
4. **Shared helpers seam-routed:** `_getWorkspaceRoots` (workspace seam) and `_resolveWorkspaceRoot`'s `autoSelectFirstWorkspace` read (pathConfig seam) — both on the arm hot path.
5. **Schemas:** ~40 kanban verb schemas in `verbSchemas.ts`; move/dispatch payloads strict (`triggerAction`, `triggerBatchAction`, `moveCardForward/Backwards`, `moveSelected/All`, prompt verbs), plus plan-lifecycle / project / worktree / feature verbs. Schemaless verbs still pass through (generic-dispatch contract).
6. **Headless test** `src/test/verb-engine-kanban-headless.test.js` (npm `test:contract:verb-engine-kanban`): 17/17 under the vscode trap — allowlist rejection, strict schema rejection, error-in-body guards, UI/clipboard/command/config/editor seam routing, folded-service returns, additive pushes. KanbanProvider's ctor is vscode-coupled, so the harness builds via `Object.create(prototype)` + a real `KanbanService` with a headless ctx (pre-empting `_initKanbanService`, which would rebuild vscode seams).

Gates at completion: `compile-tests` ✅, `catalog:check` ✅ (615 arms / 525 verbs, no drift), `parity:check` ✅, `push-routing:check` ✅ (baseline 1 unchanged), `test:contract:verb-engine` 18/18 ✅, `test:contract:verb-engine-kanban` 17/17 ✅. Ratchet: **Kanban 144/144, 0 shims.**

Notes: `direct-create-ticket-regression.test.js` asserted the literal `vscode.commands.executeCommand('switchboard.initiatePlan')` source string — updated to the seam-routed form (same shared command, registry-first). 11 other provider-adjacent regression tests fail identically at HEAD (stash-verified pre-existing, unrelated). Test copies `kanbanColumnDerivationImpl.js` into `out/` (tsc allowJs off — pre-existing gap also noted in sanitize-tags-regression.test.js).
