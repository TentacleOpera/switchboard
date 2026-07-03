# Epic created as plan — no Kanban board refresh on epic creation (Epics tab path)

## Goal

When a user clicks **"+ New Epic"** in the Epics tab and creates a blank epic, the epic is
written to disk and inserted into the DB, but the **Kanban board panel never refreshes** and the
new epic card never appears on the board (or appears as a plain plan card once a later, unrelated
refresh eventually runs). The user perceives this as "the epic only got created as a plan." This
bug has survived multiple fixes because each prior fix hardened the *Kanban board's own* epic
creation path (`KanbanProvider.createEpicFromPlanIds`) but never touched the **separate, duplicated
epic-creation path in `PlanningPanelProvider`** that the Epics tab actually uses.

### Problem analysis & root cause

There are **two** `createEpic` message handlers in the codebase:

1. **`KanbanProvider` (`src/services/KanbanProvider.ts:8440`)** — handles `createEpic` messages
   posted from the **Kanban board webview** (`kanban.html:9981`). It delegates to the shared,
   hardened `createEpicFromPlanIds` (line 9421), which:
   - inherits `project`/`projectId` from subtasks or the board's active project filter,
   - embeds the full `planId` UUID in the filename (`.switchboard/epics/<slug>-<planId>.md`),
   - re-asserts `is_epic=1` as the final DB write,
   - calls `_markConfigDirty()` + `_refreshBoard()` (→ `switchboard.refreshUI`).

2. **`PlanningPanelProvider` (`src/services/PlanningPanelProvider.ts:3649`)** — handles
   `createEpic` messages posted from the **Epics tab** (`project.js:2935`, the "+ New Epic"
   modal). This handler **duplicates** the upsert/write logic instead of delegating, and has
   three critical defects relative to the hardened path:

   - **No Kanban board refresh.** It ends by calling `this._handleMessage({ type: 'fetchKanbanPlans' })`,
     which posts `kanbanPlansReady` via `_postToBothPanels` (line 1202). `_postToBothPanels` only
     posts to `_projectPanel` (the project webview) and `_panel` (the planning sidebar) — it does
     **not** post to the Kanban board panel, which is owned by `KanbanProvider` and refreshed only
     via the `switchboard.refreshUI` command. The file watcher is suppressed for 10s by
     `registerPendingCreation`, so no watcher-triggered board refresh fires either. **Result: the
     Kanban board never refreshes after an Epics-tab epic creation.**

   - **No `project`/`projectId` set.** The `upsertPlan` call (line 3685) omits both `project` and
     `projectId`, so the epic record lands with `project=''` / `project_id=NULL`. When the board
     eventually refreshes (via some later action) and a project filter is active, the epic is
     filtered off the project-filtered board and still never appears. This is the *exact* defect
     that `KanbanProvider.createEpicFromPlanIds` was hardened to fix (see the load-bearing comments
     at `KanbanProvider.ts:9454-9467`).

   - **Filename does not embed the full planId UUID.** It uses `${uniqueSlug}.md` (or
     `${slug}-${planId.slice(0,8)}.md` only on a name collision), whereas the hardened path uses
     `${slug}-${planId}.md` (full UUID). The watcher's epic-UUID derivation
     (`GlobalPlanWatcherService.ts:540`) matches only filenames ending in a *full* UUID. Without
     it, a re-import after the 10s `registerPendingCreation` window mints a fresh random
     `plan_id`, the `ON CONFLICT(plan_file, workspace_id)` keeps the old `plan_id`, and the
     trailing `updateEpicStatus(newRecord.planId, 1, '')` (line 577) targets a non-existent
     `plan_id` — a silent no-op that leaves the is_epic re-assert unprotected against future
     clobber vectors.

The root cause is the **duplicated, divergent epic-creation logic in `PlanningPanelProvider`**.
The hardened, shared entry point (`KanbanProvider.createEpicFromPlanIds`) already exists and is
explicitly designed to be the single choke point — the KanbanProvider handler comment at line
8443-8445 states: *"Delegate to the shared public method so the webview path and the agent/API
path run identical logic. No upsert/link/file-write code lives here — it would double-execute."*
The Epics-tab path was never migrated to this delegation.

## Metadata

**Tags:** bug, kanban, epic, board-refresh, planning-panel, regression-prone
**Complexity:** 4
**Project:** switchboard

## Complexity Audit

