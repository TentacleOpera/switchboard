# Audit & Downgrade: Replace Whole-Board Refreshes with Targeted Card Deltas (kanban.html)

## Goal

`KanbanProvider.ts` calls `_refreshBoard` / `_scheduleBoardRefresh` in **58 places** (plus 4 definition/log lines). Each `_refreshBoard` re-runs the entire board pipeline — custom-agents lookup, custom-columns, visible-agents, the DB `getBoard` query, a per-plan `fs.existsSync` ghost-plan filter, completed-plans query, projects list — and then posts a full `updateBoard` that makes the webview re-render and relayout **every card in every column**. For the common interactive actions (move a card, dispatch, complete), this whole-board recompute is pure overhead: the webview already has a lightweight `moveCards` delta path ([kanban.html:6067](../../src/webview/kanban.html#L6067)) that updates only the affected cards and recomputes counts from the card array it is handed.

This plan audits all 58 call sites, classifies each as **delta-safe** or **genuinely structural**, and downgrades the delta-safe ones. The companion plan [feature_plan_20260624210141_kanban-advance-buttons-bounce-back.md](feature_plan_20260624210141_kanban-advance-buttons-bounce-back.md) already covers the core advance handlers (`moveAll`, `moveSelected`, drag `moveCardForward`/`moveCardBackwards`); this plan is the broader sweep across dispatch, complete/recover, and the batch handlers, and explicitly walls off the structural refreshes that must stay.

### Why this is safe in principle

The webview `renderBoard` recomputes column counts and empty-states from the array it is given ([kanban.html:5116](../../src/webview/kanban.html#L5116)). A `moveCards` delta therefore keeps counts correct with no full redraw. A full `_refreshBoard` is only *required* when something **structural** changes — columns added/removed, workspace/project switch, plans created/deleted, epic subtask membership, worktree badges, complexity re-scored — because those change data the webview cannot derive from a move alone. Everywhere a refresh is used merely to "reflect that some cards moved", a delta is equivalent and far cheaper.

## Metadata

- **Tags:** `performance`, `refactor`, `kanban`, `KanbanProvider`, `kanban.html`, `optimistic-ui`
- **Complexity:** 6/10 (low per-site risk, but broad surface — the risk is in volume, not depth)

## Complexity Audit

**Complex by breadth, routine per site.** No single downgrade is hard; the risk is that 58 sites share a fat function and some rely on its side effects (e.g. recomputing `_lastCards`, refreshing the projects dropdown, re-evaluating visible columns). The safe approach is to classify first, change the unambiguous "redundant trailing refresh after an already-posted `moveCards`" sites (near-zero risk), then the dispatch sites, and stop before the structural ones. Each tier is independently shippable and independently revertible.

## Edge-Case & Dependency Audit

- **`_lastCards` must stay fresh.** Some handlers depend on `this._lastCards` being current for *subsequent* logic in the same handler (not just the webview). Where a refresh is removed, ensure any in-handler reliance on freshly-reloaded `_lastCards` is replaced with a data-only reload (the `_reloadLastCards` helper introduced in the companion plan) — never a webview-posting refresh.
- **Complete / archive / recover need new delta types.** `completePlan` ([5942](../../src/services/KanbanProvider.ts#L5942)) and `recoverSelected` ([5188](../../src/services/KanbanProvider.ts#L5188)) currently rely **solely** on `_refreshBoard` — they post no delta. Completing moves a card into COMPLETED (a real column, so `moveCards` works), but **archiving removes the card entirely** and **recover/uncomplete re-add or restore** a card — neither has a webview delta today. Downgrading these requires new `removeCards` / `upsertCards` message types (Tier 3). Until those exist, leave complete/recover/archive on full refresh.
- **Complexity-routing batches split across columns.** PLAN REVIEWED dispatch can send different cards to different target columns; a single `moveCards` won't express that — post **one delta per target column** (the loop already groups by `targetCol`).
- **Structural truths the delta can't carry:** projects list (project add/delete/assign), workspace switch, epic subtask counts/badges, worktree status badges, custom-agent-driven column set, kanban column structure. These MUST keep `_refreshBoard` (or `updateColumns` + refresh). Downgrading them is high-risk and low-frequency — explicitly out of scope.
- **Watcher/debounced refreshes stay.** `_scheduleBoardRefresh` fired by file watchers ([461](../../src/services/KanbanProvider.ts#L461), [508](../../src/services/KanbanProvider.ts#L508), [1111](../../src/services/KanbanProvider.ts#L1111)) is the correct mechanism for external/structural change and is already debounced. Leave it.
- **Double-render avoidance.** Several handlers currently post `moveCards` **and then** `_refreshBoard` — the card visibly moves, then the whole board redraws. Removing the trailing refresh in these is the single safest, highest-value change (no new code, just deletion).

## Call-Site Classification

Grouped by tier. Line numbers are the `_refreshBoard`/`_scheduleBoardRefresh` call sites.

### Tier 1 — Redundant trailing refresh after a move/dispatch already posts `moveCards` (near-zero risk; highest value)

| Handler | Site(s) | Action | Treatment |
|---|---|---|---|
| `moveAll` | 5601, 5635, 5671, 5686 | advance all | Covered in companion plan (start = data-only reload; trailing = delta) |
| `moveSelected` | 5593 | advance selected | Drop trailing refresh; keep the `moveCards` it already posts |
| `promptSelected` / `promptAll` | (in 5722 / 5804 bodies) | advance + copy prompt | Already post `moveCards`; drop trailing refresh |
| `promptOnDrop` | 5359, 5385, 5425 | drag-to-advance (prompt mode) | Replace refresh with `moveCards`; keep `promptOnDropResult` |
| `moveCardForward`/`moveCardBackwards` | 5054, 5042 | drag advance | Covered in companion plan (delta, not `_scheduleBoardRefresh`) |

### Tier 2 — Dispatch handlers that move cards (low–moderate risk; high value)

| Handler | Site(s) | Treatment |
|---|---|---|
| `triggerAction` | 4963, 5006 | post `moveCards` to dispatched target; drop refresh |
| `triggerBatchAction` | 5031 | post `moveCards`; drop refresh |
| `batchPlannerPrompt` | 5435, 5445 | post `moveCards` per target; drop refresh |
| `batchDispatchLow` / `batchLowComplexity` | 5462, 5474, 5488, 5502 | post `moveCards` per target; drop refresh |
| `julesLowComplexity` / `julesSelected` | 5502, 5911 | post `moveCards`; drop refresh |
| `splitterSelected` | 5938 | post `moveCards`; drop refresh |
| `rePlanSelected` / `codeMapSelected` | 6284-region | post `moveCards`; drop refresh |
| `testingFailed` | 6284, 6340 | post `moveCards` to the failure target column; drop refresh |

Each requires confirming the handler knows the final target column server-side (it computes one to dispatch), then posting `{type:'moveCards', sessionIds, targetColumn}` in its place.

### Tier 3 — Complete / recover / archive / uncomplete (moderate risk; needs new delta infra)

| Handler | Site(s) | Blocker |
|---|---|---|
| `completePlan` / `completeSelected` / `completeAll` | 5957, 5979, 5986, 6009 | move into COMPLETED works via `moveCards`, but completed-list semantics + count limits warrant care |
| `uncompleteCard` | 6047 | needs `upsertCards` (card returns to active board) |
| `recoverSelected` / `recoverAll` | 5201, 5334 | needs `upsertCards` |
| `archiveSelected` | (5205 body) | needs `removeCards` (card leaves the board) |

Do Tier 3 only after adding `removeCards` and `upsertCards` webview deltas. Until then, leave on full refresh.

### Tier 4 — Structural: KEEP full refresh (out of scope; downgrading is high-risk, low-frequency)

`selectWorkspace` (4781), `reassignPlansWorkspace` (4723, 4728), `addProject` (4798), `deleteProject` (4815), `setProjectFilter` (4824), `assignSelectedToProject` (4835), `saveCustomAgent` (6658), `deleteCustomAgent` (6673), worktree creation (6841, 6876, 6923), epic ops `addSubtaskToEpic`/`promoteToEpic`/`createEpic`/`removeSubtaskFromEpic`/`deleteEpic` (7065, 7108, 7203, 7218, 7237), kanban structure ops, and `createPlan`. These change columns, counts, badges, projects, or membership the webview cannot derive from a move.

### Keep — watcher/debounced

`_scheduleBoardRefresh` at 461, 508, 1111 (file watchers). Leave as the correct structural-change path.

## Proposed Changes

### File 1: `src/services/KanbanProvider.ts`

1. **Tier 1 — delete redundant trailing refreshes.** For each Tier 1 handler that already posts `moveCards`, remove the following `await this._refreshBoard(workspaceRoot)`. For `promptOnDrop`, replace the refresh with a `moveCards` delta (it currently has none on the success path).

2. **Tier 2 — swap refresh for delta.** In each dispatch handler, after the persist/dispatch, replace `await this._refreshBoard(...)` with:
   ```js
   this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: movedIds, targetColumn: targetCol });
   ```
   For batches that split across target columns, emit one `moveCards` per group (the grouping loop already exists).

3. **Use the data-only reload** (`_reloadLastCards`, introduced in the companion plan) anywhere a handler removed its refresh but still needs fresh `_lastCards` for its own subsequent logic.

### File 2: `src/webview/kanban.html` (only if Tier 3 is pursued)

Add two delta handlers alongside `moveCards`:
```js
case 'removeCards': {            // archive — card leaves the board
    const ids = new Set(msg.sessionIds || []);
    currentCards = currentCards.filter(c => !ids.has(c.planId || c.sessionId) && !(c.sessionId && ids.has(c.sessionId)));
    lastBoardSignature = buildBoardSignature(currentCards); renderBoard(currentCards); break;
}
case 'upsertCards': {            // recover / uncomplete — card (re)appears or changes
    const incoming = Array.isArray(msg.cards) ? msg.cards : [];
    const byKey = new Map(currentCards.map(c => [c.planId || c.sessionId, c]));
    incoming.forEach(c => byKey.set(c.planId || c.sessionId, c));
    currentCards = [...byKey.values()];
    lastBoardSignature = buildBoardSignature(currentCards); renderBoard(currentCards); break;
}
```
Both must use the planId-primary matching from the companion plan's `moveCards` fix.

## Verification Plan

**Step 1 — Tier 1 (free win).** For each Tier 1 handler, perform the action and confirm in the Extension Host log that **no** `_refreshBoardImpl` / `getBoard` / ghost-plan-filter lines appear — only a `moveCards` delta. Visually: affected cards + counts update, the rest of the board does not relayout.

**Step 2 — Tier 2 (dispatch).** Run each dispatch handler (single + batch). Confirm cards land in the correct target column via delta, counts are right, and no full redraw fires. Verify the actual dispatch/prompt still happens.

**Step 3 — Structural untouched.** Confirm Tier 4 actions (project add/delete, workspace switch, epic subtask add/remove, worktree create, custom-agent save, column edits, plan create) STILL trigger a full refresh and render correctly — these must not regress.

**Step 4 — Tier 3 (only if implemented).** Complete → card moves to COMPLETED via delta; archive → card disappears via `removeCards`; recover/uncomplete → card reappears via `upsertCards`; counts correct throughout; no full redraw.

**Step 5 — Watcher path.** Externally edit/create/delete a plan file; confirm the debounced `_scheduleBoardRefresh` still does a full refresh and the board reflects the external change.

**Step 6 — Snappiness measurement.** On a board with many cards (e.g. 50+), compare wall-clock responsiveness of advance/dispatch before vs after. Expectation: interactive moves feel instant; no perceptible relayout of unrelated columns.

**Step 7 — Build & install.** Build, reload, re-run Steps 1–2 against the installed extension (not `dist/`).

---

## Risk / Reward Advice

**Do this (highest gain, lowest risk):**

- **Tier 1 is essentially free** — it is mostly *deleting* a redundant `await this._refreshBoard()` that runs right after a `moveCards` the webview already acted on. These are the most frequent interactive actions (every advance/prompt). Near-zero risk, immediately snappier. The companion bounce-back plan already does the biggest ones (`moveAll`/`moveSelected`/drag); finishing `promptSelected`/`promptAll`/`promptOnDrop` is the same trivial change.
- **Tier 2 (dispatch) is high gain, low–moderate risk.** These fire on every triggerAction/batch dispatch. The only care needed is confirming the target column server-side and emitting one delta per target group. Worth doing.

**The highest gains come from Tier 1 + Tier 2** — the move/dispatch hot path. Together they remove whole-board recompute from virtually every routine click, which is exactly the "board as snappy as possible" goal. I'd ship these two tiers and stop.

**Consider, but only if it still feels slow:**

- **Tier 3 (complete/recover/archive)** needs new `removeCards`/`upsertCards` deltas — real new code on both sides and a moderate state-divergence risk if a delta omits a field the render needs. These actions are less frequent than moves. Do it only if complete/recover visibly lag after Tiers 1–2.

**Don't bother (poor risk/reward):**

- **Tier 4 (structural)** — projects, workspace, epics, worktrees, custom agents, columns. These genuinely change data the webview can't derive from a delta, they're infrequent (you don't create an epic or switch workspace dozens of times a minute), and hand-rolling deltas for them invites subtle desync bugs (wrong counts, stale badges, ghost cards). The full refresh is the *correct* tool here. Leave them.
- **The watcher path** is already debounced and is the right place for a full refresh. Leave it.

**Bottom line:** Tiers 1–2 are worth it and low-risk — that's where the snappiness is. Tier 3 is optional and gated on whether it still feels slow. Tier 4 is not worth the risk and should stay on full refresh.
