# Imported ticket metadata is gitignored files and two bare id strings — make it first-class shared board state

## Goal

Make a plan imported from Linear (or ClickUp) carry everything associated with its ticket, in the board's own store, so the association survives a fresh clone, reaches a teammate, and travels to a shared store. Linear stays the team's coordination surface — Switchboard is not competing with it — which is exactly why the board must faithfully hold what Linear told it.

### Problem Analysis

**The board knows a ticket's id and nothing else.** `plans` carries `clickup_task_id TEXT DEFAULT ''` and `linear_issue_id TEXT DEFAULT ''` (`KanbanDatabase.ts:217-218`), plus a `linear_issue_links` table (`:264`). Two opaque strings. Not assignee, state, labels, cycle, estimate, team, parent, project, description, comments or attachments — none of the metadata that makes a ticket legible.

**The metadata that *is* imported lands in gitignored files.** `TicketsPanelProvider` reads and watches `.switchboard/tickets/<provider>/` (`:323`, `:373`, `:524`, `:614`), and `.gitignore:52` is `.switchboard/*` with whitelists for `plans/`, `features/`, `reviews/`, `sessions/` — and none for `tickets/`. So imported ticket content is machine-local, untracked files.

Three consequences follow, and all three contradict a Linear-first product:

1. **A teammate sees the plan and not the ticket.** Plans are committed markdown; ticket metadata is not. Whoever imported the ticket is the only person whose Switchboard knows what it said.
2. **A fresh clone loses it.** The plan comes back from git; the ticket context does not. Same for a worktree, and `git clean -xdf` takes it.
3. **A shared store cannot carry it.** Board state is what travels to a libSQL or git-carried store. Ticket metadata is not board state today, so a shared board is a board where imported tickets are half-blank for everyone but one machine.

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
- **Feeds** the shared-store plans (this is part of what travels) and the projections (Linear round-trip legibility).
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
- **Size:** measure `plan_tickets` bytes per ticket with and without bodies, and report replica sync cost against the shared-store budget.

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
