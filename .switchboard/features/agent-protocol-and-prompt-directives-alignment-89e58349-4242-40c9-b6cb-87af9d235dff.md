# Agent Protocol and Prompt Directives Alignment

**Complexity:** 3

## Goal

Align agent protocol instructions, prompt directives, and workflows to improve project pinning consistency and ensure coding role completion report updates trigger the mtime-based watcher.

## How the Subtasks Achieve This

- **Clarify "Pin to Project" Mechanism**: Add Reminders and blockquotes about project pinning to `improve-plan.md`, `memo.md`, `improve-feature.md`, and `CLAUDE.md` to ensure the pinning rule is clear and followed consistently.
- **Add Plan-File Update Directive**: Add a completion report instruction string constant to `agentPromptBuilder.ts` and append it unconditionally to all coding roles (lead, coder, intern) after the caveman output conditional so that their final writes to plan files trigger the file watcher and turn off the status lights.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Feature Plan: Clarify "Pin to Project" Mechanism in Workflow & Protocol Docs](../plans/feature_plan_20260708120902_pin-to-project-docs-clarity.md) — **CODE REVIEWED**
- [ ] [Feature Plan: Add Plan-File Update Directive to All Coding Roles](../plans/feature_plan_20260708120905_coder-prompt-plan-file-update-directive.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel.

## Review Findings

Both subtasks reviewed in-place and verified complete. Subtask 1 (pin-to-project docs): pinning notes added to all three workflow docs, CLAUDE.md regenerated consistent with AGENTS.md (`ask→omit` preserved), 6 skill mirrors propagated. Subtask 2 (completion-report directive): `CODING_COMPLETION_REPORT_DIRECTIVE` added and appended override-safely to all three coding roles (lead/coder×2/intern). No CRITICAL/MAJOR findings, no code fixes required; compile/tests skipped per session directive. Remaining risks are NIT-level only (see per-subtask Review Findings).

**Second-pass review (2026-07-09):** Both subtasks re-verified in-place with advanced regression tracing. Subtask 2: all four coding-role appends survive `'replace'` overrides, no caller/orphan/double-trigger regressions. Subtask 1: three workflow sources + CLAUDE.md backstop + 6 skill mirrors consistent, ask→omit flip preserved, memo directive-first deviation confirmed correct. No CRITICAL/MAJOR in either; no code fixes applied.

**Third-pass review (2026-07-09):** Both subtasks re-verified against live source. Subtask 2: directive constant (agentPromptBuilder.ts:572) + 4 override-safe appends (1142/1194/1238/1276), non-coding roles excluded, full dispatch→watcher path sound. Subtask 1: pinning notes present in all three `.agents/workflows/` sources + 6 regenerated mirrors, CLAUDE.md backstop byte-identical to AGENTS.md, ask-regression grep clean. No CRITICAL/MAJOR, no fixes. Compile/tests skipped per session directive.
