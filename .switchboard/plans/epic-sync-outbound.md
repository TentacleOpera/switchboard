# Plan: Outbound Epic Sync to Linear + ClickUp

## Goal

When a Switchboard epic is created (or plans are assigned/unassigned to one), push the parent/child relationship to Linear and ClickUp so external trackers reflect the epic structure. Today, epic creation syncs nothing — the `createEpicFromPlanIds` method (KanbanProvider.ts) calls no sync service, and the `SKILL.md` explicitly tells agents "epic creation does NOT sync to Linear/ClickUp." This plan closes that gap.

**Core problem / root cause.** The existing move-sync pattern is **fire-and-forget**: `queueIntegrationSyncForPlanFile` → `debouncedSync` (500ms timer) → `syncPlan` creates/updates a flat external issue/task for the moved plan. It works for column changes because the only thing that changes is the issue state — no dependency on the *result* of the sync. Epic sync is different: to link subtasks as children of an epic, the **epic's external issue/task must be created first** and its ID known, then each subtask's existing external issue/task is updated to point at it as parent. The current debounced fire-and-forget cannot express this ordering — it queues the epic and the subtasks independently with no coordination. The sync services already have the linking primitives (`LinearSyncService.updateIssueParent`, `ClickUpSyncService.updateTask` with `parent` param) but they are never called from the epic creation path.

**Key design decision (user-confirmed):** ClickUp uses **parent/child tasks** (not ClickUp epics). ClickUp epics are a higher-level grouping closer to Switchboard projects. Linear uses **parent issues** (`parentId` on child issues). Both map cleanly to the Switchboard epic→subtask relationship.

## Metadata

**Tags:** [backend, api, sync, feature]
**Complexity:** 7
**Repo:** (single-repo)
**Depends on:** `agent-epic-creation.md` (shipped — `createEpicFromPlanIds` and `assignPlansToEpic` exist)

## User Review Required

Yes — confirm:
1. Failure semantics: if the epic's external issue/task creates successfully but a subtask parent-link fails, should the epic creation still succeed (report partial sync) or roll back? This plan proposes **report partial sync, do not roll back** (matching the script pattern in `create-epic.js`).
2. Whether `promoteToEpic` (single-plan promotion, KanbanProvider.ts:7768) should also sync. This plan proposes yes — it's the same conceptual operation (a plan becomes an epic), and the promoted plan already has an external issue/task that should become a parent.

## Context

The move-sync infrastructure is mature:
- `KanbanProvider._queueClickUpSync` (line 1876) and `_queueLinearSync` (line 1903) load config, check `realTimeSyncEnabled`, and call `debouncedSync`.
- `LinearSyncService.syncPlan` (line 1902) maps column→stateId, looks up existing issue via `getIssueIdForPlan` (sync map backed by DB table), creates or updates.
- `LinearSyncService.createIssue` (line 1992) creates a flat issue, persists `planFile → issueId` in the sync map, and writes `linearIssueId` to the kanban DB.
- `LinearSyncService.updateIssueParent` (line 1066) calls `issueUpdate` with `parentId` — the linking primitive already exists.
- `ClickUpSyncService.syncPlan` (line ~2540) looks up `plan.clickupTaskId` or `_findTaskByPlanId`, updates or creates via `_updateTask`/`_createTask`.
- `ClickUpSyncService.updateTask` (line 1383) accepts a `parent` field — the linking primitive already exists.
- `ClickUpSyncService.createTask` (line 1283) also accepts `parent` — so a subtask could be created with parent set if it doesn't exist yet.

The gap is purely in `createEpicFromPlanIds` and `assignPlansToEpic` — neither calls any sync.

---

## What Gets Built

### 1. New sync methods on both sync services

**`LinearSyncService.syncEpicWithSubtasks(params)`**
- `params: { epicPlanFile, epicTopic, epicColumn, subtasks: Array<{ planFile, topic, complexity }> }`
- Creates/updates the epic issue first (reuse `syncPlan` logic but **await it**, not debounce).
- Returns `{ epicIssueId, linked: string[], failed: string[] }` — `linked`/`failed` are planFiles.
- For each subtask: look up its existing `linearIssueId` via `getIssueIdForPlan`. If found, call `updateIssueParent(subIssueId, epicIssueId)`. If not found, the subtask has no Linear issue yet — skip and add to `failed` (do NOT create it; creating a subtask issue requires state mapping and description building that belongs to the normal sync flow, not the epic-linking flow).
- Guards: `config.setupComplete && config.realTimeSyncEnabled` — bail if not.

