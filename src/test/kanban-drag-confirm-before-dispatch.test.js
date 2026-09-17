'use strict';

// Contract: a dropped kanban card becomes authoritative a DB write after the drop,
// not a full agent dispatch later.
//
// The three drag-drop arms (triggerAction, triggerBatchAction, promptOnDrop) must
// persist the column move, post a targeted `moveCards` delta (plus `moveCardsFailed`
// for any write that returned falsy), and ONLY THEN dispatch — prompt assembly,
// clipboard write and terminal send all sit behind the confirm.
//
// This invariant has regressed before on the already-converted arms (moveSelected /
// moveAll / _distributePlannerDispatch), and nothing guarded the drag arms at all.
//
// It also pins the two client-side pieces that make removing the 350ms drop-dispatch
// timers safe: the `recentlyDropped` animation fence (which carries `.card-dropped`
// across the confirm-triggered re-render) and the survival of the ONE remaining
// 350ms timer, which fences completePlan's card-EXIT animation and must not be
// swept away as a twin of the two that were deleted.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function sliceBetween(source, startToken, endToken, label) {
    const start = source.indexOf(startToken);
    assert.ok(start >= 0, `Expected to find ${label} start marker: ${startToken}`);
    const end = source.indexOf(endToken, start + startToken.length);
    assert.ok(end > start, `Expected to find ${label} end marker: ${endToken}`);
    return source.slice(start, end);
}

/** Assert `earlier` occurs before `later` inside `block` (both must be present). */
function assertOrder(block, earlier, later, label) {
    const a = block.indexOf(earlier);
    const b = block.indexOf(later);
    assert.ok(a >= 0, `${label}: expected to find "${earlier}".`);
    assert.ok(b >= 0, `${label}: expected to find "${later}".`);
    assert.ok(
        a < b,
        `${label}: "${earlier}" must appear BEFORE "${later}" — the confirm has to be posted ` +
        `before the dispatch, or the card stays unbacked for the whole dispatch duration.`
    );
}

