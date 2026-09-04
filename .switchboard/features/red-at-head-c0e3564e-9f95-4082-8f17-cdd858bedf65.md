# Red at HEAD

**Complexity:** 8

## Goal

Everything failing at clean HEAD, deduplicated into one list. Three features were triaging overlapping sets of the same gates, and one gate was claimed by three cards carrying three different measurements. Ownership is stated in Dependencies so nobody re-baselines a pin another card is fixing.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A whole-file regex in the WS surface-scoping contract false-positives on a debug log](../plans/ws-surface-scoping-false-positive-blocks-ci-tail.md) — **CREATED** — ID: 25c68f2b-f66c-4a5a-bade-c015c5222d6d
- [ ] [Two CI contracts extract a span that no longer exists — a renamed declaration and a guard clause silently emptied their assertion windows](../plans/ci-contract-span-rot-memo-binding-and-pane-fit.md) — **CREATED** — ID: 74738725-1e30-413f-87ac-b419796364d1
- [ ] [Three CI contracts pin implementations that were deliberately replaced — the code moved on and the assertions did not](../plans/ci-contracts-pinning-superseded-designs-memo-verb-terminal-input-shell-strip.md) — **CREATED** — ID: 60288750-f436-47ca-a456-aba55b673bb0
- [ ] [Three dark control-plane tests fail on a database that no longer auto-creates — fix the harness seam and wire them into CI](../plans/dark-control-plane-tests-fail-on-a-db-that-no-longer-auto-creates.md) — **CREATED** — ID: ad2793d6-bea8-4004-9119-9e156779d350
- [ ] [Triage five red gates at HEAD](../plans/feature_plan_20260827144004_triage-five-red-gates-at-head.md) — **CREATED** — ID: a6f67e6c-f6e7-4e38-8aee-12bf37fb004e
- [ ] [kanbanColumnDerivation test is red at HEAD and unwired from CI](../plans/feature_plan_20260827161631_kanban-column-derivation-test-red-and-unwired.md) — **CREATED** — ID: ad6a5878-d5eb-4603-ac73-4decf6386fa1
- [ ] [vscode-test harness fails locally with ENOENT, blocking KanbanProvider and agentPromptBuilder suites](../plans/feature_plan_20260827161633_vscode-test-harness-enoent-locally.md) — **CREATED** — ID: cada9980-c314-4924-88dc-7c865052d1cc
- [ ] [Triage remaining red contract gates: staging-column and feature-file-subtask-link](../plans/feature_plan_20260827161635_triage-staging-column-and-feature-file-subtask-link.md) — **CREATED** — ID: 9d6a4525-ce7d-42dc-8810-b711d30070e3
- [ ] [Triage all 17 red contract suites blocking the integration-tests CI job](../plans/feature_plan_20260827161636_triage-all-17-red-contract-suites.md) — **CREATED** — ID: ab3c6849-08a2-4372-bd9a-ce05f8072d13
<!-- END SUBTASKS -->

## Dependencies & sequencing (2026-09-04, Board Collapse 09)

Three features were triaging overlapping sets of the same gates. Two subtasks were near-identical —
same two gates, same `viaDirectFile` fix — and have been deleted. What remains is one list.

**`mirror:check` is gone from every item here.** The Claude mirror generator, its manifest and that
CI step are deleted by *Delete the Claude mirror generator* (Board Collapse 02). Two triage cards
previously led with that drift. Do not re-add it.

Suggested order, cheapest and most-blocking first:

1. **Triage remaining red contract gates** — `staging-column` (a stale run-sheet assertion; the
   `sourceColumn: 'STAGING'` reference no longer exists in `kanban.html` and could not be found in
   `implementation.html` or `TaskViewerProvider.ts`) and `feature-file-subtask-link`
   (`create-feature.js`'s `viaDirectFile` must abort non-zero on unresolvable planIds instead of
   writing guessed links, including on the DB-unavailable `catch` path).
2. **Triage five red gates at HEAD** — now four, after the `mirror:check` item drops out:
   `claude-protocol-block`, `skill-preconditions`, `control-plane-migration.test.js:324`,
   `control-plane-repo-scope.test.js:152`. Its first three were attributed to revert commit
   `5cd79357`; do not reintroduce what that revert undid.
3. **Three dark control-plane tests fail on a database that no longer auto-creates** — fix the
   harness fixtures by pre-creating the databases. Never restore auto-create in
   `KanbanDatabase._initialize`; that is the scaffold-litter class.
4. **The four source-text contract repairs** — the WS surface-scoping false positive, the two
   rotted spans, and the three contracts pinning superseded designs. All four are test-only.
5. **`kanbanColumnDerivation` test is red and unwired**, and **the `vscode-test` harness ENOENT**.
   The second unblocks local verification of the first.
6. **Triage all 17 red contract suites** — the sweep, last, because the items above remove several
   from its list.

**One owner for `seat-safeguards`.** *Two reviewer→coder relays pass `promptComposed: true`* (in
*The Prompt A Seat Receives Is Quietly Wrong*) owns that gate's counts and re-pins them after fixing
the mis-binned site. Three cards previously claimed it with three different measurements — 7 sites
with 2 composed, 7 asserted but 12 found, and one listing it among 15 suites to fix. **Item 6 and
the pin-behaviour sweep must not re-baseline it.** If a remote-dispatch seam lands it adds an eighth
site to that inventory; cross-reference before touching.