**Routine.** The fix is a single-method delegation: replace the duplicated upsert/write/refresh
body in `PlanningPanelProvider.createEpic` with a call to the existing, hardened
`KanbanProvider.createEpicFromPlanIds`. No new abstractions, no schema changes, no new state. The
shared method is already public and already used by both the Kanban board webview path and the
LocalApiServer/agent path, so the Epics-tab path becomes the third caller of the same code.

**Risk — low, but worth naming:**
- `createEpicFromPlanIds` returns `{ success, epicPlanId, epicSessionId, error }` instead of
  posting `epicError`/`epicCreated` messages directly. The current PlanningPanelProvider path
  posts `epicError` on failure. The delegation must preserve that UX by mapping a failed result
  back to the existing `epicError` post.
- `createEpicFromPlanIds` calls `_refreshBoard` (kanban panel). The current path calls
  `fetchKanbanPlans` (project panel). After delegation we must still trigger `fetchKanbanPlans`
  so the **Epics tab list** itself updates (the Epics tab reads from `kanbanPlansReady`, not from
  the kanban board push). This is additive and safe.

## Edge-Case & Dependency Audit

- **Blank epic (zero subtasks).** The Epics-tab "+ New Epic" flow always sends
  `subtaskPlanIds: []` (`project.js:2940`). `createEpicFromPlanIds` already supports this
  (line 9482-9484: blank epic defaults to `CREATED`, line 9464-9467: falls back to the board's
  active project filter for `project`). Verified compatible.
- **Project filter active on the board.** After the fix, the epic inherits
  `kanban.activeProjectFilter` (resolved to `project_id` via `getProjectIdByName`) and appears on
  the project-filtered board. This is the core fix for the "epic never appears" symptom.
- **`_kanbanProvider` not yet set.** `PlanningPanelProvider._kanbanProvider` is wired via
  `setKanbanProvider` (line 171). If it is somehow undefined when `createEpic` fires, the
  delegation must fall back gracefully (post `epicError`) rather than crash. The KanbanProvider
  handler itself assumes the provider exists, so in practice this is always set before the Epics
  tab can be opened, but a defensive guard is cheap.
- **Filename collision.** The current path has a bespoke `${slug}-${planId.slice(0,8)}` collision
  fallback. `createEpicFromPlanIds` sidesteps collisions entirely by always appending the *full*
  `planId` UUID (`${slug}-${planId}.md`), which is unique by construction. Adopting this removes
  the collision branch rather than needing to preserve it.
- **File watcher suppression.** `createEpicFromPlanIds` calls
  `GlobalPlanWatcherService.registerPendingCreation(epicPath)` before `writeFile` (line 9562-9563),
  so the watcher correctly skips the new file. The current PlanningPanelProvider path does the
  same (line 3715-3716) — behavior preserved.
- **`addToKanbanBoard` flag.** `project.js:2941` sends `addToKanbanBoard: true`, but no handler
  reads it. After delegation this flag remains ignored (harmless — `createEpicFromPlanIds` always
  adds to the board). No change needed.
- **No regression to the Kanban board's own createEpic.** That path (KanbanProvider:8440) already
  delegates to `createEpicFromPlanIds`; this plan only changes the *other* handler, so the
  kanban-board epic-creation flow is untouched.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts` — replace `createEpic` body with delegation

Replace the duplicated upsert/write/refresh block (lines 3649-3728) with a call to the shared
hardened entry point, then trigger the Epics-tab list refresh. This collapses three defects
(board refresh, project inheritance, UUID-embedded filename) into one fix.

```typescript
            case 'createEpic': {
                try {
                    const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    if (!wsRoot) {
                        this._projectPanel?.webview.postMessage({ type: 'epicError', message: 'No workspace root resolved.' });
                        break;
                    }
                    const name = String(msg.name || '').trim();
                    if (!name) {
                        this._projectPanel?.webview.postMessage({ type: 'epicError', message: 'Epic name is required.' });
                        break;
                    }
                    const description = msg.description ? String(msg.description).trim() : undefined;

                    // Delegate to the shared, hardened entry point so the Epics-tab path runs
                    // IDENTICAL logic to the Kanban board webview path and the LocalApiServer/
                    // agent path. This is the single choke point that: inherits project/
                    // project_id, embeds the full planId UUID in the filename, re-asserts
                    // is_epic=1 as the final DB write, and calls _refreshBoard() so the Kanban
                    // board panel actually updates. The previous duplicated body here omitted all
                    // three, which is why an Epics-tab epic never appeared on the board (and
                    // showed up as a plain plan once a later refresh ran).
                    if (!this._kanbanProvider) {
                        this._projectPanel?.webview.postMessage({ type: 'epicError', message: 'Kanban provider not available.' });
                        break;
                    }
                    const result = await this._kanbanProvider.createEpicFromPlanIds(
                        wsRoot,
                        name,
                        [],            // blank epic from the "+ New Epic" modal
                        description
                    );
                    if (!result.success) {
                        this._projectPanel?.webview.postMessage({ type: 'epicError', message: result.error || 'Failed to create epic.' });
                        break;
                    }

                    // createEpicFromPlanIds refreshed the Kanban board panel; still refresh the
                    // Epics tab list (it reads from kanbanPlansReady, not the board push).
                    this._handleMessage({
                        type: 'fetchKanbanPlans',
                        requestId: Date.now()
                    }, true).catch(err => {
                        console.error('[PlanningPanelProvider] createEpic post-fetch failed:', err);
                    });
                } catch (err) {
                    console.error('[PlanningPanelProvider] createEpic failed:', err);
                    this._projectPanel?.webview.postMessage({ type: 'epicError', message: String(err) });
                }
                break;
            }
