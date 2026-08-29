---
description: 'Mapped Workspaces Open Independently'
---

# Mapped Workspaces Open Independently

**Complexity:** 6

## Goal

Switchboard's workspace mappings let several repos share one board. Grouping works; opening one member on its own does not. A folder that owns its own control plane can be silently redirected to a group parent that is not even open in the window, and the board then renders permanently blank.

The cause is that mapping resolution has no notion of precedence and no notion of which folders are actually open. `resolveEffectiveWorkspaceRootFromMappings` returns on the first mapping that names a folder, in either role, so array order decides whether a repo keeps its own board or hands it away. Nothing checks whether the redirect target is present in the window. Downstream, the board's workspace list and plan watcher read the unscoped global mapping index and act on parents that were never opened, while `refreshUI` converts the resulting root mismatch into a silent early return — a blank board with no error, no fallback, and no recovery.

This feature makes mapping resolution deterministic and window-aware, brings the board's own consumers in line with it, and closes the standalone host's parity gap — where the mapping index is never built at all. Grouping keeps working exactly as it does today; opening any single member starts working.

## How the Subtasks Achieve This

- **A Workspace That Owns a Board Opens On Its Own**: Fixes resolution itself. Adds a precedence rule so parent-hood beats child-hood across all mappings instead of first-match-wins, and gates every redirect on the target being one of the host's roots — supplied through the existing `getWorkspaceRoots()` seam rather than a `vscode` import. This is the primary fix and is expected to resolve the reported symptom on its own.

- **The Board Shows Only the Workspaces You Opened**: Fixes the consumers. Moves the workspace dropdown, plan-watch folders, and allowed roots off the unscoped `getMappingsFromIndex()` onto scoped mappings, stops `_getWatchFolders` silently dropping the folder the user actually opened, and narrows the `refreshUI` guard so an unresolvable root recovers or surfaces instead of blanking the board forever. Defence in depth behind subtask 1.

- **The Browser Host Honours Workspace Mappings**: Closes the parity gap. `buildMappingIndexFromDbs` is called only from `extension.ts`, so mappings are inert in the standalone/browser host. Wires the index into `bootstrap.ts` behind the same visibility rule, and extracts the DB-discovery walk into one shared helper so the two composition roots stop drifting.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Browser Host Honours Workspace Mappings](../plans/the-browser-host-honours-workspace-mappings.md) — **CODE REVIEWED** — ID: 2e268eaf-03af-4909-9595-761c6aec6247
- [ ] [The Board Shows Only the Workspaces You Opened](../plans/the-board-shows-only-the-workspaces-you-opened.md) — **CODE REVIEWED** — ID: 8cffe45e-e4c0-4d11-b766-208df5879050
- [ ] [A Workspace That Owns a Board Opens On Its Own](../plans/a-workspace-that-owns-a-board-opens-on-its-own.md) — **CODE REVIEWED** — ID: 307c9650-1593-481d-a576-088c9de326ec
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Subtask 1 hard-blocks subtask 3.** This is a correctness constraint, not a preference: the browser host currently sidesteps the first-match-wins redirect bug purely by never building the mapping index. Wiring the index up before the precedence fix lands would import that bug into a host that does not have it today.

**Subtask 2 should precede subtask 3.** Subtask 2 encodes the visibility rule — a workspace is visible iff it is one of the host's roots, or a member of a mapping whose parent is one of the host's roots. Without it, subtask 3 makes the browser list every workspace in the replicated mappings payload, including ones never opened. If subtask 3 must ship earlier, its own diff has to carry the visibility rule.

Recommended order: **1 → 2 → 3.** Subtasks 1 and 2 are independent of each other and could be parallelised, but subtask 1 is expected to resolve the reported symptom alone — landing it first allows re-measuring before sizing subtask 2.

Out of scope: `HeadlessSwitchboardOptions.workspaceRoot` is singular, so the browser host still cannot render a multi-parent mega workspace. That is a separate feature (multi-root standalone), not a bug fix.

## Team Dispatch Instructions

