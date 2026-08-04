# Standalone: make workspace-root resolution work in the shared providers

## Goal

Give the headless host a resolvable workspace root, so `TaskViewerProvider._resolveWorkspaceRoot()`
stops returning `null` and `KanbanProvider`'s settings helpers stop silently bypassing the workspace
database. Two coupled wiring gaps: the shared providers' root resolution never consults the host
workspace seam that already holds the served root, and `kanbanProvider.setTaskViewerProvider()` is
never called.

> **Superseded:** "the shim never exposes the served workspace as a workspace folder" (as the
> statement of gap 1).
> **Reason:** The shim's empty `workspaceFolders` is a *symptom-adjacent* fact, not the defect. The
> codebase already has the sanctioned mechanism for this exact case — the `HostWorkspace` seam
> (`hostSeams.ts:512-529`), whose `fallbackRoot` exists specifically for "the standalone vscode shim,
> where no folders are registered" — and standalone already supplies it
> (`hostServices.ts:379-381`: `workspace: { getWorkspaceRoots: () => [workspaceRoot] }`). The defect
> is that `TaskViewerProvider._getWorkspaceRoots()` (`:2513-2515`) still reads
> `vscode.workspace.workspaceFolders` directly instead of the seam, which also violates PRD contract
> #3 ("Providers reach the host only through `hostSeams.ts` — never `vscode.*` directly").
> **Replaced with:** gap 1 is "root resolution in `TaskViewerProvider` bypasses the workspace seam".
> Fixing it there fixes the shim case without teaching the shim to synthesise folders — see
> Proposed Changes, and see the Architecture Review for why the shim route is actively worse.

### Root problem / background (verified 2026-08-04 against a booted standalone server; re-verified against source 2026-08-04)

The visible symptom is one boot-log line:

```
[TaskViewerProvider] Cannot start local API server: no workspace root
```

**That line is correct behaviour and is not what this plan fixes.** `_startLocalApiServer`
(`TaskViewerProvider.ts:1801-1806`) bails because `_getWorkspaceRoot()` is null, and bailing is
desirable — `bootstrap.ts` starts its own `LocalApiServer`, and a second one would collide (see
"Confirmed regression" below, which is more severe than a port fight). The line is worth chasing only
because of *why* the root is null.

**Gap 1 — root resolution reads `vscode.*` instead of the workspace seam.**

`TaskViewerProvider._getWorkspaceRoots()` (`:2513-2515`) is the chokepoint:

```ts
private _getWorkspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
}
```

Under the shim that array is a hardcoded empty `const` (`src/standalone/vscodeShim.ts:189`), never
populated; nothing in `bootstrap.ts` assigns it (the sole mention is the comment at `:527`). The shim
*does* already know the root — `__setStandaloneWorkspaceRoot` (`vscodeShim.ts:284-286`) is called from
`bootstrap.ts:281` and stores it on `globalThis`, where `getConfiguration` reads it (`:193`, falling
back to `process.cwd()`, which is why *config* reads have always worked headlessly). But the folder
list is a separate surface, and it is empty.

That makes `_resolveWorkspaceRoot` (`:2690-2710`) unable to succeed by any route, including the one
that supplies the answer:

```ts
if (workspaceRoot) {                                   // explicit argument
    const resolved = path.resolve(workspaceRoot);
    const allowed = this._getAllowedRoots();           // built from _getWorkspaceRoots() → []
    if (allowed.has(resolved)) { return resolved; }
    if (this._getWorkspaceRoots().includes(resolved)) { return resolved; }
}
```

`_getAllowedRoots()` (`:2712`) is built from `_getWorkspaceRoots()`, so both membership tests fail and
**an explicit, correct workspace root is rejected**. Step 2 (the injected
`_kanbanProvider.getCurrentWorkspaceRoot()`) fails the same gate. Step 3 returns `roots[0]` of an
empty array → `null`. `_getWorkspaceRoot()` (`:2671-2673`) is a thin wrapper and returns `null` too.
There are **172** `_resolveWorkspaceRoot(` call sites in the file (exact count verified).

**The seam already exists and is already the convention.** `hostSeams.ts:508-529`:

```ts
// Abstracts `vscode.workspace.workspaceFolders` (every provider's
// `_getWorkspaceRoots`). A headless host answers from its configured roots.
export interface HostWorkspace { getWorkspaceRoots(): string[]; }

export class VscodeHostWorkspace implements HostWorkspace {
    // `fallbackRoot` is the headless (npx) configured root. It is used ONLY when
    // `vscode.workspace.workspaceFolders` is empty — i.e. under the standalone
    // vscode shim, where no folders are registered. ...
```

