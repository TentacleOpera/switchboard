# Worktrees Part 5: Project Binding, Epic Batch, and Terminal Lifecycle

## Goal

Make the Worktrees tab the single, discoverable home for binding work to worktrees and managing their terminals. Specifically:

1. Bind a worktree to a **project** (not just an epic). Projects are workspace-scoped mini-workspaces; a worktree becomes that project's branch.
2. Create project worktrees **one at a time** from a dropdown; create epic worktrees in **batch** ("a worktree for every epic").
3. Extend dispatch routing so a plan's **project** (in addition to its epic) routes it into the bound worktree's terminal.
4. Fix the terminal lifecycle so worktree terminals survive a VS Code restart, controlled per-worktree and globally:
   - Per-worktree checkbox **"Agents button opens worktree terminals"** — when set, the create-agents action (re)creates that worktree's full agent terminal set.
   - Per-worktree **"Open terminals"** button — manually create-if-missing then reveal/focus that worktree's terminals (also serves as "locate terminals").
   - Tab-level checkbox **"Suppress main repo agent terminals"** (default off) — when set, the create-agents action opens only worktree terminals, leaving the main repo untouched.
5. Fix the Content-Security-Policy bug that silently disables every worktree action button.
6. Retire the vestigial single-worktree `worktree_remember_*` mechanism, which contradicts the multi-worktree model.

## Dependencies

Builds on Parts 1–4 (worktrees table, epic linkage, dispatch routing, sub-bar indicator), all complete and in code.

## Metadata

- **Tags:** backend, frontend, database, ui, ux, bugfix, refactor
- **Complexity:** 7

## User Review Required

None — design decisions confirmed with the user:
- Bind both epics and projects; projects one-at-a-time, epics batched.
- Per-worktree opt-in for "agents button opens worktree terminals" PLUS a manual "Open terminals" button.
- Tab-level "Suppress main repo agent terminals", default unchecked.

## Complexity Audit

### Routine
- V33 migration: add-only `ALTER TABLE ... ADD COLUMN` wrapped in try/catch, following the exact V26/V27 idempotent pattern (`KanbanDatabase.ts:4276-4316`). Fresh DBs are covered because `_initialize` runs `SCHEMA_SQL` then `_runMigrations()` from version 0 (`KanbanDatabase.ts:1134-1137`), so the `ALTER` applies to new databases too — no `SCHEMA_SQL` change required.
- `WorktreeRow`/`getWorktrees`/`getWorktreeByBranch`/`addWorktree` extensions: mechanical column additions mirroring the existing `epic_id` mapping.
- New backend message handlers modelled directly on the existing `createWorktreeForEpic` handler (`KanbanProvider.ts:6294`).
- CSP de-inlining of the 5 known inline `onclick` handlers — confirmed exactly 5, all worktree-related (`kanban.html:4663, 4990, 4995, 8259, 8260`); the rest of the board already uses `addEventListener`.

### Complex / Risky
- **Terminal lifecycle (Phase 4 + Phase 2.6).** `addAutobanTerminalFromKanban` → `_createAutobanTerminal` (`TaskViewerProvider.ts:6021`) **always mints a new uniquely-suffixed terminal** (`getNextAutobanTerminalName`); it does NOT create-if-missing by `worktreePath`. It is also subject to `MAX_AUTOBAN_TERMINALS_PER_ROLE = 5` (`autobanState.ts:14`, enforced `TaskViewerProvider.ts:6042`), beyond which it silently warns and returns. This is the single most error-prone area.
- **Dual terminal subsystems** glued inside `createAgentGrid`: the main grid uses purpose `'agent-grid'` via `vscode.window.createTerminal` (deduped by `matchesGridAgentName`), while worktree terminals use purpose `'autoban-backup'` via the pooled, capped autoban path.
- **Three dispatch routing sites** must receive identical project-lookup logic: `_handleTriggerAgentAction` (`TaskViewerProvider.ts:14710`), readiness builder (`:1548`), and `getValidPlans` batch builder (`:2608`). Divergence makes displayed Scope text lie.

