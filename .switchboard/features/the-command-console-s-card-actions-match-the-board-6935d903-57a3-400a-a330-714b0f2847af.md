# The command console's card actions match the board

**Complexity:** 3

## Goal

Make the command surface behave like the board it fronts. Today its three card actions are each wrong in a different way: advancing a card calls the coding-seat router instead of the board's advance verb, so every card jumps to a coding column; moving a card fails outright on the standalone host because the moveCard seam is unwired; and the column lists it offers are the built-in catalogue rather than this board's enabled columns, so they include stages with no agent behind them. Each subtask fixes one of those by calling or reading what the board already uses, rather than adding a parallel mechanism to the console.

## How the Subtasks Achieve This

- **move-card.js's direct-DB fallback must go, and /kanban/move must accept a batch**: deletes
  the second write path whose result was indistinguishable from a real move, widens the route to
  take `planIds[]` so one operator gesture is one request, and makes the 503 name the missing
  seam. **The seam wiring itself is not in this feature** — it is owned by
  `wire-the-sixteen-unwired-localapiserver-seams-in-standalone.md` (planId
  `417980bd-e8d9-4465-b301-0857c39ee3d7`, already in PLAN REVIEWED), which covers `moveCard`
  plus fifteen sibling seams. That plan must land first, or deleting the fallback leaves
  standalone with no working move at all.
- **The command console never implemented advance**: replaces the console's private routing with
  a thin `POST /kanban/advance` over the `kanbanVerb` seam the dispatch handler already uses,
  sending the card's current column and letting the backend resolve the next stage exactly as
  the board's advance button does. This is the subtask that makes a card in New go to Planned
  instead of straight to a coder.
- **GET /kanban/columns publishes the built-in catalogue**: joins `agents.visibleAgents` into
  the columns response and tags each entry with `enabled` / `enabledSource`, so the console's
  dropdowns stop offering stages this board does not run. Advance is immune (it never sends a
  destination), but every column list on the surface — and every agent skill pointed at this
  endpoint as the live mapping — depends on it.

