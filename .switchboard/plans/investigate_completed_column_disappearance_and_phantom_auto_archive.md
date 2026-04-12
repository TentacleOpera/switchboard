# Investigate Completed Column Disappearance and Phantom Auto-Archive

## Goal

Determine what changed **today** that caused previously visible plans to disappear from the Kanban **Completed** column, and verify whether the root cause is:

1. a fresh data mutation today,
2. a latent visibility regression that only surfaced today,
3. a startup/refresh path that reclassified or hid old completed plans, or
4. local uncommitted code changing how Completed is rendered.

This plan is intentionally an **investigation plan**, not an implementation plan. The previous explanation ("auto-archiving has been on for a while") is **not sufficient**, because current evidence does **not** show a mass archive operation happening today.

## Metadata
**Tags:** backend, UI, database, bugfix
**Complexity:** 7

## User Review Required
> [!NOTE]
> - This plan exists because the current diagnosis is incomplete. It explains part of the behavior, but it does **not** yet explain why the disappearance appeared to happen **today**.
> - Do **not** start by changing code. First establish whether today’s disappearance was caused by a fresh mutation, a refresh/startup regression, or local uncommitted code.
> - Do **not** run state-mutating git commands. Read-only git inspection only.
> - If the reviewer confirms a code regression, the likely follow-up will require a second implementation plan rather than folding code changes into this investigation artifact.

## Complexity Audit
### Routine
- Inspect the current Completed-column query path in `src/services/KanbanProvider.ts` and `src/services/KanbanDatabase.ts`.
- Inspect the current completion/archive flow in `src/services/TaskViewerProvider.ts`.
- Compare current behavior against the original Completed-column implementation commit and recent local working-tree changes.
- Query `.switchboard/kanban.db` for status counts, update timestamps, and plan-management events.

### Complex / Risky
- Resolve the contradiction between user observation ("the cards were visible earlier today") and current database evidence (no large archive-wave today).
- Determine whether a startup/refresh path or local uncommitted code caused an existing archived backlog to stop rendering.
- Distinguish "completed", "archived", and "completed but displayed" semantics across DB rows, registry state, runsheets, and archive directories.
- Avoid false conclusions caused by stale UI state, cached board state, or code restored/recovered outside normal commit history.

## Edge-Case & Dependency Audit
- **Race Conditions:** Startup and refresh paths can rebuild registry/DB state after initial render. A board may appear correct at first and then change after a deferred refresh or startup reconciliation.
- **Security:** No direct security issue is under investigation here, but hidden behavior behind non-surfaced settings is a trust/UX defect and may cause users to lose confidence in board state.
- **Side Effects:** Investigation must remain read-only. Do not rewrite plans, repair DB rows, or toggle settings while gathering evidence, or the timeline becomes contaminated.
- **Dependencies & Conflicts:** The current working tree has uncommitted changes in `package.json`, `src/services/KanbanDatabase.ts`, `src/services/KanbanProvider.ts`, and `src/services/TaskViewerProvider.ts`. The reviewer must treat the local working tree as a possible cause of today's behavior and not assume HEAD alone explains what the user saw.

## Adversarial Synthesis
### Grumpy Critique
> The lazy answer is "auto-archive has been around since February, case closed." That answer is theatrically incomplete. The user did not ask when the code was first written; the user asked why the cards disappeared **today** after being visible earlier. The current evidence actually undermines the simple story: the database does **not** show a big archive/status transition on 2026-04-12. So if you stop at "there's a hidden default-true setting," you are confusing historical capability with today's trigger. Worse, the working tree is dirty in exactly the files that control Completed rendering, so treating committed history as the whole truth is amateur hour. You need to explain the day-of disappearance, not merely prove that archiving exists somewhere in the codebase.

### Balanced Response
> The critique is valid. The evidence collected so far proves three things: completed/archived semantics are inconsistent, the `autoArchiveCompleted` setting is phantom, and many plans are currently `archived` rather than `completed`. But it does **not** yet prove what changed today. This investigation must therefore focus on the **delta between "visible earlier today" and "missing now"**. The most credible paths are: (1) a rendering/query regression in the local working tree, (2) a refresh/startup path that stopped displaying archived-completed plans, or (3) a stale UI/cache state that masked the underlying archived status until a refresh. The next reviewer should prove or eliminate each of those with explicit file inspection, commit comparison, and DB/event evidence before proposing a fix.

## Confirmed Evidence

### 1. Current board state
- `switchboard-get_kanban_state` currently returns:
  - `COMPLETED`: empty
  - `CODE REVIEWED`: populated
- This confirms the symptom is real **right now**.

### 2. Current database state
- `.switchboard/kanban.db` currently contains:
  - `archived`: **176**
  - `active`: **54**
  - `completed`: **3**
  - `deleted`: **1**
- All rows belong to the same workspace ID:
  - `038bffef-9842-4574-96a1-69a43a280b3c`
- `.switchboard/workspace-id` and `.switchboard/workspace_identity.json` both match that same workspace ID.

