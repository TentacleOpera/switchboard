# Plan: Agent Epic Creation & Grouping

## Goal

Give Switchboard agents the ability to **create epics and assign plans to them** programmatically (today they can only *move* cards), and add a "Suggest Epics" board button so a user can ask an agent to scan pre-coding columns and propose groupings for one-click approval. The DB, the webview epic-create logic, and the dual-path CLI script pattern already exist — this plan wires them together and documents the workflow.

**Core problem / root cause.** The epic data model is fully implemented in `KanbanDatabase.ts` (`is_epic`, `epic_id`, `updateEpicStatus`, `getSubtasksByEpicId`, `upsertPlan`, `getEpicPlans`) and the webview already has a complete `createEpic` message handler in `KanbanProvider.ts` (lines 7834–7947). The gap is purely an **exposure gap**, not a capability gap:
1. The `createEpic` logic is trapped inside the webview message switch — no callable public method, no API route, no CLI script — so an agent (which speaks via `kanban_operations/*.js` → LocalApiServer) cannot reach it.
2. There is no batch "assign plans to existing epic" path for agents (only the single-card `addSubtaskToEpic` webview handler at line 7737).
3. There is no UI entry point that asks an agent to *propose* groupings; epic creation today is manual card-by-card.
4. The workflow is undocumented, so even if the scripts existed, agents would use them ad-hoc instead of following a consistent scan→propose→confirm→execute flow.

## Metadata

**Tags:** [backend, api, ui, feature, refactor]
**Complexity:** 6
**Repo:** (single-repo — no line per FOCUS DIRECTIVE)

## User Review Required

Yes — review the corrected sync claim (see Adversarial Synthesis / Edge-Case Audit) and confirm whether epic creation should push to Linear/ClickUp. The current webview `createEpic` handler does **not** sync to external trackers; this plan preserves that behavior by default and flags it as an explicit decision.

## Context

Agents can already move kanban cards (via `kanban_operations/move-card.js`), but they have no way to create epics or assign cards to them. The DB already supports epics (`is_epic`, `epic_id` columns, `updateEpicStatus`, `getSubtasksByEpicId`, etc.) and the webview already has full epic create/assign logic in `KanbanProvider.ts` (`createEpic` message handler). The gap is:

1. Exposing that logic to agents via the skill/API layer
2. Adding a "Suggest Epics" button to the board UI as a third entry point
3. Documenting the workflow so agents follow it consistently (scan→propose→confirm→execute)

---

## What Gets Built

### 1. Two new CLI scripts in `.agents/skills/kanban_operations/`

**`create-epic.js`**
- Args: `<epic_name> <plan_ids_json> [workspace_root] [description]`
- `plan_ids_json` is a JSON array of `plan_id` values (from `get-state.js` output — each plan record exposes `planId`, NOT `sessionId`; see Verification step 1)
- Dual-path like `move-card.js`:
  - Preferred: `POST /kanban/epic` on the running extension's API server → full flow (DB upsert, subtask linking, epic file write, board refresh). **Clarification:** unlike card *moves*, epic *creation* does NOT currently fan out to Linear/ClickUp — the existing `createEpic` webview handler (KanbanProvider.ts:7834–7947) calls no sync service, and `GlobalPlanWatcherService.registerPendingCreation(epicPath)` (line 7932) intentionally makes the watcher *skip* the new file. So the preferred path matches webview behavior exactly: DB + file + board refresh, **no external-tracker sync**. See Edge-Case Audit.
  - Fallback: direct DB write via `KanbanDatabase` (no board refresh, no sync). Requires `out/` to be built (see Dependencies note on `out/`).
- Output: JSON `{ ok, epicPlanId, epicSessionId }`

**`assign-to-epic.js`**
- Args: `<epic_plan_id> <plan_ids_json> [workspace_root]`
- Assigns additional plans to an existing epic (batch form of the existing single-card `addSubtaskToEpic` webview handler at KanbanProvider.ts:7737)
- Same dual-path routing (`POST /kanban/epic/assign`)
- Output: JSON `{ ok, assigned, skipped }` — `skipped` lists planIds that were already on another epic (the `addSubtaskToEpic` handler rejects these at line 7759; the batch version skips-and-reports rather than aborting the whole batch)

### 2. New API endpoints in `LocalApiServer.ts`

Two new callbacks added to `LocalApiServerOptions` (interface at line 8–30, alongside `moveCard` at line 24):
- `createEpic?(workspaceRoot, name, planIds, description?)` → `{ success, epicPlanId, epicSessionId, error? }`
- `assignToEpic?(workspaceRoot, epicPlanId, planIds)` → `{ success, assigned, skipped, error? }`

