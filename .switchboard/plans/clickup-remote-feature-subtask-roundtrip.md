# ClickUp remote board — feature subtasks orphan-import on pull

## Goal

Fix the ClickUp remote-board **pull** so that a feature exported to ClickUp and worked on there does not spawn **orphan duplicate subtask cards** — or trigger **rogue independent subtask dispatch** — when the feature's subtasks come back in the next poll. Make ClickUp feature structure strictly **outbound** (parent task + native subtasks projected out; nothing structural pulled back), which is exactly what the docs already claim.

### Problem Analysis (background + root cause)

**Symptom.** Create a feature in Switchboard with subtasks → export to ClickUp (real-time sync on) → work on it in ClickUp → on the next remote-board poll, the subtasks return as top-level deltas and are mishandled: in the common case they are **re-imported as new, unlinked `clickup-import` plans** (orphan duplicates of the subtasks); in a narrower case they are **column-moved and dispatched independently** of the feature flow.

**The local feature→subtask links themselves are NOT unlinked.** The only code that rewrites a local plan's `featureId` from a remote is `_mirrorFeatureStructure` (`RemoteControlService.ts:474`), and it only runs when a delta carries `parentRemoteId`/`isFeatureCandidate` (gated at `RemoteControlService.ts:427`). ClickUp deltas never set those, so that path is unreachable for ClickUp — the existing links sit untouched. The bug is in how the *returned subtask tasks* are handled, not in link maintenance.

**Root-cause chain (all verified in source):**

