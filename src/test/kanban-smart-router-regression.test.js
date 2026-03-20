/**
 * Regression tests for conversational kanban smart-router wiring.
 * Run with: node src/test/kanban-smart-router-regression.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const registerToolsPath = path.join(__dirname, '..', 'mcp-server', 'register-tools.js');
const extensionPath = path.join(__dirname, '..', 'extension.ts');
const kanbanProviderPath = path.join(__dirname, '..', 'services', 'KanbanProvider.ts');
const agentsDocPath = path.join(process.cwd(), 'AGENTS.md');

const registerToolsSource = fs.readFileSync(registerToolsPath, 'utf8');
const extensionSource = fs.readFileSync(extensionPath, 'utf8');
const kanbanProviderSource = fs.readFileSync(kanbanProviderPath, 'utf8');
const agentsDocSource = fs.readFileSync(agentsDocPath, 'utf8');

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

function expectRegex(source, regex, message) {
    assert.match(source, regex, message);
}

function run() {
    console.log('\nRunning kanban smart-router regression tests\n');

    test('register-tools exposes move_kanban_card and emits IPC triggerKanbanMove', () => {
        expectRegex(
            registerToolsSource,
            /server\.tool\(\s*"move_kanban_card"[\s\S]*process\.send\(\{\s*type:\s*'triggerKanbanMove'[\s\S]*sessionId:\s*trimmedSessionId[\s\S]*target:\s*trimmedTarget[\s\S]*workspaceRoot:\s*getWorkspaceRoot\(\)/s,
            'Expected move_kanban_card tool to emit the triggerKanbanMove IPC event with sessionId, target, and workspaceRoot.'
        );
        expectRegex(
            registerToolsSource,
            /queued for routing to/,
            'Expected move_kanban_card tool response to describe queueing rather than claim synchronous success.'
        );
    });

    test('extension bridges triggerKanbanMove and registers switchboard.mcpMoveKanbanCard', () => {
        expectRegex(
            extensionSource,
            /case\s+'triggerKanbanMove':\s*\{[\s\S]*Ignored malformed triggerKanbanMove payload[\s\S]*executeCommand\(\s*'switchboard\.mcpMoveKanbanCard'/s,
            'Expected extension IPC bridge to route triggerKanbanMove into the VS Code command layer.'
        );
        expectRegex(
            extensionSource,
            /registerCommand\('switchboard\.mcpMoveKanbanCard',\s*async\s*\(sessionId:\s*string,\s*target:\s*string,\s*workspaceRoot\?:\s*string\)\s*=>\s*\{[\s\S]*kanbanProvider\.handleMcpMove\(sessionId,\s*target,\s*workspaceRoot\)/s,
            'Expected extension activation to register switchboard.mcpMoveKanbanCard and delegate to KanbanProvider.handleMcpMove.'
        );
    });

    test('KanbanProvider smart router normalizes against board columns and complexity-routes generic coded/team targets', () => {
        expectRegex(
            kanbanProviderSource,
            /private\s+_normalizeMcpTarget\([\s\S]*replace\(\/\^to\\s\+\/,[\s\S]*column\|lane\|stage\|queue\|agent\|role\|terminal/s,
            'Expected conversational target normalization to strip leading "to" and trailing agent/column/role suffixes.'
        );
        expectRegex(
            kanbanProviderSource,
            /private\s+_buildMcpTargetAliases\([\s\S]*'team',\s*'team',\s*true[\s\S]*'coded',\s*'lead',\s*true[\s\S]*buildKanbanColumns\(customAgents\)/s,
            'Expected KanbanProvider to build conversational aliases from live kanban columns and generic coded/team targets.'
        );
        expectRegex(
            kanbanProviderSource,
            /private\s+async\s+_resolveComplexityRoutedRole\([\s\S]*return\s+complexity\s*===\s*'Low'\s*\?\s*'coder'\s*:\s*'lead';/s,
            'Expected generic coded/team targets to resolve via plan complexity.'
        );
        expectRegex(
            kanbanProviderSource,
            /public\s+async\s+handleMcpMove\([\s\S]*Unsupported kanban target[\s\S]*const\s+instruction\s*=\s*resolvedTarget\.role\s*===\s*'planner'\s*\?\s*'improve-plan'\s*:\s*undefined;[\s\S]*triggerAgentFromKanban/s,
            'Expected handleMcpMove to reject unsupported targets and dispatch valid routes through triggerAgentFromKanban.'
        );
    });

    test('AGENTS.md documents move_kanban_card as the preferred conversational kanban route', () => {
        expectRegex(
            agentsDocSource,
            /prefer\s+`move_kanban_card\(sessionId,\s*target\)`\s+over\s+raw\s+`send_message`/i,
            'Expected AGENTS.md to document move_kanban_card as the preferred conversational kanban routing tool.'
        );
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
