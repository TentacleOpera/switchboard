# Fix Create Plan Flow Across kanban.html, implementation.html, and project.html

## Goal

Make "Create Plan" work consistently from all three surfaces: add a Create button to the Project panel's Kanban Plans tab, remove the multi-second blocking sync that freezes the UI during creation, and route every creation path so it ends with the Project panel open, the Kanban Plans tab active, and the new plan selected and previewed.

## Metadata

**Tags:** frontend, backend, UI, UX, bugfix, testing
**Complexity:** 6

> Note: the original plan listed `api`, `ui`, `ux`. `api` is not an allowed tag (removed); `ui`/`ux` normalized to `UI`/`UX`; `testing` added (Phase 6 touches the test suite).

## User Review Required

The following decisions need explicit sign-off before coding, because they change behavior for entry points that currently behave differently:

1. **✅ APPROVED — Shared-function navigation side effect (intended).** `createDraftPlanTicket()` is the single shared entry point for all three create paths (sidebar `implementation.html`, kanban `+` button, and the new Project-panel button). Adding Project-panel navigation to `createDraftPlanTicket()` means the **sidebar** CREATE button — which today only opens the markdown file in an editor — will now **also force-open and reveal the Project panel** on the Kanban Plans tab. **User confirmed (2026-06-19): yes, the sidebar Create is meant to force-open the Project panel.** This matches Problem #3's stated expectation for every path.
2. **✅ APPROVED — Removing the post-creation sync.** Deleting `await this._syncFilesAndRefreshRunSheets(workspaceRoot)` means the sidebar run-sheet dropdown is no longer eagerly refreshed at creation time. It still refreshes on the next natural cycle. **User confirmed (2026-06-19): fine to remove the eager sync** (full delete, not fire-and-forget).
3. **✅ APPROVED — Button styling.** The Project panel strip uses a single `strip-btn` class (there is no accent/colour variant such as `is-teal`). The new Create button uses plain `strip-btn` to match. **User confirmed (2026-06-19): no distinct visual treatment required.**

## Complexity Audit

### Routine
- **Phase 1** — Add a `strip-btn` button to `project.html` + DOM ref and click handler in `project.js`. Mirrors the existing `btn-import-kanban-plans` wiring exactly.
- **Phase 2** — Add a `case 'createPlan'` to `PlanningPanelProvider._handleMessage` that executes `switchboard.initiatePlan`. Directly mirrors the proven `case 'createPlan'` already in `KanbanProvider` (line 5693).
- **Phase 4 helper** — `KanbanProvider.activatePlanInProjectPanel(planFile, workspaceRoot)` is a near-verbatim extraction of the existing `case 'reviewPlan'` open/reveal/post sequence (KanbanProvider.ts:5649-5670).
- **Phase 5** — Transient loading text on the create buttons; reuses existing CSS patterns.

