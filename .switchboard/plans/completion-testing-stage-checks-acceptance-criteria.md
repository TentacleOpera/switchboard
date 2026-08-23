# Completion testing: a planner judges the finish, and may plan the remainder

## Goal

Turn the dormant `ACCEPTANCE TESTED` column into a working completion-testing stage: a planner-role agent that judges a finished change against acceptance criteria — **deferred risks resolved** and **intent satisfied** — and writes a follow-up plan when they are not met. Reuse the existing column rather than adding one.

### Problem Analysis

**The column already exists, and it is dormant by construction.** `agentConfig.ts:158` defines it:

```
{ id: 'ACCEPTANCE TESTED', label: 'Acceptance Tested', role: 'tester', order: 350,
  kind: 'reviewed', source: 'built-in', autobanEnabled: false, dragDropMode: 'cli' }
```

`autobanEnabled: false`, so nothing advances into it. `resolveAutoDispatchColumn` returns it only when `_isAcceptanceTesterActive` is true and `null` otherwise (`TaskViewerProvider.ts:5348`), and `KanbanProvider.ts:6988` skips the column entirely when the tester is inactive. It sits at `order: 350`, already between `CODE REVIEWED` (300) and `COMPLETED` (9999) — the exact position this stage needs.

**Half the job is already written.** The `tester` role is the *"Product Acceptance / Intent Reviewer"*, and its base text names the intent criterion precisely (`agentPromptBuilder.ts:1955-1963`): *"The reviewer already checked code-vs-plan; you check code-vs-intent… Flag both directions: requirements/intent not met, and code that satisfies the plan's letter but misses the product's intent."*

So the column, its position, and one of the two acceptance criteria all exist. Three things are missing or wrong.

**1. The other criterion does not exist.** Nothing checks whether the reviewer's deferred findings were resolved. They are written into the plan file's completion report, and the `reconcile` preset scans for that section *appearing* and uses it to advance the card (`schedulerPresets.ts:90`) — so the detector is the burier. `deferred-findings-become-a-structured-record.md` gives that set a readable shape; this plan is what reads it.

**2. The role is wrong, and structurally so.** The tester's step 3 is *"Apply code fixes for valid requirement gaps"* (`:1967`). It fixes. A **planner**'s sanctioned output is a plan file — the planner instruction set already ends *"Write the plan file once, at the end"* (`:1836`) and already routes an unresolvable scope decision to *"`## Outstanding Questions` as a `[user]` item"* (`:1835`). Writing a plan when acceptance is not met is a planner capability that the tester lacks, and fixing code is a tester behaviour this stage should not have.

**3. Its intent baseline would repeat the exact miss it exists to catch.** The tester is told to treat *"the PRD as the primary intent baseline, the constitution as inviolate invariants, and the plan as the implementation record (not the yardstick)"* (`:1959`). But the incident that motivated goal-invariant verification had **no PRD entry** — as `goal-invariant-verification-and-review-escalation.md` records, *"'remove 424K of scaffold from every user repo' is not a product requirement — so the intent existed only in the plan's `## Goal`, the one artefact that role is told not to measure against."* A completion-testing agent that inherits this baseline is blind to exactly the class of intent failure that prompted the stage.

**And the cost objection that kept it dormant no longer holds.** The same plan records that the tester *"is not run in practice because the observed intent-failure rate does not justify its token cost."* That was true of a stage whose only job was fuzzy intent judgment. Adding the deferred-risk check gives it a second job that is a cheap mechanical comparison against a list the reviewer already wrote — high yield, low cost, and currently performed by nobody.

### Root Cause

Completion was defined as *"the reviewer finished"* rather than *"the acceptance criteria are met"*. So the artefact that records what remains outstanding is the same artefact whose modification means done, and the stage that would have compared the two was built with a fixer's role and a baseline that excludes the plan's own purpose.

## Metadata

**Complexity:** 6
**Tags:** feature, agents, reliability, backend

## Settled Design

- **What it may plan.** Only (a) a finding the reviewer already recorded as deferred, or (b) an intent gap it can name against the plan's `## Goal`. No net-new scope, no opportunistic improvements. Unbounded, a planner at the end of the pipeline ends every feature by generating follow-up work — the automation-forgetting problem inverted into automation-multiplying. Bounded, it is a closer.
- **It does not edit code.** No code-write capability at all. If it could fix, it would, and a resolved finding would become indistinguishable from one it quietly patched — which destroys the record the stage exists to check. It is also a second agent in a tree a team may still hold, the hazard behind the reviewer's own `CODE REVIEWED` restriction.
- **`autobanEnabled` flips to `true`**, behind a column-participation switch that is off for existing installs. That switch, not role visibility, is what makes cards flow into the stage.

