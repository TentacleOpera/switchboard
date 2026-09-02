# Review Plan Selects The Plan It Was Clicked On, And Stops Refetching The Whole Board To Do It

## Goal

Fix the Review Plan navigation from the kanban board to the Project panel over a remote Switchboard. Today the first click lands on an empty panel, a second click does not move the selection to the newly clicked plan, and every navigation drags a 1.4 MB plan-list refetch behind it. Give the browser push path the cold-panel queue the editor path already has, and stop re-fetching the entire multi-workspace plan list to select one card.

### Problem Analysis & Root Cause

Four symptoms were reported. Three have measured causes; the fourth needs reproduction before it is fixed, and this plan says so rather than guessing.

**Measured on the home lab box over the tailnet, 2026-09-01:**

| call | route | time | size |
|---|---|---|---|
| `fetchKanbanPlanPreview` (one .md) | `/project/verb/…` | **0.13 s** | 14 KB |
| `fetchKanbanPlans` (the list) | `/project/verb/…` | **2.1 – 2.3 s** | **1,401,184 bytes / 2,555 plans** |

---

**Finding 1 — the markdown is not what is slow.** A single plan preview is 14 KB and 130 ms. The 2.2-second wait is `fetchKanbanPlans`, which returns **2,555 plans and 1.4 MB** because `PlanningPanelProvider.ts:3792` builds the list across *every* allowed root:

```ts
const allRoots = Array.from(this._getAllowedRoots());
```

And it is fired on every Review Plan click: `activateKanbanTabAndSelectPlan` activates the Kanban tab (`project.js:713`), and "its click handler fires `fetchKanbanPlans`". So selecting one card costs a full multi-workspace board download. The report of "md files served super slowly" is real but misattributed — the file is fast, the list around it is not.

**Finding 2 — the first click shows nothing, because the browser push has no cold-panel queue.** For a browser-originated click, `KanbanProvider.ts:12519` takes the `__viaHttp` branch and pushes WS-only:

```ts
this._planningPanelProvider.pushProjectMessageToWsOnly(reviewActivateMsg);
```

which is (`PlanningPanelProvider.ts:1092`) a straight `this._broadcaster?.mirrorToWs('project', message)` — delivered immediately. `wsHub.broadcast` (`wsHub.ts:396`) then iterates `this._connections`: **live connections only**. A push sent before the Project panel's WebSocket has completed its handshake is delivered to nobody and is never retried.

The editor path has exactly the missing mechanism and does not share it: `_pendingProjectMessages`, `_flushPendingProjectMessages` and `_projectPanelReady` (`PlanningPanelProvider.ts:1102`) queue messages until the panel signals ready. `project.js:1237` posts `webviewReady` for this purpose, and its own comment says cold-open messages "are not dropped by the browser before the listener exists" — which is true of the webview path and false of the WS path.

Note that `shell.js:5` mounts every panel iframe up front, so the Project panel *exists* from cockpit load. Existing is not the same as WS-connected, and it is the connection the hub filters on.

**Finding 3 — the second click not moving the selection is NOT yet explained, and must be reproduced before it is fixed.** The push path is the same, and once connected it should arrive. `tryResolvePendingKanbanSelection` is called from both the message handler (`project.js:718`) and `kanbanPlansReady` (`project.js:571`), so a late list should still resolve it. Three candidates, none confirmed:

- The 2.2 s list refetch means the selection resolves seconds after the panel is shown, which reads as "not selected" even when it eventually lands.
- The stale-request guard at `PlanningPanelProvider.ts:3788` (`if (requestId <= this._latestRequestIds.get('kanban-plans')) return {error:'Stale request'}`) rejects a second fetch, so `kanbanPlansReady` never arrives to re-run the resolver. Reproduced directly with curl: a lower `requestId` returns `{"success":false,"error":"Stale request"}`.
- The second push is dropped for the same reason as the first.

**Do not implement a fix for this symptom from the list above.** Reproduce it first with logging on the push, the guard and the resolver, and fix the cause that actually fires.

