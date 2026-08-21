# Linear issues carry no planId, so a board can never be rebuilt from Linear — add the anchor, then the restore

## Goal

Give Linear the board-restore capability Notion has and ClickUp is getting. Unlike ClickUp, Linear needs a durable identity anchor added to what it pushes before restore is even possible — and existing issues need a backfill path, or every board created before this change stays unrecoverable.

### Problem Analysis

Linear is the only provider with **no `planId` anchor on the remote object at all**. Searching `LinearSyncService.ts` for a `planId` written into a description, label, attachment, or custom field returns nothing. Identity is carried solely by `linear_issue_id` on the local plan row — `KanbanDatabase.ts:218`, indexed at `:365`.

That column lives in `kanban.db`. Machine loss is precisely the event that destroys it. So after a reformat there is no way to match a Linear issue back to a card, even though the issues are all still sitting there — the mapping was only ever local.

Compare the two providers that work:

- **Notion** writes `'Plan ID'` as a rich_text property (`NotionBackupService.ts:559`) and queries by it (`:508`).
- **ClickUp** writes a `switchboard:{planId}` tag, a description footer, and an optional custom field, and looks up by any of them.

Linear writes none. The mapping primitive it does have — `stateKeyToColumn(stateKey)`, on the `RemoteProvider` interface and implemented by all three — is useless without a way to know which plan an issue belongs to.

This is the expensive one, and the backfill is why: an anchor added today helps every future issue and no existing one.

### Root Cause

Linear integration was built assuming the local DB is the source of truth for linkage, which is correct for incremental sync and false for disaster recovery. The other two providers happened to persist an anchor remotely for their own reasons, and so acquired a recovery path as a side effect nobody designed.

### Non-goals

- Not changing Linear's existing sync behaviour beyond adding the anchor.
- Not reconstructing plans that were never pushed to Linear.

## Metadata

**Complexity:** 6
**Tags:** linear, providers, restore, parity, backfill

## User Review Required

None.

## Complexity Audit

### Routine
- The restore orchestration itself, once an anchor exists — the same shape as ClickUp's.

### Complex / Risky
- **Choosing the anchor.** Linear offers labels, attachments, and the description body. A label per plan would create thousands of labels and pollute the workspace. The description footer is the pattern ClickUp already uses (`ClickUpSyncService.ts:2980`: `[Switchboard] PlanFile: … | Plan: …`) and is the strongest choice — the code grounding resolves this: Linear's `attachmentCreate` (`LinearSyncService.ts:1735`) takes a `url` (a planId is not a URL), and `uploadAttachment` (`:1668`) is an extra file-upload API call per issue just to store a 36-character string. The description footer wins on every axis. The footer shape: `[Switchboard] Plan: {planId}` appended to the description.
- **The push chain doesn't carry planId.** `createIssue` (`:2315`) takes `plan: { planFile, topic }` — no planId. `_buildInitialIssueDescription(planFile)` (`:551`) takes only `planFile`. `syncPlan` (`:2221`) takes `{ planFile, topic, complexity }` — also no planId. To put a planId in the description footer, it must be threaded through the call chain or looked up from the DB inside `_buildInitialIssueDescription` using `planFile`. The DB-lookup option is less invasive (no upstream signature changes) but adds a DB call per issue create.
- **The clobber point is `syncPlanContent:2298`.** `syncPlanContent` (`:2273`) writes `contentWithoutH1` as the ENTIRE description (`:2298`: `description: contentWithoutH1`) — it replaces, not appends. If the anchor is a description footer, `syncPlanContent` clobbers it on EVERY content sync. Protection is a concrete one-line change: `description: contentWithoutH1 + anchorFooter`. The content-conflict resolver is a separate path that needs the same treatment. This is not a generic "protect from content sync" concern — it is a specific line of code.
- **Backfilling existing issues.** Every issue created before this lands has no anchor. A backfill must match issues to plans while the local DB still holds `linear_issue_id` — meaning **the backfill only works on a machine that still has the board.** A user who has already lost their DB cannot be helped, and the plan must say so rather than implying otherwise.
- **Description-body edits.** If the anchor lives in the description, remote content edits and the content-conflict resolver must not strip it.

## Edge-Case & Dependency Audit

- **The backfill is a one-shot opportunity per install.** It must run while `linear_issue_id` is still populated, which argues for running it automatically and early once the capability ships, not behind a button a user finds later.
- **Bulk fetch completeness.** `reconcileLiveIds` already false-completed on a truncated page cap for Linear and was fixed to report INCOMPLETE. Restore must inherit that behaviour and refuse to apply a partial result.
- **Additive-only application**, for the same reason as ClickUp: a local plan absent from Linear is not a deletion.
- **`stateKeyToColumn` returning undefined** must skip and report, never default.
- **Project names resolve only**; never auto-create a `projects` row.
- **`planId`, never `sessionId`.**
- **Existing issues that were archived** must still be matchable — a completed card is board state.
- **Rate limits.** A backfill touching every issue in a large workspace needs pacing, and a partial backfill must be resumable rather than restarting.