**`ClickUpSyncService.syncEpicWithSubtasks(params)`**
- Same shape: `{ epicPlanFile, epicTopic, epicColumn, subtasks: Array<{ planFile, planId, topic, complexity }> }`
- Creates/updates the epic task first (await `syncPlan` equivalent, not debounce).
- Returns `{ epicTaskId, linked: string[], failed: string[] }`.
- For each subtask: look up its existing `clickupTaskId` from the DB record (`plan.clickupTaskId` or `_findTaskByPlanId`). If found, call `updateTask(subTaskId, { parent: epicTaskId })`. If not found, skip to `failed`.
- Guards: same config check.

**`LinearSyncService.unlinkSubtasksFromEpic(params)`** / **`ClickUpSyncService.unlinkSubtasksFromEpic(params)`**
- `params: { subtaskPlanFiles: string[] }`
- For each subtask: look up external ID, set parent to null (Linear) / clear parent (ClickUp).
- Used by `removeSubtaskFromEpic` and when a subtask is reassigned to a different epic via `assignPlansToEpic`.

### 2. Wire sync calls into `KanbanProvider`

**In `createEpicFromPlanIds` (after `_refreshBoard`, before `return`):**
- Call `_syncEpicOutbound(workspaceRoot, epicPlanFile, epicName, effectiveColumn, subtasks)` — a new private method that fans out to both services in parallel (`Promise.allSettled`), checks `realTimeSyncEnabled` first, and logs results. Does NOT block the epic creation return on sync success — the epic is already created locally; sync is best-effort with diagnostic logging.

**In `assignPlansToEpic` (after the batch loop, after `_refreshBoard`):**
- For the newly `assigned` plans: call the same `_syncEpicOutbound` but only for the assigned subset (the epic already has an external issue; just link the new children).
- For any plans that were skipped because they were on a *different* epic: optionally unlink them from the old epic's external issue first (set parent to null, then the new epic's `syncEpicWithSubtasks` will set the new parent). This is the reparenting case.

**In `removeSubtaskFromEpic` (existing webview case, KanbanProvider.ts:7872):**
- After the DB unlink, call `unlinkSubtasksFromEpic` on both services for the removed subtask.

