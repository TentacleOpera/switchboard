---
name: improve-feature
description: "Reconcile and restructure a feature's subtasks — improve each, then merge/delete/rewrite/split to make the set coherent"
---

# Improve Feature

Use this workflow when the target is a Switchboard **feature** (a container of subtask plans), not a single plan. Its job is to make the subtask **set** coherent: improve every subtask, detect inconsistencies between them, and then **restructure** — merge overlapping plans, delete superseded ones, rewrite contradictory ones, split oversized ones.

Detect a feature when the target file is under `.switchboard/features/`, or contains an auto-generated `<!-- BEGIN SUBTASKS ... -->` / `<!-- END SUBTASKS -->` block. If the target is a single plan, use `improve-plan` instead.

## Why this is a separate skill

`improve-plan` is deliberately non-destructive ("never delete content; only update the plan document") because for a single plan that is correct. For a feature it is the opposite of the job — the highest-value action is exactly the thing improve-plan forbids: recognising that two plans are one, that a plan is obsolete, or that a contradiction means one plan gets rewritten. **This skill is authorised to cut.** Invoking it *is* the sign-off to restructure the subtask set; there is no per-run confirmation gate.

## Guardrails (different from improve-plan, not fewer)

Restructuring is expected — but bounded:

- **Preserve information, not files.** Every requirement, edge case, and root-cause note from a plan you delete or merge MUST survive in its target plan. The unit of preservation is the union of intent across the set, never each individual `.md`.
- **Git is the undo.** Commit before any destructive op (delete/merge) so it is trivially reversible. Deletion of a plan file on a branch is cheap — it is a working document, not shipped user data. Do not treat it with production-data caution.
- **Never hand-edit the auto-generated subtasks block** (`<!-- BEGIN/END SUBTASKS -->`) — Switchboard regenerates it from the DB.
- **Route set changes through the real mechanisms**, not the block:
  - *Remote (no extension):* `git rm` the removed subtask `.md` files (the plan watcher hard-deletes their rows on the next local pull), create any new consolidated plan file (do NOT write a `**Plan ID:**` line — it is never read; the importer assigns the ID and keys by file path), and add a `**Feature:** <feature-plan-id>` line to the new plan file's frontmatter (the feature's UUID, taken from its `feature-<uuid>.md` filename; applied on import with apply-if-empty semantics). For column moves, you MUST move newly created cards to `PLAN REVIEWED` using the session-appropriate mechanism:
    - **Local (extension running — `.switchboard/api-server-port.txt` present):** Use the `kanban_operations` skill (move-card.js) to move the card to `PLAN REVIEWED`.
    - **Remote (no extension — `.switchboard/api-server-port.txt` absent):** Use the Notion/Linear provider or MCP to move the card to `PLAN REVIEWED`.
    In-place rewrites keep their existing column. Detect remote by the absence of `.switchboard/api-server-port.txt`.
  - *Local (extension running):* use `assign-to-feature.js` / the feature's create path for card-set changes.
- **Report the restructure** — what merged into what, what was deleted, what survived — so the diff is legible. End with the reconciled subtask list.

## Steps

1. **Expand the feature into its subtasks.** Read the feature and collect every linked subtask plan (and the code they touch). If a link is broken, say so.

2. **Improve every subtask (run improve-plan on each).** For each subtask plan file, execute the `improve-plan` workflow's per-plan Steps in full (Load → all Required Sections → adversarial critique → write back → complexity-based recommendation). Improve each in place, with sibling context in hand. This is the same behaviour as dispatching improve-plan across a feature's subtasks locally. Report a per-subtask summary (complexity, routing, key changes).

   ### Project Pinning
   When updating subtask plans, ensure each has `**Project:** <name>` in Metadata if a project is active; if none is active, omit the line — never ask the user. The workspace/repo name is NOT a project — never pin it (the importer silently drops workspace-name pins to unassigned). See AGENTS.md "Plan Project Pinning" for the full protocol.


