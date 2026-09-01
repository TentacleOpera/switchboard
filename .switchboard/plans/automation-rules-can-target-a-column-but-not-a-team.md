# An automation rule can send a labelled Linear card to a column, but not to a team

## Goal

Let a Linear label address a card to an **agent team** rather than a kanban column, so the
operator can write a card, tag it with a team, and have its content delivered into that team's
terminal with an instruction to update the card and write back. The label-keyed rule engine, the
delivery mechanism and the write-back path all exist; only the destination type is missing.

### Problem Analysis

**The rule engine already keys on a label.** `LinearAutomationRule`
(`src/models/PipelineDefinition.ts:11`) is:

```ts
{ name, enabled?, triggerLabel, triggerStates, targetColumn, finalColumn, writeBackOnComplete }
```

and `matchesLinearAutomationRule` (`:133`) fires only when the issue carries `triggerLabel`
**and** its state id is in `triggerStates`. `LinearAutomationService.poll()` (`:274`) loads the
active rules, derives the watched state ids (`_getWatchedStateIds`, `:97`), queries Linear with
`buildLinearIssueFilter`, and for each match writes a local plan whose body carries
`> **Automation Rule:** <name>` as provenance (`:167`) — which is also how a later poll
re-identifies which rule produced a plan (`:184-191`).

**The write-back half exists too.** `writeBackAutomationResult(issueId, summary, target)`
(`:209`) posts the result to the issue, either as a `commentCreate` mutation or into the
description (`DEFAULT_WRITEBACK_TARGET = 'description'`, `:11`). `writeBackOnComplete` on the
rule is the switch.

**What does not exist is a team destination.** `targetColumn` is a kanban column, and the effect
of the rule is "create a plan and let that column's agent pick it up". There is no way to say
"deliver this to team X". So a label today selects a *stage of the pipeline*, never a *recipient*.

**Delivery into a named terminal is a solved problem, in a different subsystem.**
`POST /terminals/relay` (`LocalApiServer.ts:3867`) delivers a message into a live terminal
without resetting it: `ptyListTerminals` validates the target against the live fleet,
`ptySendPrompt` is called with `clearBeforePrompt: false` **hardcoded** — "there is no field to
omit and no field to get wrong" — and the text is wrapped with a provenance header so the
recipient knows who is talking. Teams are equally real: `ptyStartTeam` starts one, standing
orders carry `scope: 'team'` with a `teamId` (`standingOrders.ts:5-24`), and each team has a
report inbox at `.switchboard/teams/<teamId>/reports/`.

**So the gap is an addressing gap, not a capability gap.** Two subsystems that each do their
half — a label-matched rule engine, and provenance-wrapped delivery into a live terminal — have
never been introduced to each other.

### Root Cause

The automation rules were designed as a *pipeline* feature: a label promotes a card into the
board's flow, and the board's columns decide who works on it. Teams arrived later as a
*dispatch* feature, with their own delivery path and their own standing-order scope. Nothing
forced the two models to meet, so "which column" remained the only expressible destination and
"which team" was never a question the rule shape could ask.

### Non-goals

- **Not replacing column-targeted rules.** `targetColumn` rules keep working exactly as they
  do. This adds a destination kind; it does not migrate the existing one.
- **Not a chat product.** One card, one delivery, one write-back. No threads, no conversation
  state on the card beyond what Linear comments already carry.
- **No new transport.** Delivery uses the existing relay seam. No second socket, no new poller.
- **Not changing relay send semantics.** `clearBeforePrompt: false` stays hardcoded and the
  provenance header stays. A team-addressed card must never reset a working terminal.
- **No public exposure and no new auth.** This runs inside the existing Linear poll on the
  operator's own host.

## Metadata

**Complexity:** 6
**Tags:** backend, feature, api, devops, reliability

## User Review Required

Yes — three decisions.

1. **How is the team named on the rule?** Recommendation: **a `targetTeam` field alongside
   `targetColumn`, with exactly one of the two required.** A rule with both is a configuration
   error that should be refused at normalization time (`normalizeLinearAutomationRules`, `:97`),
   not resolved by precedence — a silent precedence rule is how a card ends up somewhere the
   operator did not intend.
