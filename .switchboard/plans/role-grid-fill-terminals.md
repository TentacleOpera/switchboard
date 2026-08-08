# Role Grid Fill: Create a Grid-Full of Agent Terminals in One Action

> **Alternative approach.** This is a deliberate alternative to the linkup-based hidden-batch design (`hidden-terminal-create-and-provider-mix.md`, `plan-update-notifies-planner.md`, `improver-prompt-and-planner-lifecycle.md`). It reaches roughly the same outcome — many plans improved in parallel — by adding almost nothing, because the distribution machinery already exists. It can ship on its own, and it can ship *first* regardless of whether the linkup design is also built.

## Goal

Let a user pick a role and a grid size in the terminals interface and have Switchboard create as many terminals as the grid holds, so that a batch move of plans from Created to Planned fans out across them via the existing planner round-robin.

### The problem

Everything needed for parallel plan improvement already exists **except** a way to create the terminals quickly:

| Piece | State today |
| :--- | :--- |
| Multi-pane grid with known capacity | Exists. `LAYOUTS` in `src/webview/terminals.js:679-694` defines slot counts per mode — `2x2`→4, `1x3`/`2x3`→3/6, `3x3`→9. |
| A pool of same-role terminals | Exists. `getRoleTerminalSet(role, workspaceRoot)` returns `{ terminals, locationKey }`. |
| Round-robin distribution across that pool | Exists and is persistent. `getPlannerRotationCursor` / `advancePlannerRotationCursor` (`TaskViewerProvider.ts:5626-5644`) store the cursor in `globalState`, keyed by location so it is shared across workspaces serving the same terminals. |
| Per-plan fan-out on dispatch | Exists. The dispatch path picks `terminals[cursor % terminals.length]` and advances the cursor by 1 per successful dispatch (`TaskViewerProvider.ts:19490-19497`), so sequential moves continue the rotation rather than restarting at terminal 0. |
| Creating N terminals of one role | **Missing.** The new-agent menu adds one at a time. |

Filling a 3×3 grid with planners takes nine trips through the menu, which is why the capability goes unused at the scale it was built for.

### Root cause

Terminal creation is modelled as a single-item action, while the grid it feeds is modelled by capacity. The two were never connected — nothing translates "this layout holds 9" into "create 9."

### Why this is worth having even alongside the linkup design

It reuses the existing dispatch path end to end, which means no new completion signal, no new messaging transport, no new prompt contract, and no hidden-terminal semantics. The terminals are ordinary, visible, and inspectable — a worker that stalls or asks a question is *seen*, which is the observability the hidden-batch design has to reconstruct. Its cost is that it does not scale past the grid and does not mix providers (see Limitations).

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, feature

## Reconcile Before Building

1. Confirm the batch move of multiple cards Created → Planned actually iterates the per-plan dispatch path at `TaskViewerProvider.ts:19470-19500` (the path that advances the rotation cursor once per dispatch), rather than dispatching once for the whole selection. **The entire value of this plan rests on that.** If a batch move dispatches once, the fan-out must be fixed there and this plan grows.
2. Check for unpushed local work touching the terminals grid or the new-agent menu before editing either.

## Design

### The action

In the terminals interface, alongside the existing new-agent menu, add a "Fill grid" action taking:

- **Role** — from the same role list the new-agent menu uses.
- **Grid size** — the existing layout modes, labelled by capacity ("2×2 — 4 agents", "3×3 — 9 agents"). Read the count from `LAYOUTS[mode].slots`; do not hardcode a second copy of those numbers.

On confirm: switch the layout to the chosen mode and create `slots − (existing terminals of that role in this location)` new terminals.

### Relationship to groups

Do **not** persist a saved group here. Under the sidebar rework (`terminals-sidebar-groups-and-grids-ia.md`), groups are derived from role rather than snapshotted, so filling a 3×3 with planners causes the "Planners" group to exist automatically — no save step, and the batch is recallable in one click for free.

If that plan has not landed yet, this one still ships standalone: the fill seats the panes and the user can save a group by hand exactly as today. Do not build a bespoke persistence path here that the derived-group work would then have to unpick.

### Reuse the existing creation path

Call the same code path the new-agent menu already uses, once per terminal. Do not fork a bulk-creation path — role resolution, startup-command injection, registry updates, and naming all live there, and a parallel implementation will drift from it.

Create sequentially rather than all at once. `PtyFleetService.injectStartupCommand` waits `SHELL_READINESS_DELAY_MS` (750ms) then **types** the startup command via `sendText`; nine concurrent shells racing that same typed-injection path is the most likely source of a garbled or missing startup command. Sequential creation with the existing per-terminal delay is slower to finish and far more likely to be correct.

