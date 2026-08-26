---
name: refine-feature
description: Refine a feature into a complete, decomposable specification — clear goal, success criteria, scope, and a proposed subtask breakdown
disable-model-invocation: true
---

# Skill: Refine Feature

This skill transforms a thin or empty feature into a complete, unambiguous feature that is ready to decompose into subtasks and orchestrate.

## When to Use
Triggered by clicking "Refine" on a selected feature in the Switchboard Features tab.

## What it does
Produces a complete feature description (goal/problem, success criteria, scope, risks, and a proposed subtask breakdown) and writes the result back to the feature's local markdown file.

## Template Sections (Flexible — agent decides which apply)
- `## Goal` — the outcome this feature delivers and the problem it solves (root-cause framed, self-contained).
- `## Background / Why` — context, motivation, business reason.
- `## Success Criteria` — checkboxed, testable conditions that mean "this feature is done".
- `## Scope` — In Scope / Out of Scope bullets.
- `## Proposed Subtasks` — an ordered, checkboxed breakdown into independently-shippable units of work. Each item: a one-line title plus a sentence of intent. Aim for 3–12 subtasks.
- `## Dependencies & Sequencing` — ordering constraints between subtasks, external blockers.
- `## Risks / Open Questions` — what could go wrong; unresolved decisions.

## Agent Instructions
- Read the existing feature markdown from the local file path provided in the prompt. Preserve the YAML frontmatter exactly.
- Determine what's missing. If the file is empty or has no `## Goal`, author one from the feature title and any context in the prompt.
- Enhance, don't rewrite: keep existing well-written content; fill gaps.
- The most valuable output for a sparse feature is the `## Proposed Subtasks` breakdown — make it concrete and decomposable.
- Do NOT create kanban cards or modify any database. Only write markdown back to the file. Subtask cards are created separately by the user.
- Eliminate ambiguity: replace vague language with specific, testable criteria.
- Write the refined markdown back to the local file path provided. If the file does not exist, create it at that path.
- Report back with a summary of what you added or changed, and list the proposed subtasks so the user can decide which to create.

## Note on the auto-generated subtasks block
The feature file may contain an auto-generated block wrapped in
`<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->` / `<!-- END SUBTASKS -->`.
Do NOT edit inside that block — Switchboard regenerates it. Put your proposed
breakdown in a separate `## Proposed Subtasks` section above it.
