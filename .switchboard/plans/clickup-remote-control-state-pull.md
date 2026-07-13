# Promote ClickUp to a State-Pull Remote Control Provider

## Goal

Make ClickUp a first-class **remote control** provider alongside Linear and Notion, limited to **state pull**: moving a ClickUp task to a different mapped list triggers the local column agent for that column — exactly as moving a Linear issue's state or a Notion page's `Kanban Column` does today. Comment-bus (two-way conversation) is explicitly **out of scope**.

### Problem / background / root cause

ClickUp is currently excluded from remote control **by deliberate design, not by architectural limitation.** `src/services/remote/ClickUpRemoteProvider.ts` already implements the `RemoteProvider` interface but declares `capabilities.pull = false` and stubs every pull method, with a header comment stating "ClickUp is NOT a remote-control (pull) provider. It stays a push-only stakeholder-visibility mirror."

That design line was drawn primarily around the **comment message-bus**: ClickUp comments are per-task (`GET /task/{id}/comment`) with no workspace-wide "comments since cursor" feed, so a Linear/Notion-style comment stream would require rate-limit-expensive per-task polling. **State pull has no such problem** — it needs only a cheap per-list delta query, which the codebase already supports.

Motivation for closing the gap: ClickUp offers a free AI agent and no active-task limit, making it an attractive tracker to drive Switchboard from remotely. Users reasonably expect the same "move a card → the local agent runs" capability they get from Linear and Notion.

### Why this is tractable (evidence)

- **The poll loop is provider-agnostic.** `RemoteControlService._pollState` (`src/services/RemoteControlService.ts:383`) never branches on `kind` — it calls `provider.fetchStateDeltas`, then imports/mirrors/dispatches generically. `RemoteProviderKind` already includes `'clickup'` (`RemoteControlService.ts:38`); `_normalizeProviderKind` already accepts it (`:219`); cursors are keyed per-kind (`:90-92`).
- **Delta polling already exists.** `ClickUpSyncService`'s list-fetch already emits `&date_updated_gt=<epoch_ms>&order_by=updated` when passed `dateUpdatedGt` (`ClickUpSyncService.ts:1184`). One cheap query per mapped list per cycle.
- **The UI self-wires from capabilities.** The provider dropdown already lists ClickUp (`src/webview/setup.html:1426`), and `applyRemoteProviderUi()` (`setup.html:5390`) enables the "full/pull" mode radio purely from `_remoteCapabilities.pull`. `setRemoteConfig`/`renderRemoteConfig` already round-trip `provider === 'clickup'` (`setup.html:5466`, `:5493`). Flip the capability → the UI lights up with no new controls.
- **A clean template exists.** `src/services/remote/LinearRemoteProvider.ts` (~300 lines) is the reference implementation for a pull provider, including the shared `importRemoteMarkdownPlan` helper.

### Key design fact: ClickUp column == list

Linear maps a column → a workflow **state** in one project; Notion maps a column → a `Kanban Column` **property value** on a page. **ClickUp maps a column → a whole separate list** inside a folder: `_ensureColumnMappings` (`ClickUpSyncService.ts:457`) creates one list per column and stores `columnMappings: { column → listId }`. A plan's column is therefore expressed by *which list its task lives in*. The remote gesture that changes a plan's column is **moving the task to a different mapped list** — and the push side already performs this exact move (`syncPlan`, `ClickUpSyncService.ts:2931`), so the model is symmetric and already proven in this codebase.

Consequently, for ClickUp: `stateKey = task.list.id`, and `stateKeyToColumn` is the inverse of `columnMappings`.

## Non-goals

- **No comment bus.** `fetchCommentDeltas` and `postComment` stay no-op stubs. No two-way conversation, no comment polling, no dispatch-ack comment (see rationale below).
- **No feature/subtask structure mirroring** (parent/children). Possible later via ClickUp's `parent` field, but not required for state pull; leave `parentRemoteId`/`isFeatureCandidate` undefined.
- **No project-context push or archive** for ClickUp — remain skipped (`pushProjectContext`/`archiveCard` keep returning `{ ok: true, skipped: true }`).
- **No push-path changes.** ClickUp's existing outbound status mirror (ContinuousSyncService) is untouched.

### Why no dispatch-ack comment

The ack comment in `_applyStateMirror` (`RemoteControlService.ts:449`) exists so a remote operator who *cannot see the local board* learns their move was received. It is not needed for ClickUp because:
1. It is not load-bearing — the call is `.catch()`-guarded and gated on `dispatched`; state pull works fully without it.
2. ClickUp is already a **push** provider, so when the local agent advances the card, that advancement is pushed back out as a **list move** — the operator watches the task land in the next list, a more reliable ack than a comment, for free.
3. Skipping it avoids wiring `postComment` and the comment-marker/`authoredBySelf` stamping machinery that only matters when comments are polled (which they are not, here).

## Implementation

### 1. `src/services/remote/ClickUpRemoteProvider.ts` — implement pull

