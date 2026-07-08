# Agent Protocol and Prompt Directives Alignment

**Complexity:** 3

## Goal

Align agent protocol instructions, prompt directives, and workflows to improve project pinning consistency and ensure coding role completion report updates trigger the mtime-based watcher.

## How the Subtasks Achieve This

- **Clarify "Pin to Project" Mechanism**: Add Reminders and blockquotes about project pinning to `improve-plan.md`, `memo.md`, `improve-feature.md`, and `CLAUDE.md` to ensure the pinning rule is clear and followed consistently.
- **Add Plan-File Update Directive**: Add a completion report instruction string constant to `agentPromptBuilder.ts` and append it unconditionally to all coding roles (lead, coder, intern) after the caveman output conditional so that their final writes to plan files trigger the file watcher and turn off the status lights.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Feature Plan: Clarify "Pin to Project" Mechanism in Workflow & Protocol Docs](../plans/feature_plan_20260708120902_pin-to-project-docs-clarity.md) — **INTERN CODED**
- [ ] [Feature Plan: Add Plan-File Update Directive to All Coding Roles](../plans/feature_plan_20260708120905_coder-prompt-plan-file-update-directive.md) — **INTERN CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel.
