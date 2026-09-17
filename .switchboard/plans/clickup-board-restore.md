# ClickUp can already be queried by planId but cannot rebuild a board — add the restore orchestration

> **CANCELLED — 2026-09-16.** This work is removed, not deferred, and the code
> that had already landed for it has been deleted.
>
> Tracker board-restore was a sql.js-era hedge: the board projection into Notion
> existed because the local store used to be fragile. The store is now one
> better-sqlite3 database owned by one host, so the premise is gone. Rebuilding a
> board out of a SaaS tracker is also the wrong shape for a Pi appliance —
> recovery is a system-level concern (SD-card image, restic), not the board's job.
>
> The one legitimate need behind it — getting an existing board into a tracker in
> bulk — is served by the per-project seed, not by a backup/restore pair:
> `seed-board-projects-to-linear-projects.md`, `seed-board-projects-to-clickup-lists.md`,
> `seed-controls-in-linear-and-connections-panels.md`. Mass ticket→plan import
> already exists in the Tickets panel ("Import All as Plans").
>
> `boardPush` and `boardRestore` are no longer capabilities on
> `RemoteProviderCapabilities`, and `provider-capability-parity-contract.test.js`
> now ratchets against them coming back. Re-adding either is a product decision,
> not a parity fix.


## Goal

Give ClickUp the board-restore capability Notion has. Every primitive is already built and already used for reconciliation; what is missing is the pass that fetches everything, matches it back, and applies it.

### Problem Analysis

ClickUp already persists the identity anchor a restore needs, three separate ways (`ClickUpSyncService.ts`):

- a `switchboard:{planId}` tag (`:2976`)
- a description footer, `[Switchboard] PlanFile: … | Plan: …` (`:2980`)
- an optional configured custom field (`:2986`)

And it already looks tasks up by `planId` — `_findTaskByPlanId()` (`:2935`) filters on the custom field and falls back to a tag search, both with `include_closed=true`.

The remote-state-to-column mapping also exists: `stateKeyToColumn(stateKey)` is on the `RemoteProvider` interface and implemented by all three providers.

What does not exist is the orchestration. There is no `restoreFrom*` method on `ClickUpSyncService`, and nothing writes `kanban_column` back into the DB from ClickUp. So on a fresh machine — where `clickup_task_id` is gone because it lived in the DB — the board cannot be rebuilt even though every task still carries its `planId`.

This is the cheap one of the two missing restores, and the anchor already being in three places is what makes it cheap.

### Root Cause

The anchors and the lookup were built for incremental reconciliation — find *this* task for *this* plan. Nobody needed the inverse direction, so the bulk pass was never written.

### Non-goals

- No change to what ClickUp pushes. The anchors are sufficient as they stand.
- Not addressing ClickUp's `archive: false` asymmetry, which is a separate pre-existing exemption.

## Metadata

**Complexity:** 4
**Tags:** clickup, providers, restore, parity

## User Review Required

None.

## Complexity Audit

### Routine
- Reusing `_findTaskByPlanId` and `stateKeyToColumn`.

### Complex / Risky
- **Bulk fetch completeness.** A truncated or capped listing that is treated as complete makes absent plans look deleted. The provider-sync feature already shipped this exact bug in `reconcileLiveIds` for Notion and Linear, fixed by reporting INCOMPLETE when the cap is hit. Restore must do the same and refuse to apply a partial result.
- **Additive-only application.** A local plan absent from ClickUp must be left alone. This codebase has already shipped a destructive prune on a short fetch once, in the tickets import.

## Edge-Case & Dependency Audit

- **Custom field not configured.** The tag fallback must carry the whole restore, not just individual lookups.
- **Duplicate tags.** Two tasks carrying the same `switchboard:{planId}` — pick deterministically and report the collision rather than applying an arbitrary one.
- **Closed tasks.** `include_closed=true` is already the existing behaviour and must be preserved; a completed card is still board state.
- **Unmappable status.** `stateKeyToColumn` returning undefined must skip the column and be reported, not default to a column.
- **Project names resolve only.** An unknown project leaves the plan unassigned; never auto-create a `projects` row — the importer's existing rule.
- **`planId`, never `sessionId`.** `session_id` is deprecated and `plan_id` is canonical; matching on the former is a defect.

## Dependencies

- **Depends on the capability + contract test plan.** This plan's proof of landing is deleting ClickUp's board-restore exemption.
- Independent of the Notion and Linear plans; no shared files.

## Adversarial Synthesis

**Key risks:** (1) The restore uses `getListTasks` which drops the `complete` flag, making the "refuse truncated" defense a no-op. (2) The bulk fetch is unspecified — a coder defaults to N per-plan `_findTaskByPlanId` calls, which has no bulk completeness story. (3) The `boardSyncRestore` signature doesn't match Plan 2's contract. **Mitigations:** A `getListTasksWithCompleteness` variant exposes the flag with `includeClosed: true`; the bulk fetch iterates mapped lists (not per-plan); the method signature matches Plan 2's `boardSyncRestore?(workspaceRoot, progress?)`.

