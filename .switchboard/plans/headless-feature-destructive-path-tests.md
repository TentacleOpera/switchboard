---
description: "The headless feature-management review suite covers the create/promote spine but never executes the destructive and convergence paths: reconcileFeatures (the one external agents drive unattended), deleteFeature/splitFeature side effects, removeSubtaskFromFeature, watcher exclusion with a LIVE ingestion engine, and the WS board push over a real socket. Add a sibling contract suite that runs all of them against a standalone-shaped KanbanProvider + real LocalApiServer, wired into CI. Closes the automated-test remainder from wire-feature-management-standalone.md (tests 3, 7, 10, 11, 13 + split)."
---

# Headless Feature Management — Destructive & Convergence Path Tests

## Goal

**Definition of done: every feature-management mutation available over `npx switchboard` — not just create/promote — has a CI-run headless test asserting its full observable contract: in-body result, DB convergence, file-system side effects, watcher suppression, and a board push a real WebSocket client receives.**

### Core problem (root-cause analysis)

The 2026-07-29 code review of the *Headless Feature Management* feature found the entire planned test suite missing and fixed the highest-value half in-review: `src/test/headless-feature-management-contract.test.js` (33 tests) now proves the standalone `KanbanProvider` constructs under the shim and that `createFeature`/`promoteToFeature` dispatch correctly with live schema validation.

What it deliberately did **not** cover — because each needs a heavier harness than a review pass could carry — is the destructive and convergence half of `wire-feature-management-standalone.md`'s verification plan:

- **`reconcileFeatures` convergence (its test 13).** The largest feature operation, and the one **external agent hosts drive unattended** (`improve-feature`, orchestrator restructures). If it breaks headlessly, an agent run against a standalone host fails mid-restructure with nobody watching.
- **Watcher exclusion (test 7).** `promoteToFeature` and `_regenerateFeatureFile` suppress re-import via `GlobalPlanWatcherService.registerPendingCreation`, which delegates to a class-level static on `PlanIngestionEngine` (`GlobalPlanWatcherService.ts:72-73`). The delegation was read-verified — same class, same bundle, shared static — but never run with the ingestion engine **actually watching**. The failure mode if it doesn't land is a duplicate card: the feature file re-imported as a plain plan.
- **Delete/remove/split side effects (test 10).** `_deleteFeature` → `_cleanupFeatureWorktrees`; `_removeSubtaskFromFeature` → `_removeWorktreeRow` + `_pruneWorktrees` + feature-file regen. Same provider code as the extension, so risk is environmental (no worktree manager attached headlessly) — exactly the kind of assumption a test should pin.
- **WS board push end-to-end (test 11).** The review suite ran with `apiServer: null`, so every push was a no-op. The wiring (`kanbanProvider.setApiServer(server)` at `bootstrap.ts:1080`, `pushFullState()` in the verb arms at `:857`) is source-contract-asserted only. If the broadcaster→WS path regresses, every mutation succeeds silently and the board never moves — the exact complaint class that surfaced the whole feature.
- **Hook-route smoke (test 3, scoped).** `POST /kanban/feature` against a standalone-shaped `LocalApiServer` was never exercised over real HTTP. Full two-host table-driven equivalence is deliberately cut (both hosts now execute the same provider methods, so equivalence holds by construction); one live-route smoke per hook family is the proportionate residue.

The harness ingredients all have proven in-repo precedent: the `vscode → out/standalone/vscodeShim.js` module mapping and bootstrap-shaped provider construction (from the review suite), and a real `LocalApiServer` + `ws` client (from `cross-client-scope-contract.test.js`).

## Metadata
- **Tags:** testing, reliability, backend
- **Complexity:** 5
- **Project:** browser-switchboard

## User Review Required
- **None.**

## Scope

