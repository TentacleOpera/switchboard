---
description: Reconcile and restructure an epic's subtasks — improve each, then merge/delete/rewrite/split to make the set coherent
---

# Improve Epic

Use this workflow when the target is a Switchboard **epic** (a container of subtask plans), not a single plan. Its job is to make the subtask **set** coherent: improve every subtask, detect inconsistencies between them, and then **restructure** — merge overlapping plans, delete superseded ones, rewrite contradictory ones, split oversized ones.

Detect an epic when the target file is under `.switchboard/epics/`, or contains an auto-generated `<!-- BEGIN SUBTASKS ... -->` / `<!-- END SUBTASKS -->` block. If the target is a single plan, use `improve-plan` instead.

## Why this is a separate skill

`improve-plan` is deliberately non-destructive ("never delete content; only update the plan document") because for a single plan that is correct. For an epic it is the opposite of the job — the highest-value action is exactly the thing improve-plan forbids: recognising that two plans are one, that a plan is obsolete, or that a contradiction means one plan gets rewritten. **This skill is authorised to cut.** Invoking it *is* the sign-off to restructure the subtask set; there is no per-run confirmation gate.

## Guardrails (different from improve-plan, not fewer)

Restructuring is expected — but bounded:

- **Preserve information, not files.** Every requirement, edge case, and root-cause note from a plan you delete or merge MUST survive in its target plan. The unit of preservation is the union of intent across the set, never each individual `.md`.
- **Git is the undo.** Commit before any destructive op (delete/merge) so it is trivially reversible. Deletion of a plan file on a branch is cheap — it is a working document, not shipped user data. Do not treat it with production-data caution.
- **Never hand-edit the auto-generated subtasks block** (`<!-- BEGIN/END SUBTASKS -->`) — Switchboard regenerates it from the DB.
- **Route set changes through the real mechanisms**, not the block:
  - *Remote (no extension):* `git rm` the removed subtask `.md` files (the plan watcher hard-deletes their rows on the next local pull), create any new consolidated plan file with an embedded `**Plan ID:** <uuid>`, and write a `.switchboard/plans/manifest.json` entry linking the new plan to the epic (`epicId` = the epic's Plan ID; `fromColumn`/`kanbanColumn` if a column move is wanted). Detect remote by the absence of `.switchboard/api-server-port.txt`.
  - *Local (extension running):* use `assign-to-epic.js` / the epic's create path for card-set changes.
- **Report the restructure** — what merged into what, what was deleted, what survived — so the diff is legible. End with the reconciled subtask list.

## Steps

1. **Expand the epic into its subtasks.** Read the epic and collect every linked subtask plan (and the code they touch). If a link is broken, say so.

2. **Improve every subtask (run improve-plan on each).** For each subtask plan file, execute the `improve-plan` workflow's per-plan Steps in full (Load → all Required Sections → adversarial critique → write back → complexity-based recommendation). Improve each in place, with sibling context in hand. This is the same behaviour as dispatching improve-plan across an epic's subtasks locally. Report a per-subtask summary (complexity, routing, key changes).

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

5. **Backfill the epic file's own description.** Ensure the epic has `## Goal`, `## How the Subtasks Achieve This`, and `## Dependencies & sequencing` (backfill from the subtasks if missing; don't overwrite existing content; never touch the auto-block). Optionally record the reconciled merge map / end-state here so a coder implements to one design.

6. **Commit, push, and report.** Commit the improvements and the restructure (already committed before destructive ops per the guardrail). Report the before/after subtask set and the reconciliation outcome.

## Recommendation

End with a per-subtask complexity routing (Intern 1-3 / Coder 4-6 / Lead Coder 7-10) and, for the epic, whether it is ready to execute or still has open decisions for the user.
