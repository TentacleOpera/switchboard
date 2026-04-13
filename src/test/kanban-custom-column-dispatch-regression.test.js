'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const kanbanProviderPath = path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts');
const taskViewerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');

const kanbanProviderSource = fs.readFileSync(kanbanProviderPath, 'utf8');
const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');

function run() {
    assert.match(
        taskViewerSource,
        /type ConfiguredKanbanDispatchOptions = \{[\s\S]*targetColumn: string;[\s\S]*dragDropMode: 'cli' \| 'prompt';[\s\S]*\}[\s\S]*public async dispatchConfiguredKanbanColumnAction\(/,
        'Expected TaskViewerProvider.ts to expose the explicit configured-column dispatch helper.'
    );
    assert.match(
        taskViewerSource,
        /explicitTargetColumn \|\| this\._targetColumnForRole\(role\)/,
        'Expected configured dispatches to keep an explicit target column instead of always snapping to the role default lane.'
    );
    assert.match(
        taskViewerSource,
        /this\._appendAdditionalInstructions\(messagePayload,\s*options\.additionalInstructions\)/,
        'Expected configured dispatches to append the saved triggerPrompt as additional instructions.'
    );
    assert.match(
        taskViewerSource,
        /private async _updateKanbanColumnForSession\(workspaceRoot: string, sessionId: string, column: string \| null\): Promise<void> \{[\s\S]*await db\.updateColumn\(sessionId, column\);[\s\S]*await writePlanStateToFile\([\s\S]*column === 'COMPLETED' \? 'completed' : 'active'[\s\S]*\);/s,
        'Expected explicit target-column dispatches to persist the plan-file Switchboard State after updating the DB column.'
    );

    assert.match(
        kanbanProviderSource,
        /private async _resolveKanbanDispatchSpec\([\s\S]*source:\s*column\.source[\s\S]*triggerPrompt:\s*column\.triggerPrompt/,
        'Expected KanbanProvider.ts to resolve a full dispatch spec from the target column.'
    );
    assert.match(
        kanbanProviderSource,
        /case 'promptOnDrop':[\s\S]*dispatchSpec\?\.source === 'custom-user'[\s\S]*dispatchConfiguredKanbanColumnAction\(/,
        'Expected promptOnDrop to use the target custom column configuration instead of the source stage prompt.'
    );
    assert.match(
        kanbanProviderSource,
        /const acceptanceTesterActive = await this\._isAcceptanceTesterActive\(workspaceRoot\);[\s\S]*if \(!this\._isParallelCodedLane\(normalizedColumn\)\) \{[\s\S]*candidate\.id === 'ACCEPTANCE TESTED' && !acceptanceTesterActive[\s\S]*if \(normalizedColumn === 'CODE REVIEWED' && candidate\.id === 'COMPLETED' && !acceptanceTesterActive\) \{[\s\S]*return null;[\s\S]*\}[\s\S]*if \(!this\._isParallelCodedLane\(candidate\.id\)\)/s,
        'Expected _getNextColumnId() to skip only the built-in tester/coded special cases while still honoring ordered custom lanes.'
    );
    assert.match(
        kanbanProviderSource,
        /dispatchSpec\?\.source === 'custom-user'[\s\S]*dispatchConfiguredKanbanColumnAction\(/,
        'Expected KanbanProvider.ts to route user-authored lanes through the explicit configured-column dispatch helper.'
    );

    console.log('kanban custom column dispatch regression test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban custom column dispatch regression test failed:', error);
    process.exit(1);
}
