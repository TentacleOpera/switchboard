# Fix: "Review Plan" on an Epic Card Opens the Kanban Plans Tab Instead of the Epics Tab

## Goal

When the user clicks the **Review** ("Review plan") button on an **epic** card in `kanban.html`, the Project panel (`project.html`) opens on the **KANBAN PLANS** tab and tries to select the epic there. Because epics are rendered in the **EPICS** tab (not the kanban plans list), the selection silently fails to land where the user expects — they wanted to review the epic in its dedicated Epics view.

### Problem analysis & root cause

The review flow is a three-hop message chain, and the **epic context is dropped at hop 1 and never restored**:

1. **kanban.html (webview) — epic flag not sent.** The review button click handler posts a `reviewPlan` message that includes `sessionId`, `planId`, `planFile`, and `workspaceRoot` — but **not** whether the card is an epic:
   - `src/webview/kanban.html:5182-5186` — the `.card-btn.review` click handler.
   - `src/webview/kanban.html:5184` — `postKanbanMessage({ type: 'reviewPlan', sessionId, planId, planFile, workspaceRoot })`.
   - The card data already exposes `card.isEpic` / `card.epicId` (used elsewhere, e.g. `src/webview/kanban.html:5158-5164`, `5354-5358`), so the flag is available locally but is not attached to the message.

2. **KanbanProvider.ts — handler forwards without epic context.** The `reviewPlan` case opens/targets the Project panel and forwards an `activateKanbanTabAndSelectPlan` message, again with no epic flag:
   - `src/services/KanbanProvider.ts:6272-6292` — `case 'reviewPlan'` (NOTE: earlier drafts cited 6181-6202; the actual location is 6272-6292).
   - `src/services/KanbanProvider.ts:6284-6290` — `postMessageToProjectWebview({ type: 'activateKanbanTabAndSelectPlan', planId, sessionId, planFile, workspaceRoot })`.

3. **project.js — unconditionally activates the Kanban tab.** The receiver always clicks the `kanban` tab and resolves the selection against the kanban plans list:
   - `src/webview/project.js:339-361` — `case 'activateKanbanTabAndSelectPlan'`.
   - `src/webview/project.js:357-358` — `document.querySelector('.shared-tab-btn[data-tab="kanban"]').click()` (hard-coded `kanban`).
   - `src/webview/project.js:988-1004` — `tryResolvePendingKanbanSelection()` searches `_kanbanPlansCache` and clicks a `.kanban-plan-item` — which never contains epic rows.

**Root cause:** the epic/non-epic distinction is known at the click site but is never propagated through the `reviewPlan` → `activateKanbanTabAndSelectPlan` chain, and the project-panel receiver hard-codes the `kanban` tab. Epics live in the EPICS tab (`renderEpicsList()` builds its list from `_kanbanPlansCache.filter(plan => plan.isEpic)` plus `_epicDocumentsCache` — `src/webview/project.js:1216-1219`), so an epic target can never resolve in the kanban list.

**Fix in one line:** carry an `isEpic` flag through the chain and, when set, activate the EPICS tab and resolve the selection there (mirroring the existing kanban-selection resolver).

## Metadata

- **Tags:** `frontend`, `ui`, `bugfix`
- **Complexity:** 4 / 10
- **Affected components:** `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/webview/project.js`
- **Migration required:** No (no persisted state or schema changes; pure message-plumbing + UI routing).

## User Review Required

Yes — this plan changes the routing of an existing user-facing button ("Review Plan" on epic cards). The user should confirm that the desired behavior is: clicking Review on an epic card opens the **EPICS** tab (not the KANBAN PLANS tab) and selects/scrolls to that epic. No code changes should proceed until this is confirmed.

## Complexity Audit

### Routine
- Adding one boolean (`isEpic`) to the `reviewPlan` message object in `kanban.html` (hop 1) — trivial, the flag is already available on the card data.
- Forwarding `isEpic` through `KanbanProvider.ts` `case 'reviewPlan'` (hop 2) — one added property on an existing `postMessageToProjectWebview` call.
- Branching on `msg.isEpic === true` in `project.js` `case 'activateKanbanTabAndSelectPlan'` (hop 3) — a single `if` gate that preserves the existing non-epic path byte-for-byte.
- Adding `data-plan-id` to the `.epic-plan-item` div in `renderEpicsList()` — one line, mirroring the attribute already on the inner `.epic-accordion`.

