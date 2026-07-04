# `**Column:**` transition-intent frontmatter — retire manifest.json

## Goal

Let a plan `.md` advance its own kanban column by carrying a `**Column:**` transition-intent
line the watcher honors on **existing** rows, guarded exactly like the manifest's `fromColumn`
so it never clobbers a card a human already moved. Then deprecate the `manifest.json` subsystem,
whose only reason to exist is that the `.md` currently cannot express a column move.

### Core problem & root cause

Kanban column state is DB-owned and never written to disk (`updateColumnByPlanFile` at
`src/services/KanbanDatabase.ts:1554`). Remote agents that cannot reach the extension's local
API server therefore advance a card by dropping a `manifest.json` sidecar that
`PlanManifestService` ingests then deletes (`src/services/PlanManifestService.ts`). This is an
entire out-of-band subsystem — staleness guard (`STALENESS_MAX_ATTEMPTS`/`MS`), the stale-move
`fromColumn` guard, consume-then-delete, and producer instructions duplicated across ~6 skill
docs — that exists solely because the `.md` can't move a card.

The watcher already reads `**Project:**` from frontmatter (`planMetadataUtils.ts:96`) and a
loose `kanbanColumn:` token, but the column can't advance an imported card because
`insertFileDerivedPlan` **hardcodes `'CREATED'`** on insert and deliberately omits
`kanban_column` from its ON-CONFLICT UPDATE (`KanbanDatabase.ts:1457-1465`) — the guard that
stops a re-scan from resetting a human's drag. The fix is to let an explicit `**Column:**`
*intent* line perform a guarded forward move on existing rows, replicating exactly what the
manifest does today but through the file the agent is already editing.

## Metadata

- **Project:** Switchboard
- **Tags:** kanban, watcher, frontmatter, manifest, cleanup
- **Complexity:** 6

## Implementation

> ⚠️ **`**Column:**` is ALREADY an owned token — do not reuse it in plan frontmatter.**
> `GitStateProvider._parseColumnDeltasFromDiff` (`src/services/remote/GitStateProvider.ts:397`,
> `COLUMN_LINE_RE = /^\*\*Column:\*\*\s*(.+)$/m`) parses `**Column:**` from **any** `.switchboard/`
> git diff (remoteId = file basename) and applies a column move **plus an agent dispatch**. It
> normally reads the exported mirror (`kanban-state-*.md`), but a `**Column:**` line committed into
> a *plan* `.md` would be double-consumed (this subtask's GlobalPlanWatcher path *and*
> GitStateProvider) and fire a spurious dispatch in control-plane mode. So: use a **distinct key**
> (e.g. `**Move To:**`) for the plan-frontmatter transition intent, OR route column moves through
> the existing GitStateProvider mirror channel instead of adding a second consumer.
>
> Also: on a stock install (`boardStateExport: 'none'`) the manifest is the **only** git-inbound
> channel, so retiring the manifest for column is deferred until either the `**Move To:**` intent
> or the mirror channel fully covers stock installs. Epic/project retirement (via their carriers)
> is not blocked by this.

1. **Parse the intent key.** Add a `columnIntent?: string` field to `PlanMetadata`
   (`planMetadataUtils.ts:47-54`), parsed via `extractEmbeddedMetadata(content, 'Move To')` (NOT
   `'Column'` — see the warning above). Keep this distinct from the legacy `kanbanColumn:` token.

2. **Apply as a guarded move in the watcher.** In `GlobalPlanWatcherService._handlePlanFile`
   update branch (`GlobalPlanWatcherService.ts:617-697`), after `parsePlanMetadata` (`line
   500`), if `metadata.columnIntent` is present and differs from the plan's current
   `kanban_column`:
   - Apply the move via the same targeted method the manifest uses — `movePlanByPlanFile`
     (the epic-aware move that cascades subtasks and triggers integration sync) rather than a
     raw `updateColumnByPlanFile`.
   - **Guard:** only move when the plan is currently in the expected `fromColumn`. Reuse the
     manifest's default (`'CREATED'`) unless an explicit `**From Column:**` is provided, so a
     stale intent (whose expected column no longer matches) is skipped and never overrides a
     human/host move. This is the exact semantics documented at `PlanManifestService.ts:26-31`
     and `44-53`.
   - Do NOT write the new column back into the file; the DB stays authoritative (matching
     current behavior).

