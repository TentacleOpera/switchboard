# Plan-Import Manifest and Workflow Documentation

**Complexity:** 5

## Goal

Fix and refine plan-import manifest behavior and project pinning. Local agents should not write manifests at all — the extension owns column moves and project assignment for local dispatches. Project pinning for newly created plans is solved via .md metadata (`**Project:** <name>`), not manifests, eliminating a concurrency flaw where simultaneous agents would race on a shared `manifest.json`.

## How the Subtasks Achieve This

The two plans split cleanly along layer lines — no file overlap, no conflicting edits:

- **Fix /improve-plan Manifest Prompting for Local Agents** (workflow-text layer): Rewrites the Trigger A manifest section in `.agents/workflows/improve-plan.md` + `.claude/skills/improve-plan/SKILL.md` to add a local/remote conditional using port-file detection (`.switchboard/api-server-port.txt`). Local agents skip the manifest entirely; remote agents emit Trigger A as today. No source code changes. Complexity 2.
- **Pin Plan Project via .md Metadata** (source-code + chat-workflow layer): Adds a `PROJECT_LINE_DIRECTIVE` to the prompt builder so chat and memo prompts carry the active project name at generation time. The agent writes `**Project:** <name>` into the plan .md's metadata block. The watcher already prefers this field over the stale `kanban.activeProjectFilter` DB config key (`GlobalPlanWatcherService.ts:526` and `:620-632`), preventing the project race. No manifest, no sidecar file, no concurrency issue — works identically for local and remote agents. Does NOT touch `improve-plan.md` (that is the sibling plan's scope). Complexity 5.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix /improve-plan Manifest Prompting for Local Agents](../plans/feature_plan_20260702112304_improve-plan-manifest-local-vs-remote.md) — **CODE REVIEWED**
- [ ] [Pin Plan Project via .md Metadata (Not Manifest) — Eliminate the Project Race](../plans/feature_plan_20260702130028_creator-manifest-project-pinning.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