### Complex / Risky
- The new `tryResolvePendingEpicSelection()` resolver must search **two** epic sources (DB epics from `_kanbanPlansCache.filter(p => p.isEpic)` AND standalone epic documents from `_epicDocumentsCache`) and handle the cold-cache deferred-resolution pattern. This mirrors the proven `tryResolvePendingKanbanSelection()` but is genuinely new logic, not a copy-paste.
- The resolver must be wired into **both** `renderEpicsList()` call sites (lines 304 and 368), and the second site (`epicDocumentsReady`, line 368) currently has **no** existing `tryResolvePendingKanbanSelection()` call after it — so the implementer must not miss it.

## Edge-Case & Dependency Audit

- **Non-epic cards must keep working.** When `isEpic` is falsy, behaviour must be byte-for-byte identical to today (activate `kanban` tab, resolve via `tryResolvePendingKanbanSelection`). The branch is gated strictly on `msg.isEpic === true`.
- **Standalone epic documents.** Epics in the EPICS tab come from two sources: DB epics (`_kanbanPlansCache.filter(p => p.isEpic)`) and standalone epic documents (`_epicDocumentsCache`). The epic resolver must search both so a standalone epic document still resolves. Match priority should be `planFile` → `planId` → `sessionId`, identical to `tryResolvePendingKanbanSelection`.
- **Timing / cache not yet loaded.** `tryResolvePendingKanbanSelection` handles the "cache not ready yet" case by returning early and being re-invoked after the list renders (`renderEpicsList()` is called on `kanbanPlansLoaded` at `src/webview/project.js:304` and on `epicDocumentsReady` at `src/webview/project.js:368`). The epic resolver must follow the same pattern: store `_pendingEpicSelection`, attempt resolution now, and re-attempt after every `renderEpicsList()` call. **Important:** the `epicDocumentsReady` call site (line 368) currently has NO `tryResolvePendingKanbanSelection()` after it — the implementer must add `tryResolvePendingEpicSelection()` after BOTH renderEpicsList calls (lines 304 and 368).
- **Epics tab click handler confirmed.** Clicking `data-tab="epics"` fires `fetchKanbanPlans` AND `fetchEpicDocuments` (`src/webview/project.js:35-38`), which populates both `_kanbanPlansCache` and `_epicDocumentsCache` and triggers `renderEpicsList()` via the `kanbanPlansLoaded`/`epicDocumentsReady` handlers. So clicking the epics tab does kick off the needed fetches — no extra fetch logic is required.
- **`epicsWorkspaceFilter` exists.** The DOM element `epicsWorkspaceFilter` is defined at `src/webview/project.js:213`, and the `epicsFilters` object (`{ workspaceRoot: '' }`) is at `src/webview/project.js:275`. Both are confirmed present — no fallback handling is needed. Clear `epicsFilters.workspaceRoot = ''` and set `epicsWorkspaceFilter.value = ''` before activating the epics tab, mirroring how the kanban path clears its filters at lines 350-355.
- **`epicId` vs `planId`.** For DB epics, the epic's own card id is its `planId`; `epicId` on a *subtask* points back to its parent. The review button is on the epic card itself, so pass the epic's `planId`/`sessionId` as the selection key — do **not** use `epicId` (that field is empty on the epic card). Only the boolean `isEpic` needs to cross the wire.
- **No confirmation dialogs** introduced (per project rule).
- **Shared `_kanbanPreviewRequestId` counter.** Both `loadKanbanPlanPreview` (`project.js:1014`) and `selectEpic` (`project.js:1297`) increment the same `_kanbanPreviewRequestId` counter when sending `fetchKanbanPlanPreview`. This is safe — the response handler (`kanbanPlanPreviewReady`, line 313) disambiguates by checking `_kanbanSelectedPlan.planFile === msg.filePath` (kanban) vs `_epicPreviewFilePath === msg.filePath` (epics). No collision risk; no change needed.
- **Other `activateKanbanTabAndSelectPlan` callers (out of scope, documented for safety):**
  - `KanbanProvider.ts:186-193` (`activatePlanInProjectPanel`) — called from `TaskViewerProvider.ts:15985` after creating a **new (non-epic) plan** with `autoEdit: true`. It does not pass `isEpic`, so it falls through to the kanban path — correct for its use case. Not modified by this plan.
  - `planning.js:3673` — a parallel handler in the legacy `planning.html` webview. The `reviewPlan` flow routes to `project.html` via `postMessageToProjectWebview` (not planning.html), so this handler is not reached by the Review button. Not modified by this plan.

## Dependencies

- None — this is a self-contained bugfix with no prerequisite plans.

