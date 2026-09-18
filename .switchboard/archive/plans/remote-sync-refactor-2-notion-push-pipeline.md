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

## User Review Required

Yes — two design decisions need review:

1. **Destructive content write**: `NotionFetchService.updatePageContent` (`:631`) uses a **delete-all-blocks-then-reappend** strategy. Any content added directly to the Notion page outside Switchboard (by the agent via MCP, or by a human) will be **wiped** on the next content push. This is the existing behavior of `updatePageContent` (already used by `ResearchImportService`), but applying it to the sync loop makes it fire on every plan file save. Confirm this is acceptable, or whether the push should be additive/merge-based instead.

2. **Status property target**: The Notion state property is the **`Kanban Column`** select (not a separate "Status" property). `stateKeyToColumn` (`NotionRemoteProvider.ts:138`) is an identity mapping — the select option name IS the column name. `pushState` will write this select via `PATCH /pages/{pageId}` with `{ properties: { 'Kanban Column': { select: { name: columnName } } } }`. This is the same pattern `NotionBackupService` uses at `:418`. Confirm the `Kanban Column` select is the correct target (the analysis doc's decision D2 confirms this).

## Complexity Audit

### Routine
- Wiring `NotionFetchService.updatePageContent` into `NotionRemoteProvider.pushContent` — the method already exists (`:631`), just needs a new caller
- Flipping Notion's `capabilities.push` from `false` to `true` (one-line change on the provider class)
- Adding the `PATCH /pages/{pageId}` status-property write — the HTTP pattern already exists in `NotionBackupService.ts:418` and `NotionFetchService.httpRequest` (`:76`) supports `PATCH`

### Complex / Risky
- **Echo-loop verification for Notion's new round trip**: Notion's `fetchStateDeltas` (`NotionRemoteProvider.ts:85`) queries by `last_edited_time` with an inclusive `on_or_after` cursor (`:66`). When `pushState` writes the `Kanban Column` select, `last_edited_time` bumps → next poll re-fetches the page → state delta has the same column → echo guard no-ops. But `last_edited_time` rounds to the minute, so the boundary-minute items re-appear. The column-equality guard handles this, but must be verified end-to-end.
- **Content push → state delta interaction**: When `pushContent` writes page blocks via `updatePageContent`, `last_edited_time` also bumps. The next poll's `fetchStateDeltas` will see the page as changed, but the `Kanban Column` select hasn't changed → `stateKey` is the same → echo guard no-ops. This is safe, but is a new interaction that didn't exist before (Notion was pull-only, so no push ever bumped its timestamp).
- **Select option existence**: If a new Kanban column was added locally after Notion remote setup, the `Kanban Column` select may not have an option for it. `setupRemoteControl` extends options via `_ensureColumnSelectOptions` (`NotionBackupService.ts:349-365`), but this only runs during setup. `pushState` must handle a missing select option gracefully (skip + log, or ensure the option exists first).
- **`refreshLocalPlanFromRemote` + file watcher loop risk**: `_applyStateMirror` calls `provider.refreshLocalPlanFromRemote` (`RemoteControlService.ts:299`) which writes the remote body to the local plan file. If the file watcher sees this write, it triggers `ContinuousSyncService` → `pushContent` → writes to remote → bumps timestamp → next poll sees state delta → column matches → no-op. The loop is broken by the column-equality guard, but the content push → timestamp bump → state delta path is new for Notion and must be verified.

## Edge-Case & Dependency Audit

### Race Conditions
- **Push + concurrent poll**: A column move triggers `pushState` (writes `Kanban Column` select) while `_poll()` is mid-`fetchStateDeltas`. The poll may or may not see the pushed state in this cycle. If it does, the echo guard no-ops. If it doesn't, the next poll sees it and no-ops. No data corruption — same pattern as Linear's existing bidirectional sync.
- **Content push + state push ordering**: If a column move and a file save happen near-simultaneously, `pushState` and `pushContent` may race. Both write to the same Notion page via different API calls (`PATCH /pages/{id}` for properties vs `DELETE + PATCH /blocks/{id}/children` for content). Notion processes these independently — no conflict, but the `last_edited_time` will bump twice. Both bumps are handled by the echo guard.
- **Notion API rate limits**: `updatePageContent` makes 2 API calls (DELETE + PATCH). `pushState` makes 1 API call (PATCH). If both fire in rapid succession (column move + file save), that's 3 calls. Notion's rate limit is ~3 requests/second. Should be fine, but worth monitoring under heavy sync load.

### Security
- No new credential handling. `NotionRemoteProvider` already has access to `NotionFetchService` via `_deps.notion` (`:168`), which manages the Notion API token.

### Side Effects
- **Destructive block replacement**: `updatePageContent` (`:642-646`) deletes ALL existing block children before appending new ones. If the agent (via Notion MCP) or a human has added content to the page between pushes, that content is lost. This is the existing behavior but becomes higher-impact when it fires on every plan file save.
- **`last_edited_time` bumps on content push**: Every `pushContent` call bumps the page's `last_edited_time`, causing `fetchStateDeltas` to re-fetch the page on the next poll. This is harmless (echo guard no-ops) but adds unnecessary API calls. Consider whether `pushContent` should be debounced or batched.
- **Markdown → paragraph blocks**: `updatePageContent` converts content to ≤2000-char paragraph blocks (`:649-668`). Markdown formatting (headers, lists, code blocks) is NOT preserved — it's dumped as plain text. This matches the existing `ResearchImportService` behavior but may surprise users expecting rich-text sync.

### Dependencies & Conflicts
- **Plan 1** (provider capabilities + unified push dispatch) — **hard dependency**. `pushState` / `pushContent` must exist on the `RemoteProvider` interface, and the provider registry must route Notion push triggers through `NotionRemoteProvider`.
- **`NotionFetchService.httpRequest`** (`:76`) — used for both the status-property PATCH and the content DELETE/PATCH. Already available via `_deps.notion`.
- **`NotionBackupService._ensureColumnSelectOptions`** (`:349-365`) — may need to be called from `pushState` if a column's select option doesn't exist. Currently a private method on `NotionBackupService`; may need to be exposed or duplicated.

## Dependencies

- **Plan 1** — `pushState` / `pushContent` interface methods and the provider registry must exist first. This plan fills in the Notion implementations.

## Adversarial Synthesis

Key risks: (1) `updatePageContent`'s delete-all-blocks strategy is destructive — any agent-authored or human-authored Notion page content between pushes gets wiped, which is a data-loss risk in the bidirectional loop; (2) content push bumps `last_edited_time`, creating a new state-delta echo path that didn't exist for Notion before — the column-equality guard handles it, but the extra API calls are wasteful; (3) missing select options for new columns cause silent push failures. Mitigations: document the destructive write as intentional (matching existing `ResearchImportService` behavior); verify the echo guard end-to-end with a manual push→poll cycle; have `pushState` check select option existence and log (not crash) on missing options.

## Proposed Changes

### `src/services/remote/NotionRemoteProvider.ts` (`:36`)
- **Context**: Implements `RemoteProvider`, pull-only today. `stateKeyToColumn` (`:138-143`) is identity mapping. `_deps.notion` provides `NotionFetchService` access (`:168`). `_ensureSetup` (`:46`) returns `NotionRemoteSetup` with `plansDatabaseId`.
- **Logic**:
  1. **Flip capability**: Change `capabilities` from `{ pull: true, push: false }` to `{ pull: true, push: true }` (set in Plan 1, flipped here).
  2. **Implement `pushState(remoteId, column)`**:
     - Call `this._deps.notion.httpRequest('PATCH', \`/pages/${remoteId}\`, { properties: { 'Kanban Column': { select: { name: column } } } })`.
     - This is the same pattern as `NotionBackupService.ts:418`.
     - If the API returns an error about an invalid select option (the option doesn't exist), log the error and skip — do NOT crash the sync loop. Optionally, call `_ensureColumnSelectOptions` to add the missing option and retry.
  3. **Implement `pushContent(remoteId, markdown)`**:
     - Delegate to `this._deps.notion.updatePageContent(remoteId, markdown)` (`:631`).
     - The method handles size guarding (1MB limit, `:634`), block deletion (`:642-646`), and chunked re-append (`:648-668`).
     - If the result is `{ success: false }`, log the error and throw (the trigger site handles errors).
  4. **Remove the stub implementations** added in Plan 1 (the stubs that logged "not yet implemented").
- **Edge Cases**:
  - **Missing select option**: If `PATCH /pages/{id}` returns a 400/422 because the `Kanban Column` select doesn't have an option named `column`, log: `[NotionRemoteProvider] pushState: column "${column}" is not a valid Kanban Column select option for page ${remoteId} — skipping. Re-run Notion remote setup to sync column options.` Do not retry or crash.
  - **Page not found**: If the API returns 404, the Notion page was deleted. Log and skip — the next poll's `fetchStateDeltas` will naturally stop seeing it.
  - **Content too large**: `updatePageContent` already guards against >1MB content (`:634-637`). The error propagates up; the trigger site logs it.

### `src/services/NotionFetchService.ts` (`:631`)
- **Context**: `updatePageContent` already exists and is functional. No changes needed to the method itself.
- **Logic**: No changes. The method is called by `NotionRemoteProvider.pushContent` via `_deps.notion.updatePageContent`.
- **Edge Cases**: The delete-and-reappend strategy is documented in the User Review Required section. If the user decides this is unacceptable, an alternative implementation would need to diff existing blocks against new content and update incrementally — but that is a significant scope expansion and NOT part of this plan.

### `src/services/RemoteControlService.ts` (`:17-29`, `:288-312`)
- **Context**: The echo-loop guards are documented at `:17-29` and implemented in `_applyStateMirror` at `:288-312`. The state guard is a single column-equality check at `:295`: `if (targetColumn === plan.kanbanColumn) { return; }`.
- **Logic**: No code changes needed — the guard is provider-agnostic. But the documentation at `:17-29` should be updated to note that Notion now has push-state, making the round-trip guard load-bearing for Notion (not just Linear). Add a comment noting that content push also bumps `last_edited_time`, causing state deltas to re-fetch, but the column-equality guard no-ops them.
- **Edge Cases**: Verify that `_pollState` (which calls `_applyStateMirror`) handles the case where a state delta's `stateKey` maps to the same column as the plan's current `kanbanColumn`. The guard at `:295` should prevent `refreshLocalPlanFromRemote` from being called, which prevents the file watcher from triggering a content push echo.

### `src/services/ContinuousSyncService.ts` (`:483-493`)
- **Context**: After Plan 1, `ContinuousSyncService` routes through the provider registry. The provider selection logic at `:483-493` checks `plan.clickupTaskId` / `plan.linearIssueId`. Notion plans have a Notion page ID stored in a different field.
- **Logic**: Add Notion page ID to the provider resolution logic. The plan record's Notion remote ID field must be checked alongside `clickupTaskId` and `linearIssueId`. **Clarification**: The exact field name for the Notion remote ID on `KanbanPlanRecord` needs to be confirmed — it may be `notionPageId` or stored in a generic `remoteId` field. Check `KanbanPlanRecord` type definition and `_indexByRemoteId` in `RemoteControlService` for the field name.
- **Edge Cases**: If a plan has both a Notion page ID and a Linear issue ID (unlikely but possible), the priority logic must be defined. Current priority: ClickUp > Linear. Add Notion to the chain (likely ClickUp > Linear > Notion, or based on the active `remote.config.provider`).

### `src/services/KanbanProvider.ts` (`:1924`)
- **Context**: After Plan 1, `_queueLinearSync` and `_queueClickUpSync` route through `provider.pushState`. There is no `_queueNotionSync` today.
- **Logic**: Add a Notion push trigger for column moves. When a card with a Notion remote ID moves locally, call `provider.pushState(notionPageId, targetColumn)` through the provider registry. The `realTimeSyncEnabled` gate equivalent for Notion needs to be defined — Notion doesn't have a `realTimeSyncEnabled` flag today (it's Linear/ClickUp-specific). **Recommendation**: use the `remote.config` active state (if Notion is the configured provider and remote control is active, push is active). This will be formalized in Plan 3's config consolidation.
- **Edge Cases**: If Notion remote control is not set up (`_ensureSetup` returns null), skip the push silently.

## Verification Plan

### Automated Tests
- **Skipped per session directive** — the test suite will be run separately by the user.

### Manual Verification
- **pushState verification**: Move a Notion-linked card locally → confirm the Notion page's `Kanban Column` select updates to the new column name.
- **pushContent verification**: Edit a Notion-linked plan file → confirm the Notion page body updates (all old blocks deleted, new content appended as paragraph blocks).
- **Echo-loop verification**: After a `pushState`, wait for the next poll cycle → confirm the poll does NOT re-apply the column move (echo guard no-ops). Check logs for "State mirror" messages — there should be none for the pushed card.
- **Content push echo verification**: After a `pushContent`, wait for the next poll → confirm no state mirror dispatch fires (the state delta from the timestamp bump is no-oped by the column-equality guard).
- **Missing select option**: Add a new local column that doesn't exist as a Notion select option → move a card to it → confirm the push logs a skip message and does not crash.
- **Bidirectional flow**: Change the `Kanban Column` select directly in Notion → confirm the next poll mirrors it locally (pull still works). Then move the card locally → confirm the push updates Notion (push now works). This is the full bidirectional round trip.
- **TypeScript compilation**: Skipped per session directive.

## Uncertain Assumptions

None — all Notion API operations (PATCH page properties, DELETE/PATCH block children) are confirmed in the existing codebase (`NotionBackupService.ts:418`, `NotionFetchService.ts:631-672`). The echo-loop guard behavior is documented and provider-agnostic. The `Kanban Column` select as the state property is confirmed by `NotionRemoteProvider.ts:94` and the analysis doc's decision D2.

## Non-goals

- **No config consolidation or Remote-tab UI** (plan 3).
- **No changes to Linear/ClickUp push** beyond what plan 1 relocated.

## Dependencies

- **Plan 1** (provider capabilities + unified push dispatch) — required. `pushState`/`pushContent` and the provider registry must exist first.

## Open items to resolve during `/improve-plan`

- ~~Confirm a writable Notion status property exists in the remote setup and define the column→status map.~~ **Resolved**: The `Kanban Column` select property is the status property. The column→status map is identity (the select option name IS the column name). No separate mapping needed.
- ~~Decide content-write strategy in `updatePageContent` (it currently deletes-and-reappends blocks — verify idempotency under repeated pushes).~~ **Resolved**: The delete-and-reappend strategy is idempotent — repeated pushes with the same content produce the same result. The destructive nature (wiping non-Switchboard content) is documented in User Review Required.

## Source

Derived from `docs/remote_sync_architecture_refactor_analysis.md` (Sequencing → Plan 2; open questions #2, #4). Base-level plan — run `/improve-plan` to deepen before execution.

## Recommendation

Complexity 6 → **Send to Coder**. The implementation is well-scoped: wire two existing capabilities (`updatePageContent` + page-property PATCH) into the provider interface, flip a capability flag, and verify the echo guard. The main risk is the destructive content write, which is a design decision (not a coding challenge) flagged in User Review Required.