2. **Who in the team receives it?** A team has a lead and workers. Recommendation: **the lead.**
   The lead already owns work distribution and the report inbox, and sending to a worker
   bypasses the coordination the team exists for. This also means the rule does not need to know
   the team's internal shape.
3. **Does a team-addressed card create a local plan as well?** Recommendation: **yes, but say so
   plainly.** The existing plan-creation path is also the provenance record (`> **Automation
   Rule:**`, `> **Linear Issue ID:**`) that makes write-back and dedupe work at `:184-191`. Skip
   it and this feature needs its own tracking store. Reuse it and a team-addressed card is
   visible on the board like anything else, which is probably what the operator wants anyway.

## Complexity Audit

### Routine

- Adding `targetTeam` to the rule interface, its normalizer, and the Linear config UI.
- Resolving a team name to a live team and its lead terminal via the existing seam.
- Composing the delivered text: the card body plus the instruction to update the card and write
  back, wrapped with the existing provenance header.

### Complex / Risky

- **The team may not be running.** A column-targeted rule is satisfied by writing a file; a
  team-targeted one needs a *live terminal*. The poll runs on a timer and cannot start a team on
  the operator's behalf without deciding a lot of policy. So the interesting states are "team
  not started", "team started but lead not registered", and "lead busy" — and each needs a
  resolution that is neither a silent drop nor an infinite retry. A card that was matched,
  delivered nowhere, and left looking dispatched is the worst outcome.
- **Dedupe across polls is currently plan-file-based.** `_extractPlanMetadata` reads the
  `Automation Rule` line out of the plan body to decide whether a card was already handled
  (`:184`). A delivery is not a file, so if the plan-creation path is skipped (decision 3) the
  dedupe key disappears and every poll re-delivers the same card. This is the single most likely
  way to ship a loop that spams a team's terminal every 30-120 seconds.
- **Write-back correlation.** `writeBackAutomationResult` needs the issue id and a summary. For
  a column rule, "complete" is a board transition. For a team rule, "complete" is the team
  saying so — which arrives in the report inbox, not on the board. Bridging that is most of the
  work, and it overlaps with the standing-order reporting plan; the two should agree on one
  mechanism rather than each inventing one.
- **Label collisions.** Rules are matched independently, so a card carrying two team labels
  matches two rules and gets delivered twice. Today the analogous case produces two plans, which
  is visible and harmless; two deliveries into two teams is neither.
- **Instruction text is prompt content.** The "update the card and push back" instruction is
  appended to an agent's context. It must be unambiguous about *which* card, must not conflict
  with the team's standing orders, and is untrusted-adjacent: the card body is operator-authored
  here, but Linear cards can be created by anyone with access to the project.

## Edge-Case & Dependency Audit

**Race conditions**
- Poll overlapping a slow delivery: the next poll must not re-match a card whose delivery is in
  flight. Needs a claim, not just an end-state check.
- Team restarting between match and delivery — terminal ids change, so the id must be resolved
  at delivery time and re-validated, exactly as the relay already does with `ptyListTerminals`.
- Two Switchboard instances polling one Linear project. The poll already calls
  `db.refreshFromDisk()` before dedupe specifically because "outbound syncs from another instance
  are visible immediately" (`:300-303`) — the delivery path needs the same discipline.

**Security**
- **The delivered text reaches an agent's context.** A Linear card is authored by anyone with
  project access, and the instruction wraps it. Treat the body as data: it must not be able to
  redefine the instruction, impersonate the provenance header, or forge a standing order. The
  header wrapping the relay already establishes the pattern; it must be injection-resistant, not
  merely present.
- No new exposure: this is the existing poll, on the operator's host, with the existing token.
- A team's terminal can write the repository. A rule that delivers a card straight into a team
  is therefore a path from "someone filed a Linear card" to "an agent edited code". That is the
  point of the feature, and it should be stated in the docs as such rather than discovered.

**Side effects**
- The Linear config UI gains a destination-kind choice, and existing saved rules must load
  unchanged with `targetTeam` absent.
- Team report volume rises, which interacts with whatever retention the reporting plan settles on.

**Migration**
- **Automation rules ship today**, so `normalizeLinearAutomationRules` must keep accepting every
  stored rule shape with no `targetTeam` and behave identically. New field optional, absent means
  column-targeted, and unknown keys preserved rather than dropped.

