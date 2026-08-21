# There is no way to ask the orchestrator anything from a tracker — add an instructions column whose cards are messages, not work

## Goal

Give the project-management layer a remote inbox. Today every remote card is work to be staged and coded; there is no card type meaning "a note for the orchestrator." Adding one lets a user away from their desk ask for board organisation, advice on which plans to queue, whether worktrees are needed, or a pre-flight check — and read the answer where their tracker's own notifications will alert them.

### Problem Analysis

The orchestrator is an optional organisation layer, not a dispatch mechanism. It is what you reach for when you want an agent to organise the board, when the teams UI is more than you want to drive, when you want advice on which plans to queue, or when you are running everything through an external agentic app. It is a project manager.

It has exactly two entry points, both local and both deliberate: the AUTOMATION tab's Start orchestrator button, and `POST /kanban/orchestration/start`. From a tracker there is none. Every remote delta is interpreted as a plan: `stateKeyToColumn` maps its status to a local column and the card is either mirrored or staged for coding. A card that is a *question* has nowhere to land.

The primitives this needs already exist and are already provider-agnostic:

- **Detection** — `provider.fetchStateDeltas(cursor)` at `RemoteControlService:675`, implemented by all three providers.
- **Column mapping** — `provider.stateKeyToColumn(stateKey)` at `:694`, on the `RemoteProvider` interface, all three.
- **Write-back** — `postManagedComment` (`NotionFetchService:235`, surfaced via `NotionRemoteProvider:246`) and `updateIssueDescription` for Linear. `commentMarker.ts:9` notes the marker is applied host-side, never by the agent, so a Switchboard reply is already distinguishable from a human comment.
- **Provider factory** — `KanbanProvider:2534/2539/2544` builds ClickUp, Linear and Notion behind one factory keyed on `RemoteProviderKind`.

So nothing here needs new transport or a new poll loop. What is missing is a card *type* and its routing.

Notifications need no work at all: the reply is written back onto the originating card, and the tracker's own subscription bells fire. Switchboard should not build a notification channel it would then have to maintain across three platforms.

### Root Cause

Remote control was designed around plans, because plans were the only thing worth syncing. The orchestrator arrived later as a local, human-invoked layer, and nothing connected the two. The card model has one type where it needs two.

### Non-goals

- **No automatic orchestrator wake.** A note is a request; seating a PM because a card appeared in a work column is the mistake the sibling plan removes. This trigger is a user deliberately writing in a specific column.
- **No notification system.** The tracker's own alerts do this, which is the whole point of replying onto the card.
- Not routing to individual terminal agents. Per-agent messaging is the orchestrator's job once it is seated, not this mechanism's.
- Not a general chat surface. One column, one card per request, one reply thread.

## Metadata

**Complexity:** 5
**Tags:** remote-control, orchestrator, providers, remote

## User Review Required

None.

## Complexity Audit

### Routine
- Reusing `fetchStateDeltas` and the existing write-back methods.

### Complex / Risky
- **The card must never be mistaken for work.** `stateKeyToColumn` maps a remote state onto *any* local column, and the existing dispatch-column guard exists precisely because an unguarded branch will code a card someone moved to COMPLETED. An instructions card leaking into a coding column is the same failure with a worse blast radius: it would be coded as if it were a plan.
- **The orchestrator may not be seated, and must not be seated automatically.** The correct behaviour when no orchestrator exists needs deciding and stating — hold the request and reply that it is queued, or reply that none is running. Writing a report when no orchestrator exists is a known failure mode in this codebase.
- **Reply idempotency.** A poll loop that re-reads the same card must not answer twice. The comment path already solves this with a capped seen-set in the DB `config` table plus an `authoredBySelf` guard; this must reuse that shape rather than invent one.

## Edge-Case & Dependency Audit

- **The instructions column must never resolve to a queueable destination, and must be excluded from plan ingestion**, so a note never becomes a plan file or a queue entry. Today that means excluding it from `QUEUEABLE_TARGET_COLUMNS`. Once `staging-column-replaces-dispatch-view.md` lands, that set is expected to disappear — STAGING becomes a real column and staging is determined by an explicit provider-list mapping rather than inferred from a global mode. The requirement then becomes simpler and stronger: the instructions column must not be mapped to STAGING. Express it against whichever mechanism is current, and note that the mapping must be an explicit link, never a name match — `stateKeyToColumn` maps a remote state onto *any* local column.
- **Self-authored replies must not re-trigger.** `authoredBySelf` and the host-side comment marker are the existing defences; reuse both.
- **A note on an untracked card** — the comment path logs and skips rather than dispatching. Match that.
- **Truncated fetch.** `reconcileLiveIds` has already shipped a false-complete on a page cap for Notion and Linear, fixed by reporting INCOMPLETE. Any bulk read here inherits that requirement.
- **Long replies.** Linear descriptions and Notion comments have limits; a long orchestrator answer needs truncation with a pointer rather than a silent failure.
- **All three providers or none.** This rides the seam, so it should be declared as a capability alongside the board-sync work rather than implemented per provider — otherwise it becomes the next asymmetry that hides.
- **`planId`, never `sessionId`** for any card linkage.

## Dependencies

- **Should land after the `queueSequencing` removal**, so the only orchestrator triggers in the system are deliberate ones and the two are not confused.
- **Relates to the provider-capability feature.** If board sync is becoming a declared capability with a contract test, this belongs in the same enumeration rather than as three separate implementations.

## Adversarial Synthesis

The tempting shortcut is to reuse the comment bus — a comment on any card becomes an orchestrator instruction. That is the per-card micro-control model this system is moving away from, it re-dispatches a column role rather than reaching the PM layer, and ClickUp cannot do it at all. A dedicated column is one interface, works identically on all three trackers, and matches how these tools are actually used: bulk moves and queued work, not per-card conversation.

The second temptation is to auto-seat an orchestrator when a note arrives, so a reply always comes. That reintroduces the automatic wake being deleted in the sibling plan. A note left unanswered because no PM is on duty is the correct behaviour, provided the reply says so.

## Proposed Changes

1. **Define an instructions column convention** recognised across all three providers, excluded from queueable columns and from plan ingestion.
2. **Route its cards to the orchestrator as messages**, not plans — no plan file, no queue position, no role dispatch.
3. **Write the reply back onto the originating card**, host-marked, so the tracker's own notifications alert the user.
4. **Handle the no-orchestrator case explicitly** with a truthful reply rather than silence, and without seating one.
5. **Reuse the seen-set and `authoredBySelf` guards** so a reply is never duplicated and never re-triggers.
6. **Declare it as a provider capability** so any provider lacking it is visible rather than stubbed.

### Migration

None. Additive: a column that does not exist in a user's tracker simply never produces deltas.

## Verification Plan

1. **End to end on each provider.** Drop a note in the instructions column in Notion, Linear and ClickUp; confirm the orchestrator receives it and the reply appears on that card.
2. **A note never becomes work.** Confirm no plan file is written, no queue position assigned, and no coder dispatched.
3. **No orchestrator seated.** With none running, confirm the reply says so and confirm no Orchestrator terminal is created.
4. **No duplicate replies.** Run several poll cycles over an answered card; confirm exactly one reply.
5. **The reply does not re-trigger.** Confirm the host-marked reply is filtered by `authoredBySelf`.
6. **Truncated fetch refuses.** Force a page cap; confirm INCOMPLETE is reported and nothing is applied.
7. **Long reply.** Exceed the provider's field limit; confirm truncation with a pointer, not a silent drop.
8. **Column-mapping guard.** Confirm an instructions card cannot resolve to a queueable column.

## Outstanding Questions

None.
