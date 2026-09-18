# Role Grid Fill: Create a Grid-Full of Agent Terminals in One Action

> **Alternative approach.** This is a deliberate alternative to the linkup-based hidden-batch design (`hidden-terminal-create-and-provider-mix.md`, `plan-update-notifies-planner.md`, `improver-prompt-and-planner-lifecycle.md`). It reaches roughly the same outcome — many plans improved in parallel — by adding almost nothing, because the distribution machinery already exists. It can ship on its own, and it can ship *first* regardless of whether the linkup design is also built.

## Goal

Let a user pick a role and a grid size in the terminals interface and have Switchboard create as many terminals as the grid holds, so that a batch move of plans from Created to Planned fans out across them via the planner round-robin.

### The problem

Filling a 3×3 grid with planners takes nine trips through the role picker, which is why the capability goes unused at the scale it was built for. Terminal creation is modelled as a single-item action, while the grid it feeds is modelled by capacity — nothing translates "this layout holds 9" into "create 9."

### What already exists (verified against the working tree, 2026-08-08)

| Piece | State today |
| :--- | :--- |
| Multi-pane grid with known capacity | Exists. `LAYOUTS` in `src/webview/terminals.js:690-700` defines slot counts per mode — `2x2`→4, `1x3`/`2x3`→3/6, `3x3`→9. |
| A role picker with visibility + CLI-configured labelling | Exists. `#role-picker` (`terminals.html:1398-1401`), populated by `onNewTerminalClicked` (`terminals.js:3598`) from `fetchPtyVisibleRoles()`. |
| Bulk, top-up-only, sequential terminal creation | Exists. `openAllTerminals()` (`terminals.js:3768-3810`). |
| Creating **N terminals of one role** | Exists, but only for `planner`, and only via a global setting. |
| Seating the newly created terminals | Exists. `fillEmptyPanes()` (`terminals.js:3819`). |
| Switching the grid to a chosen layout | Exists. `setLayoutMode(mode)` (`terminals.js:1727`). |

> **Superseded:** "Creating N terminals of one role — **Missing.** The new-agent menu adds one at a time."
> **Reason:** `openAllTerminals()` already creates N terminals of a role. `resolveGridAgents()` (`terminals.js:3724-3758`) reads `agents.plannerTerminalCount` — a shipped setting with a select control on the Agents tab (`kanban.html:4145`, `8506`) and a server-side reader (`TaskViewerProvider.getPlannerTerminalCount`, line 5624) — and sets `wanted.set('planner', plannerCount)`. The creation loop (3782-3805) then tops up to that count, sequentially, one `ptyCreateTerminal` POST at a time. Every mechanism this plan proposed to build already exists; what is missing is narrower.
> **Replaced with:** What is missing is (a) choosing **which role** and **how many** at the point of use, instead of a global planner-only setting applied through a button that also opens one of every other visible role, and (b) deriving the count from **grid capacity** rather than a hand-typed number. This plan builds those two things by generalising `openAllTerminals`'s per-role top-up loop — it does not build bulk creation, which is already here.

### Root cause

`openAllTerminals` is shaped around "one of everything, plus N planners" because it is the browser counterpart of `switchboard.createAgentGrid`, which opens the standard agent set. There is no shape for "N of *this* role," and no connection between the layout picker's capacity and the creation path.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, feature

## User Review Required

None.

## Reconcile Before Building

1. **`src/webview/terminals.js` and `terminals.html` carry uncommitted local changes** as of 2026-08-08, and this plan's earlier line references had drifted by 100-200 lines. Re-grep `LAYOUTS`, `openAllTerminals`, `resolveGridAgents`, `fillEmptyPanes`, `setLayoutMode` and `onNewTerminalClicked` before editing.
2. **Two sibling subtasks edit the same file** (Terminals Sidebar Groups, Terminal Peek). Per the project PRD's one-stream-per-file rule, do not code this in parallel with either of them in a separate worktree.

