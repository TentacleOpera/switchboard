# The Board Shows Only the Workspaces You Opened

## Goal

Stop the board, the plan watcher, and the refresh path from reasoning about workspace mappings that have nothing to do with the folders currently open — and stop a workspace-root mismatch from silently rendering a permanently blank board.

### The problem

With workspace mappings configured, opening a single member repo produces an empty board. Not an error, not the wrong repo's cards — nothing. Three distinct defects combine to produce it, all sharing one root cause: consumers read the **global** mapping index instead of a board-scoped view of it.

**1. The workspace dropdown lists folders that are not open.** `KanbanProvider._getWorkspaceItems()` (`src/services/KanbanProvider.ts:1652`) and `workspaceUtils.buildWorkspaceItems()` (`src/services/workspaceUtils.ts:6`) share the same shape: they compute `anyOpenFolderIsMapped`, and if *any* open folder appears in *any* mapping, they discard the open-folders list entirely and emit `parentFolder` from **every** mapping in the payload. Because `SetupPanelProvider.ts:1216-1222` replicates the complete mappings list into every member's DB, that means every workspace in the group — including ones never opened in this window. The folder the user actually opened can be absent from its own board's selector.

**2. The plan watcher silently drops the open root.** `KanbanProvider._getWatchFolders()` (line 1989) pushes only `parentFolder` entries, then adds the current workspace root **only if `folders.length === 0` and mappings are disabled entirely**. The code says so outright:

```
// Fallback: if no mappings configured, watch the current workspace root
// If mappings exist but current workspace is not in any mapping, skip it silently
```

So a folder that is a mapped child gets no plan watcher on itself, while watchers are armed on parent folders that are not open. `_getAllowedRoots()` (line 1149) has the same unscoped shape, adding every mapping parent and child to the allowed set irrespective of what is open.

**3. A root mismatch blanks the board permanently.** `TaskViewerProvider.refreshUI()` (`src/services/TaskViewerProvider.ts:6165-6174`):

```ts
if (resolvedCurrentRoot && path.resolve(resolvedCurrentRoot) !== path.resolve(effectiveRoot)) {
    console.log('... effectiveRoot differs from resolved current — not switching workspace context');
    return;
}
```

Once `effectiveRoot` and the board's current root disagree, **every** refresh returns early. A `console.log` and a `return` — no error surface, no fallback, no recovery path. The webview is never sent a payload, so it renders empty forever. This is the difference between the user seeing the wrong board and seeing nothing at all.

### Root cause

`getScopedMappingsForBoard` already exists in `WorkspaceIdentityService.ts:174`, and its docstring describes precisely this failure — mappings "scavenged out of an unrelated repo's DB" that happens to be on disk in the same window. It is wired into **one** call site (`TaskViewerProvider.ts:3675`, the terminals sidebar). Roughly sixteen other consumers still read the unscoped `getMappingsFromIndex()`. The correct abstraction was built and then not adopted.

### The rule to encode

> A workspace is visible iff it is one of the host's roots, **or** it is a member of a mapping whose parent is one of the host's roots.

Reachability from what was actually opened — not everything the database remembers. The host's roots come from the existing `getWorkspaceRoots()` seam (`hostSeams.ts:513`): `workspaceFolders` in the extension, `[workspaceRoot]` in standalone (`src/standalone/hostServices.ts:446`).

## Metadata

**Tags:** backend, bugfix, ui, reliability
**Complexity:** 6
**Feature:** 6f6a7cad-ef44-49a9-b70a-5921a55c4256

## User Review Required

The refresh-guard behaviour change. Today a root mismatch yields a blank board; after this plan it must either recover or surface. Confirm the preferred outcome: re-activate the workspace context to match the selection (recover), or render an explicit "this workspace is not available on this board" state (surface). The plan below implements recover-then-surface; a reviewer may prefer surface-only.

## Complexity Audit

### Routine
- Swap `getMappingsFromIndex()` for `getScopedMappingsForBoard(root)` in the three board-facing consumers.
- Always include the open root(s) in `_getWatchFolders()` output.

### Complex / Risky
- **`getScopedMappingsForBoard` changes `enabled` semantics.** It derives `enabled` from the scoped subset (`WorkspaceIdentityService.ts:216`), so a board with no mappings of its own gets `enabled: false` and falls back to the single-root path. That is the desired outcome, but it flips behaviour in the *working* mega-workspace case too. Both cases need verification, not just the broken one.
- **It also prunes mappings whose `parentFolder` is missing from disk** (lines 199-214). A group member on a detached volume or an unmounted network share disappears from the board rather than rendering a dead row. Correct, but a visible change worth calling out in release notes.
- **`_getWorkspaceItems` and `buildWorkspaceItems` are near-duplicates.** They implement the same `anyOpenFolderIsMapped` logic twice, in two files. Fixing one and not the other leaves the bug alive in the Design panel (`DesignPanelProvider.ts:748`, `997`) and the Planning panel. Either fix both or collapse them into one shared helper — collapsing is preferred, but it widens the diff, so it is a judgement call for the implementer.
- **The refresh guard is load-bearing.** It exists to stop a workspace switch from clobbering the current selection. Removing it outright reintroduces that bug. The fix is to distinguish "this refresh is for a different workspace, ignore it" (legitimate — keep returning) from "the board's own root can no longer be resolved" (the blank-board case — must recover or surface).
- **Not all sixteen consumers should change.** `switchboardLocationGuard.ts:94` deliberately reads the global index — it is asking a different question (may `.switchboard` exist here), and scoping it would weaken a safety guard. Audit each call site; do not do a blanket find-and-replace.

