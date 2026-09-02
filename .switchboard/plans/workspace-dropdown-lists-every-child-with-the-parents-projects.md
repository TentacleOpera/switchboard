# The workspace dropdown lists every mapped child alongside its parent, and selecting one filters the board by a repo — a dimension plans are not organised on

## Goal

Show only parent workspaces in the board's workspace/project dropdown, and remove the repo-scope filter that selecting a child silently applies. Today a control plane with eight mapped children and seven projects renders 72 options that resolve to 8 distinct boards, and choosing one of the 64 redundant entries filters the board on a dimension the product does not organise plans by.

### Problem Analysis

**Expected:** the dropdown lists the parent workspaces — the boards.
**Actual:** it lists every mapped child as well, and each child repeats the parent's entire project list, so the control is a long repeating list of entries that all open the same board.

**Measured on a live control plane.** `Documents/Gitlab` maps eight `workspaceFolders`, and its board has seven named projects. `buildWorkspaceItems` emits 9 items (parent + 8 children); `updateWorkspaceProjectDropdown` emits one base option plus one per project for each. 9 × (1 + 7) = **72 options**. Only 8 name a distinct board.

**Every child resolves to the parent's database.** `KanbanProvider._getKanbanDb` (`:2568-2573`) routes the root through `resolveEffectiveWorkspaceRoot` before touching the cache, and says why in a comment: *"Use resolveEffectiveWorkspaceRoot so that child workspaces with workspaceDatabaseMappings share the same DB instance as the parent."* Children have no database of their own.

Confirmed live over the tailnet — `GET /kanban/plans?workspaceRoot=…` for the parent and three separate children each returned the identical 163 plans:

```
163  /Users/patrickvuleta/Documents/Gitlab
163  /Users/patrickvuleta/Documents/Gitlab/fe
163  /Users/patrickvuleta/Documents/Gitlab/ai
163  /Users/patrickvuleta/Documents/GitHub/patrickwork
```

**So the repetition is structural, not a data problem.** `_getAllWorkspaceProjects` (`KanbanProvider.ts:1160-1184`) loops every root and does:

```ts
const db = this._getKanbanDb(root);
const workspaceId = await db.getWorkspaceId();
result[path.resolve(root)] = await db.getProjects(workspaceId);
```

All nine roots resolve to one database and one `workspaceId`, so the same seven project names are written under nine different keys. The dropdown then treats those nine keys as nine independent workspaces and expands each against its (identical) project list.

### The second half: selecting a child applies a repo filter that should not exist

**A plan is authored against a project, never against a repo.** Switchboard is built for multi-repo
setups where one body of work is sectioned across several repositories, so a project is the unit a
plan belongs to and a repo is at most a descriptive note about where the code lives. There is no
repo filter in the product.

There is one in the code. `selectWorkspace` (`KanbanProvider.ts:9932-9943`) branches on whether the
selected root is a mapped child and, when it is, sets a filter from the folder name:

```ts
const isChildWorkspace = path.resolve(msg.workspaceRoot) !== effectiveRoot;
if (isChildWorkspace) {
    const repoScope = path.basename(path.resolve(msg.workspaceRoot));
    this._repoScopeFilter = repoScope;
} else {
    this._repoScopeFilter = null;
}
```

That value reaches the board read at `:1340` (`const repoScope = this.getRepoScopeFilter() ?? null`)
and lands in SQL as an exact match:

```sql
AND plans.repo_scope IN (?, '')
```

**The live data shows why an exact match on that column cannot work.** Of 163 plans on the reporting
board, 125 carry no repo scope and 38 carry one — and five of those name more than one repo, in prose:

```
viaapp                              25
fe                                   7
viaapp, fe (spans both repos)        1
viaapp (frontend), be (backend)      1
viaapp, be                           1
fe (primary), viaapp, be             1
viaapp (mobile)                      1
be                                   1
```

