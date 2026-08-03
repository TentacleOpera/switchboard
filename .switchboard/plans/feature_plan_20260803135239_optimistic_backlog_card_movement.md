# Optimistic Card Movement for Send to Backlog and Send to New Actions

## Goal
Moving a card to the Backlog (or restoring it from Backlog via "Send to New") currently feels slow because it waits for full backend disk/DB synchronization and a full board re-render round-trip before updating the UI. In contrast, column movements on other Kanban workflow actions leverage optimistic UI updates.

The goal is to implement optimistic card movement for `.send-to-backlog-btn` and `.send-to-new-btn` UI triggers in `src/webview/kanban.html`, matching the fast, responsive UX of other column transition triggers, with proper fallback and rollback guard integration.

### Problem Analysis & Root Cause
1. **Missing Optimistic Movement**: When clicking `.send-to-backlog-btn` or `.send-to-new-btn` in `kanban.html`, the click listener immediately posts `sendToBacklog` or `sendToNew` messages to the VS Code host without calling `moveCardsOptimistically(...)` first or animating card transition.
2. **Perceived Lag**: In `src/services/KanbanProvider.ts`, `sendToBacklog` and `sendToNew` call `moveCardToColumn(...)` which performs file mtime / database column updates and triggers full `this.refresh()`. Because the webview UI remains static until the post-refresh IPC payload arrives, the user experiences noticeable UI lag.
3. **Inconsistent UI Feedback**: Other card movement triggers (such as `runCopyPrompt`, drag-and-drop, and card completion) apply optimistic DOM transitions, column highlighting, or exit animations prior to dispatching messages. `sendToBacklog` and `sendToNew` lack this instant visual feedback.

### Root-Cause Verification (added by improve pass — code-read findings)

Three additional root causes were confirmed by reading the code. They change what the fix must do, so they are recorded here as part of the problem statement:

4. **BACKLOG has no DOM container on the kanban board.** `DEFAULT_KANBAN_COLUMNS` (`src/services/agentConfig.ts:132-142`) contains no `BACKLOG` entry, and `KanbanProvider` never appends one (only `PlanningPanelProvider.ts:9966-9977` does, for its own surface). The board's own fallback list (`src/webview/kanban.html:4174-4183`) has no `BACKLOG` entry either. Backlog cards are displayed by *re-labelling the CREATED slot* (`kanban.html:5476`, `5565`) and swapping which cards it holds (`renderBoard`, `kanban.html:6292-6300`). Consequently `document.getElementById('col-BACKLOG')` is always `null`.
5. **Both transitions are "vanish from view", not "move between columns".** The buttons are mutually exclusive by render condition (`kanban.html:6746-6752`): `.send-to-backlog-btn` renders **only** when `card.column === 'CREATED' && !showingBacklog`; `.send-to-new-btn` renders **only** when `showingBacklog && card.column === 'BACKLOG'`. So the target column is *never displayed in the view the click happens in* — BACKLOG is hidden outside backlog view, and CREATED is hidden inside it. `resolveDisplayColumn(target)` (`kanban.html:5099-5111`) returns `null` in both cases. The correct optimistic effect is **instant removal from the visible board plus a count decrement**, not an inter-column slide.
6. **`sendToBacklog` / `sendToNew` emit no move delta, so the optimistic ledger never resolves.** `armOptimisticGuard` writes `id -> targetColumn` into `pendingOptimisticMoves` (`kanban.html:4253-4268`), and `applyPendingOptimisticMoves` (`kanban.html:5373-5384`) overlays that column onto **every** subsequent `updateBoard` payload. The ledger is cleared only by `resolveOptimisticGuard`, called from the `moveCards` (`kanban.html:7581`) and `moveCardsFailed` (`kanban.html:7634`) handlers, or by `clearOptimisticGuard()` on a workspace switch. `sendToBacklog`/`sendToNew` (`KanbanProvider.ts:9811-9828`) post neither message — they call `moveCardToColumn` then `this.refresh()`. They also **discard** `moveCardToColumn`'s boolean result, which is `false` on every failure path (`KanbanProvider.ts:6753-6796` — it never throws). So an optimistic move armed by these two buttons would leave a permanent column overlay on this board and would have no rollback at all if the DB write failed.

