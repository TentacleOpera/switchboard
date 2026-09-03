# The create-feature Skill Documents the Link Mechanism That Works Without the Extension

<!-- board-collapse-02 -->
> **RESCOPED 2026-09-04 (Board Collapse 02).** Delete the proposed `mirror:generate` npm script and `scripts/generate-claude-mirror.js`. The generator is being removed, not given a second entry point — see *Delete the Claude mirror generator*. Edit `.agents/skills/create-feature/SKILL.md` and its `.claude/` counterpart directly, in the same commit. **The rest of this plan stands and is still wanted**: the two stale sections telling remote agents how to link subtasks via `**Feature:**` frontmatter, and flipping "never commit the feature file" to "commit it in remote sessions".


## Goal

Fix two stale sections in the `create-feature` skill that make an agent produce a feature with no subtasks attached, and that tell it not to commit the file it just wrote. Both were caught by an agent following the skill in a real remote session.

### Problem analysis

`create-feature` is the skill for creating a feature when the VS Code extension is **not** running. Two of its sections describe a world that no longer exists.

**Defect A — the skill does not document the link mechanism that works.** Its "Linking Existing Plans as Subtasks" section offers exactly one method, `assign-to-feature.js`, and then says:

> This also routes through the extension; in a remote session it will fail and the agent should note that subtask linking will need to be done when VS Code is next opened, OR the user can drag-and-drop in the kanban UI.

So the skill whose entire purpose is "the extension is unreachable" tells the agent that linking is impossible without the extension. An agent following it literally writes a feature file, links nothing, and hands the user an empty feature plus an apology.

Linking works fine without the extension. `**Feature:** <feature-uuid>` written into each plan's `.md` **is** the carrier — `src/services/PlanIngestionEngine.ts:999` logs *"Linked subtask … to feature … via `**Feature:**` frontmatter"*. It is apply-if-empty (`:993-994` returns early when `featureId` is already set) and it defers with retries when the feature row has not been imported yet (`:978-988`), so plan and feature files can land in either order.

> **Superseded:** The project's own CLAUDE.md documents this as the *only* mechanism: *"Feature relationships are carried by `**Feature:** <feature-plan-id>` … No manifest file or batch payload is used."*
> **Reason:** The quoted text is not in CLAUDE.md. It appears in `.agents/workflows/switchboard-cloud.md` (line 39) and its mirror `.claude/skills/switchboard-cloud/SKILL.md` (line 39). The `improve-plan` SKILL.md itself (line 149) also documents this mechanism. CLAUDE.md contains the Switchboard protocol (workflow registry, skill table, plan-authoring rules) but does not include the "No manifest file or batch payload is used" sentence. The misattribution does not change the argument — the mechanism IS documented in the project — but the citation must point to the correct file so a verifier can check it.
> **Replaced with:** The project documents this as the *only* mechanism in `.agents/workflows/switchboard-cloud.md:39` (and its mirror): *"Feature relationships are carried by `**Feature:** <feature-plan-id>` … No manifest file or batch payload is used."* The `improve-plan` SKILL.md (line 149) states the same. The skill and the project instructions disagree, and the skill is the one an agent reads while doing the task.

**This is on every remote grouping path.** `create-feature-from-plans` is the extension-running skill, and it correctly hands off when the extension is down — *"fall back to the `create-feature` skill"* (`.agents/skills/create-feature-from-plans/SKILL.md:19`, `:26`, `:71`). The `switchboard-cloud` workflow says the same. So all of them terminate in the broken section.

**Defect B — the "don't commit" instruction is stale.** "After Writing" says:

> Do NOT commit or push — creating a feature is a planning action. Leave the new file in the working tree for the user. (The features folder will be tracked once `expose-features-folder-in-gitignore.md` is deployed.)

That plan has deployed and is gone from `.switchboard/plans/`. `.gitignore:55` carries an explicit `!.switchboard/features/` negation, and 261 feature files are tracked today. The parenthetical describes a pre-deployment state, and the instruction it justifies leaves a remote agent's work uncommitted in an ephemeral container.

**Where the fix goes.** `.agents/` is the source of truth; `.claude/skills/` is **generated**. `scripts/check-claude-mirror.js` regenerates the mirror from `.agents/` with the same `generateClaudeMirror` the extension uses and fails CI on drift, and its header names the reason: *"the exact failure mode behind the 'skill fixes don't stick' bug this guard backstops."* The two copies differ only in that the `.claude` one carries YAML frontmatter, which the generator adds. Editing `.claude/skills/create-feature/SKILL.md` is the wrong move and turns `mirror:check` red — and it is the likely wrong move, because that is the copy an agent reads.

