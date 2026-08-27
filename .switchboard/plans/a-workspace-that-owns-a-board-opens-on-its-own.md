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
- **`KanbanDatabase._redirectToParentIfMapped`** (`KanbanDatabase.ts:1183-1192`) delegates to the resolver via a dynamic `require`. It inherits the fix, but `KanbanDatabase._instances` is keyed on the redirected root — instances cached before the root set was injected hold the pre-fix key. `invalidateWorkspace` must run for affected roots after a root-set change.

## Edge-Case & Dependency Audit

### Race Conditions
- **Activation window.** `initializeMappingIndex` is async (`extension.ts:206`). Any resolver call before it completes sees `hostRoots === null` and skips the gate — deliberately preserving current behaviour rather than failing into a blank board. This is the same transient-empty-index window that `switchboardLocationGuard.ts:17-27` documents as the root cause of an earlier bug class; the `null` sentinel is what keeps this fix from repeating it.
- **Workspace folders change mid-session.** `extension.ts:1857` already re-runs `initializeMappingIndex` on `switchboard.mappingsChanged`. Confirm `onDidChangeWorkspaceFolders` also triggers a rebuild; if it does not, add it — otherwise adding a folder to the window leaves a stale root set and the gate rejects a now-legitimate redirect.

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

Key risks: (1) collapsing the `null`/`[]` distinction re-creates the transient-empty-index bug the location guard was written to close; (2) fixing the resolver but not `buildMappingIndexFromDbs` leaves redirects reachable through the pre-seeded `_mappingCache`; (3) stale `KanbanDatabase._instances` keyed on the pre-fix redirect target keep serving the wrong DB until invalidated; (4) the fix could plausibly break the working mega-workspace case, which is the feature users actually rely on.

Mitigations: model `hostRoots` as `string[] | null` with an explicit unset arm and test all three states; apply the gate at both index-build and resolve time in the same commit; call `clearMappingCache()` from the root-set setter and invalidate affected `KanbanDatabase` instances; make the multi-root grouping case a first-class item in the verification plan, not an afterthought.

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

In `initializeMappingIndex` (line 206), before `buildMappingIndexFromDbs`, call `setHostWorkspaceRoots(kanbanProvider.getWorkspaceRoots())` — or read the folder list already being walked at line 207. Verify `onDidChangeWorkspaceFolders` re-runs `initializeMappingIndex`; add it if absent.

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
