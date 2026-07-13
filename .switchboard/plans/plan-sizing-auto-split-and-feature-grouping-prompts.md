# Plan Sizing: Auto-Split + Feature Grouping in Plan-Writing Prompts

## Goal

Agents are writing enormous single plans that should be split into multiple smaller plans and grouped under a feature. The current feature-grouping language in all plan-writing prompts is reactive — it triggers on "3 or more plan files" — but agents write ONE mega-plan, so the trigger never fires. The fix adds a proactive **Plan Sizing** step to the planning flow: agents assess scope before drafting, auto-split when the work spans multiple distinct deliverables or independently-shippable phases, write separate plan files, then notify the user and offer to group them as a feature.

### The problem this solves

The feature-grouping nudge in `DEFAULT_CHAT_BASE_INSTRUCTIONS`, `switchboard-cloud.md`, `switchboard-memo.md`, `switchboard-remote.md`, and `_buildMemoPlannerPrompt` all say some version of "when the work spans 3 or more plan files, offer to group them under a feature." This assumes the agent has already decided to write multiple plans. But the actual failure mode is the opposite: the agent writes one giant plan (e.g. `switchboard-docs-section-astro.md` — 331 lines covering Astro migration, 20+ doc pages, layout system, build pipeline, and content adaptation), the plan-count trigger never fires, and no feature is ever suggested.

### Root cause

1. **No splitting guidance.** Prompts tell agents to *group* 3+ plans into a feature, but never tell agents to *split* an oversized plan into multiple smaller ones.
2. **No scope heuristic.** Agents have no signal for what constitutes "too large for one plan."
3. **Trigger is plan-count-based, not work-scope-based.** "3 or more plan files" only fires if multiple plans already exist.
4. **Feature grouping is buried as a postscript.** It's after the Process section, not integrated into the planning flow.

## Metadata

**Complexity:** 5
**Tags:** backend, feature, refactor, docs
**Project:** Website

> **Superseded:** Complexity: 4
> **Reason:** Originally scored as routine single-file text edits. Code verification revealed (a) a fifth prompt surface was missed (`switchboard-remote.md`), (b) a step-4/step-5 timing contradiction in the memo flow that creates orphan plan files, and (c) a dangling forward pointer in `switchboard-cloud.md`. These are two moderate, well-scoped coordination risks (sync drift across 5 files + memo write-ordering) extending the routine text-substitution pattern — the definition of Mixed (5-6).
> **Replaced with:** Complexity: 5

## User Review Required

Yes — before implementation. Two judgment calls need user sign-off:
1. **Auto-split without pre-permission.** Step 3 directs the agent to split and write multiple plan files, then notify the user at the Gate (not ask first). This makes the planner more autonomous in a prompt whose posture is "orchestrate, don't develop." The plan carves out "if the user explicitly asks for a single plan, respect that," but the default behavior shifts from propose-then-write to write-then-notify. Confirm this is desired.
2. **Behavioral verification approach.** The sync test verifies text presence only. A behavioral check (running a known mega-plan scope through the updated prompt and observing whether the agent splits) is proposed in the Verification Plan. Confirm whether that behavioral check should be a manual QA step or a heavier integration test.

## Complexity Audit

### Routine
- Replacing one Process block with another across 5 prompt surfaces — pure text substitution, no logic.
- Folding the "Feature Grouping:" postscript header into the Gate step — deletion + relocation of existing prose.
- Adding a new regression test (`prompt-split-guidance-sync.test.js`) that asserts string presence — standard `assert.includes` pattern matching existing prompt tests in `src/test/`.
- All edits reuse existing prompt structure (numbered Process steps, same skill-invocation language for `create-feature-from-plans`).

