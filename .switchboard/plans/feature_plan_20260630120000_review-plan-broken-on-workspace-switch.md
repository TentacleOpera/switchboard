# Fix: "Review Plan" button on kanban cards stops working after switching workspaces

## Goal

Make the **Review Plan** button on kanban board cards (`kanban.html`) reliably open and select the target plan in the Project panel's Kanban tab (`project.html` / `project.js`) — including after the user switches workspaces via the kanban workspace/project dropdown, and including the first click when the Project panel is not yet open.

### Problem / background / root cause

The Review Plan button lives on the **standalone Kanban board** webview (`kanban.html`, rendered by `KanbanProvider._panel`). Clicking it must navigate a *different* webview — the **Project panel** (`project.html`, rendered by `PlanningPanelProvider._projectPanel`) — to its Kanban tab and select the plan there. These are two independent webviews with independent JS state, independent plan caches, and independent filter dropdowns, kept in sync only by async `postMessage` round-trips through the extension host.

The full flow today:

1. `kanban.html` review button → `postKanbanMessage({ type: 'reviewPlan', workspaceRoot: btn.dataset.workspaceRoot, planId, sessionId, planFile, project, column, isEpic })` (`kanban.html:5169-5183`). `workspaceRoot` falls back to `getActiveWorkspaceRoot()` (`kanban.html:3929-3933`) when the card's `data-workspace-root` is empty.
2. `KanbanProvider` `case 'reviewPlan'` (`KanbanProvider.ts:6831-6854`) → opens/reveals the Project panel, then `postMessageToProjectWebview({ type: 'activateKanbanTabAndSelectPlan', ... })`.
3. `project.js` `case 'activateKanbanTabAndSelectPlan'` (`project.js:572-625`) → sets `_pendingKanbanSelection` + `_pendingKanbanFilterIntent`, **clears all filters to widest**, clicks the Kanban tab (which fires `fetchKanbanPlans`), and calls `tryResolvePendingKanbanSelection()` immediately.
4. `PlanningPanelProvider` `case 'fetchKanbanPlans'` (`PlanningPanelProvider.ts:2913-2982`) → reads ALL allowed roots, tags each plan with `workspaceRoot: effectiveRoot` (`_getKanbanPlans`, `PlanningPanelProvider.ts:8723-8736`), posts `kanbanPlansReady`.
5. `project.js` `case 'kanbanPlansReady'` (`project.js:398-496`) → updates `_kanbanPlansCache`, populates dropdowns, **applies the filter intent** (narrow `kanbanFilters.workspaceRoot`/`project`/`column` to the target), renders, calls `tryResolvePendingKanbanSelection()`.
6. `tryResolvePendingKanbanSelection` (`project.js:1545-1577`) → finds the match in `_kanbanPlansCache` by `planFile`/`planId`/`sessionId`, then looks for the DOM element `.kanban-plan-item[data-plan-id="..."]`. **Only if the DOM element exists** does it scroll, select, and load the preview. If `!itemDiv`, it returns and retries (up to 3×), then falls back to widest filters and re-fetches.

**Root cause — three compounding defects:**

**A. Webview-ready race (Project panel not yet open).** `openProject()` (`PlanningPanelProvider.ts:318-387`) sets `webview.html` and returns, but `project.js` registers its `window.addEventListener('message', …)` listener *asynchronously* as the script loads. `reviewPlan` posts `activateKanbanTabAndSelectPlan` immediately after `await openProject()`. VS Code does **not** queue messages for an unloaded webview, so the message is **silently dropped**. There is no ready-handshake and no outbound message queue anywhere in `PlanningPanelProvider` (verified: no `_pending`/`_ready`/`_queued` state). `project.js` only sends `fetchKanbanPlans` on load (`project.js:382`); it never signals "ready". `retainContextWhenHidden: true` masks this in steady state — it only bites when the panel must be (re)created.