## Metadata
- **Complexity:** 5
- **Tags:** frontend, backend, ui, ux, performance, refactor

> **Superseded:** **Complexity:** 3
> **Reason:** The change is not confined to two webview click handlers. Making the plan's own stated requirement ("proper fallback and rollback guard integration") true requires (a) correcting the shared `moveCardsOptimistically` helper, which is also used by the column-header bulk actions and `runCopyPrompt`, and (b) adding move-delta emission to two backend verbs so the optimistic ledger resolves and a failed write reverts. Two files, a shared helper with existing callers, and a new use of the `moveCards`/`moveCardsFailed` protocol — mixed, not routine.
> **Replaced with:** **Complexity:** 5 (majority routine, two moderate well-scoped risks: shared-helper blast radius and new delta emission on two verbs).

## User Review Required
- **Backend edit is in scope.** The plan as written named only `src/webview/kanban.html`. Rollback and ledger resolution cannot be delivered from the webview alone, because the webview has no ack channel (`postKanbanMessage` is fire-and-forget — `kanban.html:4567-4579`). Confirm that `src/services/KanbanProvider.ts` may be edited; if not, the optimistic move must be shipped **without** the guard/ledger (see "Rejected Alternatives", option C) and the plan's rollback requirement dropped explicitly.
- **Expected visual outcome.** After this change, "Send to Backlog" makes the card **disappear** from the New column immediately; "→ New" makes the card **disappear** from the Backlog view immediately. Neither produces a visible card-to-column slide, because the destination is not on screen in either direction. Confirm that instant removal (optionally plus a status-bar confirmation) is the desired feedback.
- **Exit animation is deferred.** No exit/removal animation primitive exists in the board (only `card-dropped` at `kanban.html:1172` and `card-op-completed` at `1044`, both for cards that stay on screen). A fade-out would require deferring the model mutation and the render until `animationend`, which delays the count update and widens the guard window. Recommended: ship instant removal now.

## Complexity Audit

### Routine
- Front-end webview event handler updates in `src/webview/kanban.html` calling existing helper functions (`moveCardsOptimistically`, target column resolution).
- Capturing `btn.dataset.*` into locals before the optimistic step.
- Two small backend `case` bodies in `KanbanProvider._handleMessage` following the existing `moveCards` / `moveCardsFailed` emission pattern used by ~20 other move sites.

### Complex / Risky
- Ensuring optimistic state correctly handles backlog visibility toggles (`showingBacklog`) so cards moving to hidden/visible target columns don't leave zombie DOM elements or corrupted state if backend operations fail.
- `moveCardsOptimistically` is shared with the column-header bulk actions (`kanban.html:5681`, `5700`, `5724`, `5743`) and `runCopyPrompt` (`6540`). Changing its target resolution changes behaviour for any caller whose target column is not rendered (e.g. a role column hidden by `visibleAgents`). Today those calls silently do nothing; after the change they will optimistically remove the card from view. That is the intended, consistent behaviour, but it is a behaviour change beyond the two buttons.
- The optimistic ledger (`pendingOptimisticMoves`) is a *forcing* overlay: any id left in it rewrites that card's column on every board push until a `moveCards`/`moveCardsFailed` for that id arrives or the workspace changes. Arming it without arranging for its resolution is worse than not arming it.

## Edge-Case & Dependency Audit