> **Superseded (reconcile item):** "Confirm the batch move of multiple cards Created → Planned actually iterates the per-plan dispatch path at `TaskViewerProvider.ts:19470-19500` … **The entire value of this plan rests on that.** If a batch move dispatches once, the fan-out must be fixed there and this plan grows."
> **Reason:** Checked, and the answer is worse than "dispatches once" — the fan-out cannot see these terminals at all. A batch move takes `KanbanProvider._distributePlannerDispatch` (line 5664), which calls `getRoleTerminalSet('planner', …)`. That helper enumerates `_getAliveAutobanTerminalRegistry`, whose liveness test matches against `vscode.window.terminals` or a heartbeat gated on `ideName` — and PTY fleet rows carry `ideName: 'switchboard-pty'`, which matches nothing. `TaskViewerProvider.ts:8389-8393` states it outright: "`_getAliveAutobanTerminalRegistry` cannot supply one — it keeps a row only on a VS Code pid/name match or a heartbeat, and PTY rows have none of those." So a grid full of terminals-pane planners yields `terminals.length === 0`, the no-live-terminals fallback branch runs, and every plan is sent to a **single** terminal.
> **Replaced with:** That defect is now its own subtask — **`planner-fanout-pty-fleet-awareness.md`** — because it is backend work in different files (`TaskViewerProvider.ts`, `KanbanProvider.ts`) with its own verification surface, and because it is independently valuable: it fixes fan-out for any number of terminals-pane planners, however they were created. This plan stays what it always was — the cheap creation gesture — and now carries a hard dependency on that one for its stated outcome.

## Design

### The action

In the terminals interface, alongside the existing role picker, add a **"Fill grid"** action taking:

- **Role** — from the same list the role picker builds (`onNewTerminalClicked`, lines 3605-3651): `fetchPtyVisibleRoles()` filtered by visibility, minus `SYSTEM_ROLES`, sorted by `roleOrderMap`, labelled via `BUILT_IN_AGENT_LABELS`, with the "no agent CLI configured (plain shell)" hint carried through from `hasCommand`. Reuse that builder rather than writing a second role list.
- **Grid size** — the existing layout modes, labelled by capacity ("2×2 — 4 agents", "3×3 — 9 agents"). Read the count from `LAYOUTS[mode].slots`; do not hardcode a second copy of those numbers.

On confirm: switch the layout via `setLayoutMode(mode)` (which already re-renders and applies the floor) followed by `saveLayoutSettings()`, matching the layout picker's own handler (lines 517-523), then create `slots − (live terminals of that role)` new terminals and call `fillEmptyPanes()`.

### Generalise `openAllTerminals`, do not fork it

Factor the creation loop out of `openAllTerminals` into a `createTerminalsForRole(role, count, hasStartupCommand)` that both callers use. That loop already carries three decisions worth keeping verbatim:

1. **Sequential, not `Promise.all`.** Its own comment (lines 3784-3786): "`ptyFleetService.create()` picks the next free `${role}-${n}` name off its own map, so concurrent creates for the same role can settle on the same name." Nine concurrent creates is a name collision, not just a startup-command race.
2. **Startup commands are not sent from the webview.** "`ptyFleetService.create()` injects the role's configured command itself, and duplicating that would launch each agent CLI twice" (3765-3766). `injectStartupCommand` waits `SHELL_READINESS_DELAY_MS` (750ms, `ptyFleetService.ts:7`) then types the command; the sequential loop is what gives each shell that window uncontested.
3. **Arm the startup curtain per created terminal** with `hasCommand[role]`, before the list refetch (3798) — the curtain must be armed before the pane exists or it paints a reconcile late.

Do not fork a bulk-creation path. Role resolution, startup-command injection, registry updates, and naming all live behind `ptyCreateTerminal`, and a parallel implementation will drift from it.

### Top up, do not duplicate

Filling a grid that already holds terminals of that role should create only the difference. Re-running "Fill 3×3 with planner" when nine planners already exist must be a no-op, not eighteen planners.