## Dependencies

- **Depends on the capability + contract test plan.** Proof of landing is deleting Linear's board-restore exemption.
- **Sequenced after the ClickUp plan**, not because of a code dependency but because ClickUp's restore establishes the orchestration shape this one reuses, and doing the cheap one first means two of three providers are restorable while this larger change is still in review.

## Adversarial Synthesis

**Key risks:** (1) The push chain (`createIssue`/`_buildInitialIssueDescription`) doesn't carry planId — the anchor can't be written without threading or a DB lookup. (2) `syncPlanContent:2298` clobbers the description footer on every content sync — protection is a specific line fix, not a generic concern. (3) The backfill is a one-shot opportunity that only works while `linear_issue_id` exists locally. **Mitigations:** planId is looked up from the DB inside `_buildInitialIssueDescription`; `syncPlanContent` re-appends the footer after content; the backfill runs automatically on upgrade and the UI states its limit plainly.

The tempting shortcut is to skip the anchor and match on issue title. Titles are user-editable, non-unique, and get renamed during planning — a title match will confidently attach board state to the wrong card, which is worse than no restore. If the anchor is not durable, the restore should not ship.

The second temptation is to skip the backfill and ship the anchor alone. That is defensible only if stated loudly: it means Linear restore works for boards created after the upgrade and silently does nothing for everyone else, which reads as a broken feature rather than a scoped one.

## Proposed Changes

1. **Add a durable `planId` anchor to what Linear pushes as a description footer** — `[Switchboard] Plan: {planId}` appended to the description, matching ClickUp's proven pattern (`ClickUpSyncService.ts:2980`). The attachment option is rejected: Linear's `attachmentCreate` (`:1735`) takes a `url` (a planId is not a URL), and `uploadAttachment` (`:1668`) is an extra file-upload API call per issue. The label option is rejected: thousands of labels. The description footer wins on durability, cost, and pattern match.
2. **Thread planId through the push chain.** `createIssue` (`:2315`) and `_buildInitialIssueDescription` (`:551`) don't receive planId. Look up planId from the DB inside `_buildInitialIssueDescription` using `planFile` (less invasive than threading through `syncPlan`'s upstream callers), and append the footer to the description before the `issueCreate` call.
3. **Protect the anchor from `syncPlanContent` clobbering.** The clobber point is `syncPlanContent:2298` (`description: contentWithoutH1` — a full replace). Change to `description: contentWithoutH1 + anchorFooter`, re-appending the footer on every content sync. The content-conflict resolver path needs the same treatment. This is a concrete one-line fix at a specific line, not a generic "protect from content sync" concern.
4. **Backfill existing issues** from `linear_issue_id` while it is still available, paced for rate limits and resumable.
5. **Add board restore to `LinearSyncService`**, exposed through the seam as `boardSyncRestore?(workspaceRoot, progress?)` on `RemoteProvider` (the signature Plan 2 specifies), reusing the ClickUp orchestration shape — completeness-checked bulk fetch (Linear's `reconcileLiveIds` at `LinearRemoteProvider.ts:243` paginates with `hasNextPage`/`endCursor` and reports INCOMPLETE on cap — the restore inherits this), additive application keyed on `planId`, `stateKeyToColumn` for columns, resolve-only projects, feature structure in a second pass.
6. **State the backfill's limit plainly in the UI**: a board whose local DB is already gone cannot be recovered from Linear.
7. **Flip the declared capability and delete the exemption.**

### Migration

The backfill *is* the migration, and it is one-directional and time-sensitive: it depends on `linear_issue_id`, which exists only while the original machine's DB does. Run it automatically once on upgrade rather than leaving it to a user action, and record that it ran so it is not repeated.

## Verification Plan

1. **The machine-loss case, post-anchor.** Push a board, clear the local DB, restore, confirm columns and feature relations return.
2. **Backfill recovers pre-anchor issues.** With issues created before the change and a populated DB, run the backfill, then clear the DB and confirm restore works.
3. **Anchor survives a content edit.** Edit an issue's description remotely, run content sync, confirm the anchor is intact.
4. **Title matching is absent.** Rename an issue and confirm restore still matches, proving no title fallback was introduced.
5. **Truncated fetch refuses.** Force a page cap; confirm incomplete is reported and nothing is applied.
6. **Additive.** Omit locally-present plans; confirm untouched and reported.
7. **Backfill is resumable and paced.** Interrupt it mid-run and confirm it resumes without duplicating work or tripping rate limits.
8. **The limit is stated.** Confirm the UI says a lost DB cannot be recovered from Linear.
9. **Contract test.** Linear's board-restore exemption is gone and the suite is green.

## Outstanding Questions

None.