**B. Stale cache + filter-intent workspaceRoot mismatch (the dropdown-switch case the user reported).** Switching the kanban workspace dropdown (`kanban.html:6858-6882` → `selectWorkspace` → `KanbanProvider.ts:5225-5262`) refreshes **only the kanban.html board** (via `refreshWithData`, `KanbanProvider.ts:1203`). It does **not** refresh the Project panel. The Project panel's `_kanbanPlansCache` and dropdowns only update when *project.js* sends `fetchKanbanPlans`. So when Review is clicked right after a dropdown switch:
   - The immediate `tryResolvePendingKanbanSelection()` at `project.js:624` runs against a **stale cache** that likely does not contain the target plan → fails, begins retrying.
   - The filter intent then narrows `kanbanFilters.workspaceRoot` to the `workspaceRoot` carried by the kanban card. That value comes from `KanbanProvider.refreshWithData` (`KanbanProvider.ts:1210,1275`), which sets `card.workspaceRoot = path.resolve(workspaceRoot)` where `workspaceRoot` is **already the effective root** passed by `TaskViewerProvider._refreshRunSheetsImpl` (`TaskViewerProvider.ts:15263`). The Project panel's plans are also tagged with the effective root (`PlanningPanelProvider._getKanbanPlans:8723-8736`). **In the happy path these match.** They diverge — and the filter hides the plan, so `tryResolvePendingKanbanSelection` finds the match in the *unfiltered* cache but the DOM element is never rendered (`if (!itemDiv) return`) — whenever:
     - one path resolves through `resolveEffectiveWorkspaceRootFromMappings` and the other does not (e.g. a child workspace selected directly, or mappings enabled/disabled toggled between fetches),
     - `path.resolve` casing/trailing-separator differences across macOS/Windows,
     - the kanban card's `data-workspace-root` was empty and `postKanbanMessage` fell back to `getActiveWorkspaceRoot()` which returned `workspaceItems[0]` (a *different* root than the effective one the plan is tagged with).
   Once the filter hides the plan, the 3-retry fallback widens to "All Workspaces" — but if the cache still hasn't been re-fetched with the target plan, even the widest view has no DOM element and the selection silently never resolves.

**C. project/column filter intent can also hide the plan.** The review message carries `project` and `column` from `cardData` (`kanban.html:5179-5180`). The filter intent narrows both (`project.js:468-484`). The project dropdown options are built from `allWorkspaceProjects[workspaceRoot]`, which `fetchKanbanPlans` keys by **both** resolved and effective root (`PlanningPanelProvider.ts:2946-2953`). If the key the webview looks up (`kanbanFilters.workspaceRoot`, set from the intent) does not match the key under which the projects were stored, the project option is missing, the project filter is silently **not applied** (`project.js:470-476` only applies if `opts.includes(intent.project)`), and the rendered set can still exclude the plan via the column filter — same `!itemDiv` dead-end.

**Why agents keep failing to fix it:** the visible logic (`activateKanbanTabAndSelectPlan`, the filter-intent narrowing, `tryResolvePendingKanbanSelection`) is correct and well-built; auditing that layer finds nothing wrong. The defects are one layer *below* — a dropped message (A) and a string-equality dependency between two async-fed caches (B/C) that only manifests as a *silent no-selection*, with no error, no log, and intermittent reproduction. `retainContextWhenHidden` further dampens it, so it resurfaces unpredictably.

## Metadata

**Tags:** frontend, bug, kanban, webview, reliability
**Complexity:** 7
*(Single-repo workspace — no Repo line per session directive.)*

## User Review Required

Yes — before implementation, review:
1. **The ready-handshake design (Root cause A).** Confirm the approach: `project.js` posts `{ type: 'webviewReady' }` on load; `PlanningPanelProvider` queues outbound messages until ready and flushes on `webviewReady`; reset `_projectPanelReady = false` in `openProject()` and `onDidDispose`. Confirm the queue should also cover `activatePlanInProjectPanel` (`KanbanProvider.ts:202-217`), which has the identical race.
2. **The filter-intent robustness strategy (Root causes B/C).** Two options — see *Approach*. Confirm whether to (i) make `tryResolvePendingKanbanSelection` force-clear filters when a cache match has no DOM element, or (ii) keep the narrow filter but make the workspaceRoot comparison tolerant (normalize both sides through `resolveEffectiveWorkspaceRoot` + `path.resolve` + lower-case on case-insensitive filesystems). Preference is to do **both**.
3. **Whether to unify workspaceRoot tagging** between `KanbanProvider.refreshWithData` and `PlanningPanelProvider._getKanbanPlans` into a single shared helper to prevent future drift.

