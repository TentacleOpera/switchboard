# A feature's title and prose must be true of the plans inside it

**Project:** Browser Switchboard

## Goal

Stop the grouping and backfill passes from describing a feature by its subtasks' titles. The title and the prose must be true of what the plan files actually contain, and neither may assert that material moved somewhere without checking that it arrived.

### Problem Analysis

**The skill already knows titles are not enough — but only for clustering.** `manage-features/SKILL.md:310-314` (step 2, READ PLAN BODIES) says: *"For each candidate plan in scope, read the full plan file. Extract: goal, problem summary, dependencies, tags. **Use this — not just titles — to determine groupings.**"*

That instruction governs which plans land together. Nothing carries it into what gets written. Step 3's output format is keyed on the name:

> `- How the Subtasks Achieve This: one bullet per member plan explaining what it does and how it contributes to the feature's goal. Format: - **Plan Name**: <what it does and how it contributes>`

Same at `agentPromptBuilder.ts:987`, which composes the backfill prompt: *"one bullet per member plan (subtask) explaining what it does and how it contributes… Format: `- **<Plan Name>**: <what it does and how it contributes>`"*. And `improve-feature/SKILL.md:54` says to *"backfill from the subtasks if missing"* without saying to read them.

So an agent reads bodies to decide grouping, then writes the description from the titles. When a subtask's title is narrower than its plan, the feature's title and prose narrow with it, and the plan's remaining content becomes invisible to anyone reading the feature.

**A worked instance, verified.** `worktrees-consolidate-to-two-models-and-streams-become-a-sta-a5221df8….md`:

- Subtask `fc3d5e9a`'s plan was retitled by `c630a80f` from *"Mission cards: turn dispatch analysis into a stream map on a card, launched from the board"* to *"Persist dependency edges and gate dispatch on asserted completion at pop time"*. Only the title changed — the mission-card material stayed in the file.
- The feature was then retitled from *"Worktrees Consolidate to Two Models, and Streams Become a Stage Map"* to *"Worktree Models and Dependency-Gated Dispatch"*, and its subtask bullet rewritten to describe only the dispatch gate.
- The feature's `Dependencies & sequencing` then asserted, in the past tense: *"**The mission-card material is no longer in this feature** — it was split out to `the-automation-model-four-things-not-a-mode-axis.md` and `mission-control-panel-ui-specification.md`."*

That last sentence is false, and one grep disproves it: both named files contain the phrase *"mission card"* **zero** times; the subtask plan contains it **28** times, and building the mission card is Proposed Change item 7 there. The plan's own note calls the split *"Recommendation Only — Not Performed Here"*. The agent read a recommendation and wrote it up as a completed migration.

**The cost is not a wrong label — it is work that cannot be found.** A reviewer tracing the mission card design read the retitled card, then the sequencing paragraph saying the material had moved, and concluded the design was orphaned. Item 7 had been in Proposed Changes the whole time. Every gate stayed green throughout: the file parses, the subtask links resolve, the card renders, `mirror:check` passes. Nothing in the system compares a feature's prose against its members' contents, so a false claim there is load-bearing and unchallenged.

**Past tense is what makes it dangerous.** *"belongs with X"* invites a check. *"was split out to X"* forecloses one. The second form tells a reader the question is already answered, which is precisely when nobody re-opens the file.

**The worked instance has since been corrected.** The feature file no longer contains the string "was split out" — a prior `improve-feature` pass rewrote the `Dependencies & sequencing` section to describe the split as the open recommendation it is. The bug class remains real; this specific instance is closed. The Verification Plan below retains a regression guard for it.

### Root Cause

The feature file is authored from the board's view of its members — titles and columns — because that is what the grouping agent has cheaply to hand after clustering. The plan bodies it read in step 2 are used for the grouping decision and then dropped before the writing step. Nothing in the skill, the prompt, or any gate requires the description to be re-derived from, or checked against, the files it describes.

## Metadata

**Complexity:** 4
**Tags:** bugfix, docs

## User Review Required

