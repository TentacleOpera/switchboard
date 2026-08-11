#!/usr/bin/env node
'use strict';

/**
 * Kanban Dispatch Callers Guard.
 *
 * Ensures the webview's CODED_AUTO drop path sends `targetColumn: 'CODED_AUTO'`
 * as intent (not a pre-resolved column), and that the server's KanbanProvider
 * delegates CODED_AUTO to `_advanceCards` for per-card complexity routing.
 *
 * Three assertions:
 *  1. resolveCodedAutoTarget is absent from kanban.html (deleted).
 *  2. The CODED_AUTO drop block sends targetColumn: 'CODED_AUTO' (not a
 *     pre-resolved target).
 *  3. KanbanProvider's triggerBatchAction and triggerAction arms delegate
 *     CODED_AUTO to _advanceCards.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const kanbanHtml = fs.readFileSync(path.join(REPO_ROOT, 'src/webview/kanban.html'), 'utf8');
const kanbanProviderCode = fs.readFileSync(path.join(REPO_ROOT, 'src/services/KanbanProvider.ts'), 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}\n     ${e.message}`);
        failed++;
    }
}

// 1. resolveCodedAutoTarget is deleted from kanban.html.
test('resolveCodedAutoTarget is absent from kanban.html', () => {
    assert.ok(
        !/function\s+resolveCodedAutoTarget\s*\(/.test(kanbanHtml),
        'resolveCodedAutoTarget must be deleted from kanban.html — the server resolves complexity routing via _advanceCards'
    );
});

// 2. The CODED_AUTO drop block sends targetColumn: 'CODED_AUTO'.
test('CODED_AUTO drop sends targetColumn CODED_AUTO as intent', () => {
    // The drop block must send 'CODED_AUTO' as the targetColumn, not a
    // pre-resolved column ID. Look for the pattern in the triggerAction /
    // triggerBatchAction messages within the CODED_AUTO drop block.
    const codedAutoBlock = kanbanHtml.substring(
        kanbanHtml.indexOf("if (targetColumn === 'CODED_AUTO')"),
        kanbanHtml.indexOf("const forwardIds = []")
    );
    assert.ok(codedAutoBlock.includes("targetColumn: 'CODED_AUTO'"),
        'CODED_AUTO drop block must send targetColumn: \'CODED_AUTO\' as intent'
    );
});

// 3. KanbanProvider delegates CODED_AUTO to _advanceCards.
test('KanbanProvider triggerBatchAction delegates CODED_AUTO to _advanceCards', () => {
    const armStart = kanbanProviderCode.indexOf("case 'triggerBatchAction':");
    assert.ok(armStart !== -1, "case 'triggerBatchAction': not found");
    const armEnd = kanbanProviderCode.indexOf("case 'moveCardBackwards':", armStart);
    const armCode = kanbanProviderCode.substring(armStart, armEnd);
    assert.ok(
        armCode.includes("_advanceCards") && armCode.includes("CODED_AUTO"),
        'triggerBatchAction must delegate CODED_AUTO to _advanceCards'
    );
});

test('KanbanProvider triggerAction delegates CODED_AUTO to _advanceCards', () => {
    const armStart = kanbanProviderCode.indexOf("case 'triggerAction':");
    assert.ok(armStart !== -1, "case 'triggerAction': not found");
    // Find the next case after triggerAction
    const nextCase = kanbanProviderCode.indexOf("\n            case '", armStart + 100);
    const armCode = kanbanProviderCode.substring(armStart, nextCase);
    assert.ok(
        armCode.includes("_advanceCards") && armCode.includes("CODED_AUTO"),
        'triggerAction must delegate CODED_AUTO to _advanceCards'
    );
});

// 4. _advanceCards method exists.
test('_advanceCards method exists on KanbanProvider', () => {
    assert.ok(
        /private\s+async\s+_advanceCards\s*\(/.test(kanbanProviderCode),
        '_advanceCards method must exist on KanbanProvider — the unified advance operation'
    );
});

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