Show progress while it runs — nine sequential creations with a readiness delay each is several seconds of apparent hang otherwise.

### Top up, do not duplicate

Filling a grid that already holds terminals of that role should create only the difference. Re-running "Fill 3×3 with planner" when nine planners already exist must be a no-op, not eighteen planners. Count existing terminals via `getRoleTerminalSet(role, workspaceRoot)` so the count matches exactly the pool the round-robin will later distribute across — counting by any other means risks creating terminals that the rotation does not see.

Never destroy or replace existing terminals to make room; if the chosen grid is smaller than the current pool, create nothing and say so.

### Naming

N same-role terminals need distinct, stable names that `_isValidAgentName` accepts and `_stripIdeSuffix` handles unchanged, and that `getRoleTerminalSet` still collects into one pool. Follow whatever suffixing the existing single-add path already produces for a second terminal of the same role rather than inventing a scheme — the pool membership test is what the round-robin depends on, and a name shape it does not recognise silently produces a pool of one.

### Rotation-cursor interaction

The cursor is stored per `locationKey`, and `getRoleTerminalSet` derives that key from the workspace path (falling back to a name signature only for mixed-worktree sets). Growing the pool therefore keeps the same key while changing `terminals.length`, so a cursor left over from a smaller pool still resolves via `cursor % length`. No migration is needed and no reset should be added — an arbitrary starting offset is harmless in a round-robin, whereas resetting to 0 on every fill would over-load the first terminal for users who fill repeatedly.

### No confirmation dialog

Per the project's standing rule, this action must not gate on `confirm()` — `window.confirm()` is a silent no-op in VS Code webviews and would make the button do nothing at all. Show the count in the action itself ("Create 7 planner agents") so the effect is legible before the click.

## Limitations (state these plainly in the UI or docs)

- **Capped by grid capacity.** The largest layout is `3x3` = 9 slots, so this tops out at 9 concurrent agents. Twenty plans across nine planners is three passes, not one.
- **Single role per fill, and therefore a single provider.** The round-robin resolves a pool with `getRoleTerminalSet('planner', ...)` — one role. Because `startupCommands` is keyed by role, two providers means two roles, which means two pools, and the existing rotation will distribute across only one of them. **Mixed-provider batches (e.g. 10 Claude + 10 Devin) do not come for free here** — that is the specific capability the linkup design buys and this one does not. Filling a grid with a mix of roles is possible, but distribution across the mix is not.
- **Every agent is visible and occupies a pane.** That is the point — but it means these terminals compete for the interface with whatever else the user is doing.
- **No completion signal, no auto-kill.** Terminals persist after their plan is improved; the user closes them. Acceptable at grid scale, where they are all on screen.

## Verification Plan

1. **Unit — slot count is sourced, not duplicated.** Assert the fill count derives from `LAYOUTS[mode].slots`; assert no second hardcoded slot table exists.
2. **Unit — top up.** With 3 planners present, "fill 3×3" creates exactly 6. Re-running creates 0.
3. **Unit — smaller grid.** With 9 planners present, "fill 2×2" creates 0 and destroys nothing.
4. **Unit — pool membership.** After filling, assert `getRoleTerminalSet(role, workspaceRoot)` returns all created terminals in one pool — this is the test that catches a bad naming scheme.
5. **Unit — reuses single-add path.** Assert fill calls the existing creation function once per terminal rather than a forked bulk implementation.
6. **Unit — sequential creation.** Assert creations are serialized, not issued concurrently, so each startup-command injection gets its readiness window.
7. **Unit — cursor survives growth.** Set the cursor to 7, grow the pool from 3 to 9, assert dispatch resolves via modulo without reset or error.
8. **Unit — no confirm gate.** Static assertion that the action introduces no `confirm(` / `window.confirm(` call, matching the existing confirm-gate regression tests.
9. **Integration — fan-out.** With 4 planners and a batch move of 8 plans Created → Planned, assert each planner receives exactly 2 dispatches and the cursor advances 8 times.
10. **Integration — concurrent writes.** Those 8 improvements against 8 plan files in one shared directory: assert all files are well-formed and none contains another's content.
11. **Manual (VSIX).** Fill a 3×3 grid with planners, confirm all 9 panes hold a live agent with its startup command correctly injected, then batch-move 9 plans and confirm each pane receives one.

## Dependencies

None. Ships standalone and depends on no unpushed work — unlike the linkup design, which assumes a transport that is not yet in this branch.