- The two-copy divergence in `improve-feature` (see Outstanding Questions) needs a human decision on whether to reconcile or delete the alias.

## Settled Design

- **A feature's title and prose are derived from the plan bodies, not from subtask titles.** The step-2 rule — *"use this, not just titles"* — governs the writing as well as the grouping.
- **A claim that material moved is verified before it is written.** If the destination does not contain it, the claim is not written. If a plan calls a split a recommendation, it is described as a recommendation.
- **Deferrals are written in the present, as open items** — *"belongs with X"* — never in the past tense as completed migrations.
- **A retitled subtask does not retitle the feature.** A title change is a title change; whether the feature's scope changed is a separate question answered by reading the plan.

## Complexity Audit

### Routine

- Three text edits: `manage-features/SKILL.md`, `improve-feature/SKILL.md` (canonical protocols copy), and the prompt builder that composes the backfill instruction.

### Complex / Risky

- **The rule has to land where the writing happens, not only where the reading happens.** The existing *"not just titles"* line already proves that a correct instruction in step 2 does not reach step 3. Adding a fourth restatement of "read the bodies" in a preamble would repeat that failure. The constraint belongs inline in the output format that the agent is following as it writes each bullet.
- **`improve-feature` exists in two diverged copies.** `.agents/protocols/improve-feature/SKILL.md` is the canonical copy — the extension dispatches it by path (`agentPromptBuilder.ts:1488`, `KanbanProvider.ts:6610`), and tests read from it (`goal-invariant-verification.test.js:32`). `.agents/skills/improve-feature/SKILL.md` is a discoverable alias listed in the system prompt's skill registry; `agentPromptBuilder.ts:1505` maps it to the protocols path at prompt-build time. The two copies have diverged in opposite directions: the protocols copy has the Goal Invariants addition (line 31) but lacks Team Dispatch Instructions (line 54); the skills copy has Team Dispatch Instructions but lacks Goal Invariants. Editing only one reproduces the exact split-brain this plan exists to prevent. Both must be edited, or the alias deleted and the protocols copy made the sole source.
- **`improve-feature` is NOT in the mirror manifest.** `ClaudeCodeMirrorService.ts:47-94` lists `manage-features`, `query-kanban`, `kanban_operations`, `worktree-cleanup` — not `improve-feature`. The dynamic scan at `:353` only catches `switchboard-*.md` files. So `mirror:check` does not cover `improve-feature`; it covers `manage-features` only. A `mirror:check` pass is green for `improve-feature` drift because `improve-feature` is never mirrored to `.claude/skills/` to begin with.
- **`.agents/` is the source of truth, and `.claude/skills/` is generated.** Editing the mirror directly leaves them divergent and `mirror:check` red. Regenerate rather than hand-edit. The mirror is regenerated by extension activation (which calls `generateClaudeMirror`), not by a standalone CLI command. There is no `npm run mirror:generate`; `mirror:check` regenerates to a temp directory and diffs against the committed tree.
- **This cannot be gated by a test.** No check can decide whether a sentence about a plan is true. The only lever is the instruction, which is why it must be phrased as a refusal — *do not write a claim you have not checked* — rather than as an aspiration.

## Edge-Case & Dependency Audit

**Race Conditions.** None. Instruction text only; no runtime state.

**Migration.** None. Instruction text only; no state, no schema.

**Security.** None.

**Side effects.** Grouping passes become slower where an agent had been writing bullets from titles alone. That is the intended cost.

**Existing feature files carry the defect already.** They are not rewritten by this change. `improve-feature` is the pass that revisits them, and it picks up the corrected instruction the next time it runs on each.

**Dependencies & Conflicts.** The two-copy divergence in `improve-feature` (see Complexity Audit) means a coder must edit both copies or the alias must be deleted before editing. If only the protocols copy is edited, the skills copy stays stale for any agent that loads it via skill discovery.

## Dependencies

- **Corrects** the instructions used by the Group flow of `manage-features` and by `improve-feature`.
- **Must be mirrored (manage-features only):** `.claude/skills/manage-features/` is generated from `.agents/skills/manage-features/`; `npm run mirror:check` gates the two being in step. `improve-feature` is not mirrored — no `mirror:check` coverage applies to it.