`repo_scope` is free text describing where a plan's code sits, and the multi-repo entries are the
design working as intended. Selecting the `fe` child would show 132 plans — the 125 unscoped plus the
7 whose scope is exactly `fe` — and silently drop the two that name `fe` alongside other repos. The
plans most specific to a multi-repo project are precisely the ones the filter hides.

Six of the eight mapped children (`ai`, `viaapp-web`, `funnel-sandbox`, `autism360-analytics`,
`patrickwork`, and any other whose basename never appears in the column) match nothing at all, so
selecting them narrows the board to the 125 unscoped plans and nothing else.

This is a fallback in the sense the constitution now names: `path.basename(childRoot)` produces a
plausible filter value for any folder, so a filter that matches nothing is indistinguishable from a
repo that genuinely has no plans.

### Root Cause

**Two orthogonal things are flattened into one list, and one of them has no distinct values.** The dropdown's axis is *board × project*. Mapped children are not boards — they are folders that share the parent's board — so admitting them multiplies the list by nine without adding a single new destination.

`buildWorkspaceItems` (`workspaceUtils.ts:37-79`) is where children enter. Its visibility rule is stated in a comment — *"A workspace is visible iff it is one of the host's roots, or it is a member of a mapping whose parent is one of the host's roots"* — and the loop at `:60-71` faithfully emits `parentMapping.workspaceFolders` as sibling items of the parent. That rule is correct for deciding **which roots the host may serve**; it is the wrong rule for **what a board picker should offer**, and the same function answers both questions.

The repo filter exists for the same reason: once children are offered as selectable workspaces, something has to decide what selecting one *means*, and repo-scoping was invented to give the action an effect. Remove the children from the picker and the filter has no trigger left — it should go with them rather than survive as an unreachable branch that reads like a feature.

### Non-goals

- **Do not change the mapping config or the setup panel.** The mappings on the reporting machine are correct and deliberate; the folders listed there are intended members. Nothing about this is a config problem.
- **Do not remove children from the host's known-root set.** `_getKnownRoots` (`LocalApiServer.ts:6985`) unions parents and children to validate caller-supplied `workspaceRoot` values, and API callers legitimately pass a child path. That union stays.
- **Do not delete the `repo_scope` column or stop writing it.** It is a useful description of where a plan's code lives and it is populated on ~23% of this board's plans. Only the *filtering* on it is being removed.
- No change to how plans are stored.

## Metadata

**Topic:** Workspace dropdown lists boards, and the repo-scope filter is retired
**Complexity:** 4
**Tags:** webview, ui, kanban, workspaces, dead-code, bug

## User Review Required

None. Both halves were stated directly by the product owner: only parent workspaces appear in the dropdown, and there is no repo filter — plans are organised by project, because a project may span repos.

## Complexity Audit

### Routine
- Filtering children out of the list the dropdown consumes.
- Dropping the redundant per-child keys from `_getAllWorkspaceProjects`.

- Deleting the repo-scope filter field, its accessors, and the `selectWorkspace` branch that sets it.

### Complex / Risky
- **`_repoScopeFilter` is threaded through the board read and the push key.** It appears in the composite early-out key and the snapshot key (`KanbanProvider.ts:284`, `:2354`), in `getBoardFilteredByProject` / `getCompletedPlansFilteredByProject` calls (`:1342`, `:1345`), and in several status payloads (`:1414`, `:2323`, `:4132`). Removing it means the cache keys lose a component — verify the early-out still re-pushes on every context switch it used to, or a board change can be swallowed. Passing `null` at the call sites is the low-risk first step; deleting the parameter is the follow-through.
- **`getBoardFilteredByProject` is shared.** Its `repoScope` parameter has callers beyond this path. Pass `null` from the board read rather than changing the method's signature in the same pass.
- **`buildWorkspaceItems` has more than one caller.** It answers "which roots may this host serve" as well as "what goes in the picker". Changing it in place would narrow the first question too. Establish the picker's list as its own derivation — parents only — and leave the existing function's contract alone for any caller that needs the full set.
- **An unmapped root is its own parent.** A workspace with no mapping falls to the `else` arm at `:73-78` and must keep appearing. "Parents only" must mean *parents and unmapped roots*, not *roots that appear as a `parentFolder` somewhere*, or a plain single-folder workspace disappears from its own picker.
- **A stored selection may name a child.** The board persists the selected root, and existing installs may have a child selected right now. Removing children from the options without mapping a stored child selection back to its parent leaves the select with no matching option, which renders as a blank or wrongly-defaulted picker on first load after upgrade.