### Race Conditions
- **Guard window vs. authoritative refresh.** `armOptimisticGuard` sets a 2000 ms suppression window (`OPTIMISTIC_MOVE_WINDOW_MS`, `kanban.html:4245`). The `refresh()` that follows the backend write lands inside it. Path: `updateBoard` → `applyPendingOptimisticMoves` overlays the optimistic column → `nextBoardSignature` matches `lastBoardSignature` (which the optimistic step re-baselined) → no render, no flicker. If any other field changed in the same payload, `suppressedRenderPending` is set and the expiry timer posts one `refresh` ~2050 ms later, which then renders authoritatively. Both branches are correct; neither reverts the move on screen.
- **Success echo is a no-op by design.** When the `moveCards` echo arrives, `currentCards` already carries the target column, so `card.column !== targetCol` is false, `entriesToMove` is empty, and the handler performs no DOM work and no render — it only calls `resolveOptimisticGuard` (`kanban.html:7551-7599`). This is the same short-circuit the post-drop confirm relies on.
- **Double-click / repeat click.** The button is destroyed by the fallback `renderBoard` in the same tick, so a second click on the same element is not possible. A rapid click on a *different* card re-arms the guard (extending, not resetting, the window) and adds a second ledger entry — the ledger is a Map keyed by id, so entries do not collide.
- **Feature cards cascade server-side.** `moveCardToColumn` cascades a feature to all its subtasks in one transaction (`KanbanProvider.ts:6764-6772`). The optimistic step moves only the feature card, which is correct: subtasks are filtered out of the board entirely (`renderBoard`, `kanban.html:6303`) and `unresolvedNeedsRender` deliberately ignores ids with a `featureId` (`kanban.html:5210-5215`).

### Security
- No new data crosses a trust boundary. No new user input is interpolated into HTML; the existing `escapeAttr`-encoded dataset values are read, not written. The added backend messages carry only an already-resolved session id and a column constant.

### Side Effects
- **`moveCardToColumn` is not purely a column write.** It also runs `_autoCommitIfCodeReviewTransition`, queues ClickUp/Linear integration sync for the card and any cascaded subtasks, and regenerates the owning feature file (`KanbanProvider.ts:6759-6790`). None of that is changed here, but it is why the round-trip is slow enough to be worth hiding — and why the optimistic window must tolerate a multi-hundred-millisecond backend.
- **Verb response shape.** Returning `{ success: ok }` instead of an unconditional `{ success: true }` makes the HTTP/LocalApiServer response honest about failure. Any caller that treats `success` as "the request was accepted" rather than "the move happened" will now see `false` on a failed write. That is the intent; it is called out because it is an externally visible contract change.
- **Count badges.** `renderBoard` writes count badges from `computeColumnOccupancy(allCards …)` (`kanban.html:6326`), not from the DOM. `currentCards` entries are the same object references as `allCards` entries (`allCards = applyPendingOptimisticMoves(msg.cards)` → `currentCards = applyBoardProjectFilter(allCards)`, which preserves references), so the in-place column mutation inside `moveCardsOptimistically` is already visible to the occupancy computation and the badge is correct after the fallback render. The explicit `allCards` sync added below is a no-op in that shared-reference case and exists only to keep the invariant from becoming load-bearing.

### Dependencies & Conflicts
- **Backlog View Filtering (`showingBacklog`)**: When `showingBacklog` is false, moving a card to `BACKLOG` effectively removes it from the visible board.

  > **Superseded:** `moveCardsOptimistically` handles hidden targets by triggering `renderBoard` fallback or relying on `armOptimisticGuard`.
  > **Reason:** It does not. `moveCardsOptimistically` resolves its target with `resolveDomColumn` (`kanban.html:5224`), which passes `'BACKLOG'` straight through, then `return`s early when `document.getElementById('col-BACKLOG')` is `null` (`kanban.html:5225-5226`). Since no `col-BACKLOG` container exists on the board (finding 4 above), the entire call exits before the model mutation, before `armOptimisticGuard`, and before the `unresolvedNeedsRender` fallback. The plan's proposed `.send-to-backlog-btn` code would therefore have been a provable no-op — the exact "passes its own success check while the goal is unmet" failure. The `.send-to-new-btn` case survives the early return (`col-CREATED` exists) but only because the per-entry `resolveDisplayColumn` inside `moveCardElements` then returns `null` and routes it to the full-render fallback.
  > **Replaced with:** `moveCardsOptimistically` must resolve its target through `resolveDisplayColumn` (the same rule `moveCardElements` uses per entry) and, when the target is not displayed, skip the DOM move but still mutate the model, arm the guard, and let `unresolvedNeedsRender` trigger the `renderBoard` fallback that removes the card from view. See Proposed Changes, change 1.

