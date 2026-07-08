# Dead Legacy Mechanism Cleanup

**Complexity:** 3

## Goal

Remove two vestigial mechanisms that no longer have any consumer in the codebase — the Stage Complete parser field and label (superseded by the mtime-based activity-light clear) and the Plan-Import Manifest language scattered across workflow and skill docs (superseded by the .md frontmatter carrier read by GlobalPlanWatcherService). Both are pure deletion and cleanup with no behavioral change, but each is non-trivial because the dead surface spans multiple files and has adjacent load-bearing code that must be carefully fenced off.

## How the Subtasks Achieve This

- **Remove the dead Stage Complete label + parser field**: Deletes the `stageComplete` interface field, parser block, return-literal entry, cross-file import, and the `STAGE_COMPLETE_LABEL` constant across `planMetadataUtils.ts` and `agentPromptBuilder.ts`. Reaps the leftover parser surface left behind by the mtime-based activity-light fix (commit `c5185aa`).
- **Remove Dead Plan-Import Manifest Language from Workflows and Skills**: Strips the fictional v1 JSON manifest ingestion instructions from `improve-plan` / `switchboard-chat` workflows and their mirrored `.claude/skills/` SKILL.md copies, preserves the live frontmatter-carrier guidance, and corrects the backwards trigger-model framing. Eliminates documentation that misleads agents into emitting manifests nobody reads and telling users to move cards that are already in place.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Remove Dead Plan-Import Manifest Language from Workflows and Skills](../plans/remove-dead-plan-import-manifest-language-from-workflows-and-skills.md) — **INTERN CODED**
- [ ] [Remove the dead Stage Complete label + parser field](../plans/remove-dead-stage-complete-label-and-parser.md) — **INTERN CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel. The two subtasks touch disjoint file sets (TypeScript parser source vs. workflow/skill Markdown docs), so there is no merge-conflict risk. The manifest-cleanup plan's trigger-model discussion references the Stage Complete marker conceptually, but there is no code-level dependency — either can land first.

<!-- BEGIN WORKTREES (auto-generated, do not edit) -->
## Worktrees
- **Feature integration**: `dead-legacy-mechanism-cleanup` → `/Users/patrickvuleta/Documents/GitHub/worktrees/switchboard/dead-legacy-mechanism-cleanup`
- [Remove Dead Plan-Import Manifest Language from Workflows and Skills](../plans/remove-dead-plan-import-manifest-language-from-workflows-and-skills.md): `remove-dead-plan-import-manifest-languag` → `/Users/patrickvuleta/Documents/GitHub/worktrees/switchboard/remove-dead-plan-import-manifest-languag`
- [Remove the dead Stage Complete label + parser field](../plans/remove-dead-stage-complete-label-and-parser.md): `remove-the-dead-stage-complete-label-par` → `/Users/patrickvuleta/Documents/GitHub/worktrees/switchboard/remove-the-dead-stage-complete-label-par`
<!-- END WORKTREES -->