Two new route handlers, modeled on `_handleKanbanMove` (line 205–242):
- `POST /kanban/epic` — calls `createEpic` callback
- `POST /kanban/epic/assign` — calls `assignToEpic` callback

Both reuse the existing `_checkAuth(req, true)` gate and `_parseJsonBody` helper used by `_handleKanbanMove`. Add the two routes to the `pathname` dispatch in `_handleRequest` (line 842 region), immediately after the `/kanban/move` branch.

### 3. New public methods in `KanbanProvider.ts`

- `createEpicFromPlanIds(workspaceRoot, name, planIds, description?)` — extracts the body of the existing `createEpic` webview case (lines 7834–7947) into a callable public method. The webview `case 'createEpic'` then delegates to it (no duplication of the upsert/subtask-link/file-write logic). Returns `{ success, epicPlanId, epicSessionId }`.
- `assignPlansToEpic(workspaceRoot, epicPlanId, planIds)` — batch wrapper around the logic in the existing `addSubtaskToEpic` case (lines 7737–7766): for each planId, look up the subtask, skip if already on another epic (report in `skipped`), otherwise `updateEpicStatus` + `_regenerateEpicFile` + `_refreshBoard` once at the end. Honors the same `epic_lock_columns` config check (line 7747–7751) — if the epic is in a locked column, return `{ success:false, error }` without modifying anything.

### 4. Wire callbacks in `TaskViewerProvider.ts`

In `_startLocalApiServer()` (line 889–932), add `createEpic` and `assignToEpic` alongside the existing `moveCard` callback (line 911), delegating to the new `KanbanProvider` public methods. Pattern: guard `if (!this._kanbanProvider) return { success:false, error }`, try/catch, return the result shape.

### 5. "Suggest Epics" button in the kanban webview

In `src/webview/kanban.html` (toolbar at the `kanban-sub-bar` div, line 2516–2533) and `src/webview/project.js`:
- Add a "SUGGEST EPICS" button in the sub-bar (next to the existing `btn-chat-copy-prompt` at line 2527), styled like the existing `strip-btn` class.
- Clicking it posts `{ type: 'suggestEpics', workspaceRoot }` to the extension.
- New `case 'suggestEpics'` in `KanbanProvider._handleWebviewMessage` builds a prompt (using the existing `buildKanbanBatchPrompt`-style helper or `chatCopyPrompt` pattern at line 6362) that instructs the agent to:
  - Read all cards in CREATED, BACKLOG, CONTEXT GATHERER, PLAN REVIEWED via `get-state.js`
  - Propose groupings **all at once** in a single chat message
  - Wait for user confirmation
  - Call `create-epic.js` once per approved group
- **Clarification (implied by existing patterns):** the button copies the prompt to the clipboard and shows a status message (matching `chatCopyPrompt` at line 6380–6383), rather than auto-dispatching to a terminal. This keeps it host-agnostic and consistent with the existing CHAT PROMPT button. If true auto-dispatch is desired, that is a separate decision — flag for user review.

### 6. Updated `SKILL.md`

