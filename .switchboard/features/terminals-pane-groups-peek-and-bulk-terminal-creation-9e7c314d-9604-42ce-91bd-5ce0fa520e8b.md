# Terminals Pane: Groups, Peek, and Bulk Terminal Creation

**Complexity:** 7

## Goal

Make the terminals pane cheap to arrange, cheap to inspect, and cheap to fill.

Today every way to change what you are looking at mutates persisted state: composing a view costs one click per terminal, looking closely at one agent destroys the arrangement, and filling a 3x3 grid with planners means nine trips through the new-agent menu. Each subtask removes one of those costs without taking free composition away.

The through-line is separating what the user picked from what is currently rendered, so temporary and derived views stop being indistinguishable from deliberate ones.

## How the Subtasks Achieve This

- **Terminals Sidebar: Logical Groups That Lock the View**: Recasts groups from frozen snapshots of the composer's output ("all planners" costs nine seated panes to capture, and membership is a list of friendly names that silently loses a terminal when it is recreated) into logical sets that cost nothing to create and repair themselves. Also makes the sidebar a hierarchy rather than a mode toggle, so reaching a terminal no longer means leaving the groups. Free composition is unchanged whenever no group is locked.
- **Terminal Peek: Temporary Full-Pane View That Restores Exactly**: Adds the missing cheap gesture for "read this one agent for ten seconds, then go back." Today the only ways to make a terminal big — composing a 1-pane layout, or solo/pop-out — either mutate persisted `currentLayout`/`paneAssignments` or leave the window entirely. Peek renders over the arrangement and restores it untouched, with pins and scrollback intact.
- **Role Grid Fill: Create a Grid-Full of Agent Terminals in One Action**: Connects the two things the codebase already models separately — a layout that knows it holds 9, and terminal creation that is only ever reached one role at a time. Picking a role plus a grid size creates the whole grid in one action, generalising the top-up loop `openAllTerminals` already runs for `agents.plannerTerminalCount`, and driving the count from `LAYOUTS[mode].slots` instead of a hand-typed number.

  > **Superseded:** "Every other piece of that fan-out (role terminal sets, the persistent rotation cursor, per-plan dispatch) already exists."
  > **Reason:** Those pieces exist for **VS Code** terminals only. `getRoleTerminalSet` resolves the pool through `_getAliveAutobanTerminalRegistry`, whose liveness test PTY (terminals-pane) rows cannot pass — `TaskViewerProvider.ts:8389-8393` states it outright. A grid full of pane planners resolves to an empty pool, so the batch move takes the single-dispatch fallback and every plan lands on one agent.
  > **Replaced with:** The fan-out gap is now its own subtask (below). Role Grid Fill is the creation gesture; Planner Fan-Out is what makes the created grid mean anything.

- **Planner Fan-Out: Make the Round-Robin See the Terminals-Pane Fleet**: Closes the gap the audit above found. Widens the pool resolver so a `purpose:'pty'` registry row counts as alive on its own `status` — gated on the same `apiOriginated` flag that already decides delivery, so the shipped VS Code path is byte-identical and the fix works in both the extension and standalone hosts. Also fixes the status message that reports "Distributed N plan(s)" even when every dispatch bucket rejected, which only became reachable once the pool could be non-empty.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Role Grid Fill: Create a Grid-Full of Agent Terminals in One Action](../plans/role-grid-fill-terminals.md) — **PLAN REVIEWED**
- [ ] [Terminal Peek: Temporary Full-Pane View That Restores Exactly](../plans/terminal-peek-temporary-fullscreen.md) — **PLAN REVIEWED**
- [ ] [Terminals Sidebar: Logical Groups That Lock the View](../plans/terminals-sidebar-groups-and-grids-ia.md) — **PLAN REVIEWED**
- [ ] [Planner Fan-Out: Make the Round-Robin See the Terminals-Pane Fleet](../plans/planner-fanout-pty-fleet-awareness.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No cross-feature dependencies. Two streams, and they parallelise cleanly because they touch disjoint files.

**Stream A — webview (`src/webview/terminals.js`, `terminals.html`, `shell.js`).** Strictly serial. The project PRD's orchestration rule is one agent stream per file, and all three of these subtasks edit `terminals.js`.

1. **Terminals Sidebar: Logical Groups That Lock the View** — first. It defines the lock state Peek must restore back into, the sidebar row action ordering Peek inserts a control into, and the derived-group model that makes a role-filled grid recallable for free. It also owns the shipped-state migration for `terminals.groups`, which nothing else should touch.
2. **Terminal Peek: Temporary Full-Pane View That Restores Exactly** — second. Places its control into the row layout Groups defines, reads lock state without writing it, and is the only subtask that also edits `shell.js`. If it must land first, Groups has to preserve its control placement.
3. **Role Grid Fill: Create a Grid-Full of Agent Terminals in One Action** — any time within the stream. It only extracts and generalises `openAllTerminals`; nothing else depends on it.

**Stream B — providers (`src/services/TaskViewerProvider.ts`, `KanbanProvider.ts`).**

4. **Planner Fan-Out: Make the Round-Robin See the Terminals-Pane Fleet** — independent of stream A and runnable in parallel with it. One stream for both provider files (same PRD rule); they must not be split across two agents.

**The one real ordering constraint is across the streams:** Role Grid Fill must not ship *before* Planner Fan-Out. On its own it produces nine visible planners of which one does the work — a feature that looks like fan-out and is not, which is worse than shipping nothing. Planner Fan-Out has no such constraint in the other direction: it improves distribution for any pane planner pool, however it was created.

**Prerequisites and guards.**

- Every one of these files carries uncommitted local work as of 2026-08-08, and line references in the earlier drafts had drifted by 100-200 lines. Re-grep symbols before editing; do not trust a line number.
- Two shipped static contract tests must be **rewritten, not deleted**: `src/test/terminal-sidebar-groupings-contract.test.js` (Groups removes every symbol it asserts) and `src/test/shell-terminal-strip.test.js` (Peek changes the strip click). `src/test/terminal-solo-popout-contract.test.js` must pass unmodified.
- `terminals.groups` is **unreleased dev state** — it first appears at commit `1c7de0f6` (2026-08-06), after the last released VSIX (`1.7.12`, 2026-07-12). It takes a clean break, not a migration. Groups owns the store's shape; no other subtask may change it.

**Relationship to the batch-improvement feature.** Role Grid Fill is positioned as a cheaper substitute for the *Unattended Batch Plan Improvement* feature (feature `8ab67e5d`): it reaches roughly the same outcome — many plans improved in parallel — with far less machinery. That framing survives the fan-out finding, but the cost is now honest: it needs the pool-resolution fix, not zero backend work. Decide between the two paths before starting the batch feature, not after.