**A contributing gap:** there is a `mirror:check` script but no regenerate script. An agent that correctly edits `.agents/` has no documented way to refresh the mirror, so it either leaves CI red or hand-edits `.claude/` and defeats the guard. `generateClaudeMirror(rootDir, extensionVersion)` is exported at `src/services/ClaudeCodeMirrorService.ts:446`.

## Metadata

**Complexity:** 2
**Tags:** docs, bugfix

## User Review Required

Yes — the rewrite of the "After Writing" section changes the commit guidance from "never commit" to "commit in remote sessions." This is a behavioral policy change for agents following the skill. The user should confirm that remote agents committing feature files (and the plans they group) is the desired behavior, since it changes what a remote session leaves behind in the git tree.

## Complexity Audit

### Routine
- Editing markdown content in a single skill file (`.agents/skills/create-feature/SKILL.md`).
- Adding one npm script entry to `package.json` (`mirror:generate`).
- Regenerating the mirror by running the new script — mechanical, idempotent.
- Grep-based verification that stale claims are gone.

### Complex / Risky
- The "After Writing" guidance change is a policy shift (not just a factual correction) — a remote agent will now commit feature files instead of leaving them in the working tree. If the user disagrees with this policy, the fix introduces an unwanted behavior. This is flagged in User Review Required.

## Edge-Case & Dependency Audit

**Race Conditions:** None. The skill is documentation; it does not execute code. The `mirror:generate` script calls `generateClaudeMirror`, which is synchronous and idempotent (documented in its JSDoc at `ClaudeCodeMirrorService.ts:443`).

**Security:** No security implications. No secrets, credentials, or auth surfaces touched.

**Side Effects:**
- Running `mirror:generate` overwrites all of `.claude/skills/` from `.agents/`. If any hand-edited drift exists in other skill files (it should not, since `mirror:check` guards this), the regeneration would overwrite it. This is the intended behavior — the guard exists to prevent exactly this drift.
- The `mirror:generate` script must be run after `npm run compile-tests` because it requires `out/services/ClaudeCodeMirrorService.js` (same as `mirror:check`, per `check-claude-mirror.js:13-14,64-66`). The plan should document this prerequisite.

**Dependencies & Conflicts:**
- `mirror:check` (package.json:914) remains unchanged. The new `mirror:generate` script is additive.
- The `create-feature-from-plans` skill's three fallback references (`:19`, `:26`, `:71`) point to the `create-feature` skill. After the fix, they land on a section that can complete the job. No edit expected there, but the verification plan asserts it.
- The `switchboard-cloud` workflow (`.agents/workflows/switchboard-cloud.md:39`) already documents the frontmatter carrier. The fix brings the `create-feature` skill into alignment with it — no conflict.

## Dependencies

None — this plan is self-contained. No other plan needs to complete first.

## Adversarial Synthesis

Key risks: (1) the commit-policy change in "After Writing" is a behavioral shift, not just a factual fix — if the user expects remote agents to never commit, the fix introduces an unwanted side effect; (2) a plan without a `## Metadata` block would need one created to carry `**Feature:**`, and the skill must say so explicitly; (3) the `mirror:generate` script shares `mirror:check`'s compiled-output prerequisite, which must be documented or an agent will hit a confusing "module not found" error. Mitigations: the policy change is flagged in User Review Required; the Metadata-block edge case is addressed in the Proposed Changes; the compile prerequisite is noted in the script documentation.

## Proposed Changes

### `.agents/skills/create-feature/SKILL.md`

**Context:** This is the source-of-truth skill file. The `.claude/skills/` mirror is generated from it and must never be hand-edited.

**Logic:** Two sections have stale content that causes agent failure in remote sessions. The "Linking Existing Plans as Subtasks" section offers only `assign-to-feature.js` (which requires the extension) and says linking is impossible without it. The "After Writing" section says "do NOT commit" based on a gitignore state that no longer exists. Both need rewriting to match the current system.

**Implementation:**

1. **Rewrite "Linking Existing Plans as Subtasks" so the frontmatter carrier is the primary method**, since it is the one that works in the situation this skill exists for:
   - Write `**Feature:** <feature-uuid>` into each plan's `## Metadata` block. The UUID is the one in the feature's filename.
   - State that it is apply-if-empty — it will not steal a plan already attached to another feature.
   - State that order does not matter: an unresolved reference defers and retries (up to 5 retries, `PlanIngestionEngine.MAX_FEATURE_LINK_RETRIES = 5` at `:184`).
   - Keep `assign-to-feature.js` documented, correctly labelled as the path for when the extension **is** running.
   - Delete the claim that linking must wait for VS Code. It is the sentence that produces the empty feature.