## Edge-Case & Dependency Audit

**Race conditions:** `_allWorkspaceProjectsCache` (`:310`) is invalidated at `:569`. Reducing the keys it holds does not change its lifecycle, but verify the invalidation still fires on project add/remove so the shorter list is not stale.

**Security:** None. This narrows a UI list; it does not change which roots the API will accept.

**Side effects:** Any UI that reads `allWorkspaceProjects[someChildRoot]` would now get `undefined`. Grep for readers before removing the keys — the dropdown builder guards with `|| []` (`kanban.html:7450`), but a second consumer may not.

**Dependencies & conflicts:** `kanban.html` is a self-contained webview; the change to `updateWorkspaceProjectDropdown` lands in its own inline script. The command surface has a separate dropdown with a related-but-different defect, already covered by `command-workspace-row-shows-every-project.md` — do not merge the two.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) editing `buildWorkspaceItems` in place and silently narrowing the host's servable-root set, breaking API callers that pass a child path — mitigation: derive the picker list separately and leave that function's contract intact; (2) defining "parent" as "appears as a `parentFolder`", which drops every unmapped single-folder workspace from its own dropdown — mitigation: parents *and* unmapped roots, with an explicit test for a workspace that has no mapping at all; (3) leaving a persisted child selection unmapped, so the first load after upgrade shows a blank picker — mitigation: resolve a stored child to its parent on read; (4) treating the duplicate project keys as the bug and de-duplicating those while still listing nine workspaces — the list of *workspaces* is the defect, and the verification counts options, not keys; (5) missing the worktree-creation path (`:15221-15222`) where `isRepoScoped` drives a functional git-root decision, not just a display payload — mitigation: enumerate the site and state the fall-through is intended; (6) leaving the `repoScopeFilter`/`isRepoScoped` fields in the `ControlPlaneSelectionStatus` type definitions after removing them from payloads, causing type errors — mitigation: clean both type definitions (KanbanProvider and TaskViewerProvider).

## Proposed Changes

**1. The picker lists boards (`workspaceUtils.ts` / its consumer).**

Add a derivation that returns one item per board: each open root that is either a mapping parent or has no mapping at all. Mapped children are excluded. Leave `buildWorkspaceItems` itself unchanged for callers that need the full servable set.

**2. Stop writing a project list per child (`KanbanProvider._getAllWorkspaceProjects:1169-1178`).**

Key the result by the resolved effective root rather than by each raw root, so nine identical entries collapse to one. Grep for readers of the removed keys first.

**3. Resolve a stored child selection to its parent.**

When the persisted workspace selection names a mapped child, select its parent instead. One-time on read; nothing is written back.

**4. Retire the repo-scope filter.**

Delete the `isChildWorkspace` branch in `selectWorkspace` (`KanbanProvider.ts:9932-9943`) — with children gone from the picker it can no longer fire — and pass `null` for `repoScope` at the board reads (`:1340-1345`). Then remove `_repoScopeFilter`, `getRepoScopeFilter`, `setRepoScopeFilter` (`:307`, `:8184-8190`) and the field from the payloads that carry it, checking the cache keys as the Complexity Audit describes. Leave `plans.repo_scope` and the `repoScope` parameter on `getBoardFilteredByProject` in place.

