# Remote Sync Refactor (2/3): Notion Push Pipeline (Status + Content Write-Back)

## Goal

Give **Notion** a real push pipeline so it becomes a genuinely bidirectional remote, implementing `pushState` / `pushContent` behind the provider abstraction introduced in plan 1, and re-proving the echo-loop guards for Notion. This closes the **one real provider gap** in the remote/sync system.

### Core problem & background

Notion is the marquee *agent control surface* (claude.ai + the Notion MCP connector): the remote Claude session is meant to drive plan status and write results back. But today **Notion is pull-only** (full analysis: `docs/remote_sync_architecture_refactor_analysis.md`).

- `RemoteControlService` pulls Notion state/comments fine via `NotionRemoteProvider`.
- But neither push pipeline touches Notion: `ContinuousSyncService` only pushes to ClickUp + Linear (`src/services/ContinuousSyncService.ts:874`/`:847`), and the column-move status push (`KanbanProvider._queueLinearSync`/`_queueClickUpSync`) has no Notion path.
- The capability to write a Notion page body **already exists** — `NotionFetchService.updatePageContent` (`src/services/NotionFetchService.ts:631`) — but its **only caller is `ResearchImportService.ts:240`**, a one-off import path. It is wired into nothing.
- The only write-back Notion remote control performs is `postComment` (dispatch acks).

So the user's own code-automation loop silently half-works: the steps "Switchboard uses the Notion API to change status to Coded" and "update the description" **do not exist for Notion today**.

### Root cause

When push was built it targeted the legacy issue trackers (Linear, then ClickUp). Notion arrived later, only on the pull side, and its write capability (`updatePageContent`) was added for an unrelated import feature and never connected to sync. There is no Notion status-property write at all.

## Metadata

- **Tags:** [backend, api, feature, reliability]
- **Complexity:** 6
- **Repo:** switchboard

## Scope (base level)

1. **Implement `pushContent` for `NotionRemoteProvider`** by wiring the existing `NotionFetchService.updatePageContent` into the content path created in plan 1.
2. **Implement `pushState` for Notion** — add a status-property write. Requires confirming the Notion remote setup exposes a **writable status property** and defining the **column→status mapping** (the Linear analogue is `columnToStateId`).
3. **Flip Notion's declared capability** to `push: true`.
4. **Re-prove the echo-loop guards for Notion** (`RemoteControlService.ts:18–29`). Linear is already bidirectional, so the round trip (push state → bumped remote timestamp → inbound delta) and the column-equality echo guard are battle-tested there. Notion gaining push-state is the **new** exposure: its `fetchStateDeltas` will now see its own pushes echo back. The column-equality guard is provider-agnostic and should hold, but must be verified against Notion's minute-rounded `last_edited_time` (the same rounding the comment seen-set already defends against).

## Non-goals

- **No config consolidation or Remote-tab UI** (plan 3).
- **No changes to Linear/ClickUp push** beyond what plan 1 relocated.

## Dependencies

- **Plan 1** (provider capabilities + unified push dispatch) — required. `pushState`/`pushContent` and the provider registry must exist first.

## Open items to resolve during `/improve-plan`

- Confirm a writable Notion status property exists in the remote setup and define the column→status map.
- Decide content-write strategy in `updatePageContent` (it currently deletes-and-reappends blocks — verify idempotency under repeated pushes).

## Source

Derived from `docs/remote_sync_architecture_refactor_analysis.md` (Sequencing → Plan 2; open questions #2, #4). Base-level plan — run `/improve-plan` to deepen before execution.