### ✅ IN SCOPE
1. New test file `src/test/headless-feature-management-destructive.test.js`, reusing the review suite's patterns: shim-mapped `vscode`, bootstrap-shaped `KanbanProvider` construction, seeded temp-workspace `kanban.db` (empty-file + `ensureReady()`, mirroring `bootstrap.ts:230-241`).
2. `reconcileFeatures` convergence: one manifest call that creates a feature, assigns an existing plan by path, and removes an unmentioned one — asserting the in-body result and the converged DB rows.
3. `deleteFeature` with `deleteSubtasks` **both ways**: feature row gone, subtasks deleted vs detached, seeded worktree rows abandoned, feature file removed.
4. `removeSubtaskFromFeature`: subtask detached, parent feature file's `## Subtasks` block regenerated without it, subtask worktree row abandoned.
5. `splitFeature`: kept/second membership correct, two new feature files, original feature deleted.
6. Watcher exclusion with a **running** `PlanIngestionEngine` on the temp root (initialized the way `bootstrap.ts` initializes it): a feature created via `handleServiceVerb` is not re-imported as a plain plan after the suppression window.
7. WS push end-to-end: real `LocalApiServer` on port 0, `kanbanProvider.setApiServer(server)`, a `ws` client connected to `/ws`; a `createFeature` dispatch is followed by a board-update push frame on the socket.
8. Hook-route smoke: `POST /kanban/feature` (and one sibling, e.g. `/kanban/features/reconcile`) against the same server with the six standalone-shaped hooks returns `200` with data — not `503`.
9. `package.json` script `test:contract:headless-feature-mgmt-destructive` + a step in `.github/workflows/integration-tests.yml`. A check defined but not CI-invoked is the "green while incomplete" hole — wire it in the same change.

