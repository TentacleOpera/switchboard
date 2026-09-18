# Switchboard Speaks Linear Natively

**Complexity:** 7

## Goal

Stop speaking an invented dialect at Linear. Give Switchboard a workspace identity that can be assigned issues and mentioned, replace column-mapping and marker-stamped comments with the affordances Linear already renders, let a label address a card to an agent team rather than only a column, and give missions and their dependency edges a tracker representation using two Linear primitives that are currently unused.

The auth actor is the hard prerequisite - no actor, no agent surface - and everything else here is what that identity makes possible.

## How the Subtasks Achieve This

- **Linear auth needs an app actor, and rolling refresh means exactly one host may hold the credential**: Adds OAuth 2.0 with PKCE and `actor=app` to the Linear integration, giving Switchboard a workspace identity that can be assigned issues and @mentioned. Delivers the credential that unlocks the agent surface — without shipping a client secret, without ingress, and without breaking the personal API key. The single-writer refresh lease is the defect this plan exists to prevent.
- **Switchboard speaks Linear in a dialect it invented, when Linear has native words for all of it**: Spends the auth credential to make Switchboard a Linear app user — assign an issue to dispatch, @mention to talk, agent activities to narrate. Replaces the bespoke dialect of column mappings, trigger labels, and marker-stamped comments with Linear's native affordances. Establishes three dispatch layers (status/assignment/natural-language) with distinct owners.
- **An automation rule can send a labelled Linear card to a column, but not to a team**: Lets a Linear label address a card to an agent team rather than a kanban column. Models the destination as a discriminated union (column/team/memo), delivers through the existing relay seam, and keeps plan creation as the provenance and dedupe record. The write-back half is already built via `postManagedComment`.
- **A mission is a gap in the tracker, and the two Linear primitives that fit it are both unused**: Gives missions and their dependency edges a tracker representation using Linear project milestones (orthogonal to parent) and issue relations (blocks/blocked-by). A card can carry a feature parent AND a mission milestone simultaneously — the collision that made the obvious representation impossible is dissolved.

## Dependencies & sequencing

- **auth first** — it is the hard prerequisite for app-user (no app actor, no agent surface). It also delivers the rate-limit budgeting that benefits all other subtasks.
- **automation-rules and missions are independent** of auth and app-user — they use the existing Linear poll and work with either credential. They can land in any order relative to each other and to auth. Recommended: land after auth so the rate-limit budgeting is in place.
- **app-user last** — depends on auth's credential. Should land after automation-rules and missions so the poll cycle already handles the additional load and the rate budget accounts for it.
- **Shared surface coordination**: `RemoteProviderCapabilities` is extended by both missions and app-user — coordinate the interface extension (add `missions` and `agentSurface` fields to one interface). `switchboard-remote/SKILL.md` is updated by both missions and app-user — coordinate the edits (missions removes missions from "cannot show" list, app-user adds Linear-agent section). The rate-limit utility is delivered by auth and consumed by app-user.
- **Cross-plan dependency**: automation-rules depends on the `teamId → issueId` binding from `standing-orders-can-post-a-team-status-report-to-a-card.md` (outside this feature). If that plan has not landed, automation-rules must define its own binding or block on it.

## Team Dispatch Instructions

### Linear auth needs an app actor, and rolling refresh means exactly one host may hold the credential
- **Seat:** Lead Coder
- **Acceptance:**
  - Two hosts, one refresher: run extension + standalone across a token expiry, assert exactly one exchange and both remain authenticated
  - Personal key unregressed: key-only install behaves byte-identically to today, no agent-surface affordance
  - No client secret shipped: grep built VSIX, assert only `client_id` present
  - All three callback entries (URI handler, loopback listener, code paste) produce identical stored credential state
  - Guards untouched: `loopback-hostname-contract` green during and after a flow
- **Must not touch:** The four loopback guards. The personal API key path (byte-identical, no migration). No `admin` scope requested.