and `SetupPanelProvider._getCurrentWorkspaceRoot()` (`:254-269`) already does the right thing:

```ts
// Headless test harness injects a seam bundle; prefer it over vscode.
const seamRoots = this._hostSeams?.workspace.getWorkspaceRoots();
if (seamRoots && seamRoots.length > 0) { return seamRoots[0]; }
return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
```

So this plan is not inventing a resolution semantics — it is applying the existing one to the
provider that was never converted. Raw `vscode.workspace.workspaceFolders` reads remaining in the
wired providers: `TaskViewerProvider` 7 (one of them `_getWorkspaceRoots`), `SetupPanelProvider` 7
(two of them the already-seam-guarded resolver above), `TicketsPanelProvider` 2,
`KanbanProvider` 1. This plan converts the **one chokepoint** and records the rest as burndown.

Measured live impact of gap 1 is **narrow**. All 92 panel read verbs were re-probed with the correct
`workspaceRoot` in the payload; exactly one fails from this cause:

```
setup getDefaultPromptPreviews → {"success":false,"error":"Invalid workspace root: Workspace root path cannot be empty."}
```

Supplying `workspaceRoot` cannot help, because the arm forwards nothing:
`SetupPanelProvider.ts:966` calls `this._taskViewerProvider.handleGetDefaultPromptPreviews()` with no
arguments and depends entirely on internal resolution *inside TaskViewerProvider*; the empty result is
then rejected by `KanbanDatabase.ts:1179`. (Confirmed: the resolution happens in TaskViewerProvider,
so converting `_getWorkspaceRoots()` does fix this verb.) For contrast, `getConstitutionPaths` and
`getProjectContextEnabled` both succeed with an explicit root, because `PlanningPanelProvider`
resolves through its own seam rather than this gate — which is why the blast radius today is one verb
and not ninety.

**Gap 2 — `KanbanProvider` never receives its `TaskViewerProvider` reference.**
`bootstrap.ts` calls `setTaskViewerProvider` on `setupProvider` (`:621`) and `planningProvider`
(`:678`), and wires the *reverse* direction for kanban (`taskViewerProvider.setKanbanProvider(kanbanProvider)`,
`:642`) — but never the forward one. (`TicketsPanelProvider` has no such method, so it is not a third
gap.) `KanbanProvider._taskViewerProvider` (`:216`, assigned only by the setter at `:242`) is
therefore permanently `undefined`, and eight helpers degrade:

| Helper | Behaviour with no TaskViewerProvider |
| :--- | :--- |
| `_getSetting:494` | globalState only; never reads the `kanban.db` config table |
| `_getScopedSetting:636` | project tier and workspace-DB tier skipped → globalState → default |
| `_updateSetting:602` | globalState only; no DB mirror |
| `_updateScopedSetting:674` | globalState only; no DB write |
| `_loadOverrideFlags:622` | both override flags stay `false` |
| `saveRoleConfig` path `:598` | `?.saveRoleConfig(...)` on undefined — a silent no-op |
| `getScopedRoleConfig` reads `:557`, `:577`, `:586` | fall back to global/defaults |

Two accuracy notes. The degrade is partly **deliberate** — `:620-621` reads "Pre-wiring (no
`_taskViewerProvider` / root): keep defaults (false)". And the two call sites that look unguarded
(`:500`, `:605`) both sit inside an enclosing `if (this._taskViewerProvider)`, so there is **no
TypeError hazard**; every path degrades rather than throwing. Standalone's `globalState` is a
file-backed memento (`bootstrap.ts:529-560`, installed at `:566-567`), so these writes do persist to a
JSON file — they simply never reach the database.

**Gap 2's setter does more than the wiring line implies (verified).** `setTaskViewerProvider`
(`KanbanProvider.ts:241-247`) is not a plain assignment:

```ts
public setTaskViewerProvider(provider: TaskViewerProvider) {
    this._taskViewerProvider = provider;
    // Constructor's _reloadSettingsFromStore ran before the DB tier was reachable;
    // this second pass is what actually applies scoped values on startup (plan 02 §6).
    this._loadOverrideFlags();
    this._reloadSettingsFromStore();
}
```

