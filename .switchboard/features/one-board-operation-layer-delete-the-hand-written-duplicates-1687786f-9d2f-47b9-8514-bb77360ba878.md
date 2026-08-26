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
- [ ] [Standalone Kanban Column-Parity Audit](../plans/standalone-kanban-column-parity-audit.md) — **CODE REVIEWED** — ID: 9110f26b-dfdb-4be2-a028-8f5290f2bb91
- [ ] [Delete `allowPtyFleet` — Resolve Terminals by Name, Not by Caller Surface](../plans/delete-allowptyfleet-resolve-terminals-by-name.md) — **CODE REVIEWED** — ID: 7ebe51eb-36d0-45d4-8020-17116c9d9851
- [ ] [Extract One `advanceCards` Operation — Eighteen Copies of the Same Routine](../plans/extract-advance-cards-operation.md) — **CODE REVIEWED** — ID: b4e836f4-cd18-44a9-bf6a-621adc4b930e
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Strictly sequential.** All three edit `KanbanProvider.ts`; two also edit `TaskViewerProvider.ts`.

Recommended order:
1. **Delete allowPtyFleet** — it removes the sixth positional argument the advanceCards extraction would otherwise have to preserve through eighteen call sites.
2. **Extract advanceCards** — cleaner once the flag is gone.
3. **Standalone parity audit** — its delegation target is cleanest once the provider arms are consolidated.

**Unblocked 2026-08-10 (user decision).** The allowPtyFleet plan previously declared `vscode-terminals-view-onto-pty-fleet.md` a HARD prerequisite, on the reasoning that VS Code must render fleet terminals in-process before the flag could be deleted. That prerequisite was **struck**: PTY terminals are not going into VS Code and were never wanted there. They live in the browser cockpit the operator opens and watches, and a VS Code-originated dispatch landing in one is the **intended** outcome of this work, not a failure mode. The plan's Dependencies section now reads `None.` and the corresponding "dominant risk is ordering" sentence has been removed from its Risk Summary.

The one genuine risk that remains in that subtask: the flag carries a **third** job — suppressing `vscode.Terminal` *creation* for callers that cannot see one — which name-based resolution cannot answer, because its trigger is a role that resolves to nothing. Author the create-if-missing policy explicitly; do not let a grep-clean sweep stand in for it.

~~⚠ **Cross-feature:** *Kanban Move Addressing and Honest Failure Reporting* also edits `moveCardToColumn`'s signature.~~ **Struck 2026-08-10 (review pass on that feature).** It does not: that feature added parallel `…WithReason` siblings and left `moveCardToColumn` byte-identical at `KanbanProvider.ts:6974`, specifically so no call site had to move. Both features are already integrated in one tree — `_advanceCards` calls `moveCardToColumnWithReason` — and both gate sets pass together (`standalone-fork:check` 13/13, `kanban-dispatch-callers:check` 5/5, `verb-returns:check` Planning 152, plus `parity`/`push-routing`/`catalog`). No sequencing constraint remains.

## Review Findings

**Re-reviewed 2026-08-10 (second pass) — all three subtasks are now implemented; the feature is deliverable.** The two missing pieces from the first pass landed: Axis 1 of the parity audit (all seven forked verb cases deleted from `bootstrap.ts`, `getNextKanbanColumn`/`getRoleForTargetColumn` gone, `_lastCards` primed standalone-side) and the `advanceCards` extraction (`KanbanProvider._advanceCards`, `resolveCodedAutoTarget` deleted, webview sends `CODED_AUTO` as intent). Two new CI-wired gates arrived with them — `standalone-fork:check` and `kanban-dispatch-callers:check` — both green and both added to `.github/workflows/integration-tests.yml`. Three defects were found and fixed in this pass, all in the new `_advanceCards` path: `triggerAction` gated CLI-triggers *before* the CODED_AUTO branch while `triggerBatchAction` gated after (same drag, different outcome by cardinality); the `failures` accumulator was posted once per complexity group, re-reporting earlier groups' failures; and `options.bypassTriggerGate` was accepted but never read, so an explicit API dispatch moved cards then silently skipped the dispatch. Verified after the fixes: `tsc -p tsconfig.test.json` clean, all seven ratchets green, 69/74 contract scripts green — the 5 reds live in `memo.js`/`terminals.js` and belong to other features. One scope caveat carries forward: `_advanceCards` is reached only for `CODED_AUTO`, so the other advance affordances still open-code the routine and the new guard does not enforce the plan's broader "no arm calls `trigger*AgentFromKanban` directly" invariant; `scripts/check-dispatch-surface.js` was also never built.

---

*First pass (superseded):* Reviewed 2026-08-10 across all three subtasks: **one is complete, one is half-done, one has not started** — the feature is not deliverable as a unit. *Delete `allowPtyFleet`* is implemented and correct on its hardest point (the middle-positional-argument landmine on both `trigger*AgentFromKanban` registrations was defused by retaining a dead `_apiOriginated` slot in both hosts rather than closing it up); two MAJOR precedence defects were fixed here — `_getAgentNameForRole` and `_findTerminalNameByWorktreePathAndRole` still resolved by state-file key order, and `_getAgentNameForRoleGlobal`'s per-root `break` defeated its own fleet-first sort, so all three now route through one new `TaskViewerProvider._pickTerminalCandidate` (live-first, fleet-wins-among-equals). *Standalone Kanban Column-Parity Audit* landed Axis 2 only (the `getFullStateMessages` push swap, plus a new CI-wired `standalone-parity:check` ratchet); Axis 1 is untouched, so `getNextKanbanColumn` and the seven forked verb cases survive and five of the seven confirmed divergences are still live. *Extract One `advanceCards` Operation* has no implementation at all. Four CI-gated tests were red on arrival and are now green (`ws-surface-scoping` — made stale by Axis 2 itself; `verb-engine-kanban-headless` and `pty-dispatch-focus` — stale since `ea1077da`; plus `catalog:check` drift from the provider line shifts); `tsc` is clean and 69/74 contract scripts pass, the 5 remaining reds all living in `memo.js`/`terminals.js` outside this feature. Two gates this feature promised were never built and remain the main regression risk: `scripts/check-dispatch-surface.js` and `scripts/check-kanban-dispatch-callers.js`.
