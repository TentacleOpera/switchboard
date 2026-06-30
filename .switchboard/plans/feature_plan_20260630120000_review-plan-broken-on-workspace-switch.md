# Fix: "Review Plan" button on kanban cards stops working after switching workspaces

## Goal

Make the **Review Plan** button on kanban board cards (`kanban.html`) reliably open and select the target plan in the Project panel's Kanban tab (`project.html` / `project.js`) — including after the user switches workspaces via the kanban workspace/project dropdown, and including the first click when the Project panel is not yet open.

### Problem / background / root cause

The Review Plan button lives on the **standalone Kanban board** webview (`kanban.html`, rendered by `KanbanProvider._panel`). Clicking it must navigate a *different* webview — the **Project panel** (`project.html`, rendered by `PlanningPanelProvider._projectPanel`) — to its Kanban tab and select the plan there. These are two independent webviews with independent JS state, independent plan caches, and independent filter dropdowns, kept in sync only by async `postMessage` round-trips through the extension host.

The full flow today:

1. `kanban.html` review button → `postKanbanMessage({ type: 'reviewPlan', workspaceRoot: btn.dataset.workspaceRoot, planId, sessionId, planFile, project, column, isEpic })` (`kanban.html:5169-5183`). `workspaceRoot` falls back to `getActiveWorkspaceRoot()` (`kanban.html:3925-3933`) when the card's `data-workspace-root` is empty.
2. `KanbanProvider` `case 'reviewPlan'` (`KanbanProvider.ts:6845-6868`) → opens/reveals the Project panel, then `postMessageToProjectWebview({ type: 'activateKanbanTabAndSelectPlan', ... })`.
3. `project.js` `case 'activateKanbanTabAndSelectPlan'` (`project.js:572-625`) → sets `_pendingKanbanSelection` + `_pendingKanbanFilterIntent`, **clears all filters to widest**, clicks the Kanban tab (which fires `fetchKanbanPlans`), and calls `tryResolvePendingKanbanSelection()` immediately.
4. `PlanningPanelProvider` `case 'fetchKanbanPlans'` (`PlanningPanelProvider.ts:2913-2982`) → reads ALL allowed roots, tags each plan with `workspaceRoot: effectiveRoot` (`_getKanbanPlans`, `PlanningPanelProvider.ts:8721-8748`), posts `kanbanPlansReady`.
5. `project.js` `case 'kanbanPlansReady'` (`project.js:398-496`) → updates `_kanbanPlansCache`, populates dropdowns, **applies the filter intent** (narrow `kanbanFilters.workspaceRoot`/`project`/`column` to the target), renders, calls `tryResolvePendingKanbanSelection()`.
6. `tryResolvePendingKanbanSelection` (`project.js:1545-1577`) → finds the match in `_kanbanPlansCache` by `planFile`/`planId`/`sessionId`, then looks for the DOM element `.kanban-plan-item[data-plan-id="..."]`. **Only if the DOM element exists** does it scroll, select, and load the preview. If `!itemDiv`, it returns and retries (up to 3×), then falls back to widest filters and re-fetches.

**Root cause — three compounding defects:**

**A. Webview-ready race (Project panel not yet open).** `openProject()` (`PlanningPanelProvider.ts:318-387`) sets `webview.html` and returns, but `project.js` registers its `window.addEventListener('message', …)` listener *asynchronously* as the script loads. `reviewPlan` posts `activateKanbanTabAndSelectPlan` immediately after `await openProject()`. VS Code queues the message internally on the main thread, but flushes it to the iframe as soon as the HTML is dispatched — *before* the webview's JS has parsed and registered its `message` listener. The browser engine silently discards the event with no exception, no error signal, and no `false` return value (`postMessage` resolves `true` even when dropped — it only resolves `false` if the panel is disposed or hidden without `retainContextWhenHidden`). This is a confirmed VS Code webview API behavior (verified via research against official VS Code docs, source code `overlayWebview.ts`, and GitHub issues #64597, #74568). There is no ready-handshake and no outbound message queue anywhere in `PlanningPanelProvider` (verified: no `_pending`/`_ready`/`_queued` state — grep returned zero matches). `postMessageToProjectWebview` (`PlanningPanelProvider.ts:731-733`) is a bare `this._projectPanel?.webview.postMessage(message)`. `project.js` only sends `fetchKanbanPlans` on load (`project.js:382`); it never signals "ready". `retainContextWhenHidden: true` does **not** prevent this cold-load race — it only preserves DOM/JS state when an *already-loaded* panel is subsequently hidden (confirmed by research; VS Code GitHub issue #47534). It masks the bug in steady state — it only bites when the panel must be (re)created.

