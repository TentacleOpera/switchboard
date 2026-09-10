# Imported ticket metadata is gitignored files and two bare id strings — make it first-class shared board state

<!-- libsql-rejected -->
> **PREMISE NOTE 2026-09-11 (operator decision: libSQL is rejected).** This plan's goal is
> **unaffected** — it is recorded here only so a reader does not chase the dead reference below.
> The authoritative store is one better-sqlite3 database owned by one board host, which lives at
> `~/.switchboard/boards/<workspace-id>.db`, **outside the repository**. That is what carries the
> clone-survival and `git clean -xdf` guarantees, and it always was: neither depended on libSQL.
> "Reaches a teammate" now means a second person or machine reaching that board host over its HTTP
> API, or a hand-carried `.db`, rather than a replica. The only corrections owed are the words
> "libSQL" and "replica sync" where they appear as the *reason*; every requirement stands.

## Goal

Make a plan imported from Linear (or ClickUp) carry everything associated with its ticket, in the board's own store, so the association survives a fresh clone, reaches a teammate, and travels to a shared store. Linear stays the team's coordination surface — Switchboard is not competing with it — which is exactly why the board must faithfully hold what Linear told it.

### Problem Analysis

**The board knows a ticket's id and nothing else.** `plans` carries `clickup_task_id TEXT DEFAULT ''` and `linear_issue_id TEXT DEFAULT ''` (`KanbanDatabase.ts:217-218`), plus a `linear_issue_links` table (`:264`). Two opaque strings. Not assignee, state, labels, cycle, estimate, team, parent, project, description, comments or attachments — none of the metadata that makes a ticket legible.

**The metadata that *is* imported lands in gitignored files.** `TicketsPanelProvider` reads and watches `.switchboard/tickets/<provider>/` (`:323`, `:373`, `:524`, `:614`), and `.gitignore:52` is `.switchboard/*` with whitelists for `plans/`, `features/`, `reviews/`, `sessions/` — and none for `tickets/`. So imported ticket content is machine-local, untracked files.

Three consequences follow, and all three contradict a Linear-first product:

1. **A teammate sees the plan and not the ticket.** Plans are committed markdown; ticket metadata is not. Whoever imported the ticket is the only person whose Switchboard knows what it said.
2. **A fresh clone loses it.** The plan comes back from git; the ticket context does not. Same for a worktree, and `git clean -xdf` takes it.
3. **The board's own store cannot carry it.** Board state is what lives in the board database and what the `board.json` snapshot carries. Ticket metadata is not board state today, so imported tickets are half-blank for everyone but the one machine that holds the gitignored files. *(2026-09-11: previously read "travels to a libSQL or git-carried store" — libSQL is rejected, and the point is unchanged without it.)*

**The related bug class is already documented, which is evidence the seam is thin.** `feature_plan_20260810144300_tickets-sync-badge-reads-a-different-workspace-db-row-than-the-refetch-stamps.md` and `feature_plan_20260807161809_tickets-subtask-drilldown-sync-badge-always-local.md` are both symptoms of ticket truth living in one place and board truth in another, with badges reading across the gap.

### Root Cause

Tickets were built as a *panel* — a browsing surface over an external system, backed by files it could cache and watch. Board state was built as a database. Importing a ticket as a plan crosses from one model to the other, and the crossing was implemented as an id assignment because there was nowhere in the board's model for the rest to go.

### Non-goals

- Becoming a Linear client. Switchboard does not replace Linear, does not model everything Linear models, and does not attempt two-way authority over ticket fields. Linear remains authoritative for tickets; the board holds a faithful snapshot of what it was told.
- Removing the tickets file cache. Files stay as the browsing/refetch cache; this adds the durable board-side record for tickets actually imported as plans.
- Syncing ticket fields back to Linear. Out of scope; projections own outbound.
- Importing every ticket. Only tickets promoted to plans get board-side metadata.

## Metadata

**Complexity:** 7
**Tags:** database, backend, api, feature, reliability, ux

## User Review Required

Yes — three decisions.