## Adversarial Synthesis

Key risks: (1) the rule lands in a preamble the writing step doesn't consult, reproducing the exact gap it describes; (2) the two diverged `improve-feature` copies are edited unevenly, leaving one path stale; (3) `mirror:check` is claimed as a gate for `improve-feature` when it doesn't cover that file. Mitigations: the constraint is written into the output-format block the agent follows while composing each bullet; both `improve-feature` copies are edited (or the alias deleted); the mirror step is scoped to `manage-features` only, with no false claim of `improve-feature` coverage.

## Proposed Changes

### 1. `.agents/skills/manage-features/SKILL.md` — the PROPOSE output format

**Context:** Step 3's format block (`:342-348`) and the write-sections step (`:369-376`).

**Logic:**
- In the `How the Subtasks Achieve This` format line (`:342-344`), state that each bullet describes what the plan file contains, not what its title says, and that a subtask whose plan is wider than its title is described by the plan.
- In the `Dependencies & sequencing` format line (`:345-348`), state that a claim about material having moved is written only after opening the destination and finding it there; that a plan's own recommendation to split is reported as a recommendation; and that deferrals are written as open items in the present tense, never as completed migrations in the past tense.

### 2. `.agents/protocols/improve-feature/SKILL.md` — the backfill step (canonical copy)

> **Superseded:** `.agents/skills/improve-feature/SKILL.md` — the backfill step
> **Reason:** The extension dispatches `improve-feature` from `.agents/protocols/improve-feature/SKILL.md` (confirmed at `agentPromptBuilder.ts:1488` `DEFAULT_FEATURE_PLANNER_WORKFLOW`, `KanbanProvider.ts:6610`, and `goal-invariant-verification.test.js:32`). The `.agents/skills/` copy is a discoverable alias mapped to the protocols path at prompt-build time (`agentPromptBuilder.ts:1505`). Editing the skills copy does not change what the extension sends to dispatched agents. The plan's original target was the alias, not the canonical file.
> **Replaced with:** Edit `.agents/protocols/improve-feature/SKILL.md` (the canonical, dispatched copy). Then sync or delete the `.agents/skills/` alias (see Proposed Change 5).

**Context:** Step 5 (`:54`), which says to backfill *"from the subtasks if missing"*.

**Logic:**
- Say from the subtasks' **plan files**. Add that an existing `Dependencies & sequencing` claim asserting material moved is checked on this pass, and corrected when the destination does not contain it — this is the pass that revisits feature files, so it is where the existing false claims get caught.

### 3. `src/services/agentPromptBuilder.ts` — the composed backfill instruction

**Context:** `:987`, the `How the Subtasks Achieve This` format line in `WRITE_FEATURE_DESCRIPTION_IF_EMPTY_DIRECTIVE`.

**Logic:**
- Carry the same constraint as change 1, so a dispatched agent working from the prompt rather than the skill gets the identical rule.

### 4. Regenerate the mirror (manage-features only)

> **Superseded:** "Run it and confirm `npm run mirror:check` passes" — implying the mirror covers all edited files.
> **Reason:** `improve-feature` is not in the `MIRROR_MANIFEST` (`ClaudeCodeMirrorService.ts:47-94`) and is not picked up by the dynamic scan (`:353`, which only catches `switchboard-*.md`). `mirror:check` does not cover `improve-feature`; it covers `manage-features` only. The original wording implied a gate that doesn't exist for half the changes. Additionally, there is no `npm run mirror:generate` CLI command — the mirror is regenerated by extension activation calling `generateClaudeMirror()`, or by running `mirror:check` (which regenerates to a temp dir and diffs).
> **Replaced with:** Regenerate the mirror by activating the extension (or calling `generateClaudeMirror` on the repo root), then confirm `npm run mirror:check` passes. This covers the `manage-features` change only; `improve-feature` has no mirror to regenerate.

