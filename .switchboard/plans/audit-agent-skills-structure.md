# Audit and Restructure Agent Skills to Prevent Discovery Failures

We audited the `.agents/skills` directory and found multiple skills that are ignored or incorrectly named by the Antigravity discovery system. This is caused by missing frontmatter name/description keys, and flat skill files that are not structured in subdirectories. We need to decide which files are meant to be active user-callable skills (which should be moved to subdirectories or workflows) and which are only deep-linked helper skills or remote tools.

## Metadata
- **Complexity:** 3
- **Tags:** refactor, devops, infrastructure

## Goal
Detail the current state of ignored and malformed skills in the `.agents/skills` directory, discuss the distinction between user-initiated workflows and deep-linked skills, and propose a clean path forward to restructure them.

### Background Context & Root Cause Analysis
Antigravity's skill auto-discovery engine expects skills to be directories inside the customization root's `skills/` directory (e.g., `.agents/skills/my-skill/`) containing a `SKILL.md` file. In addition, this `SKILL.md` must have YAML frontmatter declaring both `name` and `description` to be successfully registered.
Currently:
1. `group-into-features` and `switchboard-orchestration` are directories but lack the `name` property in their frontmatter.
2. `advise_research` lacks frontmatter entirely.
3. There are 26 flat markdown files directly in `.agents/skills/` (such as `deep_planning.md`, `complexity_scoring.md`, `linear_api.md`, etc.). Because they are flat files rather than subdirectories containing a `SKILL.md`, they are completely ignored by the auto-discovery engine.

### Core Problems
- **Discovery Failure:** Multiple essential agent skills are currently completely hidden/unusable by Antigravity.
- **Workflow vs. Skill Ambiguity:** It is unclear which files are meant to be user-callable skills, which are meant to be workflows, and which are background-consumed helper skills that should remain hidden from the user-facing lists but still accessible when deep-linked.

## Proposed Changes

### Restructuring Strategy
1. **Identify User-Callable Workflows:** Move any skills that are primarily user-initiated tasks to the `.agents/workflows/` directory as standard workflows (e.g., `/linear-sync` or similar if appropriate).
2. **Move True Skills to Directories:** For skills that are meant to be callable but are currently flat files (e.g. `complexity_scoring.md`), move them to a directory format: `.agents/skills/<skill-name>/SKILL.md` and supply a valid YAML frontmatter with `name` and `description`.
3. **Handle Deep-Linked/Private Skills:** If a skill is only meant to be accessed programmatically by other agents or deep-linked from the UI (and not registered as an active user-callable skill in the prompt), leave them as flat markdown files or document them in a separate folder like `references/` or `_lib/` to keep the user-facing skill list clean.

## Verification Plan
- Verify that only the desired skills show up in the Antigravity prompt after the restructuring is complete.