### Complex / Risky
- **Sync drift across 5 files.** `DEFAULT_CHAT_BASE_INSTRUCTIONS`, `switchboard-cloud.md`, `switchboard-memo.md`, `switchboard-remote.md`, and `_buildMemoPlannerPrompt` must all carry the same splitting signals. The new sync test mitigates this, but it only catches drift if it asserts all five surfaces — the original plan's test covered four and would have silently allowed the remote surface to drift.
- **Memo write-ordering.** The memo Process Memo Command must split in step 4 (before any plan file is written), not step 5 (after). Getting this wrong creates orphan plan files inside a workflow that guarantees "no memos lost on failure" — a data-integrity risk, not just a wording risk.
- **Dangling forward pointer in `switchboard-cloud.md`.** Line 34 references "the Feature Grouping section below"; deleting that section without rewriting line 34 leaves a runtime tombstone reference that agents will try to follow.
- **Verification green-metric trap.** Text-presence tests do not prove agents actually split. Without a behavioral check, the test passes while the root failure mode persists.

## Edge-Case & Dependency Audit

**Race Conditions**
- None. All changes are static prompt text and a static test file. No runtime state, no concurrent access.

**Security**
- None. No secrets, no auth surfaces, no user-input handling changes. The `create-feature-from-plans` skill invocation language is preserved verbatim from the existing prompts.

**Side Effects**
- Auto-split changes the shape of what the user approved during Iterate. A user who said "plan the docs migration" may receive 5 plan files at the Gate instead of 1. Mitigated by the explicit "if the user explicitly asks for a single plan, respect that" carve-out and the Gate notification.
- Removing the "Feature Grouping:" header section from `DEFAULT_CHAT_BASE_INSTRUCTIONS` changes the string content of a exported prompt constant. Any external consumer that greps for the literal "Feature Grouping:" header (none found in `src/` beyond the source definition) would break. The sync test asserts the header is gone.

**Dependencies & Conflicts**
- `DEFAULT_CHAT_BASE_INSTRUCTIONS` is documented (line 768) as needing to stay in sync with `.agents/workflows/switchboard-cloud.md`. This plan enforces that via the sync test.
- `switchboard-remote.md` and `.claude/skills/switchboard-remote/SKILL.md` are host-mirrors. This plan edits the canonical `.agents/workflows/switchboard-remote.md`; the mirror is regenerated by the extension's mirror logic and is NOT edited by hand (per the FOCUS directive — the plan file path is the source of truth).
- AGENTS.md is auto-generated between `<!-- switchboard:agents-protocol:start -->` / `:end -->` markers and is NOT edited by this plan. The `DEFAULT_CHAT_BASE_INSTRUCTIONS` constant is the prompt text agents receive; AGENTS.md generation is a separate concern.
- The proposed test file `src/test/prompt-split-guidance-sync.test.js` must be registered with the project's test runner. Existing prompt tests (`prompt-working-dir-regression.test.js`, `prompts-tab-move-regression.test.js`) live in `src/test/` and run via the project's standard test command — the new test follows the same convention.

## Dependencies

- None. This is a self-contained prompt-text refactor with no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) the sync test verifies prompt *text presence* not *agent behavior*, so it can pass while mega-plans persist; (2) the memo step-4/step-5 split timing, if ordered wrong, creates orphan plan files inside a "no loss" workflow; (3) a fifth prompt surface (`switchboard-remote.md`) was originally missed, breaking the "all prompts" goal. Mitigations: add a behavioral verification step alongside the sync test, confine the split decision to memo step 4 (before any write), and add `switchboard-remote.md` as change #6 with sync-test coverage.

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` — `DEFAULT_CHAT_BASE_INSTRUCTIONS` (line 771-790)

Replace the current Process + Feature Grouping sections with a new Process that includes a **Plan Sizing** step (step 3) and integrates feature grouping into the Gate step (step 5).

**Current Process (lines 783-790):**
```
Process:
1. **Onboard:** Greet the user. Identify the core problem or opportunity. Focus on ideation.
2. **Iterate:** Ask "Why" before "How." Challenge assumptions. Document requirements, edge cases, and risks the user may have missed.
3. **Plan:** When the "What" and "Why" are clear, draft the implementation plan.
4. **Gate:** Only suggest moving forward once the plan is complete and the user has explicitly approved it.

