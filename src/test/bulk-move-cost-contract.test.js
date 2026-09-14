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

    test('moveAll handler uses try/finally to manage bulkMoveActive and fires single refresh at end', () => {
        const moveAllIndex = kanbanProviderSrc.indexOf("case 'moveAll':");
        assert.ok(moveAllIndex !== -1, 'moveAll case must exist');
        const moveAllBlock = kanbanProviderSrc.slice(moveAllIndex, moveAllIndex + 4000);

        assert.ok(moveAllBlock.includes('setBulkMoveActive(true)'), 'moveAll must set bulk move active true');
        assert.ok(moveAllBlock.includes('finally {'), 'moveAll must use try/finally');
        assert.ok(moveAllBlock.includes('setBulkMoveActive(false)'), 'moveAll finally must reset bulk move active to false');
        assert.ok(
            moveAllBlock.includes("executeCommand('switchboard.refreshUI'") ||
            moveAllBlock.includes('_scheduleBoardRefresh'),
            'moveAll finally must trigger final refresh'
        );
    });

    test('moveAll and moveSelected check BULK_MOVE_MAX_CARDS and refuse if exceeded', () => {
        const moveAllIndex = kanbanProviderSrc.indexOf("case 'moveAll':");
        const moveAllBlock = kanbanProviderSrc.slice(moveAllIndex, moveAllIndex + 1200);
        assert.ok(
            moveAllBlock.includes('BULK_MOVE_MAX_CARDS'),
            'moveAll must enforce BULK_MOVE_MAX_CARDS'
        );

        const moveSelectedIndex = kanbanProviderSrc.indexOf("case 'moveSelected':");
        const moveSelectedBlock = kanbanProviderSrc.slice(moveSelectedIndex, moveSelectedIndex + 1200);
        assert.ok(
            moveSelectedBlock.includes('BULK_MOVE_MAX_CARDS'),
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