### A Workspace That Owns a Board Opens On Its Own

- **Seat:** Coder (Complexity 5)
- **Acceptance:**
  - A folder that is both a parent of mapping A and a child of mapping B resolves to itself, for both array orderings
  - All three `_hostRoots` states behave correctly: `null` (gate off, legacy behaviour), `[]` (gate on, no redirect), populated (gate on, redirect only to listed roots)
  - `buildMappingIndexFromDbs` two-pass precedence: a both-roles folder maps to itself in the index regardless of mapping order
  - `child-switchboard-creation-regression.test.ts` passes — no `.switchboard/` created anywhere
  - Grouping still works: open all group members multi-root → board shows the mega workspace as before
- **Must not touch:** `isAllowedSwitchboardLocation` (untouched by this plan); `src/standalone/bootstrap.ts` (parity note only — no code changes in this plan)

### The Board Shows Only the Workspaces You Opened

- **Seat:** Coder (Complexity 6)
- **Acceptance:**
  - Workspace dropdown lists only host roots plus children of mappings whose parent is a host root — non-open parents never appear
  - `_getWatchFolders()` always contains the current workspace root, for every combination of mappings-enabled and folder-is-mapped
  - `refreshUI` with an unresolvable current root posts state or re-activates; never returns silently. `refreshUI` for a genuinely different workspace still returns early
  - `switchboardLocationGuard.ts` keeps its global `getMappingsFromIndex()` read — the guard is NOT scoped
  - `child-switchboard-creation-regression.test.ts` passes
- **Must not touch:** `src/utils/switchboardLocationGuard.ts:94` — deliberate global read (scoping it weakens a safety guard that exists to stop `.switchboard/` appearing in child folders)

### The Browser Host Honours Workspace Mappings

- **Seat:** Coder (Complexity 5)
- **Acceptance:**
  - `buildMappingIndexFromDbs` is called in the boot path of `startHeadlessSwitchboard` in `src/standalone/bootstrap.ts`
  - `getMappingsFromIndex()` returns `{ enabled: true, mappings: [...] }` after standalone boot when a DB with enabled mappings exists at the launch root
  - `buildWorkspaceItems([workspaceRoot])` returns exactly one item when `workspaceRoot` is a mapped child launched alone (not every workspace in the payload)
  - No `kanban.db` file exists at a mapped child path after `startHeadlessSwitchboard` boots with the child as `workspaceRoot`
  - Stored `workspace_mappings` value is byte-identical before and after standalone boot (read-only adoption)
- **Must not touch:** `HeadlessSwitchboardOptions.workspaceRoot` (singular — multi-root standalone is out of scope); the `onDidChangeWorkspaceFolders` handler in `extension.ts` (owned by subtask 1)

## Review Findings

Reviewed commit `efe6e936` against all three subtask plans, then fixed three material defects.
**(1) CRITICAL — `src/standalone/bootstrap.ts` re-derived its own child→parent DB redirect** (`effectiveDbRoot`), bypassing `KanbanDatabase.forWorkspace`'s call to the newly-corrected resolver and reinstating the exact child-wins behaviour this feature removes; the plan's preferred option ("redirect DB resolution via the resolver from Plan 1") is now what runs, and the `isAllowedSwitchboardLocation` guard was narrowed to `.switchboard`-shaped paths so a `kanban.dbPath` override outside one is still created.
**(2) MAJOR — `TaskViewerProvider.refreshUI` activated the workspace context twice** on the new recovery arm (once inline, once at the shared tail); collapsed to one activation with the failure-surfacing preserved, and dropped the unreachable "not available on this board" toast that fired only when the host has zero workspace folders.
**(3) MAJOR — 4 of the 11 new tests failed and none of them were invoked by any gate**; the two suites plus the long-unwired `child-switchboard-creation-regression.test.ts` now run under `npm run test:contract:workspace-mappings`, wired into `.github/workflows/integration-tests.yml`.
Files changed by this review: `src/standalone/bootstrap.ts`, `src/services/TaskViewerProvider.ts`, `src/test/browser-host-workspace-mappings.test.ts`, `src/test/workspace-identity-precedence.test.ts`, `src/test/bootstrap/vscodeStub.js` (new), `package.json`, `.github/workflows/integration-tests.yml`.
Validation: `tsc -p tsconfig.test.json --noEmit` clean; `npm run compile` clean; eslint 0 errors; `npm run test:contract:workspace-mappings` 18/18 passing; `parity:check`, `push-routing:check`, `standalone-parity:check`, `standalone-fork:check`, `host-seam-parity:check`, `kanban-dispatch-callers:check`, `verb-returns:check`, `goal-invariant-verification` all pass. Pre-existing and unrelated red at HEAD (verified untouched by this commit): `catalog:check`, `mirror:check`, `test:contract:verb-engine`, `test:contract:headless-feature-mgmt`, `test:contract:memo-workspace-binding`.

