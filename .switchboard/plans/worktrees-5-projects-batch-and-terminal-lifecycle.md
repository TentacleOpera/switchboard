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

- **Tags:** backend, frontend, db-migration, git, dispatch, ux
- **Complexity:** 7

## User Review Required

None — design decisions confirmed with the user:
- Bind both epics and projects; projects one-at-a-time, epics batched.
- Per-worktree opt-in for "agents button opens worktree terminals" PLUS a manual "Open terminals" button.
- Tab-level "Suppress main repo agent terminals", default unchecked.

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

6. New `openWorktreeTerminals`: `{ worktreeId }` → resolve the worktree path → for each visible agent role, `switchboard.addAutobanTerminalFromKanban(role, agentName, wtPath)` (create-if-missing), then reveal the first via a new `switchboard.revealWorktreeTerminal` command (Phase 4). This is the "Open terminals" / locate action.

7. `_sendWorktreeConfig` (6837): extend the payload with, per worktree, `project`, `agentsOpenWithGrid`, and — for epic-bound worktrees — `epicTopic` and `epicProject` (the epic plan's own `.project`, used by the webview to nest the row under the matching project worktree). Add top-level `suppressMainTerminals` (from meta), `projects` (`db.getProjects(workspaceId)` — see `KanbanDatabase.ts:1984`), and `epics` (id+topic list) for the dropdowns/batch button.

8. Remove `clearRememberedWorktreeChoice` (6340) and stop writing the `worktree_remember_*`/`worktree_agent_behaviour` meta keys anywhere. (Cleanup tie-in with Phase 4.)

### Phase 3 — Dispatch routing: project as a routing key

**File: `src/services/TaskViewerProvider.ts`**

The plan record already carries `.project`. Add a project-based worktree lookup parallel to the existing epic lookup at both routing sites:

- Single dispatch `_handleTriggerAgentAction` (14697-14714): after the epic lookup, if `worktreePath` is still unset and `plan.project` is non-empty, find an active worktree with matching `project` and set `worktreePath`.
- Batch dispatch readiness (≈1540-1552 and ≈2600-2630): same dual lookup before building each `BatchPromptPlan`.

**Precedence (intentional hierarchy):** the routing order is `epic worktree → project worktree → main repo`. A project worktree is the base branch for the whole mini-workspace; epic worktrees layer on top and override for their own epic's plans. So a plan in both an epic-worktree and a project-worktree routes to the epic one; a project plan not claimed by any epic-worktree routes to the project one; a plan in neither routes to workspace root (unchanged, no error). This order is surfaced in the tab (Phase 5.4) so it is never invisible.

### Phase 4 — Terminal lifecycle: worktree-aware create-agents + reveal

**File: `src/extension.ts`** (`createAgentGrid`, 2280) and **`src/services/TaskViewerProvider.ts`**

1. In `createAgentGrid`, **remove** the legacy `worktree_remember_*` block (2298-2319).

2. After resolving `effectiveWorkspaceRoot`, read from the kanban DB:
   - `suppressMain = getMeta('worktree_suppress_main_terminals') === 'true'`
   - `gridWorktrees = getWorktrees().filter(w => w.status === 'active' && w.agentsOpenWithGrid)`
3. Behaviour:
   - If `!suppressMain`: create the main-repo grid as today (cwd = workspace root).
   - For each `w` in `gridWorktrees`: create that worktree's agent set (cwd = `w.path`) via the existing per-terminal path (`taskViewerProvider.addAutobanTerminalFromKanban(role, agentName, w.path)` for each visible agent) — this is exactly the worktree-creation terminal logic, reused.
   - If `suppressMain && gridWorktrees.length === 0`: warn ("Suppress main is on but no worktree is set to open terminals — nothing to open") and do nothing.
   This re-establishes worktree terminals on restart whenever the per-worktree checkbox is set, with zero extra clicks.

4. New command `switchboard.revealWorktreeTerminal(worktreePath)` in `extension.ts` + a method on `TaskViewerProvider` that calls `findTerminalNameByWorktreePath` (6439) and `terminal.show()` on the match (the "locate" behaviour). Used by the per-row Open terminals button.

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
- `src/services/TaskViewerProvider.ts` — project routing at both dispatch sites; reveal-terminal method.
- `src/extension.ts` — worktree-aware `createAgentGrid`; remove legacy remember hack; `revealWorktreeTerminal` command.
- `src/webview/kanban.html` — rebuilt `createWorktreesPanel` (CSP-safe); epic/focus chips de-inlined.

## Verification Plan

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
- **Terminal fan-out**: many worktrees with the checkbox set × many roles = many terminals on create-agents. Mitigation: opt-in per worktree (default off) keeps it bounded; document the cost in the checkbox tooltip.
- **Migration on shared parent DBs** (workspaceDatabaseMappings): `worktrees` is not workspace-scoped by column; project names can repeat across child workspaces. Acceptable for now (same limitation as existing epic linkage); note for a future scope pass.
- **CSP regression**: any future `innerHTML`+`onclick` reintroduces the dead-button class of bug. Add a short comment at the top of `createWorktreesPanel` mandating `addEventListener`.

## Recommendation

**Complexity: 7 → Send to Lead Coder.** Touches DB migration, two dispatch-critical routing sites, the create-agents lifecycle in `extension.ts`, and a full webview panel rebuild. The dispatch-routing and `createAgentGrid` changes are the risky cross-cutting parts and warrant a lead.
