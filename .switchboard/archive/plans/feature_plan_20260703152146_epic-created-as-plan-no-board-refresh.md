# Epic created as plan — no Kanban board refresh on epic creation (Epics tab path)

**Plan ID:** 7a3c1f4e-2b8d-4e6a-9c1d-5f0b8e2a7d44

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

1. **`KanbanProvider` (`src/services/KanbanProvider.ts:8972`)** — handles `createEpic` messages
   posted from the **Kanban board webview** (`kanban.html`). It delegates to the shared,
   hardened `createEpicFromPlanIds` (line 9975), which:
   - inherits `project`/`projectId` from subtasks or the board's active project filter,
   - embeds the full `planId` UUID in the filename (`.switchboard/epics/<slug>-<planId>.md`),
   - re-asserts `is_epic=1` as the final DB write (line 10145),
   - calls `_markConfigDirty()` + `_refreshBoard()` (→ `switchboard.refreshUI`).

2. **`PlanningPanelProvider` (`src/services/PlanningPanelProvider.ts:3832`)** — handles
   `createEpic` messages posted from the **Epics tab** (`project.js:3141`, the "+ New Epic"
   modal). This handler **duplicates** the upsert/write logic instead of delegating, and has
   three critical defects relative to the hardened path:

   - **No Kanban board refresh.** It ends by calling `this._handleMessage({ type: 'fetchKanbanPlans' })`
     (line 3902), which posts `kanbanPlansReady` via `_postToBothPanels` (line 1203). `_postToBothPanels`
     only posts to `_projectPanel` (the project webview) and `_panel` (the planning sidebar) — it does
     **not** post to the Kanban board panel, which is owned by `KanbanProvider` and refreshed only
     via the `switchboard.refreshUI` command. The file watcher is suppressed for 10s by
     `registerPendingCreation`, so no watcher-triggered board refresh fires either. **Result: the
     Kanban board never refreshes after an Epics-tab epic creation.**

   - **No `project`/`projectId` set.** The `upsertPlan` call (line 3868) omits both `project` and
     `projectId`, so the epic record lands with `project=''` / `project_id=NULL`. When the board
     eventually refreshes (via some later action) and a project filter is active, the epic is
     filtered off the project-filtered board and still never appears. This is the *exact* defect
     that `KanbanProvider.createEpicFromPlanIds` was hardened to fix (see the load-bearing comments
     at `KanbanProvider.ts:10008-10027`).

   - **Filename does not embed the full planId UUID.** It uses `${uniqueSlug}.md` (or
     `${slug}-${planId.slice(0,8)}.md` only on a name collision, line 3862), whereas the hardened
     path uses `${slug}-${planId}.md` (full UUID, line 10057). The watcher's epic-UUID derivation
     (`GlobalPlanWatcherService.ts:540`) matches only filenames ending in a *full* UUID. Without
     it, a re-import after the 10s `registerPendingCreation` window mints a fresh random
     `plan_id`, the `ON CONFLICT(plan_file, workspace_id)` keeps the old `plan_id`, and the
     trailing `updateEpicStatus(newRecord.planId, 1, '')` targets a non-existent
     `plan_id` — a silent no-op that leaves the is_epic re-assert unprotected against future
     clobber vectors.

The root cause is the **duplicated, divergent epic-creation logic in `PlanningPanelProvider`**.
The hardened, shared entry point (`KanbanProvider.createEpicFromPlanIds`) already exists and is
explicitly designed to be the single choke point — the KanbanProvider handler comment at line
8975-8977 states: *"Delegate to the shared public method so the webview path and the agent/API
path run identical logic. No upsert/link/file-write code lives here — it would double-execute."*
The Epics-tab path was never migrated to this delegation.

## Metadata

**Tags:** bugfix, backend, ui
**Complexity:** 4
**Project:** switchboard

## User Review Required

Yes — this change alters the side-effect profile of Epics-tab epic creation (see Clarification
notes in Proposed Changes). Specifically, blank epics created via the Epics tab will now trigger
epic-integration worktree provisioning (when `epic_worktree_mode` is `per-subtask` or `high-low`)
and outbound Linear/ClickUp sync, which they previously did not. These are desirable parity
gains, but the user should confirm the worktree-mode behavior is intended for blank epics before
implementation. No data-migration impact (this is unreleased dev work on the
`epic/comms-monitor-improvements` branch).

## Complexity Audit