Documents (in `.agents/skills/kanban_operations/SKILL.md`):
- The full epic grouping workflow (scan → propose → confirm → execute)
- `create-epic.js` usage and output
- `assign-to-epic.js` usage and output
- Which `planId` field to use (from `get-state.js` output) vs `sessionId` — emphasize `planId` because file-watcher-imported plans have `session_id=''` (this is exactly why the existing `createEpic` handler uses `st.planId` at line 7937, not `st.sessionId`)
- Note that the board updates live when the extension is running (preferred path); fallback path requires a manual refresh
- Note that epic creation does **not** sync to Linear/ClickUp (so agents don't assume external trackers are updated)

---

## Approval Flow (Agent Behaviour)

1. Agent reads board state via `get-state.js` (all pre-coding columns)
2. Agent analyses topics and proposes groupings **all at once** in a single chat message
3. User gives one approval (or edits the groupings)
4. Agent runs `create-epic.js` once per group — no further confirmation needed
5. Agent optionally runs `assign-to-epic.js` if user wants to add more cards later

This is documented in SKILL.md so the agent follows it consistently, not just ad-hoc.

---

## Critical Files

| File | Change |
|------|--------|
| `src/services/KanbanProvider.ts` | Add `createEpicFromPlanIds()` and `assignPlansToEpic()` public methods; refactor `case 'createEpic'` (line 7834) to delegate; add `suggestEpics` webview message handler |
| `src/services/LocalApiServer.ts` | Add `createEpic`/`assignToEpic` callbacks to `LocalApiServerOptions` (line 8); add `_handleKanbanCreateEpic` + `_handleKanbanAssignEpic` handlers modeled on `_handleKanbanMove` (line 205); wire two routes into `_handleRequest` dispatch (after line 843) |
| `src/services/TaskViewerProvider.ts` | Wire `createEpic` and `assignToEpic` callbacks in `_startLocalApiServer()` (line 900–932), delegating to `KanbanProvider` |
| `src/webview/kanban.html` | Add "SUGGEST EPICS" `strip-btn` in `kanban-sub-bar` (line 2516–2533) |
| `src/webview/project.js` | Handle `suggestEpics` button click → `vscode.postMessage({ type:'suggestEpics', workspaceRoot })` (pattern from line 2308) |
| `.agents/skills/kanban_operations/create-epic.js` | New script — copy `move-card.js` dual-path skeleton (lines 33–161), replace `/kanban/move` with `/kanban/epic` |
| `.agents/skills/kanban_operations/assign-to-epic.js` | New script — same skeleton, `/kanban/epic/assign` |
| `.agents/skills/kanban_operations/SKILL.md` | Updated docs + workflow |

---

## Key Reuse (do not reinvent)

- `KanbanDatabase.upsertPlan()` (line 1287) — epic record insert
- `KanbanDatabase.updateEpicStatus(planId, isEpic, epicId)` (line 1455) — subtask→epic linking
- `KanbanDatabase.getSubtasksByEpicId()` (line 3726) — fetch subtasks
- `KanbanDatabase.getPlanByPlanId()` — used throughout the existing `createEpic` handler
- `KanbanProvider._regenerateEpicFile()` — already regenerates the epic markdown
- `KanbanProvider._refreshBoard()` — already triggers webview update
- `move-card.js` — copy its dual-path pattern (API → DB fallback) exactly; reuse `findApiPort` + `httpJson` verbatim
- `get-state.js` — agents use this unchanged to read the board before suggesting
- `addSubtaskToEpic` webview case (line 7737) — `assignPlansToEpic` is the batch extraction of this

---

## Complexity Audit

### Routine
- Copying the `move-card.js` dual-path skeleton into two new scripts (mechanical)
- Adding two callback fields to `LocalApiServerOptions` and two route branches mirroring `/kanban/move`
- Wiring two callbacks in `_startLocalApiServer()` next to `moveCard`
- Extracting the `createEpic` switch body into a public method (pure refactor, no logic change)
- Adding a toolbar button + click handler in the webview (existing `strip-btn` pattern)
- SKILL.md documentation additions

### Complex / Risky
- **Sync-claim correctness:** the plan originally asserted the preferred path gives "Linear/ClickUp sync"; code reading shows epic creation does NOT sync (no sync call in the handler, and `registerPendingCreation` suppresses the watcher). Documentation and agent expectations must reflect this, or an explicit sync hook must be added (scope expansion — flagged for user review).
- **Batch assign semantics:** `assignPlansToEpic` must decide skip-vs-abort when a plan is already on another epic. Choosing skip-and-report (matching robust batch idioms) diverges slightly from the single-card `addSubtaskToEpic` which warns-and-breaks. Must be consistent and documented.
- **`out/` build dependency:** the fallback (direct-DB) path `require`s from `../../../out/services/KanbanDatabase`. `out/` is produced by `tsc -p . --outDir out` (the `watch-tests`/`compile-tests` script), NOT by `npm run compile` (webpack → `dist/`). The fallback silently fails if `out/` is stale/missing. This is inherited from `move-card.js`, not new, but the new scripts double the surface area.

---

## Edge-Case & Dependency Audit

- **Race Conditions:** An agent runs `create-epic.js` while the user is simultaneously dragging one of the same subtasks onto a different epic in the webview. Last `updateEpicStatus` write wins; the subtask ends up on whichever epic was written last. Mitigation: the `addSubtaskToEpic` "already belongs to another epic" guard (line 7759) is check-then-act and not atomic across the HTTP boundary — acceptable for a single-user local tool, but `assignPlansToEpic` should re-check each plan's `epicId` immediately before writing and report conflicts in `skipped`.
- **Security:** Both new routes must call `_checkAuth(req, true)` exactly as `_handleKanbanMove` does (line 206). Do not skip auth on the new endpoints. Validate that `planIds` is an array of strings and `name` is a non-empty trimmed string (mirror the validation at line 228–231). Reject epic names containing newlines (the existing handler strips them via slug regex at line 7883; preserve this).
- **Side Effects:** Epic creation writes a new file under `.switchboard/epics/` and calls `registerPendingCreation` so the watcher ignores it. If the API call fails *after* the DB upsert but *before* the file write, the DB has an epic record with no file → the next watcher scan may treat it as orphaned. The existing handler upserts first then writes (line 7894→7933); preserve this order and rely on the existing `verifyEpic` log (line 7945) for diagnostics. No new side effects beyond what the webview already does.
- **Dependencies & Conflicts:** `createEpicFromPlanIds` and the webview `createEpic` case must not double-execute. After refactor, the webview case must *only* delegate (no residual upsert code). `assignPlansToEpic` must call `_refreshBoard` once after the batch, not per-item. The `epic_lock_columns` guard (line 7747) must be evaluated once up-front for the whole batch.

---

## Dependencies

- `out/services/KanbanDatabase.js` must exist for the fallback path — produced by `npm run watch-tests` (or one-off `tsc -p . --outDir out`). This is an existing dependency of `move-card.js`; the new scripts inherit it.
- No new npm packages. No new external APIs.
- No prior plan sessions required (`sess_…`) — this is a greenfield wiring of existing internals.

---

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the plan's "Linear/ClickUp sync" claim for epic creation is contradicted by the actual `createEpic` handler — shipping the docs as-written would mislead agents into believing external trackers are updated; (2) batch `assignPlansToEpic` introduces check-then-act races with concurrent webview edits; (3) the fallback path's `out/` build dependency is undocumented and silently fails when stale. Mitigations: correct the sync claim in SKILL.md and flag sync-on-create as an explicit user decision; re-check `epicId` per-item in the batch and report conflicts in `skipped`; document the `out/` requirement in SKILL.md alongside the existing `move-card.js` fallback note.

---

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Context:** The `createEpic` webview case (lines 7834–7947) and `addSubtaskToEpic` case (lines 7737–7766) contain the only epic-mutation logic in the codebase.
- **Logic:** Extract the `createEpic` case body into `public async createEpicFromPlanIds(workspaceRoot, name, planIds: string[], description?: string): Promise<{success, epicPlanId?, epicSessionId?, error?}>`. Keep every step in order: resolve subtasks via `getPlanByPlanId`, inherit project from subtasks (line 7860–7861), resolve effective column (line 7862–7873), mint planId/sessionId, `upsertPlan` (line 7894), YAML-safe epic file write with `registerPendingCreation` first (line 7932–7933), `updateEpicStatus` per subtask using `st.planId` (line 7937), `_regenerateEpicFile`, re-assert `is_epic=1` (line 7943), `_refreshBoard`. Refactor `case 'createEpic'` to validate `msg` then call `this.createEpicFromPlanIds(...)` and post a status message.
- **Implementation:** Add `public async assignPlansToEpic(workspaceRoot, epicPlanId, planIds: string[]): Promise<{success, assigned: string[], skipped: string[], error?}>`. Look up epic via `getPlanByPlanId`, reject if `!isEpic`. Read `epic_lock_columns` config once (line 7747); if locked, return early. For each planId: look up subtask, skip if `subtask.isEpic` or `subtask.epicId && subtask.epicId !== epic.planId` (append to `skipped`), else `updateEpicStatus(st.planId, 0, epicPlanId)` and append to `assigned`. After the loop: `_regenerateEpicFile` + `_refreshBoard` once.
- **Edge Cases:** Empty `planIds` → return `{success:false, error:'No planIds'}`. All plans already on other epics → `{success:true, assigned:[], skipped:[...]}`. Epic not found → `{success:false, error:'Epic not found'}`.

### `src/services/LocalApiServer.ts`
- **Context:** `LocalApiServerOptions` (line 8) and `_handleKanbanMove` (line 205) are the template.
- **Logic:** Add two optional callbacks to the interface with the signatures in §2. Add `_handleKanbanCreateEpic` and `_handleKanbanAssignEpic` methods, each: `_checkAuth(req, true)` → 401; check callback present → 503; `_parseJsonBody`; validate required string fields (name/epicPlanId, planIds array); call callback; respond `200`/`502` with the result JSON. Add `else if (pathname === '/kanban/epic' && req.method === 'POST')` and `else if (pathname === '/kanban/epic/assign' && req.method === 'POST')` branches in `_handleRequest` (after the `/kanban/move` branch at line 842–843).
- **Edge Cases:** Non-array `planIds` → 400. Missing `name`/`epicPlanId` → 400. Callback throws → 500 with error message (mirror line 237–241).

### `src/services/TaskViewerProvider.ts`
- **Context:** `_startLocalApiServer` (line 889) constructs `LocalApiServer` with `moveCard` (line 911).
- **Logic:** Add `createEpic: async (wsRoot, name, planIds, description) => { if (!this._kanbanProvider) return {success:false, error:'Kanban provider not available'}; try { return await this._kanbanProvider.createEpicFromPlanIds(wsRoot, name, planIds, description); } catch (err) { return {success:false, error: err.message}; } }` and the analogous `assignToEpic` delegating to `assignPlansToEpic`.
- **Edge Cases:** Provider null → 503-style error result. Exception → caught and returned as `{success:false, error}`.

### `.agents/skills/kanban_operations/create-epic.js` (new)
- **Context:** Copy `move-card.js` (lines 1–161) skeleton.
- **Logic:** Args `<epic_name> <plan_ids_json> [workspace_root] [description]`. `JSON.parse(plan_ids_json)` → validate array. `tryViaExtension()` → `POST /kanban/epic` with `{ workspaceRoot, name, planIds, description }`; on success print `JSON.stringify({ok:true, epicPlanId, epicSessionId})`. Fallback `viaDirectDb()` → `require('../../../out/services/KanbanDatabase')`, `forWorkspace`, `ensureReady`, replicate the upsert+link sequence (or, preferably, throw a clear error directing the user to run the extension, since replicating the full webview flow in raw DB calls duplicates significant logic — see Adversarial note). Print `JSON.stringify({ok:false, error})` on failure.
- **Edge Cases:** Invalid JSON array → usage error + exit 1. Extension reachable but returns `{success:false}` → print error, do NOT fall back (authoritative, matching `move-card.js` line 144–152).

### `.agents/skills/kanban_operations/assign-to-epic.js` (new)
- **Context:** Same skeleton as `create-epic.js`.
- **Logic:** Args `<epic_plan_id> <plan_ids_json> [workspace_root]`. `POST /kanban/epic/assign` with `{ workspaceRoot, epicPlanId, planIds }`. Print `{ok, assigned, skipped}`.
- **Edge Cases:** Same as create-epic. Empty `planIds` array → still call through (server returns `{success:false, error}`).

### `src/webview/kanban.html` + `src/webview/project.js`
- **Context:** Sub-bar at kanban.html line 2516–2533; existing button pattern at line 2527; existing postMessage pattern at project.js line 2308.
- **Logic:** Add `<button class="strip-btn" id="btn-suggest-epics" data-tooltip="Scan pre-coding columns and propose epic groupings">SUGGEST EPICS</button>` after `btn-chat-copy-prompt`. In project.js, add click listener (after the `btnNewEpicSubmit` block at line 2300) that posts `{ type:'suggestEpics', workspaceRoot }` (resolve workspaceRoot the same way the surrounding epic modal code does — `epicsFilters.workspaceRoot` at line 2312).
- **Edge Cases:** Button clicked with no cards in pre-coding columns → the extension-side handler should detect this and show a status message rather than copying an empty prompt.

### `.agents/skills/kanban_operations/SKILL.md`
- **Context:** Existing SKILL.md documents `move-card.js` and `get-state.js`.
- **Logic:** Add "## Create an Epic" and "## Assign Plans to an Epic" sections with usage, output shape, and the `planId`-not-`sessionId` note. Add a "## Suggest Epics Workflow" section describing scan→propose→confirm→execute. Add an explicit note: epic creation does not sync to Linear/ClickUp; the board refreshes live only via the preferred (extension-running) path.

---

## Verification Plan

### Automated Tests
*(Skipped per session directive — the user will run the suite separately.)*

### Manual Verification (preserved from original plan)
1. Run `get-state.js` against a workspace with cards in CREATED/BACKLOG — confirm output includes the `planId` field on each plan record (this is the field agents must pass to `create-epic.js`).
2. Run `create-epic.js` with two planIds — confirm the epic appears on the kanban board immediately (extension running) and on restart (fallback path). Confirm `out/services/KanbanDatabase.js` exists before testing the fallback.
3. Run `assign-to-epic.js` — confirm the new card appears under the epic in the Epics tab; confirm a plan already on another epic is reported in `skipped` and not moved.
4. Click "SUGGEST EPICS" button — confirm a prompt is produced that instructs the agent to read the board and propose groupings in chat before touching anything.
5. Approve groupings — confirm epics are created and board updates without further prompts.
6. **Added:** Confirm no Linear/ClickUp sync occurs on epic creation (verify in Linear/ClickUp that no new epic issue/task appears) — documents the current behavior. If sync IS desired, that is a follow-up scope decision.

---

## Recommendation

Complexity is **6** (multi-file coordination, two new scripts, one new UI entry point, but all reusing existing patterns and existing epic internals — no new architectural patterns, no data-model changes). **Send to Coder.**
