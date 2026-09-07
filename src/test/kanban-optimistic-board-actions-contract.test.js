const fs = require('fs');
const path = require('path');
const assert = require('assert');

/**
 * Contract for the feature "A Click Does What It Looks Like It Did, Especially Over a
 * Remote Board" — three board actions that used to wait on a host round trip:
 *
 *  1. Send to Backlog / Send to New apply optimistically (subtask d845c19b).
 *  2. The priority star applies optimistically (subtask 20d4a089).
 *  3. Review Plan selects its own plan without refetching the whole board (subtask
 *     9a6ceb8d).
 *
 * All three are latency behaviours whose failure mode is "the click looks like it did
 * nothing" — invisible on loopback, reported only over the tailnet. There is no runtime
 * harness for kanban.html, so these are source-level invariants: they discriminate
 * exactly the regressions each plan names (a post-and-do-nothing-else handler, a
 * silent-no-op optimistic helper, a forcing ledger nothing clears, a tab click that
 * drags a 2,555-plan refetch behind it).
 */

const WEBVIEW = path.join(__dirname, '../webview');
const SERVICES = path.join(__dirname, '../services');

const KANBAN_HTML = fs.readFileSync(path.join(WEBVIEW, 'kanban.html'), 'utf8');
const PROJECT_JS = fs.readFileSync(path.join(WEBVIEW, 'project.js'), 'utf8');
const KANBAN_PROVIDER = fs.readFileSync(path.join(SERVICES, 'KanbanProvider.ts'), 'utf8');
const PLANNING_PROVIDER = fs.readFileSync(path.join(SERVICES, 'PlanningPanelProvider.ts'), 'utf8');
const VERB_ALLOWLIST = fs.readFileSync(path.join(__dirname, '../generated/verbAllowlist.ts'), 'utf8');

/** Slice from `startNeedle` to the first `endNeedle` after it. */
function slice(source, startNeedle, endNeedle, label) {
    const a = source.indexOf(startNeedle);
    assert.notStrictEqual(a, -1, `${label}: could not find ${JSON.stringify(startNeedle)}`);
    const b = source.indexOf(endNeedle, a + startNeedle.length);
    assert.notStrictEqual(b, -1, `${label}: could not find ${JSON.stringify(endNeedle)} after it`);
    return source.slice(a, b);
}

function assertOrder(body, first, second, label) {
    const i = body.indexOf(first);
    const j = body.indexOf(second);
    assert.notStrictEqual(i, -1, `${label}: missing ${JSON.stringify(first)}`);
    assert.notStrictEqual(j, -1, `${label}: missing ${JSON.stringify(second)}`);
    assert.strictEqual(i < j, true, `${label}: ${JSON.stringify(first)} must appear before ${JSON.stringify(second)}`);
}