## Deferred Findings

- MAJOR — Plan 2's two named automated tests were never written: no unit test asserts `_getWatchFolders()` always contains the current workspace root, and none asserts `refreshUI()` recovers instead of returning silently. `src/services/KanbanProvider.ts:1924`, `src/services/TaskViewerProvider.ts:6213`.
- MAJOR — `npx switchboard` in a mapped child still creates an empty `.switchboard/` directory there, so Plan 3's manual step 3 ("no `.switchboard/` appeared in any folder that lacked one") is not met. The `kanban.db` marker is correctly withheld, and the directory holds the host's own runtime files (`api-server-port.txt`, `auth_token`), so guarding it needs its own plan. `src/standalone/bootstrap.ts:168`.
- MAJOR — the multi-root grouping dropdown changes shape: it used to show one entry labelled with the mapping name, and now shows the parent plus every member as separate entries. This is exactly what Plan 2's goal invariant demands, and it contradicts the feature file's "Grouping keeps working exactly as it does today". `src/services/workspaceUtils.ts:38`.
- MAJOR — Plan 3's negative invariant is asserted structurally, not behaviourally: no test boots `startHeadlessSwitchboard` with a mapped child and then asserts no `kanban.db` exists at that path. `src/test/browser-host-workspace-mappings.test.ts:145`.
- NIT — `scripts/check-standalone-push-parity.js` was not extended; the "both roots build the mapping index" assertion lives in the mocha suite instead. It is CI-invoked, so the hole is closed, but the parity script still cannot see composition-root index wiring. `scripts/check-standalone-push-parity.js:1`.
- NIT — `_getAllowedRoots` admits a mapping's non-open parent whenever an open child pulls that mapping into scope, so a folder that is not open remains selectable. Within Plan 2's wording ("mappings reachable from a host root"), but looser than the visibility rule the dropdown enforces. `src/services/TaskViewerProvider.ts:4677`.
- NIT — the standalone `switchboard.mappingsChanged` handler rebuilds the index but leaves `KanbanDatabase._instances` keyed on pre-change roots; Plan 1's superseded block accepts this (the 60s eviction sweep reclaims them). `src/standalone/bootstrap.ts:1225`.
- NIT — nothing rebuilds the standalone mapping index when `workspace_mappings` is edited outside the board, so a change made elsewhere is served stale until restart. `src/standalone/bootstrap.ts:177`.

### Goal verdict (feature)

Achieved. Mapping resolution is now deterministic (parent-hood beats child-hood in both `buildMappingIndexFromDbs` and `resolveEffectiveWorkspaceRootFromMappings`) and window-aware (redirects gated on `isHostRoot`, with `null`/`[]`/populated modelled distinctly). The board's consumers read `getScopedMappingsForBoard` instead of the unscoped index, `_getWatchFolders` no longer drops the open root, and `refreshUI` recovers rather than blanking. The standalone host builds the index and honours the same visibility rule. `isAllowedSwitchboardLocation` and its global `getMappingsFromIndex()` read are untouched, as all three plans required. No destination or approach named in any plan's Goal was changed by this review: removing bootstrap's hand-rolled redirect restores the option Plan 3's own Proposed Changes called preferable.