### 3. Date distribution does **not** show a mass archive today
- By `updated_at` day in `plans`:
  - `archived` on `2026-04-05`: **167**
  - `archived` on `2026-04-09`: **8**
  - `archived` on `2026-04-10`: **1**
  - `archived` on `2026-04-12`: **0**
- This is the key contradiction: if the user is right that the cards were visible earlier today, then today's disappearance was likely caused by a **visibility/query/state** change, not a fresh mass-archive event recorded in `updated_at`.

### 4. Today's plan-management evidence is minimal
- `plan_events` shows only one relevant event today:
  - `2026-04-12T03:13:34.105Z`
  - `operation: mark_complete`
  - session `antigravity_7893c9b6252330d467e9f9f5beda401383183bf0cd9b4360fea30d7931d0cd81`
- This does **not** explain the disappearance of a large historical Completed backlog.

### 5. Hidden / phantom archive setting
- `package.json` defines:
  - `switchboard.archive.autoArchiveCompleted`
  - default: `true`
- Repo search found this string only in `package.json`, not in runtime code or setup UI.
- Therefore:
  1. the setting exists,
  2. it is not exposed in `src/webview/setup.html`,
  3. it is not being read in runtime logic,
  4. it is effectively a phantom setting.

### 6. Completion currently archives unconditionally
- Current code path:
  - `src/services/TaskViewerProvider.ts:1467-1469`
  - `src/services/TaskViewerProvider.ts:8383-8444`
  - `src/services/TaskViewerProvider.ts:8567-8640`
- Moving to `COMPLETED` calls `_handleCompletePlan()`, which unconditionally calls `_archiveCompletedSession(...)`.

### 7. Completed-column rendering currently depends on `status='completed'`
- Current query:
  - `src/services/KanbanDatabase.ts:743-752`
- `getCompletedPlans(workspaceId, limit)` currently returns rows where:
  - `status = 'completed'`
- Current board rendering:
  - `src/services/KanbanProvider.ts:955-965`
- So any rows reclassified to `archived` will vanish from the Completed column even if users think of them as "completed plans."

### 8. Current code explicitly converts completed -> archived in some paths
- `src/services/TaskViewerProvider.ts:5612-5627`
  - `p.status === 'completed' ? 'archived' : p.status`
- `src/services/TaskViewerProvider.ts:6261`
  - `sheet.completed === true ? 'archived' : 'active'`
- These paths strongly suggest historical "completed" records can be normalized into "archived" and then disappear from the Completed column.

### 9. Historical timeline
- `802aa34` (2026-02-27, `launch commits`)
  - introduced `_handleCompletePlan()` and `_archiveCompletedSession()` behavior.
- `5611028` (2026-03-24, `feat: add Completed kanban column for archived plans`)
  - strongly implies the original Completed column was meant to show archived-completed items.
- `1bfad75` (2026-03-28, `Add adversarial code review to Database Operations Panel plan`)
  - added `switchboard.archive.dbPath`
  - added `switchboard.archive.autoArchiveCompleted` with default `true`
- The local working tree is currently dirty in:
  - `package.json`
  - `src/services/KanbanDatabase.ts`
  - `src/services/KanbanProvider.ts`
  - `src/services/TaskViewerProvider.ts`

## Core Contradiction to Resolve

The current evidence supports **historical** auto-archiving/archived-status behavior, but it does **not** explain the user's observation that completed plans were visible earlier today and then disappeared.

That contradiction must be resolved before any implementation fix is accepted.

## Working Hypotheses

### Hypothesis A — Visibility regression, not fresh archive
The old completed backlog was already mostly `archived`, but the board **used to display archived-completed plans** and now no longer does. This could be due to a recent code path or local uncommitted change making the Completed column depend strictly on `status='completed'`.

### Hypothesis B — Startup or refresh replaced stale UI state with DB truth
The user may have been looking at a stale/cached/carry-over board state earlier, and a later refresh/reload/startup path reloaded the DB and removed archived rows from the Completed column.

### Hypothesis C — Local working-tree regression today
Because the local working tree is dirty in the exact Kanban files involved, the disappearance may have been caused by uncommitted code, not by a historical committed change.

### Hypothesis D — Rehydration / registry sync changed what counts as completed
A startup sync path may be converting rows or registry entries in a way that makes historical completed plans render as archived-only after reload, even if they were visible before that reload.

## Investigation Workstreams

### Workstream 1 — Compare current Completed behavior against original intent
#### [MODIFY NOTHING] Inspect historical Completed-column semantics
- **Files to inspect:**
  - `src/services/KanbanProvider.ts`
  - `src/services/KanbanDatabase.ts`
  - `src/services/TaskViewerProvider.ts`
- **Git references to inspect:**
  - `5611028` — original Completed-column implementation
  - `802aa34` — initial archive-on-complete implementation
  - `1bfad75` — phantom setting introduction