So the missing call is also the missing *settings reload*. Two consequences: the plan's earlier
concern about having to re-run `_loadOverrideFlags()` manually is moot (see the Superseded callout in
Proposed Changes), and the behaviour change on first boot is wider than "override flags" — the whole
scoped-settings set is re-read from the DB tier.

**Why this is urgent rather than tidy.** Both gaps are latent today *only* because standalone's
hand-rolled verb arms bypass these helpers entirely — its `getSetting` reads the local `uiSettings`
Map and never calls `_getScopedSetting`. Both become live the moment
`standalone-board-verb-rail-fallthrough` routes 82 verbs into `KanbanProvider`: delegated verbs would
read settings that ignore the workspace DB and write role configs that vanish. This plan is a
**prerequisite** for that one, not a parallel improvement.

### Confirmed regression to defend against (was an Uncertain Assumption; now measured in source)

The previous revision listed "fixing the root may start a competing API server" as the plan's top
uncertainty. It is **confirmed, and it is worse than a port fight.** The chain:

`bootstrap.ts:618` calls `taskViewerProvider.activateHostIntegrations()`. That method
(`TaskViewerProvider.ts:803-834`) ends with `void this._startLocalApiServer()` (`:829`) — and today
that call returns immediately at `:1803` *because the root is null*. Once the root resolves it
proceeds and:

1. **Purges the live PTY fleet's registry rows.** `:1824` calls
   `PtyFleetService.purgePtyTerminals(db)` against the same workspace DB where bootstrap's own fleet
   (`bootstrap.ts:1308-1312`) has just registered. The method's own comment (`:1812-1819`) names this
   hazard: "purge the LIVE fleet's registry rows".
2. **Spawns a second PTY host child.** `:1832` `cp.spawn(process.execPath, [ptyHostScript, ...])`,
   gated only on `ptyReady && !this._ptyHostChild` — and `_ptyHostChild` is undefined on this
   provider, because standalone's fleet is a separate object.
3. **Starts a second `LocalApiServer` and overwrites the discovery file.** Both servers bind
   ephemeral ports (`LocalApiServer.ts:361` — `options.port || 0`), so there is no bind collision.
   The collision is `.switchboard/api-server-port.txt`: `TaskViewerProvider.ts:2388-2392` writes it
   for every eligible root, clobbering the file `bootstrap.ts:1426` wrote. Every consumer that
   discovers Switchboard through that file — `sb_api_call.sh`, the `kanban_operations` scripts,
   orchestration dispatch, the researcher hand-off — would then talk to the wrong server. Ordering
   between the two writes is racy (`_startLocalApiServer` is async and awaits a DB open plus a spawn
   handshake; bootstrap writes at `:1426`), so the failure is intermittent, which is the worst kind.
   `_startApiServerWatchdog()` (`:2399`) then keeps the wrong server alive.
4. **Wakes a second plan-import path.** `_setupPlanWatcher()` (`:12859`) early-returns on
   `!workspaceRoot` today. Once the root resolves it registers **native `fs.watch` handles** on
   `<root>/.switchboard/plans` (the VS Code watcher half is inert under the shim's no-op
   `createFileSystemWatcher`, `vscodeShim.ts:217`, but the `fs.watch` fallback is real) and routes
   creations into `_handlePlanCreation` — racing the `PlanIngestionEngine` that bootstrap already
   runs. `_setupMemoWatcher` and `_validateNoSwitchboardPollution` un-gate the same way.

The seam-based fix in Proposed Changes **structurally avoids all four**, because seams are injected
*after* activation (bootstrap `:618` activate → `:619` `initHeadlessVerbServing`). That ordering must
not be left load-bearing, so an explicit guard on `_startLocalApiServer` ships in the same change.

## Metadata
- **Tags:** backend, bugfix, reliability, cli, refactor
- **Complexity:** 6

## Architecture Review — the approach was challenged

**The plan's original approach:** teach `vscodeShim.ts` to synthesise a single-entry
`workspaceFolders` array from the already-installed global root, so every existing
`vscode.workspace.workspaceFolders` reader starts working unchanged.

**Alternatives considered:**

1. **Seam-first resolution (chosen).** Convert `TaskViewerProvider._getWorkspaceRoots()` to read
   `this._hostSeams?.workspace.getWorkspaceRoots()` before falling back to `vscode.*`. Honours PRD
   contract #3, reuses a seam built for this exact case, matches the pattern
   `SetupPanelProvider:254-269` already uses, preserves multi-root in the editor
   (`VscodeHostWorkspace` returns every folder and only falls back when the list is empty), and keeps
   the roots empty during `activateHostIntegrations()` so the four dormant subsystems above stay
   dormant. Cost: it fixes readers that go through the chokepoint, not every raw `vscode.*` read in
   the codebase — the rest become named burndown rather than a silent claim.