> **Superseded:** "Count existing terminals via `getRoleTerminalSet(role, workspaceRoot)` so the count matches exactly the pool the round-robin will later distribute across — counting by any other means risks creating terminals that the rotation does not see."
> **Reason:** `getRoleTerminalSet` is a TypeScript method on `TaskViewerProvider` (line 5645) with no HTTP verb; the webview cannot call it. And it would be the wrong oracle even if it could — as established above, it cannot see PTY terminals at all, so it would return 0 every time and the fill would duplicate the entire pool on every press.
> **Replaced with:** Count from `fleetList`, exactly as `openAllTerminals` does (lines 3775-3779): live rows (`status !== 'exited'`) grouped by `role`. That is the same list the sidebar and the panes render from, so the count the user sees and the count the fill uses are the same number by construction. Making the *dispatch* pool agree with that list is the job of `planner-fanout-pty-fleet-awareness.md`.

Never destroy or replace existing terminals to make room; if the chosen grid is smaller than the current pool, create nothing and say so.

### Naming

Names come from `ptyFleetService.create()`, which assigns the next free `${role}-${n}` off its own map — there is no scheme to invent and nothing for the webview to pass. `_isValidAgentName` and `_stripIdeSuffix` already handle that shape, and the sidebar's `terminalNameSuffix` comparator (line 1411) already orders on the trailing `-N`. The one requirement is the sequential loop above, which is what keeps `n` from colliding.

### Progress and feedback

Nine sequential creations with a 750ms readiness delay each is several seconds of apparent hang. `#btn-open-all`'s handler already solves this (lines 531-545): disable the button, swap its label, restore in a `finally`. Reuse that idiom, and show the live count ("Opening 4 of 7…") since this action's duration scales with the grid.

### Relationship to groups

Do **not** persist a saved group here. Under the sidebar rework (`terminals-sidebar-groups-and-grids-ia.md`), groups are derived from role rather than snapshotted, so filling a 3×3 with planners causes the "Planners" group to exist automatically — no save step, and the batch is recallable in one click for free.

If that plan has not landed yet, this one still ships standalone: the fill seats the panes and the user can save a group by hand exactly as today. Do not build a bespoke persistence path here that the derived-group work would then have to unpick.

### No confirmation dialog

Per the project's standing rule, this action must not gate on `confirm()` — `window.confirm()` is a silent no-op in VS Code webviews and would make the button do nothing at all. Show the count in the action itself ("Create 7 planner agents") so the effect is legible before the click.

## Limitations (state these plainly in the UI or docs)

- **Capped by grid capacity.** The largest layout is `3x3` = 9 slots, so this tops out at 9 concurrent agents. Twenty plans across nine planners is three passes, not one.
- **On a small screen, fewer will be visible than were created.** `3x3` requires 750×450 (`LAYOUTS`, line 699) and `applyLayoutFloor` reduces the rendered pane count below that, so a laptop may show two of the nine. The terminals all exist and all receive dispatches — this is a visibility limit, not a fan-out limit. Label the grid choice by capacity and let the floor do its job; do not suppress or bypass the floor to honour the requested grid, which would produce exactly the unreadable grid it exists to prevent. Choosing *which* of them stay visible is the group-ordering concern in `terminals-sidebar-groups-and-grids-ia.md`.
- **Single role per fill, and therefore a single provider.** The round-robin resolves a pool with `getRoleTerminalSet('planner', …)` — one role. Because `startupCommands` is keyed by role, two providers means two roles, which means two pools, and the rotation will distribute across only one of them. **Mixed-provider batches (e.g. 10 Claude + 10 Devin) do not come for free here** — that is the specific capability the linkup design buys and this one does not. Filling a grid with a mix of roles is possible, but distribution across the mix is not.
- **Every agent is visible and occupies a pane.** That is the point — but it means these terminals compete for the interface with whatever else the user is doing.
- **No completion signal, no auto-kill.** Terminals persist after their plan is improved; the user closes them. Acceptable at grid scale, where they are all on screen.
- **Only planner fans out.** The rotation cursor and `_distributePlannerDispatch` are planner-specific. Filling a grid with coders creates nine coders; a batch move to a coder column does not round-robin across them. Say so, or the action promises something the board does not deliver.

## Complexity Audit

### Routine

- Extracting `createTerminalsForRole` from `openAllTerminals` and calling it from both places.
- Reusing the existing role-picker builder, `LAYOUTS[mode].slots`, `setLayoutMode`, `fillEmptyPanes`, and the `#btn-open-all` progress idiom.
- Counting live role instances from `fleetList`.

