# Send the Dispatch Set to Coders, with Terminal Provisioning

## Metadata

**Complexity:** 2
**Tags:** feature, ui
**Project:** Browser Switchboard

## Goal

Give the Dispatch view a **Send all to coders** button that fans the staged plans out to coder terminals in one press, plus a terminal count control so you can size the coder fleet to the batch before you press it.

The Dispatch view header shows the two numbers that matter — `10 plans · 3 coder terminals` — with a stepper to create more. Press Send and every plan in Dispatch dispatches to its complexity-routed coder column.

### Problem

After Analyze stages the parallel-safe set (companion plan), you drag each plan to a coder terminal by hand. Tedious when the set is large. And terminal count is a pre-configured constraint rather than something sized to the batch, so 10 safe plans with 3 terminals leaves 7 idle — the parallelism the analysis just proved is available goes unused.

### Root Cause

There is no fan-out action on the Dispatch set, and no place in the UI where the plan count and the terminal count are visible together — so the mismatch that wastes the parallelism is never surfaced at the moment you'd act on it.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Trigger | A **Send all to coders** button in the Dispatch view | A deliberate second press, after you've looked at what Analyze staged. See the reversal note below. |
| Who does the sending | Extension code, no agent | Counting terminals, creating terminals, and calling dispatch per plan involves no reasoning. An agent would need HTTP endpoints to reach in-process functions the button already has. |
| Shortfall handling | Show `N plans · M coder terminals` with a stepper to create more | Surfaces the mismatch without asking a question. Consistent with the codebase's no-dialogs rule: buttons act, state is visible. |
| Dispatch mechanism | The existing per-plan dispatch path, `targetColumn: "auto"` | Already does plan resolution, complexity routing (`resolveAutoDispatchColumn`, `KanbanProvider.ts:7225`), card move, terminal dispatch, and DB-verified results. |
| Terminal creation | `addAutobanTerminalFromKanban()` (`TaskViewerProvider.ts:9669`) | Wraps `_createAutobanTerminal()` (`:8930-9009`) — pool validation, name collision detection (`:8957`), the `MAX_AUTOBAN_TERMINALS_PER_ROLE` cap (`:8951`), pool registration (`:8999`). Coder is a pool role. Do not copy `startOrchestratorFromKanban`, which bypasses all of that because `orchestrator` is not a pool role (`:9319`). |
| Terminal counting | Alive coder terminals via `_getAliveAutobanTerminalNames()` | There is no "busy" concept — `sendCounts` is cumulative dispatch counts, not active processing. Alive is an upper bound, and it's the number worth showing. |
| Failure handling | Failed plans stay in Dispatch, reported in the result | No silent loss; retry is another press. |

> **Reversal — worth flagging.** The original ask was "stop the turn and offer to create a number of terminals and send to them," with an agent staying alive, printing an offer, and waiting for a typed reply. That shape existed because sending was bolted onto the end of the Analyze run — there was a turn to stop. Once Send is its own button, there's no turn, and the offer-and-wait becomes a dialog for information the UI can just display. The stepper replaces it. If the typed-offer flow is still wanted, it needs the agent, the interactive-wait lifecycle, and the three HTTP endpoints back.

> **Superseded:** A board toolbar auto-send toggle, default-off.
> **Reason:** A button you press is its own opt-in. A toggle that makes a *different* button do more is a hidden mode.

> **Superseded:** `GET /kanban/dispatch-auto-send`, `GET /kanban/dispatch/terminal-count`, `POST /kanban/dispatch/create-terminals`.
> **Reason:** These existed so an agent could reach extension functions over localhost. With the button in the webview, it's a verb to in-process code.

## User Review Required

None.

## Complexity Audit

### Routine
- The Send button and the count display in the Dispatch view header.
- The stepper, wired to the existing `addAutobanTerminalFromKanban()`.
- A `sendDispatchSetToCoders` verb and its handler looping the existing dispatch path.