**B. Stale cache + filter-intent workspaceRoot mismatch (the dropdown-switch case the user reported).** Switching the kanban workspace dropdown (`kanban.html:6858-6882` → `selectWorkspace` → `KanbanProvider.ts:5239-5276`) refreshes **only the kanban.html board** (via `refreshWithData`, `KanbanProvider.ts:1203`). It does **not** refresh the Project panel. The Project panel's `_kanbanPlansCache` and dropdowns only update when *project.js* sends `fetchKanbanPlans`. So when Review is clicked right after a dropdown switch:
   - The immediate `tryResolvePendingKanbanSelection()` at `project.js:624` runs against a **stale cache** that likely does not contain the target plan → fails, begins retrying.
   - The filter intent then narrows `kanbanFilters.workspaceRoot` to the `workspaceRoot` carried by the kanban card. That value comes from `KanbanProvider.refreshWithData` (`KanbanProvider.ts:1210,1275`), which sets `card.workspaceRoot = path.resolve(workspaceRoot)` where `workspaceRoot` is **already the effective root** passed by `TaskViewerProvider._refreshRunSheetsImpl` (`TaskViewerProvider.ts:15263`). The Project panel's plans are also tagged with the effective root (`PlanningPanelProvider._getKanbanPlans:8721-8748`). **In the happy path these match.** They diverge — and the filter hides the plan, so `tryResolvePendingKanbanSelection` finds the match in the *unfiltered* cache but the DOM element is never rendered (`if (!itemDiv) return`) — whenever:
     - one path resolves through `resolveEffectiveWorkspaceRootFromMappings` and the other does not (e.g. a child workspace selected directly, or mappings enabled/disabled toggled between fetches),
     - `path.resolve` casing/trailing-separator differences across macOS/Windows,
     - the kanban card's `data-workspace-root` was empty and `postKanbanMessage` fell back to `getActiveWorkspaceRoot()` which returned `workspaceItems[0]` (a *different* root than the effective one the plan is tagged with).
   Once the filter hides the plan, the 3-retry fallback widens to "All Workspaces" — but if the cache still hasn't been re-fetched with the target plan, even the widest view has no DOM element and the selection silently never resolves.

   **Critical detail discovered in code review:** The `!itemDiv` branch in `tryResolvePendingKanbanSelection` (line 1571) does a bare `return` — it does **NOT** increment `_pendingKanbanSelectionRetries`. The 3-retry fallback (lines 1557-1566) only fires in the `!match` branch (plan not in cache). When `match` IS found but is hidden by a filter, the function returns without retrying, without clearing filters, and without incrementing the counter. This creates a **permanent dead-end**: `_pendingKanbanSelection` stays set, and every subsequent `kanbanPlansReady` re-applies the filter intent (lines 444-484), re-hiding the plan in an **infinite re-narrow loop**. The 3-retry fallback never triggers for this case.

**C. project/column filter intent can also hide the plan.** The review message carries `project` and `column` from `cardData` (`kanban.html:5179-5180`). The filter intent narrows both (`project.js:468-484`). The project dropdown options are built from `allWorkspaceProjects[workspaceRoot]`, which `fetchKanbanPlans` keys by **both** resolved and effective root (`PlanningPanelProvider.ts:2946-2953`). If the key the webview looks up (`kanbanFilters.workspaceRoot`, set from the intent) does not match the key under which the projects were stored, the project option is missing, the project filter is silently **not applied** (`project.js:470-476` only applies if `opts.includes(intent.project)`), and the rendered set can still exclude the plan via the column filter — same `!itemDiv` dead-end.

   **Note:** The `allWorkspaceProjects` keys are already normalized through the existing `normalizeRoot` function (`project.js:424-428`), but the filter-intent `opts.includes()` check (line 448) and `getFilteredKanbanPlans` comparison (line 1379) do **not** apply `normalizeRoot` to both sides. The existing `normalizeRoot` (`project.js:1189-1193`) normalizes backslashes → forward slashes, collapses repeated slashes, and strips trailing slashes — but does **not** lower-case (correct for case-sensitive filesystems).

**Why agents keep failing to fix it:** the visible logic (`activateKanbanTabAndSelectPlan`, the filter-intent narrowing, `tryResolvePendingKanbanSelection`) is correct and well-built; auditing that layer finds nothing wrong. The defects are one layer *below* — a dropped message (A) and a string-equality dependency between two async-fed caches (B/C) that only manifests as a *silent no-selection*, with no error, no log, and intermittent reproduction. `retainContextWhenHidden` further dampens it, so it resurfaces unpredictably.