2. **Populate the shim's `workspaceFolders` (the plan's original).** One edit, widest reach. But it
   makes the shim assert a folder list to *every* consumer, including four subsystems that use "no
   folders" as their de-facto headless gate — waking a PTY purge, a duplicate pty host, a discovery-file
   clobber and a duplicate plan watcher. It also entrenches the contract-#3 violation it routes
   around.
3. **Relax the validation gate for headless.** Rejected in the original plan and still rejected: it
   creates a second resolution semantics and weakens a check that exists to stop a request naming an
   arbitrary directory.

**Justification.** (1) beats (2) on both axes that matter here: it is the mechanism the codebase
already chose (the seam's own comment names the standalone shim as its reason for existing), and its
blast radius is the one we want rather than the one we have to defend against. (2)'s single-edit
appeal is exactly what makes it dangerous — a two-line change that boots four editor-host subsystems
inside a host that already runs its own equivalents.

**Goal-vs-appearance probe.** The stated goal is "settings helpers stop silently bypassing the
workspace database". A root that merely *resolves* does not achieve that — the gate is gap 2's
wiring, and its acceptance signal must be a **DB read/write observed at the DB**, not
`_resolveWorkspaceRoot()` returning a string. The plan could otherwise pass by asserting a non-null
root while `KanbanProvider` still answered from the memento. Two consequences, both folded into the
Verification Plan: (a) the DB-tier assertions are the pass bar, not the resolution assertion; and
(b) the previous headline assertion — `POST /setup/verb/getDefaultPromptPreviews` returns previews —
is **not** a valid oracle, because that arm pushes its result and returns a bare ack
(`SetupPanelProvider.ts:966-968`: `this.postMessage({type:'defaultPromptPreviews', previews}); return
{ success: true };`). Asserting on the body would fail after a correct fix.

## User Review Required (decisions, with defaults)

1. **Route resolution through the workspace seam, or populate the shim's `workspaceFolders`?**

   > **Superseded:** "Default (recommended): populate `workspaceFolders`. The shim already holds the
   > root and every consumer expects VS Code's shape; supplying it fixes all 172
   > `_resolveWorkspaceRoot(` sites at once and keeps one code path across hosts."
   > **Reason:** The premise that this is the cheap option is wrong. Populating the shim un-gates
   > `_startLocalApiServer` (PTY-registry purge, duplicate pty host, `api-server-port.txt` clobber),
   > `_setupPlanWatcher` (native `fs.watch` duplicate import path), `_setupMemoWatcher` and
   > `_validateNoSwitchboardPollution` — all four verified in source and all four currently gated
   > only by the empty folder list. It also entrenches a PRD contract #3 violation when the
   > contract-compliant mechanism (`HostWorkspace` seam + `hostServices.ts:379` already supplying the
   > root) is already built and already used by `SetupPanelProvider:254-269`.
   > **Replaced with:** **Default: seam-first resolution.** Convert the `_getWorkspaceRoots()`
   > chokepoint to prefer `this._hostSeams?.workspace.getWorkspaceRoots()`, keep the `vscode.*` read
   > as the fallback (so the editor host is byte-identical), and leave the shim's `workspaceFolders`
   > alone. Still fixes all 172 resolution sites, because they all route through this chokepoint.

   The relax-the-gate alternative stays rejected for the original reason: it would create a second
   resolution semantics and let any authenticated caller supply any path.

2. **Fix both gaps together, or ship gap 1 alone?**
   **Default: together.** Gap 2 alone is inert — `_taskViewerProvider` would be wired to a provider
   that still resolves `null`. Gap 1 alone fixes the one measured verb but leaves `KanbanProvider`
   blind to the DB, which is the half that matters for the fallthrough. They are one deliverable.

3. **Should the headless host report one root or several?**
   **Default: one, from the served `--workspace`.** The CLI accepts a single `--workspace`, and
   `hostServices.ts:379-381` already reports exactly that. Multi-root is a bigger question tied to
   the workspace-mappings feature and should not be invented here. Note the editor host is
   unaffected: `VscodeHostWorkspace.getWorkspaceRoots()` returns every real folder and only consults
   its fallback when the list is empty.

4. **Does the `_startLocalApiServer` guard ship in this change?**
   **Default: yes, in the same commit.** The seam approach means the guard is not needed for
   correctness *today* (seams are injected after activation), which is precisely why it must be
   explicit — a future reorder of two bootstrap lines would otherwise reintroduce a PTY purge and a
   discovery-file clobber with no test to catch it.

## Complexity Audit

### Routine
- The chokepoint conversion is a three-line edit in one method, following an in-repo precedent
  (`SetupPanelProvider:254-269`).
- Adding one missing `setTaskViewerProvider` call mirrors two adjacent lines (`:621`, `:678`).
- The headless workspace seam needs **no** new code — `hostServices.ts:379-381` already returns the
  served root.

### Complex / Risky
- **The recursion trap.** `_getWorkspaceRoots()` must read `this._hostSeams` **directly**, never via
  the `_seams()` accessor. `_seams()` (`TaskViewerProvider.ts:423-428`) lazily builds its bundle with
  `createVscodeHostSeams(this._getWorkspaceRoot() || '', ...)`, and `_getWorkspaceRoot()` →
  `_resolveWorkspaceRoot()` → `_getWorkspaceRoots()`. Routing through `_seams()` therefore recurses
  until the stack blows — and it would blow during `activateHostIntegrations()`, i.e. at standalone
  boot, before any verb is served. This is the single most likely way to get this change wrong.
- **Wiring gap 2 switches the settings store underneath standalone, and reloads it.** Reads that have
  always returned the file-backed memento (or a default) will start returning `kanban.db` config
  rows; writes that landed only in the memento will start mirroring to the DB; and
  `setTaskViewerProvider` itself calls `_reloadSettingsFromStore()`, so the whole scoped set is
  re-read at wiring time. For a workspace previously configured in VS Code, standalone's effective
  configuration changes on first boot after this lands — correct, and a visible change that belongs
  in release notes.
- **Override flags flip from forced-false to real.** `_loadOverrideFlags` currently keeps
  `_workspaceOverrideEnabled` / `_projectOverrideEnabled` at `false` because the root is null. Once the
  root resolves, they read their true values, which changes which tier `_updateScopedSetting` writes
  to (`:678-685`). A workspace with overrides enabled will behave differently — correctly, but
  differently.
- **Four dormant editor-host subsystems sit one resolving root away.** Even with the seam approach
  they are only dormant because of bootstrap's `:618` → `:619` ordering. Enumerated and defended in
  "Confirmed regression" above; the guard in Proposed Changes is what makes the defence explicit
  rather than incidental.

## Edge-Case & Dependency Audit

- **Race Conditions.** With the seam approach the ordering that matters is bootstrap `:618`
  (`activateHostIntegrations`) before `:619` (`initHeadlessVerbServing`, which injects the seams):
  during activation the seam is absent, roots are `[]`, and the four subsystems early-return exactly
  as they do today. By `:621`/`:642` (the `setTaskViewerProvider` calls) the seam is present, so the
  settings reload resolves a real root. Assert this ordering in a test — it is behaviour, not an
  accident to be rediscovered later.
- **Security.** The validation gate at `:2692-2697` exists so a request cannot name an arbitrary
  directory as its workspace root. Answering `_getWorkspaceRoots()` from the seam keeps that
  protection intact and correct — the allowlist becomes "the workspace this server was started on".
  Do **not** short-circuit the gate for headless; that would let any authenticated caller supply any
  path.
- **Side Effects.** `KanbanDatabase.forWorkspace(root)` will now be called from `KanbanProvider`'s
  helpers where it previously was not, opening/attaching the DB from more code paths. The DB is
  already open in standalone, so this should be a no-op, but it is a new caller of a cache-keyed
  factory.
- **Dependencies & Conflicts.** Hard prerequisite of `standalone-board-verb-rail-fallthrough`.
  `bootstrap.ts` currently carries uncommitted Tickets Panel Extraction edits (confirmed via
  `git status`), so expect a merge in the provider-construction block. Supersedes the premise of
  `standalone-persist-ui-settings`: once this lands, `KanbanProvider`'s own `getSetting`/`saveSetting`
  arms (`:10085-10118`) work headlessly, and that plan becomes a deletion rather than a
  reimplementation.

## Dependencies

- None blocking.
- Blocks: `standalone-board-verb-rail-fallthrough` (must land first).
- Rewrites the premise of: `standalone-persist-ui-settings` (see its Superseded callout).
- (No session IDs cited; IDs are assigned on import.)

## Adversarial Synthesis

**Risk summary.** Two small edits with a deceptively large radius: one makes 172 previously-null
resolutions start returning a path, the other switches `KanbanProvider`'s settings store from an
in-process memento to the workspace database *and* triggers a full scoped-settings reload. Nothing
here can throw — every affected site already guards for the null case — so the failure mode is
behavioural, not a crash. The two things that can actually break the build are mechanical and both
are now named: routing `_getWorkspaceRoots()` through `_seams()` recurses to a stack overflow at boot,
and any approach that resolves the root *before* `activateHostIntegrations()` purges the live PTY
registry, spawns a duplicate pty host and clobbers `api-server-port.txt`. Land it on its own, verify
the settings tiers at the database rather than at the resolver, and do not bundle it with the
fallthrough change it unblocks.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — seam-first root resolution

- **Context.** `_getWorkspaceRoots()` at `:2513-2515`; `_resolveWorkspaceRoot()` at `:2690-2710`;
  `_getAllowedRoots()` at `:2712`; `_getWorkspaceRoot()` at `:2671-2673`; the `_seams()` accessor at
  `:423-428`; the in-repo precedent at `SetupPanelProvider.ts:254-269`.
- **Logic.** Prefer the injected host workspace seam; fall back to the raw `vscode` read so the
  extension host is behaviour-identical and so a provider driven before seam injection degrades
  exactly as it does today.
- **Implementation.**
  ```ts
  private _getWorkspaceRoots(): string[] {
      // Seam FIRST (PRD contract #3): the standalone host answers from its configured
      // root (hostServices.ts:379), where vscode.workspace.workspaceFolders is a
      // hardcoded empty array (vscodeShim.ts:189) and every resolution below returns
      // null. Same pattern SetupPanelProvider._getCurrentWorkspaceRoot() already uses.
      //
      // Read `_hostSeams` DIRECTLY — never through `_seams()`. `_seams()` lazily builds
      // its bundle with `createVscodeHostSeams(this._getWorkspaceRoot() || '')`, and
      // _getWorkspaceRoot() → _resolveWorkspaceRoot() → here: routing through the
      // accessor recurses until the stack blows, at standalone boot.
      const seamRoots = this._hostSeams?.workspace?.getWorkspaceRoots();
      if (seamRoots && seamRoots.length > 0) { return seamRoots; }
      return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
  }
  ```
- **Edge Cases.** In the editor `_hostSeams` may be present *and* backed by `VscodeHostWorkspace`,
  which returns every real folder — multi-root behaviour is preserved, and the fallback only fires
  when both the seam and the folder list are empty. Do not "simplify" the empty-array check to a
  null check: an injected seam that legitimately reports zero roots must fall through, not short-circuit
  to `[]`.

### `src/services/TaskViewerProvider.ts` — explicit headless guard on `_startLocalApiServer`

- **Context.** `activateHostIntegrations()` at `:803-834`, ending with `void this._startLocalApiServer()`
  at `:829`; the method at `:1801-1806`; the PTY purge at `:1824`; the child spawn at `:1832`; the
  port-file write at `:2388-2392`; the watchdog at `:2399`.
- **Logic.** A host that runs its own `LocalApiServer` must be able to say so. Add an opt-out the
  standalone composition root sets before it activates host integrations, and early-return from
  `_startLocalApiServer` when it is set — with a log line, so the skip is visible rather than
  mysterious.
- **Implementation.** Preferred: an explicit public flag/setter (e.g. `suppressLocalApiServer`)
  set by `bootstrap.ts` immediately before `activateHostIntegrations()`, checked at the top of
  `_startLocalApiServer` alongside the existing null-root bail. Acceptable alternative if a
  bootstrap-side change is unwanted: sniff
  `(globalThis as any).__SWITCHBOARD_STANDALONE_WORKSPACE_ROOT`, which `bootstrap.ts:281` installs
  before any provider exists — less explicit, zero bootstrap diff. Either way the guard must cover
  the *whole* method, not just the `listen` call, because the PTY purge and the child spawn happen
  before the server starts.
- **Edge Cases.** The guard must not affect the editor host, where the flag is never set and the
  global never exists. Keep the existing null-root bail: the guard is additive defence, not a
  replacement.

### `src/standalone/bootstrap.ts` — wire the forward kanban→taskViewer reference

- **Context.** `__setStandaloneWorkspaceRoot(workspaceRoot)` at `:281`; provider construction at
  `:591-680`; `activateHostIntegrations()` at `:618`; `initHeadlessVerbServing(...)` at `:619`;
  `setupProvider.setTaskViewerProvider(taskViewerProvider)` at `:621`;
  `taskViewerProvider.setKanbanProvider(kanbanProvider)` at `:642`;
  `planningProvider.setTaskViewerProvider(taskViewerProvider)` at `:678`; the stale comment at
  `:623-626` ("Only the three feature verbs are routed to it").
- **Logic.** Add the missing forward wiring next to the existing reverse call, so `KanbanProvider`'s
  settings helpers can resolve a root. Set the API-server suppression flag before `:618`.
- **Implementation.**
  ```ts
  taskViewerProvider.setKanbanProvider(kanbanProvider);
  // Forward direction too: KanbanProvider's settings helpers (_getSetting:494,
  // _getScopedSetting:636, _updateScopedSetting:674, _loadOverrideFlags:622) all
  // resolve their workspace root through this reference. Without it they silently
  // skip the kanban.db config tiers and answer from globalState/defaults.
  //
  // Placement matters: this must run AFTER initHeadlessVerbServing (:619) injects the
  // seams, because the setter itself calls _loadOverrideFlags() + _reloadSettingsFromStore()
  // (KanbanProvider.ts:241-247) and those need a resolvable root to reach the DB tier.
  kanbanProvider.setTaskViewerProvider(taskViewerProvider);
  ```

  > **Superseded:** "Re-run `_loadOverrideFlags()` after wiring if it is only called from the
  > constructor — otherwise the flags keep the `false` they were forced to at construction time."
  > **Reason:** Verified unnecessary. `KanbanProvider.setTaskViewerProvider` (`:241-247`) already
  > calls `_loadOverrideFlags()` **and** `_reloadSettingsFromStore()` for exactly this reason; its
  > comment cites "plan 02 §6". A manual re-run would be a redundant second pass.
  > **Replaced with:** no extra call. Instead, place the wiring after seam injection (above) so the
  > setter's own reload can reach the DB tier, and note in release notes that scoped settings are
  > re-read at this point.

- **Edge Cases.** Update the now-inaccurate comment at `:623-626` in the same change; leaving it
  claiming the provider is only used for three verbs is how the next reader re-derives the wrong
  model. Expect a merge here against the in-flight Tickets Panel Extraction edits.

### Not changed (recorded so the next reader does not redo the analysis)

- `src/standalone/vscodeShim.ts:189` stays a hardcoded empty `workspaceFolders`. That is now a
  deliberate, documented choice — see the Architecture Review. Add a one-line comment pointing at
  the seam so the next reader does not "fix" it.
- The remaining raw `vscode.workspace.workspaceFolders` reads (`TaskViewerProvider` `:1328`, `:1391`,
  `:1551`, `:1620`, `:5988`, `:20046`; `SetupPanelProvider` `:249`, `:1455-1456`, `:1931-1932`;
  `TicketsPanelProvider` ×2; `KanbanProvider` `:1403`) are contract-#3 burndown, not this plan. None
  is on the resolution chokepoint.

## Verification Plan

### Automated Tests

- **Contract — seam-first resolution.** With a headless seam bundle injected (`workspace.getWorkspaceRoots
  → [dir]`) and `vscode.workspace.workspaceFolders` empty, assert `_getWorkspaceRoots()` returns
  `[dir]`, `_resolveWorkspaceRoot()` returns `dir`, and `_resolveWorkspaceRoot(dir)` returns it
  rather than falling through. Assert `_resolveWorkspaceRoot('/some/other/dir')` still returns the
  served root, not the supplied one — this is the security assertion that the gate still gates.
- **Regression — no recursion at boot.** Construct a `TaskViewerProvider` with **no** seams injected
  and call `activateHostIntegrations()`; assert it completes (does not overflow the stack) and that
  `_getWorkspaceRoots()` returns `[]`. This is the test that catches the `_seams()` mistake, and it
  must exist before the chokepoint edit is written.
- **Contract — the four dormant subsystems stay dormant during activation.** Boot standalone and
  assert: no second `.switchboard/api-server-port.txt` write after bootstrap's own (compare file
  mtime/content to the port bootstrap reports), no second pty-host child, and PTY registry rows
  registered by bootstrap's fleet still present after activation (i.e. `purgePtyTerminals` did not
  run). Then assert the guard directly: with `suppressLocalApiServer` set, `_startLocalApiServer()`
  returns without touching the DB or spawning.