3. **Single-shot / no re-fire.** The mtime gate (`GlobalPlanWatcherService.ts:481-484`) plus
   the `movePlanByPlanFile` UPDATE (which stamps `updated_at`) means the intent is applied once
   per file change. Because the guard checks `current == fromColumn`, a leftover `**Column:**`
   line will not re-move the card after the first application (current no longer equals
   fromColumn) — matching the manifest's consume-then-idempotent behavior without a delete.

4. **Deprecate manifest.json.** Retirement is only complete once *every* manifest field has a
   frontmatter replacement — this subtask covers `**Column:**`; `epic_id`/`project` are covered by
   `epic-membership-carrier-bidirectional-sync.md` and `project-carrier-hardening.md`; `status`
   needs a `**Status:**` carrier (fold into whichever lands last). Do NOT retire the manifest
   until all four exist, or remote agents lose those capabilities. Then:
   - Update the skill docs that instruct agents to write `manifest.json`
     (`improve-plan`, `improve-epic`, `switchboard-chat`, `switchboard-split`, and the two
     workflow mirrors) to write the frontmatter carriers instead.
   - Keep `PlanManifestService` **reading** manifests for one release (migration safety — remote
     agents on older skill docs may still emit them), but log a deprecation notice. Do not delete
     the service in the same change that ships the replacement.

Note: this plan predates the `state-ownership-and-reconciliation-model.md` foundation — the
`**Column:**` guard here (`fromColumn` compare-and-swap) is the same CAS the model formalizes;
column stays DB-owned (no writeback), unlike epic_id/project.

## User Review Required

- Confirm the intent field name (`**Column:**`) and whether to support an explicit `**From
  Column:**` companion (vs. always defaulting the guard to `CREATED`).
- Confirm the phased retirement: ship frontmatter path + keep manifest reader for one release,
  remove the reader later. **This is a migration-sensitive change — remote agents are a released
  surface.**
- Confirm the move should go through `movePlanByPlanFile` (epic cascade + ClickUp/Linear/Notion
  sync fan-out) and not a bare column write.

## Complexity Audit

### Routine
- Adding a parsed field via `extractEmbeddedMetadata`.
- Calling an existing move method from the watcher's update branch.
- Editing skill-doc producer instructions.

### Complex / Risky
- **Guard correctness is the whole feature.** Without the `fromColumn` match, a stale
  `**Column:**` line clobbers a card a human dragged — the exact failure the manifest guard was
  built to prevent. Replicate it faithfully.
- **Move fan-out.** `movePlanByPlanFile` cascades epics and fires integration sync
  (`move-card.js:6-16` documents that integration tokens live in VS Code secret storage, so the
  fan-out must happen inside the extension). Confirm the watcher path reaches the same fan-out
  the drag-drop path does, or remote moves silently desync external trackers.
- **Migration / released surface.** Remote agents are shipped; do not break in-flight
  manifest-based flows. Phase the retirement (reader stays one release). Per CLAUDE.md, when
  unsure whether something shipped, assume it did and keep the compat path.

## Edge-Case & Dependency Audit

- **Independent** of the entire activity-light workstream (B). Shares only the "watcher reads
  agent-written frontmatter" spine.
- **Interaction with `**Stage Complete:**`:** the two markers are orthogonal — `**Column:**`
  moves the card (dispatch-time, in advance), `**Stage Complete:**` only clears the light. A
  plan could carry both; apply the column move and (separately) the light-clear independently.
- **Custom columns:** `**Column:**` values validate against `VALID_KANBAN_COLUMNS` OR
  `SAFE_COLUMN_NAME_RE` (`KanbanDatabase.ts:697-706`), so custom column names are accepted —
  reuse the same validation the move methods already apply.
- **Both markers + `**Project:**`:** ensure parsing all three from one file is order-independent.
- **Backward compat:** old plans with no `**Column:**` line behave exactly as today (import to
  CREATED, DB-owned thereafter).