## Metadata

**Tags:** frontend, ui, bugfix, reliability
**Complexity:** 7

## User Review Required

Yes — before implementation, review:
1. **The ready-handshake design (Root cause A).** This approach is confirmed by research as the **canonical VS Code-recommended pattern** — VS Code core maintainers explicitly direct extension developers to implement a bidirectional ready-handshake rather than relying on timeouts or assuming the platform preserves messages prior to script boot. Confirm the implementation details: `project.js` posts `{ type: 'webviewReady' }` on load (after the `addEventListener('message', …)` at `project.js:385`, NOT at line 382 which is before the listener); `PlanningPanelProvider` queues outbound messages until ready and flushes on `webviewReady`; reset `_projectPanelReady = false` only when creating a new panel (after the early return in `openProject()`, after line 325) and in `onDidDispose` (line 352). Confirm the queue should also cover `activatePlanInProjectPanel` (`KanbanProvider.ts:202-217`), which has the identical race.
2. **The filter-intent robustness strategy (Root causes B/C).** Two options — see *Approach*. Confirm whether to (i) make `tryResolvePendingKanbanSelection` force-clear filters when a cache match has no DOM element (this also breaks the infinite re-narrow loop described in root cause B), or (ii) keep the narrow filter but make the workspaceRoot comparison tolerant (normalize both sides through the existing `normalizeRoot` + extension-host-side `resolveEffectiveWorkspaceRoot`). Preference is to do **both**.
3. **Whether to unify workspaceRoot tagging** between `KanbanProvider.refreshWithData` and `PlanningPanelProvider._getKanbanPlans` into a single shared helper to prevent future drift.

## Scope

In scope:
- `src/services/PlanningPanelProvider.ts` — ready-handshake + outbound queue; `openProject()`/`onDidDispose` reset (correct placement: after early return, not at top).
- `src/webview/project.js` — emit `webviewReady` on load (after listener registration at line 385, NOT at line 382); harden `tryResolvePendingKanbanSelection` and the filter-intent application.
- `src/services/KanbanProvider.ts` — `reviewPlan` (`KanbanProvider.ts:6845-6868`) and `activatePlanInProjectPanel` (`KanbanProvider.ts:202-217`) to route through the queued sender; ensure `workspaceRoot` is resolved through `resolveEffectiveWorkspaceRoot` before forwarding.
- `src/services/workspaceUtils.ts` / `WorkspaceIdentityService.ts` — (optional) shared `normalizeWorkspaceRoot` helper for string-equality comparisons on the extension host side.

Out of scope:
- The Epics-tab review path (`tryResolvePendingEpicSelection`) — same class of bug but separate surface; file a follow-up if the same fix doesn't naturally cover it.
- Redesigning the two-webview split.

## Complexity Audit

### Routine
- Adding `_projectPanelReady` boolean flag and `_pendingProjectMessages` array to PlanningPanelProvider — straightforward state additions.
- Adding `case 'webviewReady'` to `_handleMessage` switch in PlanningPanelProvider — single new case.
- Sending `vscode.postMessage({ type: 'webviewReady' })` from project.js after listener registration.
- Applying the existing `normalizeRoot` function (project.js:1189) to filter-intent `opts.includes()` checks and `getFilteredKanbanPlans` comparisons — using an already-present utility.
- Resolving `msg.workspaceRoot` through `this.resolveEffectiveWorkspaceRoot(...)` in `KanbanProvider.reviewPlan` before forwarding — one-line change using an existing method (KanbanProvider.ts:4497).

### Complex / Risky
- Ready-handshake + outbound message queue is a **new architectural pattern** for this codebase — no existing queue mechanism anywhere in PlanningPanelProvider. Must handle flush ordering, disposal cleanup, and the reveal-existing-panel early-return path correctly.
- Force-clearing filters on `!itemDiv` when a cache match exists — changes user-visible view state. Could surprise users who deliberately narrowed the view. Must only trigger when a cache match is confirmed (plan is real but hidden by filter), not when the plan genuinely isn't in the cache.
- The `!itemDiv` permanent dead-end (retry counter never incremented, creating an infinite re-narrow loop) requires careful fix — the force-clear must also reset the retry counter to re-enter the normal resolution flow, without breaking the existing 3-retry fallback for the genuinely-not-in-cache case.
- Cross-webview state synchronization between kanban.html and project.js with async `postMessage` round-trips — multiple race windows (cold-open, dropdown-switch, flush-ordering) that are intermittent and hard to reproduce.
- Proactive `kanbanPlansReady` pushes (PlanningPanelProvider.ts:3154-3155, 3267-3268, 3284-3285, 3310-3311) use direct `this._projectPanel?.webview.postMessage(...)`, bypassing `postMessageToProjectWebview` — should optionally be routed through the queue for consistency.