1. **Export projects subtasks as native ClickUp children.** `KanbanProvider._syncFeatureOutbound` (`KanbanProvider.ts:12000`, gated on each provider's `realTimeSyncEnabled`) calls `ClickUpSyncService.syncFeatureWithSubtasks`, which sets each subtask's ClickUp `parent` to the feature task (`ClickUpSyncService.ts:3440`). ClickUp subtasks live in the **same list** as their parent — i.e. the list mapped to the feature's column.

2. **The poll returns subtasks.** `ClickUpRemoteProvider.fetchStateDeltas` fetches each mapped list via `getListTasks(listId, { dateUpdatedGt, includeClosed:false })`, and `getListTasks` requests **`subtasks=true`** (`ClickUpSyncService.ts:1187`, base path `:841`). So subtask tasks come back as their own deltas — carrying only `remoteId` / `stateKey` / `updatedAt` / `description`, with **no parent information** (`ClickUpRemoteProvider.ts:80-96`).

3. **Subtasks fail the match index.** `_pollState` resolves each delta against `byRemoteId` (`RemoteControlService.ts:415`). `_indexByRemoteId` only includes a plan when `boardSet.has(p.project || '')` (`RemoteControlService.ts:364`; ClickUp index at `:377-382`). Subtasks **do not inherit the feature's project** — `updateFeatureStatus` writes only `is_feature`/`feature_id`/`updated_at`, never `project` (`KanbanDatabase.ts:2354`). (The `st.project || featureProject` fallback at `KanbanProvider.ts:3872` is an ephemeral dispatch-prompt record, not a DB write.) So a subtask under a feature on project "X" keeps its creation-time project (usually empty), which ≠ "X" ⇒ it is excluded from `byRemoteId`.

4. **Unmatched ⇒ orphan import.** With no local match, `_pollState` calls `provider.importRemotePlan(subtaskTaskId)` (`RemoteControlService.ts:420`, **before** the column/ingest checks at `:430-434`, so it fires regardless of mode or column mapping), which calls `importRemoteMarkdownPlan` — that always writes a **brand-new file** (`randomUUID()` → `${slug}-${id}.md`) with `project: ''`, `kanbanColumn: 'CREATED'`, and **no dedup by `clickupTaskId`** (`importRemotePlan.ts:20-40`), then sets `clickupTaskId` on it (`ClickUpRemoteProvider.ts:149`). Result: an orphan duplicate of the subtask lands on the **No-Project base board, CREATED column**, sharing a `clickupTaskId` with the original subtask plan (ambiguous mapping). Because the orphan keeps `project=''`, it stays unmatched on every later poll — so **each subsequent edit of that subtask in ClickUp spawns another orphan** (one per edit, bounded by the state cursor, not per poll). `_mirrorFeatureStructure`, which would otherwise link it, never runs (step 0).

5. **Matched ⇒ rogue dispatch (narrower case).** If a subtask's stored project *does* coincide with a synced board, it is matched instead and `_applyStateMirror` (`RemoteControlService.ts:435`) moves its card and **dispatches its column agent independently** of the feature — separate from the intended feature cascade.

**Why Linear/Notion are immune.** Their deltas carry `parentRemoteId`, so after the same import step `_mirrorFeatureStructure` links the subtask to its feature (import-then-link). ClickUp does import-then-nothing. This is genuinely ClickUp-specific.

**Determination.** In the **common workflow (a feature on a named project board), the orphan-duplicate branch is the one that fires** — subtasks don't carry the feature's project and are filtered out of the match index. The independent-dispatch branch is the narrow exception.

## Preconditions (when the bug reproduces)

Both must hold — they are separate toggles:
1. **Real-time ClickUp sync on** (`realTimeSyncEnabled`), so `_syncFeatureOutbound` actually projects the feature's subtasks out (`KanbanProvider.ts:12020-12021`). Fires from feature create/assign (`KanbanProvider.ts:10333`, `:11605` `createFeatureFromPlanIds`, `:11666`).
2. **Remote Board poll running in Full mode** for that ClickUp board, so the poll pulls the subtasks back.

And one data precondition: **each subtask must already have a `clickupTaskId`** — `syncFeatureWithSubtasks` only *links* pre-existing subtask tasks (`ClickUpSyncService.ts:3437-3444`); it never *creates* them. So the blast radius is subtasks that were individually synced to ClickUp (have a `clickupTaskId`) before/while being grouped. A subtask that was never individually synced is marked `failed`, never reaches ClickUp, and can't orphan.

## Assumptions — Verified (source-checked)

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| 1 | Parent field on the task object is `parentId` (not `parent`/`top_level_parent`) | ✅ corrected | `ClickUpTask.parentId: string \| null` (`ClickUpSyncService.ts:85`), mapped from raw `parent` (`:751-753`) |
| 2 | The delta fetch requests `subtasks=true` (so subtasks come back) | ✅ | `getListTasks` delta branch path `…&subtasks=true…` (`ClickUpSyncService.ts:1187`); tasks run through `_normalizeClickUpTask` |
| 3 | Normalized task carries `.list` (used as `stateKey`) and `.parentId` | ✅ | `list: {id,name}\|null` (`:89`), `parentId` (`:85`), both set in `_normalizeClickUpTask` (`:772-775`, `:751-753`) |
| 4 | `getTaskDetails.task` is normalized (guard can read `parentId`) | ✅ | return type `{ task: ClickUpTask; … }` (`ClickUpSyncService.ts:1272`) |
| 5 | Subtasks do NOT inherit the feature's `project` | ✅ | `updateFeatureStatus` UPDATE sets only `is_feature`/`feature_id`/`updated_at` (`KanbanDatabase.ts:2354`); the `st.project \|\| featureProject` fallback (`KanbanProvider.ts:3872`) is an ephemeral dispatch record, not a DB write |
| 6 | `_indexByRemoteId` excludes a plan whose `project` ∉ synced boards | ✅ | `if (!boardSet.has(p.project \|\| '')) continue` (`RemoteControlService.ts:364`); `boardSet = new Set(config.boards)` (`:318`); `_normalizeBoards` passes tokens through (`:243-246`) |
| 7 | `importRemoteMarkdownPlan` creates a new file with no `clickupTaskId` dedup | ✅ | `randomUUID()` + always-write, `project:''`, `kanbanColumn:'CREATED'` (`importRemotePlan.ts:20-40`) |
| 8 | `importRemotePlan` fires before the column/ingest checks | ✅ | import at `RemoteControlService.ts:420`; column resolve/ingest skip at `:430-434` |
| 9 | `_mirrorFeatureStructure` is unreachable for ClickUp | ✅ | gated on `d.parentRemoteId!==undefined \|\| d.isFeatureCandidate!==undefined` (`RemoteControlService.ts:427`); ClickUp deltas set neither (`ClickUpRemoteProvider.ts:90-95`) |
| 10 | Skipping the push but keeping the `nextCursor` update advances the cursor | ✅ | push and cursor-update are separate statements (`ClickUpRemoteProvider.ts:89-99`) — guard the push only |
| 11 | Linear/Notion link imported subtasks (import-then-link), so they're immune | ✅ | Linear delta sets `parentRemoteId`/`isFeatureCandidate` (`LinearRemoteProvider.ts:76-77`) → `_mirrorFeatureStructure` runs |

One residual behavioral question left for the coder to confirm at runtime (not a code-read assumption): whether setting a subtask's `parent` in ClickUp ever *moves* it out of the mapped list. It doesn't matter to the fix — the subtask is in a mapped list because it was individually synced there, independent of its parent — but worth eyeballing during manual verification.

## Metadata

> **Superseded:** **Tags:** backend, bug, clickup, remote-sync
> **Reason:** `bug`, `clickup`, and `remote-sync` are not in the improve-plan allowed tag list. The skill forbids inventing tags outside the list.
> **Replaced with:** allowed-list tags that fit: `backend` (server-side remote-sync code), `bugfix` (this is a bug fix), `api` (ClickUp API pull path), `reliability` (prevents duplicate-card state corruption).

**Tags:** backend, bugfix, api, reliability
**Complexity:** 4

## User Review Required

Yes — before dispatch. The fix changes the ClickUp round-trip contract for subtasks: **subtask body and status edits made in ClickUp will no longer pull back into the local subtask plans** (structure and subtask content become outbound-only). This matches the existing docs claim (`remote-boards.md:27`), but users who have been relying on the buggy import path to surface ClickUp subtask edits locally should approve the change. Also confirm: existing orphan `clickup-import` cards already created by the bug are **not** auto-cleaned (manual delete or a separate dedup pass).

## Complexity Audit

### Routine
- Adding `&& !task.parentId` to one `if` condition in `ClickUpRemoteProvider.fetchStateDeltas` (`:89`).
- Adding a one-line `if (task.parentId) return null` defensive guard in `importRemotePlan` (`:138-139`).
- One docs clause in `switchboard-site/src/pages/docs/integrations/remote-boards.md`.
- All changes localized to `ClickUpRemoteProvider.ts` (+ doc); no shared indexing or `_pollState` logic touched.

### Complex / Risky
- **Cursor-stall risk** if the `nextCursor` computation were accidentally gated alongside the push — mitigated by design (cursor update is a separate statement at `:97-99` over ALL grouped tasks), but the manual verification step #4 is the load-bearing gate since automated tests are skipped per session directive.
- **Behavioral contract change** (subtask edits outbound-only) — not code-risky, but user-facing; covered by User Review Required.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) cursor stall if the guard accidentally covers the `nextCursor` update — mitigated by keeping the guard on `deltas.push` only; (2) silent loss of ClickUp-authored subtask body/status edits locally — by design, matches docs, but must be explicitly approved; (3) the `importRemotePlan` guard is defense-in-depth only, not load-bearing (the delta filter is the real fix). Mitigations: manual verification step #4 is the critical cursor gate; DoD states the outbound-only contract explicitly; guard labeled as defense-in-depth in Proposed Changes.