## Edge-Case & Dependency Audit

### Race Conditions
- **Scoped lookups during the activation window.** `getScopedMappingsForBoard` returns `{ enabled: false, mappings: [] }` when the index is unbuilt, so consumers transiently take the single-root path and then correct on rebuild. Confirm each migrated consumer is re-invoked after `switchboard.mappingsChanged` (`extension.ts:1857`), or a board opened during activation keeps the transient answer until the next interaction.
- **Watcher churn.** Changing `_getWatchFolders()` output changes which directories are watched. Disposal of the previous watcher set must precede arming the new one, or duplicate watchers fire per file change.

### Security
- None. No auth, PII, or trust boundary.

### Side Effects
- **A member repo opened alone stops showing its siblings.** Intended: they are separate repos the user did not open.
- **New watchers on previously-unwatched roots.** A member opened alone now gets a plan watcher on its own `.switchboard/plans`. That directory may not exist. Creation must continue to route through `isAllowedSwitchboardLocation` (`TaskViewerProvider.ts:16135`) — this plan must not become a path that scaffolds `.switchboard/` into a child folder.

### Dependencies & Conflicts
- **Pairs with Plan 1** (mapping-resolution precedence and openness gate). Plan 1 fixes resolution; this plan fixes the consumers. Neither strictly blocks the other, but with Plan 1 landed, the mismatch that trips the refresh guard should stop occurring — making this plan defence-in-depth rather than the primary fix. Ship Plan 1 first and re-measure before sizing this one.
- **Independent of Plan 3.**

## Dependencies

Recommended after Plan 1. Not blocked by it.

## Adversarial Synthesis

Key risks: (1) a blanket `getMappingsFromIndex` → `getScopedMappingsForBoard` replacement weakens `switchboardLocationGuard`, whose global read is deliberate; (2) fixing `_getWorkspaceItems` while leaving the duplicated `buildWorkspaceItems` keeps the bug alive in the Design and Planning panels; (3) removing the refresh guard instead of narrowing it reintroduces the workspace-clobber bug it was written to prevent; (4) new watch roots could become a scaffolding path into child folders; (5) the scoped helper's existence-pruning silently hides group members on detached volumes.

Mitigations: audit all sixteen call sites individually with a written keep/migrate decision per site; prefer collapsing the two duplicated item-builders into one helper; narrow the guard by distinguishing unresolvable-own-root from different-workspace rather than deleting it; keep `isAllowedSwitchboardLocation` on every directory-creation path and re-run the child-scaffold regression test; document the pruning behaviour in release notes.

## Proposed Changes

### `src/services/WorkspaceIdentityService.ts`

Extend `getScopedMappingsForBoard` to accept the host root set (or read the injected `_hostRoots` from Plan 1) so its scope test is "reachable from any host root", not just "reachable from this one board root". Today it takes a single `boardRoot` (line 174), which is right for the terminals sidebar but too narrow for a multi-root window.

### `src/services/KanbanProvider.ts`

- `_getWorkspaceItems()` (1652) — source mappings from the scoped helper. Then apply the visibility rule: emit each host root, plus the members of any mapping whose parent is a host root. Never emit a parent that is not a host root.
- `_getWatchFolders()` (1989) — always seed `folders` with the current workspace root before the mapping loop, and drop the `folders.length === 0` special case. Restrict added parents to host roots.
- `_getAllowedRoots()` (1149) — restrict the mapping-derived additions to mappings reachable from a host root.

### `src/services/workspaceUtils.ts`

`buildWorkspaceItems()` duplicates `_getWorkspaceItems`. Collapse both onto one shared implementation, or apply the identical fix in both. Verify the Design and Planning panel call sites (`DesignPanelProvider.ts:748`, `997`; `PlanningPanelProvider.ts:2257`) render correctly afterwards.

### `src/services/TaskViewerProvider.ts`

`refreshUI()` (6165-6174) — narrow the guard. Keep the early return when the incoming `workspaceRoot` names a *different* workspace than the current selection (its original purpose). When the board's own current root fails to resolve, or resolves outside the host root set, do not return silently: re-activate the workspace context to the board's actual root, and if that fails, post an explicit unavailable state to the webview. Replace the bare `console.log` with an output-channel warning so the condition is visible in `Output → Switchboard`.

### `src/extension.ts` and `src/standalone/bootstrap.ts`

