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

    // ── 1. triggerAction: persist → confirm → dispatch ────────────────────────
    const triggerAction = sliceBetween(
        provider,
        "case 'triggerAction': {",
        "case 'triggerBatchAction': {",
        "triggerAction arm"
    );
    assertOrder(
        triggerAction,
        "type: 'moveCards'",
        'dispatchConfiguredKanbanColumnAction',
        'triggerAction (custom-user branch)'
    );
    assertOrder(
        triggerAction,
        "type: 'moveCards'",
        "'switchboard.triggerAgentFromKanban'",
        'triggerAction (built-in CLI branch)'
    );
    assertOrder(
        triggerAction,
        "type: 'moveCards'",
        '_generatePromptForColumn',
        'triggerAction (prompt fallback)'
    );
    assert.ok(
        triggerAction.includes("type: 'moveCardsFailed'"),
        'triggerAction must post moveCardsFailed when moveCardToColumn returns falsy — a hopeful ' +
        'echo that is never corrected leaves the card lying about where it is.'
    );
    assert.ok(
        /const ok = await this\.moveCardToColumn\(/.test(triggerAction),
        "triggerAction must check moveCardToColumn's return value, not discard it."
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
        "type: 'moveCards'",
        'dispatchConfiguredKanbanColumnAction',
        'triggerBatchAction (custom-user branch)'
    );
    assertOrder(
        triggerBatch,
        "type: 'moveCards'",
        "'switchboard.triggerBatchAgentFromKanban'",
        'triggerBatchAction (built-in branch)'
    );
    assert.ok(
        triggerBatch.includes("type: 'moveCardsFailed'"),
        'triggerBatchAction must post moveCardsFailed for cards whose write failed.'
    );
    assert.ok(
        /dispatchConfiguredKanbanColumnAction\(role, dispatchIds,/.test(triggerBatch) &&
        /'switchboard\.triggerBatchAgentFromKanban', role, dispatchIds,/.test(triggerBatch),
        'triggerBatchAction must dispatch the persisted ids (dispatchIds), not the raw sessionIds — ' +
        'a card whose write failed must not be dispatched.'
    );
    assert.ok(
        /let dispatchIds: string\[\] = Array\.isArray\(sessionIds\) \? \[\.\.\.sessionIds\] : \[\];/.test(triggerBatch),
        'triggerBatchAction must seed dispatchIds from sessionIds so an unresolved workspaceRoot skips ' +
        'only the persist loop and still dispatches. Nesting the dispatch inside the workspaceRoot ' +
        'guard turns that path into a silent no-op.'
    );
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
        "type: 'moveCards'",
        'dispatchConfiguredKanbanColumnAction',
        'promptOnDrop (custom-user / prompt-mode branch)'
    );
    assertOrder(
        promptOnDrop,
        "type: 'moveCards'",
        '_generatePromptForColumn',
        'promptOnDrop (routing + general branches)'
    );
    assertOrder(
        promptOnDrop,
        "type: 'moveCards'",
        'clipboard.writeText',
        'promptOnDrop (routing + general branches)'
    );
    assert.ok(
        promptOnDrop.includes("type: 'moveCardsFailed'"),
        'promptOnDrop must post moveCardsFailed for cards whose write failed.'
    );
    assertOrder(
        promptOnDrop,
        "showErrorMessage('No coding agent is currently enabled",
        'const targetCol = this._targetColumnForDispatchRole(',
        'The no-coding-agent early return must stay ABOVE the persist loop — it aborts the whole ' +
        'operation and must not leave cards half-moved.'
    );

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
