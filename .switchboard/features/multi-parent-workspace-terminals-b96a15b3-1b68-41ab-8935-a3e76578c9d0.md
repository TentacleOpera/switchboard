# Multi-Parent Workspace Terminals

**Complexity:** 5

## Goal

Teach the PTY fleet and the Terminals sidebar about configured parent workspaces, so an operator with two parents can see which repo each terminal is in and spawn into either one. Today every non-worktree terminal collapses into one bucket labelled with the hardcoded string Workspace Root, and because the fleet is pinned to its boot root for the life of the extension host, that label is frequently wrong - it sits above terminals from the parent the operator has already navigated away from, while the New button hands them a shell in that same stale repo. The panel stays fully responsive and quietly gives you the wrong directory, which is the failure mode that costs real time. Three plans: data layer, spawn targeting, then UI.

## How the Subtasks Achieve This

- **PTY Fleet: Report Each Terminal's Parent Workspace**: `create()` already computes the directory it spawns the shell in and then throws it away — this stores it on the handle and reports it as `cwd` in `ptyListTerminals`. The extension proxy then resolves each `cwd` to its owning mapping and attaches `parentRoot` per terminal plus a full `parents[]` list, including parents holding zero terminals. All mapping knowledge stays in the extension host, which already has it; nothing crosses into the pty child. Ships with no UI change — this is the data the sidebar consumes.
- **PTY Fleet: Spawn Into the Active Parent Workspace**: makes a browser terminal open where `OPEN AGENT TERMINALS` in VS Code has always opened. `createAgentGrid` (`extension.ts:3056-3064`) reads the board's current selection and collapses it to its parent at click time; the PTY path never did, so it fell back to the root the host booted on. The fix is those same two calls in `TaskViewerProvider.handlePtyVerb`, filling in `cwd` before forwarding to the child — plus translating an explicit `parentRoot` from the sidebar into a `cwd`. The child's signature does not change. It also removes `create()`'s inference that a non-boot-root `cwd` means "worktree", which would otherwise turn every injected directory into a phantom worktree group.
- **Terminals Sidebar: Parent → Worktree Two-Level Hierarchy**: replaces the single flat `groupsMap` with a parent → worktree accordion seeded from `parents[]`, iterating configured parents first so a parent holding zero terminals still renders with a discoverable `+`. Unattributed terminals land in a trailing Unmapped group rather than vanishing. `OPEN AGENT TERMINALS` needs no client change at all — it posts no target, and the proxy now fills in the active parent for it.

## Reconciled end-state (cross-subtask audit)

The load-bearing decision for the whole feature: **the pty child stays a dumb shell spawner.** It receives a directory and reports the directory it used. It is never told what a "parent workspace" is. Every mapping lookup — choosing the target, and labelling the result — happens in the extension host, which holds the mappings natively and re-reads them on every request.

That is why there is no `--parents` boot argument, no `ptySetParents` verb, no `switchboard.mappingsChanged` wiring and no cached parent set anywhere: an edited mapping takes effect on the next request with no refresh channel, because nothing was cached to go stale.

| Contended surface | Reconciled end-state |
| :--- | :--- |
| **Where the target directory is chosen** | `TaskViewerProvider.handlePtyVerb` (`:1930`), per request, from `getCurrentWorkspaceRoot()` + `resolveEffectiveWorkspaceRootFromMappings()` — a copy of what `createAgentGrid` has always done. Not in `PtyFleetService`, and not at host boot. |
| **Where a `cwd` is resolved to a parent name** | The same proxy, on the response path, via `getMappingsFromIndex()`. The standalone host does the same from `db.getWorkspaceMappings()`, through one shared exported resolver so the two hosts cannot drift. |
| **`worktreePath` on the handle** (`ptyFleetService.ts:95`) | Set only when the caller names a worktree. The spawn subtask removes the `cwd !== workspaceRoot` inference; the sidebar subtask additionally guards at render time, because terminals created before that fix are still live in the fleet. |