### Complex / Risky

- **None architecturally.** The one real hazard is regressing `openAllTerminals` during the extraction — its three embedded decisions (sequential creation, no webview-side startup command, curtain armed before refetch) are each load-bearing and each documented in-place. Extract by moving the loop, not by rewriting it.

## Edge-Case & Dependency Audit

### Race Conditions

- Concurrent creates for one role collide on `${role}-${n}`. The sequential loop is the mitigation and must survive the extraction.
- `fleetList` is refreshed by a poll timer and by `terminalsChanged` pushes. Compute the top-up count once at click time; a refresh mid-loop must not re-derive and extend it.
- Double-clicking the action must not start two loops — the disable-during-run idiom covers it.

### Security

- Role comes from `fetchPtyVisibleRoles()`, i.e. the server's own list, not free text. Keep it that way; do not accept a typed role.
- Grid mode must be validated against `LAYOUT_MODES` before reaching `setLayoutMode` (which already guards) and before indexing `LAYOUTS`.

### Side Effects

- `setLayoutMode` writes `currentLayout` and persists it — a fill deliberately changes the user's layout. That is the asked-for behaviour; do not try to make it transient.
- `fillEmptyPanes` seats into empty, non-kanban slots only and never displaces (lines 3827-3836). Preserve that.
- Creating nine agent CLIs starts nine processes; there is no cap beyond grid capacity and no auto-cleanup.

### Dependencies & Conflicts

- Shares `src/webview/terminals.js` with both sibling webview subtasks — serialise.
- Depends on `planner-fanout-pty-fleet-awareness.md` for its stated outcome (see below).

## Dependencies

> **Superseded:** "None. Ships standalone and depends on no unpushed work."
> **Reason:** The action ships and works standalone — it creates the terminals and seats them. But its *stated goal* ("so that a batch move of plans from Created to Planned fans out across them") is not reached without the PTY-awareness fix, because the planner round-robin cannot currently see terminals-pane terminals at all. Shipping this alone produces nine visible planners and one working one, which is worse than no feature: it looks like fan-out and is not.
> **Replaced with:** Hard dependency below.

- **`planner-fanout-pty-fleet-awareness.md`** — must land **before or with** this plan. Without it, a grid full of planners receives a single bundled dispatch. This plan's own verification item 9 cannot pass until it does.
- **`terminals-sidebar-groups-and-grids-ia.md`** — soft, and only for file serialisation. Derived groups make the filled grid recallable for free; this plan does not require them.

## Adversarial Synthesis

Key risks: shipping the creation gesture without the fan-out fix, which produces a grid of planners where only one works and reads as a broken feature; regressing `openAllTerminals` during the loop extraction (sequential creation, no duplicate startup command, curtain armed pre-refetch are all load-bearing and all documented in place); and counting existing terminals from the wrong source, which turns a top-up into a fleet doubling on every press. Mitigations: the hard dependency above, extract-by-moving rather than rewriting, and count from `fleetList` — the same list the UI renders.

## Proposed Changes

### `src/webview/terminals.js`

- **Context:** `LAYOUTS` (690), `setLayoutMode` (1727), `onNewTerminalClicked` (3598), `createTerminal` (3656), `resolveGridAgents` (3724), `openAllTerminals` (3768), `fillEmptyPanes` (3819), the `#btn-open-all` handler (531-545).
- **Logic:** Extract `createTerminalsForRole(role, count, hasStartupCommand)`; add a fill action that resolves role + mode, computes `LAYOUTS[mode].slots − liveCount(role)`, switches the layout, runs the loop, and seats.
- **Implementation:** Reuse the role-picker builder for the role list; add a capacity-labelled mode list; drive progress through the existing disable/label idiom.
- **Edge cases:** Count ≤ 0 (create nothing, say so); role with no configured CLI (allowed, labelled as a plain shell); a create rejected mid-loop (log and continue, matching `openAllTerminals`); double-click.

### `src/webview/terminals.html`

