'use strict';

/**
 * Bulk move cost contract — ensures that moving cards in bulk (e.g. moveAll, moveSelected)
 * coalesces to one refresh and cannot outgrow the board.
 *
 * Plan: a-bulk-move-cannot-outgrow-the-board
 * Goals:
 * 1. Bulk move scope flag suppresses watcher-driven refreshes at both composition roots:
 *    - KanbanProvider.refreshIfShowing (extension root)
 *    - ingestionEngine.onPlanDiscovered in bootstrap.ts (standalone root)
 * 2. Bounded fanout for subtask cascaded integration and runsheet updates in moveCardToColumnWithReason.
 * 3. Bulk move backstop ceiling rejects absurd counts (>500) with a loud error.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err && err.message}`);
    }
}

async function runAsyncTest(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err && err.message}`);
    }
}

(async function main() {
    console.log('\n── Bulk Move Cost & Invariant Contract Tests ──');

    const kanbanProviderPath = path.join(REPO_ROOT, 'src', 'services', 'KanbanProvider.ts');
    const bootstrapPath = path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts');

    test('Source files exist', () => {
        assert.ok(fs.existsSync(kanbanProviderPath), 'KanbanProvider.ts must exist');
        assert.ok(fs.existsSync(bootstrapPath), 'bootstrap.ts must exist');
    });

    const kanbanProviderSrc = fs.readFileSync(kanbanProviderPath, 'utf8');
    const bootstrapSrc = fs.readFileSync(bootstrapPath, 'utf8');

    test('KanbanProvider defines BULK_MOVE_MAX_CARDS ceiling (500)', () => {
        assert.ok(
            kanbanProviderSrc.includes('BULK_MOVE_MAX_CARDS = 500') ||
            kanbanProviderSrc.includes('BULK_MOVE_MAX_CARDS = 500;'),
            'KanbanProvider must define BULK_MOVE_MAX_CARDS = 500'
        );
    });

    test('KanbanProvider defines isBulkMoveActive / setBulkMoveActive', () => {
        assert.ok(
            kanbanProviderSrc.includes('isBulkMoveActive(): boolean'),
            'KanbanProvider must have isBulkMoveActive'
        );
        assert.ok(
            kanbanProviderSrc.includes('setBulkMoveActive('),
            'KanbanProvider must have setBulkMoveActive'
        );
    });

    test('Extension root: refreshIfShowing suppresses refresh when bulkMove is active', () => {
        const refreshIfShowingStart = kanbanProviderSrc.indexOf('public refreshIfShowing(');
        assert.ok(refreshIfShowingStart !== -1, 'refreshIfShowing method must exist');
        const refreshIfShowingBlock = kanbanProviderSrc.slice(refreshIfShowingStart, refreshIfShowingStart + 500);
        assert.ok(
            refreshIfShowingBlock.includes('_bulkMoveActive') ||
            refreshIfShowingBlock.includes('isBulkMoveActive'),
            'refreshIfShowing must check bulkMoveActive and return early'
        );
    });

    test('Standalone root: bootstrap.ts onPlanDiscovered suppresses push when bulkMove is active', () => {
        assert.ok(
            bootstrapSrc.includes('onPlanDiscovered'),
            'bootstrap.ts must have onPlanDiscovered'
        );
        assert.ok(
            bootstrapSrc.includes('isBulkMoveActive()'),
            'bootstrap.ts onPlanDiscovered must check isBulkMoveActive()'
        );
    });

    // The moveAll arm is ~4.5 KB of source, so a fixed-width slice cut the
    // `finally` block off the end and the assertion failed against a correct
    // implementation. Bound the window by the NEXT `case '` label instead.
    function caseBlock(src, label) {
        const start = src.indexOf(`case '${label}':`);
        assert.ok(start !== -1, `${label} case must exist`);
        const next = src.indexOf("case '", start + 8);
        return src.slice(start, next === -1 ? src.length : next);
    }

    test('moveAll handler uses try/finally to manage bulkMoveActive and fires single refresh at end', () => {
        const moveAllBlock = caseBlock(kanbanProviderSrc, 'moveAll');

        assert.ok(moveAllBlock.includes('setBulkMoveActive(true)'), 'moveAll must set bulk move active true');
        assert.ok(moveAllBlock.includes('finally {'), 'moveAll must use try/finally');
        assert.ok(moveAllBlock.includes('setBulkMoveActive(false)'), 'moveAll finally must reset bulk move active to false');
        assert.ok(
            moveAllBlock.includes("executeCommand('switchboard.refreshUI'"),
            'moveAll finally must trigger the final refresh through switchboard.refreshUI (registered at BOTH roots)'
        );
    });

    // The whole point of the guard is ONE rebuild. `_refreshBoard` is nothing
    // but a call to `switchboard.refreshUI`, so a finally that also schedules a
    // board refresh buys the extension host a second full board build per burst.
    test('bulk-move finally fires exactly one refresh, not a scheduled board refresh as well', () => {
        for (const label of ['moveSelected', 'moveAll']) {
            const block = caseBlock(kanbanProviderSrc, label);
            const finallyIdx = block.lastIndexOf('finally {');
            assert.ok(finallyIdx !== -1, `${label} must use try/finally`);
            const finallyBlock = block.slice(finallyIdx);
            assert.ok(
                !finallyBlock.includes('_scheduleBoardRefresh('),
                `${label} finally must not ALSO call _scheduleBoardRefresh — that is a second full board build`
            );
            const refreshCalls = finallyBlock.split("executeCommand('switchboard.refreshUI'").length - 1;
            assert.strictEqual(refreshCalls, 1, `${label} finally must call switchboard.refreshUI exactly once (got ${refreshCalls})`);
        }
    });

    test('moveAll and moveSelected check BULK_MOVE_MAX_CARDS and refuse if exceeded', () => {
        assert.ok(
            caseBlock(kanbanProviderSrc, 'moveAll').includes('BULK_MOVE_MAX_CARDS'),
            'moveAll must enforce BULK_MOVE_MAX_CARDS'
        );
        assert.ok(
            caseBlock(kanbanProviderSrc, 'moveSelected').includes('BULK_MOVE_MAX_CARDS'),
            'moveSelected must enforce BULK_MOVE_MAX_CARDS'
        );
    });

    test('moveCardToColumnWithReason applies fan-out in bounded chunks', () => {
        const moveCardIndex = kanbanProviderSrc.indexOf('public async moveCardToColumnWithReason(');
        assert.ok(moveCardIndex !== -1, 'moveCardToColumnWithReason must exist');
        const moveCardBlock = kanbanProviderSrc.slice(moveCardIndex, moveCardIndex + 4000);

        assert.ok(
            moveCardBlock.includes('FANOUT_CHUNK_SIZE') ||
            moveCardBlock.includes('chunk') ||
            moveCardBlock.includes('slice('),
            'moveCardToColumnWithReason must chunk the fan-out instead of unbounded Promise.allSettled'
        );
    });

    if (failures > 0) {
        console.error(`\n❌ ${failures} test(s) failed.`);
        process.exit(1);
    } else {
        console.log('\n✅ All bulk-move contract tests passed.');
        process.exit(0);
    }
})();