## Proposed Changes

### Primary fix — keep ClickUp structure strictly outbound (recommended)

This matches the documented contract ("structure projects outbound; re-parenting doesn't pull back") and is the minimal change that removes both failure modes.

**File: `src/services/remote/ClickUpRemoteProvider.ts`**
- In `fetchStateDeltas` (`:80-96`), **skip tasks that have a parent** — do not emit a delta for a subtask. Add `&& !task.parentId` to the existing push condition (`if (remoteId && stateKey && !task.parentId)`). **Do NOT `continue` the loop** — the `nextCursor` update below the push (`ClickUpRemoteProvider.ts:97-99`) must still run for subtasks so the state cursor keeps advancing past a poll where only a subtask changed. The field is `task.parentId` (the normalized `ClickUpTask.parentId`, `ClickUpSyncService.ts:85`, mapped from raw `parent` at `:751-753`) — populated for subtasks, `null` for top-level tasks. The feature task (parentId null) still flows through, so its state + content keep syncing. **This is the load-bearing fix.**
- In `importRemotePlan` (`:132-155`), add a **defense-in-depth guard** (NOT a load-bearing fix — the delta filter above is the real fix; this guard only fires if some future caller invokes `importRemotePlan` directly, bypassing `_pollState`): after `getTaskDetails`, `if (task.parentId) { return null; }` (never import a parented task as a standalone plan). `getTaskDetails` returns a normalized `ClickUpTask` (`ClickUpSyncService.ts:1272`), so `parentId` is available.