### Routine
- Single-method delegation: replace the duplicated upsert/write/refresh body in
  `PlanningPanelProvider.createEpic` with a call to the existing, public, hardened
  `KanbanProvider.createEpicFromPlanIds`.
- No new abstractions, no schema changes, no new state.
- The shared method is already public and already used by both the Kanban board webview path
  (`KanbanProvider` case at 8972) and the LocalApiServer/agent path, so the Epics-tab path
  becomes the third caller of the same code.
- The defensive `_kanbanProvider` undefined guard is a 3-line branch reusing the existing
  `epicError` post pattern.
- The `fetchKanbanPlans` follow-up call already exists verbatim in the current handler, so it is
  preserved unchanged.

### Complex / Risky
- **Behavior-parity side effects from delegation (Clarification, not new scope).** Adopting the
  shared choke point means Epics-tab epics now inherit *all* of `createEpicFromPlanIds`'s
  behavior, not just the three bug fixes. Two behaviors are newly applied to the Epics-tab path:
  (1) epic-integration worktree provisioning when `epic_worktree_mode` is `per-subtask` or
  `high-low` (`KanbanProvider.ts:10124-10129`), and (2) outbound Linear/ClickUp epic sync
  (`_syncEpicOutbound`, line 10162). These are the *point* of delegating (parity), but they are
  side effects the current Epics-tab path does not produce, so the implementer must not be
  surprised by them.
- **Epic file content format change (Clarification).** The current PlanningPanelProvider path
  writes `# ${name}\n\n${description}\n` (bare description). The hardened path writes
  `# ${epicName}\n\n## Goal\n\n${epicDesc}\n` (description wrapped under a `## Goal` heading,
  `KanbanProvider.ts:10110-10112`). After delegation, Epics-tab epics adopt the `## Goal`
  format. This matches every other epic in the system; no downstream parser depends on the
  bare-description format. Low risk, documented for completeness.

## Edge-Case & Dependency Audit

- **Race Conditions**
  - **`_kanbanProvider` not yet set.** `PlanningPanelProvider._kanbanProvider` is wired via
    `setKanbanProvider` (line 172). If it is undefined when `createEpic` fires, the delegation
    falls back to an `epicError` post rather than crashing. In practice this is always set before
    the Epics tab can be opened (the project panel and Kanban board co-activate), but the
    defensive guard is cheap and makes the failure mode a visible toast instead of a thrown
    exception. **Trade-off acknowledged:** in this edge case the current path *creates the epic
    (with the three bugs)* while the fixed path *does not create it at all* and surfaces an
    error. This is the correct trade (a visible error beats silent data corruption), but it is
    a behavior delta worth naming.
  - **File-watcher re-import race.** `createEpicFromPlanIds` calls
    `GlobalPlanWatcherService.registerPendingCreation(epicPath)` *before* `writeFile`
    (line 10116-10117), so the watcher skips the new file. The current PlanningPanelProvider path
    does the same (line 3898-3899) — behavior preserved. After the 10s window, a re-import
    derives the `plan_id` from the full-UUID filename suffix (`GlobalPlanWatcherService.ts:540`),
    which now matches the DB row — closing the orphan vector.

- **Security**
  - `createEpicFromPlanIds` strips `\r\n` from the epic name (line 9982) to prevent YAML/H1
    injection. The current PlanningPanelProvider path does **not** strip newlines from the name
    (it only `.trim()`s). Delegation closes this injection vector for the Epics-tab path.
  - No new credential, network, or filesystem-scope exposure. Outbound sync reuses the existing
    `_syncEpicOutbound` path already exercised by board-created epics.

- **Side Effects**
  - **Newly applied to Epics-tab path:** epic-integration worktree provisioning (per-subtask /
    high-low mode) and outbound Linear/ClickUp sync. See Complexity Audit — Complex / Risky.
  - **Board refresh:** `createEpicFromPlanIds` calls `_refreshBoard` (Kanban panel). The
    delegation additionally triggers `fetchKanbanPlans` so the **Epics tab list** updates (it
    reads from `kanbanPlansReady`, not the board push). Two refreshes, both idempotent.
  - **`addToKanbanBoard` flag.** `project.js:3146` sends `addToKanbanBoard: true`, but no
    handler reads it. After delegation this flag remains ignored (harmless —
    `createEpicFromPlanIds` always adds to the board). No change needed.

