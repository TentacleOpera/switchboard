# Three dark control-plane tests fail on a database that no longer auto-creates — fix the harness seam and wire them into CI

## Goal

Make `control-plane-migration`, `control-plane-repo-scope` and `planner-workflow-path-migration` pass, then wire all three into `package.json` and `.github/workflows/integration-tests.yml`. They are currently **dark** (invoked by nothing) **and red** (fail when invoked), which is the worst of both states: the repo carries the maintenance cost of three test files and gets none of their coverage, and nobody finds out because no job runs them.

### Problem Analysis

**All three are invoked by nothing.** Measured directly:

| Test file | in `package.json` | in `integration-tests.yml` |
| :--- | :--- | :--- |
| `control-plane-migration.test.js` | 0 | 0 |
| `control-plane-repo-scope.test.js` | 0 | 0 |
| `planner-workflow-path-migration.test.js` | 0 | 0 |

**All three fail for one shared mechanism.** `KanbanDatabase._initialize` refuses to create a database file that does not exist, logging `Database file does not exist (not auto-creating)` and returning `false`. These harnesses build a temp workspace and never pre-create the `.db` files, so every read against them returns empty and the assertions fail on data that was never loadable.

The causal chain is confirmed end-to-end for two of the three:

- **`control-plane-repo-scope.test.js:152`** — `getCompletedPlansFiltered` returns `[]` where two rows are expected. Completed plans live in the **archive** database, and `kanban-archive.db` is the only DB that fails to initialise in this run (22 occurrences, no `kanban.db` failures). The earlier `getBoardFiltered` assertion against the main DB passes. Direct and unambiguous.
- **`planner-workflow-path-migration.test.js:58`** — asserts the kanban DB initialises and gets `false`, with `lastError=Database file does not exist (not auto-creating)`. The test's own first assertion is the failure.

- **`control-plane-migration.test.js:324`** — `importPlanFiles` returns `0` where `2` is expected. This run shows failures against **both** `kanban.db` (22) and `kanban-archive.db` (16), so it shares the mechanism, but **whether the import count is caused by it is not yet established** and is step 1 of the work below. `importPlanFiles` may be failing for an unrelated ingestion reason and merely running in a workspace whose DBs also do not exist. Do not assume; confirm before fixing.

### Root Cause

The no-auto-create behaviour is deliberate and correct in production — it is what stops a wrong working directory fabricating a stray 0-byte database somewhere it should never exist, the same failure the `query-kanban` skill guards against. What changed is that harnesses written when creation was implicit were never updated. This is a **test-harness debt**, not a product defect: the fix belongs in the fixtures, not in `KanbanDatabase`.

**Do not "fix" this by making `_initialize` create databases again.** That reintroduces the scaffold-litter class the product spent real effort closing, and it would be invisible until a user reported a phantom DB.

### Why this is worth doing rather than deleting the three files

`planner-workflow-path-migration.test.js` is the **dedicated** guard on `RETIRED_WORKFLOW_PATH_MAP` (`agentPromptBuilder.ts`), the map that rewrites workflow paths retired across releases. That safety net exists for an install base on much older versions; a silent break there sends agents at paths that no longer resolve. The map is referenced by one other test file (`mission-control-tick-and-reports-contract.test.js`), but incidentally and from a differently-scoped contract — it is not a substitute.

The two control-plane tests cover migration and repo-scoped board filtering, both of which touch shipped state.

### Non-goals

- **The broader dark-test population.** `test-reachability-ratchet-and-wire-green-tests.md` (CREATED) deliberately excludes failing files — *"Do not wire the 45 failing files here… They are the baseline this plan establishes"* — and names *"triage the failing dark tests"* as a follow-up. This plan is a **narrow slice** of that follow-up: three files with one confirmed shared mechanism. It does not attempt the other 42.
- **Changing `KanbanDatabase`'s no-auto-create behaviour.** See Root Cause.
- **The two currently-red tests that belong to in-flight work.** `seat-safeguards-fleet-prompt-path.test.js` (asserts 7 `_dispatchExecuteMessage` call sites, finds 12) and `catalog:check` are both red from the Mission Control rename landing in `TaskViewerProvider.ts` / `LocalApiServer.ts`. They belong to that work, not here.

## Metadata

