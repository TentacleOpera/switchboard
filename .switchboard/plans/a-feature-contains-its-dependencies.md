# A feature contains its dependencies

**Project:** Browser Switchboard

## Goal

When an agent groups plans into a feature, a plan and the plans it declares it requires land in the same feature — unless that would push the feature past ten subtasks, in which case the split is deliberate and the cross-feature dependency is stated. Stop producing features that hold half a capability.

### Problem Analysis

**Dependencies are already read at grouping time, and used only to cluster.** `manage-features/SKILL.md:310-314`, step 2 READ PLAN BODIES: *"For each candidate plan in scope, read the full plan file. Extract: goal, problem summary, **dependencies**, tags. Use this — not just titles — to determine groupings."*

So a declared dependency is a hint that two plans are related. Nothing makes it a rule about where they end up. Step 3 then groups *"by underlying capability theme"* — a judgement made on how the plans read, which a declared `Requires` can lose to a shared keyword.

**A worked instance, verified.** `mission-control-panel-ui-specification.md:230` states, in its own Dependencies section:

> **Requires** `staging-streams-parallel-dispatch-and-worktrees.md` for missions, stream maps and the sequencing view.

A hard, explicit, machine-readable requirement. The two plans are in different features:

| Feature | Created | Subtasks |
| --- | --- | --- |
| Mission Control: rename the orchestrator and settle its surfaces | 2026-08-23 13:45 | panel UI spec · one controller · rename the orchestrator · automation model |
| Worktree Models and Dependency-Gated Dispatch | 2026-08-24 22:22 | **the plan the panel requires** · worktree model consolidation |

Two groupings a day apart. The first grouped on the phrase *"Mission Control"* appearing in four titles. The second grouped on the filename `…-and-worktrees.md`. Neither consulted the `Requires` line, which was present in both passes.

**The threshold was never the constraint.** Combined, those two features hold five subtasks. Nothing about size forced the split — it was not a scoping decision at all, it was a keyword falling out differently on two different days.

**What a split capability costs, concretely.** The panel half reached CODE REVIEWED and shipped: `src/webview/mission-control.html` (27 KB) and `mission-control.js` (43 KB) are in the tree. The half it requires is still in PLAN REVIEWED. So a finished UI renders a mission object nothing produces — `grep maxExtraWorktrees src/services/` returns nothing, there is no missions table, no `mission_id`, no reader, no writer. Its own feature file records this as a remaining risk and does not treat it as a defect.

Worse than the dead tab: the interface between the halves was never written down. The panel reads thirteen fields off a mission and posts nine `mc*` verbs; the plan that must produce them mentioned **none** of the twenty-two until `81afd296` pasted them in by hand. A coder dispatched before that would have invented a mission shape and left the finished UI rendering nothing — the work shipped twice, neither half meeting the other.

**A feature is the unit of dispatch, which is why this matters more than tidiness.** Subtasks cascade to a column together and a drive-mode lead works a feature as one run. A feature holding half a capability dispatches half a capability, and the missing half is invisible from inside the run — the coder sees a complete-looking feature file and no signal that the thing they are building against lives elsewhere and is already built.

### Root Cause

Grouping optimises for a readable theme rather than for a runnable unit. "Underlying capability theme" is a judgement about what plans have in common; a declared dependency is a fact about what one plan cannot run without. The skill treats the second as weaker evidence for the first, so a shared word in four titles outweighs an explicit `Requires` in a body.

### Scope Limit (Clarification)

This plan addresses the **declared-dependency** subset of the root cause. A declared `Requires` line is machine-readable and can be made a membership rule. A half-capability where no dependency was ever written down is invisible to this rule and remains a theme-judgment problem the grouping step already has. The worked instance that motivated this plan had a `Requires` line; the rule catches that class. Undeclared half-capabilities are not solved here and are not claimed to be.

## Metadata

**Complexity:** 4
**Tags:** bugfix

## User Review Required

- None.

## Settled Design