1. **Schema shape.** Provider-specific columns on `plans`, versus one `plan_tickets` table with a typed core plus a provider payload. Recommendation: **a `plan_tickets` table** — a typed core (provider, external id, url, title, state, assignee, labels, parent, team/project, estimate, updated-at-source) plus a JSON payload for provider-specific extras. Columns on `plans` is how the current two ids happened, and it does not survive a third provider.
2. **How much is a snapshot versus a live read.** Recommendation: **snapshot on import, refresh on demand and on refetch**, with the source's own updated-at stored so staleness is visible. A live read makes the board depend on Linear's availability to render a card.
3. **Does the description/body come along?** It is the largest field and the one most likely to be stale. Recommendation: **yes, but stored as body-plus-hash with staleness surfaced**, because "see everything associated" is the actual requirement and a card that omits the ticket's text does not meet it.

## Complexity Audit

### Routine

- The `plan_tickets` table and its read/write paths.
- Populating it on the existing import-ticket-as-plan path.
- Keeping `plans.linear_issue_id` / `clickup_task_id` in place as-is, so nothing that reads them breaks.

### Complex / Risky

- **Two truths must be reconciled without inventing a third.** The file cache and the board record will disagree the moment a refetch updates one. The board record is the board's truth; the file cache is the panel's cache. Whichever one a badge reads must be stated, because the documented sync-badge bugs are precisely this ambiguity.
- **Provider field models do not align.** Linear has cycles, estimates, teams, sub-issues; ClickUp has lists, folders, spaces, custom fields. A typed core forces a mapping decision per field, and a wrong mapping is worse than an untyped payload — it asserts an equivalence that is not there.
- **Field volume against a shared store.** Ticket bodies and comment threads are the largest text the board would hold, and the storage boundary rule from the sidecar plan says the store may hold control-plane definitions but "must never become the sole home of a user artifact". A ticket body is an *external* artifact — regenerable from Linear, not from nothing — so it is admissible, but it must be sized: bodies and comments are the fields most likely to make a replica sync expensive.
- **Deletion and unlinking.** A ticket deleted in Linear, or a plan unlinked from its ticket, needs a defined outcome. Recommendation: keep the snapshot and mark it orphaned, because the plan may have been worked from it.
- **Privacy.** Ticket metadata carries assignee names and emails, and it would now travel to a shared store and possibly to projections. Fine for a team on their own infrastructure, worth stating explicitly, and an argument for the body being excludable.

## Edge-Case & Dependency Audit

**Race conditions**
- A refetch landing while a plan is being imported from the same ticket.
- Two machines importing the same ticket as two plans. Both are legitimate; the table must not assume one plan per external id.

**Security**
- Assignee emails in the shared store and in projections. State it; allow the body and comments to be excluded.
- Ticket attachments must not be pulled into the store as blobs — reference them by URL.

**Side effects**
- The tickets panel's badge logic should read the board record for imported tickets, which is the fix for the documented cross-reading bugs rather than a new behaviour.
- The shared-tier definition in `split-shared-board-state-from-machine-local-runtime.md` gains `plan_tickets`, and the snapshot projection in `BoardSnapshotPublisher` has to decide whether ticket metadata rides in `board.json` — probably a bounded subset, not the body.
- `get-tickets`, the ClickUp/Linear protocols, and any agent surface describing where ticket data lives need updating.

**Migration**
- The two id columns shipped and are populated. This is additive: create `plan_tickets`, backfill from `linear_issue_links` and from any parseable file cache present, and leave both id columns and every file in place. A plan whose ticket cannot be resolved gets a row with the id and nulls, never a fabricated field.
- Never invent metadata for a historical link. Unknown stays unknown.

## Dependencies

- **Requires** the tier split, which decides that `plan_tickets` is shared state.
- **Feeds** the projections (Linear round-trip legibility) and the `board.json` snapshot. ~~the shared-store plans (this is part of what travels)~~ — **corrected 2026-09-11:** there are no shared-store plans downstream; libSQL is rejected and the board database is the store.
- **Fixes the root of** the two documented sync-badge bugs, without depending on them.

## Adversarial Synthesis