## Edge-Case & Dependency Audit

- **Race Conditions:** Pressing "Open terminals" or create-agents repeatedly (or quickly after restart) races terminal creation: because there is no create-if-missing guard, concurrent/repeat presses spawn duplicate `Coder N` terminals for the same `worktreePath`. When multiple same-path terminals exist, `findTerminalNameByWorktreePath` (`TaskViewerProvider.ts:6439`) returns the first `Object.entries` match — non-deterministic across reloads.
- **Security:** None new. Branch names derived from project/epic names must pass through the existing slugify in `_createSafetyWorktree`; do not interpolate raw names into shell `git` invocations (existing handlers use `execFile` arg arrays, not shell strings — preserve that).
- **Side Effects:** `MAX_AUTOBAN_TERMINALS_PER_ROLE = 5` caps worktree terminals per role across all worktrees on the autoban path. Batch-all-epics with ≥6 epics, or many opt-in worktrees, silently fails to create the overflow role terminals → dispatch silently falls back to the main tree (the very bug this plan exists to fix). Must be surfaced, not swallowed.
- **Dependencies & Conflicts:** Removing `clearRememberedWorktreeChoice` (`KanbanProvider.ts:6340`) and the `worktree_remember_*` block in `createAgentGrid` (`extension.ts:2298-2319`) must be done together with the webview affordance removal (Phase 5) so no dead message handler or orphan UI control remains. The epic→project nesting join calls `getPlanByPlanId(epic_id)` (`KanbanDatabase.ts:2312`) — guard against a null/missing/cross-workspace epic plan and fall back to top-level rendering (display-only, so failure is cosmetic).

## Adversarial Synthesis

Key risks: (1) `addAutobanTerminalFromKanban` always creates rather than create-if-missing, so repeat/restart presses spawn duplicate per-worktree terminals and accelerate hitting the hard `MAX_AUTOBAN_TERMINALS_PER_ROLE = 5` ceiling, which silently fails and resurrects the silent main-repo fallback; (2) the project routing lookup must be applied identically at all three dispatch sites or behaviour diverges from the displayed Scope text. Mitigations: introduce a shared `_ensureWorktreeTerminals(w, visibleAgents)` helper that does per-role create-if-missing via `findTerminalNameByWorktreePath` and reports cap-hit skips with a worktree/role-named toast; centralize the project lookup in one helper invoked at all three sites; guard the epic→project nesting join against missing plans. Fresh-DB schema and cross-workspace `epic_id` concerns were reviewed and judged non-blocking (migrations run from 0 on new DBs; cross-workspace linkage is a pre-existing, out-of-scope limitation).

## Problem Analysis

### Bug A — CSP kills every worktree button
The webview CSP (`KanbanProvider.ts:6739`) is `script-src 'nonce-${nonce}' ${webview.cspSource}` with no `'unsafe-inline'`. With a nonce present, inline `onclick=` attributes are blocked entirely. The only 5 inline handlers in the entire 8,415-line `kanban.html` are all worktree-related — Merge/Abandon (`kanban.html:8259-8260`), the per-epic create chip (`:4995`), the epic-focus chip (`:4990`), and clear-focus (`:4663`). All are dead. The rest of the board works because it uses `addEventListener`.

### Bug B — the tab only makes orphan worktrees
The generic `CREATE WORKTREE` button posts `{ type: 'createWorktree' }` with no `epicId`/`project` (`kanban.html:8221`), so the worktree row gets `epic_id = NULL` and no project. Dispatch routing keys only off `epic_id` (`TaskViewerProvider.ts:14706`), so nothing can ever route to it.

### Gap C — no project binding exists
The `worktrees` table has `epic_id` only (`KanbanDatabase.ts:151-158`); there is no project column. Projects (`projects` table `KanbanDatabase.ts:143`, `plans.project` name column) have zero dispatch isolation today.

