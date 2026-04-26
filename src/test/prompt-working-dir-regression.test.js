'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const kanbanProviderPath = path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts');
    const taskViewerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');

    const kanbanProviderSource = fs.readFileSync(kanbanProviderPath, 'utf8');
    const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');

    assert.match(
        kanbanProviderSource,
        /export interface KanbanCard \{[\s\S]*repoScope: string;/,
        'Expected KanbanCard to carry repoScope.'
    );
    assert.match(
        kanbanProviderSource,
        /private _buildKanbanCard\([\s\S]*repoScope: row\.repoScope \|\| ''/,
        'Expected _buildKanbanCard to copy repoScope from DB rows.'
    );
    assert.match(
        kanbanProviderSource,
        /private _buildCardsFromRows\([\s\S]*\.map\(\(row\) => this\._buildKanbanCard\(row, workspaceRoot\)\)[\s\S]*\.map\(\(row\) => this\._buildKanbanCard\(row, workspaceRoot, 'COMPLETED'\)\)/,
        'Expected both active and completed row paths to reuse _buildKanbanCard.'
    );
    assert.match(
        kanbanProviderSource,
        /private _cardsToPromptPlans\(cards: KanbanCard\[\], workspaceRoot: string\): BatchPromptPlan\[\] \{[\s\S]*workingDir: card\.repoScope \? path\.join\(workspaceRoot, card\.repoScope\) : ''[\s\S]*\}/,
        'Expected _cardsToPromptPlans to resolve workingDir from repoScope.'
    );

    assert.match(
        taskViewerSource,
        /workingDir = plan\.repoScope \? path\.join\(workspaceRoot, plan\.repoScope\) : '';/,
        'Expected _resolveKanbanDispatchPlans to resolve workingDir from repoScope.'
    );
    assert.match(
        taskViewerSource,
        /const plan: BatchPromptPlan = \{ topic, absolutePath: planFileAbsolute, workingDir \};/,
        'Expected clipboard prompt generation to include workingDir.'
    );
    assert.match(
        taskViewerSource,
        /const teamPlan: BatchPromptPlan = \{ topic: sessionTopic, absolutePath: planFileAbsolute, workingDir \};/,
        'Expected team dispatch to include workingDir.'
    );
    assert.match(
        taskViewerSource,
        /const dispatchPlan: BatchPromptPlan = \{ topic: sessionTopic, absolutePath: planFileAbsolute, workingDir \};/,
        'Expected direct dispatch to include workingDir.'
    );

    console.log('prompt working-dir regression test passed');
}

try {
    run();
} catch (error) {
    console.error('prompt working-dir regression test failed:', error);
    process.exit(1);
}
