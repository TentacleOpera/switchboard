# Building and Gating on the Pi

**Complexity:** 4

## Goal

Consolidated 2026-09-10: no build cache, double type-checking, the Pi cannot build what CI can, and a catalogue extractor that tracks brace depth without consulting it.

The Pi is a supported deployment, so build time is on the critical path of changing anything — not just of cutting a release. This feature makes builds faster (filesystem cache, single-bundle builds, no double type-check), gives the operator a visible choice of where builds run (this box, desktop over SSH, or GitHub Actions), and fixes a protocol-catalogue extractor bug that allowlists six phantom verbs with no handler. Together these reduce the Pi's build wall and make the build pipeline honest.

## How the Subtasks Achieve This

- **The catalogue extractor tracks brace depth but never consults it, so six role names are allowlisted as verbs**: Fixes `extractHandlerArms` in `scripts/generate-protocol-catalog.js` to record a `case` as a handler arm only at brace depth 1 (directly in the message-handler switch), not inside nested switches. Regenerates the catalogue and allowlist, removing six phantom verbs (`planner`, `lead`, `coder`, `intern`, `reviewer`, `tester`) and adding two missing ones (`setCardPriority`, `setOrderByMode`). Makes the parity gate green and tightens the `POST /kanban/verb/<name>` validation boundary.
- **The Webpack Build Has No Cache, Type-Checks Everything Twice, and Always Builds Both Bundles**: Adds a webpack 5 filesystem cache (with mandatory `buildDependencies`), enables `transpileOnly` (eliminating the double type-check since `tsc` already runs in the pretest chain), adds npm scripts for single-bundle builds via the already-present `name` fields, and reduces dev source-map cost. Makes `npm run compile` reuse work between runs and lets the operator build one bundle when only one is wanted.
- **Surface a Build Target in Agent Control**: Adds a build-target control to Agent Control with three values (this box, desktop over SSH, GitHub Actions), records build results against commit SHAs so a reviewer is told the result for the commit it was handed (not "the last build"), and reports target unavailability at the point of choice rather than silently falling back. Depends on the webpack plan landing first (faster local builds weaken the case for offloading) and on the `agent-control-becomes-its-own-panel` feature providing the panel surface.

## Dependencies & sequencing

- **Subtask 1 (catalogue extractor) is independent** — it touches only `scripts/generate-protocol-catalog.js` and the two generated files. It can land in any order relative to the other two.
- **Subtask 2 (webpack build) should land before subtask 3 (build target).** The build-target plan explicitly states this: faster local builds (from the cache and `transpileOnly` changes) weaken the case for offloading, so the target choice should be made after the build improvements land. If the build-target control ships first, the operator's calculus is based on the old slow build.
- **Subtask 3 (build target) also depends on the `agent-control-becomes-its-own-panel` feature** landing first — the control lives on that panel. This is a cross-feature dependency stated in the plan, not inferred from shared files.
- **No intra-feature file conflicts.** The three subtasks touch disjoint file sets. `KanbanProvider.ts` is read by subtask 1 (the nested switch is the source of the false positives, not the fix) and modified by subtask 3 (reviewer dispatch path) at different locations — no merge-order constraint.

## Team Dispatch Instructions

### The catalogue extractor tracks brace depth but never consults it, so six role names are allowlisted as verbs

- **Seat:** Intern (complexity 2)
- **Acceptance:**
  - `node scripts/check-protocol-parity.js` passes with 0 errors.
  - `KANBAN_VERBS` no longer contains `planner`, `lead`, `coder`, `intern`, `reviewer`, `tester`; `POST /kanban/verb/coder` is refused as unknown.
  - `protocol-catalog.json` changes by exactly six removals (Kanban role names) and two additions (`setCardPriority`, `setOrderByMode` in Kanban and Planning) — nothing else moves.
  - The regression fixture yields one arm, not two; an arm of the form `case 'x': {` at depth 1 is still recorded.
  - Arm counts for Planning, Tickets, Design, TaskViewer, and Setup are unchanged.
- **Must not touch:** `KanbanProvider.ts` — the nested `switch (role)` inside `getPromptPreview` is the source of the false positives, not the fix site. The fix is in the extractor script only.

### The Webpack Build Has No Cache, Type-Checks Everything Twice, and Always Builds Both Bundles

- **Seat:** Coder (complexity 3)
- **Acceptance:**
  - `node_modules/.cache` exists after a build and is reused on a no-change rebuild.
  - Editing `webpack.config.js` invalidates the cache (observable output change on next build).
  - A deliberate type error in `src/` still fails `npm test` (via `compile-tests`) AND the release path (via whichever type-gate mechanism was chosen).
  - `webpack --config-name standalone` builds only `dist/standalone`; `--config-name extension` builds only the extension bundle; `npm run compile` with no args still builds both.
  - `npm run package` builds both bundles and produces a working VSIX with `devtool: hidden-source-map`.
- **Must not touch:** Source files in `src/` — this is a configuration-only change to `webpack.config.js` and `package.json`. The one exception is if `fork-ts-checker-webpack-plugin` is chosen as the type gate, which adds it to the configs (not to source).

### Surface a Build Target in Agent Control

- **Seat:** Coder (complexity 4)
- **Acceptance:**
  - The build-target control appears in Agent Control with exactly three options, persists its choice across reopens, and shows the last duration per target.
  - A reviewer dispatched commit SHA `X` receives the build result for `X` (not the latest build for a different SHA), or an explicit "not built yet."
  - Selecting an unreachable target displays "unavailable" at the point of choice, before any build is dispatched — no silent fallback to `this box`.
  - The control and its build-execution backend work in both the extension host and the standalone host (parity).
  - Default remains `this box`; a build on it succeeds.
- **Must not touch:** The `agent-control-becomes-its-own-panel` extraction itself — this plan adds to the panel, it does not perform the extraction. If the extraction has not landed, coordinate rather than doing both in one diff.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The catalogue extractor tracks brace depth but never consults it, so six role names are allowlisted as verbs](../plans/the-catalogue-extractor-tracks-brace-depth-but-never-consults-it.md) — **PLAN REVIEWED** — ID: 98483dc5-e238-4396-a60a-c6e31136a55a
- [ ] [The Webpack Build Has No Cache, Type-Checks Everything Twice, and Always Builds Both Bundles](../plans/webpack-build-has-no-cache-and-typechecks-twice.md) — **PLAN REVIEWED** — ID: 38c0a7c2-4962-4db9-a53a-d0b3e758d0ec
- [ ] [Surface a Build Target in Agent Control](../plans/surface-a-build-target-in-agent-control.md) — **PLAN REVIEWED** — ID: c4475ad5-4222-4ccd-b009-7ce44ee60e0e
<!-- END SUBTASKS -->