function run() {
    const providerPath = path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts');
    const kanbanHtmlPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
    const provider = fs.readFileSync(providerPath, 'utf8');
    const html = fs.readFileSync(kanbanHtmlPath, 'utf8');

    // ── 0. _advanceCards: the shared persist → confirm → dispatch operation ────
    // Since the advance-affordance refactor every arm delegates the move half to
    // _advanceCards; the confirm posts and the outcome check live inside it. The
    // per-arm assertions below therefore pin `_advanceCards(` BEFORE each arm's
    // own dispatch markers, and this section pins the internal ordering.
    const advanceCards = sliceBetween(
        provider,
        'private async _advanceCards(',
        'private _isColumnBefore(',
        '_advanceCards'
    );
    assertOrder(
        advanceCards,
        "type: 'moveCards'",
        "'switchboard.triggerAgentFromKanban'",
        '_advanceCards (single dispatch)'
    );
    assertOrder(
        advanceCards,
        "type: 'moveCards'",
        "'switchboard.triggerBatchAgentFromKanban'",
        '_advanceCards (batch dispatch)'
    );
    assert.ok(
        advanceCards.includes("type: 'moveCardsFailed'"),
        '_advanceCards must post moveCardsFailed for writes that returned falsy — a hopeful ' +
        'echo that is never corrected leaves the card lying about where it is.'
    );
    assert.ok(
        /const outcome = await this\.moveCardToColumnWithReason\(/.test(advanceCards) &&
        /if \(outcome\.ok\)/.test(advanceCards),
        "_advanceCards must check the move's return value, not discard it."
    );
    assert.ok(
        /if \(outcome\.ok\) \{[\s\S]*?dispatchIds\.push\(sid\)/.test(advanceCards),
        'only a card whose write succeeded may enter dispatchIds — a failed write must not dispatch.'
    );
    // The no-coding-agent guard sits ABOVE the persist loop inside the CODED_AUTO
    // branch — it aborts the whole operation and must not leave cards half-moved.
    assertOrder(
        advanceCards,
        "showErrorMessage('No coding agent is currently enabled",
        'moveCardToColumnWithReason',
        '_advanceCards (no-coding-agent early return)'
    );

    // ── 1. triggerAction: persist → confirm → dispatch ────────────────────────
    const triggerAction = sliceBetween(
        provider,
        "case 'triggerAction': {",
        "case 'triggerBatchAction': {",
        "triggerAction arm"
    );
    assertOrder(
        triggerAction,
        'await this._advanceCards(',
        'dispatchConfiguredKanbanColumnAction',
        'triggerAction (custom-user branch)'
    );
    assertOrder(
        triggerAction,
        'await this._advanceCards(',
        "'switchboard.triggerAgentFromKanban'",
        'triggerAction (built-in CLI branch)'
    );
    assertOrder(
        triggerAction,
        'await this._advanceCards(',
        '_generatePromptForColumn',
        'triggerAction (prompt fallback)'
    );
    assert.ok(
        /moveResult\.moved\.length === 0/.test(triggerAction),
        'triggerAction must refuse the dispatch when the persist moved nothing — a failed write ' +
        'must not reach dispatchConfiguredKanbanColumnAction or the built-in dispatch.'
    );
    assert.ok(
        triggerAction.includes('this._scheduleBoardRefresh('),
        'triggerAction must KEEP its trailing _scheduleBoardRefresh — it is the only corrector for ' +
        'dispatch identity, working state, and a dispatch-layer column rewrite (_targetColumnForRole).'
    );

    // ── 2. triggerBatchAction: persist → confirm → dispatch ───────────────────
    const triggerBatch = sliceBetween(
        provider,
        "case 'triggerBatchAction': {",
        "case 'moveCardBackwards': {",
        'triggerBatchAction arm'
    );
    assertOrder(
        triggerBatch,
        'await this._advanceCards(',
        'dispatchConfiguredKanbanColumnAction',
        'triggerBatchAction (custom-user branch)'
    );
    assert.ok(
        /const dispatchIds = result\.moved\.map\(m => m\.id\)/.test(triggerBatch),
        'triggerBatchAction must dispatch the persisted ids (result.moved), not the raw sessionIds — ' +
        'a card whose write failed must not be dispatched.'
    );
    assert.ok(
        /dispatchConfiguredKanbanColumnAction\(role, dispatchIds,/.test(triggerBatch),
        'triggerBatchAction custom-user dispatch must consume the persisted dispatchIds.'
    );
    // The built-in dispatch moved inside _advanceCards (pinned in section 0). The
    // arm's own triggerBatchAgentFromKanban call is the no-workspaceRoot branch
    // only — nothing persists there, so no confirm is expected on that path.
    assert.ok(
        triggerBatch.includes('this._scheduleBoardRefresh('),
        'triggerBatchAction must keep its trailing _scheduleBoardRefresh as the slow-path reconciler.'
    );

    // ── 3. promptOnDrop: persist → confirm → prompt/clipboard → dispatch ──────
    const promptOnDrop = sliceBetween(
        provider,
        "case 'promptOnDrop': {",
        "case 'batchPlannerPrompt': {",
        'promptOnDrop arm'
    );
    assertOrder(
        promptOnDrop,
        'await this._advanceCards(',
        'dispatchConfiguredKanbanColumnAction',
        'promptOnDrop (custom-user / prompt-mode branch)'
    );
    assertOrder(
        promptOnDrop,
        'await this._advanceCards(',
        '_generatePromptForColumn',
        'promptOnDrop (routing + general branches)'
    );
    assertOrder(
        promptOnDrop,
        'await this._advanceCards(',
        'clipboard.writeText',
        'promptOnDrop (routing + general branches)'
    );
    // moveCardsFailed and the no-coding-agent early return moved inside
    // _advanceCards — both pinned in section 0 above.

    // ── 4. The 350ms drop-dispatch timers are gone; completePlan's survives ───
    const timerHits = html.match(/\}, 350\)/g) || [];
    assert.strictEqual(
        timerHits.length,
        1,
        `Expected exactly ONE "}, 350)" left in kanban.html (completePlan's exit-animation fence); ` +
        `found ${timerHits.length}. The two drag-dispatch timers were deliberately removed — ` +
        `reintroducing one puts 350ms back in front of every drop confirm.`
    );
    const timerIndex = html.indexOf('}, 350)');
    const beforeTimer = html.slice(Math.max(0, timerIndex - 600), timerIndex);
    assert.ok(
        beforeTimer.includes("type: 'completePlan'"),
        'The surviving 350ms timer must be the completePlan one. It fences a card-EXIT animation on a ' +
        'card leaving the DOM — a different case from the two removed drop timers.'
    );

    const dropHandler = sliceBetween(
        html,
        'function handleDrop(e, targetColumn) {',
        '// ── Forward-declare variables used by message handlers',
        'handleDrop'
    );
    assert.ok(
        !/,\s*350\)/.test(dropHandler),
        'handleDrop must post its dispatch messages immediately — no setTimeout gate in front of the POST.'
    );

    // ── 5. The animation fence that makes the timer removal safe ─────────────
    assert.ok(
        /const recentlyDropped = new Map\(\);/.test(html),
        'Expected the recentlyDropped expiry map (id -> expiryMs). A plain Set would re-animate a card ' +
        'on an unrelated later refresh.'
    );
    const renderBoardHead = sliceBetween(
        html,
        'function renderBoard(cards, justFinishedIds = new Set()) {',
        'const viewState = captureBoardViewState();',
        'renderBoard prologue'
    );
    assert.ok(
        renderBoardHead.includes('recentlyDropped.delete('),
        'renderBoard must prune expired recentlyDropped entries, or the map grows unbounded and a stale ' +
        'id can re-animate a card.'
    );
    const createCardHtml = sliceBetween(
        html,
        'function createCardHtml(card) {',
        'function handleDrop(e, targetColumn) {',
        'createCardHtml'
    );
    assert.ok(
        createCardHtml.includes('recentlyDropped.get(') && createCardHtml.includes('card-dropped'),
        'createCardHtml must re-emit the card-dropped class for recently dropped ids — renderBoard replaces ' +
        'column innerHTML, so without this the confirm-triggered rebuild truncates dropPulse on every drop.'
    );
    const stampSites = html.match(/recentlyDropped\.set\(/g) || [];
    assert.ok(
        stampSites.length >= 3,
        `Expected recentlyDropped to be stamped at every drop site (targeted DOM move, CODED_AUTO drag ` +
        `group, main drag path); found ${stampSites.length}.`
    );

    console.log('kanban drag confirm-before-dispatch contract test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban drag confirm-before-dispatch contract test failed:', error);
    process.exit(1);
}