- **Context:** `#role-picker` markup and styling (1398-1401, CSS 185-244), the sidebar ops block around `#btn-open-all` (1408).
- **Logic:** A fill entry point and a grid-size choice, styled as a peer of the existing picker rather than a new visual idiom.

## Verification Plan

### Automated Tests

1. **Unit — slot count is sourced, not duplicated.** Assert the fill count derives from `LAYOUTS[mode].slots`; assert no second hardcoded slot table exists.
2. **Unit — top up.** With 3 planners present, "fill 3×3" creates exactly 6. Re-running creates 0.
3. **Unit — smaller grid.** With 9 planners present, "fill 2×2" creates 0 and destroys nothing.
4. **Unit — counted from `fleetList`.** Assert the existing-count is derived from live (`status !== 'exited'`) `fleetList` rows grouped by role — the same source `openAllTerminals` uses — and that no path calls or emulates `getRoleTerminalSet` from the webview.
5. **Unit — one creation path.** Assert the fill and `openAllTerminals` both call the extracted `createTerminalsForRole`, and that `openAllTerminals`'s behaviour is otherwise unchanged.
6. **Unit — sequential creation.** Assert creations are serialized, not issued concurrently, so each `ptyCreateTerminal` gets a clean `${role}-${n}` and each startup-command injection gets its readiness window.
6b. **Unit — no webview-side startup command.** Assert the fill sends no startup command itself (regression on the duplicate-CLI-launch note at 3765-3766).
6c. **Unit — curtain armed before the refetch.** Assert `armStartupCurtain` is called per created terminal before `fetchTerminalList`, matching the existing ordering.
7. **Unit — layout switch.** Assert the fill calls `setLayoutMode(mode)` with a mode validated against `LAYOUT_MODES`, then persists — it does not write `currentLayout` or `effectiveLayout` directly.
8. **Unit — no confirm gate.** Static assertion that the action introduces no `confirm(` / `window.confirm(` call, matching the existing confirm-gate regression tests.
9. **Integration — fan-out (requires `planner-fanout-pty-fleet-awareness.md`).** With 4 terminals-pane planners and a batch move of 8 plans Created → Planned, assert the dispatch is partitioned across all 4 terminals. Exact bucket semantics and cursor accounting are specified and tested in that plan; this item asserts only that a grid produced by "Fill grid" is the pool that gets partitioned.
10. **Integration — concurrent writes.** Those 8 improvements against 8 plan files in one shared directory: assert all files are well-formed and none contains another's content.
11. **Manual (VSIX).** Fill a 3×3 grid with planners, confirm all 9 panes hold a live agent with its startup command correctly injected exactly once, then batch-move 9 plans and confirm the work is spread across the panes rather than landing in one.

## Recommendation

Complexity 3 — **Send to Intern.** Ship it after (or alongside) `planner-fanout-pty-fleet-awareness.md`; on its own it creates terminals that the board cannot distribute across.

## Review Findings

Reviewer pass found one material defect: the extraction of `createTerminalsForRole` dropped open-all's per-terminal `fillEmptyPanes({ persist: false })`, so the whole batch landed seconds later instead of each terminal appearing as it was born — the plan required extracting by moving the loop, not rewriting it. Restored via an `onCreated` hook invoked after `armStartupCurtain`, preserving the arm-before-seat ordering. Two contract tests (`terminal-open-all-seating`, `multi-parent-terminals`) were red because the target-free `ptyCreateTerminal` payload and the curtain ordering had moved into the shared helper; their assertions were retargeted at the helper rather than dropped, and new assertions were added for sequential creation, no webview-side startup command, `LAYOUTS[mode].slots` sourcing, `LAYOUT_MODES` validation, fleetList-derived top-up, and no confirm gate. Files: `src/webview/terminals.js`, `terminals.html`, `src/test/terminal-open-all-seating-contract.test.js`, `src/test/multi-parent-terminals-contract.test.js`. Validation: open-all 12/12, multi-parent 29/29, `tsc` clean. Remaining risk: the progress affordance is a static "FILLING…" rather than the planned live "Opening 4 of 7…" count, and integration items 9–11 (real fan-out across a filled grid) remain manual-VSIX.