- **Dependencies & Conflicts**
  - **No regression to the Kanban board's own createEpic.** That path (`KanbanProvider:8972`)
    already delegates to `createEpicFromPlanIds`; this plan only changes the *other* handler, so
    the kanban-board epic-creation flow is untouched.
  - **Blank epic (zero subtasks).** The Epics-tab "+ New Epic" flow always sends
    `subtaskPlanIds: []` (`project.js:3145`). `createEpicFromPlanIds` already supports this
    (line 10036-10038: blank epic defaults to `CREATED`, line 10018-10021: falls back to the
    board's active project filter for `project`). Verified compatible.
  - **Project filter active on the board.** After the fix, the epic inherits
    `kanban.activeProjectFilter` (resolved to `project_id` via `getProjectIdByName`,
    line 10026) and appears on the project-filtered board. This is the core fix for the "epic
    never appears" symptom.
  - **Filename collision.** The current path has a bespoke `${slug}-${planId.slice(0,8)}`
    collision fallback (line 3862). `createEpicFromPlanIds` sidesteps collisions entirely by
    always appending the *full* `planId` UUID (`${slug}-${planId}.md`, line 10057), which is
    unique by construction. Adopting this removes the collision branch rather than needing to
    preserve it.

## Dependencies

- None. This is a self-contained single-file bug fix with no cross-plan ordering constraints.
  The hardened entry point it delegates to (`KanbanProvider.createEpicFromPlanIds`) already
  exists and is stable on this branch.

## Adversarial Synthesis

Key risks: (1) delegation newly applies worktree-provisioning and outbound-sync side effects to
Epics-tab epics — desirable parity, but a behavior delta the implementer must expect; (2) the
`_kanbanProvider`-undefined edge case trades "creates with bugs" for "surfaces an error and does
not create" — the correct trade but a named delta; (3) the epic file content format shifts from
bare-description to `## Goal`-wrapped, matching all other epics. Mitigations: document both
Clarifications in the plan, keep the defensive guard, preserve the `fetchKanbanPlans` follow-up
so the Epics tab list still updates. No blocking issues; complexity 4 → Send to Coder.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts` — replace `createEpic` body with delegation

Replace the duplicated upsert/write/refresh block (lines 3832-3912) with a call to the shared
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
`fs.promises.writeFile` pair, the `db.getWorkspaceId()` guard, and the `epicContent` string
build. All of these now live exactly once, inside `createEpicFromPlanIds`.

**What this preserves:** the `epicError` UX on failure, and the `fetchKanbanPlans` trigger that
updates the Epics tab list itself.

**Clarification — newly applied side effects (not new scope, implied by delegation):** because
the Epics-tab path now runs the full `createEpicFromPlanIds`, blank epics created via the Epics
tab will for the first time trigger (a) epic-integration worktree provisioning when
`epic_worktree_mode` is `per-subtask` or `high-low` (`KanbanProvider.ts:10124-10129`), and (b)
outbound Linear/ClickUp epic sync via `_syncEpicOutbound` (line 10162). This is the intended
parity outcome of using the single choke point; it is called out here so the implementer is not
surprised by worktree creation or external-issue sync for Epics-tab epics.

**Clarification — epic file content format:** the hardened path wraps the description under a
`## Goal` heading (`# ${epicName}\n\n## Goal\n\n${epicDesc}\n`,
`KanbanProvider.ts:10110-10112`) instead of the current bare `# ${name}\n\n${description}\n`.
After delegation, Epics-tab epics adopt the `## Goal` format, matching every other epic in the
system. No downstream parser depends on the bare-description format.

### No other files change

- `KanbanProvider.createEpicFromPlanIds` is already public and already handles blank epics,
  project inheritance, UUID-embedded filenames, watcher suppression, is_epic re-assertion,
  worktree provisioning, outbound sync, and `_refreshBoard`. No modification needed.
- `project.js` already posts the correct `{ type: 'createEpic', name, description, subtaskPlanIds: [], workspaceRoot }`
  payload (line 3141). No webview change needed.
- `GlobalPlanWatcherService` already derives the epic `plan_id` from the full-UUID filename
  suffix (line 540). The fix adopts that filename scheme, so the watcher's re-import path
  becomes correct for Epics-tab epics too.

## Verification Plan

### Automated Tests

No automated tests cover this path — the bug requires the dual-webview (project panel + Kanban
board panel) refresh topology that only exists inside a running VS Code extension host. The
existing unit tests for `createEpicFromPlanIds` already pass and are untouched (the shared
method is not modified). Verification is manual, via an installed VSIX on a real workspace.

### Manual Verification (via installed VSIX)

