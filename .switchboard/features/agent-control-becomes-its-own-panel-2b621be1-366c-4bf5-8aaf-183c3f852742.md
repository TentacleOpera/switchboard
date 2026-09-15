# Agent Control becomes its own panel

**Complexity:** 6

## Goal

Move Agent Control out of kanban.html into a panel file of its own, give it an Orders tab, and retire the agent tabs it leaves behind. These are one unit because they edit the same markup in sequence: extracting first means the Orders tab is added once, in its final home, and the old tabs can then be removed without leaving the board without a control surface.

## How the Subtasks Achieve This

- **Extract Agent Control into its own panel file**: lifts Agent Control out of `kanban.html` into a panel of its own. This is the move that makes the other two cheap.
- **Add an Orders tab to Agent Control**: adds the Orders tab. Done after the extraction, it is written once in its final home rather than added to `kanban.html` and then moved.
- **Retire the agent tabs from kanban.html**: removes what the extraction left behind, once the new panel is carrying the function.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add an Orders tab to Agent Control](../plans/add-an-orders-tab-to-agent-control.md) — **CODE REVIEWED** — ID: 6b9d97ce-60da-43d2-b1ab-6e574f27e1b7
- [ ] [Extract Agent Control into its own panel file](../plans/extract-agent-control-into-its-own-panel-file.md) — **CODE REVIEWED** — ID: 1e9a9b79-abd5-46ef-9b78-31beb778cd77
- [ ] [Retire the agent tabs from kanban.html](../plans/retire-the-agent-tabs-from-kanban-html.md) — **CODE REVIEWED** — ID: 02aa2bd1-26cc-492f-b3b4-7d826eede6f6
- [ ] [Surface a Build Target in Agent Control](../plans/surface-a-build-target-in-agent-control.md) — **CODE REVIEWED** — ID: c4475ad5-4222-4ccd-b009-7ce44ee60e0e
- [ ] [The Agent Control Surface Cannot Be Configured, and Is Driven by Typing](../plans/the-agent-control-surface-cannot-be-configured-and-is-driven-by-typing.md) — **CODE REVIEWED** — ID: 00e0d1f0-6e70-4d9f-843c-d8433daa6e6f
<!-- END SUBTASKS -->

## Scope note (operator, 2026-09-15)

**No dual-run.** These agent tabs live **only in Agent Control, not kanban.html**.
The extraction is a *move*, not a mirror — kanban.html losing the tabs is the
intended end state, not a regression. Do not keep a second copy alive in
`kanban.html` to preserve the old surface, and do not treat its removal as a
defect during review.

## Dependencies & sequencing

Strictly ordered: **extract → add the Orders tab → retire the old tabs**. All three edit the same markup, so any other order edits it more than once, and retiring the old tabs before the new panel carries the function would leave the board without a control surface in between.

**Cross-feature note.** The in-flight standing-orders work has a *Standing Orders Tab in the Agent Control Panel* subtask that depends on the extraction here landing first — it has nowhere to live until Agent Control is its own panel.


## Review Findings

Reviewed commit `a9497bd6`; the feature goal is achieved — `getAgentControlHtml` now serves `src/webview/agent-control.html` (161 KB, four tabs, `data-panel="agent-control"`, no `data-view`) instead of the 796 KB board, `KanbanProvider._getHtml` branches on `viewMarker`, and `src/` contains no `data-view="agent-control"` or `AGENT_CONTROL_VIEW`. Three fixes applied: `KanbanProvider.saveBuildTargetConfig` now pushes `config` on the `buildTarget` message (it blanked the SSH host / Actions repo / credentials checkbox on the round-trip that saved them), `buildTargetDirective` now tells the agent to send `planId` (the only writer of `BuildConfig.planIndex`, previously dead), and `protocol-catalog.json` was regenerated so the CI `catalog:check` gate is green (it was red on the commit's own new endpoint). Validation: `tsc -p tsconfig.test.json` clean, `catalog:check` OK, `eslint` 0 errors, `test:contract:agent-control-config` 11/11, both standing-order fragment suites green, and every retargeted suite at or better than its `a9497bd6^` baseline (measured in a `git archive` copy of the parent — `completion-asserted-never-inferred` improved 2→1, `panel-runtime-surface` 2→1, the rest unchanged). Remaining risk is coverage, not correctness: three of the five subtasks have no automated check that discriminates on their core mechanism.

## Deferred Findings

- MAJOR — commit `a9497bd6` sweeps in the Coding Rounds contract rewrite (deletion of `CODING_HEAD_WORK`, the `hasRegisteredRounds` compat branch, and the `headNext` lead arm) which belongs to `coding-rounds-05-the-lead-is-told-its-new-contract.md`, not to any plan in this feature — `src/services/standingOrderFragments.ts:125`
- MAJOR — commit `a9497bd6` also carries an unrelated feature-file edit for the Liveness feature — `.switchboard/features/liveness-stall-watching-and-what-arms-them-8033c64d-49e3-497b-9ef5-c1b386dec20b.md:14`
- MAJOR — `src/test/prompts-tab-move-regression.test.js` was retargeted at `agent-control.html` by this commit but has no `package.json` script and no CI invocation; it also fails (pre-existing, same assertion at baseline) — `src/test/prompts-tab-move-regression.test.js:1`
- NIT — `agent-control.html` carries dead `#setup-tab-content` / `#uat-tab-content` CSS inherited from the board — `src/webview/agent-control.html:2373`
- NIT — `inspectStandingOrders` does `kept.indexOf(o)` inside a `map` over every persisted row (O(n²)) — `src/services/teamWiring.ts:2246`
- NIT — `listCoreStandingOrders` still resolves `hasRegisteredRounds` per team, which no surviving fragment reads — `src/services/standingOrders.ts:495`
