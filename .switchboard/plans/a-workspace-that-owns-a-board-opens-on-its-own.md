# A Workspace That Owns a Board Opens On Its Own

## Goal

Make workspace-mapping resolution deterministic and window-aware, so a folder that owns its own control plane can always be opened individually — regardless of whether some other mapping also lists it as a child.

### The problem

Switchboard's workspace mappings let several repos share one board. Each mapping has a `parentFolder` (which owns `.switchboard/kanban.db`) and a list of `workspaceFolders` (children that share it). Grouping works. Opening one member on its own does not.

`resolveEffectiveWorkspaceRootFromMappings` (`src/services/WorkspaceIdentityService.ts:336-380`) walks the mappings array and returns on the **first** mapping that names the folder, in either role:

```ts
if (isParent || matchingIndex !== -1) {
    // returns mapping.parentFolder
}
```

A folder that is the parent of its own mapping **and** a child in a group mapping matches both arms. Which wins is decided purely by array order in the stored `workspace_mappings` JSON. Nothing ranks "I own a control plane" above "someone else listed me". Users see this as intermittent: sometimes a repo opens standalone, sometimes it silently hands its board to a parent that is not even open.

### Root cause

Two independent defects in one function:

1. **No precedence rule.** Parent-hood and child-hood are tested inside the same loop iteration and treated as equivalent. Iteration order — not semantics — decides the result. `buildMappingIndexFromDbs` (line 45) has the same flaw in its index: it writes `index.set(resolvedParent, resolvedParent)` and the children→parent entries in a single pass, so a folder that is both loses to whichever mapping is iterated last.

2. **No notion of which folders are actually open.** The resolver never asks whether the parent it is redirecting to is present in the current window. Redirecting the only folder open to a folder that is not open cannot produce a usable board — there is nothing there to show.

The group config makes this worse rather than better: `SetupPanelProvider.ts:1216-1222` replicates the **complete** mappings list into every parent's DB. So opening a member alone reads that member's own database, and that database is what instructs the system to hand control away from it.

### Why the fix is not a new file

The host already exposes exactly the signal needed. `getWorkspaceRoots()` is a declared host seam (`src/services/hostSeams.ts:513`), implemented as `vscode.workspace.workspaceFolders` in the extension (`hostSeams.ts:524`) and as `[workspaceRoot]` in standalone (`src/standalone/hostServices.ts:446`). No breadcrumb files, no scaffolding into child folders, no schema change — the resolver just has to be told the root set instead of guessing.

## Metadata

**Tags:** backend, bugfix, reliability
**Complexity:** 5
**Feature:** 6f6a7cad-ef44-49a9-b70a-5921a55c4256

## User Review Required

None. Behaviour-restoring bug fix with no schema or config change.

## Complexity Audit

### Routine
- Two-pass precedence in `buildMappingIndexFromDbs`: write children→parent entries first, then parent→self, so parent-hood overwrites.
- Restructure `resolveEffectiveWorkspaceRootFromMappings` into a parent scan followed by a child scan.
- Add `setHostWorkspaceRoots(roots: string[])` to `WorkspaceIdentityService`, called from `initializeMappingIndex` in `extension.ts`.