## Dependencies

- **Should agree with** `standing-orders-can-post-a-team-status-report-to-a-card.md` on one
  mechanism for a team result reaching a Linear card. Both need it; neither should invent its own.
- **Reuses** the relay seam and the existing poll. No dependency on the phone feature.
- **Related:** `a-message-to-a-terminal-has-no-return-path.md` solves the same
  "how does an answer come back" question for a different sender. If both land, they should share
  one correlation model — worth deciding before either is coded.

## Adversarial Synthesis

Key risks: (1) dropping the plan-creation path and with it the dedupe key, producing a loop that
re-delivers every card each poll; (2) a matched card whose team is not running being silently
dropped while the card looks dispatched; (3) two team labels on one card causing two deliveries;
(4) card text treated as instruction rather than data once it lands in an agent's context; (5)
this plan and the reporting plan each inventing a different card-write-back mechanism.
Mitigations: keep plan creation as the provenance and dedupe record; define explicit
not-running/not-registered/busy resolutions that are visible on the card; refuse or explicitly
resolve multi-label matches at normalization time; wrap card text injection-resistantly; and
settle the write-back mechanism jointly with the reporting plan before implementing either.

## Proposed Changes

1. **`targetTeam` on `LinearAutomationRule`**, with `normalizeLinearAutomationRules` refusing a
   rule that sets both `targetTeam` and `targetColumn`, and preserving unknown keys.
2. **A team destination in the poll**: resolve the team, resolve its lead at delivery time,
   deliver through the existing relay seam with the provenance header plus an instruction naming
   the card and asking for a write-back.
3. **Keep the plan-creation path** as provenance and dedupe, with the plan recording the team it
   was addressed to alongside the existing `Automation Rule` and `Linear Issue ID` lines.
4. **Explicit unresolved states** — team not started, lead not registered, delivery failed —
   each surfaced on the Linear card rather than only in a log, so the operator sees that nothing
   happened.
5. **A claim so a card is delivered once**, robust to overlapping polls and to a second instance.
6. **Multi-label resolution** decided and enforced rather than emergent.
7. **Docs**: state in the Linear/remote documentation that a team-targeted rule is a path from a
   filed card to an agent editing the repository.

### Clarifications

- **Normalizer is memory-only.** `normalizeLinearAutomationRules` maps a stored `targetColumn` to
  `{ kind: 'column', column }` in memory on load. The stored config shape is preserved — old installs
  that downgrade can still read their configs. The normalizer runs on every load; it does not write
  back.
- **Claim mechanism.** The plan-creation path is the dedupe key, but between matching and plan
  creation there is a window where two overlapping polls could both match. The claim should be a
  DB-level insert-if-absent on the plan row (the existing `refreshFromDisk` + plan creation path),
  not a separate lock. The plan file's existence is the claim.
- **Multi-label decision.** A card carrying two team labels matches two rules. Decision: **refuse at
  delivery time with a comment on the card naming both labels**, rather than delivering to both. Two
  deliveries into two teams is neither visible nor harmless. The refusal is surfaced on the card so
  the operator sees the conflict.
- **Cross-plan dependency on `teamId → issueId` binding.** The completion write-back for a
  team-addressed card with no plan needs the `teamId → issueId` binding defined in
  `standing-orders-can-post-a-team-status-report-to-a-card.md`. If that plan has not landed, this
  plan must define its own binding or block on it. State the dependency explicitly; do not assume it
  is available.

### Migration

Additive and optional. Every stored automation rule loads and behaves exactly as it does today
with `targetTeam` absent. No state, file format or default changes.

## Verification Plan

1. **End to end.** Label a card with a team tag, move it to a trigger state, and assert the card
   body arrives in that team's lead terminal with the provenance header intact and the terminal's
   prior context **not** cleared.
2. **Write-back.** Assert the team's result reaches the Linear card by whatever mechanism was
   settled jointly with the reporting plan, and that the card is not left mid-flight.
3. **Existing column rules unregressed.** Run a stored, pre-existing `targetColumn` rule and
   assert byte-identical behaviour — plan created, provenance lines present, `finalColumn`
   honoured.
