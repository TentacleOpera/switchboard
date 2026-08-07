# Standalone Push-Path Parity

**Complexity:** 6

## Goal

Both standalone state builders in `src/standalone/bootstrap.ts` fabricate the browser board's payload from hardcoded literals instead of reading live state — raw default columns, an empty routing map, CLI triggers off, a fixed theme, and seven dead control-plane / repo-scope fields. Because every verb still reaches the provider through the `default:`-arm delegation, writes land and return `{success:true}` while the next coalesced push (~40 ms later) re-asserts the literal and reverts the UI.

That is why repeated standalone parity audits passed on features that were entirely dead in the browser: the audits checked verb reachability, which cannot fail, rather than the read-back path, which carries fabricated values.

This feature installs a CI guard that turns the gap into a ratcheted number, replaces the fabricated payload with a delegation to the provider's existing `getFullStateMessages`, and closes the one still-live defect in the shared push transport.

> **Correction (2026-08-07, improve-feature pass).** This feature originally opened with "KanbanProvider.postMessage has no sink there because bootstrap.ts installs neither a broadcaster nor a panel." That is not true and was already not true when the plans were written: `bootstrap.ts:639` constructs a shared `BroadcastHub`, `:705` assigns it to the Kanban provider (and five siblings), and `:1660` attaches the live WS hub — landed 2026-07-22 (`0f2e55d6`). Provider pushes do reach the browser. The transport's real residual defect is retention, not delivery: with no webview, `BroadcastHub.push` appends every message to an unbounded queue that is never drained headlessly. The fabricated payload, not a missing bridge, is what dominates this feature.

## How the Subtasks Achieve This

- **Standalone Push-Parity Guard — Make "Is the Browser Host at Parity?" a CI Number**: Adds `scripts/check-standalone-push-parity.js`, an AST-based ratchet that diffs the message types the shared board handles against the types standalone can actually deliver, asserts the broadcaster wiring stays in place, and flags hardcoded view-state fields in the board payload — with a delegation assertion as the ratchet's floor. It lands first so every other subtask is verified by a number dropping rather than by another manual assessment. Its acceptance criterion is that it must FAIL on the current tree with baselines at zero *while reporting the already-fixed broadcaster as green* — a guard that cannot tell a closed sub-problem from an open one is the failure mode this feature exists to end.
- **Standalone State Builders Fabricate the Board Payload — Delegate to `getFullStateMessages`**: The bulk of the work. Deletes both hand-built state arrays and calls `KanbanProvider.getFullStateMessages(root, scope)` — already `public`, already scope-aware, and documented as existing for exactly this caller — which fixes custom columns, visibility, order, routing config, CLI triggers, repo scope, project context and the workspace-item shape in one change. Keeps only the theme entry (which that method does not emit) and the genuinely host-specific `dispatchAnalyzeAvailable: ptyReady` override, and resolves the three state-ownership conflicts delegation exposes (the shadowing `projectFilter` closure, the `{value,label}` vs `{label,workspaceRoot}` item shape, and the shared DB handle).
- **Restore the Backlog View to the Standalone (Browser) Host**: Now scoped to the transport's remaining defect. `BroadcastHub` has no headless mode: with `webview: null` and no webview ever attached, every push is appended to `_pendingWebviewMessages` and never flushed — one shared hub, six providers, driven by the 40 ms coalesced push loop, in a long-running `npx` process. Adds an explicit headless mode set once at the standalone composition root, and carries the end-to-end backlog UAT the feature always owed.

**Merge record (2026-08-07).** Five subtasks — `standalone-column-structure-ignores-custom-columns-and-visibility.md`, `standalone-routing-config-hardcoded-empty.md`, `standalone-cli-triggers-state-hardcoded-off.md`, `standalone-theme-hardcoded-afterburner.md`, `standalone-workspace-selection-fields-hardcoded.md` — were merged into the single delegation plan. All five edited the same two array literals in the same two functions, and each proposed exposing a private `KanbanProvider` resolver that `getFullStateMessages` makes redundant. Their full intent is carried forward there; the git history before commit `e8e025fe` holds the originals.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Restore the Backlog View to the Standalone (Browser) Host](../plans/restore-backlog-view-to-standalone-host.md) — **PLAN REVIEWED**
- [ ] [Standalone Push-Parity Guard — Make "Is the Browser Host at Parity?" a CI Number](../plans/standalone-push-parity-guard.md) — **PLAN REVIEWED**
- [ ] [Standalone State Builders Fabricate the Board Payload — Delegate to `getFullStateMessages`](../plans/standalone-state-builders-delegate-to-getfullstatemessages.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

There are ordering constraints, and they matter more than usual here — the point of the sequence is that no subtask is ever declared done on a human's judgement.

1. **Standalone Push-Parity Guard** lands first. Everything after it is verified by lowering a baseline. It ships with a baseline capturing today's real gap so CI is green from the first commit; following the `check-push-routing.js` convention, the baseline may only ever be lowered, never raised. It has no code dependency on the other two — the ordering is purely so their completion is measured rather than asserted.
2. **Standalone State Builders Delegate to `getFullStateMessages`** lands second and is where the baseline actually drops. It owns `bootstrap.ts`'s two state builders outright, so nothing else may edit them concurrently.
3. **Restore the Backlog View** can land at any point. Its remaining scope is `src/services/broadcastHub.ts` plus the single hub construction site at `bootstrap.ts:639`, so it does not collide with the delegation plan's edits. Its UAT is most meaningful *after* the delegation lands, since several of its board-exercising steps depend on live payload values.

**Prerequisites / guards.** The delegation plan must not begin until it is confirmed that `KanbanDatabase.forWorkspace` returns the same cached instance to both `bootstrap.ts:286` and `KanbanProvider._getKanbanDb` — a second DB handle would give the browser a different card set from the same file. Per the project PRD's orchestration discipline, only one agent stream may hold `src/standalone/bootstrap.ts` at a time.

**Cross-feature dependencies.** None inbound. Outbound: `dispatcher-column-and-bounce-analysis.md` declares this feature's transport work as a hard prerequisite — dispatch is implemented as a display mode on the Planned column and would inherit the fabricated-payload defect verbatim, so it must not start until the delegation plan lands.
