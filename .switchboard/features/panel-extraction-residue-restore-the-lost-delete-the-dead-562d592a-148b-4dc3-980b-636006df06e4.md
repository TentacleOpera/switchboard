# Panel Extraction Residue - Restore the Lost, Delete the Dead

**Complexity:** 7

## Goal

Two features moved to new surfaces and left broken residue behind in the old panel, failing in opposite directions. Tickets auto-sync left its engine in the panel being retired and had its only writer deleted, so users who enabled it in a shipped version still have it running with no way to see it or turn it off. Default Prompt Overrides moved to the kanban Prompts tab but left its entire implementation in Setup, where a bare getElementById on a deleted id throws an uncaught TypeError on every panel load. Same root cause class, opposite symptom. Note the tickets subtask touches state shipped to roughly 4000 installs and must be migrated, not orphaned.

## How the Subtasks Achieve This

- **Tickets Auto-Sync Lost in the Panel Extraction**: migrates the shipped `ticketsAutoSync` state and moves the auto-sync engine into `TicketsPanelProvider` with a control the user can actually see and click.
- **Delete the Vestigial Default Prompt Overrides UI in the Setup Panel**: removes the dead markup, JavaScript and backend arms, and adds a contract test that fails on any element id the JavaScript reads but the markup does not define.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Tickets Auto-Sync Lost in the Panel Extraction — Migration Regression](../plans/feature_plan_20260807103000_tickets-autosync-migration-regression.md) — **CODE REVIEWED** — ID: d5bf487a-3578-4846-b17f-5e4e8834b9c4
- [ ] [Delete the Vestigial Default Prompt Overrides UI Left Behind in the Setup Panel](../plans/feature_plan_20260807150000_setup-panel-orphaned-element-ids-crash.md) — **CODE REVIEWED** — ID: 2071a79c-cf26-4702-929d-2c1471aedfef
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; different providers, different files, and they can be executed in parallel.

Worth landing the **contract test** from the Setup subtask early regardless of order — it is the gate that would have caught this entire class of defect, and it protects the other subtask's edits too.

⚠ **Migration rule applies.** The tickets subtask touches state written by a control that shipped in a released version to roughly 4,000 installs, many on much older builds. Import before deleting, archive legacy files as `*.migrated.bak` rather than unlinking, preserve unknown keys, and do not assume a prior migration already ran. The read path is **live right now** on those installs — a 45-second delta-pull timer and an auto-push file watcher are running in a provider that is being emptied out.

---

## Review Findings

Both subtasks reviewed in place with regression analysis; four defects found and fixed. **Tickets auto-sync:** one CRITICAL — the first-open carrier `ticketsAutoSyncChanged` was gated on `_isForThisPanel`, which rejects scope-less pushes whenever a ClickUp list is selected, so the restored toggle would have rendered unticked over a running engine (the exact failure the subtask exists to prevent); plus one MAJOR cross-root broadcast leak on `integrationProviderStates` and one MAJOR gap where both of the plan's named regression guards were never written. **Setup panel deletion:** one MAJOR — the new contract test's "no crashing reads" rule could not see capture-then-dereference, the shape of the crash it was written for; the classifier now catches it and a self-test pins that. Validation: `tsc` clean of new errors, `catalog:check`/`parity:check`/`verb-returns:check`/`push-routing:check` green after catalog regeneration, and 15 contract suites green (the single red, `ws-surface-scoping`'s `updateColumns` resync assertion, is caused by a sibling uncommitted `bootstrap.ts` change from the standalone push-parity stream and is unrelated to this feature).

## Completion Report — Review Pass

Executed a direct reviewer pass over both subtasks: Grumpy findings, balanced synthesis, code fixes, and verification, in one continuous pass. Files changed: `src/services/TicketsPanelProvider.ts`, `src/webview/tickets.js`, `src/test/verb-engine-tickets-headless.test.js`, `src/test/setup-panel-element-ids.test.js`, `protocol-catalog.json` and `src/generated/verbAllowlist.ts` (regenerated). The feature's stated goal is met: the shipped `ticketsAutoSync` state is now migrated, visible and controllable, and the dead Default Prompt Overrides UI is gone with a durable guard against the next occurrence of its defect class. Remaining risks are recorded per subtask; none block.