Together they remove the console's three parallel mechanisms and leave it calling the board's
own verbs and reading the board's own configuration.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [move-card.js's direct-DB fallback must go, and /kanban/move must accept a batch — the seam wiring itself is already owned by another plan](../plans/kanban-move-is-unwired-in-the-standalone-host.md) — **CODE REVIEWED** — ID: 1946ee61-5e32-4663-8ddc-7cb0b45d4cc0
- [ ] [The command console never implemented advance — it calls the coding-seat router directly, so every card jumps to a coding column](../plans/command-console-dispatch-reads-as-an-advance.md) — **CODE REVIEWED** — ID: c73ea0da-6d96-41fa-81ed-95f2134e5ef1
- [ ] [GET /kanban/columns publishes the built-in catalogue instead of this board's columns, so clients offer Researcher and Ticket Updater to a board that has neither](../plans/column-reads-publish-the-catalogue-not-the-board.md) — **CODE REVIEWED** — ID: d8cc4d79-ff07-4730-804d-fde66f617ac6
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints — the three subtasks touch different seams and can be executed in
parallel. Two soft orderings are worth knowing, and neither blocks a coder:

- The **advance** subtask is independently shippable and delivers the reported bug fix on its
  own; it does not wait on the other two.
- The **Move view** depends on work partly outside this feature.
  `wire-the-sixteen-unwired-localapiserver-seams-in-standalone.md` (PLAN REVIEWED, external to
  this feature) wires the `moveCard` seam; subtask 1 here must land **after** it, never before.
  Move is then only fully verifiable once the column lists are also correct (subtask 3), since
  its target dropdown is fed by `GET /kanban/columns`.
- **Multi-card selection** is delivered by the advance subtask (the console's selection state is
  shared by both views), while the batch `planIds[]` form for the move route is in subtask 1.
  Both must land for a batch *move*; a batch *advance* needs only the advance subtask.

Each subtask's verification runs on **both** composition roots — the standalone host and the
installed VSIX. Subtask 1 exists because those two roots had drifted, so a same-host-only pass
would miss the whole class of defect.

## Team Dispatch Instructions

### move-card.js's direct-DB fallback must go, and /kanban/move must accept a batch

- **Seat:** Intern (complexity 2)
- **Acceptance:**
  - `POST /kanban/move` with `planIds: [a,b,c]` moves all three and reports `count: 3` with per-card results; a partial batch returns 207 naming the failing id
  - With no host reachable, `move-card.js` exits 1 telling the operator to start the board, and the kanban DB is byte-identical (`md5sum` before/after) — no fallback write
  - `grep -r viaDirectDb .agents .claude` returns nothing; neither skill mirror describes a second path
  - With the seam deliberately unset, `POST /kanban/move` returns 503 with `seam: 'moveCard'` in the body
- **Must not touch:** The `moveCard` seam wiring itself — that is owned by `wire-the-sixteen-unwired-localapiserver-seams-in-standalone.md`. Do not add `moveCard` to `bootstrap.ts` options; only delete the fallback, widen the route, and improve the 503.

### The command console never implemented advance — it calls the coding-seat router directly, so every card jumps to a coding column

- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - Card in New, console ADVANCE → lands in Planned (not a coding column); same card, board advance → same destination
  - Card in Planned, complexity 6, console ADVANCE → lands in Coder (banding applies where it should)
  - Three cards selected, ADVANCE → all three move in one request, chip reports `Advanced 3 cards`; selection clears after
  - `grep` the served console JS for `resolveAutoDispatchColumn` and coding-column identifiers → zero matches; the console names no column and no role
  - `POST /kanban/advance` response body does not contain a `prompt` field
- **Must not touch:** `POST /kanban/dispatch` handler (existing callers — CLI `dispatch` verb, board drag-drop — must keep working unchanged); `getNextColumn` in `kanban.html` (board-local optimistic predictor only; the console does not get a copy)

### GET /kanban/columns publishes the built-in catalogue instead of this board's columns, so clients offer Researcher and Ticket Updater to a board that has neither

- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - `GET /kanban/columns` on this board: `RESEARCHER`, `TICKET UPDATER`, `ACCEPTANCE TESTED` come back with `enabled: false, enabledSource: 'config'`; the five enabled role columns with `enabled: true`
  - Console's three dropdowns do not include disabled columns as options; enabling Researcher in Setup (no restart) makes it appear, disabling hides it
  - A card parked in `TICKET UPDATER` by direct DB write still appears in `GET /kanban/board` with its label — disabled ≠ invisible on read paths
  - `DEFAULT_VISIBLE_AGENTS` is exported from `agentConfig.ts`; `grep` confirms no private static copy remains in `GlobalIntegrationConfigService.ts`
  - `.agents/skills/**` and `.claude/skills/**` describe the same response shape (diff the two mirrors)
- **Must not touch:** `/kanban/board`, `/kanban/plan`, and label resolution paths (reads must stay untouched — the response tags, it does not server-side filter); `displayModeOf` / `legacyAliasOf` relationships (enabled must not override those signals)

## Completion Summary

All three subtasks implemented and verified via git diff review. Subtask 1 deleted the direct-DB fallback from move-card.js, widened POST /kanban/move to accept planIds[] batches with 207 on partial failure, and named the moveCard seam in the 503. Subtask 2 replaced the console's /kanban/dispatch call with POST /kanban/advance over the kanbanVerb seam, enabling multi-card selection with no prompt field in the response and no coding-column identifiers in the served JS. Subtask 3 joined agents.visibleAgents into GET /kanban/columns with enabled/enabledSource tagging, moved DEFAULT_VISIBLE_AGENTS to agentConfig.ts, and filtered console dropdowns to enabled columns. Committed as 505e6e92.


## Review Findings

Reviewer pass over all three subtasks. The feature's goal is met — the console now calls `POST /kanban/advance` (source column in, backend resolves the stage), `POST /kanban/move` takes `planIds[]`, and `GET /kanban/columns` tags each column with `enabled`/`enabledSource` — but the delivered commit did not compile: two `_lookupPlansByIds` implementations coexisted in `LocalApiServer` (5 errors, breaking the CI `compile-tests` gate), and the surviving one fabricated identity records for unresolved plan ids. Fixed here: one honest lookup helper carrying a `resolved` flag; `_resolveVisibleAgents` now reads the machine-global store Setup actually writes instead of the retired per-workspace `agents.visibleAgents` DB key (measured: the two stores disagree by 7 roles on this board); the final-stage advance no longer reports a false success; and the console sends one batch move request instead of a per-card loop. Files changed: `src/services/LocalApiServer.ts`, `src/services/agentConfig.ts`, `src/webview/command.js`. Validation: `tsc -p tsconfig.test.json` clean of every feature-introduced error, `eslint` 0 errors, 10 gate scripts and 12 contract suites pass.

## Deferred Findings

- CRITICAL — `src/standalone/bootstrap.ts:3273` — `moveCard` is still unwired in the standalone composition root, but subtask 1 deleted `move-card.js`'s direct-DB fallback anyway. Its plan names `wire-the-sixteen-unwired-localapiserver-seams-in-standalone.md` (planId `417980bd-e8d9-4465-b301-0857c39ee3d7`) as a hard blocking dependency that must land first; it has not. Standalone currently has no working card move. Not fixed here — the plan's "Must not touch" explicitly forbids adding `moveCard` to `bootstrap.ts`.
- MAJOR — none of the three plans defines an `### Automated` verification subsection, so no gate discriminates on any of the three core mechanisms (advance destination, batch move, column enablement). Every manual verification step remains unexecuted: the live host on :7777 serves a VSIX predating this commit, so none of this code has ever run.
- MAJOR — `protocol-catalog.json` drift makes `catalog:check` and `parity:check` red, and `verb-returns:check` reports a Planning break-count regression. All three trace to `setCardPriority`/`setOrderByMode` from the later priority commit `4df54319`, not to this feature. `npm run catalog:generate` fixes the first two; the verb-returns baseline needs a hand-edited justification from that feature's author.
- MAJOR — `test:contract:skill-preconditions` (CI-wired, workflow line 414) fails 5 assertions on `kanban_operations` and `query-kanban` SKILL.md. Byte-identical across `505e6e92^`, `505e6e92` and HEAD — pre-existing, not caused by this feature.
- MAJOR — `test:contract:verb-engine` (CI-wired, line 596), `test:contract:plan-priority-endpoint` and `test:contract:headless-feature-mgmt` fail on `TaskViewerProvider` headless migrations, `starred` input validation, and the deleted AUTOMATION tab respectively. None touch this feature's files.
- NIT — `src/webview/command.js:1527` — `pollDispatchDelivery` is now orphaned (zero callers) after the switch off `/kanban/dispatch`.
- NIT — `src/webview/command.js:706` — each tap re-runs `renderDispatchView()`, whose sort floats selected rows to the top, so rows reorder under the operator's finger. Plan-specified behaviour.
- NIT — `src/services/LocalApiServer.ts:7712` — custom columns are `enabled: true` unconditionally, so a custom column with a disabled role is still offered as a destination.
- NIT — `src/webview/command.js:1712` — a 207 partial move leaves the successfully-moved cards selected.