**Cut from the earlier draft, deliberately:** path validation against an allowlist (a real pre-existing hole, but a separate ticket — folding it in is what made these plans large), and the `terminals.*` settings-scope work (the defect it fixed does not occur — `_getScopedSetting` reads `globalState` before the workspace tier, and both override flags default to `false`).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [PTY Fleet: Report Each Terminal's Parent Workspace](../plans/pty-fleet-parent-workspace-attribution.md) — **CODE REVIEWED**
- [ ] [PTY Fleet: Spawn Into the Active Parent Workspace](../plans/pty-fleet-multi-parent-spawn.md) — **CODE REVIEWED**
- [ ] [Terminals Sidebar: Parent → Worktree Two-Level Hierarchy](../plans/terminals-sidebar-parent-worktree-hierarchy.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Reconcile against the in-flight plan first.** The operator reports an existing in-flight plan that already carries the active-parent resolution. *Spawn Into the Active Parent Workspace* may be wholly or partly redundant with it; if that plan already injects the `cwd` in the proxy, this subtask reduces to the one-line `worktreePath` fix. Check before starting — do not implement it twice.

**The two backend subtasks are independent of each other.** *Report Each Terminal's Parent Workspace* and *Spawn Into the Active Parent Workspace* touch different concerns (the response path and the request path) and only overlap on two non-adjacent lines of `ptyFleetService.ts`. Either order, or in parallel.

**The sidebar lands last.** *Parent → Worktree Two-Level Hierarchy* needs `parentRoot` and `parents[]` from the reporting subtask to render anything at all, and needs the spawn subtask's `parentRoot` → `cwd` translation for its per-parent `+` (its verification step 5). Everything else in it is independently verifiable.

**No review gates.** All three subtasks are *User Review Required — No*. The only observable behaviour change is the intended one: a terminal opened with no explicit target now lands in the board's active parent instead of the host's boot root, matching what the VS Code grid button has always done.

**Regression surface shared by all three.** Eight terminal contract suites must stay green: `terminal-input-path`, `terminal-solo-popout`, `shell-terminal-strip`, `pty-route-surface`, `terminal-flow-control`, `terminal-token-transport`, `pty-host-gating`, `terminal-operations-no-periodic-reopen`. No verb is added anywhere, so the route surface and the generated verb allowlist are untouched — `pty-route-surface-contract.test.js` should need no changes at all, and if it does, something has drifted from this design.

**Working-tree caveat.** `terminals.js`, `terminals.html`, `KanbanProvider.ts` and `shell-terminal-strip.test.js` all had uncommitted modifications when these plans were reviewed. Rebase before starting and re-read `renderSidebarList()` rather than trusting the cited line numbers.

**Out of scope for this feature, deliberately:** validating caller-supplied paths against an allowlist (a real pre-existing hole in `ptyCreateTerminal`, but its own security ticket), the `terminals.*` settings scope question (the defect it addressed does not occur under the default configuration), running more than one pty host, re-pointing the fleet's `workspaceRoot` on workspace switch, making the pane grid parent-aware (pane headers stay name-only), and changing the flat `${role}-${n}` naming scheme.

## Review Findings

All three subtasks reviewed in one pass; the load-bearing decision held — the pty child stayed a dumb shell spawner, every mapping lookup happens host-side, and no verb was added, so the route surface and verb allowlist are untouched exactly as designed. Three MAJOR issues fixed: grid-button parity (the proxy bypassed `KanbanProvider.resolveEffectiveWorkspaceRoot`'s `kanban.controlPlaneRoot` override — `TaskViewerProvider.ts:1945-1959`), the standalone host silently ignoring `parentRoot` so the per-parent `+` lied under `npx switchboard` (`bootstrap.ts:1045-1052`), and an unattributed terminal being folded into a sole *real* parent instead of Unmapped (`terminals.js:877-887`). Gate-wiring audit found the feature's ~31 named automated checks did not exist as test files at all — closed with `src/test/multi-parent-terminals-contract.test.js` (29 assertions, behavioural on the resolver plus source-text on the host-parity traps), wired into CI; separately, `terminal-operations-no-periodic-reopen` had **no** `package.json` script and **no** CI step despite being named in this feature's shared regression surface, and it fails **stale** on main (its fourth assertion pins `toFields`, `getCustomAgents` and `getJulesAutoSyncSetting`, none of which exist in `implementation.html` any more) — the script now exists, CI wiring is deliberately withheld with that diagnosis in a comment, and repairing the assertion needs its own ticket. Validation: `compile-tests` clean, `compile` clean (3 pre-existing jsdom/canvas warnings), `lint` 0 errors, all five PRD gates green, 16 terminal contract suites plus the new suite green.