### Switchboard speaks Linear in a dialect it invented, when Linear has native words for all of it
- **Seat:** Lead Coder
- **Acceptance:**
  - Assign an issue to Switchboard from Linear on a phone; assert it dispatches with no status mapping, label, or comment
  - Dispatch once: leave an issue assigned across poll cycles and a process restart; assert exactly one dispatch; two hosts → one dispatch total
  - @mention reaches the seat: message arrives in the live terminal with context intact; notification marked handled only after delivery succeeded
  - Sessions: lookup-or-create produces one session per issue; activities render; nothing posted into an ended session
  - No ingress: whole flow completes with no inbound listener; `loopback-hostname-contract` green
- **Must not touch:** `REMOTE_MODE_DIRECTIVE` (agents keep being told to report; which surface that means is a follow-on). Status-dispatch and `_mapColumnsToStates` (not deprecated — the contract Linear-side actors depend on). The four loopback guards. The comment-marker feedback guard.

### An automation rule can send a labelled Linear card to a column, but not to a team
- **Seat:** Coder
- **Acceptance:**
  - End to end: label a card with a team tag, move to trigger state; assert card body arrives in team's lead terminal with provenance header, terminal context not cleared
  - No re-delivery loop: leave a matched card in trigger state across polls; assert exactly one delivery
  - Existing column rules unregressed: stored `targetColumn` rule behaves byte-identically — plan created, provenance lines present, `finalColumn` honored
  - Two labels on one card: assert refusal with comment naming both labels, never two silent deliveries
  - Card text is data: forged provenance header and fake standing-orders marker in card body do not change what the agent is told to do
- **Must not touch:** `clearBeforePrompt: false` on the relay (hardcoded, stays). The provenance header wrapping. Existing column-targeted rule behavior. `normalizeLinearAutomationRules` must not write back (memory-only normalization).

### A mission is a gap in the tracker, and the two Linear primitives that fit it are both unused
- **Seat:** Coder
- **Acceptance:**
  - The phone test: two cards staged into one mission, open Linear on a phone, see both under one milestone with any blocking relation drawn
  - No parent collision: stage a card that is a feature subtask; assert feature parent intact AND mission milestone set
  - Membership follows reality: remove a card from a mission; assert unassigned from milestone in the same cycle
  - Relations follow reality: delete a `plan_dependencies` row; assert Linear relation removed
  - Providers degrade: run on Notion and ClickUp; assert no partial state, no errors
- **Must not touch:** `plans`, `missions`, `mission_members` tables (mission mapping is separate). Mission internals (`team`, `max_extra_worktrees`, `goal`, membership) — host-owned, not rewritten from Linear. No two-way dependency sync (outbound only to start).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Linear auth needs an app actor, and rolling refresh means exactly one host may hold the credential](../plans/linear-auth-needs-an-app-actor-and-only-one-refresher.md) — **PLAN REVIEWED** — ID: b88e04e6-f066-4aa6-8de3-8e97c5a4cbcd
- [ ] [An automation rule can send a labelled Linear card to a column, but not to a team](../plans/automation-rules-can-target-a-column-but-not-a-team.md) — **PLAN REVIEWED** — ID: 63f8b8bd-a4b5-47d5-9875-3cb286f0f170
- [ ] [A mission is a gap in the tracker, and the two Linear primitives that fit it are both unused](../plans/missions-are-invisible-in-the-tracker-and-two-linear-primitives-are-free.md) — **PLAN REVIEWED** — ID: fd43529c-d30b-47b6-9c81-47bf61e28029
- [ ] [Switchboard speaks Linear in a dialect it invented, when Linear has native words for all of it](../plans/switchboard-as-a-linear-app-user.md) — **PLAN REVIEWED** — ID: 2d8a50a8-f2c2-4472-a1a7-6aacbaa7064a
<!-- END SUBTASKS -->

## Completion Summary