- Flip capabilities: `{ pull: true, push: true, projectContextPush: false, archive: false }`. Update the header comment to reflect state-pull support (drop the "NOT a remote-control provider" language; note comment-bus remains unsupported).
- Cache a `_listIdToColumn: Record<string, string>` built from `ClickUpSyncService`'s loaded config `columnMappings` (invert `{column→listId}` to `{listId→column}`), rebuilt at the start of each `fetchStateDeltas` (mirrors `LinearRemoteProvider`'s `_stateIdToColumn` pattern, `LinearRemoteProvider.ts:44`).
- **`fetchStateDeltas(sinceCursor)`**:
  - Cursor is an ISO timestamp we mint (consistent with Linear/Notion). Convert to epoch-ms for ClickUp's `date_updated_gt`.
  - For each mapped `listId` in `columnMappings`, call the existing delta-capable list fetch with `{ dateUpdatedGt: <ms>, includeClosed: false }`.
  - For each returned task: `remoteId = task.id`, `stateKey = task.list.id` (the list it now lives in), `updatedAt = ISO(task.date_updated)`, `description = task markdown description` (already fetched via `include_markdown_description=true`).
  - `nextCursor = max(updatedAt seen, sinceCursor)`.
  - Dedup tasks that appear across multiple mapped lists by `task.id` (keep the latest `date_updated`).
- **`stateKeyToColumn(listId)`** → `this._listIdToColumn[listId]`.
- **`refreshLocalPlanFromRemote(remoteId)`**: find the local plan by `clickupTaskId`, fetch `getTaskDetails(remoteId)`, render `# <name>\n\n<markdown description>`, write to `plan.planFile` (never clobber with empty — mirror `LinearRemoteProvider.ts:126`).
- **`importRemotePlan(remoteId)`**: `getTaskDetails(remoteId)` → `importRemoteMarkdownPlan({ ..., sourceType: 'clickup-import' })` → `db.updateClickUpTaskIdByPlanFile(rec.planFile, workspaceId, remoteId)` → return the linked record (mirror `LinearRemoteProvider.ts:143`).
- Leave `fetchCommentDeltas`, `postComment` as no-op stubs; leave `pushState`/`pushContent`/`pushProjectContext`/`archiveCard` unchanged.

### 2. `src/services/KanbanDatabase.ts` — lookup helper (parity)

- Add `findPlanByClickUpTaskId(workspaceId, clickupTaskId)` mirroring `findPlanByLinearIssueId` (`:4261`). `updateClickUpTaskIdByPlanFile` already exists (`:2821`). Use the finder in `refreshLocalPlanFromRemote` instead of scanning `getAllPlans` (the current `pushState` scan can also be migrated to it, optional).

### 3. UI cosmetics — `src/webview/setup.html`

- Change the dropdown option label `ClickUp (push-only)` → `ClickUp` (`:1426`).
- In `applyRemoteProviderUi`, drop the `provider === 'clickup' ? 'Remote Control (ClickUp — push only)'` special-case title (`:5398`) so it reads `Remote Control (ClickUp)`.
- No logic change needed — capability-driven enablement already works once the provider reports `pull: true`.

### 4. Docs — `.agents/workflows/switchboard-remote.md`

- Update the description and body ("Plans live in Linear or Notion") to include ClickUp for state pull. Add a short ClickUp subsection: the operator moves a task **between the folder's mapped lists** to change its column and trigger the local agent; comment-driven conversation is not supported for ClickUp (state changes only). Note new tasks created in a mapped list are imported as new local plans on the next poll (via `importRemotePlan`).

### 5. Tests

- Add `src/test/integrations/clickup/clickup-remote-provider.test.js` mirroring `notion-remote-provider.test.js`:
  - `fetchStateDeltas` returns `{remoteId, stateKey=listId, updatedAt}` per changed task; `nextCursor` advances to the max `date_updated`; dedup across lists.
  - `stateKeyToColumn` inverts `columnMappings`; unmapped listId → `undefined`.
  - `importRemotePlan` writes a plan file and links `clickupTaskId`.
  - `refreshLocalPlanFromRemote` never clobbers with empty.
  - Capabilities: `pull === true`.
- **Echo-guard regression** (the one behavior to prove explicitly): an outbound list-move performed by the push path bumps `date_updated` and resurfaces as an inbound state delta; assert `_applyStateMirror`'s guard (`targetColumn === plan.kanbanColumn → no-op`, `RemoteControlService.ts:438`) prevents re-dispatch. Cover in a `RemoteControlService` test with a fake ClickUp provider.

## Risks / edge cases

- **Self-echo from the existing push mirror.** ClickUp is already push-active; our own list-move re-appears as a delta. Mitigated by the existing column-equality echo guard; covered by the regression test above. This is the highest-value thing to verify.
- **Cross-list task membership.** ClickUp's tasks-in-multiple-lists feature can place one task in several mapped lists. Resolve `stateKey` from `task.list.id` (home list) and dedup by task id; document that Switchboard treats the home list as authoritative.
- **Seed-on-first-poll.** The generic `_pollState` baselines the cursor to "now" on first run (`RemoteControlService.ts:391`), so enabling ClickUp pull will not replay existing task history as a burst of dispatches — no ClickUp-specific handling needed.
- **Rate limits.** State pull is one delta query per mapped list per cycle — well within ClickUp's limits (the `clickup-rate-limiting.test.js` concern was comment/full-scan traffic, which this avoids).
- **Unmapped columns.** If a task sits in a list not present in `columnMappings`, `stateKeyToColumn` returns `undefined` and `_pollState` skips it (`:417`) — correct no-op.
- **Migration.** No shipped state changes shape; this only flips a capability and adds methods/helpers. `remote.config` already tolerates `provider: 'clickup'`, so no config migration is required.

## Metadata

**Complexity:** 5
**Tags:** backend, api, feature, integration, reliability
