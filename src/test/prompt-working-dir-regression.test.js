'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const kanbanProviderPath = path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts');
    const taskViewerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const promptBuilderPath = path.join(process.cwd(), 'src', 'services', 'agentPromptBuilder.ts');

    const kanbanProviderSource = fs.readFileSync(kanbanProviderPath, 'utf8');
    const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');
    const promptBuilderSource = fs.readFileSync(promptBuilderPath, 'utf8');

    // --- resolveWorkingDir helper exists and is exported ---
    assert.match(
        promptBuilderSource,
        /export function resolveWorkingDir\(workspaceRoot: string, repoScope: string\): string/,
        'Expected resolveWorkingDir to be exported from agentPromptBuilder.'
    );
    assert.match(
        promptBuilderSource,
        /fs\.existsSync\(candidate\) && fs\.statSync\(candidate\)\.isDirectory\(\)/,
        'Expected resolveWorkingDir to validate that the resolved path exists and is a directory.'
    );
    assert.match(
        promptBuilderSource,
        /return workspaceRoot;/,
        'Expected resolveWorkingDir to fall back to workspaceRoot on invalid paths.'
    );

    // --- detectWorkspaceType helper exists and is exported ---
    assert.match(
        promptBuilderSource,
        /export function detectWorkspaceType\(workspaceRoot: string\)/,
        'Expected detectWorkspaceType to be exported from agentPromptBuilder.'
    );

    // --- _cardsToPromptPlans uses repoScopeMap + resolveWorkingDir ---
    assert.match(
        kanbanProviderSource,
        /private _cardsToPromptPlans\([\s\S]*repoScopeMap\?/,
        'Expected _cardsToPromptPlans to accept repoScopeMap parameter.'
    );
    assert.match(
        kanbanProviderSource,
        /resolveWorkingDir\(workspaceRoot, repoScope\)/,
        'Expected _cardsToPromptPlans to resolve workingDir via resolveWorkingDir.'
    );

    // --- KanbanProvider callers pre-fetch repoScopeMap ---
    const repoScopeMapPattern = /const repoScopeMap = new Map<string, string>\(\);[\s\S]*?repoScopeMap\.set\(card\.sessionId, plan\.repoScope\)/g;
    const callerMatches = kanbanProviderSource.match(repoScopeMapPattern);
    assert.ok(
        callerMatches && callerMatches.length >= 5,
        `Expected at least 5 callers to pre-fetch repoScopeMap, found ${callerMatches ? callerMatches.length : 0}.`
    );

    // --- KanbanProvider passes workspaceRoot to buildKanbanBatchPrompt ---
    assert.match(
        kanbanProviderSource,
        /buildKanbanBatchPrompt\([^)]*\{[^}]*workspaceRoot/,
        'Expected KanbanProvider to pass workspaceRoot in buildKanbanBatchPrompt options.'
    );

    // --- TaskViewerProvider uses resolveWorkingDir ---
    assert.match(
        taskViewerSource,
        /resolveWorkingDir\(workspaceRoot, plan\.repoScope/,
        'Expected TaskViewerProvider to resolve workingDir via resolveWorkingDir (plan.repoScope).'
    );
    assert.match(
        taskViewerSource,
        /resolveWorkingDir\(resolvedWorkspaceRoot, planRecord\?\.repoScope/,
        'Expected TaskViewerProvider to resolve workingDir via resolveWorkingDir (planRecord.repoScope).'
    );

    // --- TaskViewerProvider passes workspaceRoot to buildKanbanBatchPrompt ---
    assert.match(
        taskViewerSource,
        /buildKanbanBatchPrompt\([^)]*\{[^}]*workspaceRoot/,
        'Expected TaskViewerProvider to pass workspaceRoot in buildKanbanBatchPrompt options.'
    );

    // --- planner prompt includes WORKSPACE TYPE block ---
    assert.match(
        promptBuilderSource,
        /WORKSPACE TYPE: This workspace is multi-repo/,
        'Expected planner prompt to include multi-repo WORKSPACE TYPE block.'
    );
    assert.match(
        promptBuilderSource,
        /WORKSPACE TYPE: This workspace is single-repo/,
        'Expected planner prompt to include single-repo WORKSPACE TYPE block.'
    );

    console.log('prompt working-dir regression test passed');
}

try {
    run();
} catch (error) {
    console.error('prompt working-dir regression test failed:', error);
    process.exit(1);
}
