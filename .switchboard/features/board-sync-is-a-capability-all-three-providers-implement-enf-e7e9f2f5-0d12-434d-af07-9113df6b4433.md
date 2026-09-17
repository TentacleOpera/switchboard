# Board sync is a capability all three providers implement, enforced by a contract test

**Complexity:** 6

## Goal

**REVISED — 2026-09-16. Board sync is no longer a capability; it is removed.**

The original goal was to make board push/restore a declared capability across all
three providers and enforce symmetry with a contract test. The structural half of
that landed and was worth it: `RemoteProviderCapabilities` is now the seam's only
interface, every provider is enumerated from source, and asymmetries must carry a
typed exemption. That test stays.

The board-sync half is deleted. The whole-board projection into a tracker was a
sql.js-era hedge against a fragile local store; the store is one better-sqlite3
database owned by one host now, so the premise no longer exists. Restoring a board
out of a SaaS tracker is also the wrong shape for a Pi appliance — recovery is a
system-level concern, not the board's job. And the parity framing inverted cause
and effect: Notion's restore was an accident nobody designed (the plans below say
so), and it was being used as the standard two other providers had to be dragged
up to.

What was actually wanted — getting an existing board into a tracker in bulk — is
the per-project **seed**, which is different work with a different shape: it needs
a `(workspace_id, provider, board_project)` destination mapping, because Linear's
`_resolveSingleIncludeProjectId` resolves one project for the entire config. See
`seed-board-projects-to-linear-projects.md`, `seed-board-projects-to-clickup-lists.md`
and `seed-controls-in-linear-and-connections-panels.md`. Mass ticket→plan import
already exists in the Tickets panel ("Import All as Plans").

Removed in full: `boardPush`/`boardRestore` capabilities, `boardSyncPush`/
`boardSyncRestore` on the seam, `NotionSyncService.backupToNotion`/
`restoreFromNotion`, `ClickUpSyncService.restoreBoardFromClickUp`,
`LinearSyncService.restoreFromLinear` + the anchor backfill, and the Notion
Backup / Break-Glass Restore UI. The contract test now ratchets against all of it
returning. Kept: the Notion plans-database projection itself, because Remote
Control (`setupRemoteControl`) is built on it, and the Linear planId description
anchor, which the seed will want for re-runnable attach.

## How the Subtasks Achieve This

- **Board sync is a seam with no interface — extend RemoteProviderCapabilities and add the contract test** — **KEPT, and it is the part that survived.** The seam now has one enumeration: providers discovered from source, capability fields re-parsed from the interface, every asymmetry carrying a typed exemption. It also now ratchets `boardPush`/`boardRestore` *out* — a provider that re-implements `boardSyncPush`/`boardSyncRestore`, or re-declares either capability, fails the test.
- **Notion's board sync is misnamed as "backup" and sits outside the provider seam** — **SUPERSEDED.** Renaming it behind the seam was the right read of a wrong thing: it was a board backup, and board backup is not this product's job. `backupToNotion` and `restoreFromNotion` are deleted along with the Backup / Break-Glass Restore UI. The Notion **plans database itself is kept** — `setupRemoteControl` builds on it and reuses its schema, and the two "byte-identical to the shipped schema" tests still guard the property names in real user workspaces.
- **ClickUp can already be queried by planId but cannot rebuild a board** — **CANCELLED and reverted.** `restoreBoardFromClickUp`, `getListTasksWithCompleteness` and the normalized `ClickUpTask.customFields` are removed. The three planId anchors ClickUp already writes stay; they cost nothing and the seed can use them.
- **Linear issues carry no planId, so a board can never be rebuilt from Linear** — **CANCELLED and reverted.** `restoreFromLinear`, `backfillPlanIdAnchors`, `ensurePlanIdAnchorBackfill` and the backfill progress key are removed. This work was uncommitted in the working tree, and the auto-run backfill was never wired to a caller, so nothing had ever written to a user's Linear issues. **The description anchor is kept** (`linearPlanIdAnchor.ts`, `[Switchboard] Plan: {planId}`) — it is cheap, already wired into the push path, and the seed needs exactly that identity to make "attach on re-run" work.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [ClickUp can already be queried by planId but cannot rebuild a board — add the restore orchestration](../plans/clickup-board-restore.md) — **LEAD CODED** — ID: 1d7f31cf-781c-4a65-9ef7-5c159163f86c
- [ ] [Board sync is a seam with no interface — extend RemoteProviderCapabilities to cover it and add the contract test that keeps it symmetric](../plans/provider-capability-board-sync-and-contract-test.md) — **LEAD CODED** — ID: cbba7fc1-2227-4eee-847b-10531983770c
- [ ] [Notion's board sync is misnamed as "backup" and sits outside the provider seam — move it behind the interface without breaking shipped Notion databases](../plans/notion-board-sync-behind-the-seam.md) — **LEAD CODED** — ID: 1ba7ecd9-04bb-4f15-a27d-cbf4f99642a4
- [ ] [Linear issues carry no planId, so a board can never be rebuilt from Linear — add the anchor, then the restore](../plans/linear-board-restore-and-planid-anchor.md) — **LEAD CODED** — ID: 91784573-2765-4442-916b-d3263b6661ae
- [ ] [The Linear Agent Surface Reconciles Destructively, Never Ends a Session, and Cannot Authenticate at All](../plans/memo-the-linear-agent-surface-reconciles-destructively-and-cannot-authenticate.md) — **LEAD CODED** — ID: 97a3d80b-47a1-4394-95ab-c5c54737e708
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Obsolete — the sequencing below described landing three board-sync
implementations in order, and three of the four subtasks are cancelled.** The one
surviving subtask (the capability interface + contract test) has landed.

The successor work is the per-project seed, and it has its own ordering:

1. **`seed-board-projects-to-linear-projects.md`** — introduces the shared
   `(workspace_id, provider, board_project)` destination mapping and the seed pass.
   Everything else depends on it.
2. **`clickup-columns-are-statuses-not-lists.md`** — ClickUp cannot own a list per
   project while every column owns one.
3. **`seed-board-projects-to-clickup-lists.md`** — the ClickUp seed, through the
   same interface and the same mapping table. Must not duplicate it per provider.
4. **`seed-controls-in-linear-and-connections-panels.md`** — the surface. Explicitly
   not in the Tickets panel, which already has `syncAllTickets` and would invite
   exactly the confusion the seed exists to resolve.

**Do not revive board push/restore to serve the seed.** They are different
operations: the seed targets a chosen remote project per board project, whereas
`boardPush` had a single destination for the whole config and `boardRestore`
answered a recovery question this product does not take on.