**In `promoteToEpic` (KanbanProvider.ts:7768):**
- After `_refreshBoard`, call `_syncEpicOutbound` with the promoted plan as the epic and no subtasks (the promoted plan's existing external issue just needs to exist — no children to link yet). This ensures the promoted plan's external issue is up-to-date. Children added later via `assignPlansToEpic` will trigger the linking path.

### 3. The `create-and-wait` pattern (the core complexity)

The existing `syncPlan` is called via `debouncedSync` (500ms timer, fire-and-forget). For epic sync, the epic issue must be created and its ID known BEFORE linking children. Two approaches:

**Approach A (preferred): await `syncPlan` directly, bypass the debounce.**
- `syncPlan` is already `async` and returns `Promise<void>`. Call it directly (not through `debouncedSync`) for the epic plan. After it resolves, look up the epic's external ID via `getIssueIdForPlan` (Linear) or the DB record (ClickUp).
- Risk: `syncPlan` was designed to be called from a debounce timer. Calling it directly should work — it's a normal async method with no timer-specific state. But verify it doesn't rely on debounce-specific cleanup.

**Approach B (fallback): add a `syncPlanAndWait` wrapper.**
- Wraps `syncPlan` in a Promise that resolves when the sync map has a real (non-`creating_*`) issue ID. Polls the sync map every 100ms up to 5s.
- More robust if `syncPlan` has hidden timer dependencies, but adds latency and complexity.

This plan proposes Approach A. If it proves fragile, fall back to B.

### 4. Update `SKILL.md`

Remove the "epic creation does NOT sync to Linear/ClickUp" note. Replace with: "Epic creation syncs the epic as a parent issue/task and links subtasks as children, IF real-time sync is enabled for Linear/ClickUp. Subtasks without an existing external issue are skipped (they'll be linked on their next individual sync)."

---

## Critical Files

| File | Change |
|------|--------|
| `src/services/LinearSyncService.ts` | Add `syncEpicWithSubtasks()` and `unlinkSubtasksFromEpic()` public methods |
| `src/services/ClickUpSyncService.ts` | Add `syncEpicWithSubtasks()` and `unlinkSubtasksFromEpic()` public methods |
| `src/services/KanbanProvider.ts` | Add `_syncEpicOutbound()` private method; call it from `createEpicFromPlanIds`, `assignPlansToEpic`, `promoteToEpic`; call unlink from `removeSubtaskFromEpic` |
| `.agents/skills/kanban_operations/SKILL.md` | Update sync note (remove "does NOT sync", document the parent/child linking behavior) |

---

## Key Reuse (do not reinvent)

- `LinearSyncService.syncPlan` (line 1902) — epic issue create/update (call directly, await)
- `LinearSyncService.updateIssueParent` (line 1066) — child→parent linking
- `LinearSyncService.getIssueIdForPlan` (line 1576) — look up epic's issue ID after creation
- `ClickUpSyncService.syncPlan` (line ~2540) — epic task create/update
- `ClickUpSyncService.updateTask` (line 1383) — child→parent linking (`parent` field)
- `ClickUpSyncService._findTaskByPlanId` — look up subtask's ClickUp task ID
- `KanbanDatabase.getPlanByPlanId` — look up subtask records (for `clickupTaskId`, `linearIssueId`)
- `KanbanProvider._getLinearService` / `_getClickUpService` — service accessors
- `KanbanProvider._queueClickUpSync` / `_queueLinearSync` — existing pattern reference (but NOT the calling pattern — epic sync needs await, not debounce)

---

## Complexity Audit

### Routine
- Adding two public methods to each sync service (mechanical, primitives exist)
- Wiring calls into the three KanbanProvider methods
- SKILL.md text update

### Complex / Risky
- **The create-and-wait pattern:** calling `syncPlan` directly instead of through `debouncedSync` is a new calling convention. Must verify no timer-specific assumptions in `syncPlan`. If Approach A fails, Approach B (poll) adds latency.
- **Subtask without external issue:** a subtask that has never been synced has no `linearIssueId`/`clickupTaskId`. The epic link cannot be set. Decision: skip and report in `failed`. The subtask will be linked on its next individual sync IF that sync is made epic-aware (see Edge-Case Audit). Without that, the subtask creates a flat issue with no parent — the link is lost.
- **Reparenting in `assignPlansToEpic`:** a subtask moving from epic A to epic B needs its external parent updated from A's issue to B's issue. The `assignPlansToEpic` method currently only handles "not on any epic" or "already on this epic" — it skips subtasks on a *different* epic. But if the user explicitly reassigns (via a future UI), the external parent must change. For now, the skip-and-report behavior means reparenting doesn't happen via `assignPlansToEpic` — only via remove-then-assign.
- **`promoteToEpic` sync:** the promoted plan already has an external issue. After promotion, it's an epic with no subtasks. The sync call just ensures the issue is up-to-date. No parent-linking needed until subtasks are assigned later.
- **Failure isolation:** sync failures must not roll back the local epic creation (the DB write, file write, and board refresh are already committed). Sync is best-effort with logging. The `_syncEpicOutbound` wrapper uses `Promise.allSettled` so one service failing doesn't affect the other.

---

## Edge-Case & Dependency Audit

- **Partial sync:** epic issue created, 2 of 5 subtasks linked, 3 failed (no external ID). Return `{ linked: [2], failed: [3] }`. Log a warning. Do NOT roll back the epic issue — it's a valid flat issue that just has fewer children than the local board.
- **Sync disabled:** `realTimeSyncEnabled === false` → `_syncEpicOutbound` returns immediately with `{ synced: false, reason: 'disabled' }`. The epic is created locally only. This matches the existing move-sync behavior.
- **Race with individual sync:** if a subtask's `debouncedSync` fires at the same time as the epic's `syncEpicWithSubtasks`, the subtask's sync might create/update its issue AFTER the epic tried to link it (and found no ID). The epic's `failed` list would include that subtask, but the subtask's own sync would create a flat issue with no parent. Mitigation: the next time `assignPlansToEpic` or a board refresh triggers epic sync, the now-existing subtask issue will be found and linked. Acceptable for a single-user local tool.
- **Subtask created later via individual sync:** when a subtask that's already on an epic gets synced individually (via move or content change), the individual sync creates/updates a flat issue — it does NOT set the parent. This is the **"subtask sync must be epic-aware"** sub-problem. Two options: (a) make `syncPlan` check if the plan has an `epicId` and, if so, look up the epic's external ID and set parent — this closes the loop but modifies the hot path; (b) leave it and rely on the next epic-sync to fix it. This plan proposes (a) as a follow-up — see "Related Future Work" below. For this plan, the initial epic creation and assignment are covered; individual subtask syncs remain flat.
- **`removeSubtaskFromEpic`:** must unlink the external parent. If the subtask has no external ID, the unlink is a no-op. If the external API call fails, log and continue (the local unlink already succeeded).
- **Epic deleted:** not currently supported (no delete-epic handler). If added later, it would need to unlink all children and optionally delete/close the external epic issue.

---

## Dependencies

- `agent-epic-creation.md` must be shipped (it is — commit `a9636da`).
- No new npm packages. No new external APIs.
- Linear and ClickUp integrations must be configured (`setupComplete === true`) and `realTimeSyncEnabled === true` for any sync to fire.

---

## Adversarial Synthesis

**Risk Summary:** (1) The create-and-wait pattern bypasses the debounce, which is a new calling convention — if `syncPlan` has hidden timer dependencies, it could misbehave. Mitigation: verify `syncPlan` is stateless re: the debounce timer; if not, use Approach B (poll). (2) Subtasks without an existing external issue are skipped — the link is silently lost until a future sync. Mitigation: document clearly in `failed` list; consider making individual `syncPlan` epic-aware as a follow-up. (3) The reparenting path (epic A → epic B) is not handled by `assignPlansToEpic` (which skips cross-epic subtasks) — only remove-then-assign works. Mitigation: acceptable for now; if direct reparenting is needed, extend `assignPlansToEpic` to handle it.

---

## Proposed Changes

### `src/services/LinearSyncService.ts`
- **Context:** `syncPlan` (line 1902), `updateIssueParent` (line 1066), `getIssueIdForPlan` (line 1576) are the building blocks.
- **Logic:** Add `public async syncEpicWithSubtasks(params): Promise<{ epicIssueId?: string, linked: string[], failed: string[] }>`:
  1. Check config; bail if not enabled.
  2. Map epic column → stateId; if no mapping, bail.
  3. Call `syncPlan({ planFile, topic, complexity }, epicColumn)` directly (await).
  4. Look up `epicIssueId = await this.getIssueIdForPlan(params.epicPlanFile)`. If still a `creating_*` temp marker, wait 200ms and retry once.
  5. If no `epicIssueId`, return `{ linked: [], failed: allSubtaskPlanFiles }`.
  6. For each subtask: `subIssueId = await getIssueIdForPlan(sub.planFile)`. If found, `await updateIssueParent(subIssueId, epicIssueId)` → push to `linked`. If not found, push to `failed`.
- **Logic:** Add `public async unlinkSubtasksFromEpic(planFiles: string[]): Promise<{ unlinked: string[], failed: string[] }>`:
  - For each planFile: look up issue ID, call `updateIssueParent(issueId, null)`.
- **Edge Cases:** `syncPlan` throws → catch, return `{ linked: [], failed: all }`. `updateIssueParent` throws for one subtask → catch, push to `failed`, continue.

### `src/services/ClickUpSyncService.ts`
- **Context:** `syncPlan` (line ~2540), `updateTask` (line 1383), `_findTaskByPlanId` are the building blocks.
- **Logic:** Add `public async syncEpicWithSubtasks(params): Promise<{ epicTaskId?: string, linked: string[], failed: string[] }>`:
  1. Check config; bail if not enabled.
  2. Call `syncPlan` directly (await) for the epic plan — this creates/updates the ClickUp task.
  3. Look up `epicTaskId` from the DB record (`getPlanByPlanId` → `clickupTaskId`) or `_findTaskByPlanId`.
  4. For each subtask: look up `subTaskId` from DB or `_findTaskByPlanId`. If found, `await updateTask(subTaskId, { parent: epicTaskId })` → push to `linked`. If not found, push to `failed`.
- **Logic:** Add `public async unlinkSubtasksFromEpic(planFiles: string[]): Promise<{ unlinked: string[], failed: string[] }>`:
  - For each: look up task ID, `await updateTask(taskId, { parent: '' })` (or `null` — verify ClickUp API accepts empty string vs null for parent removal).

### `src/services/KanbanProvider.ts`
- **Context:** `createEpicFromPlanIds` (the new public method), `assignPlansToEpic` (the new public method), `removeSubtaskFromEpic` (line 7872), `promoteToEpic` (line 7768).
- **Logic:** Add `private async _syncEpicOutbound(workspaceRoot, epicPlanFile, epicTopic, epicColumn, subtasks): Promise<void>`:
  1. Load both configs; check `realTimeSyncEnabled`. If neither is enabled, return.
  2. Build the subtask param array from the subtask records.
  3. `Promise.allSettled([ linear.syncEpicWithSubtasks(...), clickup.syncEpicWithSubtasks(...) ])`.
  4. Log results: `console.log('[KanbanProvider] epic sync: linear linked=X failed=Y, clickup linked=X failed=Y')`.
  5. Do NOT throw on sync failure — log only.
- **Wiring:**
  - `createEpicFromPlanIds`: after `_refreshBoard`, before `return`, call `await this._syncEpicOutbound(workspaceRoot, epicPlanFile, epicName, effectiveColumn, subtasks)`. The `await` is acceptable — the method is already async and the caller (webview or API) waits for the full creation. If sync is slow, the board refresh has already happened (it's before the sync call), so the UI is responsive.
  - `assignPlansToEpic`: after the loop and `_refreshBoard`, call `_syncEpicOutbound` with only the `assigned` subset.
  - `removeSubtaskFromEpic`: after the DB unlink and `_refreshBoard`, call `linear.unlinkSubtasksFromEpic([subtaskPlanFile])` and `clickup.unlinkSubtasksFromEpic([subtaskPlanFile])` via `Promise.allSettled`.
  - `promoteToEpic`: after `_refreshBoard`, call `_syncEpicOutbound` with the promoted plan as epic and empty subtasks array (just syncs the epic issue, no children to link).

### `.agents/skills/kanban_operations/SKILL.md`
- Replace the "no Linear/ClickUp sync" note with: "Epic creation and assignment sync the epic as a parent issue (Linear) or parent task (ClickUp) and link subtasks as children, IF real-time sync is enabled. Subtasks without an existing external issue/task are skipped — they will be linked on a future epic-sync trigger."

---

## Verification Plan

### Automated Tests
*(Skipped per session directive — the user will run the suite separately.)*

### Manual Verification
1. With Linear real-time sync enabled: create an epic via `create-epic.js` with 2 subtasks that already have Linear issues. Confirm in Linear that the subtask issues now show the epic issue as their parent.
2. With ClickUp real-time sync enabled: same test. Confirm in ClickUp that the subtask tasks now show the epic task as their parent.
3. Create an epic with 1 subtask that has an external issue and 1 that doesn't. Confirm the first is linked and the second is reported in `failed` in the console log.
4. Use `assign-to-epic.js` to add a new plan to an existing epic. Confirm the new plan's external issue/task gets parented.
5. Remove a subtask from an epic (via the webview). Confirm the external issue/task loses its parent.
6. Sync disabled (`realTimeSyncEnabled = false`): confirm epic creation succeeds locally with no external sync and no errors.
7. `promoteToEpic`: promote a plan that has a Linear issue. Confirm the issue still exists and is up-to-date (no parent set, since no subtasks yet).

---

## Related Future Work (not in this plan)

- **Epic-aware individual sync:** make `syncPlan` check if the plan has an `epicId` and, if so, set the parent on create/update. This closes the loop for subtasks that sync individually (via move or content change) after the epic was created. Without this, a subtask's individual sync creates a flat issue — the parent link set by epic-sync is overwritten or never set.
- **Inbound epic import:** when importing Linear/ClickUp issues that are parent/child, the parent should become a Switchboard epic. See the companion plans `clickup-import-epic-linking.md` and `linear-import-epic-linking.md`.

---

## Recommendation

Complexity is **7** (new calling convention for sync, multi-service fan-out, failure isolation, but all primitives exist and the trigger point is already wired). **Send to Coder** after user confirms the two review questions (failure semantics + `promoteToEpic` scope).

## Review Findings

**Reviewed:** 2026-07-03. All 4 wiring points (`createEpicFromPlanIds`, `assignPlansToEpic`, `removeSubtaskFromEpic`, `promoteToEpic`) correctly call `_syncEpicOutbound` or `unlinkSubtasksFromEpic` after `_refreshBoard`. Both `syncEpicWithSubtasks` methods implement the create-then-link pattern with proper config guards, `creating_*` retry, per-subtask error isolation, and best-effort `Promise.allSettled` fan-out. SKILL.md updated. **MAJOR finding:** ClickUp's `unlinkSubtasksFromEpic` uses `parent: ''` but the ClickUp v2 API explicitly does not support parent removal via Update Task ("You cannot convert a subtask to a task by setting parent to null") — the unlink will fail or no-op; added a documenting comment at `ClickUpSyncService.ts:3290`. Linear's `unlinkSubtasksFromEpic` uses GraphQL `issueUpdate` with `parentId: null` which is supported. Reparenting via `assignPlansToEpic` is not implemented (skips cross-epic subtasks) — explicitly acceptable per plan. No compilation/tests run per session directives. **Remaining risk:** ClickUp external unlink is non-functional (API limitation); local DB unlink still works correctly.