## Adversarial Synthesis

**Key risks:** (1) the original plan cited wrong line numbers for `KanbanProvider.ts` (off by ~90 lines) which would send an implementer to the wrong code; (2) the `epicDocumentsReady` render path (line 368) has no existing resolver call and is easy to miss; (3) the `.epic-plan-item` div lacks `data-plan-id`, so the resolver's querySelector would silently fail without the one-line addition to `renderEpicsList`. **Mitigations:** line numbers corrected to 6272-6292; resolver wired into both render call sites (304 and 368); `data-plan-id` addition explicitly called out as a required step.

## Proposed Changes

### 1. `src/webview/kanban.html` — attach the epic flag to the `reviewPlan` message

At the review-button click handler (`src/webview/kanban.html:5182-5186`), look up the card (the same lookup pattern already used at line 5158) and include `isEpic`:

```js
document.querySelectorAll('.card-btn.review').forEach(btn => {
    btn.addEventListener('click', () => {
        const pid = btn.dataset.planId || btn.dataset.session || '';
        const cardData = currentCards.find(c => (c.planId || c.sessionId) === pid);
        postKanbanMessage({
            type: 'reviewPlan',
            sessionId: btn.dataset.session || '',
            planId: btn.dataset.planId || '',
            planFile: btn.dataset.planFile || '',
            workspaceRoot: btn.dataset.workspaceRoot,
            isEpic: cardData?.isEpic || false
        });
    });
});
```

### 2. `src/services/KanbanProvider.ts` — forward the epic flag

In `case 'reviewPlan'` (`src/services/KanbanProvider.ts:6272-6292`), pass `isEpic` straight through to the project webview message (`src/services/KanbanProvider.ts:6284-6290`):

```ts
this._planningPanelProvider.postMessageToProjectWebview({
    type: 'activateKanbanTabAndSelectPlan',
    planId: msg.planId || '',
    sessionId: reviewId,
    planFile: msg.planFile || '',
    workspaceRoot: msg.workspaceRoot || '',
    isEpic: msg.isEpic === true
});
```

(No DB round-trip needed — the webview already knows the flag. If defensive verification is ever wanted, `db.getPlanBySessionId(reviewId)` exposes `isEpic`, but it is unnecessary here.)

### 3. `src/webview/project.js` — route epics to the EPICS tab

**3a.** Add a pending-epic-selection slot next to the existing kanban one (near `src/webview/project.js:169`, where `_pendingKanbanSelection` is declared):

```js
let _pendingEpicSelection = null;
```

**3b.** Branch in `case 'activateKanbanTabAndSelectPlan'` (`src/webview/project.js:339-361`). Insert the epic branch **before** the existing kanban path:

```js
case 'activateKanbanTabAndSelectPlan': {
    if (msg.isEpic === true) {
        _pendingEpicSelection = {
            planId: msg.planId || '',
            sessionId: msg.sessionId || '',
            planFile: msg.planFile || '',
            workspaceRoot: msg.workspaceRoot || ''
        };
        // Clear the epics workspace filter so the target epic is guaranteed
        // visible regardless of which workspace it belongs to.
        epicsFilters.workspaceRoot = '';
        if (epicsWorkspaceFilter) epicsWorkspaceFilter.value = '';
        // Activate the Epics tab — its click handler fires fetchKanbanPlans
        // and fetchEpicDocuments (project.js:35-38), populating both caches.
        const epicsTabBtn = document.querySelector('.shared-tab-btn[data-tab="epics"]');
        if (epicsTabBtn) epicsTabBtn.click();
        tryResolvePendingEpicSelection();
        break;
    }
    // ---- existing non-epic path unchanged below ----
    _pendingKanbanSelection = {
        planId: msg.planId || '',
        sessionId: msg.sessionId || '',
        planFile: msg.planFile || '',
        workspaceRoot: msg.workspaceRoot || ''
    };
    _pendingAutoEdit = msg.autoEdit === true;
    kanbanFilters.workspaceRoot = '';
    if (kanbanWorkspaceFilter) kanbanWorkspaceFilter.value = '';
    kanbanFilters.column = '';
    if (kanbanColumnFilter) kanbanColumnFilter.value = '';
    kanbanFilters.project = '';
    if (kanbanProjectFilter) kanbanProjectFilter.value = '';
    const kanbanTabBtn = document.querySelector('.shared-tab-btn[data-tab="kanban"]');
    if (kanbanTabBtn) kanbanTabBtn.click();
    tryResolvePendingKanbanSelection();
    break;
}
```

