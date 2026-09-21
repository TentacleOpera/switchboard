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
        /if \(normalizedColumn === 'CODE REVIEWED'\) \{ return null; \}[\s\S]*const shouldSkip = \(col: typeof allColumns\[0\]\): boolean => \{[\s\S]*if \(!this\._isParallelCodedLane\(normalizedColumn\)\) \{[\s\S]*if \(!this\._isParallelCodedLane\(candidate\.id\)\)/s,
        'Expected _getNextColumnId() to treat CODE REVIEWED as terminal and to honor ordered custom lanes while skipping role-less/parallel-coded candidates.'
    );
    assert.match(
        kanbanProviderSource,
        /if \(!col\.role && col\.kind !== 'completed'\) \{\s*return true;/,
        'Expected _getNextColumnId() to skip role-less non-completed columns while keeping COMPLETED reachable.'
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