Key risks: a typed core forces per-field provider mappings where a wrong mapping asserts a false equivalence; the file cache and board record will disagree and the badge-reading ambiguity is already a documented bug class; ticket bodies and comment threads are the largest text the board would hold and the most expensive to replicate; and assignee identities now travel to shared stores and projections. Mitigations: typed core kept deliberately small with a provider payload for everything else; the board record declared the board's truth and the cache declared the panel's, with badges reading the former; bodies stored with hashes, sized, and excludable; and the privacy consequence stated with an opt-out rather than discovered.

## Proposed Changes

1. **`plan_tickets` table** — typed core (provider, external id, url, title, state, assignee, labels, parent, team/project, estimate, source-updated-at, fetched-at) plus a JSON payload for provider extras. Not one row per plan: keyed to allow several plans per ticket and several tickets per plan.
2. **Populate on import** — the ticket-as-plan path writes the snapshot; refetch updates it and bumps `fetched-at`; source-updated-at makes staleness visible.
3. **Body and comments** stored with content hashes, sized and excludable by setting, referenced attachments by URL only.
4. **Badge and drilldown reads** repointed at the board record for imported tickets, retiring the cross-read.
5. **Shared-tier registration** — `plan_tickets` is shared board state, so it travels with the Board store; a bounded subset (not the body) rides in `board.json`.
6. **Backfill** from `linear_issue_links` and the file cache, leaving both id columns and all files in place.
7. **Orphan marking** for tickets deleted upstream or plans unlinked, retaining the snapshot.

### Migration

Additive. Nothing removed, nothing unlinked, nothing fabricated. A link that cannot be resolved yields a row with the id and nulls.

## Verification Plan