4. **Old config loads.** Load a config saved before this change and assert every rule parses,
   runs, and keeps any keys this version does not know about.
5. **No re-delivery loop.** Leave a matched card in its trigger state across several poll cycles
   and assert exactly one delivery. This is the regression that would otherwise spam a terminal
   every 30-120 seconds.
6. **Team not running.** Match a card with no team started. Assert the state is visible on the
   card, that nothing is silently dropped, and that it is not retried forever.
7. **Team restarted mid-flight.** Restart the team between match and delivery; assert the lead
   is re-resolved and validated rather than a stale id being used.
8. **Two labels.** Put two team labels on one card and assert the decided behaviour — one
   delivery or an explicit refusal — never two silent deliveries.
9. **Card text is data.** File a card whose body contains a forged provenance header, a fake
   standing-orders marker (`=== STANDING ORDERS ===`), and instruction-shaped text. Assert none
   of it changes what the agent is told to do.
10. **Two instances.** Poll the same project from two hosts and assert one delivery total.

### Goal Invariants

- **Legacy rules preserved.** Assert a stored rule with `targetColumn` and no `targetTeam` loads,
  runs, and behaves byte-identically to today. (Negative: no stored rule fails to load due to the
  destination-kind migration. Positive: legacy `targetColumn` rule creates a plan, honors
  `finalColumn`, and writes back as before.)
- **Destination kind exhaustive.** Assert the poll's destination switch is exhaustive — every rule's
  `destination.kind` is handled, and an unknown kind is refused at normalization. (Negative: no rule
  with both `targetColumn` and `targetTeam` passes normalization. Positive: each kind has a defined
  delivery path.)
- **No re-delivery loop.** Assert a matched card left in its trigger state across multiple polls is
  delivered exactly once. (Negative: no second delivery after the first. Positive: the plan-creation
  dedupe key prevents re-match.)

## The write-back half is already built — revision after review

*Appended rather than rewritten; the addressing analysis above stands unchanged.*

This plan's Complex/Risky section called write-back correlation "most of the work" and told the
reader to agree a mechanism with the team-status plan. Both statements are withdrawn: the
mechanism exists.

`LinearSyncService.postManagedComment(issueId, body)` (`:1444`) is a host-side comment primitive
that truncates to 64k and stamps a self-marker. `src/services/commentMarker.ts:9` records that the
marker is applied host-side only, "never by the agent", which is what prevents Switchboard's own
comments being re-ingested as operator input. Agents reach it via the `/comment` route
(`LocalApiServer.ts:1436`) and "never call the provider API directly and never touch the marker, so
they cannot break the feedback-loop guard". `NotionFetchService` and `ClickUpSyncService` implement
the same method behind `RemoteProvider`, so it is provider-agnostic.

More directly: **agents are already instructed to use it when the operator is remote.**
`REMOTE_MODE_DIRECTIVE` (`agentPromptBuilder.ts:839`) is injected into every role when the
dispatched card's board is under remote control, per-board gated at `KanbanProvider.ts:3202` and
`:6080`, telling the agent to post questions and blockers as a comment on the linked issue and not
to wait on terminal input.

**What this changes in this plan:**

- **Decision 3 gains a second reason to keep plan creation.** A team-addressed card that becomes a
  local plan inherits the plan's synced issue as its comment destination, so the team's replies
  land on the originating card through the existing path with no new correlation model. Skipping
  plan creation would cost both the dedupe key *and* the write-back destination.
- **`writeBackOnComplete` needs no new implementation** for a team-targeted rule — only the
  decision of what counts as "complete" when the worker is a team rather than a column agent.
- **The dedupe trap is now the plan's single largest risk**, not correlation. Re-delivering a
  matched card every poll would spam a team's terminal every 30-120 seconds, and the key lives in
  the created plan's body (`_extractPlanMetadata`, `:184`).
- **The `teamId → issueId` binding** that a completion write-back needs for a card with no plan is
  defined in `standing-orders-can-post-a-team-status-report-to-a-card.md`. Use it; do not define a
  second one.

Net effect: scope reduction. Nothing above is invalidated except the claim that a write-back
mechanism has to be designed.

## Make the destination a kind, not a growing set of sibling fields

*Appended after review.*