- **Session & Plan ID Resolution**: Both `sessionId` and `planId` are passed in dataset attributes (`btn.dataset.session`, `btn.dataset.planId`). The resolution must prefer `planId` or `sessionId` consistently matching `moveCardsOptimistically` expectations. Confirmed: the board keys cards by `planId || sessionId` (`kanban.html:5235`, `5257`, `6260`), and the buttons are rendered with `data-plan-id="${card.planId || card.sessionId}"` (`kanban.html:6747`, `6751`), so `dataset.planId` is already the board key. On the backend, `_resolveSessionId` prefers `sessionId` and falls back to `planId` (`KanbanProvider.ts:472-476`), and `getPlanBySessionId` retries the value as a `plan_id` for file-based plans with an empty `session_id` (`KanbanDatabase.ts:4492-4511`) — so a planId-only card resolves. The `moveCards` echo may therefore carry a *sessionId* while the ledger was armed with a *planId*; the `moveCards` handler already reconciles that by matching on both and clearing by the card's own key (`kanban.html:7551-7581`), so the ledger resolves either way.

- **Backend Rollback / Resync**: Existing `armOptimisticGuard` in `kanban.html` handles rolling back or accepting authoritative server state updates if the backend write fails or completes.

  > **Superseded:** Existing `armOptimisticGuard` in `kanban.html` handles rolling back or accepting authoritative server state updates if the backend write fails or completes.
  > **Reason:** `armOptimisticGuard` only *arms* the suppression window and the forcing ledger. Rollback lives in the `moveCardsFailed` handler and ledger clearing lives in the `moveCards` handler — and `sendToBacklog`/`sendToNew` post neither (finding 6). They also throw away `moveCardToColumn`'s `false` return, so a failed DB write is silent. Left as-is, an optimistic move here would (a) never clear its ledger entry, so this board would keep forcing the optimistic column onto every later board push until a workspace switch or reload, and (b) never revert on failure, leaving the card visually gone while the DB still has it in CREATED.
  > **Replaced with:** The two backend verbs must emit `moveCards` on success and `moveCardsFailed` (with the pre-move column as `sourceColumn`) on failure, exactly like the ~20 other move sites in `KanbanProvider`. The existing webview handlers then resolve the ledger on success and perform the revert + error status message on failure with no further webview changes. See Proposed Changes, change 3.

- **Custom column named `BACKLOG`.** A user-defined column (`customKanbanColumns`, `agentConfig.ts:393-403`) could in principle introduce an id of `BACKLOG`, which would make `col-BACKLOG` exist and turn the backlog transition into a real inter-column move. The `resolveDisplayColumn`-based implementation below handles that case automatically (it would return a non-null container and take the normal `moveCardElements` path), so no special-casing is required.

## Dependencies
- None. No prior session artifacts are required; all touched code is present in this repo (`src/webview/kanban.html`, `src/services/KanbanProvider.ts`).

## Adversarial Synthesis
Key risks: the plan's original approach was a silent no-op for Send to Backlog because BACKLOG has no DOM container, so the fix has to be a *removal* primitive rather than a move; arming the optimistic ledger without a resolving `moveCards` delta would leave this board permanently forcing a stale column onto every refresh; and a failed DB write is currently invisible, so an optimistic removal without `moveCardsFailed` would desync the board from the DB with no repair. Mitigations: resolve the optimistic target through `resolveDisplayColumn` and route non-displayed targets to the existing `unresolvedNeedsRender` → `renderBoard` fallback; emit `moveCards` on success and `moveCardsFailed` (carrying the pre-move column) on failure from both backend verbs so the existing ledger-clearing and revert handlers do the work; capture button dataset values before the optimistic step because the fallback render detaches the button mid-handler.