- **Regression — the measured verb no longer errors.**
  `POST /setup/verb/getDefaultPromptPreviews` must stop returning
  `Invalid workspace root: Workspace root path cannot be empty.`

  > **Superseded:** "assert `POST /setup/verb/getDefaultPromptPreviews` returns previews instead of
  > `Invalid workspace root: ...`. This is the plan's headline assertion."
  > **Reason:** That arm is a write-only read — `SetupPanelProvider.ts:966-968` does
  > `this.postMessage({type:'defaultPromptPreviews', previews}); return { success: true };`. After a
  > correct fix the HTTP body is `{success:true}` with no previews, so a body assertion would fail
  > and be misread as the fix not working.
  > **Replaced with:** assert (a) the body is `success:true` and carries no `Invalid workspace root`
  > error, and (b) the `defaultPromptPreviews` WS push arrives with a non-empty `previews` payload.
  > Converting that arm to return-in-body is Setup-provider burndown (PRD contract #4), tracked
  > there, not here.

- **Contract — KanbanProvider now reads the DB tier (the real pass bar).** Seed a `config` row
  directly in a scratch `kanban.db`, boot standalone, and assert `_getScopedSetting` returns the
  seeded value rather than the default. Assert the inverse before the fix, so the test documents the
  change.
- **Contract — writes reach the DB.** Call `_updateScopedSetting`, then read the row back from the DB
  file directly, confirming the mirror now happens.
- **Contract — override flags load.** With `kanban.workspaceOverrideEnabled` seeded `true`, assert
  `_workspaceOverrideEnabled` is `true` after boot and that `_updateScopedSetting` writes to the DB
  config tier rather than globalState.
- **Contract — wiring order.** Assert `kanbanProvider.setTaskViewerProvider` runs after seam
  injection, by asserting that a DB-tier value seeded before boot is present in `KanbanProvider`'s
  in-memory settings immediately after bootstrap completes (i.e. `_reloadSettingsFromStore()` reached
  the DB).
- **Regression — nothing in the extension host changes.** Run the existing headless and verb-engine
  contract suites; the chokepoint edit must be a no-op for the editor host, which supplies real
  `workspaceFolders` and where the seam returns the same list.
- **Manual smoke.** Boot standalone, open the Setup panel, confirm default prompt previews render,
  and confirm the boot log no longer shows `Cannot start local API server: no workspace root` but
  *does* show the new suppression line — proving the server was skipped deliberately rather than by
  accident of a null root.

## Uncertain Assumptions

- That no consumer of `_getWorkspaceRoots()` relies on emptiness as a headless signal *beyond* the
  four subsystems enumerated above. Those four were found by tracing `activateHostIntegrations()`;
  a grep for `_getWorkspaceRoots(` / `_resolveWorkspaceRoot()` callers that early-return on falsy
  should precede implementation to confirm the list is complete.
- That `hostServices.ts:379-381`'s single-root answer is correct for every mapped-workspace case.
  Standalone serves one `--workspace`, but `_filterMappedRoots` and the mappings index exist for
  multi-root setups; a mapped child served directly may want its parent reported.

> **Resolved since the previous revision** (kept for audit, no longer open):
> *"That fixing the root does not start a competing API server"* — **confirmed as a real regression**,
> now specified with its mechanism and a guard (see "Confirmed regression" and Proposed Changes).
> *"That `_loadOverrideFlags` is safe to re-run post-construction"* — moot; the setter already
> re-runs it by design (`KanbanProvider.ts:241-247`).

## Out of Scope

- Multi-root support in the headless host.
- Changing the validation gate's semantics.
- The fallthrough change this unblocks.
- Converting the remaining raw `vscode.workspace.workspaceFolders` reads (contract-#3 burndown).
- Converting `getDefaultPromptPreviews` to return-in-body (Setup-provider burndown).

## Completion Summary
Implemented seam-first workspace root resolution in `TaskViewerProvider._getWorkspaceRoots()` via `this._hostSeams?.workspace?.getWorkspaceRoots()`. Added explicit `suppressLocalApiServer` guard to `TaskViewerProvider` for standalone mode, and wired `kanbanProvider.setTaskViewerProvider(taskViewerProvider)` in `src/standalone/bootstrap.ts`.
- Files changed: `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`
- Issues encountered: None.