- **Questions to answer:**
  1. Did the Completed column originally show archived plans, completed plans, or both?
  2. When did the query contract become `status='completed'` only?
  3. Was the old fallback path removed?

### Workstream 2 — Audit today's local working-tree deltas
#### [MODIFY NOTHING] Compare working tree vs HEAD
- **Files to inspect:**
  - `package.json`
  - `src/services/KanbanDatabase.ts`
  - `src/services/KanbanProvider.ts`
  - `src/services/TaskViewerProvider.ts`
- **Questions to answer:**
  1. Did an uncommitted local change today alter Completed rendering semantics?
  2. Did any local change remove an archived-plan fallback or tighten the Completed query?
  3. Is the user's "it happened today" observation best explained by local edits rather than committed history?

### Workstream 3 — Reconstruct today's event timeline
#### [MODIFY NOTHING] Use DB evidence, not memory
- **Artifacts to inspect:**
  - `.switchboard/kanban.db`
  - `.switchboard/archive/plans/`
  - `.switchboard/archive/sessions/`
  - `.switchboard/sessions/`
- **Tables to query:**
  - `plans`
  - `activity_log`
  - `plan_events`
- **Questions to answer:**
  1. Did any plans actually change status today?
  2. Did any refresh path write plan rows today without obvious archive events?
  3. Are there cards whose DB status remained archived while UI visibility changed today?

### Workstream 4 — Inspect startup and rehydration paths
#### [MODIFY NOTHING] Trace the code that can hide cards without new user action
- **Functions to inspect:**
  - `TaskViewerProvider._loadPlanRegistry()`
  - `TaskViewerProvider._savePlanRegistry()`
  - `TaskViewerProvider._migrateLocalPlansToRegistry()`
  - `TaskViewerProvider._reconcileAntigravityPlanMirrors()`
  - `KanbanProvider._refreshBoardImpl()`
- **Questions to answer:**
  1. Which path runs on startup or board refresh and can convert completed semantics to archived semantics?
  2. Which path could have run today without a corresponding mass plan-management event?
  3. Does board refresh render from DB only, whereas earlier UI state came from a fallback/cached source?

### Workstream 5 — Confirm the phantom-setting defect separately
#### [MODIFY NOTHING] Establish scope of the archive settings bug
- **Files to inspect:**
  - `package.json`
  - `src/webview/setup.html`
  - `src/services/TaskViewerProvider.ts`
  - `src/services/KanbanProvider.ts`
  - `src/extension.ts`
- **Questions to answer:**
  1. Is `switchboard.archive.autoArchiveCompleted` entirely unused?
  2. Is there any non-setup UI surface that exposes it?
  3. Should this become a separate bug/plan from the "why today?" investigation?

## Suggested Commands for Reviewer

```bash
git --no-pager status --short -- src/services/KanbanDatabase.ts src/services/KanbanProvider.ts src/services/TaskViewerProvider.ts package.json
git --no-pager diff -- src/services/KanbanDatabase.ts src/services/KanbanProvider.ts src/services/TaskViewerProvider.ts package.json
git --no-pager show 5611028 -- src/services/KanbanProvider.ts src/services/KanbanDatabase.ts src/services/TaskViewerProvider.ts
git --no-pager show 802aa34 -- src/services/TaskViewerProvider.ts
git --no-pager show 1bfad75 -- package.json
```

```bash
sqlite3 -json .switchboard/kanban.db "SELECT status, COUNT(*) AS count FROM plans GROUP BY status ORDER BY count DESC;"
sqlite3 -json .switchboard/kanban.db "SELECT status, substr(updated_at,1,10) AS day, COUNT(*) AS count FROM plans GROUP BY status, day ORDER BY day DESC, status;"
sqlite3 -json .switchboard/kanban.db "SELECT session_id, topic, status, kanban_column, updated_at FROM plans WHERE status='archived' ORDER BY updated_at DESC LIMIT 50;"
sqlite3 -json .switchboard/kanban.db "SELECT timestamp, event_type, payload FROM activity_log WHERE timestamp >= '2026-04-12' ORDER BY timestamp DESC LIMIT 100;"
sqlite3 -json .switchboard/kanban.db "SELECT timestamp, event_type, payload FROM plan_events WHERE timestamp >= '2026-04-12' ORDER BY timestamp DESC LIMIT 100;"
```

## Success Criteria

The investigation is complete only when the reviewer can answer **all** of the following:

1. Why were completed plans visible earlier today but missing later?
2. Was today's disappearance caused by:
   - a fresh data mutation,
   - a refresh/startup/rendering change,
   - or local uncommitted code?
3. Are archived plans supposed to appear in the Completed column or not?
4. When did that behavior change?
5. Is `switchboard.archive.autoArchiveCompleted` a dead/phantom setting?
6. Should the fix be:
   - render archived-completed plans again,
   - stop coercing completed -> archived,
   - respect the archive setting,
   - expose the setting in setup,
   - or split those into separate fixes?

## Recommended Agent

Send to Lead Coder
