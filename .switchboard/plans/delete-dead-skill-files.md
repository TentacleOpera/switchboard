# Delete Dead Skill Files

## Goal

Remove 24 dead files from `.agents/skills/`: 23 stale flat `.md` files that were superseded by directory-based `SKILL.md` versions during the July 11 migration, and the orphaned `delegates/` directory from the retired delegate-children system. No code changes required — none of these files are referenced by the extension code.

## Problem Analysis

### Background

On July 9, Switchboard skills existed as flat `.md` files in `.agents/skills/` (e.g. `archive.md`, `clickup_api.md`, `tuning.md`). On July 11, they were migrated to the directory-based `SKILL.md` format (e.g. `archive/SKILL.md`, `clickup-api/SKILL.md`, `tuning/SKILL.md`) required by the `.agents` skill standard and Devin CLI discovery.

The migration created the directory versions but left the flat files behind. The directory versions are the ones discovered by CLIs (which look for `<name>/SKILL.md`) and mirrored by `ClaudeCodeMirrorService`. The flat files are invisible to CLI discovery and unreferenced by code.

### Stale Flat Files (23)

All 23 flat `.md` files have directory-based counterparts. Some are byte-identical; others differ because the directory version evolved after migration (e.g. `deep_planning.md` → `deep-planning/SKILL.md` gained the "Plan Sizing" section) or because frontmatter was stripped during mirroring.

**Identical to directory counterpart (6):** `archive.md`, `complexity_scoring.md`, `constitution_builder.md`, `get_tickets.md`, `tuning.md`, `web_research.md`

**Differs from directory counterpart (17):** `clickup_api.md`, `clickup_attach.md`, `clickup_create_subpage.md`, `clickup_create_task.md`, `clickup_fetch.md`, `clickup_modify_task.md`, `clickup_move_task.md`, `create_feature.md`, `deep_planning.md`, `generate_diagram.md`, `improve_remote_plan.md`, `linear_api.md`, `linear_move_issue.md`, `notion_api.md`, `query_kanban_plans.md`, `query_switchboard_kanban.md`, `worktree_cleanup.md`

The directory-based versions are the authoritative evolved versions. The flat files' divergent content is stale (pre-migration snapshots) and is NOT preserved — the directory version supersedes it in every case.

**NOT deleted:** `refine_feature.md` — this is the only flat file still referenced by code (`PlanningPanelProvider.ts` line 4963) and is in the `MIRROR_MANIFEST` (`ClaudeCodeMirrorService.ts` line 172). It will be moved to `.switchboard/protocols/` in the protocols move plan (Subtask 2).

### Orphaned Directory (1)

`delegates/` — Contains `SKILL.md` describing the delegate child terminal contract. The delegate-children system was retired in favor of the TEAMS tab. The `addons.delegates` read path was removed (`bootstrap.ts` line 1404: "The role-config `addons.delegates` read path is RETIRED"). No code references `skills/delegates` or `delegates/SKILL.md` by path. The skill is not in the `MIRROR_MANIFEST` and thus not mirrored to `.claude/skills/`.

## Metadata

**Complexity:** 1
**Tags:** refactor, infrastructure
**Project:** Browser Switchboard

## User Review Required

No user review required — this is a pure deletion of unreferenced stale files with no behavioral change.

## Complexity Audit

### Routine
- Deleting 23 flat `.md` files that have directory-based counterparts
- Deleting 1 orphaned directory (`delegates/`) from a retired system
- No code changes — none of these files are referenced by extension code
- No migration concerns — these files never shipped in a released version (they are repo-internal skill definitions, not user data)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — file deletion is atomic and no process reads these files at runtime.
- **Security:** None — no secrets or sensitive data in skill definition files.
- **Side Effects:** `ClaudeCodeMirrorService` mirror generation is unaffected — it reads directory-based `SKILL.md` files, not flat `.md` files. The flat files were never in the `MIRROR_MANIFEST` (except `refine_feature.md`, which is NOT deleted here).
- **Dependencies & Conflicts:** Must land before Subtask 2 (Move Protocols Out of Skill Discovery) — reduces noise so the protocol move operates on a clean directory. No other dependencies.

## Dependencies

- None — this is the first subtask in the feature's execution order.

## Adversarial Synthesis

