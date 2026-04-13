/**
 * Regression tests for built-in role dispatch coverage.
 * Run with: node src/test/builtin-role-dispatch-coverage.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const kanbanProviderPath = path.join(__dirname, '..', 'services', 'KanbanProvider.ts');
const taskViewerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const agentConfigPath = path.join(__dirname, '..', 'services', 'agentConfig.ts');

const kanbanProviderSource = fs.readFileSync(kanbanProviderPath, 'utf8');
const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');
const agentConfigSource = fs.readFileSync(agentConfigPath, 'utf8');

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

function extractMethodBody(tsSource, methodName) {
    const marker = `private async ${methodName}(`;
    const start = tsSource.indexOf(marker);
    if (start < 0) {
        throw new Error(`Method '${methodName}' not found`);
    }

    const bodyStart = tsSource.indexOf('{', start);
    if (bodyStart < 0) {
        throw new Error(`Method '${methodName}' body not found`);
    }

    let depth = 0;
    for (let i = bodyStart; i < tsSource.length; i++) {
        const ch = tsSource[i];
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (depth === 0) {
            return tsSource.slice(bodyStart, i + 1);
        }
    }

    throw new Error(`Method '${methodName}' closing brace not found`);
}

function extractDefaultKanbanRoles(tsSource) {
    const start = tsSource.indexOf('const DEFAULT_KANBAN_COLUMNS');
    if (start < 0) {
        throw new Error('DEFAULT_KANBAN_COLUMNS not found');
    }

    const end = tsSource.indexOf('];', start);
    if (end < 0) {
        throw new Error('DEFAULT_KANBAN_COLUMNS closing bracket not found');
    }

    const block = tsSource.slice(start, end + 2);
    const matches = [...block.matchAll(/role:\s*'([^']+)'/g)].map(match => match[1]);
    return [...new Set(matches)];
}

function run() {
    console.log('\nRunning built-in role dispatch coverage regression tests\n');

    const builtInRoles = extractDefaultKanbanRoles(agentConfigSource);
    const getAgentNamesSource = extractMethodBody(kanbanProviderSource, '_getAgentNames');
    const dispatchMethodSource = extractMethodBody(taskViewerSource, '_handleTriggerAgentActionInternal');

    test('DEFAULT_KANBAN_COLUMNS includes expected built-in roles', () => {
        for (const role of ['planner', 'lead', 'coder', 'intern', 'reviewer', 'tester', 'team-lead']) {
            assert.ok(builtInRoles.includes(role), `Expected DEFAULT_KANBAN_COLUMNS to include '${role}'`);
        }
    });

    test('_getAgentNames derives built-in roles from buildKanbanColumns([])', () => {
        assert.match(
            getAgentNamesSource,
            /buildKanbanColumns\(\[\]\)/,
            'Expected _getAgentNames to derive roles from buildKanbanColumns([])'
        );
    });

    test('_getAgentNames does not use stale hardcoded fallback role list', () => {
        assert.doesNotMatch(
            getAgentNamesSource,
            /\[\s*'lead'\s*,\s*'coder'\s*,\s*'reviewer'\s*,\s*'planner'\s*,\s*'analyst'\s*\]/,
            'Expected _getAgentNames to avoid the stale hardcoded fallback list'
        );
    });

    test('_handleTriggerAgentActionInternal covers every built-in role branch', () => {
        for (const role of builtInRoles) {
            assert.match(
                dispatchMethodSource,
                new RegExp(`role === '${role}'`),
                `Expected dispatch branch for role '${role}'`
            );
        }
    });

    test('_handleTriggerAgentActionInternal includes intern dispatch prompt', () => {
        assert.match(
            dispatchMethodSource,
            /else if \(role === 'intern'\)[\s\S]{0,300}buildKanbanBatchPrompt\('intern'/,
            'Expected intern branch to dispatch via buildKanbanBatchPrompt'
        );
    });

    test('_handleTriggerAgentActionInternal includes team-lead dispatch prompt', () => {
        assert.match(
            dispatchMethodSource,
            /else if \(role === 'team-lead'\)[\s\S]{0,300}buildKanbanBatchPrompt\('team-lead'/,
            'Expected team-lead branch to dispatch via buildKanbanBatchPrompt'
        );
    });

    test('_handleTriggerAgentActionInternal includes tester dispatch prompt', () => {
        assert.match(
            dispatchMethodSource,
            /else if \(role === 'tester'\)[\s\S]{0,500}buildKanbanBatchPrompt\('tester'/,
            'Expected tester branch to dispatch via buildKanbanBatchPrompt'
        );
    });

    test('_workflowNameForDispatchRole includes intern and team-lead', () => {
        assert.match(
            taskViewerSource,
            /'team-lead'\s*:\s*'handoff-lead'/,
            "Expected workflowMap to include 'team-lead': 'handoff-lead'"
        );
        assert.match(
            taskViewerSource,
            /'intern'\s*:\s*'handoff'/,
            "Expected workflowMap to include 'intern': 'handoff'"
        );
        assert.match(
            taskViewerSource,
            /'tester'\s*:\s*'tester-pass'/,
            "Expected workflowMap to include 'tester': 'tester-pass'"
        );
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