## Scope

In scope:
- `src/services/PlanningPanelProvider.ts` — ready-handshake + outbound queue; `openProject()`/`onDidDispose` reset.
- `src/webview/project.js` — emit `webviewReady` on load; harden `tryResolvePendingKanbanSelection` and the filter-intent application.
- `src/services/KanbanProvider.ts` — `reviewPlan` and `activatePlanInProjectPanel` to route through the queued sender; ensure `workspaceRoot` is resolved through `resolveEffectiveWorkspaceRoot` before forwarding.
- `src/services/workspaceUtils.ts` / `WorkspaceIdentityService.ts` — (optional) shared `normalizeWorkspaceRoot` helper for string-equality comparisons.

Out of scope:
- The Epics-tab review path (`tryResolvePendingEpicSelection`) — same class of bug but separate surface; file a follow-up if the same fix doesn't naturally cover it.
- Redesigning the two-webview split.

## Approach

### Step 0 — Diagnose first (do not skip)

Before changing logic, add **temporary** `console.log` instrumentation to pin which of A/B/C is firing in the user's actual repro, because the fix differs per cause:

- `KanbanProvider.reviewPlan` (`KanbanProvider.ts:6831`): log `msg.workspaceRoot`, `msg.planId`, `msg.sessionId`, `hasProjectPanel`, `isProjectInCurrentWindow`.
- `PlanningPanelProvider.openProject` / `postMessageToProjectWebview`: log when the panel is created vs. when the message is sent, and whether `_projectPanelReady` is true.
- `project.js` `activateKanbanTabAndSelectPlan` (`project.js:572`): log the full `msg`, the current `_kanbanPlansCache.length`, and the filter state.
- `project.js` `kanbanPlansReady` (`project.js:398`): log the intent, the dropdown options, and the resolved `kanbanFilters`.
- `project.js` `tryResolvePendingKanbanSelection` (`project.js:1545`): log `match` (found in cache?), the computed `itemDiv` (rendered?), and the retry count.

Repro: open kanban board, switch workspace dropdown, click Review. Capture the logs. **This is what makes the bug solvable** — every prior attempt likely skipped this and reasoned about the wrong layer.

### Step 1 — Fix Root cause A: ready-handshake + outbound queue

`PlanningPanelProvider`:
- Add `private _projectPanelReady = false;` and `private _pendingProjectMessages: any[] = [];`.
- `postMessageToProjectWebview(message)`: if `!_projectPanelReady`, push to `_pendingProjectMessages` and return; else post.
- In `_handleMessage`, add `case 'webviewReady': _projectPanelReady = true; flush _pendingProjectMessages (post each, clear); break;`.
- `openProject()`: set `_projectPanelReady = false` at the top (a fresh webview must re-handshake).
- `onDidDispose` (line 352): set `_projectPanelReady = false` and clear the queue.

`project.js`:
- At the end of the IIFE init (after the listener is registered, near `project.js:382`), send `vscode.postMessage({ type: 'webviewReady' })`.

This makes `reviewPlan` and `activatePlanInProjectPanel` correct regardless of panel state. No change needed to their call sites beyond routing through `postMessageToProjectWebview` (already the case for `reviewPlan`; `activatePlanInProjectPanel` already uses it too — just verify).

### Step 2 — Fix Root cause B/C: robust selection despite filter/cache drift

