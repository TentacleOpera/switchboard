# Standalone CLI Scaffolding

**Complexity:** 6

## Goal

Add CLI subcommands to the standalone Switchboard binary for initialising scaffolding into a repo (init), multi-repo control-plane scaffolding (scaffold), and control-plane migration (control-plane detect/preview/migrate). Includes fixing the vscode.window dialog no-op that silently cancels headless multi-repo scaffold when an existing sub-repo kanban.db is found.

## How the Subtasks Achieve This

- **Standalone `init` Command — Bootstrap Switchboard Scaffolding Into a Repo From the CLI**: Wires the existing `ControlPlaneMigrationService.bootstrapControlPlaneLayout` + `KanbanDatabase.createIfMissing` + `ensureWorkspaceIdentity` into a new `npx switchboard init` subcommand, giving standalone users the full protocol layout (`.agents/`, `AGENTS.md`, `CLAUDE.md`, `.claude/`, `kanban.db`, workspace identity) without installing the VS Code extension. Establishes the CLI idioms (subcommand placement, `__setStandaloneWorkspaceRoot`-before-services ordering, `--target` via the existing `updateConfigWorkspace` write path) the second subtask builds on.
- **Standalone Multi-Repo Scaffold + Control Plane CLI Commands**: Adds `scaffold` (multi-repo Fresh Setup from the CLI) and `control-plane detect/preview/migrate` subcommands, and fixes the headless silent-cancel bug by threading an explicit, backward-compatible `headlessDefaults` parameter through `MultiRepoScaffoldingService.scaffold` → `_reviewSubRepoDb` (delete sub-repo DB by default, `--keep-sub-repo-db` to opt out), with a `_headless` flag on `SetupPanelProvider` so the browser-UI standalone path gets the same fix. Source cleanup on migrate is opt-in via `--cleanup`/`--cleanup-all`.

## Dependencies & sequencing

- **Cross-feature dependencies:** None on other features' plans. One forward-looking note for the B4 npx-distribution phase (per the PRD release-phase map): the published tarball must carry `.agents/` + `AGENTS.md` at the package root (express via `.npmignore`, not `files` — `files` conflicts with `.vscodeignore`); the init/scaffold commands warn at runtime if the bundled files are missing.
- **Shipping order within this feature:** Subtask 1 (`init`) lands **first** — it establishes the subcommand block placement in `cli.ts`, the base `usage()` help text, and the shim/config-ordering idiom. Subtask 2 (`scaffold` + `control-plane`) lands **second** and appends to that base; its Dependencies section records this. Coding both in one branch in that order is also fine (one delivery unit).
- **Prerequisites/guards:** Standalone bundle already built (`dist/standalone/cli.js`); verification in both plans is manual smoke only (no compilation, no automated tests per dispatch directive). The shipped extension path must stay byte-compatible (PRD contract #2) — `headlessDefaults` is optional and the extension dialog path is untouched.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Standalone `init` Command — Bootstrap Switchboard Scaffolding Into a Repo From the CLI](../plans/feature_plan_20260804081225_standalone-init-scaffolding-command.md) — **CODE REVIEWED**
- [ ] [Standalone Multi-Repo Scaffold + Control Plane CLI Commands](../plans/feature_plan_20260804081226_standalone-multi-repo-scaffold-and-control-plane-cli.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Completion Report

Implemented `npx switchboard init`, `scaffold`, and `control-plane detect/preview/migrate` subcommands in `src/standalone/cli.ts`, updated `usage()` help. Added `headlessDefaults` to `ScaffoldOptions` / `MultiRepoScaffoldingService._reviewSubRepoDb` to fix silent headless cancel; added `SetupPanelProvider._headless` and set it in `src/standalone/bootstrap.ts`. No compilation or automated tests run per dispatch directive.

## Review Findings

Reviewer pass ran compilation and tests independently (no skip directive was present in the dispatch, so the coder's "no tests run" note was treated as a record, not an instruction) and found two CRITICALs that plan-compliance alone would have missed — both commands' headline deliverables were inert. `init` wrote no `kanban.db` whatsoever (`createIfMissing`'s `_persist()` only arms a 300 ms debounce; the handler hard-exited first), and `control-plane migrate` aborted on every fresh parent (`executeMigration` used `ensureReady()`, which never creates a DB). Also fixed: a bare re-init clobbering an existing `protocol.target`, unparseable JSON from `detect/preview/migrate` (`console.log`/`info`/`debug` all land on stdout in Node), the shim/DB-path root resolving to the cwd instead of the target dir, and `.switchboard/` litter in arbitrary launch directories. Files changed: `src/standalone/cli.ts`, `src/services/ControlPlaneMigrationService.ts`, `src/test/multi-repo-scaffolding.test.js`, `src/test/control-plane-repo-scope.test.js`; `compile`, `compile-tests`, all five PRD gates and eslint are clean, `multi-repo-scaffolding.test.js` went red→green, and live smoke against `dist/standalone/cli.js` confirms a 245,760-byte v57 DB from `init` plus all three `control-plane` subcommands exiting 0 with pure JSON. Remaining risks: the CLI `scaffold` clone path is unverified without network + a real PAT, and three suites stay red at **pre-existing** assertions (`importPlanFiles` discovery, `getCompletedPlansFilteredByProject`, and the setup-panel sidebar check) — all red at baseline before this feature and unrelated to it.

