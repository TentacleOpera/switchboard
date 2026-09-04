# Six Host Divergences the Parity Gates Do Not See

## Goal

Six places where the extension host and the standalone host behave differently, none of them caught by an existing parity gate, and one of them pinned in place by a green CI assertion.

### Problem analysis

Six reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against HEAD. They belong together because they are the same class the *Defects the Parity Audits Could Not See* feature was created for: divergences that every reachability-based gate reports as fine.

One is worse than a gap. A green contract test is asserting the shape that makes a feature dead in the editor.

## Metadata

- **Complexity:** 6
- **Tags:** both-hosts, parity, standalone, bugfix

## User Review Required

None.

## Proposed Changes

### 1. The Connections Jobs tab is dead in the extension host, and a green gate pins it there

`ConnectionsPanelProvider._forwardOne` (`:153-163`) branches `SETUP_VERBS`, then `PLANNING_VERBS`, then errors with "it is in neither SETUP_VERBS nor PLANNING_VERBS". `LocalApiServer.ts:9190` has a third branch, and `jobsList`, `jobsRefresh`, `jobsInboxList`, `jobsClearStuckClaim`, `jobsDropInstruction`, `jobsMovesList` and `copyTextToClipboard` are all in `TASKVIEWER_VERBS`.

So the Jobs sub-tab works in the browser and is dead in VS Code.

**`connections-routing-contract.test.js:45-49` asserts the two-branch shape.** The gate is green and it is holding the bug in place, so the provider arm and the contract test have to be rewritten together. This is the strongest single finding in the memo.

### 2. Standalone creates an empty `.switchboard/` inside a mapped child

`bootstrap.ts:194-197` calls `mkdirSync(workspaceDir/.switchboard)` unconditionally, before any mapping resolution — the mapping index is only built afterwards at `:203-213`. The `kanban.db` marker is correctly withheld, but the directory is created anyway.

This is the scaffold-litter class. Fixing it requires deciding where `api-server-port.txt` and the auth token live for a mapped child, which is why it is card-sized rather than a one-line guard.

### 3. The standalone mapping index is never rebuilt on an out-of-band edit

`bootstrap.ts:1304-1317` is the sole post-boot caller of `clearMappingCache()` and `buildMappingIndexFromDbs()`, and it fires only on the `switchboard.mappingsChanged` command, which comes from the Setup panel's three in-app save sites (`SetupPanelProvider.ts:1069`, `:1147`, `:1230`).

An edit made anywhere else is served stale until restart. Not among the *Mapping state* feature's three subtasks.

### 4. The team-head batch cap is applied at different granularity on each host

`bootstrap.ts:2549-2551` guards on `partitionPlansByFeature(records).featureGroups.length === 0` over the **entire selection**. `TaskViewerProvider.ts:7851` partitions first, then applies the same predicate per raw group at `:7909-7910`.

Same predicate, different input. One feature plus twelve loose plans sends five on the extension and thirteen on standalone. A source-text parity contract should cover it once fixed.

### 5. Scheduled agent actions cannot run on a fleet host

All ten agent-executed schedule sources end at `vscode.window.createTerminal`. `_ensureSurvivorTerminal` returns `undefined` early on any fleet host (`if (this._hasFleet()) { return undefined; }`), and the caller then records `outcome = 'terminal creation failed'`. `sendRobustText` needs a `vscode.Terminal` regardless, and `_headlessRuntime` — referenced five times in the file — is not consulted here.

The parity sweep card would find this but does not name it.

### 6. Newly wiring `resolveKanbanDispatch` added an undocumented 400

`bootstrap.ts:3362` wires `resolveKanbanDispatch`, added in `cf57044b` among fourteen newly wired options. `LocalApiServer.ts:2388-2392` then fails with 400 when `!gate.role` — and that block is skipped entirely when the option is absent.

So closing a parity gap **changed the standalone API contract**: dispatches that previously proceeded now 400 on a column with no drop action. No test, no documentation. Either document it as the intended contract on both hosts, or fold it into the sixteen-seams follow-up.

## Verification Plan

1. The Jobs sub-tab works in the VS Code extension host, and `connections-routing-contract.test.js` asserts the three-branch shape rather than the two-branch one.
2. `npx switchboard` in a mapped child creates no `.switchboard/` directory, and the port file and token have a stated home for that case.
3. A mapping edited outside the Setup panel is served correctly without a restart.
4. One feature plus twelve loose plans dispatches the same number of cards on both hosts, with a source-text parity assertion covering the predicate's input.
5. A scheduled agent action runs on a fleet host, or reports honestly that it cannot.
6. The 400 on a no-drop-action column is either documented and present on both hosts, or removed.