## Proposed Changes

### File: `src/webview/kanban.html` — change 1: `moveCardsOptimistically` (line 5223)

**Context.** `moveCardsOptimistically` currently resolves its target container with `resolveDomColumn` (which only collapses coder columns) and bails out when the container is missing. `moveCardElements`, which it calls, resolves each entry with `resolveDisplayColumn` (which additionally applies the backlog-view swap and the "column not rendered" rule) and reports unmovable ids as `unresolved` so the caller can fall back to a full render. The two resolvers disagree, and the disagreement is exactly the backlog case.

**Logic.** Make the helper's own target resolution use the display rules, and treat "target not displayed" as *all ids unresolved* rather than as a reason to abort. The model mutation, the signature re-baseline, the guard arming, and the `unresolvedNeedsRender` fallback then all still run — and the fallback `renderBoard` is what removes the card from the view (it filters BACKLOG cards out when `!showingBacklog` and CREATED cards out when `showingBacklog`, `kanban.html:6292-6300`), with correct count badges recomputed from occupancy.

**Implementation.**
```javascript
/**
 * Move cards optimistically in the DOM before backend processing.
 * @param {string[]} sessionIds - Session IDs to move
 * @param {string} sourceColumn - Logical source column (may be 'CODED_AUTO'). Vestigial:
 *   the source is re-derived from currentCards below, before the model mutation.
 * @param {string} targetColumn - Logical target column
 */
function moveCardsOptimistically(sessionIds, sourceColumn, targetColumn) {
    // Resolve through the DISPLAY rules, not resolveDomColumn. A target that is not
    // rendered in the current view has no container at all: BACKLOG outside backlog
    // view, CREATED inside it, or a role column hidden by visibleAgents. The old
    // resolveDomColumn + early return made the whole call a silent no-op for those
    // targets — the model was never mutated and no guard was armed.
    const domTargetColumn = resolveDisplayColumn(targetColumn);
    const targetBody = domTargetColumn ? document.getElementById('col-' + domTargetColumn) : null;

    const entries = sessionIds.map(id => ({ id, targetColumn }));

    // Called before the model mutation below, so the source column resolves from
    // currentCards — no explicit sourceColumn needed here. With no target container
    // there is nothing to move to: every id is unresolved, and the render fallback
    // below is what takes the card off screen.
    const unresolved = targetBody ? moveCardElements(entries) : sessionIds.slice();

    sessionIds.forEach(id => {
        const cardData = currentCards.find(c => (c.planId || c.sessionId) === id);
        if (cardData) cardData.column = targetColumn;
    });
    // currentCards entries are the same objects as allCards entries, so the mutation
    // above normally already reaches the occupancy cache renderBoard reads for the
    // count badges. Kept explicit so that invariant is not load-bearing.
    allCards.forEach(card => {
        const key = card.planId || card.sessionId;
        if (key && sessionIds.includes(key)) card.column = targetColumn;
    });

    lastBoardSignature = buildBoardSignature(currentCards);
    armOptimisticGuard(entries);

    // A renderable card we could not place (e.g. the target column is hidden in the
    // current backlog view) would otherwise sit in the wrong column with no render
    // left to repair it — the guard we just armed suppresses them.
    if (unresolvedNeedsRender(unresolved)) {
        renderBoard(currentCards);
        lastBoardSignature = buildBoardSignature(currentCards);
    }
}
```