### Gap D — worktree terminals are not re-established on restart
Terminal records persist to a per-workspace state file with their `worktreePath` (`TaskViewerProvider.ts:5530`), but on restart the processes are dead and are filtered out by `_getAliveAutobanTerminalRegistry` (`:5548`). The create-agents command `createAgentGrid` (`extension.ts:2280`) builds one grid in a single `effectiveCwd` (workspace root by default) and does NOT iterate active worktrees. Its only worktree awareness is the legacy single-path hack `worktree_remember_*` (`extension.ts:2298-2319`). Result: after restart, `findTerminalNameByWorktreePath` finds nothing and dispatch silently falls back to the main tree.

## Proposed Changes

### Phase 1 — DB: project link + per-worktree terminal flag (migration V33)

**File: `src/services/KanbanDatabase.ts`**

1. Add migration **V33** (next after V32 at line 4495-4499), following the existing `currentVersion < N` pattern:
   ```sql
   ALTER TABLE worktrees ADD COLUMN project TEXT;
   ALTER TABLE worktrees ADD COLUMN agents_open_with_grid INTEGER DEFAULT 0;
   ```
   Wrap each `ALTER` in try/catch (idempotent — same pattern as prior migrations), then `setMigrationVersion(33)`.

2. Extend `WorktreeRow` interface (line 18) with:
   ```ts
   project: string | null;
   agentsOpenWithGrid: boolean;
   ```

3. Update `getWorktrees()` (2030) and `getWorktreeByBranch()` (2081): add `project, agents_open_with_grid` to the `SELECT`, and map:
   ```ts
   project: r.project !== null && r.project !== undefined && r.project !== '' ? String(r.project) : null,
   agentsOpenWithGrid: Number(r.agents_open_with_grid) === 1,
   ```

4. Extend `addWorktree()` (2053) signature to `addWorktree(branch, wtPath, epicId?, project?)` and include `project` in the INSERT column list.

5. Add two helpers next to `updateWorktreeStatus` (2072):
   ```ts
   async setWorktreeAgentsOpenWithGrid(id: number, enabled: boolean): Promise<boolean>
   // UPDATE worktrees SET agents_open_with_grid = ? WHERE id = ?
   ```
   Keep `getMeta`/`setMeta` for the tab-level suppress flag (key `worktree_suppress_main_terminals`).

### Phase 2 — Backend handlers (KanbanProvider.ts)

**File: `src/services/KanbanProvider.ts`** (message switch around 6252-6404)

1. `createWorktree` (6259): read optional `msg.project`, pass to `addWorktree(branch, wtPath, undefined, msg.project)`.

2. New `createWorktreeForProject`: like `createWorktreeForEpic` (6294) but keyed on `msg.project`. Block if an active worktree with the same `project` already exists. Branch name derived from the project name (reuse the slugify in `_createSafetyWorktree`).

3. New `createWorktreesForAllEpics` (batch): list epics (`plans` where `is_epic=1`); for each epic without an active linked worktree, call `_createSafetyWorktree(workspaceRoot, epic.topic)` + `addWorktree(..., epicId)`. Collect successes/failures; show one summary toast (`Created N worktree(s); skipped M already-linked`). Refresh board + worktree config once at the end (not per-epic).

4. New `toggleWorktreeAgentsOpenWithGrid`: `{ worktreeId, enabled }` → `db.setWorktreeAgentsOpenWithGrid`. Re-send worktree config.

5. New `setSuppressMainTerminals`: `{ enabled }` → `db.setMeta('worktree_suppress_main_terminals', enabled ? 'true' : '')`. Re-send worktree config.

