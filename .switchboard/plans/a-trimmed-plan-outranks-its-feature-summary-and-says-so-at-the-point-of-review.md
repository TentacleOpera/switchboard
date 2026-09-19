# A Trimmed Plan Outranks Its Feature Summary, and Says So at the Point of Review

## Goal

When a subtask plan and its feature file disagree, **the plan wins** — as a rule the
review prompt states, not a judgement each lead has to make alone. And trimming a plan
tells you which feature files it just falsified, at the moment you trim it.

## Problem analysis

**A lead rejected a correct implementation and nearly forced it to be undone.**
2026-09-19, feature `0f759387`, subtask `9d453d11`. The feature file said the subtask
reinstates an `Unassigned` pseudo-group across `getAllGroups()`, `getGroupMembers()`,
`findGroupForTerminalName()`, the locked-click router and the free-slot branch. The
subtask's own plan had been **scope-trimmed on 2026-09-17** and removed all of it — not
as redundant but as **breaking**:

> `getUnassignedTerminalNames()` derives its complement as
> `fleetList.filter(...).filter(t => !findGroupForTerminalName(t.friendlyName))`, so
> teaching `findGroupForTerminalName()` to return a pseudo-group inverts that filter to
> always-false — the unassigned grid seats nothing and the tab count reads zero.

The lead reviewed against the feature file **because its dispatch instructions tell it
to**, rejected the subtask, and sent a fix round demanding exactly the three things the
plan had removed. The coder pushed back that the documents conflict. **The operator
intervened**, the fix round was withdrawn before it acted, and the subtask was accepted
on its trimmed scope.

Nothing in the system caught it. The lead followed its instructions correctly and its
instructions pointed at the stale document.

**It is not a one-off.** Scanning every feature that references a plan carrying a dated
supersede/trim heading found a second live instance:
`board-hygiene-cards-that-leave-and-cards-that-should-not-arrive` still summarises
`ccffc96a` as a two-week dwell sweep, while that plan was superseded on 2026-09-18 by
bin semantics — COMPLETED archives immediately and **there is no dwell period**. That
subtask is uncoded, so the same rejection is waiting to happen.

**Why the feature file goes stale and stays stale.** A feature's summary is written once,
when the feature is assembled from its subtasks. A subtask plan is edited whenever scope
changes. Nothing links the two: trimming a plan does not touch, flag, or even know about
the features that quote it. The summary is a **copy**, and this repo's recurring defect is
two copies that disagree with no way to tell which answered.

**Annotating each conflict by hand does not scale** and was only possible here because
someone already knew where to look.

## Metadata

**Complexity:** 4
**Tags:** features, plans, review, orchestration, standalone
**Scope:** the feature-dispatch review instructions, the subtask/feature link in
`manage-features` (or wherever a plan edit can observe its referencing features), and a
gate. **Standalone only** — the extension is being reduced to a launcher sidebar.

## Constraints

**No sessionId.** Anything added here keys on `planId` / `featureId`.

**Do not make the feature file non-authoritative in general.** It is the right document
for sequencing, shared guards and cross-subtask reconciliation — the things no single
subtask plan can see. The rule is narrower: where a subtask plan carries a **dated
supersede or trim heading**, that plan's scope wins for **that subtask**.

## Proposed changes

### 1. The precedence rule goes in the review instruction itself

The feature-dispatch prompt currently tells a lead to review each subtask against the
feature. It must also say, in the same breath:

> A subtask plan carrying a dated **Scope trimmed** / **Superseded** heading outranks the
> feature file's summary of that subtask. If they disagree, implement and review the
> plan, and report the contradiction rather than resolving it silently.

Stated at the point of review, not in a document the lead would have to think to consult.
The lead that hit this did the right thing *after* a human intervened; the instruction is
what decides whether the next one needs a human.

### 2. A trim announces which features it falsified

When a plan gains a dated supersede/trim heading, the features referencing it are
discoverable — the subtask block carries the plan path and the ID. Surface them at that
moment: list every feature whose summary now describes retired scope, so the person doing
the trim can correct or annotate them while the reasoning is in their head.

Notification, not automatic rewriting. A feature summary is prose about how subtasks
relate, and machine-editing it is how it would start lying in a new way.

### 3. The dispatched subtask carries the trim marker

A lead should not have to open the plan file to discover it was trimmed. Whatever the
dispatch hands the lead about a subtask includes a flag when that plan carries a dated
supersede/trim heading, so the precedence rule fires without anyone reading for it.

### 4. A gate on the class, not the instances

A check that fails when a feature file's subtask summary describes scope a trimmed plan
has removed cannot be written in general — it is prose against prose. What *can* be
checked, and is exactly the signal that found both instances:

> For every feature referencing a plan with a dated supersede/trim heading, the feature
> file must carry an acknowledgement dated on or after that heading.

That is mechanical, it caught both live cases, and it fails loudly on the next one. It
does not verify the prose is *correct* — only that someone looked after the trim.

## Verification plan

### Automated

- The gate above is wired into CI and **fails today** on any feature not yet
  acknowledged, then passes once each is annotated. Proven by adding a dated trim heading
  to a referenced plan and watching it go red.
- The feature-dispatch review instruction contains the precedence rule verbatim.
- A dispatched subtask whose plan carries a dated trim heading is flagged as such in what
  the lead receives; one without is not.
- Trimming a plan reports every feature referencing it, by featureId and path.
- **The 2026-09-19 case, as a fixture:** a feature summary demanding a pseudo-group and a
  plan that removed it must resolve to the plan. This is the case that cost a fix round
  and needed a human.

### Goal invariants

- A lead never has to choose between two documents unaided; the rule is in its
  instructions.
- A plan edit cannot silently falsify a feature summary — the trim names what it broke.
- "Which document is authoritative?" is answerable at the point of review, not by
  archaeology.

### Manual

Trim a subtask plan in a feature, confirm the referencing feature is named, leave it
un-annotated, and confirm CI goes red. Then dispatch that subtask and confirm the lead is
told the plan is trimmed.

## Outstanding questions

- **Should the acknowledgement be structured rather than prose?** A dated marker line the
  gate can parse is cheap and unambiguous; free prose is friendlier and harder to check.
  Decide before writing the gate, since it determines what the gate reads.