**Edge cases.**
- Subtask ids and ids from other boards still land in `unresolved`; `unresolvedNeedsRender` already filters those out, so no spurious rebuild.
- With a hidden target, `renderBoard` drops the card *before* the bucket loop, so the "server sent a card in a column it is not showing" branch (`kanban.html:6308-6316`) and its one-shot `refresh` are not triggered for the backlog/created cases.
- Existing callers with a *visible* target are unaffected: `resolveDisplayColumn` returns the same container `resolveDomColumn` did (it delegates to it at `kanban.html:5108`), so `moveCardElements` runs exactly as before.

### File: `src/webview/kanban.html` — change 2: button handlers (lines 6606-6616)

**Context.** Both listeners are (re)bound inside `renderBoard`, and the optimistic step can call `renderBoard` synchronously — which replaces every card's markup and detaches the clicked button in the middle of its own handler.

**Logic.** Read the dataset into locals first, then move optimistically, then post. Derive the board key as `planId || sessionId` to match how cards are keyed everywhere else.

> **Superseded:** the two code sketches in the original plan, which read `btn.dataset.*` *after* calling `moveCardsOptimistically` and passed `currentCol` as a meaningful argument.
> **Reason:** (a) The optimistic step may run `renderBoard`, detaching `btn` before the `postKanbanMessage` line reads its dataset — the values happen to survive on a detached node, but depending on that is fragile and non-obvious. (b) The `currentCards.find(...)`/`currentCol` computation feeds `moveCardsOptimistically`'s `sourceColumn` parameter, which the function never reads (`kanban.html:5230-5231`); as written it reads like load-bearing logic and it is not. (c) Both sketches were no-ops or accidental successes for the reasons in finding 4/5.
> **Replaced with:** the implementation below — dataset captured first, key derived once, `sourceColumn` passed for readability with the card's actual column and a comment that it is vestigial.

**Implementation.**
```javascript
document.querySelectorAll('.send-to-backlog-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        // Capture the dataset BEFORE the optimistic step: its renderBoard fallback
        // rebuilds every card and detaches this button mid-handler.
        const sessionId = btn.dataset.session || '';
        const planId = btn.dataset.planId || '';
        const workspaceRoot = btn.dataset.workspaceRoot;
        const key = planId || sessionId;
        if (key) {
            // sourceColumn is informational (the helper re-derives it); the button only
            // renders on CREATED cards outside backlog view.
            const card = currentCards.find(c => (c.planId || c.sessionId) === key);
            moveCardsOptimistically([key], card?.column || 'CREATED', 'BACKLOG');
        }
        postKanbanMessage({ type: 'sendToBacklog', sessionId, planId, workspaceRoot });
    });
});

document.querySelectorAll('.send-to-new-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const sessionId = btn.dataset.session || '';
        const planId = btn.dataset.planId || '';
        const workspaceRoot = btn.dataset.workspaceRoot;
        const key = planId || sessionId;
        if (key) {
            // The button only renders on BACKLOG cards inside backlog view.
            const card = currentCards.find(c => (c.planId || c.sessionId) === key);
            moveCardsOptimistically([key], card?.column || 'BACKLOG', 'CREATED');
        }
        postKanbanMessage({ type: 'sendToNew', sessionId, planId, workspaceRoot });
    });
});
```

**Edge cases.**
- Missing key (`data-plan-id` and `data-session` both empty): the optimistic step is skipped and the message is still posted, so behaviour degrades to today's.
- No target-column highlight is applied (unlike `runCopyPrompt`, `kanban.html:6533-6539`) because the destination column is not on screen in either direction — highlighting the re-labelled CREATED slot would point at the wrong place.
- **Optional (not required):** after the optimistic step, `showStatusBarMessage('Moved to Backlog')` / `showStatusBarMessage('Moved to New')` gives an explicit confirmation for a card that just disappeared. Cheap and uses an existing helper (`kanban.html:5075-5089`); include only if the reviewer wants the extra confirmation.

### File: `src/services/KanbanProvider.ts` — change 3: `sendToBacklog` / `sendToNew` (lines 9811-9828)

