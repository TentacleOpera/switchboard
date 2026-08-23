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

## User Review Required

- **The planning bound.** A planner at the end of the pipeline that may write plans will otherwise end every feature by generating follow-up work — the automation-forgetting problem inverted into automation-multiplying. Recommending it may write a plan **only** for (a) a finding the reviewer already recorded as deferred, or (b) an intent gap it can name against the plan's `## Goal`. No net-new scope, no opportunistic improvements. That keeps it a closer rather than a second planner.
- **It must not fix.** Recommending no code-editing capability at all. If it can fix, it will, and the deferred-risk record stops being trustworthy — a resolved finding becomes indistinguishable from one it quietly patched. It is also a second agent editing the same tree while a team may still hold it, which is the file-conflict hazard behind the reviewer's own `CODE REVIEWED` restriction.
- **`autobanEnabled: false` → `true` is the actual behaviour change.** Everything else is composition. This is the flip that makes cards flow into the stage, and it is the regression risk for ~4,000 installs: every feature suddenly gains a pipeline stage. Recommending it ship behind the existing role visibility so an install that leaves the role hidden is unaffected, which `_isAcceptanceTesterActive` and the `:6988` skip already provide for free.

### The design-doc gate is already dead, with a live error message behind it

`_isAcceptanceTesterActive` (`TaskViewerProvider.ts:7045-7048`) is:

```ts
const visibleAgents = await this.getVisibleAgents(workspaceRoot);
return visibleAgents.tester !== false && this._isAcceptanceTesterDesignDocConfigured();
```

and `_isAcceptanceTesterDesignDocConfigured()` (`:7034-7036`) is a stub returning `true` unconditionally. So the only live gate is role visibility — activating this stage is cheaper than the call site suggests.

But `_ensureAcceptanceTesterDispatchEligible` (`:7056-7058`) still surfaces *"Acceptance Tester requires a Planning Feature to be enabled and attached in Setup."* That error can never fire. Worth removing with this work: a user who reads it will go looking for a Setup toggle that does not gate anything, and a coder who reads it will assume a PRD is required — which would push them straight back toward the PRD-primary baseline this plan is correcting.

## Complexity Audit

### Routine

- Flipping `autobanEnabled` on the column, and relabelling it.
- Deleting the unreachable design-doc error string.

### Complex / Risky

- **Keep the column id; change only the label and the role.** `ACCEPTANCE TESTED` shipped in released column sets and is stored in card `kanban_column` values across ~4,000 installs. It also appears in `_isColumnBefore`'s order array (`KanbanProvider.ts:8659`), the `POST_CODE` set (`KanbanDatabase.ts:9388`), the column→role maps (`KanbanProvider.ts:3661`, `:13570`, `TaskViewerProvider.ts:5133`), the next-column resolver (`:5176`, `:5348`), the inactive-column skip (`:6988`) and a test fixture (`KanbanProvider.test.ts:152`). Renaming the id strands every card sitting in it. Relabel and re-role only.
- **Two order arrays disagree about the tail.** `_isColumnBefore` orders `… CODE REVIEWED, ACCEPTANCE TESTED, COMPLETED, TICKET UPDATER` while the comment at `KanbanProvider.ts:6977-6979` says COMPLETED *"is the pipeline's terminal stage, advanced into from TICKET UPDATER (or ACCEPTANCE TESTED when the updater is hidden)"*. Activating the column makes that tail live for the first time, so the disagreement stops being theoretical — confirm which ordering the advance path actually uses before relying on either.
- **A planner role in a reviewed-stage column is a new combination.** The column is `kind: 'reviewed'` and `dragDropMode: 'cli'`, and role-keyed behaviour elsewhere (git policy via `STAGE_BY_ROLE`, prompt composition, dispatch routing) is written against the roles that occupy each kind today. Re-roling the column exercises paths that have never seen a planner past `CODE REVIEWED`.
- **Git policy must match "does not fix".** `buildGitPolicyBlock` is composed per role with `STAGE_BY_ROLE[role]`. A stage that writes a plan file but never touches code needs a policy that permits the plan write and prohibits code commits — not the planner's default and not the tester's.
- **The prompt cannot inherit the tester's baseline.** The intent check must read the plan's `## Goal` as a first-class intent source, with the PRD used when present rather than required. Inheriting `resolveBaseInstructions('tester', …)` unchanged reproduces the documented blind spot.
- **The deferred-risk check needs the previous plan to have landed.** Against a plan file written before the structured section exists, the stage has no list to check. It must report "no deferred record" as a distinct outcome from "no deferred findings", or every historical plan reads as clean.

## Edge-Case & Dependency Audit

**Migration.** Column id unchanged, so no card migration. `autobanEnabled` flipping from `false` to `true` changes flow for every install where the role is visible — per CLAUDE.md this shipped state must be migrated deliberately, not silently: an install that has never used the tester should not discover a new mandatory stage mid-feature. Prefer defaulting the flip off for existing installs and on for new ones, or gate it on an explicit opt-in the user already expressed by making the role visible.

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
7. **Flip `autobanEnabled` deliberately**, defaulting so existing installs do not gain a stage without asking.
8. **Delete the unreachable design-doc error** and either implement or remove the `_isAcceptanceTesterDesignDocConfigured` stub.
9. **Resolve the two order arrays** before relying on the column's advance path.

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
- **Role visibility still disables the stage:** hide the role; assert `resolveAutoDispatchColumn` returns null and the `:6988` skip still fires, so an opted-out install is unaffected.
- **The dead error is gone:** assert no code path can emit the Planning Feature message.

### Manual Verification

- Run one real feature end to end with a deliberately deferred MAJOR and confirm it surfaces before COMPLETED.
- Confirm the two halves' token costs are reported separately.

## Outstanding Questions

- **[user]** Confirm the planning bound: recorded deferred findings plus intent gaps named against the Goal, and nothing else?
- **[user]** Should the `autobanEnabled` flip default on for new installs only, or stay opt-in for everyone until asked for?
- Which order array governs the advance out of this column once it is live — `_isColumnBefore`'s, or the TICKET UPDATER carve-out the `:6977` comment describes?