// ---------------------------------------------------------------------------
// Subtask 2 — the priority star applies optimistically
// ---------------------------------------------------------------------------
function testPriorityStarIsOptimistic() {
    const branch = slice(
        KANBAN_HTML,
        "if (btn.classList.contains('star-btn')) {",
        "if (btn.classList.contains('priority-btn')) {",
        'star-btn branch'
    );

    // Goal invariant: the visual change does not await the post. The class flip, the
    // data-starred flip and the model update all precede postKanbanMessage. A handler
    // that only posts is the bug this plan exists to fix.
    assertOrder(branch, 'btn.dataset.starred = nextStarred', "type: 'setPriorityStarred'", 'star branch');
    assertOrder(branch, "btn.classList.toggle('starred'", "type: 'setPriorityStarred'", 'star branch');
    assertOrder(branch, 'pendingStars.set(', "type: 'setPriorityStarred'", 'star branch');
    assert.match(branch, /setAttribute\('fill'/,
        'star branch must update the SVG fill so the icon matches the rendered state');
    assert.match(branch, /cc\.priorityStarred = nextStarred/,
        'star branch must advance the currentCards model entry');
    assert.match(branch, /ac\.priorityStarred = nextStarred/,
        'star branch must advance the allCards model entry (drives occupancy + starred count)');
    assert.match(branch, /lastBoardSignature = buildBoardSignature\(currentCards\)/,
        'star branch must re-baseline the board signature so the next push does not flicker');

    // Goal invariant: the sort applies at the same instant, through the SHARED
    // comparator — not a private mirror of renderBoard's ordering.
    assert.match(branch, /repositionCardInColumn\(/,
        'star branch must reposition the card in its column optimistically');
    const reposition = slice(KANBAN_HTML, 'function repositionCardInColumn(',
        '\n        function renderBoard(', 'repositionCardInColumn');
    assert.match(reposition, /compareCardsByPrecedence\(/,
        'repositionCardInColumn must consume the shared comparator, not mirror it');

    // Goal invariant (paired negative): renderBoard consumes the same comparator and no
    // longer carries its own inline starred-first sort. Two copies of "where does this
    // card go" is the drift this was extracted to prevent.
    assert.match(KANBAN_HTML, /function compareCardsByPrecedence\(a, b, colId\)/,
        'compareCardsByPrecedence must exist as a shared function');
    const renderBoardBody = slice(KANBAN_HTML, 'function renderBoard(', 'function createMissionCardHtml',
        'renderBoard');
    assert.match(renderBoardBody, /sort\(\(a, b\) => compareCardsByPrecedence\(a, b, col\)\)/,
        'renderBoard must sort each column through the shared comparator');
    assert.strictEqual(
        /const sa = a\.priorityStarred \? 1 : 0;/.test(renderBoardBody),
        false,
        'renderBoard must not keep an inline starred-first sort alongside the shared comparator'
    );

    console.log('  ✓ priority star applies optimistically through the shared comparator');
}

function testPendingStarLedgerIsLatencyRobustAndBounded() {
    assert.match(KANBAN_HTML, /const pendingStars = new Map\(\)/,
        'a pendingStars ledger must exist on the board');

    // Goal invariant: the ledger is consulted by the reconciliation/overlay path, so a
    // slow remote push cannot revert a fast local click.
    const overlay = slice(KANBAN_HTML, 'function applyPendingOptimisticMoves(', '\n        function ',
        'applyPendingOptimisticMoves');
    assert.match(overlay, /pendingStars\.has\(id\)/,
        'applyPendingOptimisticMoves must apply the pending-star overlay');
    assert.match(overlay, /priorityStarred: pendingStars\.get\(id\)\.value/,
        'the overlay must read the ledger entry value');

    // Goal invariant (negative): no code path clears pendingStars purely on the 2 s
    // optimistic-move expiry. The timer is tuned for the local postMessage round trip
    // and expires mid-flight on the remote case this plan exists to fix.
    const armGuard = slice(KANBAN_HTML, 'function armOptimisticGuard(', 'function clearOptimisticGuard(',
        'armOptimisticGuard');
    assert.strictEqual(armGuard.includes('pendingStars'), false,
        'the OPTIMISTIC_MOVE_WINDOW_MS expiry timer must not clear pendingStars');
    const resolveGuard = slice(KANBAN_HTML, 'function resolveOptimisticGuard(', '\n        let currentWorkspaceRoot',
        'resolveOptimisticGuard');
    assert.strictEqual(resolveGuard.includes('pendingStars'), false,
        'resolveOptimisticGuard (the move-delta path) must not clear pendingStars');

    // A workspace switch DOES void it — the board is replaced wholesale.
    const clearGuard = slice(KANBAN_HTML, 'function clearOptimisticGuard(', 'function resolveOptimisticGuard(',
        'clearOptimisticGuard');
    assert.match(clearGuard, /pendingStars\.clear\(\)/,
        'a workspace switch must void in-flight star toggles for the previous board');

    // Cleared by a MATCHING updateBoard push...
    const updateBoard = slice(KANBAN_HTML, "case 'updateBoard': {", "case 'settingResult'", 'updateBoard');
    assert.match(updateBoard, /!!card\.priorityStarred === !!pendingStars\.get\(id\)\.value/,
        'updateBoard must clear a ledger entry the server has confirmed');
    assertOrder(updateBoard, 'pendingStars.delete(id)', 'allCards = applyPendingOptimisticMoves(',
        'updateBoard');

    // ...and TTL-bounded, because neither host emits a card-keyed ack. Without this an
    // unconfirmed toggle (failed write, or a concurrent edit by another client whose
    // value never matches) forces the optimistic star onto every later push for the
    // life of the board — a forcing overlay nothing resolves.
    assert.match(KANBAN_HTML, /const PENDING_STAR_TTL_MS = \d+/,
        'the pending-star ledger must be TTL-bounded (no card-keyed ack exists)');
    assert.match(KANBAN_HTML, /function expirePendingStars\(/,
        'an expiry sweep for pendingStars must exist');
    assert.match(updateBoard, /expirePendingStars\(\)/,
        'every board push must expire stale pending-star entries so the server can win');
    assert.match(overlay, /expirePendingStars\(\)/,
        'the overlay must not apply an entry whose TTL has elapsed');

    console.log('  ✓ pendingStars survives guard expiry, is cleared by a matching push, and is TTL-bounded');
}

// ---------------------------------------------------------------------------
// Subtask 1 — Send to Backlog / Send to New apply optimistically
// ---------------------------------------------------------------------------
function testSendToBacklogAndNewAreOptimistic() {
    // The helper must resolve its target through the DISPLAY rules. resolveDomColumn
    // passes 'BACKLOG' straight through, and no col-BACKLOG container exists on the
    // board, so the old `if (!targetBody) return;` made the whole call a provable
    // no-op for exactly the two buttons this subtask is about.
    const helper = slice(KANBAN_HTML, 'function moveCardsOptimistically(', '\n        function ',
        'moveCardsOptimistically');
    assert.match(helper, /resolveDisplayColumn\(targetColumn\)/,
        'moveCardsOptimistically must resolve its target through resolveDisplayColumn');
    assert.strictEqual(/resolveDomColumn\(targetColumn\)/.test(helper), false,
        'moveCardsOptimistically must not resolve its target through resolveDomColumn');
    assert.strictEqual(/if \(!targetBody\) return;/.test(helper), false,
        'a missing target container must not abort the call before the model mutation');
    assert.match(helper, /targetBody \? moveCardElements\(entries\) : sessionIds\.slice\(\)/,
        'with no target container every id must be reported unresolved, not silently skipped');
    // The model mutation, the guard and the render fallback must all still run.
    assertOrder(helper, 'const unresolved =', 'armOptimisticGuard(entries)', 'moveCardsOptimistically');
    assert.match(helper, /allCards\.forEach\(/,
        'moveCardsOptimistically must sync allCards so the count badges track the move');
    assert.match(helper, /if \(unresolvedNeedsRender\(unresolved\)\) \{\s*renderBoard\(currentCards\)/,
        'an unplaceable renderable card must route to the renderBoard fallback');

    for (const [cls, target] of [['send-to-backlog-btn', "'BACKLOG'"], ['send-to-new-btn', "'CREATED'"]]) {
        const branch = slice(KANBAN_HTML, `if (btn.classList.contains('${cls}')) {`, 'return;', cls);
        // The dataset must be read into locals BEFORE the optimistic step: its
        // renderBoard fallback rebuilds every card and detaches this button mid-handler.
        assertOrder(branch, 'const sessionId = btn.dataset.session', 'moveCardsOptimistically(', cls);
        assertOrder(branch, 'const planId = btn.dataset.planId', 'moveCardsOptimistically(', cls);
        assertOrder(branch, 'moveCardsOptimistically(', 'postKanbanMessage(', cls);
        assert.match(branch, new RegExp(`moveCardsOptimistically\\(\\[key\\], [^)]*, ${target}\\)`),
            `${cls} must move optimistically to ${target}`);
    }

    // The backend verbs must emit the deltas that RESOLVE the ledger. Arming a forcing
    // overlay with nothing to clear it is worse than not arming it, and a failed
    // moveCardToColumn write returns false rather than throwing — discarding it makes
    // the failure silent and unrecoverable.
    for (const [verb, target] of [['sendToBacklog', 'BACKLOG'], ['sendToNew', 'CREATED']]) {
        const body = slice(KANBAN_PROVIDER, `case '${verb}': {`, '\n            case ', verb);
        assert.match(body, new RegExp(`const ok = await this\\.moveCardToColumn\\([^)]*'${target}'\\)`),
            `${verb} must honour moveCardToColumn's boolean result`);
        assert.match(body, new RegExp(`type: 'moveCards', sessionIds: \\[resolvedSessionId\\], targetColumn: '${target}'`),
            `${verb} must emit moveCards on success so the optimistic ledger resolves`);
        assert.match(body, /type: 'moveCardsFailed'/,
            `${verb} must emit moveCardsFailed so a failed write reverts the optimistic move`);
        assert.match(body, /sourceColumn/,
            `${verb} must carry the pre-move column so the revert targets the real source`);
        assert.match(body, /return \{ success: ok, sessionId: resolvedSessionId \}/,
            `${verb} must report the write's real outcome, not an unconditional success`);
    }

    console.log('  ✓ send-to-backlog / send-to-new apply optimistically and their ledger resolves');
}

// ---------------------------------------------------------------------------
// Subtask 3 — Review Plan selects its plan without refetching the board
// ---------------------------------------------------------------------------
function testReviewPlanColdPanelQueue() {
    // wsHub.broadcast iterates live connections only, so a browser-originated
    // activation pushed before the Project panel's WS handshake completes is delivered
    // to nobody and never retried. Single-slot, latest-wins, expiry-bounded.
    const push = slice(PLANNING_PROVIDER, 'public pushProjectMessageToWsOnly(',
        'private _flushPendingWsOnlyProjectActivation(', 'pushProjectMessageToWsOnly');
    assert.match(push, /message\.type === 'activateKanbanTabAndSelectPlan'/,
        'pushProjectMessageToWsOnly must stash the activation for a cold panel');
    assert.match(push, /this\._pendingWsOnlyProjectActivation = message/,
        'the queue must hold the LATEST activation only (single slot)');
    assert.match(push, /setTimeout\(/,
        'the queued activation must expire so a stale click cannot hijack the panel');

    const flush = slice(PLANNING_PROVIDER, 'private _flushPendingWsOnlyProjectActivation(',
        '\n    }\n', 'flush');
    assert.match(flush, /this\._pendingWsOnlyProjectActivation = undefined/,
        'the flush must clear the slot so an activation is delivered once');
    assert.match(flush, /mirrorToWs\('project', message\)/,
        'the flush must deliver over the WS fan-out');

    const ready = slice(PLANNING_PROVIDER, "case 'webviewReady':", 'return { success: true };',
        'webviewReady');
    assert.match(ready, /_flushPendingWsOnlyProjectActivation\(\)/,
        'webviewReady must flush the WS-only cold-panel queue');

    // The browser side must re-post webviewReady once its connection has provably
    // joined the hub's broadcast set. A `ready` posted during the handshake is
    // broadcast to zero subscribers and lost — the same trap setup.html documents.
    assert.match(PROJECT_JS, /addEventListener\('sbTransportSubscribed'/,
        'project.js must re-request on sbTransportSubscribed');
    const subscribed = slice(PROJECT_JS, "addEventListener('sbTransportSubscribed'", '});',
        'sbTransportSubscribed listener');
    assert.match(subscribed, /type: 'webviewReady'/,
        'the sbTransportSubscribed listener must re-post webviewReady to flush the queue');

    console.log('  ✓ the WS-only push path has a bounded cold-panel queue flushed on WS-ready');
}

function testReviewPlanDoesNotRefetchTheBoard() {
    const activation = slice(PROJECT_JS, "case 'activateKanbanTabAndSelectPlan': {",
        "case 'featureDetails'", 'activateKanbanTabAndSelectPlan');

    // The tab click's own fetchKanbanPlans is the 1.4 MB / 2,555-plan multi-workspace
    // refetch measured at 2.2 s behind every Review Plan click.
    assert.match(activation, /_suppressNextKanbanTabFetch = true/,
        'the activation must suppress the Kanban tab click fetch');
    assertOrder(activation, '_suppressNextKanbanTabFetch = true', 'kanbanTabBtn.click()',
        'activation');
    assertOrder(activation, 'kanbanTabBtn.click()', '_suppressNextKanbanTabFetch = false',
        'activation');
    const tabHandler = slice(PROJECT_JS, "if (activeTab === 'kanban') {", "} else if (activeTab === 'projects')",
        'kanban tab click');
    assert.match(tabHandler, /if \(!_suppressNextKanbanTabFetch\)/,
        'the Kanban tab click must honour the suppression flag');

    // Cache hit resolves with zero fetch; cache miss fetches ONE plan.
    assert.match(activation, /_kanbanPlansCache\.find\(/,
        'the activation must try the cache before any fetch');
    assert.match(activation, /type: 'fetchKanbanPlan', planId: msg\.planId/,
        'a cache miss must fetch the single plan, not the list');
    const cachedBranch = slice(activation, 'if (cached) {', '} else if (msg.planId)', 'cache-hit branch');
    assert.strictEqual(cachedBranch.includes('fetchKanbanPlans'), false,
        'the cache-hit path must issue no list fetch at all');

    // The single-plan verb must exist, be reachable from the browser, and land in the
    // cache in the same summary shape a list fetch produces.
    assert.match(PLANNING_PROVIDER, /case 'fetchKanbanPlan': \{/,
        'the fetchKanbanPlan verb must exist');
    assert.match(PLANNING_PROVIDER, /private async _getKanbanPlanSummaryByPlanId\(/,
        'the single-plan summary lookup must exist');
    assert.match(VERB_ALLOWLIST, /'fetchKanbanPlan'/,
        "fetchKanbanPlan must be in the generated PLANNING_VERBS allowlist (browser reachability)");
    const planReady = slice(PROJECT_JS, "case 'kanbanPlanReady':", 'break;', 'kanbanPlanReady');
    assert.match(planReady, /_kanbanPlansCache/,
        'kanbanPlanReady must insert the plan into the cache');
    assert.match(planReady, /tryResolvePendingKanbanSelection\(\)/,
        'kanbanPlanReady must resolve the pending selection');

    console.log('  ✓ Review Plan selects from cache or one row, never the whole board');
}

function testScopedPlanFetchDoesNotNarrowGlobalState() {
    const fetchPlans = slice(PLANNING_PROVIDER, "case 'fetchKanbanPlans': {", "case 'fetchKanbanPlanPreview'",
        'fetchKanbanPlans');

    // A named root that matches no allowed root must fail loudly, not post an empty
    // scoped payload — the webview's merge-by-workspace branch would drop that
    // workspace's whole cache and add nothing back.
    assert.match(fetchPlans, /if \(requestedRoot && allRoots\.length === 0\)/,
        'an unmatched workspaceRoot must be reported, not silently scoped to nothing');
    assert.match(fetchPlans, /is not an allowed root/,
        'the unmatched-root failure must name the offending root');

    // The scoped payload must be tagged with the SAME root the plans in it carry.
    // The webview de-duplicates on that comparison; a raw request string that differs
    // from the effective root removes nothing and appends duplicates.
    assert.match(fetchPlans, /const scopedTagRoot = requestedRoot/,
        'the scoped payload root must be derived, not echoed');
    assert.match(fetchPlans, /_resolveEffectiveWorkspaceRoot\(allRoots\[0\]\)/,
        'the scoped payload must carry the effective root the plans are tagged with');
    assert.strictEqual(/workspaceRoot: requestedRoot \|\| undefined/.test(fetchPlans), false,
        'the scoped payload must not echo the raw requested root as its workspace tag');

    // A scoped payload carries the project/column maps for ONE root. Assigning them
    // wholesale drops every other workspace's projects and any column contributed only
    // by another workspace.
    const planReady = slice(PROJECT_JS, "case 'kanbanPlansReady':", "case 'kanbanPlanReady'",
        'kanbanPlansReady');
    assert.match(planReady, /const _kanbanScoped = !!msg\.workspaceRoot/,
        'the webview must distinguish a scoped payload from a full one');
    assert.match(planReady, /_kanbanScoped \? \{ \.\.\._kanbanAllWorkspaceProjects \} : \{\}/,
        'a scoped payload must MERGE allWorkspaceProjects, not replace it');
    assert.match(planReady, /_kanbanScoped \? \{ \.\.\._kanbanAllWorkspaceProjectPaths \} : \{\}/,
        'a scoped payload must MERGE allWorkspaceProjectPaths, not replace it');
    assert.match(planReady, /if \(_kanbanScoped && Array\.isArray\(_kanbanAvailableColumns\)/,
        'a scoped payload must MERGE the column list, not replace it');

    console.log('  ✓ a workspace-scoped plan fetch cannot narrow global project/column state');
}

// ---------------------------------------------------------------------------
// Cross-cutting: the editor path must be left alone (plan 3, change 6)
// ---------------------------------------------------------------------------
function testEditorPathUnchanged() {
    const reviewPlan = slice(KANBAN_PROVIDER, "case 'reviewPlan': {", "case 'pauseLiveSync'", 'reviewPlan');
    assert.match(reviewPlan, /msg\.__viaHttp === true/,
        'reviewPlan must still branch on __viaHttp');
    const viaHttp = slice(reviewPlan, 'if (msg.__viaHttp === true) {', 'return { success: true, sessionId: reviewId };',
        '__viaHttp branch');
    assert.match(viaHttp, /pushProjectMessageToWsOnly\(reviewActivateMsg\)/,
        'the browser branch must stay WS-only (revealing the editor panel steals focus)');
    assert.strictEqual(/createOrShowProjectPanel|reveal\(/.test(viaHttp), false,
        'the browser branch must not open or reveal the editor Project panel');

    console.log('  ✓ the editor path and the browser no-focus-steal rule are unchanged');
}

function testKanbanOptimisticBoardActionsContract() {
    testPriorityStarIsOptimistic();
    testPendingStarLedgerIsLatencyRobustAndBounded();
    testSendToBacklogAndNewAreOptimistic();
    testReviewPlanColdPanelQueue();
    testReviewPlanDoesNotRefetchTheBoard();
    testScopedPlanFetchDoesNotNarrowGlobalState();
    testEditorPathUnchanged();
    console.log('testKanbanOptimisticBoardActionsContract passed all assertions successfully.');
}

module.exports = { testKanbanOptimisticBoardActionsContract };

if (require.main === module) {
    testKanbanOptimisticBoardActionsContract();
}
