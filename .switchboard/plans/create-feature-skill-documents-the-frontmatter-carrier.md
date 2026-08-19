# The create-feature Skill Documents the Link Mechanism That Works Without the Extension

## Goal

Fix two stale sections in the `create-feature` skill that make an agent produce a feature with no subtasks attached, and that tell it not to commit the file it just wrote. Both were caught by an agent following the skill in a real remote session.

### Problem analysis

`create-feature` is the skill for creating a feature when the VS Code extension is **not** running. Two of its sections describe a world that no longer exists.

**Defect A — the skill does not document the link mechanism that works.** Its "Linking Existing Plans as Subtasks" section offers exactly one method, `assign-to-feature.js`, and then says:

> This also routes through the extension; in a remote session it will fail and the agent should note that subtask linking will need to be done when VS Code is next opened, OR the user can drag-and-drop in the kanban UI.

So the skill whose entire purpose is "the extension is unreachable" tells the agent that linking is impossible without the extension. An agent following it literally writes a feature file, links nothing, and hands the user an empty feature plus an apology.

Linking works fine without the extension. `**Feature:** <feature-uuid>` written into each plan's `.md` **is** the carrier — `src/services/PlanIngestionEngine.ts:999` logs *"Linked subtask … to feature … via `**Feature:**` frontmatter"*. It is apply-if-empty (`:992` returns early when `featureId` is already set) and it defers with retries when the feature row has not been imported yet (`:978-988`), so plan and feature files can land in either order. The project's own CLAUDE.md documents this as the *only* mechanism: *"Feature relationships are carried by `**Feature:** <feature-plan-id>` … No manifest file or batch payload is used."*

The skill and the project instructions disagree, and the skill is the one an agent reads while doing the task.

**This is on every remote grouping path.** `create-feature-from-plans` is the extension-running skill, and it correctly hands off when the extension is down — *"fall back to the `create-feature` skill"* (`.agents/skills/create-feature-from-plans/SKILL.md:19`, `:26`, `:71`). The `switchboard-cloud` workflow says the same. So all of them terminate in the broken section.

**Defect B — the "don't commit" instruction is stale.** "After Writing" says:

> Do NOT commit or push — creating a feature is a planning action. Leave the new file in the working tree for the user. (The features folder will be tracked once `expose-features-folder-in-gitignore.md` is deployed.)

That plan has deployed and is gone from `.switchboard/plans/`. `.gitignore:55` carries an explicit `!.switchboard/features/` negation, and 260 feature files are tracked today. The parenthetical describes a pre-deployment state, and the instruction it justifies leaves a remote agent's work uncommitted in an ephemeral container.

**Where the fix goes.** `.agents/` is the source of truth; `.claude/skills/` is **generated**. `scripts/check-claude-mirror.js` regenerates the mirror from `.agents/` with the same `generateClaudeMirror` the extension uses and fails CI on drift, and its header names the reason: *"the exact failure mode behind the 'skill fixes don't stick' bug this guard backstops."* The two copies differ only in that the `.claude` one carries YAML frontmatter, which the generator adds. Editing `.claude/skills/create-feature/SKILL.md` is the wrong move and turns `mirror:check` red — and it is the likely wrong move, because that is the copy an agent reads.

**A contributing gap:** there is a `mirror:check` script but no regenerate script. An agent that correctly edits `.agents/` has no documented way to refresh the mirror, so it either leaves CI red or hand-edits `.claude/` and defeats the guard. `generateClaudeMirror(rootDir, extensionVersion)` is exported at `src/services/ClaudeCodeMirrorService.ts:446`.

## Metadata

**Complexity:** 2
**Tags:** docs, bugfix

## Implementation

Edit `.agents/skills/create-feature/SKILL.md` **only**, then regenerate the mirror. Do not hand-edit `.claude/skills/`.

1. **Rewrite "Linking Existing Plans as Subtasks" so the frontmatter carrier is the primary method**, since it is the one that works in the situation this skill exists for:
   - Write `**Feature:** <feature-uuid>` into each plan's `## Metadata` block. The UUID is the one in the feature's filename.
   - State that it is apply-if-empty — it will not steal a plan already attached to another feature.
   - State that order does not matter: an unresolved reference defers and retries.
   - Keep `assign-to-feature.js` documented, correctly labelled as the path for when the extension **is** running.
   - Delete the claim that linking must wait for VS Code. It is the sentence that produces the empty feature.

2. **Fix "After Writing":** drop the stale gitignore parenthetical, and drop the blanket "do NOT commit". `.switchboard/features/` is tracked, and a remote session's container is ephemeral, so uncommitted work is lost work. Say that a local session may leave the file for the user to review, and a remote session should commit it with the plans it groups.

3. **Add the two invariants an agent gets wrong**, both already true and neither currently stated in the linking section:
   - The feature's UUID lives **only** in its filename. The skill says this under "Filename Convention" but not where linking is described, which is where it matters — a body-line UUID that disagrees with the filename links nothing.
   - Never write a `**Plan ID:**` line into a plan body. It is never parsed; the importer keys identity by file path.

4. **Add a note that `.agents/` is the source of truth** and `.claude/skills/` is generated, so the next agent asked to fix a skill edits the right file. Consider placing this in the skill-authoring guidance rather than in `create-feature` itself if a better home exists — it applies to every skill, not this one.

5. **Add a `mirror:generate` npm script** wrapping `generateClaudeMirror`, so "edit `.agents/`, run `npm run mirror:generate`, commit both" is a stated two-step rather than folklore. Keep `mirror:check` exactly as it is — it is the guard, and this only gives it a matching fix command.

6. **Regenerate and commit the mirror** in the same commit as the `.agents/` edit. A commit containing one without the other is the drift the guard exists to catch.

## Verification Plan

1. **`npm run mirror:check` is green** after the edit and regeneration — the gate that fails if `.claude/` was hand-edited or left stale.
2. **The two copies differ only by frontmatter.** `diff` them and assert the only delta is the leading YAML block, as it is today.
3. **`npm run mirror:generate` is idempotent** — running it twice produces no diff.
4. **Read-through as the target reader.** Follow the revised skill end to end in a session with no extension, on two throwaway plans, and assert the result is a feature file plus two plans each carrying `**Feature:** <uuid>` matching the filename UUID. The current skill fails this test, which is what makes it the acceptance criterion.
5. **Grep for the deleted claim.** Assert no copy of any skill still says subtask linking requires VS Code or must wait for the extension.
6. **Grep for the stale gitignore claim**, in `create-feature` and anywhere else it was copied.
7. **Confirm `.switchboard/features/` is still tracked** (`git check-ignore` reports the `!` negation, `git ls-files` non-empty) so step 2 is not being justified by a state that has since changed back.
8. **`create-feature-from-plans` still hands off correctly** — its three fallback references (`:19`, `:26`, `:71`) now land on a section that can complete the job. No edit expected there; assert it rather than assume it.

No `npm run compile` dependency for the skill text itself; step 5's script addition touches `package.json` only. The relevant gate is `mirror:check`.