## Edge-Case & Dependency Audit

**Race Conditions:**
- *Cold-open:* `activateKanbanTabAndSelectPlan` sent before project.js listener registers → message dropped (Root cause A). Fixed by ready-handshake queue.
- *Dropdown-switch:* Project panel cache stale; filter intent narrows to a root the cache doesn't contain yet → `!itemDiv` dead-end (Root cause B). Fixed by force-clear on hidden match + `resolveEffectiveWorkspaceRoot` normalization.
- *`webviewReady` flush ordering:* queued `activateKanbanTabAndSelectPlan` flushes before `kanbanPlansReady` arrives → `_pendingKanbanSelection` is set before cache is populated. This is the designed async flow; `tryResolvePendingKanbanSelection`'s retry handles it. Verify with cold-open repro.
- *Infinite re-narrow loop:* `kanbanPlansReady` re-applies filter intent every time, re-hiding the plan. The `!itemDiv` branch never increments the retry counter, so the 3-retry fallback never fires. Fixed by force-clear on hidden match.
- *Reveal-existing-panel:* `openProject()` returns early if panel exists. Resetting `_projectPanelReady` at the top (as originally proposed) would queue messages unnecessarily for every `reviewPlan` click when the panel is already open. Fixed by placing the reset after the early return.
- *Background throttling (retainContextWhenHidden):* Per research findings, webviews with `retainContextWhenHidden: true` that are in the background are subject to Chromium resource conservation — `setTimeout`/`setInterval` are clamped to 1000ms and `requestAnimationFrame` is paused. The `tryResolvePendingKanbanSelection` retry mechanism uses immediate calls (not timers), so it is not directly throttled, but any future timer-based retry additions should account for this. `postMessage` events are still delivered to background panels, but UI updates driven by them may not render until focus is restored.

**Security:**
- No security implications — all messages are internal webview ↔ extension host communication within VS Code's sandbox. No user input is passed to evaluators or file system operations through this path.

**Side Effects:**
- Force-clearing filters changes the user's view state (narrowed → widest). Mitigated by only clearing when a cache match exists (plan is confirmed real but hidden by filter). Optional polish: restore prior filter after selection resolves.
- Resetting `_projectPanelReady = false` must only happen when creating a new panel (after the early return in `openProject()`), not when revealing an existing one — otherwise messages queue forever on the reveal path.
- Routing `reviewPlan`'s `workspaceRoot` through `resolveEffectiveWorkspaceRoot` changes the value sent to the Project panel — in the happy path it's a no-op (already effective), but in edge cases (empty `data-workspace-root` fallback) it corrects the root to match what `_getKanbanPlans` tags plans with.

**Dependencies & Conflicts:**
- No dependencies on other plans or sessions.
- The Epics-tab review path (`tryResolvePendingEpicSelection`, project.js:1579-1597) shares the same `_pendingKanbanFilterIntent` mechanism and has the same `!itemDiv` dead-end pattern (line 1591: bare `return`, no retry increment). The fix should be verified against it as a regression check. A follow-up plan may be needed if the fix doesn't naturally cover it.
- The existing `normalizeRoot` function (project.js:1189-1193) does NOT lower-case roots — correct for case-sensitive filesystems (Linux). Do NOT add lower-casing in the webview; handle case normalization on the extension host side via `resolveEffectiveWorkspaceRoot` + `path.resolve`.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) the ready-handshake queue is a new async pattern that could introduce flush-ordering bugs if `webviewReady` is sent before the webview's `message` listener is registered — mitigated by sending it after `addEventListener` at line 385; (2) the `!itemDiv` permanent dead-end (retry counter never incremented) creates an infinite re-narrow loop that the 3-retry fallback never breaks — mitigated by force-clearing filters when a cache match is confirmed hidden; (3) `_projectPanelReady` reset placement must be after the reveal-existing-panel early return, not at the top of `openProject()` — otherwise the reveal path queues messages forever. Additional correction: line numbers for `reviewPlan` (6845-6868, not 6831-6854) and `selectWorkspace` (5239-5276, not 5225-5262) were off by 14 lines in the original plan.

## Proposed Changes

### src/services/PlanningPanelProvider.ts

**Context:** This provider owns the Project panel webview and its message bridge. It currently has no ready-handshake and no outbound message queue — `postMessageToProjectWebview` (line 731-733) is a bare `this._projectPanel?.webview.postMessage(message)`.

