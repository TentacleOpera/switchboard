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
   - `src/services/KanbanProvider.ts:6181-6202` — `case 'reviewPlan'`.
   - `src/services/KanbanProvider.ts:6193-6200` — `postMessageToProjectWebview({ type: 'activateKanbanTabAndSelectPlan', planId, sessionId, planFile, workspaceRoot })`.

3. **project.js — unconditionally activates the Kanban tab.** The receiver always clicks the `kanban` tab and resolves the selection against the kanban plans list:
   - `src/webview/project.js:335-358` — `case 'activateKanbanTabAndSelectPlan'`.
   - `src/webview/project.js:353-354` — `document.querySelector('.shared-tab-btn[data-tab="kanban"]').click()` (hard-coded `kanban`).
   - `src/webview/project.js:963-979` — `tryResolvePendingKanbanSelection()` searches `_kanbanPlansCache` and clicks a `.kanban-plan-item` — which never contains epic rows.

**Root cause:** the epic/non-epic distinction is known at the click site but is never propagated through the `reviewPlan` → `activateKanbanTabAndSelectPlan` chain, and the project-panel receiver hard-codes the `kanban` tab. Epics live in the EPICS tab (`renderEpicsList()` builds its list from `_kanbanPlansCache.filter(plan => plan.isEpic)` plus `_epicDocumentsCache` — `src/webview/project.js:1187-1194`), so an epic target can never resolve in the kanban list.

**Fix in one line:** carry an `isEpic` flag through the chain and, when set, activate the EPICS tab and resolve the selection there (mirroring the existing kanban-selection resolver).

## Metadata

- **Tags:** `kanban`, `epics`, `project-panel`, `webview`, `routing`, `bugfix`
- **Complexity:** 4 / 10
- **Affected components:** `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/webview/project.js`
- **Migration required:** No (no persisted state or schema changes; pure message-plumbing + UI routing).

## Complexity Audit

**Classification: Routine (with one new small UI resolver).**

- The message-plumbing changes (hops 1 and 2) are trivial: add one boolean to two existing message objects.
- The only genuinely new logic is hop 3: a `tryResolvePendingEpicSelection()` that mirrors the already-proven `tryResolvePendingKanbanSelection()` (`src/webview/project.js:963-979`) and reuses the existing `selectEpic(plan)` (`src/webview/project.js:1261-1277`). No new architecture, no new state store.
- Risk is low and contained to the review-button path; the non-epic path is unchanged.

## Edge-Case & Dependency Audit

- **Non-epic cards must keep working.** When `isEpic` is falsy, behaviour must be byte-for-byte identical to today (activate `kanban` tab, resolve via `tryResolvePendingKanbanSelection`). The branch is gated strictly on the new flag.
- **Standalone epic documents.** Epics in the EPICS tab come from two sources: DB epics (`_kanbanPlansCache.filter(p => p.isEpic)`) and standalone epic documents (`_epicDocumentsCache`). The epic resolver must search both so a standalone epic document still resolves. Match priority should be `planFile` → `planId` → `sessionId`, identical to `tryResolvePendingKanbanSelection`.
- **Timing / cache not yet loaded.** `tryResolvePendingKanbanSelection` already handles the "cache not ready yet" case by returning early and being re-invoked after the list renders (`renderEpicsList()` is called on `kanbanPlansLoaded`/refresh — `src/webview/project.js:300,364`). The epic resolver must follow the same pattern: store `_pendingEpicSelection`, attempt resolution now, and re-attempt after `renderEpicsList()`.
- **Epics tab click handler.** Clicking `data-tab="epics"` must trigger an epics render/fetch the same way the `kanban` tab click triggers `fetchKanbanPlans`. Confirm the epics tab button's click handler renders the list; if it relies on `_kanbanPlansCache` already being populated, ensure a fetch is kicked off (epics derive from the same kanban cache, so the existing kanban fetch already populates it).
- **`epicId` vs `planId`.** For DB epics, the epic's own card id is its `planId`; `epicId` on a *subtask* points back to its parent. The review button is on the epic card itself, so pass the epic's `planId`/`sessionId` as the selection key — do **not** use `epicId` (that field is empty on the epic card). Only the boolean `isEpic` needs to cross the wire.
- **No confirmation dialogs** introduced (per project rule).

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