1. **Reproduce the bug first (pre-fix), then confirm it's gone (post-fix)** via an installed
   VSIX on a real workspace (the only way to exercise the webview + dual-panel refresh path):
   - Open a workspace with a Switchboard Kanban board and at least one project created.
   - On the Kanban board, select a project in the project filter dropdown.
   - Open the Epics tab and click "+ New Epic"; enter a name and create.
   - **Pre-fix expected:** the Kanban board does not refresh; no epic card appears. Switching
     away and back to the board (or waiting for an unrelated refresh) still shows nothing,
     because the epic has `project=''` and is filtered off the project-filtered board.
   - **Post-fix expected:** the Kanban board refreshes immediately and the new epic card
     appears in the CREATED column, rendered as an epic (epic styling, 0 subtasks), on the
     project-filtered board.

2. **Filename check:** after creating an epic via the Epics tab, confirm the file on disk is
   `.switchboard/epics/<slug>-<full-uuid>.md` (matches the regex
   `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.md$`), not `<slug>.md` and not
   `<slug>-<8-char-prefix>.md`.

3. **DB check:**
   `sqlite3 .switchboard/kanban.db "select plan_id, is_epic, project, project_id, plan_file from plans where is_epic=1 order by created_at desc limit 1;"`
   — confirm `is_epic=1`, `project` matches the active project filter, `project_id` is non-null,
   and `plan_file` contains the full UUID.

4. **Re-import robustness:** touch the new epic file (e.g. append a newline) *after* the 10s
   `registerPendingCreation` window expires, then refresh the board. Confirm the epic still
   shows as an epic with the same `plan_id` (no orphaning) — the watcher's UUID-derived
   `plan_id` now matches the DB row because the filename embeds the full UUID.

5. **No regression — Kanban board's own createEpic:** on the Kanban board, select 2+ plan cards
   and use the board's create-epic modal. Confirm the epic still appears on the board
   immediately (this path was untouched).

6. **Failure UX:** send a `createEpic` message with `name=''` directly to the
   PlanningPanelProvider handler (bypassing the webview guard) and confirm the Epics tab shows
   the `epicError` toast rather than silently doing nothing. Also confirm the
   `_kanbanProvider`-undefined guard posts `epicError` (test by temporarily nulling the
   provider in a dev session).

7. **Side-effect parity check (Clarification behaviors):** with `epic_worktree_mode` set to
   `per-subtask`, create a blank epic via the Epics tab and confirm the epic-integration
   worktree is provisioned (matching board-created epic behavior). Confirm outbound sync to
   Linear/ClickUp fires if a provider is configured.

8. **Content format check:** open the created epic file and confirm the description appears
   under a `## Goal` heading (not as bare prose after the H1), matching board-created epics.

## Recommendation

Complexity 4 → **Send to Coder**. Single-file delegation to an existing public method; the only
non-trivial aspects are the two documented Clarification side effects, which are the intended
parity outcome and require no new code.

## Review Findings

**Files changed:** `src/services/PlanningPanelProvider.ts` — the `createEpic` handler (lines 3833-3882) was rewritten to delegate to `KanbanProvider.createEpicFromPlanIds`. No fixes were needed; the implementation matches the plan's proposed code exactly.

**Verification:** Typecheck passes (only 5 pre-existing TS2835 module-resolution warnings, unchanged baseline). No new errors introduced. The `createEpicFromPlanIds` signature `(workspaceRoot, name, planIds, description?)` matches the call `(wsRoot, name, [], description)`. No double-trigger: `_refreshBoard()` (via `switchboard.refreshUI`) refreshes the Kanban board + sidebar, while `fetchKanbanPlans` refreshes the Epics tab (project panel) — different panels, both idempotent. `TaskViewerProvider` never calls `fetchKanbanPlans`, confirming no indirect double-trigger.

**No findings:** The implementation is clean. The `_kanbanProvider` undefined guard, `epicError` UX on failure, and `fetchKanbanPlans` follow-up are all present and correct. The newly-applied side effects (worktree provisioning, outbound sync) and the `## Goal` format change are documented in the plan and are intended parity outcomes of delegation.

**Remaining risks:** Manual VSIX verification (board refresh, filename UUID check, DB project/project_id check, re-import robustness) was not run per SKIP TESTS/COMPILATION directives. The `_kanbanProvider`-undefined edge case trades "creates with bugs" for "surfaces error and does not create" — the correct trade but a named behavior delta.
