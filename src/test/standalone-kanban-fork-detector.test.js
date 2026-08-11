'use strict';

/**
 * Standalone Kanban Fork-Detector — structural gate.
 *
 * The standalone host (`src/standalone/bootstrap.ts`) previously forked seven
 * verb cases (moveSelected/moveAll, promptSelected/promptAll, chatCopyPrompt,
 * completePlan/completeSelected) plus two helper functions (getNextKanbanColumn,
 * getRoleForTargetColumn) from the extension's KanbanProvider. Every one of
 * those forks had drifted. This test ensures they never come back.
 *
 * Three assertions:
 *  1. No column-ID→column-ID mapping literal exists in bootstrap.ts (the
 *     shape of the deleted getNextKanbanColumn map).
 *  2. The seven forked verb cases are absent from the kanbanVerb switch —
 *     they must reach `default:` which delegates to kanbanProvider.
 *  3. The dead `sourceColumn` parameter on `moveSessionsToColumn` is gone.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const bootstrapCode = fs.readFileSync(
    path.join(__dirname, '../standalone/bootstrap.ts'), 'utf8'
);

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

// 1. No column-ID→column-ID mapping literal (the shape of getNextKanbanColumn).
test('no column-ID to column-ID mapping literal in bootstrap.ts', () => {
    // The deleted function was:
    //   const map: Record<string, string> = { 'CREATED': 'PLAN REVIEWED', ... };
    // A mapping between kanban column IDs is the structural signature of the
    // fork. This regex matches a Record<string,string> (or similar object
    // literal) where both keys and values are known kanban column IDs.
    const columnIdPattern = /'(CREATED|RESEARCHER|PLAN REVIEWED|LEAD CODED|CODER CODED|INTERN CODED|CODE REVIEWED|ACCEPTANCE TESTED|COMPLETED|TICKET UPDATER)'\s*:\s*'(CREATED|RESEARCHER|PLAN REVIEWED|LEAD CODED|CODER CODED|INTERN CODED|CODE REVIEWED|ACCEPTANCE TESTED|COMPLETED|TICKET UPDATER)'/;
    assert.ok(
        !columnIdPattern.test(bootstrapCode),
        'bootstrap.ts must not contain a column-ID→column-ID mapping literal — this is the shape of the deleted getNextKanbanColumn fork'
    );
});

// 2. The seven forked verb cases are absent.
const forkedVerbs = [
    'moveSelected',
    'moveAll',
    'promptSelected',
    'promptAll',
    'chatCopyPrompt',
    'completePlan',
    'completeSelected',
];

for (const verb of forkedVerbs) {
    test(`case '${verb}' is absent from kanbanVerb switch (delegated to default:)`, () => {
        // Match `case 'verb':` at the start of a case label inside the switch.
        // The comment block that documents the deletion also mentions these
        // verbs by name, so we must match the `case` keyword specifically.
        const casePattern = new RegExp(`case\\s+'${verb}'\\s*:`, 'g');
        const matches = bootstrapCode.match(casePattern);
        assert.ok(
            matches === null,
            `bootstrap.ts must not contain case '${verb}': — it must fall through to default: (delegated to kanbanProvider.handleServiceVerb)`
        );
    });
}

// 3. moveSessionsToColumn must not carry the dead sourceColumn parameter.
test('moveSessionsToColumn has no dead sourceColumn parameter', () => {
    // The old signature was: (sessionIds, sourceColumn, targetColumn)
    // The new signature is: (sessionIds, targetColumn)
    assert.ok(
        !/moveSessionsToColumn\s*=\s*async\s*\(\s*sessionIds\s*:\s*string\[\]\s*,\s*sourceColumn/.test(bootstrapCode),
        'moveSessionsToColumn must not carry the dead sourceColumn parameter — it was never read in the body'
    );
});

// 4. getNextKanbanColumn and getRoleForTargetColumn symbols are gone.
test('getNextKanbanColumn function is deleted', () => {
    assert.ok(
        !/function\s+getNextKanbanColumn\s*\(/.test(bootstrapCode),
        'getNextKanbanColumn must be deleted — it duplicated _getNextColumnId with no visibility awareness'
    );
});

test('getRoleForTargetColumn function is deleted', () => {
    assert.ok(
        !/function\s+getRoleForTargetColumn\s*\(/.test(bootstrapCode),
        'getRoleForTargetColumn must be deleted — it duplicated _columnToRole with no custom-column awareness'
    );
});

// 5. _lastCards priming exists (the prerequisite for delegated moveAll/promptAll).
test('_lastCards is primed from the standalone board push', () => {
    assert.ok(
        bootstrapCode.includes('(kanbanProvider as any)._lastCards ='),
        'standalone must prime _lastCards from the board push so delegated moveAll/promptAll can resolve their card set'
    );
});

// 6. CLI-triggers gate exists in handlePtyVerb's triggerAction.
test('CLI-triggers gate exists in handlePtyVerb triggerAction', () => {
    assert.ok(
        bootstrapCode.includes("'CLI triggers are disabled'") ||
        bootstrapCode.includes('"CLI triggers are disabled"'),
        'handlePtyVerb triggerAction must gate on kanban.cliTriggersEnabled (mirroring KanbanProvider.ts:8153)'
    );
});

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