**Logic — Ready-handshake + outbound queue (Root cause A):**
- Add `private _projectPanelReady = false;` and `private _pendingProjectMessages: any[] = [];` as instance fields.
- Modify `postMessageToProjectWebview(message)` (line 731-733): if `!this._projectPanelReady`, push to `this._pendingProjectMessages` and return; else post directly.
- In `_handleMessage` (line 1966), add `case 'webviewReady': this._projectPanelReady = true; for (const m of this._pendingProjectMessages) { this._projectPanel?.webview.postMessage(m); } this._pendingProjectMessages = []; break;` — place this case early in the switch, before `fetchKanbanPlans`. **FIFO ordering is guaranteed** by VS Code's IPC transport (confirmed via research — both webview→host and host→webview directions preserve order over a single serial channel), so flushing the queue in insertion order is safe.
- In `openProject()` (line 318-387): set `this._projectPanelReady = false` **after** the early return at line 323 (i.e., at the point where a new panel is actually created, after line 325), NOT at the top of the method. A fresh webview must re-handshake; an existing revealed panel is already ready.
- In `onDidDispose` (line 352-358): add `this._projectPanelReady = false; this._pendingProjectMessages = [];` alongside the existing `this._projectPanel = undefined;`.
- **Queue timeout safeguard (recommended):** add a timeout (e.g., 10s via `setTimeout`) after creating a new panel. If `webviewReady` has not arrived by then, log a warning and flush the queue anyway (best-effort delivery). This prevents unbounded queue growth if the webview fails to load due to a script error (per VS Code team guidance from the research findings).

**Optional — Route proactive pushes through queue:**
- Lines 3154-3155, 3267-3268, 3284-3285, 3310-3311 send `kanbanPlansReady` via direct `this._projectPanel?.webview.postMessage(...)`. Change these to `this.postMessageToProjectWebview(...)` for consistency. These are triggered by user actions within the project panel, so the webview is ready — but routing through the queue is safer and avoids maintaining two message paths.