Key risks: (1) ungrepped cross-references to `delegates/` in other skill files — unlikely since the system was retired, but a grep verification is cheap insurance; (2) content loss in 17 differing flat files — mitigated because the directory versions are the authoritative evolved versions and the flat files' divergent content is stale. Overall risk is very low: pure deletion of unreferenced files with no behavioral change.

## Proposed Changes

### `.agents/skills/` — Delete 23 stale flat `.md` files

- **Context:** These files are leftovers from the July 11 migration to directory-based `SKILL.md` format. They are invisible to CLI discovery and unreferenced by code.
- **Logic:** `git rm` each file. The directory-based counterpart remains.
- **Implementation:**
  ```
  .agents/skills/archive.md
  .agents/skills/clickup_api.md
  .agents/skills/clickup_attach.md
  .agents/skills/clickup_create_subpage.md
  .agents/skills/clickup_create_task.md
  .agents/skills/clickup_fetch.md
  .agents/skills/clickup_modify_task.md
  .agents/skills/clickup_move_task.md
  .agents/skills/complexity_scoring.md
  .agents/skills/constitution_builder.md
  .agents/skills/create_feature.md
  .agents/skills/deep_planning.md
  .agents/skills/generate_diagram.md
  .agents/skills/get_tickets.md
  .agents/skills/improve_remote_plan.md
  .agents/skills/linear_api.md
  .agents/skills/linear_move_issue.md
  .agents/skills/notion_api.md
  .agents/skills/query_kanban_plans.md
  .agents/skills/query_switchboard_kanban.md
  .agents/skills/tuning.md
  .agents/skills/web_research.md
  .agents/skills/worktree_cleanup.md
  ```
- **Edge Cases:** `refine_feature.md` is NOT in this list — it is referenced by code and in the MIRROR_MANIFEST. It will be moved in Subtask 2.

### `.agents/skills/delegates/` — Delete orphaned directory

- **Context:** The delegate-children system was retired in favor of the TEAMS tab. The `addons.delegates` read path was removed from `bootstrap.ts`.
- **Logic:** `git rm -r .agents/skills/delegates/`
- **Implementation:** Delete `delegates/SKILL.md` and the `delegates/` directory.
- **Edge Cases:** Verify no other skill file cross-references `delegates/` by name: `grep -r "delegates" .agents/skills/ --include="*.md"` should return zero matches (excluding the `delegates/SKILL.md` file itself).

## Verification Plan

### Automated Tests
- `grep -r "delegates/SKILL\|skills/delegates" src/` — returns zero matches (confirming no code references).
- `grep -r "delegates" .agents/skills/ --include="*.md"` — returns zero matches after deletion (confirming no skill file cross-references the deleted directory).
- `ls .agents/skills/*.md` — returns only `refine_feature.md` (the one flat file not deleted).

### Manual
- Extension activates without errors.
- Kanban board loads normally.
- Skill discovery (Devin CLI) shows the same skills as before (flat files were never discovered).
- `ClaudeCodeMirrorService` mirror generation still works (reads directory-based `SKILL.md` files, not flat `.md` files).

## Impact

- Removes 24 dead files from the repository.
- No change to CLI system prompt (flat files were never discovered by CLIs).
- No change to extension behavior (no code references these files).
- Cleaner `.agents/skills/` directory — only directory-based skills remain.

**Recommendation:** Complexity 1 → Send to Intern.

## Completion Summary

Deleted 23 obsolete flat `.md` skill files and the orphaned `delegates/` directory (`delegates/SKILL.md`) from `.agents/skills/`. Only `refine_feature.md` was preserved in `.agents/skills/` for the subsequent protocols migration subtask. No extension code modifications were required as none of these deleted files were referenced at runtime. No issues or conflicts were encountered during the file removals.

## Review Findings

Reviewer pass found no material issues. Verified commit `14322bfb` deleted exactly the 24 specified files (23 flat `.md` + `delegates/SKILL.md`), that `refine_feature.md` was correctly spared, and that `.agents/skills/` now contains only `_lib`, `kanban_operations`, `manage-features`, `query-kanban`, `worktree-cleanup`. Both grep checks from the Verification Plan return zero matches (`skills/delegates` in `src/`, `delegates` in remaining skill files); no code referenced any deleted file. Files changed: none required. Remaining risks: none — deletion only, no behavioural surface.
