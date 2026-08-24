# Route a Linear issue to a specific team's lead by label, leaving assignee to the humans

## Goal

Let an operator send remote work to a *named* team lead — `lead:coder`, `lead:review` — instead of to whichever anonymous seat the dispatch path happens to pick. Labels carry the routing; the resolver that turns a role into a terminal already exists and is unused on this path.

### Problem Analysis

**Remote dispatch cannot address a team.** `scheduled-automation-targeted-at-a-team-lead.md` establishes this for the scheduler in detail — `job.target` is vestigial, delivery spawns "a fresh, unaffiliated terminal" that "belongs to no team, carries no team standing orders, and appears in no team's roster." The same gap applies to the remote path: an issue moved into an execution-triggering state dispatches, but nothing in the remote surface can say *which* team should take it.

**The resolver already exists.** `resolveTeamScopedRoleTerminal` (`teamWiring.ts:1412`) resolves a role within a team's registered roster, reading `terminals.groups` as the authoritative membership record. That plan notes it plainly: the resolver "already exists and is unused by this path." So the missing piece is not resolution — it is a carrier on the Linear side and a mapping to feed the resolver.

**Assignee is the wrong carrier, and labels are free.** Linear's assignee is a real user account: adding a lead means an invite, an email and a paid seat each, and it fills the field humans use to record who is accountable — on the surface Switchboard deliberately does not compete with. Labels cost nothing, are unlimited, filter natively, and are invisible to anyone not looking for them. Linear's own Teams would also work conceptually, but each Linear team carries its own workflow states, multiplying the column mapping already in place.

**Note what this is not.** A label is routing metadata, not an instruction. The remote surface's command vocabulary stays exactly what `the-remote-command-vocabulary-is-closed.md` sets — author content, move a card — and moving a card remains the only trigger. The label says *where* work goes when it is already being dispatched; it never says *what to do*, and it cannot cause a dispatch on its own. That distinction is what keeps this from widening the vocabulary.

### Root Cause

Team membership is local state (`terminals.groups`) with no representation on any remote surface. Remote dispatch was built when there was one implicit worker, so nothing needed naming, and the resolver that would name one arrived later for the local cockpit.

### Non-goals

- Entering leads as Linear members. Seats, emails, and it takes the humans' assignee field.
- Mapping Switchboard teams onto Linear teams. Coherent, but it multiplies workflow-state mapping.
- Any new trigger. Moving a card stays the only one.
- Changing what a lead does once dispatched. This decides the recipient, not the work.

## Metadata

**Complexity:** 4
**Tags:** api, backend, feature, devops, ux

## User Review Required

Yes — three decisions.

1. **Label namespace.** Recommendation: a configured prefix (default `lead:`) with the suffix matching a role, and the team resolved from the plan's own team association where one exists. A flat label per team-and-role (`lead:coder:fleet-2`) is more explicit but multiplies labels in a workspace humans also use.
2. **What happens to an unroutable label?** Recommendation: **do not dispatch, and say why on the card.** A label naming a role that no live team has should not silently fall back to the anonymous seat — that reproduces the current behaviour while looking as though routing worked. Silent fallback is the failure mode to avoid.
3. **What happens with no label at all?** Recommendation: current behaviour unchanged. This is additive, and requiring a label would break every existing remote dispatch.

## Complexity Audit

### Routine

- Reading labels from the issue payload alongside the existing state and assignee fields.
- A prefix-to-role mapping, and calling `resolveTeamScopedRoleTerminal` with it.
- A comment on the card naming the resolved seat, reusing the managed-comment path.

### Complex / Risky

- **The roster is live state and the label is not.** `terminals.groups` changes as teams are spawned and torn down; a label written yesterday may name a role no team currently fills. So resolution happens at dispatch time and must handle "no such team" and "team exists, role vacant" distinctly — the second is a transient the operator can fix, the first is a mistake in the label.
- **Multiple matching labels.** Two `lead:` labels on one issue is ambiguous, and picking the first is a coin flip that will look deterministic until it isn't. Refuse and say so.
- **Busy targets.** `scheduler-custom-jobs-and-the-busy-target-rule.md` exists for a reason: a resolved lead may already be working. This plan must defer to whatever rule that establishes rather than inventing a second one.
- **Labels are human-editable on a surface humans own.** Someone tidying labels can silently change routing, and Linear label renames would break the mapping. The mapping should key on label *name* with a clear failure rather than an id that survives renames invisibly — a visible break is better than silent misrouting.
- **This should not become a command channel.** The temptation once labels route is to add `action:` labels. That is the free-text instruction queue in a different costume, and the vocabulary plan's reasoning applies unchanged.