### Complex / Risky
- **Alive ≠ idle.** A terminal mid-plan counts as available, so the displayed count is an upper bound and Send can over-dispatch onto a busy terminal. This is the same behaviour every existing dispatch path has; do not invent a busy-tracking mechanism for it.
- **Terminal creation is extension-host-only.** `addAutobanTerminalFromKanban()` needs the host terminal backend. In standalone, gate the stepper on the same capability flag the companion plan uses for Analyze — disabled, never a dead click (PRD contract #6).
- **Partial failure is the normal case, not the edge case.** With 10 plans and a cap-limited pool, some sends will fail. The result must report per-plan outcomes, not a single success boolean.

## Edge-Case & Dependency Audit

**Races**
- A terminal exits between the count display and the press: the dispatch path already returns a per-plan failure rather than throwing. Report it; the plan stays in Dispatch.
- A plan leaves Dispatch between render and press: re-read the Dispatch set inside the handler rather than trusting the webview's card list.

**Side Effects**
- Created terminals persist after the send and stay in the coder pool.
- Card moves trigger the usual feature→subtask cascade and Linear/ClickUp sync fan-out.
- Each dispatch triggers a board refresh, which is also the visual feedback — cards move as they go. No custom feedback code.

**Dependencies**
- **Hard:** `dispatcher-column-and-bounce-analysis.md` — provides the Dispatch view, its header, and the capability gating this plan reuses.

## Proposed Changes

### `src/webview/kanban.html` — Dispatch view header controls

**Logic:** When `showingDispatch` is active, the column header shows `N plans · M coder terminals`, a stepper (`+` / `−`) that creates or removes coder terminals, and a **Send all to coders** button. `M` comes from the board state payload and updates on refresh.

**Implementation:** Extend the Dispatch-view button set the companion plan adds (its step 2). The stepper's `+` posts `{ type: 'addAutobanTerminal', role: 'coder' }` — an existing verb. Send posts `{ type: 'sendDispatchSetToCoders', workspaceRoot }`.

**Edge Cases:** Send is disabled when the Dispatch set is empty, and when the host reports no terminal capability. The stepper is disabled at `MAX_AUTOBAN_TERMINALS_PER_ROLE`.

### `src/services/KanbanProvider.ts` — the send verb

**Logic:** A `sendDispatchSetToCoders` arm that re-reads the plans currently in `DISPATCH`, then loops the existing per-plan dispatch path with `targetColumn: "auto"`, collecting per-plan outcomes.

**Implementation:** Add the verb to `KANBAN_VERBS` (`src/generated/verbAllowlist.ts` is generated — regenerate rather than hand-editing). Post a result back to the webview with the per-plan outcomes so the header can show `8 dispatched, 2 failed`.

**Edge Cases:** Plans no longer in Dispatch when the handler runs are skipped, not dispatched.

### `src/services/TaskViewerProvider.ts` — terminal count in the board payload

**Logic:** Include the alive coder-terminal count (`_getAliveAutobanTerminalNames('coder', workspaceRoot, false)`) in the board state payload so the header can render it without a round trip.

**Edge Cases:** Zero coder terminals is a normal state — the header reads `0 coder terminals` and Send is disabled, rather than the button failing on press.

## Verification Plan

### Manual
1. **Counts render:** with 5 plans in Dispatch and 2 coder terminals, the header reads `5 plans · 2 coder terminals`.
2. **Stepper:** pressing `+` three times creates three coder terminals; the header updates to `5 coder terminals` without a manual refresh.
3. **Cap:** the stepper disables at `MAX_AUTOBAN_TERMINALS_PER_ROLE` rather than silently failing.
4. **Send, enough terminals:** 3 plans, 3+ terminals — all dispatch; cards move to LEAD/CODER/INTERN.
5. **Send, shortfall:** 10 plans, 3 terminals — press Send without adding any. The plans that can dispatch do; the rest stay in Dispatch and the result reports the split. No dialog, no block.
6. **Complexity routing:** dispatched plans land in the coder column matching their complexity score.
7. **Empty set:** Send is disabled with an empty Dispatch view.
8. **Plan removed mid-flight:** drag a plan out of Dispatch, then press Send — it is skipped, not dispatched.
9. **Partial failure reporting:** force one dispatch to fail; the result names it and the plan stays in Dispatch.
10. **Standalone:** the stepper and Send are disabled when the host reports no terminal capability — no dead click (PRD contract #6).

## Recommendation

Complexity 2 → **Send to Intern.** Down from 6. Decoupling Send from the Analyze run removed the agent, its interactive-wait lifecycle, three HTTP endpoints, a toolbar toggle, and a persisted state field — leaving a button, a stepper, and a loop over an existing dispatch path.