Feature Grouping:
When the work spans 3 or more plan files on a related topic (sharing a common feature area or root cause), flag it during scoping — "This looks like it will produce 3+ related plans — want me to group them under a feature once they're drafted?" — and offer again at the closing gate once all plans are written (or once the user signals scoping is complete). Only create the feature if the user confirms. When the user says yes, invoke the `create-feature-from-plans` skill — it handles the mechanics (plan ID resolution, `create-feature.js` execution, verification, and narrative section writing). Do NOT write feature files by hand or reverse-engineer the creation script. If the extension is not running, the skill will fall back to the `create-feature` remote path automatically.
```

**New Process:**
```
Process:
1. **Onboard:** Greet the user. Identify the core problem or opportunity. Focus on ideation.
2. **Iterate:** Ask "Why" before "How." Challenge assumptions. Document requirements, edge cases, and risks the user may have missed.
3. **Assess scope — split before drafting.** Before writing any plan file, assess whether the work is one plan or multiple. Auto-split into separate plan files when EITHER signal is present:
   - **3+ distinct deliverables:** the work produces 3+ independent outputs (e.g. 3+ pages, 3+ components that don't share a root cause, 3+ API endpoints in different domains, 3+ unrelated bug fixes).
   - **2+ independently-shippable phases:** the work has sequential stages where each could be shipped on its own (e.g. "migrate framework" then "build new pages" then "set up deploy pipeline").
   When splitting: write each as a separate plan file with its own Goal, Metadata, and Verification Plan. Do NOT write one mega-plan covering all deliverables/phases — each plan must be independently codeable. If the user explicitly asks for a single plan, respect that and write one.
4. **Plan:** Draft the implementation plan(s). If you split, write each plan file now, in this step.
5. **Gate:** Present the plan(s) to the user. If you wrote 3+ plans, notify the user and offer to group them: "I've split this into [N] plans covering [topic] — want me to create a feature to group them?" Only create the feature if the user confirms. When the user says yes, invoke the `create-feature-from-plans` skill — it handles the mechanics (plan ID resolution, `create-feature.js` execution, verification, and narrative section writing). Do NOT write feature files by hand or reverse-engineer the creation script. If the extension is not running, the skill will fall back to the `create-feature` remote path automatically.
```

Key changes:
- New step 3 ("Assess scope — split before drafting") with concrete splitting signals
- Step 4 is now just "draft" (the decision was made in step 3)
- Step 5 (Gate) absorbs the feature-grouping offer — no more separate postscript section
- The "Feature Grouping:" header section is removed entirely (folded into step 5)
- Auto-split behavior: the agent splits and writes multiple plans, then notifies the user (not asks permission first)

### 2. `.agents/workflows/switchboard-cloud.md` (lines 24-44)

Keep in sync with the new `DEFAULT_CHAT_BASE_INSTRUCTIONS`. Replace the current Process section (lines 24-28) and Feature Grouping section (lines 37-44) with the same new Process (steps 1-5) from change #1.

The cloud workflow currently has a slightly different structure (separate "Feature Relationships" and "Feature Grouping" sections). The "Feature Relationships" section (lines 30-34) stays — it's about frontmatter mechanics, not about when to split. The "Feature Grouping" section (lines 37-44) is replaced by the new step 5 in the Process.

> **Superseded:** "The 'Feature Relationships' section (lines 30-34) stays — it's about frontmatter mechanics, not about when to split."
> **Reason:** Line 34 of that section contains a forward pointer: "If you want to group plans into a feature, refer to the **Feature Grouping** section below and invoke the `create-feature-from-plans` skill." Deleting the Feature Grouping section (lines 37-44) leaves this pointer dangling — agents reading the workflow at runtime will follow a reference to a section that no longer exists.
> **Replaced with:** The "Feature Relationships" section (lines 30-34) stays, BUT line 34 must be rewritten to point to the new location: "If you want to group plans into a feature, see step 5 (Gate) of the Process above and invoke the `create-feature-from-plans` skill." This closes the dangling reference created by folding Feature Grouping into the Process.

### 3. `.agents/workflows/switchboard-memo.md` (Process Memo Command, steps 4-5)

Update step 4 to perform the splitting decision **before** any plan file is written, and revert step 5 to feature-grouping only.

**Current step 4 (line 53, tail):** "Create one plan per entry."

**New step 4:** "Create one plan per entry. **Before writing**, assess whether any single entry covers 3+ distinct deliverables or 2+ independently-shippable phases — if so, split that entry into multiple plan files now (each independently codeable with its own Goal, Metadata, and Verification Plan). The split decision is made here, before any file is written, so no orphan plans are created. Otherwise, one entry = one plan."

> **Superseded:** The original change #3 proposed a "New step 5" that began: "Split oversized entries, then offer feature grouping. After creating all plan files: first, check whether any single entry was large enough to warrant splitting — if one entry covers 3+ distinct deliverables or 2+ independently-shippable phases, split it into multiple plan files now..."
> **Reason:** Step 4 already created one-plan-per-entry. Splitting in step 5 means plan files are written, then MORE plan files are written, leaving the originals as orphans — inside a workflow whose step 6 guarantees "no memos lost on failure." This extends the data-loss surface from memos to plans and creates a cleanup problem the workflow does not handle. The split decision must happen before the write, not after.
> **Replaced with:** Step 4 performs the split assessment and writes the correct number of plan files in one pass. Step 5 reverts to feature-grouping only (unchanged from current).

**Step 5 (line 54):** Keep as-is — "Offer feature grouping" only. Do NOT add splitting language to step 5. The current step 5 text is correct and stays.

### 4. `src/services/TaskViewerProvider.ts` — `_buildMemoPlannerPrompt` (line 3903-3936)

Add splitting guidance to the UI-driven memo prompt. Currently the "Important" section (line 3932-3936) says "Create N plan file(s) total — one per issue" and then the feature-grouping offer.

**Add to the Instructions section (after step 4, before the Plan File Format section):**
```
5. If a single issue covers 3+ distinct deliverables or 2+ independently-shippable phases, split it into multiple plan files — each independently codeable with its own Goal, Metadata, and Verification Plan. Otherwise, one issue = one plan.
```

**Update the Important section to include splitting + feature grouping:**
```
## Important
- Create ${issues.length} plan file(s) total — one per issue (more if any issue is split per the splitting rule above)
- Write each plan to: ${plansDir}/feature_plan_<YYYYMMDDHHMMSS>_<slug>.md
- Do NOT skip the investigation step — read the relevant code before writing each plan
- If you created 3 or more plan files that cover a related topic (sharing a common feature area or root cause), offer to create a feature grouping them: "These [N] plans cover related work — want me to create a feature to group them together?" Only create the feature if the user confirms. Do NOT hand-write the feature file. If the VS Code extension is running (check ${workspaceRoot}/.switchboard/api-server-port.txt), run: node "${workspaceRoot}/.agents/skills/kanban_operations/create-feature.js" "<featureName>" '<planIdsJson>' "${workspaceRoot}" "<description>" — this does DB upsert + subtask linking atomically. If the extension is not reachable, invoke the create-feature skill (direct file write to .switchboard/features/). Use planId UUIDs from the kanban DB or kanban-board.md, NOT filenames.
```

### 5. `.agents/workflows/switchboard-remote.md` (lines 204-217) — NEW

> **Superseded:** The original plan listed only four prompt surfaces (`DEFAULT_CHAT_BASE_INSTRUCTIONS`, `switchboard-cloud.md`, `switchboard-memo.md`, `_buildMemoPlannerPrompt`) and claimed to cover "all plan-writing prompts."
> **Reason:** Code verification (`grep` for the feature-grouping trigger across the repo) revealed `switchboard-remote.md` lines 204-217 contain the identical reactive "3 or more plan files" Feature Grouping section the plan is eliminating. The remote workflow drives plans via Linear/Notion — it is a plan-writing surface by the plan's own definition. Omitting it breaks the "all prompts" goal and leaves the reactive trigger live in the remote path.
> **Replaced with:** Add change #5 (renumbered from the original #5 test) for `switchboard-remote.md`, and extend the sync test to cover it.

Replace the current "## Feature Grouping" section (lines 204-217) with a splitting-aware version. The remote workflow does not use the same numbered Process block as the chat/cloud prompts (it is Linear/Notion-driven), so the change is scoped to the Feature Grouping section: prepend a splitting directive and keep the remote-specific feature-creation path (`/create-feature` skill or `create-feature.js`).

**New section (replaces lines 204-217):**
```
## Plan Sizing & Feature Grouping

**Plan Sizing — split before drafting.** Before writing any plan file, assess whether the work is one plan or multiple. Auto-split into separate plan files when EITHER signal is present:
- **3+ distinct deliverables:** the work produces 3+ independent outputs (e.g. 3+ pages, 3+ components that don't share a root cause, 3+ API endpoints in different domains, 3+ unrelated bug fixes).
- **2+ independently-shippable phases:** the work has sequential stages where each could be shipped on its own.
When splitting: write each as a separate plan file with its own Goal, Metadata, and Verification Plan. If the user explicitly asks for a single plan, respect that and write one.

**Feature Grouping.** When the work described will span 3 or more plan files on a related topic (sharing a common feature area or root cause):
- **Early (during scoping):** Flag it once: *"This looks like it will produce 3+ related plans — once they're all drafted, want me to group them under a feature?"* Do not create anything yet.
- **Closing (when all plans are drafted):** Offer again: *"You now have [N] plans covering [topic] — want me to create a feature to group them?"*

Only create the feature if the user confirms. In a remote session, feature creation follows the `/create-feature` skill (direct file write to `.switchboard/features/`) or the `create-feature.js` script if the extension is reachable.
```

### 6. Sync test (new) — `src/test/prompt-split-guidance-sync.test.js`

> **Superseded:** The original change #5 proposed a sync test covering four prompt surfaces: `DEFAULT_CHAT_BASE_INSTRUCTIONS`, `switchboard-cloud.md`, `_buildMemoPlannerPrompt`, and `switchboard-memo.md`.
> **Reason:** The test would have silently allowed `switchboard-remote.md` to drift, since it was not asserted. A sync test that omits a surface is worse than no test — it gives false confidence that all surfaces are covered.
> **Replaced with:** The sync test asserts all FIVE prompt surfaces contain the splitting signals and are in sync, including `switchboard-remote.md`.

Add a regression test that verifies:
- `DEFAULT_CHAT_BASE_INSTRUCTIONS` contains the "Assess scope" step with both splitting signals ("3+ distinct deliverables" and "2+ independently-shippable phases")
- `DEFAULT_CHAT_BASE_INSTRUCTIONS` does NOT contain the old "Feature Grouping:" header (it's been folded into step 5)
- `switchboard-cloud.md` contains the same "Assess scope" step (sync check) AND line 34's forward pointer references step 5 (not a deleted "Feature Grouping section below")
- `switchboard-remote.md` contains the "Plan Sizing — split before drafting" directive with both splitting signals
- `_buildMemoPlannerPrompt` output contains the splitting guidance (step 5 of its Instructions)
- `switchboard-memo.md` step 4 mentions splitting; step 5 does NOT mention splitting (regression guard against the orphan-plan timing bug)

This test prevents the prompts from drifting apart in future edits and guards against re-introducing the step-4/step-5 contradiction.

## Verification Plan

> **Note:** Per session directives, compilation and automated tests are SKIPPED from this verification plan. The steps below are what a coder should run during implementation; this plan does not execute them.

### Automated Tests
- **Sync test:** Run the new `src/test/prompt-split-guidance-sync.test.js` — verifies all FIVE prompt surfaces contain the splitting signals, the old "Feature Grouping:" header is gone from the chat base instructions, the cloud forward pointer targets step 5, and the memo step 4/step 5 split responsibility is correct (split in 4, not 5).
- **Existing tests:** Run the project's test command to ensure no existing prompt tests break. `prompt-working-dir-regression.test.js` and `prompts-tab-move-regression.test.js` verify prompt structure but don't assert feature-grouping text, so they should pass.

### Behavioral Verification (closes the green-metric gap)
- **Manual behavioral check:** Take the cited mega-plan scope (the `switchboard-docs-section-astro.md` work: Astro migration + 20+ doc pages + layout system + build pipeline + content adaptation) and run it through the updated chat prompt as a new consultation. Observe whether the agent splits into multiple plan files at step 3. If it still produces one mega-plan, the splitting signals are insufficient and the prompt needs stronger anchors — the sync test alone cannot detect this failure.
- **Memo behavioral check:** Enter a multi-part memo entry that spans 3+ distinct deliverables, run `process memo`, and confirm the agent splits in step 4 (before write) — verify no orphan plan files are left from a post-write split.

### Manual Verification
- Copy a chat prompt from the Kanban board and confirm the new Process steps (including "Assess scope") are present in the copied text.
- Open the Memo tab, enter a multi-part issue, click "Copy Prompt", and confirm the splitting guidance is in the prompt text.
- Open `switchboard-remote.md` and confirm the "Plan Sizing — split before drafting" directive is present and the old reactive-only "Feature Grouping" section is gone.

### Build (skipped per session directive)
- ~~Run `npm run compile` to ensure TypeScript changes compile cleanly.~~ — skipped; coder to run during implementation.

## Edge Cases & Risks

- **User explicitly asks for one plan.** The new step 3 includes "If the user explicitly asks for a single plan, respect that and write one." This prevents the agent from over-splitting when the user wants a single comprehensive plan.
- **Work is complex but truly one deliverable.** A single complex feature (e.g. "implement OAuth flow") is one plan with high complexity — it doesn't have 3+ distinct deliverables or 2+ shippable phases. The splitting signals are about scope, not complexity.
- **Memo entries are typically small.** The memo splitting guidance only fires when a single entry is oversized. Normal one-line bug reports stay as one plan per entry.
- **Sync drift between chat base instructions, cloud, remote, and memo prompts.** There was no existing sync test. The new test in change #6 addresses this gap across all five surfaces.
- **AGENTS.md propagation.** AGENTS.md is auto-generated from the extension code between `<!-- switchboard:agents-protocol:start -->` / `:end -->` markers. The `DEFAULT_CHAT_BASE_INSTRUCTIONS` constant is the prompt text sent to agents — it's not directly in AGENTS.md. However, if the Plan Authoring Protocol section in AGENTS.md should also mention splitting, that's a separate change to the generation logic. This plan does not modify AGENTS.md generation — the prompt changes are sufficient since the prompt is what agents actually receive.
- **Auto-split vs. approval posture.** Step 3 directs the agent to split and write without pre-permission, then notify at the Gate. This is more autonomous than the current "propose then write" posture. Mitigated by the single-plan carve-out and the Gate notification. Flagged in User Review Required.
- **Remote workflow mirror.** `.claude/skills/switchboard-remote/SKILL.md` mirrors `.agents/workflows/switchboard-remote.md`. Only the canonical `.agents/workflows/` file is edited; the mirror is regenerated by the extension. The sync test asserts the canonical file.

## Recommendation

Complexity 5 → **Send to Coder** (4-6 range). Multi-file routine text edits with two moderate coordination risks (sync drift, memo write-ordering) that the corrections and sync test address. No architectural change, no new patterns — a coder can execute this directly.

## Completion Summary

Implemented all 6 changes. Added a proactive "Plan Sizing — split before drafting" step (step 3) with both splitting signals ("3+ distinct deliverables", "2+ independently-shippable phases") and the single-plan carve-out to `DEFAULT_CHAT_BASE_INSTRUCTIONS` (`src/services/agentPromptBuilder.ts`), `switchboard-cloud.md`, and `switchboard-remote.md`; folded the old reactive "Feature Grouping:" postscript into the Gate step (step 5) in the chat base and cloud workflow, and closed the dangling "Feature Grouping section below" forward pointer in `switchboard-cloud.md` to point at step 5. Updated `switchboard-memo.md` step 4 to perform the split decision before any plan file is written (no orphan plans), leaving step 5 as feature-grouping-only. Added step 5 + Important-section cross-reference to `_buildMemoPlannerPrompt` in `src/services/TaskViewerProvider.ts`. Replaced `switchboard-remote.md`'s reactive-only "Feature Grouping" section with a combined "Plan Sizing & Feature Grouping" section. Created `src/test/prompt-split-guidance-sync.test.js` asserting all FIVE surfaces carry the splitting signals, the old header is gone, the cloud forward pointer targets step 5, and the memo step-4/step-5 split-timing invariant holds. Files changed: `src/services/agentPromptBuilder.ts`, `.agents/workflows/switchboard-cloud.md`, `.agents/workflows/switchboard-memo.md`, `src/services/TaskViewerProvider.ts`, `.agents/workflows/switchboard-remote.md`, `src/test/prompt-split-guidance-sync.test.js` (new). No issues encountered; per session directives, compilation and automated tests were skipped — verification was done via grep-based read-back across all 5 surfaces (all assertions hold). The `.claude/skills/switchboard-remote/SKILL.md` mirror was intentionally not edited (regenerated by the extension); AGENTS.md was not edited (auto-generated).

## Review Findings

Reviewer pass (in-place, adversarial + regression). All 5 canonical prompt surfaces verified correct against the plan spec: `DEFAULT_CHAT_BASE_INSTRUCTIONS` (agentPromptBuilder.ts:783-794), `switchboard-cloud.md` (Process + Feature Relationships pointer), `switchboard-memo.md` (step 4 split-before-write, step 5 feature-grouping-only), `_buildMemoPlannerPrompt` (TaskViewerProvider.ts:3917-3937), `switchboard-remote.md` (Plan Sizing & Feature Grouping section). Sync test `src/test/prompt-split-guidance-sync.test.js` passes (5 surfaces in sync, old "Feature Grouping:" header absent, cloud forward pointer targets step 5, memo step-4/step-5 invariant holds). No CRITICAL or MAJOR code findings — no code fixes applied. Regression audit: no orphaned "Feature Grouping section below" references in any prompt surface; `DEFAULT_CHAT_BASE_INSTRUCTIONS` sole runtime consumer (agentPromptBuilder.ts:1565) treats it as a plain string — no signature/side-effect breakage; no double-trigger or race conditions (all changes are static text). Remaining risk: the `.claude/skills/switchboard-cloud/SKILL.md` and `.claude/skills/switchboard-remote/SKILL.md` mirrors are stale (still carry the old reactive-only "Feature Grouping" section) — this is explicitly accepted by the plan (mirrors regenerate via `ClaudeCodeMirrorService.generateClaudeMirror` on extension activation) and self-heals on next extension start; not hand-edited per plan scope. The sync test intentionally asserts canonical files only (asserting mirrors would fail on clean checkout before first activation).