## Edge-Case & Dependency Audit

**Race conditions**
- A team torn down between the trigger and the resolve. Fail with the transient message, not a fallback dispatch.
- Two issues routed to one lead simultaneously — the busy-target rule's problem, not this one's.

**Security**
- No new credential and no new trigger. A label cannot cause execution; the column move still does, and the review gate still governs it.
- Anyone who can edit labels in the workspace can change *where* work goes, though not whether it happens. Worth stating.

**Side effects**
- `remote-control-dispatch-acknowledgment-writeback.md`'s receipt should name the resolved seat — the two compose into "picked up by Review Lead", which is the actually useful notification.
- Notion and ClickUp have their own tag/label primitives; the mapping layer should not assume Linear, even if only Linear is wired first.
- `scheduled-automation-targeted-at-a-team-lead.md` targets the same resolver from the scheduler. Same mapping concept, two entry points — build the mapping once.

**Migration**
- Additive. No label means today's behaviour, so no install changes until someone adds one.

## Dependencies

- **Uses** `resolveTeamScopedRoleTerminal` (`teamWiring.ts:1412`).
- **Shares its mapping with** `scheduled-automation-targeted-at-a-team-lead.md`; coordinate so the resolver is fed from one place.
- **Defers to** `scheduler-custom-jobs-and-the-busy-target-rule.md` on busy targets.
- **Composes with** `remote-control-dispatch-acknowledgment-writeback.md` for the receipt, and with `linear-oauth-actor-app-for-per-lead-attribution.md` for who the receipt appears to come from — but requires neither.

## Adversarial Synthesis

Key risks: silent fallback to the anonymous seat when a label cannot be resolved, which reproduces today's behaviour while appearing to route; ambiguity when several `lead:` labels are present, picking the first deterministically until it isn't; labels being human-editable on a surface humans own, so a tidy-up silently reroutes work; and the temptation to extend labels into `action:` commands, which is the instruction queue the vocabulary plan refuses. Mitigations: refuse and comment rather than fall back; refuse on ambiguity; key on label name so a rename breaks visibly rather than misroutes silently; and state the label-is-metadata-not-instruction boundary in the plan and the protocol.

## Proposed Changes

1. **Read labels** from the issue payload on the remote-control path.
2. **A prefix-to-role mapping** (default `lead:`), provider-neutral so Notion tags and ClickUp tags can use it later, shared with the scheduler's targeting.
3. **Resolve at dispatch time** via `resolveTeamScopedRoleTerminal`, distinguishing no-such-team from role-vacant.
4. **Refuse rather than fall back** on unresolvable or ambiguous labels, with the reason posted to the card.
5. **Name the resolved seat** in the dispatch receipt.
6. **Defer to the busy-target rule** rather than defining a second one.
7. **State in the protocol** that labels are routing metadata and never instructions.

### Migration

Additive; unlabelled issues behave exactly as today.

## Verification Plan

- **Happy path:** an issue labelled `lead:review` triggered into dispatch reaches that team's review lead, and the receipt names it.
- **No label:** assert unchanged current behaviour.
- **No such team:** label names a role no live team fills. Assert no dispatch, a reason on the card, and specifically that it does **not** fall back to an anonymous seat — the test for the failure this plan exists to prevent.
- **Role vacant:** team exists, role unfilled. Assert the transient message, distinct from no-such-team.
- **Ambiguity:** two `lead:` labels. Assert refusal, not first-match.
- **Rename:** rename the Linear label. Assert routing breaks visibly rather than silently going elsewhere.
- **Busy target:** resolved lead already working. Assert the busy-target rule applies and no second rule is in play.
- **Not a trigger:** add a `lead:` label to an issue in a non-triggering column. Assert nothing dispatches — the label alone must never cause execution.
- **Review gate intact:** label plus a move on an unreviewed plan. Assert the gate still refuses.

## Outstanding Questions

- Should an unroutable label fail once and stay failed, or retry as teams come and go? Retrying makes a stale label a recurring notification.
- Is there a case for routing to a *team* rather than a role within it, letting the team's own lead assign internally?
- Does the same mapping want to express priority or queue position, or is that scope creep into the scheduler's territory?