- **A declared dependency is a membership rule, not a hint.** If plan A's Dependencies section says it requires plan B, and both are in scope for grouping, they go in the same feature.
- **Ten subtasks is the only reason to split them.** The ceiling is grounded in the existing dispatch guidance: *"one subtask per coder, or it will hit its context limit"* (`src/webview/terminals.js:11053`, `src/webview/kanban.html:4892`, `src/services/teamWiring.ts:760`). Ten subtasks × one coder each is the upper bound where a feature becomes a multi-coder dispatch that exhausts context. The number is a proxy for dispatchability, not an arbitrary limit.
- **A deliberate split states the dependency both ways.** Each feature's `Dependencies & sequencing` names the other feature, which plan needs which, and what is unusable until the other lands. A silent split is the failure this plan exists to stop.
- **Already-grouped features are not rewritten by this change.** The rule applies to grouping passes from here; existing splits are corrected when someone rearranges them.

## Complexity Audit

### Routine

- One rule and one exception, added to the Group flow's grouping step and its proposal format.

### Complex / Risky

- **The rule must bind the grouping decision, not decorate the reading step.** `manage-features/SKILL.md` already says *"use this — not just titles"* in step 2 and it did not reach step 3 twice in two days. A restatement in the same place would fail the same way. The rule belongs in step 3, where the group is chosen, phrased as a constraint on the output rather than as advice on the input.
- **Transitive closure is where a ten-subtask rule turns into a forty-subtask feature.** A requires B requires C requires D. The rule must be applied over the closure and measured against the threshold once, or an agent follows each edge in turn and never notices the size until it has built something undispatchable.
- **The closure boundary must be stated, not assumed.** "In scope for grouping" means: CREATED or PLAN REVIEWED column, project-matched, and not already a subtask of an existing feature (per the SCAN step's existing filters). A dependency on a plan *outside* that set — already in another feature, in BACKLOG, or COMPLETED — is not grouped; it is noted in `Dependencies & sequencing` as an external requirement. Grouping on a COMPLETED dependency would drag finished work back into new features; grouping on a plan already in another feature would silently rip it out.
- **A dependency on an already-shipped plan is not a reason to group.** `mission-control-panel-ui-specification.md` requires a plan that is still Planned — that is a live edge and they belong together. A plan requiring something already in COMPLETED needs no grouping, only a note. Grouping on dead edges would drag finished work back into new features.
- **This cannot be gated by a test.** No check can decide whether two plans form one capability. The lever is the instruction, and the reason to keep it to one rule with one number is that a rule an agent can apply mechanically is the only kind that survives a judgement call about themes.

## Edge-Case & Dependency Audit

**Migration.** None. Instruction text only.

**Security.** None.

**Side effects.** Features get larger, and closer to ten. That is the intended trade: a feature that holds a whole capability is the point, and the threshold is what stops it running away.

**Existing splits stay as they are.** The mission/worktree split is corrected by a Rearrange when someone chooses to, not by this change. Note that moving a subtask between features whose columns differ exposes the `cascadeFeatureByPlanId` semantics — the cascade moves a feature and every active subtask to one column atomically (verified: `src/services/NotionBackupService.ts:157`, `src/standalone/bootstrap.ts:1216`) — so a Rearrange across a column boundary is its own decision, not a side effect of this rule.

## Dependencies

- **Sibling of** `feature-titles-and-prose-must-be-true-of-the-plans-inside.md` — same skill, same pass, same root: grouping reads bodies to decide and then works from titles. That plan governs what a feature is *called*; this one governs what it *contains*.

## Adversarial Synthesis

Key risks: (1) the rule is added to step 2 alongside the existing *"not just titles"* line and never reaches the grouping decision, reproducing the exact failure; (2) the threshold is applied per edge rather than over the transitive closure, producing a feature far past ten; (3) an agent groups on a dependency already satisfied or on a plan outside the in-scope set, dragging finished or foreign work into new features; (4) the "ten" ceiling is perceived as arbitrary and ignored. Mitigations: the rule is written into step 3's proposal constraints; the threshold is a single measurement over the closure; the closure boundary is stated (in-scope = CREATED/PLAN REVIEWED, project-matched, unassigned); and the ceiling is grounded in the existing context-limit dispatch guidance.

## Proposed Changes

### 1. `.agents/skills/manage-features/SKILL.md` — the grouping decision

**Context:** Step 3 PROPOSE (`:318` onward), where groups are chosen *"by underlying capability theme, not by surface keyword"*.

**Logic:**
- Add the rule as a constraint on the group, next to the theme instruction: a plan and the in-scope plans its Dependencies section declares it requires go in the same feature. Compute the closure, then measure once — over ten subtasks, split.
- State the closure boundary explicitly: in-scope means CREATED or PLAN REVIEWED column, project-matched, and not already a subtask of an existing feature (the SCAN step's existing filters). A dependency on a plan outside that set is noted in `Dependencies & sequencing` as an external requirement, not grouped.
- Add the corollary to the `Dependencies & sequencing` format: a split forced by the threshold names the other feature, which plan needs which, and what is unusable until the other lands.

### 2. `.agents/skills/manage-features/SKILL.md` — the Rearrange flow

**Context:** The Rearrange flow (split/move/merge subtasks without rewriting content).

**Logic:**
- Note that a feature whose member declares a requirement on a plan in another feature is a candidate to merge, and that merging across features in different columns is a column decision because of the cascade — not a silent consequence.

### 3. Regenerate the mirror

**Logic:**

> **Superseded:** Regenerate the mirror and confirm `npm run mirror:check` passes.
> **Reason:** There is no `mirror:generate` script. `mirror:check` (`scripts/check-claude-mirror.js`) regenerates into a *temp directory* and diffs against the committed `.claude/skills/` — it does not write to `.claude/skills/`. The actual regeneration happens on extension activation (`generateClaudeMirror` at `src/extension.ts:4073`) or via the scaffold command (`switchboard.scaffoldMultiRepo`). Additionally, `mirror:check` requires the compiled module `out/services/ClaudeCodeMirrorService.js` — its header states "Run after `npm run compile-tests`" — so it fails with a module-not-found error unless the project is compiled first.
> **Replaced with:** After editing `.agents/skills/manage-features/SKILL.md`, regenerate the `.claude/skills/` mirror by reloading the VS Code extension (which calls `generateClaudeMirror` on activation) or by running the scaffold command. Then run `npm run compile && npm run mirror:check` to confirm the committed mirror matches the regenerated source. Note: `mirror:check` requires a compiled `out/` tree — compile first.

## Verification Plan

### Goal Invariants

- A plan and its in-scope declared requirements are in one feature, or the split is stated in both.
- No feature holds half a capability without saying so.
- The "ten" ceiling is grounded in the existing context-limit dispatch guidance, not stated as an arbitrary number.

### Automated Tests

- **The rule is in the deciding step:** assert the constraint appears in step 3's grouping/proposal block, not only in step 2's reading step. A step-2-only match passes a naive grep and is precisely the failure that produced this plan — the existing *"not just titles"* line lives there and did not bind two consecutive grouping passes.
- **The threshold is a closure measurement:** assert the instruction says to compute the transitive closure and measure once, not to follow edges individually.
- **The closure boundary is stated:** assert the instruction specifies that in-scope means CREATED/PLAN REVIEWED, project-matched, unassigned, and that dependencies outside that set are noted, not grouped.
- **Mirror is in step:** `npm run compile && npm run mirror:check` passes after regeneration. (Requires compiled `out/` — compile is a prerequisite, not optional.)

### Manual Verification

- Run a Group pass over a set where plan A's Dependencies declares it requires plan B; confirm they land in one feature.
- Run one where the closure exceeds ten; confirm the split happens and both features name the other, with the direction of need stated.
- Run one where plan A requires a plan already in COMPLETED; confirm the completed plan is not pulled into the new feature, and the requirement is noted in `Dependencies & sequencing`.