> `epicsWorkspaceFilter` is confirmed to exist at `src/webview/project.js:213` and `epicsFilters` at line 275 — no fallback is needed.

**3c.** Add `data-plan-id` to the `.epic-plan-item` div in `renderEpicsList()` (`src/webview/project.js:1245-1260`). Currently only the inner `.epic-accordion` carries `data-plan-id` (line 1256). Add it to the outer item div so the resolver can find it:

```js
filtered.forEach(plan => {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'epic-plan-item';
    itemDiv.dataset.planId = plan.planId || '';   // <-- ADD THIS LINE
    if (_epicSelectedPlan && _epicSelectedPlan.planId === plan.planId) {
        itemDiv.classList.add('selected');
    }
    // ...rest unchanged...
});
```

**3d.** Add the resolver, mirroring `tryResolvePendingKanbanSelection` (`src/webview/project.js:988-1004`), searching the epic sources used by `renderEpicsList` (`src/webview/project.js:1216-1219`):

```js
function tryResolvePendingEpicSelection() {
    if (!_pendingEpicSelection) return;
    const sel = _pendingEpicSelection;
    const pool = [..._kanbanPlansCache.filter(p => p.isEpic), ..._epicDocumentsCache];
    const match = pool.find(p =>
        (sel.planFile && p.planFile === sel.planFile) ||
        (sel.planId && p.planId === sel.planId) ||
        (sel.sessionId && p.sessionId === sel.sessionId)
    );
    if (!match) return;
    const itemDiv = epicsListPane &&
        epicsListPane.querySelector(`.epic-plan-item[data-plan-id="${match.planId}"]`);
    if (!itemDiv) return;
    itemDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.querySelectorAll('.epic-plan-item').forEach(el => el.classList.remove('selected'));
    itemDiv.classList.add('selected');
    selectEpic(match);
    _pendingEpicSelection = null;
}
```

**3e.** Re-attempt resolution after the epics list renders. `renderEpicsList()` is called at two sites:
- `src/webview/project.js:304` (inside `kanbanPlansLoaded`) — `tryResolvePendingKanbanSelection()` already follows at line 305. Add `tryResolvePendingEpicSelection();` immediately after line 305.
- `src/webview/project.js:368` (inside `epicDocumentsReady`) — there is currently **no** resolver call here. Add `tryResolvePendingEpicSelection();` after the `renderEpicsList()` call at line 368.

```js
// In kanbanPlansLoaded handler (after line 305):
renderEpicsList();
tryResolvePendingKanbanSelection();
tryResolvePendingEpicSelection();   // <-- ADD

// In epicDocumentsReady handler (after line 368):
_epicDocumentsCache = msg.documents || [];
renderEpicsList();
tryResolvePendingEpicSelection();   // <-- ADD
```

## Verification Plan

### Automated Tests

> Per session directives: **skip compilation** (`npm run compile` / tsc) and **skip automated tests** (unit/integration/e2e). The test suite will be run separately by the user. The verification below is manual.

### Manual Verification

1. **Epic happy path:** Open `kanban.html` with at least one epic card present. Click the epic card's **Review** button. Expect: Project panel opens (or focuses), the **EPICS** tab activates, the target epic row is highlighted/scrolled into view, and its preview loads in the epics preview pane.
2. **Non-epic regression:** Click **Review** on an ordinary (non-epic) plan card. Expect: identical-to-current behaviour — **KANBAN PLANS** tab activates and the plan is selected/previewed there.
3. **Standalone epic document:** Create a standalone epic document (no DB card), surface it on the board if applicable, and verify the resolver finds it via `_epicDocumentsCache`.
4. **Cold cache timing:** With the Project panel freshly opened (epics not yet loaded), click Review on an epic. Confirm it resolves once the epics list finishes rendering (the deferred `tryResolvePendingEpicSelection()` after `renderEpicsList()` at lines 304 and 368), not only when the cache is warm.
5. **Cross-window:** With the Project panel already open in another editor window, click Review — confirm the message routes to the existing panel (no forced reveal/steal, per `src/services/KanbanProvider.ts:6279-6283`) and lands on the EPICS tab.
6. **Regression sweep:** Confirm no other `activateKanbanTabAndSelectPlan` callers regress — specifically `activatePlanInProjectPanel` (`KanbanProvider.ts:186`, used for new-plan auto-edit) and the legacy `planning.js:3673` handler. Both should be unaffected since neither passes `isEpic: true`.

---

**Recommendation:** Complexity is 4/10 → **Send to Coder**.