This plan proposes `targetTeam` alongside `targetColumn`, with normalization refusing a rule that
sets both. A third destination is already wanted — a `sb:memo`-style label whose matched card is
captured as a memo rather than imported as a plan — and there will be others.

Two sibling fields with a hand-enforced "exactly one" rule is the shape that becomes four fields and
a tangle of pairwise checks. Model the destination as a **kind** instead:

```
destination: { kind: 'column', column: string }
            | { kind: 'team',   team: string }
            | { kind: 'memo' }
```

One discriminated union, one exhaustive switch in the poll, one normalizer, and an unknown kind
refused at load rather than silently ignored. Adding a destination later is a case, not a new field
plus a new pairwise rule.

**Migration is the reason to do it now rather than later.** Automation rules ship today with
`targetColumn` on stored configs. `normalizeLinearAutomationRules` must map a stored
`targetColumn` to `{ kind: 'column', column }` on load and keep writing whatever shape the config
version requires, preserving unknown keys. Doing that once, while there is exactly one legacy shape,
is straightforward; doing it after `targetTeam` has also shipped means migrating two.

The memo destination itself is out of scope here — it needs its own decision about what a captured
memo contains and where it lands. What this plan owes it is a destination model that does not have
to be reworked to accommodate it.

## Implementation Summary

Implemented team-targeted destination support for Linear automation rules using a discriminated union `destination: { kind: 'column' | 'team' | 'memo' }`. Added mutual exclusivity checks and legacy migration in `normalizeLinearAutomationRules` while preserving unknown keys. Updated `LinearAutomationService` to resolve live teams and leads, delivering provenance-wrapped data prompts into lead terminals via `ptySendPrompt` with `clearBeforePrompt: false`. Explicit unresolved states (team not running, lead not registered, delivery failure) and multi-rule conflicts are now surfaced directly as comments on Linear cards. Retained local plan creation for dedupe integrity and correlation across polling cycles.


## Review Findings

Reviewed `PipelineDefinition.ts`, `LinearAutomationService.ts`, `KanbanProvider.ts`, `linear-automation-service.test.js`. The multi-rule refusal comment ran ahead of the plan-file dedupe and so re-posted on every poll — the exact 30–120s loop the plan is named for, aimed at Linear comments instead of a terminal; it is now keyed on a persisted conflict signature. Three further fixes: a throw from `_deliverToTeam` was caught by the plan-creation handler *after* the dedupe file existed, permanently stranding the card with nothing said on it; the `memo` destination kind fell through to the column path and silently created a board card; and `saveAutomationSettings` persisted the normalizer's output, so a rule the normalizer refuses was silently deleted from the operator's config rather than refused. The issue body is now fence-neutralised before delivery, and `KanbanProvider` resolves `terminalVerb` at call time so the cached automation service cannot capture `undefined`. The four new tests could never pass — they called `ensureReady()` without `createIfMissing()`, so every poll aborted on "Kanban database unavailable"; with that fixed all four pass, including the end-to-end team delivery and the injection-resistance case.

## Deferred Findings

- MAJOR — `_deliverToTeam` resolves the team by head-terminal name, group id, or definition id, but `terminals.groups.name` holds the HEAD's name, not the team's; a rule naming a team template that was spawned without a `definitionId` will not resolve. `src/services/LinearAutomationService.ts:245`
- MAJOR — write-back "complete" for a team-targeted rule is hardcoded to the `DONE`/`COMPLETED` columns, an invented default the plan left undecided. `src/services/LinearAutomationService.ts:700`
- NIT — `LinearAutomationRule` gained an `[key: string]: unknown` index signature to carry unknown keys, which disables excess-property checking on every field of the interface. `src/models/PipelineDefinition.ts:26`
- NIT — an externally-headed team's `head` is a non-terminal agent, so a team rule targeting one always reports "lead terminal is not active". `src/services/LinearAutomationService.ts:262`
- NIT — `ptyListTerminals` returning `{success:false}` is reported on the card as "lead not active", conflating a dead pty host with an absent lead. `src/services/LinearAutomationService.ts:270`

### Review Deviations

None. The destination model, the relay seam, `clearBeforePrompt: false`, the provenance header and existing column-rule behaviour are all as the plan specified.