**Every remaining reference must go, not just the two named board reads.** The grep in verification step 10 is the safety net, but enumerate them so none is missed: the field decl (`:307`), the board reads (`:1340`, `:13511`), the `filterActive`/`allActiveRows` block (`:2272-2274`, `:3976-3978`), the `activeFilter` payload entries (`:1414`, `:2323`, `:4132`, `:4352`), the snapshot/push keys (`:2354`, `:8230`), the state object (`:8119-8120`), the accessors (`:8184-8190`), the `selectWorkspace` branch (`:9935-9943`), the `activeRepoFilter` payload (`:15341`), and the TaskViewerProvider read (`:20753`). After removal, `getBoardFilteredByProject` / `getCompletedPlansFilteredByProject` calls at `:1342`, `:1345` and `:13512-13513` pass `null` for repoScope (their signatures stay).

**Three additional sites the enumeration above does not name:**

- **Worktree-creation path (`KanbanProvider.ts:15221-15222`).** `cpStatus.isRepoScoped && cpStatus.repoScopeFilter` decides `effectiveGitRoot` — where git commands run for worktree creation. This is a FUNCTIONAL branch, not a display payload. With `_repoScopeFilter` retired, `isRepoScoped` is always `false`, so the branch never fires and `effectiveGitRoot` falls through to `workspaceRoot`. That is the intended outcome — state it explicitly so a coder does not leave the dead `if (cpStatus.isRepoScoped...)` branch in place or try to 'fix' it.
- **Control-plane type definitions.** `repoScopeFilter: string | null` and `isRepoScoped: boolean` are in the `ControlPlaneSelectionStatus` type at `KanbanProvider.ts:110-111`, and mirrored in `TaskViewerProvider.ts:8624-8625` (with usage at `:8640-8641`, `:8717-8718`). Removing the fields from the payloads without removing them from the types leaves type errors. Clean both type definitions.
- **Webview footprint (`kanban.html`).** `activeWorkspaceFilter` (set from `msg.activeFilter` at `:10612`, used in the dropdown signature at `:7436`, the fallback-root selection at `:7504-7505`, and the filter badge at `:7527-7529`) becomes always-`null`. `getWorkspaceItemRepoScope` (`:7376-7380`) becomes dead code — delete it (step #5 covers the rest of the webview cleanup but does not name this function). The `activeFilter` field can stay in the payload as always-`null` (harmless) or be removed; either way the webview must stop branching on it.

**5. Clean up the webview side of the filter.**

`kanban.html` consumes `activeWorkspaceFilter` (set from `msg.activeFilter` at `:10612`) in three places: the dropdown change-detection signature (`:7436`), the fallback-root logic that matches an item by `getWorkspaceItemRepoScope(item) === activeWorkspaceFilter` (`:7504-7505`), and the filter badge (`:7527-7529`). Once the host stops sending `activeFilter`, these become dead code reading a perpetually-`null` value. Remove `activeWorkspaceFilter`, its assignment from `msg.activeFilter`, the badge block, and the repo-scope fallback-root branch (fall back to `currentWorkspaceRoot` directly). The dropdown signature loses the `activeWorkspaceFilter` component. Leave `boardProjectFilter` and the project-filter badge untouched — those are a different filter.

**6. Update the contract test that asserts the filter exists.**

`src/test/control-plane-repo-scope.test.js` has three source-text assertions that break when the filter is removed (lines 185-199): it asserts `_repoScopeFilter` is declared in `KanbanProvider.ts`, that `TaskViewerProvider.ts` calls `getRepoScopeFilter()`, and that `kanban.html` contains `activeWorkspaceFilter = msg.activeFilter || null;`. Remove those three assertions. **Keep** the DB-level assertions (lines 106-178) — `plans.repo_scope` column, `idx_plans_repo_scope`, `getBoardFiltered`, `getCompletedPlansFiltered`, `getBoardFilteredByProject` with `null` repoScope — because the column and DB methods stay. Also keep the `doesNotMatch` assertion at lines 200-204 (no optimistic `currentWorkspaceRoot` mutation) if that behaviour is preserved; re-confirm it against the final webview diff.

**7. Say why in a comment at the picker derivation.**

Mapped children share the parent's database (`_getKanbanDb:2568-2573`), so listing them offers N copies of one board. And plans are organised by project, not by repo — a project may span several repos, which is why `repo_scope` is free text describing where code lives rather than an axis the board filters on. Without this note, the next person to "restore" the children will do so believing they are separate workspaces, and re-derive a repo filter to give the selection an effect.

## Verification Plan

1. On the reporting control plane (8 mapped children, 7 projects), open the board. The dropdown holds **8 options** — `Autism360App` plus its seven projects — not 72. Count them.
2. The mapped children (`ai`, `be`, `fe`, `viaapp`, `viaapp-web`, `funnel-sandbox`, `autism360-analytics`, `patrickwork`) appear nowhere in the dropdown.
3. A second mapping whose parent is also an open root still appears as its own entry with its own projects.
4. A workspace with **no** mapping still appears in its own dropdown. This is the regression fence for the plain single-folder case.
5. Upgrade an install whose persisted selection is a mapped child. The board opens on that child's parent, with a valid selection — no blank picker, no reset to a different workspace.
6. Selecting a project still filters the board exactly as before; the plan counts per project are unchanged from pre-fix.
7. `GET /kanban/plans?workspaceRoot=<a mapped child>` still returns the board's plans — the API's accepted-root set is untouched.
8. Add and remove a project. The dropdown updates, confirming `_allWorkspaceProjectsCache` invalidation still fires with the reduced key set.
9. With the children gone, confirm the board shows **all 163 plans** on the reporting control plane — including the five whose `repo_scope` names more than one repo (`viaapp, fe (spans both repos)`, `fe (primary), viaapp, be`, and siblings). Pre-fix, selecting the `fe` child showed 132 and hid two of those; post-fix there is no selection that hides them.
10. `grep -rn "_repoScopeFilter\|getRepoScopeFilter\|setRepoScopeFilter" src/` returns no hits outside tests. The branch is gone, not merely unreachable.
11. `plans.repo_scope` is still written and still readable — create a plan with a repo scope and confirm the value persists and displays.
12. Switch workspace, project, and column repeatedly and confirm the board re-pushes each time. This is the gate for the cache keys that lost a component.
13. Both hosts: run 1, 2 and 4 against the VS Code extension and the standalone host. `buildWorkspaceItems` is fed by `getWorkspaceRoots()`, which returns the open folder list on one host and a single configured root on the other.
14. `control-plane-repo-scope.test.js` passes after its source-text assertions on `_repoScopeFilter`/`getRepoScopeFilter`/`activeFilter` are removed; the DB-level `repo_scope` assertions still pass unchanged.

### Goal Invariants

- **Negative:** The picker derivation does not emit any mapped child `workspaceRoot` — only mapping parents and unmapped roots.
- **Positive:** An unmapped single-folder workspace (no mapping at all) still appears in the picker.
- **Negative:** `selectWorkspace` in `KanbanProvider.ts` contains no `isChildWorkspace` branch that sets a repo-scope filter from `path.basename`.
- **Negative:** `KanbanProvider.ts` contains no `_repoScopeFilter` field, no `getRepoScopeFilter`, no `setRepoScopeFilter`.
- **Negative:** `kanban.html` contains no `activeWorkspaceFilter` variable and no `msg.activeFilter` read.
- **Positive:** `plans.repo_scope` column and `getBoardFilteredByProject`'s `repoScope` parameter still exist — only the provider-level filter and its webview consumers are gone.
- **Positive:** `buildWorkspaceItems`'s contract is unchanged for non-picker callers (TicketsPanelProvider, PlanningPanelProvider, TaskViewerProvider memo) — the picker-only derivation is separate.
- **Negative:** `control-plane-repo-scope.test.js` contains no source-text assertion on `_repoScopeFilter`, `getRepoScopeFilter`, or `activeFilter`.