**Complexity:** 3
**Tags:** testing, infrastructure, reliability, ci

## User Review Required

None.

## Complexity Audit

### Routine

- Pre-creating the required `.db` files in each harness's temp-workspace setup.
- Adding three `test:contract:*` scripts and three CI steps.

### Complex / Risky

- **`control-plane-migration`'s failure is not yet attributed.** Step 1 is confirmation, not repair. If `importPlanFiles` returns 0 for an ingestion reason, this plan has found a real product bug and the scope grows — surface it rather than absorbing it silently.
- **Which database, and created how.** The two control-plane tests need `kanban-archive.db`, not just `kanban.db`. The archive DB has its own schema path; pre-creating an empty file is not necessarily enough. Establish how a legitimate empty archive DB is produced (the same route the extension uses) rather than touching a zero-byte file into place — a 0-byte file that then fails schema migration is the same failure wearing a different hat.
- **`SCHEMA_TABLES` is not the current schema.** A freshly created DB needs the full migration chain; stamping a baseline to skip it produces a database missing columns these tests read. Use whatever path the product uses to create a real DB.
- **Newly wired tests can fail under CI ordering.** These have only ever been run individually. The ratchet plan records the shared-state hazards — the sql.js WASM heap, the sandboxed state home, `.switchboard/` fixtures — and existing suites carry "ONE temp workspace for the whole suite" notes for that reason. Run all three in one CI job pass before declaring done.
- **sql.js heap exhaustion.** Adding three more DB-opening suites to a job that already runs many is exactly the shape that produces `disk I/O error` across unrelated databases. If that appears after wiring, it is heap exhaustion, not corruption.

## Edge-Case & Dependency Audit

**Race conditions**
- None. Test-fixture setup.

**Security**
- None.

**Side effects**
- CI job time grows by three suites.
- Wiring a previously-dark test can turn a *different* suite red if these pollute shared state. That is a find, not a regression.

**Migration**
- None. Test-only.

## Dependencies

- **Slices `test-reachability-ratchet-and-wire-green-tests.md`** (CREATED). That plan establishes the dark-test baseline and explicitly defers failing files; this takes three of them. If the ratchet lands first, its baseline count drops by three and should be re-measured rather than trusting a number recorded there. Neither blocks the other.
- **Independent of** the Mission Control rename, whose own red tests are listed under Non-goals.

## Proposed Changes

1. **Confirm `control-plane-migration`'s cause.** Pre-create the DBs its harness needs and re-run. If `importPlanFiles` still returns 0, stop and report — that is a product bug in ingestion, and it should get its own plan rather than being folded in here.
2. **Pre-create the required databases in all three harnesses**, using the same creation path the product uses so the full migration chain runs. Both `kanban.db` and `kanban-archive.db` where the test reads completed/archived rows.
3. **Wire all three** as `test:contract:*` scripts in `package.json` **and** as steps in `.github/workflows/integration-tests.yml`. A `package.json` entry alone is a test that never runs — that is the exact hole this plan exists to close, and adding one without the other reproduces it.
4. **Run the three together in one pass** before declaring done, to surface shared-state interference.

### Migration

None.

## Verification Plan

### Goal Invariants

- All three tests pass when run individually **and** when run in sequence in a single process.
- No test creates a database outside its own temp workspace.
- `KanbanDatabase`'s no-auto-create behaviour is unchanged — assert the guard still refuses a missing file.

### Automated

- `npm run test:contract:control-plane-migration`
- `npm run test:contract:control-plane-repo-scope`
- `npm run test:contract:planner-workflow-path-migration`
- The full existing contract suite, to catch shared-state interference introduced by wiring these.

### CI wiring (the point of the plan — verify, do not assume)

- Each of the three scripts above must appear **both** in `package.json` and as a named step in `.github/workflows/integration-tests.yml`. There is one workflow file and every contract test is enumerated in it by hand; no `test:contract:*` sweeper exists in `scripts/`. Grep the workflow for each script name as the acceptance check.
- Confirm the steps land **after** the "Compile test outputs" step — all three load compiled modules from `out/`.

## Outstanding Questions

- Does `importPlanFiles` returning 0 survive a correctly-created database? If it does, this plan has surfaced an ingestion bug and the finding is more valuable than the wiring.