2. **Fix "After Writing":** drop the stale gitignore parenthetical, and drop the blanket "do NOT commit". `.switchboard/features/` is tracked, and a remote session's container is ephemeral, so uncommitted work is lost work. Say that a local session may leave the file for the user to review, and a remote session should commit it with the plans it groups.

3. **Add the two invariants an agent gets wrong**, both already true and neither currently stated in the linking section:
   - The feature's UUID lives **only** in its filename. The skill says this under "Filename Convention" but not where linking is described, which is where it matters — a body-line UUID that disagrees with the filename links nothing.
   - Never write a `**Plan ID:**` line into a plan body. It is never parsed; the importer keys identity by file path.

4. **Add a note that `.agents/` is the source of truth** and `.claude/skills/` is generated, so the next agent asked to fix a skill edits the right file. Consider placing this in the skill-authoring guidance rather than in `create-feature` itself if a better home exists — it applies to every skill, not this one.

**Edge Cases:**
- **Plan without a `## Metadata` block:** If a plan file does not have a `## Metadata` section, the agent must create one before writing `**Feature:** <uuid>` into it. The skill should state this explicitly — an agent that tries to write the frontmatter line into a non-existent section will either place it in the wrong location or skip it.
- **Feature UUID mismatch:** If the UUID written into `**Feature:**` does not match the UUID in the feature's filename, the defer mechanism will exhaust retries (5) and drop the link silently (`:983-986`). The invariant in step 3 guards this, but the skill should state the consequence — not just the rule.

### `package.json`

**Context:** The `mirror:check` script (line 914) guards against `.claude/skills/` drift but there is no matching `mirror:generate` script to fix drift when it occurs.

**Logic:** Add a `mirror:generate` npm script wrapping `generateClaudeMirror`, so "edit `.agents/`, run `npm run mirror:generate`, commit both" is a stated two-step rather than folklore.

**Implementation:**
- Add `"mirror:generate": "node scripts/generate-claude-mirror.js"` alongside the existing `mirror:check` entry.
- Create `scripts/generate-claude-mirror.js` as a thin wrapper that calls `generateClaudeMirror(REPO_ROOT, packageVersion)` and writes to the committed `.claude/skills/` directory (unlike `mirror:check`, which writes to a temp dir for diffing).
- The script must require `out/services/ClaudeCodeMirrorService.js` (same compiled-output prerequisite as `mirror:check`). Document this in the script header: "Run after `npm run compile-tests`."
- Keep `mirror:check` exactly as it is — it is the guard, and this only gives it a matching fix command.

### `.claude/skills/create-feature/SKILL.md`

**Context:** This is the generated mirror. It must NOT be hand-edited.

**Logic:** Regenerate by running `npm run mirror:generate` after the `.agents/` edit. The only difference from the `.agents/` version should be the leading YAML frontmatter block that the generator adds.

**Implementation:**
- Run `npm run mirror:generate` (after `npm run compile-tests`).
- Verify with `diff` that the only delta is the frontmatter block.
- Commit both the `.agents/` edit and the regenerated `.claude/` file in the same commit. A commit containing one without the other is the drift the guard exists to catch.

## Verification Plan

### Automated Tests

1. **`npm run mirror:check` is green** after the edit and regeneration — the gate that fails if `.claude/` was hand-edited or left stale.
2. **The two copies differ only by frontmatter.** `diff` them and assert the only delta is the leading YAML block, as it is today.
3. **`npm run mirror:generate` is idempotent** — running it twice produces no diff.
4. **Read-through as the target reader.** Follow the revised skill end to end in a session with no extension, on two throwaway plans, and assert the result is a feature file plus two plans each carrying `**Feature:** <uuid>` matching the filename UUID. The current skill fails this test, which is what makes it the acceptance criterion.
5. **Grep for the deleted claim.** Assert no copy of any skill still says subtask linking requires VS Code or must wait for the extension.
6. **Grep for the stale gitignore claim**, in `create-feature` and anywhere else it was copied.
7. **Confirm `.switchboard/features/` is still tracked** (`git check-ignore` reports the `!` negation, `git ls-files` non-empty) so step 2 is not being justified by a state that has since changed back.
8. **`create-feature-from-plans` still hands off correctly** — its three fallback references (`:19`, `:26`, `:71`) now land on a section that can complete the job. No edit expected there; assert it rather than assume it.

No `npm run compile` dependency for the skill text itself; step 5's script addition touches `package.json` only. The relevant gate is `mirror:check`.