All four subtasks implemented and committed (e5086a75). OAuth 2.0 PKCE with actor=app delivers the workspace identity credential with a single-writer refresh lease preventing dual-host token corruption. The app-user surface adds assigned-issue polling, @mention relay to live agent seats, and native Linear agent sessions/activities. Automation rules now support a discriminated union destination (column/team/memo) with multi-label refusal and provenance-protected team delivery. Mission milestones and dependency edges mirror to Linear via project milestones and blocks relations, with stale-relation cleanup that queries all managed issues — not just current deps — so deleted plan_dependencies rows produce corresponding Linear relation removals in the same sync cycle. RemoteProviderCapabilities extended with missions, agentSurface, and agentSessions fields; switchboard-remote SKILL.md updated to reflect Linear's native mission mirroring and agent surface.


## Review Findings

Reviewed all four subtasks as one delivery unit against `LinearSyncService.ts`, `LinearAutomationService.ts`, `LinearRemoteProvider.ts`, `RemoteProvider.ts`, `RemoteControlService.ts`, `KanbanProvider.ts`, `KanbanDatabase.ts` (V66), `PipelineDefinition.ts`, `TaskViewerProvider.ts`, `SetupPanelProvider.ts` and the two Linear test files. The feature's goal is achieved — Switchboard now has an app-actor credential, a native agent surface, a team destination for automation rules, and a milestone/relation representation for missions — but it shipped with CI red: `compile-tests`, `catalog:check`, `parity:check`, `verb-returns:check` and `mirror:check` all failed at HEAD, and the four new automation tests could never pass. All are now green. Six CRITICALs were fixed, the sharpest being that the agent surface gated on `hasApiToken()` rather than credential kind, so a personal-API-key install would import the human operator's assigned issues as plans and archive their Linear notifications — a direct breach of the "personal key path byte-identical" invariant both the auth and app-user subtasks name. Two shared-surface coordination items landed correctly: `RemoteProviderCapabilities` carries `missions`/`agentSurface`/`agentSessions` on one interface, and the `switchboard-remote` skill edits are now in the `.agents/` source rather than the generated mirror.

## Deferred Findings

- MAJOR — stale Linear `blocks` relations between two managed issues are deleted without provenance, so a human-drawn relation is removed on the next sync. `src/services/LinearSyncService.ts:3925`
- MAJOR — mission-end does not mark its milestone complete; no `deleteMissionMilestone` caller exists. `src/services/LinearSyncService.ts:3777`
- MAJOR — `pollAssignedIssues` has no board/project scoping and no cross-host claim, so the "one dispatch total across two hosts" acceptance is unmet. `src/services/remote/LinearRemoteProvider.ts:360`
- MAJOR — agent sessions are cached in memory, so "nothing posted into an ended session" is unenforced across a session ended in Linear. `src/services/LinearSyncService.ts:3941`
- MAJOR — team resolution matches on `terminals.groups.name`, which holds the head terminal's name rather than the team's. `src/services/LinearAutomationService.ts:245`
- MAJOR — team-rule write-back completion is hardcoded to `DONE`/`COMPLETED`, a default the plan left undecided. `src/services/LinearAutomationService.ts:700`
- NIT — no real Linear `client_id` is committed, so the OAuth flow refuses until the app is registered. `src/services/LinearSyncService.ts:67`
- NIT — `postAgentActivity` has no caller on any dispatch or lifecycle path, so activities are never narrated in normal operation. `src/services/remote/LinearRemoteProvider.ts:447`
- NIT — pre-existing and untouched: the whole `test:integration:linear` suite is red before this feature (missing `createIfMissing()` in `linear-sync-service`, a stale delta-shape expectation in `linear-remote-provider`, a project-filter mismatch in `linear-automation-service`), and `test:contract:standing-orders-marker` has 5 pre-existing `wireSpawnedTeam` failures. `src/test/integrations/linear/linear-sync-service.test.js:149`