6. New `openWorktreeTerminals`: `{ worktreeId }` → resolve the worktree path → for each visible agent role, create-if-missing that worktree's terminal, then reveal the first via a new `switchboard.revealWorktreeTerminal` command (Phase 4). This is the "Open terminals" / locate action.

   **Clarification (create-if-missing is NOT free):** `addAutobanTerminalFromKanban` → `_createAutobanTerminal` (`TaskViewerProvider.ts:6021`) **always creates a new uniquely-suffixed terminal** via `getNextAutobanTerminalName`; it has no create-if-missing semantics and is capped by `MAX_AUTOBAN_TERMINALS_PER_ROLE = 5`. Therefore this handler (and Phase 4) MUST guard each role with a pre-check — see the shared `_ensureWorktreeTerminals` helper below — calling `findTerminalNameByWorktreePath(w.path)` / a role+path match and skipping creation when a live terminal already exists. Without this guard, repeat presses spawn duplicate `Coder N` terminals and burn through the per-role cap, after which overflow creations silently warn-and-return and dispatch falls back to the main tree.

7. `_sendWorktreeConfig` (6837): extend the payload with, per worktree, `project`, `agentsOpenWithGrid`, and — for epic-bound worktrees — `epicTopic` and `epicProject` (the epic plan's own `.project`, used by the webview to nest the row under the matching project worktree). Add top-level `suppressMainTerminals` (from meta), `projects` (`db.getProjects(workspaceId)` — see `KanbanDatabase.ts:1984`), and `epics` (id+topic list) for the dropdowns/batch button.

8. Remove `clearRememberedWorktreeChoice` (6340) and stop writing the `worktree_remember_*`/`worktree_agent_behaviour` meta keys anywhere. (Cleanup tie-in with Phase 4.)

### Phase 3 — Dispatch routing: project as a routing key

**File: `src/services/TaskViewerProvider.ts`**

The plan record already carries `.project` (`KanbanPlanRecord.project`, `KanbanDatabase.ts:39`). Add a project-based worktree lookup parallel to the existing epic lookup at **all three** routing sites. **Clarification:** there are three, not two — extract a single shared resolver (e.g. `resolveWorktreePathForPlan(db, { epicId, project })` returning `epic → project → undefined`) and call it at every site so the precedence rule cannot drift between them:

- Single dispatch `_handleTriggerAgentAction` (14697-14714, epic lookup at 14710-14714): after the epic lookup, if `worktreePath` is still unset and `plan.project` is non-empty, find an active worktree with matching `project` and set `worktreePath`.
- Readiness builder (≈1545-1553, epic lookup at 1548): same dual lookup before populating `plan.worktreePath`.
- Batch builder `getValidPlans` (≈2607-2612, epic lookup at 2608): same dual lookup before pushing into `validPlans`.

**Precedence (intentional hierarchy):** the routing order is `epic worktree → project worktree → main repo`. A project worktree is the base branch for the whole mini-workspace; epic worktrees layer on top and override for their own epic's plans. So a plan in both an epic-worktree and a project-worktree routes to the epic one; a project plan not claimed by any epic-worktree routes to the project one; a plan in neither routes to workspace root (unchanged, no error). This order is surfaced in the tab (Phase 5.4) so it is never invisible.

### Phase 4 — Terminal lifecycle: worktree-aware create-agents + reveal

**File: `src/extension.ts`** (`createAgentGrid`, 2280) and **`src/services/TaskViewerProvider.ts`**

1. In `createAgentGrid`, **remove** the legacy `worktree_remember_*` block (2298-2319).

2. After resolving `effectiveWorkspaceRoot`, read from the kanban DB:
   - `suppressMain = getMeta('worktree_suppress_main_terminals') === 'true'`
   - `gridWorktrees = getWorktrees().filter(w => w.status === 'active' && w.agentsOpenWithGrid)`
3. Behaviour:
   - If `!suppressMain`: create the main-repo grid as today (cwd = workspace root).
   - For each `w` in `gridWorktrees`: create that worktree's agent set (cwd = `w.path`) via the shared `_ensureWorktreeTerminals` helper (below) — NOT a raw loop over `addAutobanTerminalFromKanban`.
   - If `suppressMain && gridWorktrees.length === 0`: warn ("Suppress main is on but no worktree is set to open terminals — nothing to open") and do nothing.
   This re-establishes worktree terminals on (re)press of create-agents after restart whenever the per-worktree checkbox is set, with no extra clicks beyond the create-agents action itself.

   **Clarification — shared `_ensureWorktreeTerminals(w, visibleAgents)` helper (on `TaskViewerProvider`):** For each visible agent role, first check whether a live terminal already exists for `w.path`+role (reuse the `findTerminalNameByWorktreePath` registry lookup at 6439, extended to also match role, or iterate the alive autoban registry filtering on `worktreePath`). Only call `addAutobanTerminalFromKanban(role, agentName, w.path)` when none exists (true create-if-missing). When `_createAutobanTerminal` returns early due to `MAX_AUTOBAN_TERMINALS_PER_ROLE = 5`, surface a worktree/role-named toast (e.g. "Could not open <role> terminal for <branch>: role terminal limit reached") instead of the existing generic warning, so the cap-hit and the resulting routing fallback are visible. Both `openWorktreeTerminals` (Phase 2.6) and this `createAgentGrid` loop call this single helper so dedupe/cap behaviour is identical in both paths.

   **Note on dual subsystems:** the main grid terminals are purpose `'agent-grid'` (created directly by `createAgentGrid`, deduped by `matchesGridAgentName`); worktree terminals are purpose `'autoban-backup'` (pooled/capped). This mixing is consistent with the existing `createWorktree` handler, which already uses the autoban path. Add a short comment in `createAgentGrid` documenting that worktree terminals deliberately use the autoban registry and are matched for routing by `worktreePath`, not name.

4. New command `switchboard.revealWorktreeTerminal(worktreePath)` in `extension.ts` + a method on `TaskViewerProvider` that calls `findTerminalNameByWorktreePath` (6439) and `terminal.show()` on the match (the "locate" behaviour). Used by the per-row Open terminals button. If multiple terminals share the same `worktreePath`, `findTerminalNameByWorktreePath` returns the first registry match — acceptable for reveal/locate, but the create-if-missing guard in `_ensureWorktreeTerminals` should keep duplicates from accumulating in the first place.

### Phase 5 — Webview: rebuild the tab, CSP-safe (kanban.html)

**File: `src/webview/kanban.html`** (`createWorktreesPanel`, 8183-8273)

Rebuild the panel with **no inline `onclick`** — all wiring via `addEventListener` / event delegation, matching the rest of the board:

1. **Create section** (visible, discoverable — replaces the lone button):
   - "Create worktree for project:" `<select>` populated from `worktreeConfig.projects` + a Create button → posts `createWorktreeForProject`.
   - "Create worktrees for all epics" button → posts `createWorktreesForAllEpics`.
   - (Optional) keep a plain "Create worktree (unbound)" affordance for ad-hoc use.

2. **Tab-level checkbox** "Suppress main repo agent terminals" (default unchecked, reflects `worktreeConfig.suppressMainTerminals`) → posts `setSuppressMainTerminals` on change.

3. **Active worktrees list** — each row shows branch, a chip for its linked **epic or project**, status badge, created date, and these controls (all `addEventListener`):
   - Checkbox "Agents button opens worktree terminals" (reflects `agentsOpenWithGrid`) → posts `toggleWorktreeAgentsOpenWithGrid`.
   - "Open terminals" button → posts `openWorktreeTerminals`.
   - "Merge" / "Abandon" buttons (now functional under CSP).

4. **Make routing precedence visible** (this is the whole point of binding worktrees — the user must see where a plan will land):
   - A one-line legend at the top of the list: **"Routing order: epic worktree → project worktree → main repo."**
   - Per-row **Scope** line, computed from the same routing rule so it can never drift from actual behaviour:
     - Epic worktree: *"Catches plans in epic '<topic>' — overrides the project worktree for those plans."*
     - Project worktree: *"Catches '<project>' plans not claimed by an epic worktree."*
     - Unbound: *"No automatic routing — open terminals and work manually."*
   - **Visual nesting**: when an epic worktree's epic plan has a `project` that matches an existing project worktree, render the epic worktree indented beneath that project-worktree row (a `↳` child), making the "branch, then epics on top" hierarchy obvious at a glance. The epic→project link is resolved by reading the epic plan's `.project` for the worktree's `epic_id`. Epic worktrees with no matching project worktree render at top level. This grouping is display-only — it does not change routing.

5. Convert the epic-card chip and focus chips (`:4990`, `:4995`, `:4663`) from inline `onclick` to delegated listeners so the existing per-epic create + focus mode work again.

## Files Changed

- `src/services/KanbanDatabase.ts` — V33 migration; `WorktreeRow`; `getWorktrees`/`getWorktreeByBranch`/`addWorktree`; `setWorktreeAgentsOpenWithGrid`.
- `src/services/KanbanProvider.ts` — new/updated handlers (project create, all-epics batch, toggle, suppress, open terminals); `_sendWorktreeConfig` payload; remove remember-choice handler.
- `src/services/TaskViewerProvider.ts` — shared `resolveWorktreePathForPlan` used at all THREE dispatch sites (14710, 1548, 2608); shared `_ensureWorktreeTerminals` create-if-missing helper; reveal-terminal method.
- `src/extension.ts` — worktree-aware `createAgentGrid` (calls `_ensureWorktreeTerminals`); remove legacy remember hack; `revealWorktreeTerminal` command.
- `src/webview/kanban.html` — rebuilt `createWorktreesPanel` (CSP-safe); epic/focus chips de-inlined.

## Verification Plan

> **Session directive:** Compilation (`tsc`) and the automated test suite are explicitly OUT OF SCOPE for this session — the user runs them separately. The steps below describe the intended automated coverage plus manual acceptance checks; do not execute them as part of this pass.

### Automated Tests

- **Migration unit test**: assert V33 applies once and is idempotent on a re-run; `worktrees` has `project` + `agents_open_with_grid` columns with correct defaults; fresh-DB init (migrations from 0) also yields the columns.
- **DB layer**: `addWorktree(branch, path, undefined, project)` persists `project`; `getWorktrees`/`getWorktreeByBranch` map `project`/`agentsOpenWithGrid` correctly; `setWorktreeAgentsOpenWithGrid` toggles the flag.
- **Routing resolver**: unit-test `resolveWorktreePathForPlan` for all precedence cases — epic-only, project-only, both (epic wins), neither (undefined) — and assert it is invoked at all three dispatch sites.
- **Terminal dedupe**: `_ensureWorktreeTerminals` creates one terminal per role on first call and creates NONE on a second call for the same worktree (create-if-missing); when the role pool is at `MAX_AUTOBAN_TERMINALS_PER_ROLE`, it emits the named cap-hit toast and does not throw.
- **CSP regression guard**: a test/grep asserting zero inline `onclick` remain in `kanban.html`.

### Manual Acceptance

1. **Migration**: open an existing workspace → V33 applies once, idempotent on reopen; `worktrees` has `project` + `agents_open_with_grid`.
2. **Project worktree**: pick a project → Create → worktree row shows project chip; dispatch a plan in that project → routes to the worktree terminal; dispatch a plan in no project → routes to root.
2b. **Precedence visible**: create a project worktree AND an epic worktree for an epic inside that project → the epic row renders nested (`↳`) under the project row; each row's Scope line states what it catches; legend shows "epic → project → main repo". Dispatch a plan in that epic → lands in the epic worktree; dispatch a project plan outside the epic → lands in the project worktree. Behaviour matches the displayed Scope text.
3. **Duplicate project**: Create again for same project → blocked with toast.
4. **All-epics batch**: click → one worktree per epic lacking one; epics already linked skipped; single summary toast.
5. **Per-worktree checkbox + restart**: enable "Agents button opens worktree terminals" → restart VS Code → press create-agents → that worktree's terminals are recreated with correct cwd; dispatch routes there (no silent fallback).
6. **Suppress main**: enable → create-agents opens only worktree terminals, no root grid. With no eligible worktree → warning, no terminals.
7. **Open terminals / locate**: click on a row → terminals created if missing, first one focused.
8. **CSP**: Merge, Abandon, epic chip, focus chips all fire; no CSP violations in the webview console; grep confirms zero inline `onclick` remain in `kanban.html`.

## Risks

- **Routing precedence ambiguity** (plan in both an epic-worktree and a project-worktree): resolved by the documented `epic → project → main` rule, surfaced both in a code comment AND in the tab (legend + per-row Scope text + nesting), so the resolution is never hidden from the user.
- **Per-role terminal cap (`MAX_AUTOBAN_TERMINALS_PER_ROLE = 5`)**: worktree terminals use the autoban pool, which is hard-capped at 5 per role across ALL worktrees on that path. Batch-all-epics with ≥6 epics, or 6+ opt-in worktrees, will fail to create the overflow role terminals — and the existing failure mode is a silent `showWarningMessage` + `return`, after which dispatch routes back to the main tree (the exact bug this plan fixes). Mitigation: `_ensureWorktreeTerminals` MUST surface a worktree/role-named toast on cap-hit so the fallback is visible; opt-in per worktree (default off) keeps the common case bounded; document the limit in the checkbox tooltip. A future scope pass may raise/segment the cap per worktree.
- **Duplicate terminals / create-always**: `addAutobanTerminalFromKanban` always creates a new uniquely-suffixed terminal. Without the `_ensureWorktreeTerminals` create-if-missing guard, repeat "Open terminals" or create-agents presses spawn duplicate `Coder N` terminals for the same `worktreePath`, accelerating cap exhaustion and making `findTerminalNameByWorktreePath` non-deterministic. Mitigation: the shared helper guards every creation path.
- **Terminal fan-out**: many worktrees with the checkbox set × many roles = many terminals on create-agents. Mitigation: opt-in per worktree (default off) keeps it bounded; document the cost in the checkbox tooltip.
- **Epic→project nesting join**: `_sendWorktreeConfig` resolves each epic worktree's project via `getPlanByPlanId(epic_id)`; guard against a null/missing/cross-workspace epic plan and fall back to top-level rendering. Display-only, so failure is cosmetic, not data-corrupting.
- **Migration on shared parent DBs** (workspaceDatabaseMappings): `worktrees` is not workspace-scoped by column; project names can repeat across child workspaces. Acceptable for now (same limitation as existing epic linkage); note for a future scope pass.
- **CSP regression**: any future `innerHTML`+`onclick` reintroduces the dead-button class of bug. Add a short comment at the top of `createWorktreesPanel` mandating `addEventListener`.

## Review Findings

All five phases implemented and plan-compliant (migration is V34 not V33 — V33 was claimed by another plan; harmless). One CRITICAL fixed in `src/services/TaskViewerProvider.ts`: `_findTerminalNameByWorktreePathAndRole` had a path-only fallback that made `ensureWorktreeTerminals` skip every role after the first (a worktree got only one terminal, not the full set) — added a `strictRole` flag and used it from the create-if-missing guard. One MAJOR fixed in the same method: `ensureWorktreeTerminals` now pre-filters to autoban-pool-eligible roles so `analyst`/`jules_monitor` no longer raise an error toast on every create-agents press. Validation: compile/tests skipped per session directive; static checks pass — zero inline `onclick` in `kanban.html`, `resolveWorktreePathForPlan` invoked at all three dispatch sites (1548, 2610, 14900), epic→project nesting join guarded against missing plans. Remaining risks: per-role cap of 5 still applies (surfaced via toast as designed); concurrent rapid presses can still race terminal creation; dead `worktree_remember_*`/`worktree_agent_behaviour` reads linger in `_getWorktreeConfigData` (never written, not consumed by webview — NIT).

## Recommendation

**Complexity: 7 → Send to Lead Coder.** Touches a DB migration, three dispatch-critical routing sites (centralized via `resolveWorktreePathForPlan`), the capped/non-deduping autoban terminal lifecycle in `extension.ts` + `TaskViewerProvider.ts` (centralized via `_ensureWorktreeTerminals`), and a full webview panel rebuild. The dispatch-routing and terminal-lifecycle changes are the risky cross-cutting parts and warrant a lead.