**Context.** Every other move verb in this file posts `moveCards` on success and `moveCardsFailed` on failure (≈20 sites, e.g. `5532`/`5535`, `8007`/`8010`, `8715`/`8718`). These two verbs do not, so the webview's ledger-clearing and revert handlers never fire for them, and `moveCardToColumn`'s `false` return is discarded.

**Logic.** Capture the pre-move column (for an accurate revert target), call the existing move, then emit the matching delta, then refresh as before. The webview needs no new handler — `moveCards` (`kanban.html:7544`) clears the ledger and short-circuits to zero DOM work because the optimistic column already matches; `moveCardsFailed` (`kanban.html:7602`) reverts the model, re-renders the card back into view (the element is gone, so it routes through `unresolvedNeedsRender` → `renderBoard`), and shows the error status message.

**Implementation.**
```ts
case 'sendToBacklog': {
    const resolvedRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!resolvedRoot) return { success: false, error: 'No workspace root resolved' };
    const resolvedSessionId = this._resolveSessionId(msg.planId, msg.sessionId);
    if (!resolvedSessionId) return { success: false, error: 'Could not resolve session id' };
    // Pre-move column so a failed write reverts the optimistic move to where the
    // card actually was, not to an assumed column.
    let sourceColumn = 'CREATED';
    try {
        const preDb = this._getKanbanDb(resolvedRoot);
        const pre = preDb ? await preDb.getPlanBySessionId(resolvedSessionId) : null;
        if (pre?.kanbanColumn) sourceColumn = pre.kanbanColumn;
    } catch { /* fall back to the only column this button renders on */ }
    const ok = await this.moveCardToColumn(resolvedRoot, resolvedSessionId, 'BACKLOG');
    if (ok) {
        this.postMessage({ type: 'moveCards', sessionIds: [resolvedSessionId], targetColumn: 'BACKLOG' });
    } else {
        this.postMessage({
            type: 'moveCardsFailed',
            failures: [{ id: resolvedSessionId, sourceColumn, reason: 'database update failed' }]
        });
    }
    this.refresh();
    return { success: ok, sessionId: resolvedSessionId };
}
case 'sendToNew': {
    const resolvedRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!resolvedRoot) return { success: false, error: 'No workspace root resolved' };
    const resolvedSessionId = this._resolveSessionId(msg.planId, msg.sessionId);
    if (!resolvedSessionId) return { success: false, error: 'Could not resolve session id' };
    let sourceColumn = 'BACKLOG';
    try {
        const preDb = this._getKanbanDb(resolvedRoot);
        const pre = preDb ? await preDb.getPlanBySessionId(resolvedSessionId) : null;
        if (pre?.kanbanColumn) sourceColumn = pre.kanbanColumn;
    } catch { /* fall back to the only column this button renders on */ }
    const ok = await this.moveCardToColumn(resolvedRoot, resolvedSessionId, 'CREATED');
    if (ok) {
        this.postMessage({ type: 'moveCards', sessionIds: [resolvedSessionId], targetColumn: 'CREATED' });
    } else {
        this.postMessage({
            type: 'moveCardsFailed',
            failures: [{ id: resolvedSessionId, sourceColumn, reason: 'database update failed' }]
        });
    }
    this.refresh();
    return { success: ok, sessionId: resolvedSessionId };
}
```

**Edge cases.**
- The `moveCards` echo may carry a sessionId while the ledger holds a planId; the webview handler matches on both and clears by the card's own key (`kanban.html:7551-7581`).
- Feature cards: the echo names only the feature's session id. Cascaded subtasks are never rendered on the board and are excluded from `unresolvedNeedsRender`, so no subtask delta is needed. The authoritative `refresh()` still carries their new columns.
- `getPlanBySessionId` can restore an archived plan into the hot store as a side effect (`KanbanDatabase.ts:4512-4520`). That is the same read `moveCardToColumn` performs immediately afterwards, so the pre-read introduces no new behaviour — only an extra lookup.
- Boards other than the initiating one receive the same `moveCards` push with no guard armed, so their `moveCards` handler takes the normal `renderBoard` path and stays consistent.