### Making the role core splits one gate into two — and reinstates a migration

`tester` is currently the **first row under `<!-- OPTIONAL -->`** in the agents tab (`kanban.html:3227`, under `<div class="agents-group-label">Optional</div>`), unchecked, and `tester: false` in both defaults sources (`sharedDefaults.js:7`, `GlobalIntegrationConfigService.ts:355`). Promoting it to core means moving the row into the `<!-- CORE -->` block above that label, marking it `checked`, and flipping both defaults to `true`.

**That invalidates the earlier reading of this plan, which said there was nothing to migrate.** That claim rested entirely on the role defaulting to invisible: `_isAcceptanceTesterActive` is `visibleAgents.tester !== false`, so with `tester: false` the `autobanEnabled` flip was inert everywhere. Default the role visible and the same flip activates a new pipeline stage on every install at once — cards start flowing into a column that has never held any. That is exactly the shipped-state change CLAUDE.md requires be migrated deliberately.

**The resolution is that `_isAcceptanceTesterActive` conflates two separate questions.** "Is this a first-class role I can start and put on a team?" and "does the pipeline have a completion-testing stage?" are not the same question, and one boolean answering both is why promoting the role has pipeline consequences at all. Split it:

- **Role visibility** → core, default on. It appears in the agents tab, the role picker, and team membership like any other core role.
- **Column participation** → its own switch, default off for existing installs. The stage is opt-in, and turning it on is a deliberate act.

That gives both intents without the coupling: the tester becomes a normal, reachable role immediately, and nobody's pipeline grows a stage they did not ask for.

### There is one tester role, and the pair-level `tester` preset should go

**Correction to an earlier revision of this plan.** It described a "pair-level tester" and a "column-level tester" as two jobs on one role name. That framing was wrong and invented a distinction the product does not have. There is **one** role — `tester`, labelled *Acceptance Tester* (`extension.ts:3381`) — and it is the pipeline gate this plan is about.

What actually exists at the pair level is a **relationship preset**, not a role: `{ id: 'tester', label: 'Tester' }` in `MEMBER_RELATIONSHIP_PRESETS` (`kanban.html:4881`), duplicated in `terminals.js:10305`, with a template in `linkPresets.ts:77-85` telling a head to *"hand {child} what you changed and what the expected behaviour is… and let it run the checks."*

**That preset is needless complexity and should be removed.** A head that wants tests run can run them itself or hand the work to a coder — both are things it already does, and neither needs a dedicated relationship, a template, or a seat. Keeping it also invites exactly the confusion above: a "Tester" in the relationship dropdown reads as a second tester role sitting beside the Acceptance Tester, when it is only a way of talking to an ordinary member.

Removing it is cheap and low-risk: **no shipped team definition uses `relationship: 'tester'`** (the only seed is the member-less `Lead team`, and the retired `Coding team` carried a *reviewer* member, not a tester). Three declaration sites go, and `teamWiring.ts:1785-1787` loses one name from its head-receives list.

**But users may have selected it, so it migrates rather than disappearing.** Per CLAUDE.md this preset shipped, so an existing member carrying `relationship: 'tester'` must not be dropped — convert it to `reports-to-head`. There is an exact precedent to copy: the old Coding-team migration converts a member with `relationship === 'reviewer'` to `'reports-to-head'` (`teamWiring.ts:966-970`), preserving every other key on the group and on each member, and matching by exact value so an operator-edited group is left alone.

### The reviewer + acceptance-tester team is the structure worth having

With the pair preset gone, the team structure to add is the two post-coding gate roles together: a **reviewer and an Acceptance Tester**, so the review → completion-test handoff is a team relationship rather than two unrelated column dispatches.

It ships as a definition the user starts, **never as a pre-seeded row with members**. `SEEDED_AGENT_GROUP` is deliberately member-less (`teamWiring.ts:613-618`) and `OLD_SEEDED_AGENT_GROUP` exists solely to document why: a seed with members *"would spawn three unrequested coder agent CLIs per lead — the release gate this migration exists to close."* A seeded reviewer+tester team spawns two per lead on the identical mechanism.

### The stage is the terminal auto step, by design

`_getNextKanbanColumnForSession` is explicit (`TaskViewerProvider.ts:5348-5350`): `CODE REVIEWED` advances to `ACCEPTANCE TESTED` when the tester is active, and `ACCEPTANCE TESTED` returns `null`. Nothing auto-advances past it — reaching COMPLETED is a human or controller move. That is the right shape for a gate: it stops and asks, rather than passing through. It also means the column-order arrays are irrelevant to this path; that switch never consults them.

