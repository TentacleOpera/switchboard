# Tickets Panel Extraction — Follow-ups

**Complexity:** 6

## Goal

Finish the two pieces of the Tickets panel extraction that were never coded. Both plans were authored on 2026-08-03 and attached to the Tickets Panel Extraction feature after it had already advanced to CODE REVIEWED, so nothing ever picked them up: the feature card read complete while the work sat untouched. Verified undone at the time of grouping - the dead-code sweep's own marker phrase still returns 11 stub placeholders in planning.js and 143 ticket references remain in planning.html.

Re-verified at HEAD on 2026-08-14: still undone. The two subtasks are the extraction's two remaining loose ends — one removes what the Artifacts panel should no longer own, the other completes what the Tickets panel was never given. Together they make the extraction's ownership boundary true in code rather than only in intent.

## How the Subtasks Achieve This

- **Sweep the dead ticket code left in the Artifacts panel after the Tickets extraction**: Deletes the closed, unreachable ticket cluster still sitting in `planning.js` (403 `ticket` lines, 48 ticket-named functions, 11 `stub — real impl in tickets.js` placeholders), the ticket `<style>` rules in `planning.html` (143 lines, zero element ids), and the ticket helpers with no surviving caller in `PlanningPanelProvider.ts` (65 lines). It also removes the two dead cross-boundary push chains — `integrationWorkspaces` and `integrationProviderStates` — where the provider still computes and pushes payloads whose webview consumers were deleted in slice 2b. Contributes the "Artifacts panel no longer owns tickets" half of the goal: after it, grepping `planning.js` for "ticket" finds the panel's own concerns, not a second dead implementation.

- **Give `tickets.root` a single source of truth: wire the host push, then drop the local mirror**: Makes the host-side panel state store the sole authority for the Tickets panel's remembered workspace root. Adds the `restoredTabState` push that `TicketsPanelProvider` has never sent, fixes the provider's `persistTabState` arm so root-scoped writes stop collapsing into the panel-scoped slot, then removes the webview-local `vscode.setState` mirror that shadows the host value. Contributes the "Tickets panel actually owns its state" half: it retires the last dual-write left by slice 2a and unblocks slice 2f's `_migrateTicketsRootFromPlanning`, which the mirror currently makes look like a silent no-op. Re-tracing at HEAD showed the mirror was hiding two further defects — `_restoredPanelState` is permanently empty, so *all* per-root Tickets state restore is dead, and per-root writes have been landing in the wrong memento key — both now in scope.

## Dependencies & sequencing

- **The subtasks are independent and can land in any order.** They share no files: the sweep edits `planning.js`, `planning.html` and `PlanningPanelProvider.ts`; the `tickets.root` plan edits `tickets.js` and `TicketsPanelProvider.ts`. Disjoint file sets mean they also satisfy the project PRD's "one agent stream per provider file" rule if run in parallel.

- **The one shared concept is the legacy `tickets.root` value under the *planning* panel's state store, and it creates no ordering constraint.** The sweep deletes the `planning.js` code that *wrote* that key; the `tickets.root` plan's migration *reads* it, directly from the memento (`new PanelStateStore(globalState, 'planning').getPanelState('tickets.root')`), not from any payload the sweep touches. Deleting a writer does not erase values already persisted on shipped installs — and those installs are the whole population the migration serves. Either plan can land first.

- **Guard, not an ordering rule:** the sweep must not add any cleanup that *clears* the legacy planning-store `tickets.root` value, and must not delete the `stripImportedSubtasksBlock` import's replacement or the `_pushTickets` push-race token (a name collision, not the ticket feature). Both plans state this explicitly. If the sweep ever grows a "clear the legacy key" step, it becomes a hard blocker on the migration and this section must be rewritten.

- **Prerequisite already in place:** slice 2f's `_migrateTicketsRootFromPlanning()` ships at `TicketsPanelProvider.ts:1292`. Neither subtask needs to add it; the `tickets.root` plan only stops it being shadowed.

- **Reconciled end-state (no restructure was required):** the audit found overlap in neither files nor symbols and no contradicting designs, so both plans were improved in place and the set was left at two subtasks. The single agreed end-state on the shared surface is: the Tickets panel's own store is authoritative for `tickets.root`; the planning store's copy becomes read-only history that only the one-time migration consults.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Sweep the dead ticket code left in the Artifacts panel after the Tickets extraction](../plans/tickets-panel-7-sweep-dead-ticket-code-from-planning.md) — **PLAN REVIEWED**
- [ ] [Give `tickets.root` a single source of truth: wire the host push, then drop the local mirror](../plans/tickets-panel-8-single-source-for-tickets-root.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

