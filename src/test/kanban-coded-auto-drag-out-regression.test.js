'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const kanbanHtmlPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
    const source = fs.readFileSync(kanbanHtmlPath, 'utf8');

    assert.match(
        source,
        /function getSelectedInRenderedContainer\(cardEl\)\s*\{\s*const container = cardEl \? cardEl\.closest\('\.column-body'\) : null;\s*if \(!container\) return \[\];\s*return Array\.from\(container\.querySelectorAll\('\.kanban-card\.selected'\)\)\s*\.map\(el => el\.dataset\.session\)\s*\.filter\(Boolean\);\s*\}/s,
        'Expected kanban.html to gather selected cards from the dragged card\'s rendered column container.'
    );

    assert.match(
        source,
        /function handleDragStart\(e\) \{[\s\S]*const draggedCardEl =[\s\S]*const draggedId = draggedCardEl\?\.dataset\.session;[\s\S]*if \(selectedCards\.has\(draggedId\) && selectedCards\.size > 1\) \{[\s\S]*const selectedInRenderedContainer = getSelectedInRenderedContainer\(draggedCardEl\);[\s\S]*if \(selectedInRenderedContainer\.length > 1 && selectedInRenderedContainer\.includes\(draggedId\)\) \{[\s\S]*idsToTransfer = selectedInRenderedContainer;[\s\S]*\}[\s\S]*\}/s,
        'Expected handleDragStart() to package visible multi-selection from the dragged card\'s rendered container.'
    );

    assert.ok(
        !source.includes('const selectedInColumn = getSelectedInColumn(card.column);'),
        'Expected handleDragStart() to stop narrowing collapsed CODED_AUTO drags by logical card.column.'
    );

    console.log('kanban coded auto drag-out regression test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban coded auto drag-out regression test failed:', error);
    process.exit(1);
}