3. **Cross-subtask reconciliation audit — the real value.** For every file/symbol touched by more than one subtask, classify each finding:
   - **Overlap** — two+ subtasks doing duplicate work.
   - **Contradiction** — incompatible designs on the same surface (e.g. two subtasks rewriting one function with different signatures; two defining the same field differently).
   - **Supersession** — one subtask's approach/fields obsoleted by another.
   - **Ordering** — A must land before B (shared-file merge order, a rename/extraction others depend on, a structural move others target).
   Produce a shared-surface map and, for each contended symbol, the single reconciled end-state.

4. **Restructure the set (act — do not just recommend).** Based on the audit, do whatever makes the set coherent:
   - **Merge** overlapping/contradictory subtasks into one plan that owns the shared surface once (carry all their intent forward per the preservation guardrail), then `git rm` the originals.
   - **Delete** superseded or obsolete subtasks (`git rm`).
   - **Rewrite** a subtask to remove a contradiction or to defer to the merged owner of a shared symbol.
   - **Split** a subtask that is really two units of work.
   - **Reorder** — record the execution sequence.
   Apply session-scope directives here (e.g. "unreleased → clean break, no migration shims"; "single-repo").
   
   After restructuring, you MUST move each **newly created** plan file (merges, splits) to `PLAN REVIEWED` using the session-appropriate mechanism (e.g., `kanban_operations` skill / move-card.js locally, Notion/Linear provider/MCP remotely). In-place rewrites keep their existing columns. Do not move deleted plans.

5. **Backfill the feature file's own description.** Ensure the feature has `## Goal`, `## How the Subtasks Achieve This`, and `## Dependencies & sequencing` (backfill from the subtasks if missing; don't overwrite existing content; never touch the auto-block). Optionally record the reconciled merge map / end-state here so a coder implements to one design.

6. **Commit, push, and report.** Commit the improvements and the restructure (already committed before destructive ops per the guardrail). Report the before/after subtask set and the reconciliation outcome.

## High/Low mode (complexity-tier consolidation)

When the user asks to tier the feature by complexity — "high/low split", "split by complexity", "consolidate into tiers", or `/improve-feature --high-low` — run this variant of Step 4 instead of a free-form restructure. It is the remote, file-based equivalent of the local `high-low` feature worktree mode:

1. Run Steps 1–3 as normal (improve every subtask; reconcile).
2. Consolidate the subtasks into **exactly two** new plan files, carrying all their intent forward (preservation guardrail):
   - **HIGH** — every subtask scoring **≥ 5**, merged into one plan.
   - **LOW** — every subtask scoring **≤ 4**, merged into one plan.
   - If a tier is empty, still write its file and state there is no work for that tier (so a downstream two-tier executor has both).
3. Give each new file a `**Complexity:**` for its tier and a `**Consolidated From:** <source plan filenames>` metadata line for traceability (reference the merged files by name — never by plan ID, which you cannot know). Do NOT embed a `**Plan ID:**` — it is never read; the importer assigns the ID and keys by file path.
4. `git rm` the original subtask files (their intent now lives in the two tier files) and add a `**Feature:** <feature-plan-id>` line to each new tier plan file's frontmatter (the feature's Plan ID). Locally this is `assign-to-feature.js`. After writing the files, you MUST move both new tier cards to `PLAN REVIEWED` using the session-appropriate mechanism (e.g., `kanban_operations` skill / move-card.js locally, Notion/Linear provider/MCP remotely).
5. Report the two tier files, what merged into each, and the reconciled subtask list.

Use this when the intent is parallel execution by complexity tier; use the default free-form Step 4 when the intent is just "make the set coherent".

## Recommendation

End with a per-subtask complexity routing (Intern 1-3 / Coder 4-6 / Lead Coder 7-10) and, for the feature, whether it is ready to execute or still has open decisions for the user.