```

**What this removes:** the local `crypto.randomUUID()` minting, the bespoke slug/collision
filename logic, the `db.upsertPlan({ ... isEpic: 1 })` call with no `project`/`projectId`, the
`db.updateEpicStatus` call, the `GlobalPlanWatcherService.registerPendingCreation` +
`fs.promises.writeFile` pair, and the `epicContent` string build. All of these now live exactly
once, inside `createEpicFromPlanIds`.

**What this preserves:** the `epicError` UX on failure, and the `fetchKanbanPlans` trigger that
updates the Epics tab list itself.

### No other files change

- `KanbanProvider.createEpicFromPlanIds` is already public and already handles blank epics,
  project inheritance, UUID-embedded filenames, watcher suppression, is_epic re-assertion, and
  `_refreshBoard`. No modification needed.
- `project.js` already posts the correct `{ type: 'createEpic', name, description, subtaskPlanIds: [], workspaceRoot }`
  payload. No webview change needed.
- `GlobalPlanWatcherService` already derives the epic `plan_id` from the full-UUID filename
  suffix. The fix adopts that filename scheme, so the watcher's re-import path becomes correct
  for Epics-tab epics too.

## Verification Plan

1. **Build:** `npm run compile` (webpack) — confirms the TypeScript delegation compiles. Note
   per `CLAUDE.md`: `dist/` is not used during testing; this is just a type/compile gate.

2. **Reproduce the bug first (pre-fix), then confirm it's gone (post-fix)** via an installed VSIX
   on a real workspace (the only way to exercise the webview + dual-panel refresh path):
   - Open a workspace with a Switchboard Kanban board and at least one project created.
   - On the Kanban board, select a project in the project filter dropdown.
   - Open the Epics tab and click "+ New Epic"; enter a name and create.
   - **Pre-fix expected:** the Kanban board does not refresh; no epic card appears. Switching
     away and back to the board (or waiting for an unrelated refresh) still shows nothing, because
     the epic has `project=''` and is filtered off the project-filtered board.
   - **Post-fix expected:** the Kanban board refreshes immediately and the new epic card appears
     in the CREATED column, rendered as an epic (epic styling, 0 subtasks), on the
     project-filtered board.

3. **Filename check:** after creating an epic via the Epics tab, confirm the file on disk is
   `.switchboard/epics/<slug>-<full-uuid>.md` (matches the regex
   `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.md$`), not `<slug>.md`.

4. **DB check:** `sqlite3 .switchboard/kanban.db "select plan_id, is_epic, project, project_id, plan_file from plans where is_epic=1 order by created_at desc limit 1;"`
   — confirm `is_epic=1`, `project` matches the active project filter, `project_id` is non-null,
   and `plan_file` contains the full UUID.

5. **Re-import robustness:** touch the new epic file (e.g. append a newline) *after* the 10s
   `registerPendingCreation` window expires, then refresh the board. Confirm the epic still shows
   as an epic with the same `plan_id` (no orphaning) — the watcher's UUID-derived `plan_id` now
   matches the DB row because the filename embeds the full UUID.

6. **No regression — Kanban board's own createEpic:** on the Kanban board, select 2+ plan cards
   and use the board's create-epic modal. Confirm the epic still appears on the board immediately
   (this path was untouched).

7. **Failure UX:** temporarily make `createEpicFromPlanIds` fail (e.g. create an epic with an
   empty name via the modal — blocked by the webview guard, so instead test by sending a
   `createEpic` message with `name=''` directly) and confirm the Epics tab shows the `epicError`
   toast rather than silently doing nothing.