## Verification Plan

### Automated Tests
- **Skipped by session directive.** Per the invoking directives (SKIP TESTS, SKIP COMPILATION), no automated test run and no project compilation step form part of this verification plan. The implementing agent should still keep the change compile-clean by inspection: change 3 is TypeScript and uses `pre?.kanbanColumn` (`KanbanPlanRecord.kanbanColumn`, `KanbanDatabase.ts:49`) — not `column`, which does not exist on that record type.

  > **Superseded:** Run existing regression tests: `npm test -- src/test/kanban-subtask-column-leak-regression.test.js`
  > **Reason:** The invoking session explicitly directs that no automated tests and no compilation step be included in the verification plan.
  > **Replaced with:** the inspection note above. If the user later wants a test pass, that regression file plus any optimistic-guard tests are the right targets — it is a scope decision, not a plan defect.

### Manual Verification
1. Open Switchboard Kanban view in VS Code / web application. (Reminder: the running extension loads from the installed extension folder, so sync/reload before testing.)
2. Click "Send to Backlog" on a card in the `CREATED` column. Verify the card **disappears from the New column immediately**, before the backend refresh finishes, and that the New count badge decrements by one in the same frame.
3. Toggle Backlog view on and confirm the card is present there. Click "→ New" on it and verify it **disappears from the Backlog view immediately**.

   > **Superseded:** Toggle Backlog view on, and click "Send to New" on a backlog card. Verify instant optimistic move into the `CREATED` column.
   > **Reason:** While backlog view is active, the CREATED slot is re-labelled "BACKLOG" and displays BACKLOG cards (`kanban.html:5476`, `5565`, `6292-6300`). A card moved to CREATED is by definition not displayed in that view, so the correct observable outcome is that it leaves the backlog view — never that it appears in a visible CREATED column. Expecting an inbound move would fail a correct implementation.
   > **Replaced with:** step 3 above, plus step 4.
4. Toggle Backlog view off and confirm the card is back in `CREATED` with the badge count restored.
5. Repeat step 2 on a **feature** card and confirm the feature card vanishes from New, and that after the refresh its subtasks are in BACKLOG too (check via the feature's expanded subtask list or the DB).
6. Rollback path: with the board open, trigger a failing write (e.g. point the workspace at a DB that cannot be opened, or temporarily make `moveCardToColumn` return `false`) and confirm the card **reappears** in its original column and a red status-bar message reports the failure.
7. Ledger hygiene: send a card to Backlog, wait >3 s (past the 2 s guard window plus the expiry refresh), then move that same card from the Backlog view to another column by drag. It must land and stay in the dragged-to column — proof the `moveCards` echo cleared the ledger and no stale overlay is forcing BACKLOG back on.

## Rejected Alternatives
- **B — dedicated `removeCardOptimistically()` helper for the two buttons.** Lower blast radius (no shared-helper edit), but it duplicates the model-mutation + guard + render-fallback sequence and leaves `moveCardsOptimistically`'s hidden-target early return silently broken for every other caller (e.g. advancing into a role column hidden by `visibleAgents`). Rejected: it fixes the symptom at the two call sites and preserves the trap.
- **C — webview-only: optimistic move with no guard/ledger and no backend change.** Would deliver the instant feedback in ~10 lines, but with no `moveCards` echo the ledger must not be armed at all, which means the authoritative `refresh()` mid-flight can re-render the card back into its old column (visible bounce), and a failed write is still silent. Rejected as the default; it is the fallback only if the backend file is declared off-limits (see User Review Required).
- **D — exit animation then removal.** Fade the card out on `animationend`, then mutate and render. Rejected for v1: no exit-animation primitive exists, and deferring the mutation delays the count decrement and widens the window in which a board push can race the pending removal. Instant removal is the honest optimistic result; polish can follow separately.

## Agent Recommendation
**Send to Coder** (complexity 5).