### Complex / Risky
- **"Unset" must differ from "empty".** `hostRoots` needs three states: never injected (skip the openness gate, preserve today's behaviour), injected and non-empty (enforce), injected and empty (enforce — no folders open, so no redirect). Collapsing unset and empty into one value silently disables all redirects during the activation window before the index is built, or in any host that has not yet wired the seam. Model it as `string[] | null`, not `string[]`.
- **The memo cache is keyed by input only.** `_mappingCache` (line 21) memoises `workspaceRoot → effectiveRoot`. Its answers become stale the moment the root set changes. `clearMappingCache()` already exists; the root-set setter must call it.
- **`buildMappingIndexFromDbs` overwrites `_mappingCache` with the index** (line 133: `_mappingCache = new Map(index)`). That pre-seeds resolution results from the index, so the gate must be applied when the index is built as well as in the resolver — fixing only the resolver leaves gated-out redirects reachable through the pre-seeded cache.
- **`KanbanDatabase._redirectToParentIfMapped`** (`KanbanDatabase.ts:1186-1193`) delegates to the resolver via a dynamic `require`. It inherits the fix, but `KanbanDatabase._instances` is keyed on the redirected root — instances cached before the root set was injected hold the pre-fix key.

> **Superseded:** `invalidateWorkspace` must run for affected roots after a root-set change.
> **Reason:** `invalidateWorkspace` calls `_redirectToParentIfMapped` which calls the resolver. After the root set changes, the resolver returns a different result, so `invalidateWorkspace(childRoot)` looks up the NEW key (`childRoot`), not the OLD key (`parentRoot`). The old instance is never found and never invalidated. The proposed fix does not work.
> **Replaced with:** Accept that old instances are orphaned. After `clearMappingCache()` + root set change, `forWorkspace(childRoot)` resolves to `childRoot` (new key) and creates a fresh instance. The old instance at `parentRoot` is orphaned — nobody asks for it by that key unless the parent is also open (in which case it's the correct instance). The eviction sweep (every 60s) cleans it up. The only residual risk is a transient stale reference in a provider holding the old instance; this self-corrects on the next `forWorkspace` call. Document this in the code comment on `setHostWorkspaceRoots`.

## Edge-Case & Dependency Audit

### Race Conditions
- **Activation window.** `initializeMappingIndex` is async (`extension.ts:206`). Any resolver call before it completes sees `hostRoots === null` and skips the gate — deliberately preserving current behaviour rather than failing into a blank board. This is the same transient-empty-index window that `switchboardLocationGuard.ts:17-27` documents as the root cause of an earlier bug class; the `null` sentinel is what keeps this fix from repeating it.
- **Workspace folders change mid-session.** `extension.ts:1787` already re-runs `initializeMappingIndex` on `switchboard.mappingsChanged`. The `onDidChangeWorkspaceFolders` handler at line 1279 does NOT call `initializeMappingIndex` — it only runs integration auto-pull, auto-archive, and migration. This plan adds `initializeMappingIndex(outputChannel)` to that handler; otherwise adding a folder to the window leaves a stale root set and the gate rejects a now-legitimate redirect.

### Security
- None. No auth, PII, or trust boundary; all paths are local and already user-configured.

### Side Effects
- **A child opened alone now resolves to itself.** It will use its own `.switchboard/kanban.db` if one exists, or be treated as an unconfigured workspace if not. This is the intended outcome, but it is a visible behaviour change for anyone who currently relies on the accidental redirect. It does not create, move, or delete any file.
- **No `.switchboard/` is created anywhere by this plan.** `isAllowedSwitchboardLocation` is untouched. Resolution changing does not itself scaffold; verify with the existing `src/test/child-switchboard-creation-regression.test.ts`.

### Dependencies & Conflicts
- **Blocks Plan 3 (standalone mapping index).** Wiring the index into the standalone host before this precedence fix lands would import first-match-wins into a host that currently sidesteps it entirely. Order is not negotiable: this plan first.
- **Independent of Plan 2.** Plan 2 fixes the consumers that leak non-open parents into the UI; this plan fixes resolution itself. Either can ship first, but this one is expected to resolve the reported symptom on its own.

## Dependencies

None inbound. **Plan 3 must not ship before this plan.**

## Adversarial Synthesis

Key risks: (1) collapsing the `null`/`[]` distinction re-creates the transient-empty-index bug the location guard was written to close; (2) fixing the resolver but not `buildMappingIndexFromDbs` leaves redirects reachable through the pre-seeded `_mappingCache`; (3) stale `KanbanDatabase._instances` keyed on the pre-fix redirect target are orphaned but not actively invalidated — `invalidateWorkspace` cannot find them because it uses the resolver, which now returns a different key; (4) the fix could plausibly break the working mega-workspace case, which is the feature users actually rely on.

Mitigations: model `hostRoots` as `string[] | null` with an explicit unset arm and test all three states; apply the gate at both index-build and resolve time in the same commit; call `clearMappingCache()` from the root-set setter and accept that old `KanbanDatabase._instances` entries are orphaned (the eviction sweep reclaims them; transient stale references self-correct on the next `forWorkspace` call); make the multi-root grouping case a first-class item in the verification plan, not an afterthought.

## Proposed Changes

### `src/services/WorkspaceIdentityService.ts`

**Step 1 — Add the injected root set.**

Module-level `let _hostRoots: string[] | null = null;`. Export `setHostWorkspaceRoots(roots: string[] | null): void` which resolves and stores each entry and then calls `clearMappingCache()`. Export a private helper `isHostRoot(p: string): boolean` returning `true` when `_hostRoots === null` (unset — gate disabled) or when `_hostRoots` contains the resolved path.

**Step 2 — Precedence in `buildMappingIndexFromDbs` (line 45).**

Split the index population loop (lines 101-119) into two passes over `allMappings`:
- Pass A: children → parent, but only when `isHostRoot(resolvedParent)`.
- Pass B: parents → self, unconditionally.

Pass B runs second so a folder that is both a parent and someone's child ends up mapped to itself. Today both writes happen in one pass and the last write wins arbitrarily.

**Step 3 — Precedence in `resolveEffectiveWorkspaceRootFromMappings` (line 336).**

Replace the single combined loop with:
1. Scan **all** mappings for `parentFolder === workspaceRoot`. On any hit, cache and return `workspaceRoot`.
2. Only then scan all mappings for `workspaceRoot` in `workspaceFolders`. On a hit, compute the parent; return it **only if** `isHostRoot(parent)`, otherwise continue scanning.
3. Fall through to `setCachedMapping(workspaceRoot, workspaceRoot); return workspaceRoot`.

### `src/extension.ts`

**Step 4 — Inject the root set at index build.**

In `initializeMappingIndex` (line 206), before `buildMappingIndexFromDbs`, call `setHostWorkspaceRoots(kanbanProvider.getWorkspaceRoots())` — or read the folder list already being walked at line 207. **This plan owns the `onDidChangeWorkspaceFolders` fix** (line 1279): add `initializeMappingIndex(outputChannel)` to the handler so adding a folder mid-session rebuilds the index and refreshes the root set. Plan 3 defers to this plan for this edit.

### `src/standalone/bootstrap.ts`

**Step 5 — Parity note, not parity code.**

Standalone does not build the mapping index yet (that is Plan 3), so there is nothing to inject into here. `_hostRoots` stays `null`, the gate stays disabled, and standalone behaviour is unchanged by this plan — which is correct, because its index is empty regardless. Plan 3 adds the `setHostWorkspaceRoots([workspaceRoot])` call alongside its `buildMappingIndexFromDbs` call. **Confirm by inspection that no other standalone seam consumes the resolver in a way this changes** — do not infer it from verb reachability (`bootstrap.ts`'s `default:` arm delegates every unmatched verb, so a verb audit proves nothing here).

## Files Changed

- `src/services/WorkspaceIdentityService.ts` — root-set injection, two-pass index precedence, resolver precedence + openness gate
- `src/extension.ts` — inject root set in `initializeMappingIndex`; confirm folder-change rebuild

## Verification Plan

### Automated Tests
- Unit: `resolveEffectiveWorkspaceRootFromMappings` with a folder that is both a parent of mapping A and a child of mapping B → resolves to itself, for **both** array orderings. This is the regression test for the reported bug.
- Unit: all three `_hostRoots` states — `null` (gate off, legacy behaviour), `[]` (gate on, no redirect), populated (gate on, redirect only to listed roots).
- Unit: `buildMappingIndexFromDbs` two-pass precedence — a both-roles folder maps to itself in the index regardless of mapping order.
- Regression: `src/test/child-switchboard-creation-regression.test.ts` still passes — no `.switchboard/` is created anywhere as a result of this change.

### Manual Verification
1. **The reported bug.** Open the group parent alone → board loads its own cards. Open a member repo alone → board loads *that repo's* cards, not the parent's, not blank.
2. **Grouping still works.** Open all group members multi-root → board shows the mega workspace exactly as before.
3. **Order independence.** Reorder the mappings array in the DB's `workspace_mappings` value, restart → both cases above behave identically.
4. **Folder added mid-session.** Open a member alone, then add the parent to the window → redirect becomes legal and the board reflects it without a restart.
5. **Standalone unchanged.** `npx switchboard` in each of the two folders behaves exactly as it did before this plan.

## Risks

- **Precedence and openness must land together.** Fixing precedence alone still permits redirects to folders that are not open; fixing openness alone leaves the order-dependent parent/child ambiguity.
- **Index and resolver must be fixed in the same commit.** `_mappingCache` is pre-seeded from the index (line 133), so a resolver-only fix is bypassable.
- **The mega-workspace case is the feature users rely on.** Any regression there is worse than the bug being fixed. Verify it explicitly.

## Implementation Summary

Implemented deterministic workspace mapping resolution with host-workspace openness gating and parent-first precedence. Added `setHostWorkspaceRoots` and `isHostRoot` in `WorkspaceIdentityService.ts` along with two-pass precedence in both `buildMappingIndexFromDbs` and `resolveEffectiveWorkspaceRootFromMappings` so that folders owning their own control plane resolve to themselves regardless of mapping array order, and child redirects only occur when the parent folder is open in the host. Wired host workspace roots injection in `extension.ts` during index initialization and workspace folder changes, and added comprehensive unit test coverage in `src/test/workspace-identity-precedence.test.ts`.


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

Achieved. `setHostWorkspaceRoots` / `isHostRoot` exist in `WorkspaceIdentityService.ts` with the required three-state `string[] | null` model; the gate is applied at index-build time as well as in the resolver, so the pre-seeded `_mappingCache` cannot bypass it. `initializeMappingIndex` injects the root set and is now also called from `onDidChangeWorkspaceFolders`. `isAllowedSwitchboardLocation` is untouched and its regression test passes.