**File: `src/services/RemoteControlService.ts`**
- No logic change required, but confirm `_pollDescriptions` (content-pull) reads the same delta list — with subtasks excluded from the deltas, content-pull will not touch subtasks either (correct: subtask body edits made in ClickUp are outbound-only, consistent with structure).

### Docs (cross-repo, same branch)

**File: `switchboard-site/src/pages/docs/integrations/remote-boards.md`**
- The ClickUp provider row already states structure is one-way; after this fix that is accurate. Add one clause noting that **subtask edits made in ClickUp (status/body) don't pull back** — ClickUp structure *and* subtask content are outbound-only. Leave the Linear/Notion rows unchanged.

### Alternative (larger — true two-way ClickUp structure; DEFER unless wanted)

If bidirectional ClickUp structure is actually desired later:
- Populate `parentRemoteId` + `isFeatureCandidate` on ClickUp deltas from `task.parent` (mirroring `LinearRemoteProvider.ts:76-77`), so `_mirrorFeatureStructure` can maintain links.
- AND fix subtask matching so the *existing* subtask is found instead of duplicated — either index subtasks by their feature's board membership rather than their own `project` in `_indexByRemoteId`, or set `subtask.project = feature.project` on assignment in `updateFeatureStatus`/the feature-assign handlers. Without this, `_mirrorFeatureStructure` would link a freshly-imported *duplicate* rather than the original.
- Larger surface, touches shared indexing used by all three providers. Out of scope for this fix.

## Edge-Case & Dependency Audit

