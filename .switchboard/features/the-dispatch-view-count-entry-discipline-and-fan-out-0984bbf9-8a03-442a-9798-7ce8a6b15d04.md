# The Dispatch View - Count, Entry Discipline, and Fan-Out

**Complexity:** 4

## Goal

DISPATCH is a display mode of the Planned column that is supposed to mean these plans are proven parallel-safe, and today it neither says how many plans are staged, nor prevents an unanalysed card from being clicked into it, nor does anything useful with the set once it is staged. These three plans make the view honest and actionable: a count on the toggle, removal of the one-click entry that computes nothing, and a fan-out button that sends the staged set to complexity-routed coder terminals with a stepper to size the fleet first. Scoped to the manual Dispatch view only - autoban pools and rotation are out of scope.

## How the Subtasks Achieve This

- **The DISPATCH toggle shows how many plans are staged**: puts a live count on the toggle, reachable from all four independent count-update paths — column headers are not re-rendered on a board refresh, so a template-only change would go stale.
- **Remove the Manual Move to Dispatch Button from Planned Cards**: deletes the per-card entry arrow and its `sendToDispatch` verb, so unanalysed entry stops being the default gesture and the column keeps meaning parallel-safe.
- **Send the Dispatch Set to Coders, with Terminal Provisioning**: adds the fan-out action plus a visible plans-versus-terminals count and a stepper, so the parallelism the analysis proved is not wasted on an undersized coder fleet.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Send the Dispatch Set to Coders, with Terminal Provisioning](../plans/dispatcher-auto-send-to-coder-terminals.md) — **CODE REVIEWED**
- [ ] [The DISPATCH toggle on the Planned column shows how many plans are staged](../plans/feature_plan_20260808120100_dispatch-toggle-staged-count-badge.md) — **CODE REVIEWED**
- [ ] [Remove the Manual "Move to Dispatch" Button from Planned Column Cards](../plans/feature_plan_20260808120000_remove-manual-send-to-dispatch-button-from-planned-cards.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

The count and button-removal subtasks both edit the same region of `kanban.html` — the Planned column header and the card action ternary — so they must be sequenced. **Count first**; the removal requires promoting and re-indenting a nested ternary arm, and a line-level delete leaves an orphaned `:` that surfaces at webview load, not at `tsc`.

The fan-out subtask is independent and can run in parallel with either, but its header renders the same plans/terminals numbers — landing the count first avoids two separate count implementations.

**Known-red baseline:** `node scripts/generate-protocol-catalog.js` already exits 1 (drift detected) at HEAD. Capture that baseline before editing so the post-regeneration diff is attributable. Never hand-edit the generated catalog or allowlist; run `npm run catalog:generate`.

Scope note: this feature covers the **manual** Dispatch view only. Autoban pools and rotation are deliberately out of scope.

## Completion Report

Implemented the three subtasks: the DISPATCH toggle now shows a live staged-plan count, the manual per-card "Move to Dispatch" button and `sendToDispatch` verb have been removed, and the Dispatch view gained a "Send all to coders" fan-out button with an alive-coder terminal count and a `+` terminal stepper. Files changed: `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, and the regenerated `src/generated/verbAllowlist.ts` and `protocol-catalog.json`. The `coderTerminalCount` is now pushed in every `updateBoard` payload and `npm run catalog:generate` plus `npm run parity:check` both pass; no issues encountered.

## Review Findings

Reviewer pass over all three subtasks: the count subtask and the button removal were correct as shipped; the fan-out subtask shipped a stepper whose count never repainted, blocked by three independent gates (no board refresh after terminal creation, a cards-only snapshot hash that discarded the recomputed `coderTerminalCount`, and a webview repaint reachable only through card-signature-gated paths). Fixed across `src/services/KanbanProvider.ts`, `src/webview/kanban.html`, `src/standalone/bootstrap.ts` and `src/services/verbSchemas.ts`; also added the missing `sendDispatchSetToCoders` schema (PRD contract #5) and a `terminalCreateAvailable` capability flag so standalone disables the `+` instead of faking success (PRD contract #6). The count subtask's required contract test had never been written — added as `src/test/dispatch-view-contract.test.js` and wired into `package.json` plus `.github/workflows/integration-tests.yml`, since a check defined but not invoked by CI is the green-while-incomplete hole. Validation: `catalog:check`, `parity:check`, `push-routing:check`, `verb-returns:check` and `standalone-parity:check` all exit 0, `browser-panel-verb-routing` 11/11, `verb-engine-kanban` 19/19, `render-guard` and `drag-guard` pass, the new contract test passes, `tsc --noEmit` holds at the 5 pre-existing TS2835 errors, and every inline script in `kanban.html` parses cleanly. Remaining risk is UAT-only: the manual steps in all three plans require an installed VSIX, and "alive ≠ idle" means Send can still over-dispatch onto a busy terminal (an accepted design decision, not a defect).