**Logic:**
- `npm run catalog:generate` is unrelated; the relevant regeneration is the `.claude/skills` mirror for `manage-features`. Regenerate by activating the extension (which calls `generateClaudeMirror`) or by running the mirror generation programmatically. Then confirm `npm run mirror:check` passes. Note: `mirror:check` requires `out/services/ClaudeCodeMirrorService.js` — run `npm run compile-tests` first if `out/` is stale.
- `improve-feature` is not mirrored, so no mirror step applies to Proposed Change 2.

### 5. Reconcile the `improve-feature` two-copy divergence

**Context:** `.agents/protocols/improve-feature/SKILL.md` (canonical, dispatched) and `.agents/skills/improve-feature/SKILL.md` (discoverable alias) have diverged in opposite directions — each has one update the other lacks (see Complexity Audit).

**Logic:**
- After editing the protocols copy per Change 2, sync the skills copy to match — OR delete the skills alias entirely and rely on the protocols copy as the sole source. The alias is mapped to the protocols path at prompt-build time (`agentPromptBuilder.ts:1505`), so deleting it does not break dispatch; it only removes the discoverable skill entry from the system prompt's skill registry. The decision is a user question (see Outstanding Questions).

## Verification Plan

### Goal Invariants

- Assert the string "describes what the plan file contains, not what its title says" (or equivalent constraint phrasing) appears inside the `How the Subtasks Achieve This` format block of `.agents/skills/manage-features/SKILL.md` (between lines 342 and 344), not merely elsewhere in the file.
- Assert the string "checked" or "verified" appears in the `Dependencies & sequencing` format block of `.agents/skills/manage-features/SKILL.md` (between lines 345 and 348), confirming the move-claim verification rule is inline in the format block.
- Assert the same constraint string appears in `WRITE_FEATURE_DESCRIPTION_IF_EMPTY_DIRECTIVE` in `src/services/agentPromptBuilder.ts` (within the `How the Subtasks Achieve This` bullet at line 987), not merely elsewhere in the file.
- Assert the string "plan files" (not just "subtasks") appears in step 5 of `.agents/protocols/improve-feature/SKILL.md` at or near line 54.
- Assert the worktrees feature file (`.switchboard/features/worktrees-consolidate-to-two-models-and-streams-become-a-sta-a5221df8-9e58-4367-9417-03bc798490b0.md`) does not contain the string "was split out" — the past-tense form that made the original claim unverifiable. (Regression guard; the instance is already corrected.)

### Automated Tests

- **The rule is where the writing happens:** assert `manage-features/SKILL.md`, `improve-feature/SKILL.md` (protocols copy), and `agentPromptBuilder.ts` carry the constraint inside their `How the Subtasks Achieve This` / `Dependencies & sequencing` format blocks, not merely somewhere in the file. A preamble-only match passes a naive grep and reproduces the exact gap this plan exists to close, so the assertion is scoped to the format block.
- **Mirror is in step (manage-features only):** `npm run mirror:check` passes after regeneration. This covers the `manage-features` change; `improve-feature` is not mirrored and has no mirror:check coverage.
- **The known instance stays corrected:** assert the worktrees feature file does not contain the string "was split out".
- **Two-copy sync:** if the skills alias is retained (not deleted), assert `.agents/skills/improve-feature/SKILL.md` and `.agents/protocols/improve-feature/SKILL.md` are identical after the edit (e.g. `diff` returns zero).

### Manual Verification

- Run a Group pass over three plans, one of whose title is narrower than its body; confirm the bullet describes the body.
- Run `improve-feature` on a feature file carrying a "was split out" claim; confirm the claim is checked and corrected rather than preserved.

## Outstanding Questions

- **[user]** The `.agents/skills/improve-feature/SKILL.md` alias has diverged from the canonical `.agents/protocols/improve-feature/SKILL.md`. Should the alias be (a) synced to match the protocols copy after editing, or (b) deleted entirely so the protocols copy is the sole source? Proceeding on the assumption that the alias will be synced (option a), since deleting it removes the discoverable skill entry from the system prompt's skill registry, and the alias exists for a reason — but the user may prefer to eliminate the split-brain surface entirely.