## Proposed Changes

1. **Add board restore to `ClickUpSyncService`**, exposed through the provider seam as `boardSyncRestore?(workspaceRoot, progress?)` on `RemoteProvider` (the signature Plan 2 specifies), gated on the declared capability.
2. **Bulk fetch: iterate all mapped lists with `includeClosed: true`**, reusing `reconcileLiveIds`'s pattern (`ClickUpRemoteProvider.ts:223-255`) but with `includeClosed: true` (a completed card is still board state). Match each task to a local plan by parsing the three anchors — `switchboard:{planId}` tag (`:2976`), description footer `[Switchboard] PlanFile: … | Plan: …` (`:2980`), custom field (`:2986`) — locally from the bulk result. This is NOT N per-plan calls to `_findTaskByPlanId`; it is one paginated fetch per mapped list.
3. **Expose the `complete` flag.** `getListTasks` (`:1318`) drops the `complete` flag from `_fetchListTasksInternal` (`:1315`); `getListTasksLive` (`:1333`) returns `complete` but accepts no options (no `includeClosed`). The restore needs both. Add a `getListTasksWithCompleteness(listId, options)` method that returns `{ tasks, complete }` AND accepts `includeClosed: true`. The restore refuses to apply if ANY list's fetch is incomplete (`complete === false`) — the same contract `reconcileLiveIds` enforces.
4. **Apply plan board state additively**, keyed on `planId`, using `stateKeyToColumn` for the column and resolve-only handling for project names.
5. **Apply feature structure in a second pass**, mirroring the ordering Notion's restore already uses.
6. **Report restored, skipped, unmapped and not-found-locally counts.**
7. **Flip the declared capability and delete the exemption.**

### Migration

None. Additive read path; no schema or persisted-state change.

## Verification Plan

1. **The machine-loss case.** Push a board to ClickUp, clear the local DB, restore, and confirm columns and feature relations return.
2. **Tag-only path.** With no custom field configured, confirm restore completes on the tag fallback alone.
3. **Truncated fetch refuses.** Force a capped listing; confirm the restore reports incomplete and applies nothing.
4. **Additive.** Restore a set omitting plans that exist locally; confirm those plans are untouched and the omission is reported.
5. **Unknown project resolves only.** Confirm the plan lands unassigned with no `projects` row created.
6. **Unmappable status.** Confirm the column is skipped and reported rather than defaulted.
7. **Duplicate anchor.** Two tasks with the same `planId` tag — confirm deterministic selection and a reported collision.
8. **Contract test.** ClickUp's board-restore exemption is gone and the suite is green.

## Outstanding Questions

None.

## Implementation summary (2026-09-16)

`ClickUpSyncService.restoreBoardFromClickUp(workspaceRoot, options)` is the bulk pass: one paginated fetch per mapped list with `includeClosed: true` (via a new `getListTasksWithCompleteness`, which exposes both the `complete` flag and `includeClosed` — `getListTasks` drops `complete`, `getListTasksLive` takes no options), match every task to a local plan by parsing all three anchors (configured custom field, `switchboard:{planId}` tag, description footer `[Switchboard] PlanFile: … | Plan: …`), then apply additively keyed on `planId`. It is exposed through the provider seam as `ClickUpRemoteProvider.boardSyncRestore`, which populates `_listIdToColumn` so `stateKeyToColumn` — the interface primitive, passed into the service as `resolveColumn` — resolves the column.

Safety properties: an incomplete listing (never observed `last_page`) refuses the WHOLE restore with `incomplete: true` and applies nothing; a local plan the remote omits is left untouched and counted in `skipped`; a remote anchor with no local plan is counted in `notFoundLocally` and never creates a row; an unmappable status is counted in `unmapped` and skipped rather than defaulted; duplicate anchors pick the newest `dateUpdated` deterministically and report the collision; `planId` (never `sessionId`) is the match key. Feature relations resolve in a second pass (`updateFeatureStatus(child, 0, parentPlanId)` then mark the parent `isFeature=1`), mirroring Notion's ordering. Matched tasks also get `clickup_task_id` persisted — on a fresh machine that is exactly the field that went missing.

`ClickUpTask` gained `customFields` so the custom-field anchor survives `_normalizeClickUpTask`. `ClickUpRemoteProvider` now declares `boardRestore: true` and the parity contract test's ClickUp board-restore exemption is deleted; the contract test's board-sync-on-the-interface check is now per-provider (Notion push+restore, ClickUp restore) and asserts each method delegates to a real implementation. New integration tests cover the happy path (tag anchor, footer anchor, orphan anchor, local-only plan) and the incomplete-listing refusal. Compilation and test execution were skipped per this run's directives; `node --check` passes on the touched JS.