### Complex / Risky
- **Phase 3 — Removing `await this._syncFilesAndRefreshRunSheets(workspaceRoot)` from the hot creation path.** Touches a shared method (`_createInitiatedPlan`) used by multiple create flows. Risk is data-freshness (sidebar dropdown briefly stale), not data-loss — the DB row is already written by `_registerPlan` before this line. Well-scoped, single-line deletion, but it changes timing behavior for every caller of `_createInitiatedPlan`.
- **Phase 4 — Navigation bolted onto the shared `createDraftPlanTicket()`.** Changes observable behavior for all three entry points simultaneously (see User Review #1). Low technical risk (idempotent open/reveal), but a cross-surface behavior change.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - Creation now returns before the sidebar run-sheet refresh runs. Because `_registerPlan` (TaskViewerProvider.ts:16040) calls `db.upsertPlans()` *before* the removed sync line (16081), the new plan is already in the DB when the Project panel's `fetchKanbanPlans` fires. No read-before-write race.
  - `activateKanbanTabAndSelectPlan` posts the selection, then `project.js` resolves it after the next `kanbanPlansReady`. If `kanbanPlansReady` has already fired before the message arrives, `tryResolvePendingKanbanSelection()` (project.js:506-522) is also invoked directly from the `activateKanbanTabAndSelectPlan` handler (project.js:204), so the pending selection resolves against the current `_kanbanPlansCache` without waiting for another refresh. Both orderings are covered.
- **Security:** None. No new input surfaces, no new file paths derived from user input, no privilege changes.
- **Side Effects:**
  - The sidebar CREATE path gains Project-panel navigation (User Review #1).
  - `_syncFilesAndRefreshRunSheets` is removed only from `_createInitiatedPlan`; its other call sites (e.g. TaskViewerProvider.ts:2432, 4642, 7892) are untouched.
- **Dependencies & Conflicts:**
  - `GlobalPlanWatcherService` **intentionally skips** plans created through `createDraftPlanTicket` via its `_pendingCreations` guard (`registerPendingCreation` is called at TaskViewerProvider.ts:15879 and 16019; the guard is at GlobalPlanWatcherService.ts:438). **Therefore the watcher is NOT the mechanism that surfaces newly-created plans** — the create flow inserts the DB row itself. Any reasoning that relies on "the watcher will pick it up" is incorrect for this flow and must not be used as the safety justification.
  - The Project panel's Kanban Plans tab (`project.html` / `project.js`) is served by `PlanningPanelProvider._handleMessage(msg, isProject=true)` — that is why Phase 2's `createPlan` handler must live in `PlanningPanelProvider`, not `KanbanProvider`.

## Dependencies

- `sess_XXXXXXXXXXXXX — create-plan-flow` *(no upstream session dependencies identified; this plan is self-contained against the current `main`/`develop` source.)*

## Adversarial Synthesis

**Risk Summary:** Key risks are (1) a brief stale sidebar run-sheet dropdown after removing the eager sync, (2) a cross-surface behavior change where the sidebar CREATE button now also opens the Project panel, and (3) phantom symbols in the original draft (`_getSessionIdFromPlanFile`, `postMessageToKanbanWebview`, `is-teal`) that do not exist in the codebase. Mitigations: the new plan is already in the DB before the sync was removed (so freshness, not correctness, is the only cost); the navigation change is the explicit product goal and is flagged for sign-off; and all phantom symbols have been replaced with verified real symbols (`strip-btn`, planFile-only `activatePlanInProjectPanel`, `KanbanProvider.postMessage`).

---

## Problem Statement *(preserved from original)*

The "Create Plan" functionality is broken across three surfaces:

1. **project.html has no create button** — The kanban plans tab inside the Project panel has workspace/project/column filters, Import, Edit, Save, Cancel, and Search, but no "Create Plan" button at all. Users must leave the Project panel and open the separate kanban.html or implementation.html sidebar to create a plan.

2. **Plan creation is laggy with no feedback** — Clicking "Create Plan" in kanban.html or implementation.html triggers `TaskViewerProvider.createDraftPlanTicket()` → `_createInitiatedPlan()`. Inside `_createInitiatedPlan()`, the heavy `await this._syncFilesAndRefreshRunSheets(workspaceRoot)` is blocking. This method rescans Antigravity brain directories, rescans flat-plan scanner candidates, reconciles orphans, and refreshes the entire kanban DB state. On large workspaces this takes multiple seconds. There is no loading spinner or progress indication during this time; the UI appears frozen.

3. **Created plan is not opened in project.html** — After creation, `_openPlanInReviewPanel()` opens the raw markdown file in the VS Code editor, and `selectPlanFile` is posted to the sidebar (`implementation.html`). The Project panel (`project.html`) is never opened, never switched to the kanban plans tab, and never shows the newly created plan selected. The only visible outcome is the plan silently appearing on the kanban board (if it's open elsewhere). The user expectation is: create plan → Project panel opens → Kanban Plans tab active → New plan selected and previewed.

## Root Cause Analysis *(preserved, with verified corrections)*

- **Missing button**: `project.html` kanban controls strip simply never had a create button added when the kanban tab was moved into the Project panel.
  - **Correction (verified):** the strip is `<div class="kanban-controls-strip">` spanning **project.html:991-1006** (closing `</div>` at 1006), not 991-1001. The Import button is `<button id="btn-import-kanban-plans" class="strip-btn" ...>Import</button>` at **project.html:1001**. "Search" is an `<input id="kanban-search" class="sidebar-search-input">` at line 1005, not a button. **There is no `is-teal` class** in `project.html`; every strip button uses bare `strip-btn`.
- **Lag**: `_createInitiatedPlan()` in `TaskViewerProvider.ts` awaits `_syncFilesAndRefreshRunSheets()` at **line 16081**. This is a post-mutation heavy sync (Antigravity rescan + DB reconcile + run-sheet refresh). It is unnecessary to block the UI on this.
  - **Correction (verified):** do **not** justify this with "the file watcher will pick it up." `GlobalPlanWatcherService` deliberately ignores plans created via this flow (`_pendingCreations` guard, GlobalPlanWatcherService.ts:438). The correct safety basis is that `_registerPlan` (TaskViewerProvider.ts:16040) already inserted the row via `db.upsertPlans()` *before* line 16081.
- **No navigation to project panel**: `createDraftPlanTicket()` only calls `_openPlanInReviewPanel()`. It does not interact with `PlanningPanelProvider`. The `activateKanbanTabAndSelectPlan` message type exists in `project.js` and is used by `KanbanProvider`'s `reviewPlan` case, but plan creation never uses it. `TaskViewerProvider` has `_kanbanProvider` (field at TaskViewerProvider.ts:344) but no direct reference to `PlanningPanelProvider`.
  - **Correction (verified):** `_openPlanInReviewPanel` (TaskViewerProvider.ts:15457) is a thin wrapper around `vscode.commands.executeCommand('vscode.open', ...)` — it opens the markdown file in a standard editor; there is no dedicated review-panel UI. `reviewPlan` is a `case` in `KanbanProvider._handleMessage` (KanbanProvider.ts:5649-5670), not a method.

## Constraints & Assumptions *(preserved)*

- `project.html` uses external JS (`project.js`); HTML changes must be accompanied by corresponding JS event wiring.
- The `activateKanbanTabAndSelectPlan` message handler in `project.js` (handler at project.js:185, fallback resolver `tryResolvePendingKanbanSelection()` at project.js:506-522) already handles tab activation, filter reset, cache resolution, and selection. Reuse it.
- `_syncFilesAndRefreshRunSheets()` must still run eventually (to keep the sidebar plan dropdown and kanban board in sync), but it can be fire-and-forget for the creation path.
- A loading indicator should be minimal and consistent with existing UI patterns (the sidebar already uses `.loading` + `.select-arrow.loading` spinners).

---

## Proposed Changes

### `src/webview/project.html`

- **Context:** Kanban controls strip at lines 991-1006. Import button (`btn-import-kanban-plans`) at line 1001 uses class `strip-btn`. No Create button exists.
- **Logic:** Add a Create button to the strip, after the Import button, matching the existing `strip-btn` styling.
- **Implementation** (around line 1001, after the Import button):
  ```html
  <button id="btn-create-kanban-plan" class="strip-btn" title="Create a new plan">Create</button>
  ```
  > **Correction vs. original draft:** original specified `class="strip-btn is-teal"`. `is-teal` does not exist anywhere in `project.html`. Use bare `strip-btn`.
- **Edge Cases:** Button must sit inside the same flex strip so it inherits layout; keep it before/around the Edit/Save/Cancel cluster so it is always visible regardless of edit mode (verify it is not hidden by any edit-mode toggling logic in `project.js`).

### `src/webview/project.js`

- **Context:** DOM-reference block begins ~line 110 (`// Elements`); `btnImportKanbanPlans` ref at line 115; its click handler at lines 652-656 posts `{ type: 'importPlans' }`. `activateKanbanTabAndSelectPlan` handler at line 185 with `_pendingKanbanSelection` (declared line 102) and `tryResolvePendingKanbanSelection()` (lines 506-522). `fetchKanbanPlans` posted at lines 30/32/146/226/236; `kanbanPlansReady` handled at line 152.
- **Logic:** Add a DOM ref and click handler mirroring `btnImportKanbanPlans`. Post `createPlan`. Add a transient loading state cleared on `kanbanPlansReady` or a new `planCreated` message.
- **Implementation:**
  - DOM ref near line 115:
    ```js
    const btnCreateKanbanPlan = document.getElementById('btn-create-kanban-plan');
    ```
  - Click handler near line 652 (alongside the `btnImportKanbanPlans` handler):
    ```js
    if (btnCreateKanbanPlan) {
        btnCreateKanbanPlan.addEventListener('click', () => {
            btnCreateKanbanPlan.disabled = true;
            btnCreateKanbanPlan.textContent = 'Creating...';
            vscode.postMessage({ type: 'createPlan' });
        });
    }
    ```
  - Restore the button in the `kanbanPlansReady` handler (line 152) and/or on receipt of `planCreated`:
    ```js
    if (btnCreateKanbanPlan) {
        btnCreateKanbanPlan.disabled = false;
        btnCreateKanbanPlan.textContent = 'Create';
    }
    ```
- **Edge Cases:** If creation fails (no `kanbanPlansReady`/`planCreated` ever arrives), the button stays in "Creating..." state. Add a safety timeout (~3s) to restore the button, or restore it on any subsequent error message the panel already handles.

### `src/services/PlanningPanelProvider.ts`

- **Context:** `_handleMessage(msg, isProject = false)` at line 1223 serves both planning and project webviews; it has kanban cases (`fetchKanbanPlans` at 2089, `openKanbanPlan` at 2159, etc.) but **no `createPlan` case**. The project panel's Kanban tab posts here. Methods `hasProjectPanel()` (589), `openProject()` (271), `isProjectInCurrentWindow()` (593), `revealProject()` (581), `postMessageToProjectWebview()` (597) all exist with these exact names.
- **Logic:** Add a `createPlan` case that delegates to the same registered command the kanban `+` button uses, so all paths converge on `createDraftPlanTicket()`.
- **Implementation** (alongside the existing kanban cases):
  ```ts
  case 'createPlan': {
      await vscode.commands.executeCommand('switchboard.initiatePlan');
      break;
  }
  ```
  This mirrors `KanbanProvider`'s existing `case 'createPlan'` (KanbanProvider.ts:5693 → executes `switchboard.initiatePlan`, registered at extension.ts:672).
- **Edge Cases:** Ensure the case is reachable for `isProject === true` (the project webview). The command resolves to `taskViewerProvider?.createDraftPlanTicket()`; if `taskViewerProvider` is undefined the optional chain no-ops silently — acceptable.

### `src/services/TaskViewerProvider.ts`

#### Phase 3 — Eliminate creation lag

- **Context:** `_createInitiatedPlan` (declared line 15991, returns `{ planFileAbsolute }` at 16092) calls `_registerPlan` at line 16040 (→ `db.upsertPlans()` at 10603-10625), then at lines 16081-16082:
  ```ts
  await this._syncFilesAndRefreshRunSheets(workspaceRoot);                                  // 16081
  this._view?.webview.postMessage({ type: 'selectPlanFile', planFile: planFileRelative });  // 16082
  ```
  `_syncFilesAndRefreshRunSheets` (14246-14262) calls `_rescanAntigravityPlanSources` then `_refreshRunSheets`. `selectPlanFile` is **dead code**: verified no handler in any webview (`implementation.html` handles only `runSheets` at 2217 and `selectSession` at 2232). Note `selectPlanFile` has **three producers** (TaskViewerProvider.ts:4643, 4738, 16082), only 16082 is on this path.
- **Logic:** Delete both lines from `_createInitiatedPlan`. The plan is already persisted by `_registerPlan`; every UI surface fetches from the DB on its own schedule.
- **Implementation:**
  ```ts
  // OLD (lines 16081-16082):
  await this._syncFilesAndRefreshRunSheets(workspaceRoot);
  this._view?.webview.postMessage({ type: 'selectPlanFile', planFile: planFileRelative });

  // NEW: delete both lines. Nothing replaces them on this path.
  ```
  Why safe (corrected): `_registerPlan` already inserted the plan via `db.upsertPlans()` before line 16081; the Project panel's `fetchKanbanPlans` reads the DB and returns the new plan; `selectPlanFile` has no consumer. **Do NOT cite the file watcher** — `GlobalPlanWatcherService` deliberately skips this flow via `_pendingCreations`.
- **Edge Cases:** Other callers of `_syncFilesAndRefreshRunSheets` are untouched. The sidebar run-sheet dropdown will not eagerly refresh on creation; it refreshes on the next natural cycle (acceptable per User Review #2). If `planFileRelative` becomes unused after deletion, remove or `void`-mark it to avoid a lint warning.

#### Phase 4 — Navigate to Project panel and select the new plan

- **Context:** `createDraftPlanTicket()` (line 15461) currently does `const { planFileAbsolute } = await this._createInitiatedPlan(...)` (15474) then `await this._openPlanInReviewPanel(planFileAbsolute, title)` (15475). It has `_kanbanProvider` (344) and `_resolveWorkspaceRoot()` (974). **`_getSessionIdFromPlanFile` does NOT exist** (the registry helper is `_getRegistrySessionId`).
- **Logic:** After creation, derive the relative plan path and ask `KanbanProvider` to open/reveal the Project panel and select the plan. Use the **planFile-only** signature — do not attempt to derive a sessionId, because the `project.js` resolver already falls back to `planFile` matching.
- **Implementation** (in `createDraftPlanTicket`, after `_createInitiatedPlan` returns, before/around `_openPlanInReviewPanel`):
  ```ts
  const { planFileAbsolute } = await this._createInitiatedPlan(title, idea, false, { createdAt, projectName });
  const workspaceRoot = this._resolveWorkspaceRoot();
  if (workspaceRoot && this._kanbanProvider) {
      const planFileRelative = path.relative(workspaceRoot, planFileAbsolute).replace(/\\/g, '/');
      await this._kanbanProvider.activatePlanInProjectPanel(planFileRelative, workspaceRoot);
  }
  await this._openPlanInReviewPanel(planFileAbsolute, title);
  // Clear any sidebar/project loading state:
  this._view?.webview.postMessage({ type: 'planCreated' });
  ```
  > **Correction vs. original draft:** the original offered a first variant calling `this._getSessionIdFromPlanFile(...)` — that method does not exist. Use the planFile-only `activatePlanInProjectPanel(planFile, workspaceRoot)` signature (the original's "Simpler alternative (preferred)"). If a sessionId is ever genuinely needed, use `_getRegistrySessionId`, not the phantom method.
- **Edge Cases:** All three entry points now route through this navigation (User Review #1). `activatePlanInProjectPanel` is idempotent: if the Project panel is already open and on the Kanban tab (the in-panel Create button case), it reveals + re-selects, which is harmless.

#### Phase 5 — Loading-state clear message

- **Context:** The sidebar webview is `_view` (implementation.html). The kanban webview helper is `KanbanProvider.postMessage` (KanbanProvider.ts:1280) — **there is no `postMessageToKanbanWebview`**. The Project panel uses `PlanningPanelProvider.postMessageToProjectWebview`.
- **Logic:** After `_createInitiatedPlan` completes in `createDraftPlanTicket`, post a `planCreated` message so each surface can clear its transient loading state.
- **Implementation:**
  ```ts
  this._view?.webview.postMessage({ type: 'planCreated' });
  this._kanbanProvider?.postMessage?.({ type: 'planCreated' });
  // Project panel clearing is handled by the kanbanPlansReady refresh triggered by activatePlanInProjectPanel.
  ```
  > **Correction vs. original draft:** original used `this._kanbanProvider?.postMessageToKanbanWebview?.(...)`. Use `postMessage` (the real helper name at KanbanProvider.ts:1280).
- **Edge Cases:** `planCreated` is additive — webviews that don't handle it ignore it. Guarantee the create buttons in all three webviews also restore on `kanbanPlansReady` so a missing `planCreated` never strands them.

### `src/services/KanbanProvider.ts`

- **Context:** `_planningPanelProvider` field at line 161, `setPlanningPanelProvider` at 163. The `case 'reviewPlan'` (5649-5670) already implements the exact open/reveal/post pattern. `activatePlanInProjectPanel` does **not** exist yet. The webview post helper is `postMessage` (1280).
- **Logic:** Extract the `reviewPlan` open/reveal/post sequence into a reusable public method that `TaskViewerProvider` (Phase 4) can call.
- **Implementation** (planFile-only signature):
  ```ts
  public async activatePlanInProjectPanel(planFile: string, workspaceRoot: string): Promise<void> {
      if (!this._planningPanelProvider) { return; }
      if (!this._planningPanelProvider.hasProjectPanel()) {
          await this._planningPanelProvider.openProject();
      } else if (this._planningPanelProvider.isProjectInCurrentWindow()) {
          this._planningPanelProvider.revealProject();
      }
      this._planningPanelProvider.postMessageToProjectWebview({
          type: 'activateKanbanTabAndSelectPlan',
          planId: '',
          sessionId: '',
          planFile: planFile || '',
          workspaceRoot: workspaceRoot || ''
      });
  }
  ```
  The existing `project.js` handler for `activateKanbanTabAndSelectPlan` (line 185) stores the pending selection and resolves it via `tryResolvePendingKanbanSelection()` (506-522), whose OR-chain `(sel.planFile && p.planFile === sel.planFile) || ...` falls back to `planFile` when `planId`/`sessionId` are empty.
- **Edge Cases:** If the Project panel exists in another VS Code window, `isProjectInCurrentWindow()` is false and we only post (no reveal) — matching the deliberate `reviewPlan` behavior (prevents stealing the panel across windows).

### `src/webview/implementation.html` and `src/webview/kanban.html`

- **Context:** `implementation.html` create button `btn-create-plan` (line 1535) posts `{ type: 'createDraftPlanTicket' }` (handler 1653-1655). `kanban.html` create button `btn-add-plan` (the `+` in the CREATED column header, line 4168) posts `{ type: 'createPlan' }` (handler 4273-4275).
- **Logic:** Add brief, non-blocking visual feedback on click; clear it on `planCreated` or `kanbanPlansReady`.
- **Implementation:**
  - `implementation.html`: on `btn-create-plan` click, swap text to "Creating..." / disable; restore on `planCreated`.
  - `kanban.html`: on `btn-add-plan` click, apply a brief opacity/disabled state; restore on `planCreated`.
- **Edge Cases:** Since creation is now non-blocking and fast (file write + DB insert only), the feedback is mostly cosmetic; ensure it always restores even if the clear message is missed (timeout fallback).

## Files Changed *(preserved)*

- `src/webview/project.html`
- `src/webview/project.js`
- `src/services/TaskViewerProvider.ts`
- `src/services/KanbanProvider.ts`
- `src/services/PlanningPanelProvider.ts`
- `src/test/direct-create-ticket-regression.test.js` *(corrected path: `src/test/`, not `test/`)*
- `src/test/project-panel-kanban-create-button.test.js` (new) *(corrected path: `src/test/`)*

## Verification Plan

> Per session directives: do NOT run compilation; the user runs the test suite separately.

### Automated Tests

The existing regression test (`src/test/direct-create-ticket-regression.test.js`) is a **static source-scan test** (it greps source files for substring presence/absence), not a runtime/behavioral test. New assertions must follow that same string-presence pattern, and any "no longer awaits the sync" assertion must be written as a tolerant absence-check, not a brittle exact-line match.

- **`src/test/direct-create-ticket-regression.test.js`** (update):
  1. Assert `TaskViewerProvider.ts` source contains `activatePlanInProjectPanel` (Phase 4 wiring is present).
  2. Assert `KanbanProvider.ts` source defines `public async activatePlanInProjectPanel(`.
  3. Assert `_createInitiatedPlan` no longer contains the `selectPlanFile` postMessage *on this path* — express as a source-substring check tolerant to formatting (acknowledge `selectPlanFile` still legitimately appears at lines 4643/4738).
- **`src/test/project-panel-kanban-create-button.test.js`** (new):
  1. Assert `project.html` contains `id="btn-create-kanban-plan"` with class `strip-btn` (and NOT `is-teal`).
  2. Assert `project.js` posts `{ type: 'createPlan' }` from the new button handler.
  3. Assert `PlanningPanelProvider.ts` has a `case 'createPlan'` that executes `switchboard.initiatePlan`.

### Manual Validation Steps *(preserved from original)*

1. Open Project panel → Kanban Plans tab. Click "Create". A new plan should be created, the Project panel should stay focused, the kanban plans list should refresh, and the new "Untitled Plan" should be selected with its preview shown.
2. Open kanban.html. Click "+" in the CREATED column. The plan should be created quickly (sub-second), project.html should open/focus, and the new plan should be selected.
3. Open implementation.html sidebar. Click "CREATE". Same behavior as #2 (note: this now also opens the Project panel — confirm this is the intended behavior per User Review #1).
4. Create a plan in a large workspace (many existing plans). Creation should complete in <1s without UI freezing.

---

## Risks *(preserved, with verified corrections)*

- **Stale sidebar dropdown (was "Race condition")**: Making the post-creation sync fire-and-forget (here: removed) means the sidebar run-sheet dropdown might briefly show stale state until the next natural refresh. **Correction:** the original claimed "the `selectPlanFile` message to the sidebar is still sent immediately" — that message is dead code and is being deleted; it provides no mitigation. The actual mitigation is that the DB row already exists (`_registerPlan`), so every surface that fetches from the DB is correct. Risk is low.
- **Project panel not focused**: If the user has the Project panel open in a different VS Code window, `isProjectInCurrentWindow()` returns false and we only message it without revealing. Intentional (matches `reviewPlan`).
- **Phantom symbols (new)**: The original draft referenced `_getSessionIdFromPlanFile`, `postMessageToKanbanWebview`, and the `is-teal` class — none exist. All replaced with verified symbols (`_getRegistrySessionId` if needed, `postMessage`, `strip-btn`). Coders must use the corrected names.
- **Shared-function behavior change (new)**: Navigation is added to the shared `createDraftPlanTicket()`, changing the sidebar path's behavior. Intended per Problem #3, flagged in User Review #1.

---

## Recommendation

Complexity **6** (mixed: mostly routine, well-scoped wiring that reuses proven patterns, with two moderate cross-surface risks in Phases 3 and 4). **Send to Coder** — provided the three User Review items are signed off first.