- **Clone survival:** import a Linear ticket as a plan, then clone the repo fresh on another machine against the same Board store. Assert the plan shows assignee, state, labels and body — the requirement, tested directly.
- **`git clean -xdf` survival:** same, after wiping untracked files. Assert nothing ticket-related is lost.
- **Teammate visibility:** two machines, one shared Board store, one importer. Assert the non-importing machine renders the full ticket context.
- **Provider mapping:** import from Linear and from ClickUp; assert the typed core is populated correctly for both and that no provider-specific field was force-fitted into a core column.
- **Staleness:** change the ticket upstream. Assert the board shows the snapshot with visible staleness, and that a refetch updates it and bumps `fetched-at`.
- **Badge correctness:** reproduce the two documented sync-badge bugs' conditions; assert the badge now reads the board record and is correct.
- **Body exclusion:** with bodies excluded by setting, assert no ticket body reaches the store, the snapshot, or any projection.
- **Backfill honesty:** an existing install with populated `linear_issue_id` values and no file cache. Assert rows are created with ids and nulls, and that no field was invented.
- **Size:** measure `plan_tickets` bytes per ticket with and without bodies. *(2026-09-11: the "replica sync cost against the shared-store budget" half is void — there is no replica. The measurement still matters, against the board database's own working-set size and the board-only 1 GB host in `two-configurations-board-only-and-board-plus-agents.md`.)*

### Goal Invariants

- **`plan_tickets` exists and is shared tier:** assert the `plan_tickets` table exists in the schema and is named as shared tier in `src/services/storageTiers.ts` (owned by the tier-split plan; this plan consumes that registration).
- **Metadata resolvable without files:** assert an imported ticket's assignee, state, and labels are resolvable from the Board store alone, with `.switchboard/tickets/` files absent — clone survival (positive paired with "files are not the source of truth for imported tickets").
- **Legacy id columns preserved:** assert `plans.linear_issue_id` and `plans.clickup_task_id` remain present and populated — the keep-as-is requirement, not removed.
- **Badge reads the board record:** assert ticket badge/drilldown logic for imported tickets reads through the board-record accessor, not the file cache — the documented cross-read bugs' structural fix.
- **No fabricated metadata:** assert a backfilled link that cannot be resolved yields a row with the id and nulls, never an invented field.

## Outstanding Questions

- Should ticket metadata be refetched on a schedule, or strictly on demand? A schedule keeps cards fresh and adds provider API traffic per machine — which the sync-owner lease would then need to govern.
- Do comments belong at all, or is the body plus a link sufficient? Comments are the fastest-growing field and the least often needed on a card.
- Does an imported ticket's state map onto the board column, or stay independent? Mapping it means Linear can move cards, which crosses from projection into authority.

## Implementation Summary

`plan_tickets` was added as a shared-tier table (migration V75, additive) holding a typed core plus a provider payload, keyed `(plan_id, provider, external_id)` so several plans may share a ticket and a plan may carry several. `src/services/planTickets.ts` owns the typed core, the Linear and ClickUp mappers, the content policy (bodies/comments excludable and size-capped), and the bounded `board.json` projection. `TaskViewerProvider` writes the snapshot on the import-ticket-as-plan path; `TicketsPanelProvider` refreshes it on refetch, marks it orphaned when the provider no longer has the ticket, and answers imported tickets' badges from the board record with an explicit `syncSource` per row. The V75 backfill reads `plans.linear_issue_id`/`clickup_task_id`, `linear_issue_links` and any parseable file cache, tagging each row with the path that wrote it and leaving unresolvable fields NULL.

## Review Findings

Reviewed `c3561c23`. This subtask is the strongest of the four and needed no code fixes: the inbound field-existence check passes end to end — `LinearIssue`'s `project`, `labels`, `parentId`, `state.type` and `url` are written by `LinearSyncService._normalizeLinearIssue` and selected by the `getIssue` GraphQL query, not merely declared on the interface; `plan_tickets`' 33-column insert matches its 35 placeholders and its DDL; and the `includeBodies=false` read rewrites only `body,`/`comments,` and not `body_hash`/`comments_excluded`. `null` is preserved as "never told" throughout, `bodyExcluded`/`commentsExcluded`/`metadataSource` keep policy exclusion distinguishable from absence, and the standalone parity gap the coder found and closed (no adapter factories, a cache service with no `KanbanDatabase`, and five import commands registered only in `extension.ts` whose vscodeShim no-op *resolved*, so standalone reported successful imports that created no plan) is exactly the composition-root class CLAUDE.md warns about. The only change made for this subtask was gate wiring: `test:contract:plan-tickets` was already invoked by CI, but its sibling `board-snapshot-bidirectional-contract.test.js` — which pins that the ticket projection carries no body, comments or attachments — had no npm script and no CI step, so that is now wired. Validation: plan-tickets 37/37, board-snapshot-bidirectional pass, `tsc -p tsconfig.test.json --noEmit` exits 0.

## Deferred Findings

- MAJOR — The detail-load handler now writes to the database. `_refreshBoardTicketRecords` upserts and calls `_persist()` for every plan linked to the ticket on each `linearTaskDetails`/`clickupTaskDetails` load, on what was previously a strictly memory-only read path. Correct per Proposed Change 2 ("refresh on demand and on refetch"), but it puts a write on a click path and re-resolves + logs the content policy per load: `src/services/TicketsPanelProvider.ts:2770`, `src/services/TicketsPanelProvider.ts:2857`.
- NIT — `_applyBoardTicketRecords` sets `t.imported` on every row, and no webview reads it; `syncSource`/`syncStatus` carry the actual signal: `src/services/TicketsPanelProvider.ts:2779` region.
- NIT — The ClickUp orphan-mark arm is called without the `if (workspaceRoot)` guard its Linear counterpart has. Harmless (`_kanbanDbFor('')` returns null) but asymmetric: `src/services/TicketsPanelProvider.ts:2903`.
- NIT — `estimate` is typed, migrated and never populated for either provider, by design ("the column exists so a later fetch has somewhere honest to land"). Recorded so a future reader does not read the NULL as a fetch failure: `src/services/planTickets.ts:104`.
- NIT — Body/comment size is measured by the contract test (full row 1104B, bodies excluded 881B, `board.json` projection 341B). The "replica budget" it was to be reported against does not exist and will not (libSQL rejected, 2026-09-11); the useful comparison is the board database's working-set size on a 1 GB board-only host.
