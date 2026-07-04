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

    // --- _cardsToPromptPlans delegates to buildDispatchPlans (consolidated builder) ---
    // The repoScopeMap parameter was retained as a deprecated `_legacyRepoScopeMap`
    // (ignored); workingDir is now sourced from the DB record inside the single
    // canonical builder. Assert the delegation + that the builder resolves
    // workingDir via resolveWorkingDir.
    assert.match(
        kanbanProviderSource,
        /private async _cardsToPromptPlans\([\s\S]*?buildDispatchPlans\(/,
        'Expected _cardsToPromptPlans to delegate to buildDispatchPlans.'
    );
    assert.match(
        kanbanProviderSource,
        /public async buildDispatchPlans\([\s\S]*?resolveWorkingDir\(workspaceRoot, rec\.repoScope/,
        'Expected buildDispatchPlans to resolve workingDir via resolveWorkingDir(rec.repoScope).'
    );

    // --- The inline repoScopeMap pre-fetch callers are gone (consolidated) ---
    // Previously every caller hand-built a repoScopeMap; now the builder sources
    // repoScope from the record. _buildRepoScopeMap is deleted.
    assert.ok(
        !/_buildRepoScopeMap/.test(kanbanProviderSource),
        'Expected _buildRepoScopeMap to be deleted after consolidation.'
    );

    // --- KanbanProvider passes workspaceRoot to buildKanbanBatchPrompt ---
    assert.match(
        kanbanProviderSource,
        /buildKanbanBatchPrompt\([^)]*\{[^}]*workspaceRoot/,
        'Expected KanbanProvider to pass workspaceRoot in buildKanbanBatchPrompt options.'
    );

    // --- TaskViewerProvider delegates dispatch-plan building to KanbanProvider.buildDispatchPlans ---
    // _resolveKanbanDispatchPlans no longer resolves workingDir inline; it
    // resolves records and hands them to the consolidated builder, which
    // resolves workingDir via resolveWorkingDir(rec.repoScope) in one place.
    assert.match(
        taskViewerSource,
        /_resolveKanbanDispatchPlans[\s\S]*?buildDispatchPlans\(/,
        'Expected _resolveKanbanDispatchPlans to delegate to buildDispatchPlans.'
    );
    assert.match(
        taskViewerSource,
        /resolveWorkingDir\(resolvedWorkspaceRoot, planRecord\?\.repoScope/,
        'Expected TaskViewerProvider _handleCopyPlanLink fallback to resolve workingDir via resolveWorkingDir (planRecord.repoScope).'
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
