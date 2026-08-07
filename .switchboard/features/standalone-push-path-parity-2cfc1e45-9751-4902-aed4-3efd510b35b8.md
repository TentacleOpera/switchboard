# Standalone Push-Path Parity

**Complexity:** 5

## Goal

The standalone (browser) host silently discards host-to-UI pushes. KanbanProvider.postMessage has no sink there because bootstrap.ts installs neither a broadcaster nor a panel, and both standalone state builders fabricate the board payload from hardcoded literals instead of reading live state.

Because every verb still reaches the provider through the default-arm delegation, writes land and return success while the read-back path reverts them. That is why repeated standalone parity audits passed on features that were entirely dead in the browser: the audits checked verb reachability, which cannot fail, rather than the push path, which was never wired.

This feature installs a CI guard that turns the gap into a ratcheted number, bridges the push path so provider messages reach the browser, and replaces each fabricated payload field with live state.

## How the Subtasks Achieve This

- **Standalone Push-Parity Guard**: Adds `scripts/check-standalone-push-parity.js`, an AST-based ratchet that diffs the message types the shared board handles against the types standalone can actually deliver, asserts a broadcaster is installed, and flags hardcoded view-state fields in the board payload. It lands first so every other subtask is verified by a number dropping rather than by another manual assessment. Its acceptance criterion is that it must FAIL on the current tree with baselines at zero — a parity guard that passes on known-broken code is the exact failure mode this feature exists to end.
- **Restore the Backlog View to the Standalone Host**: Fixes the transport defect itself. Installs a `BroadcastHub`-shaped adapter so `KanbanProvider.postMessage` has a sink in standalone, and stops hardcoding `showingBacklog`. This is the highest-leverage subtask: the bridge converts every dead provider push at once, not just backlog's.
- **Standalone Board Renders Raw Default Columns**: Replaces the raw `DEFAULT_KANBAN_COLUMNS` literal with the derived, visibility-filtered list. The largest payload defect — it silently discards an entire user-configurable subsystem (custom columns, visibility, order and labels) rather than a single flag.
- **Standalone Board Sends an Empty Routing Config**: Replaces `routingConfig: {}` with the live per-scope routing map, making dynamic complexity routing act on real configuration in the browser.
- **Standalone Board Reports CLI Triggers Permanently Off**: Replaces the `enabled: false` literal with the resolved setting, so the CLI-triggers toggle stops reverting after every change.
- **Standalone Board Hardcodes the Afterburner Theme**: Replaces the fixed theme name with the configured value. The only cross-panel instance — the entry is tagged `SURFACES.common`, so the fabricated value reaches every standalone panel, not just the board.
- **Standalone Workspace-Selection Payload Is Seven Hardcoded Fields**: Derives the control-plane and repo-scope fields from the provider's existing resolvers, and converts any field with genuinely no standalone meaning into a named constant with a stated reason plus a guard-allowlist entry. Closes the loop: after this, no field in the payload is an unexplained literal.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Restore the Backlog View to the Standalone (Browser) Host](../plans/restore-backlog-view-to-standalone-host.md) — **PLAN REVIEWED**
- [ ] [Standalone Push-Parity Guard — Make "Is the Browser Host at Parity?" a CI Number](../plans/standalone-push-parity-guard.md) — **PLAN REVIEWED**
- [ ] [Standalone Board Renders Raw Default Columns — Custom Columns, Visibility and Order All Ignored](../plans/standalone-column-structure-ignores-custom-columns-and-visibility.md) — **PLAN REVIEWED**
- [ ] [Standalone Board Sends an Empty Routing Config — Dynamic Complexity Routing Is Dead in the Browser](../plans/standalone-routing-config-hardcoded-empty.md) — **PLAN REVIEWED**
- [ ] [Standalone Board Reports CLI Triggers Permanently Off](../plans/standalone-cli-triggers-state-hardcoded-off.md) — **PLAN REVIEWED**
- [ ] [Standalone Board Hardcodes the Afterburner Theme](../plans/standalone-theme-hardcoded-afterburner.md) — **PLAN REVIEWED**
- [ ] [Standalone Workspace-Selection Payload Is Seven Hardcoded Fields — Repo Scope and Project Context Are Dead](../plans/standalone-workspace-selection-fields-hardcoded.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

There are ordering constraints, and they matter more than usual here — the point of the sequence is that no subtask is ever declared done on a human's judgement.

1. **Standalone Push-Parity Guard** lands first. Everything after it is verified by lowering a baseline. It ships with a baseline capturing today's real gap so CI is green from the first commit; following the `check-push-routing.js` convention, the baseline may only ever be lowered, never raised.
2. **Restore the Backlog View** lands second. It installs the broadcaster bridge, which is shared infrastructure the whole class depends on — with no sink, every provider push stays dead no matter how correct the payload becomes. The routing-config subtask in particular only gets its immediate UI feedback once this lands.
3. **The five payload subtasks** (columns, routing config, CLI triggers, theme, workspace selection) have no dependencies on each other and can run in parallel — but all five rewrite lines inside the same two functions, `pushFullState` (`bootstrap.ts:341-346`) and `getFullState` (`:370-375`). Expect merge conflicts if they are developed simultaneously; either serialise them or assign them to one worktree.

The workspace-selection subtask is best done last of the five: it is the one that establishes the "no unexplained literals remain" invariant, which is easiest to assert once the others have cleared their fields.

**Out of scope, but linked:** `dispatcher-column-and-bounce-analysis.md` declares the backlog subtask as a hard prerequisite. Dispatch is implemented as a display mode on the Planned column and would inherit both defects verbatim, so it must not start until this feature's bridge is in place.