## Complexity Audit

### Routine

- Flipping `autobanEnabled` on the column, and relabelling it.
- Deleting the unreachable design-doc error string.

### Complex / Risky

- **Keep the column id; change only the label and the role.** `ACCEPTANCE TESTED` shipped in released column sets and is stored in card `kanban_column` values across ~4,000 installs. It also appears in `_isColumnBefore`'s order array (`KanbanProvider.ts:8659`), the `POST_CODE` set (`KanbanDatabase.ts:9388`), the column→role maps (`KanbanProvider.ts:3661`, `:13570`, `TaskViewerProvider.ts:5133`, and `_roleForKanbanColumn` at `:5197`), the next-column resolver (`:5176`, `:5348`), the inactive-column skip (`:6988`) and a test fixture (`KanbanProvider.test.ts:152`). Renaming the id strands every card sitting in it. Relabel and re-role only.
- **A planner role in a reviewed-stage column is a new combination.** The column is `kind: 'reviewed'` and `dragDropMode: 'cli'`, and role-keyed behaviour elsewhere (git policy via `STAGE_BY_ROLE`, prompt composition, dispatch routing) is written against the roles that occupy each kind today. Re-roling the column exercises paths that have never seen a planner past `CODE REVIEWED`.
- **Git policy must match "does not fix".** `buildGitPolicyBlock` is composed per role with `STAGE_BY_ROLE[role]`. A stage that writes a plan file but never touches code needs a policy that permits the plan write and prohibits code commits — not the planner's default and not the tester's.
- **The prompt cannot inherit the tester's baseline.** The intent check must read the plan's `## Goal` as a first-class intent source, with the PRD used when present rather than required. Inheriting `resolveBaseInstructions('tester', …)` unchanged reproduces the documented blind spot.
- **The deferred-risk check needs the previous plan to have landed.** Against a plan file written before the structured section exists, the stage has no list to check. It must report "no deferred record" as a distinct outcome from "no deferred findings", or every historical plan reads as clean.

## Edge-Case & Dependency Audit

**Migration.** Two items. The column id is unchanged, so no card moves. The real migrated state is the role's default visibility going from `false` to `true`: that is what previously made the `autobanEnabled` flip inert, so promoting the role to core requires the column-participation switch to carry the opt-in instead. Existing installs get the role visible and the stage off; new installs can have both on. And removing the pair-level `tester` relationship preset requires converting any member that carries it to `reports-to-head`, by the exact-value precedent at `teamWiring.ts:966-970`.

**Security.** The stage writes plan files. Plan content is agent-written and must render as text, never HTML. It gains no code-write capability, which is a reduction in surface relative to the tester it replaces.

**Side effects.** One more stage per feature, with its token cost. The deferred-risk half is cheap; the intent half is the expensive part, and it is the half whose historical yield was judged not worth it. Worth measuring the two separately rather than reporting one aggregate cost, or the cheap check gets abandoned along with the expensive one.

**Ordering.** Depends on `deferred-findings-become-a-structured-record.md` — without a readable deferred set, half the stage's job has no input.

## Dependencies

- **Requires** `deferred-findings-become-a-structured-record.md` (the input it reads).
- **Related to** `goal-invariant-verification-and-review-escalation.md`, which makes the *reviewer* assess the goal. That plan strengthens the upstream check; this one adds a downstream gate that can act when the check still misses. They are complementary, not alternatives — and if that plan lands first, the intent half of this stage becomes a second opinion rather than the only one.

## Adversarial Synthesis

**"Add a new column instead of repurposing this one."** Two columns both meaning "post-review judgment" is a UI users cannot reason about, and the existing column already sits at the right order with the right kind and the right gating. Repurposing costs a label and a role; adding costs a column id, a migration, and a permanent ambiguity.

**"The acceptance tester was already tried and abandoned."** It was, for a stage whose only job was intent judgment against a PRD-primary baseline — a fuzzy check with a low observed hit rate and a blind spot on plan-only intent. The deferred-risk check is neither fuzzy nor low-yield, and the baseline correction addresses why the intent half underperformed. Abandoning the old configuration is not evidence against a different one.

**"Let the reviewer do this — it is already in the diff."** The reviewer is the actor that deferred the findings; asking it to also judge whether deferring them was acceptable is asking it to review its own triage. It also has no roadmap context, and its remit ends at the diff.

**"A planner that can write plans will spam the board."** Which is why the bound is the first User Review item rather than an implementation detail. Unbounded, this objection is correct.

## Proposed Changes

