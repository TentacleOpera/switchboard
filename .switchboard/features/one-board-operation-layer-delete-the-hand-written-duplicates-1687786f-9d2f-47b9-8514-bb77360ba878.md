# One Board Operation Layer - Delete the Hand-Written Duplicates

**Complexity:** 8

## Goal

Three separate places in this codebase implement the same board operations by hand, and every one of them has already drifted. Eighteen call sites open-code the advance-cards routine; bootstrap.ts hand-writes eighteen verb cases and a hand-assembled board payload that duplicate provider arms that already exist and are public; and a surface flag is hand-threaded through 164 source lines across nine files plus 99 lines across six test files. The shared failure is identical in all three: a fix lands in one copy and the other copies keep the bug. This feature collapses them into single operations.

## How the Subtasks Achieve This

- **Delete allowPtyFleet — Resolve Terminals by Name, Not by Caller Surface**: removes the surface flag entirely, replacing "what kind of client is calling" with "where does the named terminal actually live". This is what makes a VS Code-originated dispatch able to land in a browser PTY terminal.
- **Extract One advanceCards Operation — Eighteen Copies of the Same Routine**: replaces the eighteen open-coded advance sequences with one operation every affordance calls, so dispatch semantics change in one place.
- **Standalone Kanban Column-Parity Audit**: closes both `bootstrap.ts` forks — the write path (eighteen hand-written verb cases above a `default:` arm that already delegates) and the read path (a literal board payload where `getFullStateMessages` is public and documented for exactly this use).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Standalone Kanban Column-Parity Audit](../plans/standalone-kanban-column-parity-audit.md) — **PLAN REVIEWED**
- [ ] [Delete `allowPtyFleet` — Resolve Terminals by Name, Not by Caller Surface](../plans/delete-allowptyfleet-resolve-terminals-by-name.md) — **PLAN REVIEWED**
- [ ] [Extract One `advanceCards` Operation — Eighteen Copies of the Same Routine](../plans/extract-advance-cards-operation.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Strictly sequential.** All three edit `KanbanProvider.ts`; two also edit `TaskViewerProvider.ts`.

Recommended order:
1. **Delete allowPtyFleet** — it removes the sixth positional argument the advanceCards extraction would otherwise have to preserve through eighteen call sites.
2. **Extract advanceCards** — cleaner once the flag is gone.
3. **Standalone parity audit** — its delegation target is cleanest once the provider arms are consolidated.

**Unblocked 2026-08-10 (user decision).** The allowPtyFleet plan previously declared `vscode-terminals-view-onto-pty-fleet.md` a HARD prerequisite, on the reasoning that VS Code must render fleet terminals in-process before the flag could be deleted. That prerequisite was **struck**: PTY terminals are not going into VS Code and were never wanted there. They live in the browser cockpit the operator opens and watches, and a VS Code-originated dispatch landing in one is the **intended** outcome of this work, not a failure mode. The plan's Dependencies section now reads `None.` and the corresponding "dominant risk is ordering" sentence has been removed from its Risk Summary.

The one genuine risk that remains in that subtask: the flag carries a **third** job — suppressing `vscode.Terminal` *creation* for callers that cannot see one — which name-based resolution cannot answer, because its trigger is a role that resolves to nothing. Author the create-if-missing policy explicitly; do not let a grep-clean sweep stand in for it.

⚠ **Cross-feature:** *Kanban Move Addressing and Honest Failure Reporting* also edits `moveCardToColumn`'s signature. Land that feature first, or coordinate.