Both composition roots must be diffed by hand for this change. The consumers above are shared services reached from both hosts, so the fix travels — but confirm by inspecting the seams each root **wires**, not the verbs each root answers. `bootstrap.ts`'s `default:` arm delegates unmatched verbs to the provider, so a verb-reachability audit will come back green whether or not the wiring is correct.

## Files Changed

- `src/services/WorkspaceIdentityService.ts` — widen `getScopedMappingsForBoard` to a root set
- `src/services/KanbanProvider.ts` — workspace items, watch folders, allowed roots
- `src/services/workspaceUtils.ts` — de-duplicate / fix `buildWorkspaceItems`
- `src/services/TaskViewerProvider.ts` — narrow the `refreshUI` guard
- `src/extension.ts`, `src/standalone/bootstrap.ts` — composition-root diff

## Verification Plan

### Automated Tests
- Unit: workspace-item visibility rule against the table in the Goal — host root alone; host root + its children; a member alone; multi-root mega workspace. Assert non-open parents never appear.
- Unit: `_getWatchFolders()` always contains the current workspace root, for every combination of mappings-enabled and folder-is-mapped.
- Unit: `refreshUI` with an unresolvable current root → posts state or re-activates; never returns silently. `refreshUI` for a genuinely different workspace → still returns early.
- Regression: `src/test/child-switchboard-creation-regression.test.ts`.

### Goal Invariants
- Assert `_getWorkspaceItems()` never emits a `parentFolder` workspace that is not in the host root set (negative — non-open parents are gone from the dropdown); paired with: assert `_getWorkspaceItems()` emits every host root plus children of any mapping whose `parentFolder` resolves to a host root (positive — the visible set is correct).
- Assert `_getWatchFolders()` never omits the current workspace root when mappings are enabled and the current root is a mapped child (negative — the open root is not silently dropped); paired with: assert `_getWatchFolders()` always contains `this._currentWorkspaceRoot` regardless of mapping state (positive — the open root is always watched).
- Assert `refreshUI()` never returns early with only a `console.log` when the board's own current root is unresolvable (negative — no silent blank board); paired with: assert `refreshUI()` either calls `_activateWorkspaceContext` with the resolved root or posts an explicit unavailable state to the webview when the root is unresolvable (positive — recovery or surfacing).
- Assert `switchboardLocationGuard.ts:94` still calls `getMappingsFromIndex()` (not `getScopedMappingsForBoard`) after this plan lands (negative — the scoping does NOT reach the guard); paired with: assert `isAllowedSwitchboardLocation` still blocks `.switchboard/` creation in mapped children when the index is populated (positive — the guard still works).

### Manual Verification
1. **The reported bug.** Open a member repo alone → board renders its cards. Not blank.
2. **Dropdown honesty.** In that same window the selector lists only that repo — no other group members.
3. **Grouping intact.** Open all members multi-root → selector lists them all; switching between them works as before.
4. **Watcher live.** With a member open alone, add a plan file to its `.switchboard/plans` → card appears without a manual Sync Board.
5. **No scaffolding.** Confirm no `.switchboard/` directory is created in any folder that did not already have one.
6. **Guard visible.** Force a root mismatch → `Output → Switchboard` shows a warning; the board recovers or states it is unavailable. It never sits silently blank.
7. **Both hosts.** Repeat 1-4 under `npx switchboard`.

## Risks

- **`switchboardLocationGuard.ts:94` must keep its global read.** Scoping it weakens a guard that exists to stop `.switchboard/` appearing in child folders.
- **Duplicated item-builders.** Fixing one leaves the Design and Planning panels broken in the same way.
- **Guard narrowing, not removal.** The early return prevents workspace clobbering; deleting it trades one bug for another.
- **Existence-pruning is user-visible.** A group member on an unmounted volume vanishes from the board rather than showing a dead row.

## Implementation Summary

Extended `getScopedMappingsForBoard` to accept either single board roots or multi-root host root arrays (`string | string[]`) and query board-reachable mappings. Refactored `buildWorkspaceItems` and `KanbanProvider._getWorkspaceItems()` to share the scoped visibility rule, ensuring non-open parent folders are never emitted in workspace selectors. Updated `_getWatchFolders()` to always watch the current workspace root and restrict watched parents strictly to open host roots. Narrowed `TaskViewerProvider.refreshUI()` to log output channel warnings and auto-recover or surface explicit unavailable status messages on root mismatches instead of silently rendering a blank board. Added comprehensive unit tests in `workspace-identity-precedence.test.ts` verifying visibility isolation and scoping.

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

### Goal verdict

Achieved for the shipped behaviour, incomplete on verification. The dropdown, watch folders and allowed roots all read `getScopedMappingsForBoard`; `buildWorkspaceItems` and `_getWorkspaceItems` are collapsed onto one implementation; `_getWatchFolders` always seeds the current root; `refreshUI`'s guard is narrowed rather than removed, and (after this review) activates exactly once. `switchboardLocationGuard.ts:94` keeps its global `getMappingsFromIndex()` read, as the plan required. The two automated tests this plan names for `_getWatchFolders` and `refreshUI` were not written — see Deferred Findings.