1. **Relabel `ACCEPTANCE TESTED`** to name completion testing, keeping the column **id** untouched.
2. **Re-role it to `planner`**, replacing `tester` in the column→role maps.
3. **Compose a completion-testing prompt** rather than inheriting the tester's: two explicit criteria — every recorded deferred finding resolved or re-deferred with a reason, and intent satisfied — with the plan's `## Goal` as a first-class intent source and the PRD used when present.
4. **Grant plan-writing, withhold code-editing**, with a git policy block that matches.
5. **Bound what it may plan** to recorded deferred findings and named intent gaps; no net-new scope.
6. **Distinguish "no deferred record" from "no deferred findings"** so pre-existing plans do not read as clean.
7. **Flip `autobanEnabled` to `true`** on the column, gated by a new column-participation switch — off for existing installs, on for new ones.
7a. **Split `_isAcceptanceTesterActive`** into role visibility and column participation. One boolean answering both is why promoting the role has pipeline consequences.
7b. **Promote the role to core**: move its row out of the Optional block in the agents tab, mark it `checked`, and set `tester: true` in both defaults sources.
7c. **Remove the pair-level `tester` relationship preset** from all three declaration sites and from the head-receives list, migrating any member carrying it to `reports-to-head` by the `:966-970` precedent.
7d. **Offer a reviewer + Acceptance Tester team definition** the user starts — never a pre-seeded row with members, which is the exact release gate `OLD_SEEDED_AGENT_GROUP` exists to document.
8. **Delete the unreachable design-doc error** and either implement or remove the `_isAcceptanceTesterDesignDocConfigured` stub.
9. **Update all four column→role maps**, not the three that are easy to find.

### Migration

Column id unchanged — no card migration. The `autobanEnabled` flip is the migrated behaviour: existing installs keep their current flow unless the user has already opted in by making the role visible.

## Verification Plan

### Goal Invariants

- A change with an unresolved recorded deferred finding does not reach COMPLETED unexamined.
- The stage never edits code.
- The stage never plans work outside a recorded finding or a named intent gap.
- Installs with the role hidden are behaviourally unchanged.

### Automated Tests

- **An unresolved deferred CRITICAL is caught:** seed a plan whose deferred section lists an unresolved CRITICAL; assert the stage reports it rather than passing. This is the whole point, and it fails today because nothing reads the section.
- **Plan-only intent is caught:** seed a change that satisfies every listed step while inverting the `## Goal`, with **no PRD**; assert the stage flags it. Under the tester's PRD-primary baseline this passes wrongly, so it is the test that pins the baseline correction.
- **No deferred record is not a pass:** run against a plan file written before the structured section existed; assert "no record" rather than "clean".
- **The stage writes no code:** assert no code-file write path is reachable from its role, and that its git policy prohibits code commits while permitting the plan write.
- **The planning bound holds:** present an unrecorded improvement opportunity; assert no plan is written for it.
- **Column id is untouched:** assert the stored id remains `ACCEPTANCE TESTED` across the relabel, and that cards seeded in it still resolve. A label-only test passes while a renamed id strands cards.
- **A visible role does not activate the stage:** with `tester` visible (its new default) and column participation off, assert no card advances into the column. This is the assertion that proves ~4,000 installs are unaffected, and it is the one that fails if the two gates stay conflated.
- **The core promotion is complete:** assert the role is `checked` in the agents tab, outside the Optional group, and `true` in both defaults sources. A test on one defaults file passes while the other still says `false`.
- **No team seed spawns a CLI:** assert the reviewer + Acceptance Tester definition is offered rather than seeded with members, and that `SEEDED_AGENT_GROUP` still has none. This is the release gate the old Coding-team migration exists to hold.
- **A stored `tester` relationship survives its preset's removal:** seed a team member with `relationship: 'tester'`, run the migration, assert it becomes `reports-to-head` with every other key on the group and the member preserved. Deleting the preset without this drops a user's team wiring silently.
- **The preset is gone from every site:** assert no `tester` entry remains in `MEMBER_RELATIONSHIP_PRESETS` in either `kanban.html` or `terminals.js`, nor in `linkPresets.ts`. Two of the three are duplicates, so a single-site test passes while the dropdown still offers it.
- **The stage does not auto-advance:** assert `_getNextKanbanColumnForSession('ACCEPTANCE TESTED')` returns null, so a card waits for a decision rather than sliding to COMPLETED.
- **The dead error is gone:** assert no code path can emit the Planning Feature message.

### Manual Verification

- Run one real feature end to end with a deliberately deferred MAJOR and confirm it surfaces before COMPLETED.
- Confirm the two halves' token costs are reported separately.

## Outstanding Questions

None.