**Finding 4 — the residual slowness after a manual sidebar click needs attribution, not assumption.** The preview fetch is 130 ms, so whatever the user feels when clicking a plan by hand is something else — most likely another `fetchKanbanPlans`, but that must be measured in the running panel rather than inferred here.

**Common thread.** Findings 1 and 2 are the same shape as a defect already planned elsewhere on this board: a browser surface treated as an afterthought to the editor path. The editor gets a queue; the browser gets a fire-and-forget push. The editor's round trip is a `postMessage`; the browser's is 1.4 MB over a network.

## Metadata
**Topic:** Review Plan navigation and the plan-list refetch behind it
**Tags:** webview, kanban, project-panel, browser-cockpit, performance, bugfix

**Complexity:** 5

## User Review Required

None.

## Proposed Changes

**1. Give the WS push path a cold-panel queue.** `pushProjectMessageToWsOnly` must not assume a live subscriber. Either queue until the Project panel's WS connection declares the `project` surface and flush on connect, or have the panel request any pending activation on connect. Reuse the semantics of `_pendingProjectMessages` / `_projectPanelReady` rather than inventing a second, differently-behaved queue.

**2. Bound the queue.** A stale activation replayed minutes later would hijack the panel to a plan the user has forgotten clicking. Keep the latest activation only, and expire it — the editor queue's timer (`_projectPanelReadyTimer`) is the precedent to follow.

**3. Stop refetching the whole board to select one card.** `activateKanbanTabAndSelectPlan` already carries `planId`, `planFile`, `workspaceRoot`, `project` and `column`. If the plan is already in `_kanbanPlansCache`, select it and load its preview without any list fetch. If it is not, fetch **that plan**, not all 2,555 — `GET /kanban/plan?planId=` already exists and the command surface uses it.

**4. Scope the list fetch when one is genuinely needed.** `fetchKanbanPlans` spanning every allowed root is the wrong default for a panel showing one workspace. Scope it to the activation's `workspaceRoot`, and treat the all-roots build as the explicit case rather than the automatic one.

**5. Reproduce Finding 3 before changing anything for it.** Add temporary logging at the three candidate points, click Review Plan twice against the remote board, and identify which one fires. Then fix that. If it turns out to be the stale-request guard, note that the guard is correct in intent — the fix is not to remove it.

**6. Do not touch the editor path's behaviour.** `__viaHttp === false` still opens/reveals the editor panel, and the comment at `KanbanProvider.ts:12513` explains why the browser branch must not: it would pull focus into VS Code for a click that happened outside it. That is a fixed bug, not an oversight.

## Verification Plan

All of it against the remote board over the tailnet — every symptom here is invisible on loopback, where the list fetch is fast enough to hide the race.

1. **Cold first click.** Reload the browser cockpit and click Review Plan immediately, before the panel has settled. The Project panel opens **with the plan selected and its content shown**. This is the reported first-click failure and the primary assertion.
2. **Second click moves the selection.** With the Project panel already showing plan A, click Review Plan on plan B. The selection moves to B and B's content renders. Repeat with a third plan.
3. **No full-board fetch.** Watch the network panel across a Review Plan click: **no** 1.4 MB `fetchKanbanPlans`. Selecting a cached plan should issue at most one small preview request.
4. **Time it.** From click to rendered content, against a 2.2 s baseline. Record the number.
5. **Uncached plan.** Select a plan not in `_kanbanPlansCache` (a different workspace). It resolves without pulling all 2,555 plans.
6. **Stale activation does not hijack.** Queue an activation, wait past the expiry, connect the panel. It must not jump to a plan the user clicked long ago.
7. **Feature cards** — `isFeature: true` takes the Features-tab branch (`project.js:652`) and still works; this path has its own pending-selection mechanism.
8. **Editor path unchanged.** In VS Code, Review Plan still opens/reveals the Project panel, and a browser-originated click still does **not** steal focus into the editor.
9. **Finding 4 attributed.** Measure a manual sidebar plan click in the running panel and state what the remaining time is spent on. If it is another list fetch, change 3 covers it; if not, say what it was.
10. **No regression in the panel's own fetches.** The Kanban tab still populates when opened directly, not only via Review Plan.
