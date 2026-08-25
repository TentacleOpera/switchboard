# A team has no card to report to, though the comment primitive that would carry the report is built

## Goal

Let the operator bind an agent team to a Linear/Notion/ClickUp card so the team's lead posts its
status there, readable from a phone. The write-back primitive, its guard, and the agents'
instruction to use it all exist. What is missing is a **destination for a team**, because every
existing write-back is scoped to a plan's own card.

> **This plan was rewritten after review.** Its first draft proposed reading the team report
> inbox non-destructively, tracking a posted-watermark, and mirroring into a delimited region of
> the card description — a mechanism it would have had to build. That was wrong: the lead can
> post directly through the existing comment bridge, which is host-side, marker-stamped and
> already used for agent replies. The watermark, the non-destructive read and the
> description-region machinery are all unnecessary and are not part of this plan.

### Problem Analysis

**The write-back primitive is built, guarded, and provider-agnostic.**
`LinearSyncService.postManagedComment(issueId, body)` (`:1444`) runs host-side where the token
lives, truncates to 64k, and stamps a self-marker. `src/services/commentMarker.ts:9` records that
the marker is "applied HOST-SIDE only (in `postManagedComment`), never by the agent" — which is
what stops Switchboard's own comments from being re-ingested as user input. Agents reach it
through the `/comment` route (`LocalApiServer.ts:1436`) and "never call the provider API directly
and never touch the marker, so they cannot break the feedback-loop guard" (`:1439-1442`).
`NotionFetchService` (`:235`) and `ClickUpSyncService` (`:1790`) implement the same method, and
`RemoteProvider` (`:120`) abstracts over them, so this works for all three trackers.

**Agents are already told to use it.** `REMOTE_MODE_DIRECTIVE`
(`src/services/agentPromptBuilder.ts:839`) is injected into **all roles** when the dispatched
card's board is under remote control, per-board gated at `KanbanProvider.ts:3202` and `:6080`. Its
own comment states the intent: "The user is on their phone, not the terminal, so questions must go
to the linked issue as a comment." Inbound, `fetchIssueUpdates` batches state plus recent comments
with an author flag so the marker filters Switchboard's own out.

**So a card-scoped conversation with an agent already works end to end.** The loop is not missing.

**What is missing is that a *team* has no card.** Every write-back path resolves its destination
from a plan — the plan's synced issue is the card. A team is not a plan: it is started by
`ptyStartTeam`, carries team-scoped standing orders (`standingOrders.ts:5-24`, `scope: 'team'` with
a `teamId`), and owns a report inbox at `.switchboard/teams/<teamId>/reports/`. Nothing maps a
`teamId` to an issue, so a lead that wanted to post its team's status has no `issueId` to pass.

**And nothing tells a lead to post status periodically.** `REMOTE_MODE_DIRECTIVE` covers questions
and blockers — event-driven, agent-initiated. A standing "keep this card current with your team's
status" instruction is a different thing, and team-scoped standing orders are exactly the
mechanism for it, with a definitions library (`StandingOrderDefinition`, `:33`) so the wording is
authored once and `syncDefinitionToAssignments` keeps assignments current.

### Root Cause

Tracker write-back was built plan-first, because the sync's unit of identity is a plan and its
issue. Teams arrived as a dispatch concept with their own lifecycle and their own inbox, and never
acquired a tracker identity. So the question "which card does this team talk to?" has never had a
place to be answered.

### Non-goals

- **Not a new write-back mechanism.** Uses `postManagedComment` through the existing `/comment`
  route. No new marker handling, no new size cap, no new provider code.
- **Not touching the report inbox.** The documented external-lead claim loop
  (`GET /teams/<id>/reports`, `POST /reports/claim`) is unchanged and uninvolved. The lead posts;
  nothing reads the inbox on the lead's behalf.
- **Not a description mirror.** Comments, not a managed region of the description — the primitive
  is a comment primitive and the marker guard lives there.
- **Not real-time.** Whatever cadence the standing order asks for, plus the tracker's own poll.
- **No new auth, no exposure.** Existing host-side bridge on the operator's machine.

## Metadata

**Complexity:** 3
**Tags:** backend, feature, devops, docs

## User Review Required

Yes — two decisions.

1. **Where does the `teamId → issueId` binding live?** Recommendation: **the remote/tracker
   config**, alongside the existing board mapping, not on the standing order. A standing order
   saying "report your status" is valid with no tracker configured; putting an issue id on it
   couples a transport-agnostic instruction to one provider. The config already holds the board
   mapping, so this is the same kind of thing in the same place.
2. **Is the card a dedicated one, or an existing plan card?** Recommendation: **a dedicated card
   per team**, created or nominated by the operator. Posting team status onto a plan's card mixes
   two conversations on one thread — the plan's own agent replies and the team's periodic status —
   and the inbound route would then send the operator's reply to the card's column agent rather
   than the team, which is a confusing failure.

## Complexity Audit

### Routine

- A `teamId → issueId` map in the remote config, with UI in the Remote tab.
- Resolving that binding when a lead asks to post, so the lead does not need to know an issue id.
- A reusable status-reporting `StandingOrderDefinition` assigned per team at `scope: 'team'`.

### Complex / Risky

- **Prompt compliance is the whole dependency.** A standing order is text in an agent's context.
  Leads will report inconsistently or forget. There is no code fix; the honest design is that the
  card shows what the lead last said and *when*, so silence reads as silence rather than as
  current status. Do not build a schema the lead is assumed to follow.
