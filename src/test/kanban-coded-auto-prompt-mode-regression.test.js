'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const kanbanHtmlPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
    const source = fs.readFileSync(kanbanHtmlPath, 'utf8');

    // Verify merge logic in updateColumnDragDropModes
    assert.match(
        source,
        /case 'updateColumnDragDropModes':[\s\S]*if \(msg\.modes && typeof msg\.modes === 'object'\) \{[\s\S]*for \(const \[key, value\] of Object\.entries\(msg\.modes\)\) \{[\s\S]*columnDragDropModes\[key\] = value;[\s\S]*\}/s,
        'Expected updateColumnDragDropModes to merge incoming modes instead of replacing the object.'
    );

    // Verify toggle icon update loop still works correctly
    assert.match(
        source,
        /document\.querySelectorAll\('\.mode-toggle'\)\.forEach\(toggle => \{[\s\S]*const colId = toggle\.dataset\.column;[\s\S]*const mode = columnDragDropModes\[colId\] || 'cli';/s,
        'Expected toggle-icon update loop to reference columnDragDropModes[colId].'
    );

    console.log('kanban coded auto prompt mode regression test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban coded auto prompt mode regression test failed:', error);
    process.exit(1);
}
