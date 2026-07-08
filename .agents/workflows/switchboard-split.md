---
description: Split one plan into two along complexity lines — a Complex/Risky file and a Routine companion — so the two tiers can be coded separately
---

# Switchboard Split

Split a single plan into two files by complexity, so the risky work and the routine work can be dispatched to different agents (Lead Coder vs Coder/Intern). This is the remote, file-based equivalent of the local splitter agent (`SPLIT_PLAN_DIRECTIVE`) — it needs no extension or dispatch engine, just file writes, so it works in a remote/cloud session.

For splitting a **feature** into complexity tiers, use `improve-feature` in high/low mode instead — this skill is for one plan.

## Input

A target plan file path (the plan to split). If none is given, ask which plan.

## Steps

1. **Read the full plan.** It should have a `## Complexity Audit` with `### Routine` and `### Complex / Risky` subsections (that's what `improve-plan` produces). If those sections are missing or thin, run the `improve-plan` complexity audit on it first — you cannot split cleanly without knowing which steps are which.

2. **Identify the shared context.** The sections both output files must carry verbatim: `## Goal` (incl. problem/root-cause), `## Metadata`, any Current State / background, `## Edge-Case & Dependency Audit`, and `## Dependencies`. Both files are self-contained.

3. **Write the Routine companion** — `<stem>_routine.md` in the **same directory** as the original (e.g. `feature_plan_..._foo.md` → `feature_plan_..._foo_routine.md`). It contains the shared context + only the **Routine** implementation steps (from `### Routine` and the routine parts of `## Proposed Changes`). Give it a `**Complexity:**` reflecting the routine tier (typically ≤4) and a `**Split From:** <original filename>` metadata line. Embed a fresh `**Plan ID:** <uuid>`.

4. **Rewrite the original** to hold only the **Complex / Risky** work: the shared context + the complex/risky steps. Add a note under the Goal: *"Routine items are split into `<stem>_routine.md` — assume they are implemented by the Coder agent."* Keep its existing `**Plan ID:**`. Bump/keep its `**Complexity:**` to the complex tier.

5. **Do not lose anything.** Every implementation step, code block, and edge case in the source must land in exactly one of the two files (shared context in both). This is the split's core guarantee.

6. **Register the new file (remote).** The new `_routine.md` imports as a new plan card on the next local pull (the plan watcher picks up new `.md` files). If it should be linked to a feature or carry a project, add `**Feature:** <feature-plan-id>` and/or `**Project:** <name>` lines to the new plan file's frontmatter (applied on import with apply-if-empty semantics). After the file is written, you MUST move the newly created companion card to `PLAN REVIEWED` using the session-appropriate mechanism:
   - **Local (extension running — `.switchboard/api-server-port.txt` present):** Use the `kanban_operations` skill (move-card.js) to move the card to `PLAN REVIEWED`.
   - **Remote (no extension — `.switchboard/api-server-port.txt` absent):** Use the Notion/Linear provider or MCP to move the card to `PLAN REVIEWED`.
   The original (Complex) file is rewritten in place and retains its existing column (no move needed for it). Commit both files.

## Guardrails

- Preserve information, not structure — nothing in the source may be dropped; git is the undo.
- Never touch a feature's auto-generated `<!-- BEGIN/END SUBTASKS -->` block.
- No `confirm()`-style gating anywhere (this is a planning-file operation, not UI).

## Report

State the two output paths, each one's complexity/tier, and confirm every source step landed in one of them.