- **The lead needs the destination without holding an issue id.** If the lead has to be told an
  issue id in its prompt, the binding rots the moment the operator rebinds. Better: the lead asks
  to post "my team's status" and the host resolves the binding at call time — which also keeps the
  issue id out of agent context entirely.
- **Inbound replies have no team route.** A comment on a plan's card routes to that card's current
  column agent. A comment on a *team's* card has no such mapping — the operator will reply on it,
  and that reply needs to reach the lead or be visibly unsupported. Shipping outbound-only with
  the limitation stated is acceptable; shipping it silently is not, because a reply that vanishes
  is worse than no reply channel.
- **Audience.** Posting team status publishes agent output to everyone with tracker project
  access. An agent that prints a token into a status line has published it, in a searchable tool
  with notification emails. `postManagedComment`'s 64k truncation bounds size, not sensitivity.
  Opt-in per team, and say so in the docs.

## Edge-Case & Dependency Audit

**Race conditions**
- Two leads bound to one card: interleaved status with no attribution. Either refuse the binding
  or require the lead to identify itself in the post.
- Binding changed while a post is in flight: resolve at call time, so the post lands on whichever
  card is bound then — and never cache the id in agent context.

**Security**
- The marker guard is why this is safe and must not be bypassed: the lead posts through
  `/comment`, never the provider API, so Switchboard's own comment cannot be re-ingested as
  operator input. Any shortcut that has the lead call Linear directly reintroduces the feedback
  loop the marker exists to prevent.
- Team ids are workspace-scoped; a binding must not let one workspace's team post to another's
  card.
- No new exposure; no new credential path.

**Side effects**
- The Remote tab gains a per-team binding, which is where the phone-facing behaviour becomes
  discoverable.
- Team cards appear in the tracker project alongside plan cards. They are not plans, so the
  inbound poll must not try to import them as plans — this is the most likely way to break
  something that currently works.

**Migration**
- The binding lives in the remote config, so `terminals.standingOrders` and
  `terminals.standingOrderDefinitions` need no shape change and every stored order loads
  unchanged. Existing remote configs load with no bindings and post nothing.

## Dependencies

- **Reuses** `postManagedComment`, the `/comment` route, `RemoteProvider`, and the standing-order
  definitions library. Adds no primitive.
- **Related:** `automation-rules-can-target-a-column-but-not-a-team.md` needs the same
  `teamId → issueId` binding for its completion write-back. That binding should be defined once,
  here, and used there.
- **Supersedes** the coordination note in both plans about agreeing on a shared write-back
  mechanism. There is nothing to agree: `postManagedComment` is the mechanism.

## Adversarial Synthesis

Key risks: (1) rebuilding a mirror mechanism when a comment primitive with a feedback-loop guard
already exists — the first draft's mistake; (2) putting an issue id in agent context, so the
binding rots on rebind; (3) assuming leads comply with a report cadence, leaving stale status
presented as current; (4) an operator replying on a team card and the reply going nowhere,
silently; (5) publishing agent output to a wide audience by default; (6) the inbound poll trying
to import team cards as plans. Mitigations: use the existing primitive unchanged; resolve the
binding host-side at call time; render last-reported-at so silence is visible; state the
outbound-only limitation in the UI and the docs; opt-in per team; and exclude bound team cards
from plan import explicitly, with a test.

## Proposed Changes

1. **A `teamId → issueId` binding** in the remote config, surfaced in the Remote tab, opt-in per
   team, shared with the label-to-team plan.
2. **Host-side resolution** so a lead can post "my team's status" without ever holding an issue
   id, going through the existing `/comment` route and `postManagedComment`.
3. **A reusable status-reporting `StandingOrderDefinition`** assigned per team at `scope: 'team'`,
   so wording is authored once and propagates through the existing definition sync.
4. **Last-reported-at rendering** so a quiet team reads as quiet, not as current.
5. **Exclude bound team cards from plan import.**
6. **Docs**: state the audience consequence, and state that team cards are outbound-only until an
   inbound team route exists.

### Migration

Additive. Standing-order storage is untouched; remote configs load with no bindings and post
nothing.

## Verification Plan

1. **The phone test.** Bind a team, run it, read its status from the tracker's mobile app without
   touching the host.
2. **Marker guard intact.** Assert the lead's post is stamped host-side and that the inbound poll
   filters it out — a team post must never be re-ingested as operator input. This is the
   regression that would create a loop.
3. **No issue id in agent context.** Grep the lead's rendered prompt and assert the bound issue id
   does not appear.
4. **Rebinding takes effect immediately.** Change the binding and assert the next post lands on
   the new card with no restart.
5. **Report inbox untouched.** With posting active, run the documented external-lead loop and
   assert every report is still claimable.
6. **Silence is visible.** Run a lead that ignores the standing order; assert the card shows when
   it last reported rather than presenting old status as current.
7. **Team cards are not imported as plans.** Assert the inbound poll skips them and creates no
   plan file.
8. **Reply behaviour is honest.** Comment on a team card as the operator; assert the documented
   behaviour (unsupported, and visibly so) rather than a silent drop.
9. **Opt-in.** With no binding, assert nothing is posted.
10. **Existing configs load.** Load a remote config and standing-orders blob saved before this
    change; assert identical behaviour and no dropped keys.
11. **All three providers.** Verify through `RemoteProvider` against Linear, and confirm the
    Notion and ClickUp implementations are reached by the same path.