In `case 'reviewPlan'` (`src/services/KanbanProvider.ts:6181-6202`), pass `isEpic` straight through to the project webview message (`src/services/KanbanProvider.ts:6193-6200`):

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

**3a.** Add a pending-epic-selection slot next to the existing kanban one (near `src/webview/project.js:169`):

```js
let _pendingEpicSelection = null;
```

**3b.** Branch in `case 'activateKanbanTabAndSelectPlan'` (`src/webview/project.js:335-358`):

```js
case 'activateKanbanTabAndSelectPlan': {
    if (msg.isEpic === true) {
        _pendingEpicSelection = {
            planId: msg.planId || '',
            sessionId: msg.sessionId || '',
            planFile: msg.planFile || '',
            workspaceRoot: msg.workspaceRoot || ''
        };
        epicsFilters.workspaceRoot = '';
        if (epicsWorkspaceFilter) epicsWorkspaceFilter.value = '';
        const epicsTabBtn = document.querySelector('.shared-tab-btn[data-tab="epics"]');
        if (epicsTabBtn) epicsTabBtn.click();
        tryResolvePendingEpicSelection();
        break;
    }
    // ---- existing non-epic path unchanged below ----
    _pendingKanbanSelection = { /* …unchanged… */ };
    /* …unchanged kanban tab activation + tryResolvePendingKanbanSelection()… */
    break;
}
```

> Confirm the exact name of the epics workspace-filter element/`epicsFilters` object during implementation (`epicsFilters.workspaceRoot` is referenced at `src/webview/project.js:1195`). If there is no `epicsWorkspaceFilter` DOM handle, just clear `epicsFilters.workspaceRoot` and re-render.

**3c.** Add the resolver, mirroring `tryResolvePendingKanbanSelection` (`src/webview/project.js:963-979`), searching the epic sources used by `renderEpicsList` (`src/webview/project.js:1191-1194`):

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

> The epic list items currently have no stable `data-plan-id` attribute on the `.epic-plan-item` div (see `src/webview/project.js:1221-1235` — only the inner `.epic-accordion` carries it). Add `itemDiv.dataset.planId = plan.planId;` when building each item in `renderEpicsList()` so the resolver can find it.

**3d.** Re-attempt resolution after the epics list renders. Where `renderEpicsList()` is invoked on data load/refresh (`src/webview/project.js:300,364`), follow each with `tryResolvePendingEpicSelection();` (the same way `tryResolvePendingKanbanSelection()` is paired at `src/webview/project.js:301`).

## Verification Plan

1. **Epic happy path:** Open `kanban.html` with at least one epic card present. Click the epic card's **Review** button. Expect: Project panel opens (or focuses), the **EPICS** tab activates, the target epic row is highlighted/scrolled into view, and its preview loads in the epics preview pane.
2. **Non-epic regression:** Click **Review** on an ordinary (non-epic) plan card. Expect: identical-to-current behaviour — **KANBAN PLANS** tab activates and the plan is selected/previewed there.
3. **Standalone epic document:** Create a standalone epic document (no DB card), surface it on the board if applicable, and verify the resolver finds it via `_epicDocumentsCache`.
4. **Cold cache timing:** With the Project panel freshly opened (epics not yet loaded), click Review on an epic. Confirm it resolves once the epics list finishes rendering (the deferred `tryResolvePendingEpicSelection()` after `renderEpicsList()`), not only when the cache is warm.
5. **Cross-window:** With the Project panel already open in another editor window, click Review — confirm the message routes to the existing panel (no forced reveal/steal, per `src/services/KanbanProvider.ts:6188-6192`) and lands on the EPICS tab.
6. **Regression sweep:** Confirm `npm run compile` succeeds (source-of-truth is `src/`, per project build note) and no other `activateKanbanTabAndSelectPlan` callers regress.