`project.js` `tryResolvePendingKanbanSelection`:
- Today: find match in `_kanbanPlansCache`, then require the DOM element. If `match` exists but `itemDiv` does not, it silently retries.
- Change: when `match` is found in the cache but **no DOM element** is rendered, **force-clear the workspace/project/column filters** (the plan is being hidden by a filter that disagrees with the cache), re-render via `renderKanbanPlans()`, then re-query the DOM element. This guarantees the matched plan becomes visible regardless of which filter-intent string mismatched. Keep the 3-retry fallback as a last resort for the genuinely-not-in-cache case.
- Rationale: the filter intent is a *nicety* (narrow the view to the plan's context); it must never *prevent* the selection the user explicitly requested.

`project.js` filter-intent application (`kanbanPlansReady`, `project.js:444-484`):
- Normalize both the intent's `workspaceRoot` and each dropdown option's value through a shared `normalizeRoot` (lower-case + `path.resolve` semantics) before the `opts.includes(...)` check, so effective-root vs raw-root and casing differences don't cause the intent to be silently skipped.
- Apply the same normalization in `getFilteredKanbanPlans` (`project.js:1379`) when comparing `plan.workspaceRoot !== kanbanFilters.workspaceRoot`.

`KanbanProvider.reviewPlan` (`KanbanProvider.ts:6831`):
- Resolve `msg.workspaceRoot` through `this.resolveEffectiveWorkspaceRoot(...)` before forwarding to the Project panel, so the two webviews always speak the same root string. Do the same in `activatePlanInProjectPanel` (`KanbanProvider.ts:202`).

### Step 3 — (Optional, recommended) Unify root tagging

Extract a single `normalizeWorkspaceRoot(root)` (resolve + effective + lower-case on case-insensitive FS) into `workspaceUtils.ts` and use it in both `KanbanProvider.refreshWithData` (card `workspaceRoot`) and `PlanningPanelProvider._getKanbanPlans` (plan `workspaceRoot`). This removes the drift source entirely rather than papering over it in the comparators.

### Step 4 — Remove Step 0 diagnostics once repro confirms the fix

Strip the temporary logs (or gate them behind a verbose flag) before the VSIX build.

## Verification

1. **Cold-open repro:** Close the Project panel. Open the kanban board. Click Review on a card. Expect: Project panel opens, Kanban tab activates, the plan is selected and its preview loads. (Validates Root cause A.)
2. **Dropdown-switch repro (the reported bug):** Open the kanban board AND the Project panel. Switch the kanban workspace dropdown to a different workspace. Click Review on a card from the newly-selected workspace. Expect: Project panel's Kanban tab narrows to that workspace and selects the plan. Repeat for several workspace pairs, including a child workspace when mappings are enabled.
3. **Mapping repro:** With `workspaceDatabaseMappings` enabled (child → parent), select a child workspace in the dropdown and click Review. Expect selection to succeed (validates the effective-root normalization).
4. **Epic review:** Click Review on an epic card. Expect the Epics tab to activate and the epic to be selected (regression check — `tryResolvePendingEpicSelection` shares the filter-intent mechanism).
5. **No-regression:** Review a plan with no workspace switch — still works.
6. `npm run compile` (webpack) must succeed. (Note: `dist/` is not used during dev/testing per CLAUDE.md; testing is via installed VSIX.)

## Risks

- **Forcing filter-clear on missing DOM** could surprise users who deliberately narrowed the view. Mitigation: only force-clear when a *cache match* exists (i.e. we know the plan is real and is being hidden), and only for the duration of resolving this selection; restore the user's prior filter afterward if desired (optional polish).
- **Ready-handshake flush ordering:** if `webviewReady` arrives before `fetchKanbanPlans`-triggered `kanbanPlansReady`, the queued `activateKanbanTabAndSelectPlan` flushes first and `_pendingKanbanSelection` is set before the cache is populated — this is already the designed async flow and `tryResolvePendingKanbanSelection`'s retry handles it. Verify with the cold-open repro.
- **Normalization changing existing filter behavior:** lower-casing roots on case-insensitive FS is safe; on case-sensitive FS (Linux) preserve case. Use `process.platform` to decide.

## Future

- Apply the same ready-handshake to the planning.html sidebar webview if it has analogous cold-open races.
- Consider collapsing the kanban.html board and the project.html Kanban tab into a single webview to eliminate the cross-webview sync class of bugs entirely (large; separate epic).