### ⚙️ OUT OF SCOPE
- Two-writer feature-file byte-identity (test 8 of the wire plan). Superseded: the companion plan *Standalone Ingestion Feature Callbacks — Delegate to the Real Provider* removes the second writer entirely.
- Full two-host table-driven route equivalence (test 3's maximal form) — see rationale above; the smoke in item 8 is the deliberate residue.
- Tracker (Linear/ClickUp) unlink behaviour beyond asserting the call is *attempted or self-gated* — a fresh temp DB has `setupComplete` false, so `_syncFeatureOutbound` and unlink self-gate; assert no throw and no network attempt, not provider-API effects.
- Any change to `src/services/KanbanProvider.ts` (hard constraint inherited from the wire plan).
- A jsdom/DOM harness for the webview source contracts — different problem, different plan if ever.

## Implementation Steps

1. Scaffold the suite from `headless-feature-management-contract.test.js`: shim mapping, `kanbanColumnDerivationImpl.js` copy-gap workaround, temp root, DB seeding, provider construction, `unhandledRejection` capture, `process.exit` at end (provider/DB timers keep the process alive otherwise).
2. Build small seed helpers: `seedPlan(db, {planId, planFile, column, featureId?})` via `insertFileDerivedPlan` (plan_file stored relative, **resolved to absolute at read time** — assert with `.includes('.switchboard/…')`, never prefix equality), and `seedWorktreeRow(db, …)` via `KanbanDatabase`'s worktree APIs (read the current method names before writing — do not guess).
3. Implement tests 2–5 (scope items) against `kp.handleServiceVerb(verb, {...})` and the public methods the six hooks call (`reconcileFeatures`, `_deleteFeature`, `_removeSubtaskFromFeature`, `splitFeature` — all public, verified in review).
4. Implement the watcher-exclusion test: initialize `PlanIngestionEngine` on the temp root exactly as `bootstrap.ts` does, create a feature through the provider, wait past the suppression window (~3s per the `registerPendingCreation` contract), assert exactly one DB row for the feature file with `is_feature=1`.
5. Implement the server-backed tests (7, 8): construct `LocalApiServer` with the six provider-delegating hooks and `kanbanVerb` routing the three feature verbs (mirroring `bootstrap.ts:853-859` and `:1015-1056`), `start()` on port 0, connect `ws`, assert push frames and route responses. Reuse the auth pattern `cross-client-scope-contract.test.js` uses for `/ws` and `_checkAuth`.
6. Wire the npm script and the CI step.

## Proposed Changes

### `src/test/headless-feature-management-destructive.test.js` (new)

- **Context.** Sibling of the review suite; same runner conventions (plain node, `assert`, ✅/❌ counters, exit code).
- **Logic.** One temp workspace per run; provider + engine + server share it, as they share the process-wide `KanbanDatabase.forWorkspace` cache — which is the production topology.
- **Edge cases.**
  - **sql.js WASM heap:** one DB, close/cleanup at exit; do not create per-test workspaces (heap exhaustion presents as "disk I/O error" across all DBs).
  - The reconcile test must dedupe expectations against the arm's *actual* manifest contract — read `reconcileFeatures` (`KanbanProvider.ts:12358`) before writing assertions; do not transcribe the skill docs.
  - `deleteFeature` deletes immediately — **no confirmation dialogs exist or may be added** (project rule).
  - Watcher test timing: prefer polling the DB with a deadline over one fixed sleep; a fixed 3s sleep is both slow and flaky.

### `package.json` + `.github/workflows/integration-tests.yml`

- Script `test:contract:headless-feature-mgmt-destructive`; CI step after the existing `test:contract:headless-feature-mgmt` step.

## Complexity Audit

### Routine
- Seed helpers, dispatch calls, file/DB assertions — all patterns proven in the two existing contract suites.

### Complex / Risky
- **The ingestion engine and the WS server are the two genuinely new harness pieces.** Both have in-repo precedent but not in combination with a live provider; expect the first run to surface ordering issues (engine initialized before/after provider, server started before `setApiServer`). Mirror bootstrap's order exactly: engine → provider → server → `setApiServer`.
- **Flakiness budget:** watcher suppression and WS delivery are both time-based. Poll with deadlines; never assert on a single `setTimeout`.
- **Worktree seeding** touches DB tables whose API names were not verified in review — step 2's read-first instruction is load-bearing.

## Edge-Case & Dependency Audit

- **Race conditions:** the engine's scan racing the provider's writes is the *subject* of test 6, not an accident to suppress. Keep the engine running during mutation tests only if test 6 has already pinned suppression; otherwise scope the engine to its own test to keep tests 2–5 deterministic.
- **Security:** server-backed tests must pass the same `_checkAuth` the production routes enforce — reuse the token/localhost approach from the cross-client suite; do not weaken auth for testability.
- **Side effects:** everything is confined to an OS temp dir; `fs.rmSync(tmpRoot, …)` at exit.
- **Migration / shipped state:** none — test-only change plus two gate-wiring lines.
- **Dependencies & conflicts:** reuses but does not modify the review suite. Serialise `.github/workflows/integration-tests.yml` edits with other in-flight plans touching CI. If the companion delegation plan lands first, its provider-delegated callbacks change nothing here (the engine setter API is stable).
- **No confirmation dialogs** are added.

## Dependencies

- None hard. Pairs with *Standalone Ingestion Feature Callbacks — Delegate to the Real Provider* (that plan removes the second file-writer this plan would otherwise have had to pin); land in either order.

## Verification Plan

### Automated Tests
The suite **is** the deliverable; its gate is:
1. `npm run test:contract:headless-feature-mgmt-destructive` green locally and in CI.
2. The existing `test:contract:headless-feature-mgmt` stays green (shared cache/topology unchanged).
3. CI wiring check: the new script name appears in `.github/workflows/integration-tests.yml` in the same change that defines it.

### Manual
- One live `npx switchboard` session exercising delete and split from the browser board, confirming cleanup matches the editor's behaviour — the last manual item carried over from the wire plan's checklist.

---

**Recommendation:** Complexity 5 → **Send to Coder.**

**Stage Complete:** CREATED