**Edge Cases:**
- If `webviewReady` arrives but `_projectPanel` is undefined (panel disposed between send and receive), the flush loop checks `this._projectPanel?.webview` — optional chaining prevents a crash; messages are lost (acceptable — panel is gone).
- If multiple `webviewReady` messages arrive (shouldn't happen, but defensive), the second is a no-op: `_projectPanelReady` is already true, `_pendingProjectMessages` is empty.

### src/webview/project.js

**Context:** This is the Project panel's webview script. It sends `fetchKanbanPlans` on load (line 382) but never signals readiness. Its `tryResolvePendingKanbanSelection` has a permanent dead-end when a cache match is hidden by filters.

**Logic — Emit `webviewReady` (Root cause A):**
- After the `window.addEventListener('message', async event => { … })` call (line 385), add `vscode.postMessage({ type: 'webviewReady' });`. This MUST be after the listener is registered, NOT at line 382 (which is before the listener). The listener registration is synchronous, so by the time any flushed queue messages arrive from the extension host, the listener is ready.

**Logic — Force-clear on hidden match (Root cause B/C):**
- In `tryResolvePendingKanbanSelection` (line 1545-1577), after `const itemDiv = …` (line 1570) and before the `if (!itemDiv) return` (line 1571), add: if `match` exists but `!itemDiv`, **force-clear all kanban filters** (workspaceRoot, project, column, complexity), call `renderKanbanPlans()`, re-query `itemDiv`, and reset `_pendingKanbanFilterIntent = null` to prevent the next `kanbanPlansReady` from re-narrowing. If the re-queried `itemDiv` now exists, proceed with selection. If it still doesn't exist, increment `_pendingKanbanSelectionRetries` and fall through to the existing retry logic. This breaks the infinite re-narrow loop.
- Rationale: the filter intent is a *nicety* (narrow the view to the plan's context); it must never *prevent* the selection the user explicitly requested.

**Logic — Apply `normalizeRoot` consistently (Root cause C):**
- In the filter-intent workspaceRoot application (line 446-451): normalize both `intent.workspaceRoot` and each dropdown option value through the existing `normalizeRoot()` (project.js:1189) before the `opts.includes()` check.
- In `getFilteredKanbanPlans` (line 1379): normalize both `plan.workspaceRoot` and `kanbanFilters.workspaceRoot` through `normalizeRoot()` before the `!==` comparison.
- Do NOT add lower-casing to `normalizeRoot` — it runs in the webview (browser sandbox) where `process.platform` is unavailable. Case normalization is handled on the extension host side (see KanbanProvider changes below).

**Edge Cases:**
- The force-clear changes the user's visible filter state. Only trigger when `match` is confirmed in cache (plan is real, just hidden by filter). Optional polish: save and restore the user's prior filter state after selection resolves.
- The `normalizeRoot` function already handles backslash → forward slash and trailing-slash removal. Adding it to the comparisons ensures Windows path separators and trailing slashes don't cause silent filter mismatches.

### src/services/KanbanProvider.ts

**Context:** This provider handles the `reviewPlan` message from kanban.html and forwards it to the Project panel. It also has `activatePlanInProjectPanel` which has the identical race.

**Logic — Resolve workspaceRoot through effective root (Root cause B):**
- In `case 'reviewPlan'` (line 6845-6868): before calling `postMessageToProjectWebview`, resolve `msg.workspaceRoot` through `this.resolveEffectiveWorkspaceRoot(msg.workspaceRoot)` (method at line 4497). This ensures the workspaceRoot sent to the Project panel matches what `_getKanbanPlans` tags plans with (effective root). In the happy path this is a no-op; in edge cases (empty `data-workspace-root` fallback to `getActiveWorkspaceRoot()`, or child workspace selected directly) it corrects the root.
- Do the same in `activatePlanInProjectPanel` (line 202-217): resolve `workspaceRoot` through `this.resolveEffectiveWorkspaceRoot(workspaceRoot)` before forwarding.

**Edge Cases:**
- `resolveEffectiveWorkspaceRoot` (line 4497) first checks the legacy control-plane root, then checks `resolveEffectiveWorkspaceRootFromMappings`. If neither applies, it returns `path.resolve(workspaceRoot)` unchanged — safe no-op.
- If `msg.workspaceRoot` is empty, `resolveEffectiveWorkspaceRoot('')` will resolve to the current working directory — but the empty case should be handled by the `getActiveWorkspaceRoot()` fallback in kanban.html, which provides a non-empty root. Add a guard: if `msg.workspaceRoot` is falsy, use `this.getCurrentWorkspaceRoot()` instead.

### src/services/workspaceUtils.ts (Optional, recommended)

**Context:** Currently contains only `buildWorkspaceItems` (line 1-86). The plan proposes adding a shared `normalizeWorkspaceRoot` helper.

**Logic — Unify root tagging (Root cause B, prevention):**
- Extract a `normalizeWorkspaceRoot(root: string): string` function that applies `path.resolve` + `resolveEffectiveWorkspaceRootFromMappings` + (on case-insensitive platforms via `process.platform`) lower-casing. This runs on the extension host where `process.platform` IS available.
- Use it in both `KanbanProvider.refreshWithData` (card `workspaceRoot`, line 1275) and `PlanningPanelProvider._getKanbanPlans` (plan `workspaceRoot`, line 8736) to remove the drift source entirely.
- This is optional because the per-call-site `resolveEffectiveWorkspaceRoot` fixes above already address the immediate bug; this helper prevents future drift.

**Edge Cases:**
- On Linux (case-sensitive FS), preserve case. On macOS/Windows (case-insensitive FS), lower-case. Use `process.platform === 'linux'` to decide — this is the extension host, where `process` is available.
- The helper should be memoized if called frequently (the existing `resolveEffectiveWorkspaceRootFromMappings` already uses memoization via `getCachedMapping`).

## Verification Plan

### Automated Tests

Automated tests and compilation are skipped per session directives. All verification is via manual repro steps below and testing through an installed VSIX.

### Manual Verification

1. **Cold-open repro (Root cause A):** Close the Project panel completely. Open the kanban board. Click Review on a card. Expect: Project panel opens, Kanban tab activates, the plan is selected and its preview loads. (Validates the ready-handshake queue — message is no longer dropped on cold open.)
2. **Dropdown-switch repro (the reported bug — Root cause B):** Open the kanban board AND the Project panel. Switch the kanban workspace dropdown to a different workspace. Click Review on a card from the newly-selected workspace. Expect: Project panel's Kanban tab narrows to that workspace and selects the plan. Repeat for several workspace pairs, including a child workspace when mappings are enabled.
3. **Mapping repro (Root cause B — effective-root normalization):** With `workspaceDatabaseMappings` enabled (child → parent), select a child workspace in the dropdown and click Review. Expect selection to succeed (validates the `resolveEffectiveWorkspaceRoot` normalization in KanbanProvider.reviewPlan).
4. **Hidden-by-filter repro (Root cause B/C — force-clear):** Open the Project panel, narrow the workspace filter to workspace X. Then from the kanban board, click Review on a plan from workspace Y. Expect: the Project panel force-clears the filter, the plan becomes visible and is selected. (Validates the force-clear on `!itemDiv` when match exists.)
5. **Epic review (regression check):** Click Review on an epic card. Expect the Epics tab to activate and the epic to be selected (regression check — `tryResolvePendingEpicSelection` shares the filter-intent mechanism and has the same `!itemDiv` dead-end pattern).
6. **No-regression:** Review a plan with no workspace switch — still works as before.
7. **Reveal-existing-panel:** With the Project panel already open, click Review on a kanban card. Expect: messages are delivered immediately (not queued), selection works. (Validates that `_projectPanelReady` is NOT reset on the reveal path.)

## Future

- Apply the same ready-handshake to the planning.html sidebar webview if it has analogous cold-open races.
- Apply the same `!itemDiv` force-clear fix to `tryResolvePendingEpicSelection` (project.js:1579-1597) — it has the identical dead-end pattern (line 1591: bare `return`, no retry increment).
- Route all proactive `kanbanPlansReady` pushes (PlanningPanelProvider.ts:3154, 3267, 3284, 3310) through `postMessageToProjectWebview` for consistency.
- Consider collapsing the kanban.html board and the project.html Kanban tab into a single webview to eliminate the cross-webview sync class of bugs entirely (large; separate epic).

## Research Confirmed

Both uncertain assumptions were confirmed via web research against official VS Code documentation, source code (`overlayWebview.ts`, `extHostWebview.ts`), and GitHub issues (#64597, #74568, #47534):

1. **VS Code webview `postMessage` delivery behavior:** Messages sent to a webview before its JS has registered a `message` listener are silently dropped by the browser engine (VS Code flushes its internal queue to the iframe as soon as HTML is dispatched, before the listener exists). `postMessage` resolves `true` even when dropped — it only resolves `false` if the panel is disposed or hidden without `retainContextWhenHidden`. The ready-handshake + queue fix is essential, not optional.
2. **`retainContextWhenHidden: true` scope:** This setting does NOT prevent the cold-load race — it only preserves DOM/JS state when an *already-loaded* panel is subsequently hidden. The cold-load race is identical with or without this setting.

Additionally, the research confirmed that the ready-handshake pattern is the **canonical VS Code-recommended approach** (core maintainers explicitly direct extension developers to use it), and that **FIFO ordering is guaranteed** in both directions of `postMessage` — validating the queue flush-in-insertion-order design.

## Recommendation

Complexity is 7 (High — new async pattern, cross-webview state synchronization, multiple race windows). **Send to Lead Coder.**

---

## Code Review Results (Reviewer Pass — 2026-06-30)

### Stage 1: Adversarial Findings

| # | Severity | File:Line | Finding |
|---|----------|-----------|---------|
| NIT-1 | NIT | `PlanningPanelProvider.ts:3017,3028` | `fetchKanbanPlans` response + error case still use direct `this._projectPanel?.webview.postMessage(...)` instead of `postMessageToProjectWebview(...)`. Safe — webview initiates fetch so it's guaranteed ready — but inconsistent with the 4 proactive pushes that were routed through the queue. |
| NIT-2 | NIT | `project.js:458` | Epics workspace filter intent uses bare `opts.includes(epicWs)` without `normalizeRoot`, while the kanban twin at lines 448-449 correctly normalizes both sides. Out of scope per plan but inconsistent. |
| NIT-3 | NIT | `project.js:1633` | `tryResolvePendingEpicSelection` still has the `!itemDiv` bare `return` dead-end (no force-clear, no retry increment). Explicitly deferred to Future section. |
| NIT-4 | NIT | `project.js:1565-1570` | `!match` 3-retry fallback clears `workspaceRoot`/`project`/`column` but not `complexity`/`search`. Pre-existing and moot — `_pendingKanbanSelection` is set to `null` at line 1571 before the re-fetch, so the re-fetched data won't trigger a selection anyway. |

**No CRITICAL findings. No MAJOR findings.**

### Stage 2: Balanced Synthesis

All four findings are NIT-level. No code fixes were applied:
- NIT-1: Defer — safe because the webview initiates `fetchKanbanPlans`; routing through the queue is cosmetic consistency only.
- NIT-2: Defer — out of scope (epics path); file as follow-up alongside NIT-3.
- NIT-3: Defer — explicitly out of scope per plan's Future section.
- NIT-4: Defer — pre-existing, moot because selection is abandoned before re-fetch.

### Implementation Audit (all requirements verified present)

| Requirement | Status | Location |
|-------------|--------|----------|
| `_projectPanelReady` + `_pendingProjectMessages` fields | ✅ | `PlanningPanelProvider.ts:69-70` |
| `_projectPanelReadyTimer` (10s timeout safeguard) | ✅ | `PlanningPanelProvider.ts:71,347-352` |
| `postMessageToProjectWebview` queues if not ready | ✅ | `PlanningPanelProvider.ts:756-762` |
| `_flushPendingProjectMessages` helper | ✅ | `PlanningPanelProvider.ts:764-774` |
| `case 'webviewReady'` before allRoots guard | ✅ | `PlanningPanelProvider.ts:2011-2013` |
| `_projectPanelReady = false` after early return in `openProject()` | ✅ | `PlanningPanelProvider.ts:338` (after early return at 326) |
| `onDidDispose` cleanup | ✅ | `PlanningPanelProvider.ts:374-379` |
| `vscode.postMessage({ type: 'webviewReady' })` after listener | ✅ | `project.js:1090` (listener at 385) |
| Force-clear on `!itemDiv` when match exists | ✅ | `project.js:1578-1612` |
| Force-clear clears complexity filter too | ✅ | `project.js:1591-1592` |
| `_pendingKanbanFilterIntent = null` to break re-narrow loop | ✅ | `project.js:1593` |
| Re-render + re-query after force-clear | ✅ | `project.js:1594-1595` |
| Retry counter incremented if still hidden | ✅ | `project.js:1608` |
| `normalizeRoot` on filter-intent workspaceRoot check | ✅ | `project.js:448-449` |
| `normalizeRoot` on `getFilteredKanbanPlans` comparison | ✅ | `project.js:1386` |
| No lower-casing added to `normalizeRoot` | ✅ | `project.js:1196-1200` |
| `resolveEffectiveWorkspaceRoot` in `reviewPlan` | ✅ | `KanbanProvider.ts:6917-6918` |
| `resolveEffectiveWorkspaceRoot` in `activatePlanInProjectPanel` | ✅ | `KanbanProvider.ts:212-213` |
| Empty workspaceRoot guard (`getCurrentWorkspaceRoot` fallback) | ✅ | `KanbanProvider.ts:6917,212` |
| Both paths route through `postMessageToProjectWebview` | ✅ | `KanbanProvider.ts:6919,214` |
| 4 proactive pushes routed through queue | ✅ | `PlanningPanelProvider.ts:3204,3317,3334,3360` |
| Optional `normalizeWorkspaceRoot` helper | ❌ Deferred | Plan says "optional" — acceptable |
| `tryResolvePendingEpicSelection` force-clear | ❌ Deferred | Plan says "out of scope" / "Future" |

### Files Changed (Implementation)

- `src/services/PlanningPanelProvider.ts` — ready-handshake + outbound queue, 10s timeout, `openProject()`/`onDidDispose` reset, `_flushPendingProjectMessages`, 4 proactive pushes routed through queue
- `src/webview/project.js` — `webviewReady` emission (line 1090), force-clear on `!itemDiv` in `tryResolvePendingKanbanSelection` (lines 1578-1612), `normalizeRoot` on filter-intent and `getFilteredKanbanPlans` (lines 448-449, 1386)
- `src/services/KanbanProvider.ts` — `resolveEffectiveWorkspaceRoot` + empty-root guard in `reviewPlan` (lines 6917-6918) and `activatePlanInProjectPanel` (lines 212-213), both routing through `postMessageToProjectWebview`

### Validation Results

- **Compilation:** Skipped per session directives.
- **Tests:** Skipped per session directives.
- **Code audit:** Complete — all in-scope requirements verified present and correctly implemented.
- **Manual repro:** To be run via installed VSIX by the user (see Verification Plan steps 1-7).

### Remaining Risks

1. **Epics review path** (`tryResolvePendingEpicSelection`, project.js:1621-1639) — same `!itemDiv` dead-end and missing `normalizeRoot` on workspace filter intent. Deferred to Future. Will manifest if an epic is hidden by a filter when Review is clicked.
2. **`fetchKanbanPlans` response bypasses queue** (PlanningPanelProvider.ts:3017,3028) — safe because webview initiates fetch, but if the panel is disposed and recreated between fetch and response, the response is silently dropped (mitigated by the new webview sending its own `fetchKanbanPlans` on load).
3. **`!match` 3-retry fallback** (project.js:1564-1574) — sets `_pendingKanbanSelection = null` before re-fetch, making the re-fetch useless for selection. Pre-existing; selection is abandoned after 3 retries.
