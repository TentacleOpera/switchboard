/**
 * Regression tests for complexity parsing across kanban and MCP surfaces.
 * Run with: node src/test/kanban-complexity-regression.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { getComplexityFromContent } = require('../mcp-server/register-tools.js');

const kanbanProviderPath = path.join(__dirname, '..', 'services', 'KanbanProvider.ts');
const kanbanProviderSource = fs.readFileSync(kanbanProviderPath, 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (error) {
        console.error(`  FAIL ${name}: ${error.message}`);
        failed++;
    }
}

function run() {
    console.log('\nRunning kanban complexity regression tests\n');

    const lowPlan = [
        '# Test Plan',
        '',
        '## Complexity Audit',
        '',
        '### Band A (Routine)',
        '- All changes are text/element deletions in a single file.',
        '',
        '### Band B (Complex/Risky)',
        '- None.',
        '',
        '## Goal',
        '- Clarify expected outcome and scope.',
        '',
        '## Proposed Changes',
        '- TODO'
    ].join('\n');

    const highPlan = [
        '# Test Plan',
        '',
        '## Complexity Audit',
        '',
        '### Routine',
        '- Update a single label.',
        '',
        '### Complex / Risky',
        '- Rework the routing logic across multiple modules.',
        '',
        '## Goal',
        '- Keep true high-complexity plans classified as high.'
    ].join('\n');

    const recommendationOnlyCoderPlan = [
        '# Test Plan',
        '',
        '## Agent Recommendation',
        'Send it to the **Coder agent**.'
    ].join('\n');

    const recommendationOnlyLeadPlan = [
        '# Test Plan',
        '',
        '## Agent Recommendation',
        'Send it to the **Lead Coder**.'
    ].join('\n');

    const noBlankLinesPlan = [
        '# Test Plan',
        '## Complexity Audit',
        '### Routine',
        '- Simple localized change.',
        '### Complex / Risky',
        '- None'
    ].join('\n');

    const plainTextPlan = [
        '# Test Plan',
        '## Complexity Audit',
        '### Routine',
        'Just some minor terminology update without bullets.',
        '### Complex / Risky',
        'None'
    ].join('\n');

    const mixedBulletsPlan = [
        '# Test Plan',
        '## Complexity Audit',
        '### Routine',
        '* Bullet with asterisk',
        '+ Bullet with plus',
        '### Complex / Risky',
        '- None'
    ].join('\n');

    const diffEmptyMarkersPlan1 = [
        '# Test Plan',
        '## Complexity Audit',
        '### Routine',
        '- Done',
        '### Complex / Risky',
        'n/a'
    ].join('\n');

    const diffEmptyMarkersPlan2 = [
        '# Test Plan',
        '## Complexity Audit',
        '### Routine',
        '- Done',
        '### Complex / Risky',
        '- None.'
    ].join('\n');

    const complexRiskySubstantivePlan = [
        '# Test Plan',
        '## Complexity Audit',
        '### Routine',
        '- Done',
        '### Complex / Risky',
        '- Rework database migration sequence'
    ].join('\n');

    test('register-tools treats parenthesized Complex/Band B label with None as low complexity score', () => {
        assert.strictEqual(getComplexityFromContent(lowPlan), '3');
    });

    test('register-tools keeps substantive Complex items as high complexity score', () => {
        assert.strictEqual(getComplexityFromContent(highPlan), '8');
    });

    test('register-tools parses plan with no blank lines after headings correctly as 3', () => {
        assert.strictEqual(getComplexityFromContent(noBlankLinesPlan), '3');
    });

    test('register-tools parses plain text correctly as 3', () => {
        assert.strictEqual(getComplexityFromContent(plainTextPlan), '3');
    });

    test('register-tools parses mixed bullets correctly as 3', () => {
        assert.strictEqual(getComplexityFromContent(mixedBulletsPlan), '3');
    });

    test('register-tools parses empty complex marker n/a as 3', () => {
        assert.strictEqual(getComplexityFromContent(diffEmptyMarkersPlan1), '3');
    });

    test('register-tools parses empty complex marker - None. as 3', () => {
        assert.strictEqual(getComplexityFromContent(diffEmptyMarkersPlan2), '3');
    });

    test('register-tools parses Complex / Risky substantive change as 8', () => {
        assert.strictEqual(getComplexityFromContent(complexRiskySubstantivePlan), '8');
    });

    test('register-tools matches recommendation-only fallback routing scores', () => {
        assert.strictEqual(getComplexityFromContent(recommendationOnlyCoderPlan), '3');
        assert.strictEqual(getComplexityFromContent(recommendationOnlyLeadPlan), '8');
    });

    test('KanbanProvider strips parenthesized complexity labels before evaluating meaning', () => {
        assert.ok(
            kanbanProviderSource.includes("replace(/^\\((.*)\\)$/, '$1')"),
            'Expected KanbanProvider to unwrap parenthesized Band B heading labels before classification.'
        );
        assert.ok(
            kanbanProviderSource.includes('!isEmptyMarker(line) && !isBandBLabel(line) && !/^recommendation\\b/.test(line)'),
            'Expected KanbanProvider to ignore empty markers and label-only Band B lines before classifying complexity.'
        );
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