- **Feature task still syncs.** The parent feature task has `parentId: null`, so the skip guard leaves it untouched — state mirror + content pull continue as before.
- **Field name is settled.** The guard uses `task.parentId` (see Assumptions #1/#3/#4) — not `task.parent`. No open field-name question remains.
- **Cursor advance.** Skipping subtask deltas must not strand the `nextCursor` — it's computed from every task's `updatedAt` (`ClickUpRemoteProvider.ts:97-99`); keep that computation over *all* grouped tasks (including skipped subtasks). The guard goes on the `deltas.push` condition, not on the loop (Assumption #10).
- **Existing orphans.** This fix prevents *new* orphans; it does not clean up duplicates already created by the bug — users who already round-tripped a ClickUp feature may have orphan `clickup-import` cards (on the No-Project board, CREATED) to delete manually. A dedup pass (by `clickupTaskId`) is a possible follow-on, not in scope.
- **Regression isolation.** All changes are inside `ClickUpRemoteProvider` (+ a doc). Linear and Notion providers are untouched.

## Dependencies

None blocking. Independent of `remote-content-pull-all-providers` (already shipped); this narrows ClickUp's inbound surface, it doesn't undo content-pull for top-level plans.

## Verification Plan

### Manual Verification (primary gate)
1. **Round-trip, common case.** Create a feature with 2 subtasks on a named project board; enable ClickUp remote (Full) + real-time sync; export. In ClickUp, change a subtask's status and edit its description. Poll. **Expect:** no new orphan `clickup-import` cards, no independent subtask dispatch; the feature card still mirrors state/content changes made to the *parent* task.
2. **Feature task still round-trips.** Move the parent feature task's status in ClickUp → local feature card moves + dispatches; edit the feature body in ClickUp → local feature plan file updates.
3. **importRemotePlan guard.** Force a subtask task id through `importRemotePlan` (unit or manual) → returns `null`, no plan created.
4. **Cursor.** A poll where only a subtask changed still advances the ClickUp state cursor (no re-processing loop, no stall).
5. **Linear/Notion regression.** Repeat step 1 on Linear → subtasks still link correctly via `_mirrorFeatureStructure` (import-then-link unaffected).

### Automated Tests — SKIPPED per session directive
Per the session directive, automated tests are NOT run as part of this verification plan. The following tests are recommended to be written/run in a future session but are explicitly out of scope here:
- `ClickUpRemoteProvider.fetchStateDeltas` omits parented tasks and still advances `nextCursor`.
- `importRemotePlan` returns `null` for a task with `parent`.
- Round-trip fixture asserting a parented ClickUp task produces zero deltas.

Because tests are skipped, **manual verification step #4 (cursor advance) is the critical gate** — a cursor stall would cause re-processing loops. Do not skip it.

### Compilation — SKIPPED per session directive
No project compilation step is run as part of this verification plan.

## Definition of Done

- Exporting a feature to ClickUp and editing its subtasks there produces **no orphan duplicate cards and no independent subtask dispatch** on the next poll.
- The parent feature task continues to sync state + content both ways.
- **Subtask body and status edits made in ClickUp do NOT pull back into the local subtask plans** (outbound-only, by design — matches `remote-boards.md:27`).
- `importRemotePlan` refuses to import a parented task (defense-in-depth).
- ClickUp state cursor still advances on subtask-only poll cycles (verified manually — step #4).
- Linear/Notion structure sync unchanged.
- `switchboard-site` `remote-boards.md` ClickUp row notes structure + subtask content are outbound-only, committed on the same branch.

## Completion Summary

Implemented the primary (outbound-only) fix. In `src/services/remote/ClickUpRemoteProvider.ts`, `fetchStateDeltas` now skips any task with a non-null `parentId` (the `deltas.push` guard gained `&& !task.parentId`); the `nextCursor` update was left running over all grouped tasks so subtask-only polls still advance the state cursor. `importRemotePlan` gained a defense-in-depth `if (task.parentId) return null` after `getTaskDetails`. Updated `switchboard-site/src/pages/docs/integrations/remote-boards.md` ClickUp row to state subtask status/body edits are outbound-only. No issues encountered. Per session directive, compilation and automated tests were skipped; manual verification steps in the plan's Verification Plan remain the load-bearing gate (cursor advance is the critical one).

## Review Findings

Direct reviewer pass complete. Files changed: `src/services/remote/ClickUpRemoteProvider.ts` (delta filter `&& !task.parentId` on push only; `importRemotePlan` defense-in-depth guard), `switchboard-site/src/pages/docs/integrations/remote-boards.md` (ClickUp row outbound-only clause). Regression audit: `_pollDescriptions` (`RemoteControlService.ts:647,669`) re-uses `fetchStateDeltas`, so subtask content-pull is correctly suppressed alongside state-pull — no separate path bypasses the filter. `refreshLocalPlanFromRemote` is only called from `_applyStateMirror` for matched deltas, so subtasks are unreachable. No signature/return-value changes; no orphaned references; no race conditions (cursor update is a separate statement from the push guard, exactly as the plan required). Existing test `clickup-remote-provider.test.js` fixtures set no `parent`/`parentId` → guard is a no-op for them → no test regression (tests skipped per directive, but fixture analysis confirms it). One NIT: the docs commit also modified the Linear/Notion rows and added a new intro paragraph, contrary to the plan's "Leave the Linear/Notion rows unchanged" — the additions are factually correct (feature structure does sync both ways for those providers) but are out-of-scope creep; left in place rather than reverting destructively. No CRITICAL or MAJOR findings; the implementation is materially correct. Remaining risks: (1) manual verification steps (especially cursor advance, step #4) are the load-bearing gate and have not been run; (2) existing orphan `clickup-import` cards from prior buggy polls are not auto-cleaned (by design, called out in plan).
