'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const extensionPath = path.join(process.cwd(), 'src', 'extension.ts');
const extensionSource = fs.readFileSync(extensionPath, 'utf8');

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

function extractWindowStateHandler(tsSource) {
    const marker = 'vscode.window.onDidChangeWindowState((state) => {';
    const start = tsSource.indexOf(marker);
    if (start < 0) {
        throw new Error('Window state handler not found');
    }

    const bodyStart = tsSource.indexOf('{', start);
    if (bodyStart < 0) {
        throw new Error('Window state handler body start not found');
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

    throw new Error('Window state handler closing brace not found');
}

function run() {
    console.log('\nRunning terminal disconnect on minimize regression tests\n');

    const windowStateHandlerSource = extractWindowStateHandler(extensionSource);

    test('focused restore handler refreshes MCP, rescans inboxes, re-syncs terminals, and refreshes the sidebar', () => {
        assert.match(
            windowStateHandlerSource,
            /if \(state\.focused\) \{[\s\S]*refreshMcpStatus\(\)\.catch\(\(\) => \{ \}\);[\s\S]*inboxWatcher\?\.triggerScan\(\);[\s\S]*if \(workspaceRoot\) \{[\s\S]*syncTerminalRegistryWithState\(workspaceRoot\)[\s\S]*taskViewerProvider\.refresh\(\);[\s\S]*\}[\s\S]*else \{[\s\S]*taskViewerProvider\.refresh\(\);[\s\S]*\}[\s\S]*\}/,
            'Expected restore-time focus handler to keep MCP refresh and inbox scan while reclaiming terminals and refreshing the sidebar UI.'
        );
    });

    test('terminal reclaim still propagates the rebuilt registry into InboxWatcher', () => {
        assert.match(
            extensionSource,
            /registeredTerminals\.clear\(\);[\s\S]*for \(const \[k, v\] of newRegistry\) \{[\s\S]*registeredTerminals\.set\(k, v\);[\s\S]*\}[\s\S]*if \(inboxWatcher\) \{[\s\S]*inboxWatcher\.updateRegisteredTerminals\(registeredTerminals\);[\s\S]*\}/,
            'Expected syncTerminalRegistryWithState to keep updating InboxWatcher after the registry swap.'
        );
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
