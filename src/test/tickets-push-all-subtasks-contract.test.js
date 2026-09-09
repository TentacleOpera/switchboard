'use strict';

/**
 * Contract: Relabel and enable 'Push all subtasks' button from subtask views.
 *
 * Source-level assertions per the plan:
 *  1. Button label is "Push all subtasks" (not "Push + subtasks").
 *  2. _toggleSubtaskMetaButtons enables the button when a subtask is selected
 *     and its parent has local subtasks (no longer disabled on parentId).
 *  3. pushTicketEditsWithSubtasks resolves a subtask id to its parent.
 *  4. All status strings say "Push all subtasks" (not "Push + subtasks").
 *
 * Run with:
 *   node src/test/tickets-push-all-subtasks-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

function run() {
    console.log('\ntickets-push-all-subtasks-contract\n');

    // ── 1. Button label ──────────────────────────────────────────────────

    const ticketsHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'tickets.html'), 'utf8');
    check('button label is "Push all subtasks"', () => {
        assert.ok(ticketsHtml.includes('>Push all subtasks</button>'), 'button must say "Push all subtasks"');
        assert.ok(!/>Push \+ subtasks</.test(ticketsHtml), 'old label "Push + subtasks" must be gone');
    });

    // ── 2. _toggleSubtaskMetaButtons no longer disables on parentId ──────

    const ticketsJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'tickets.js'), 'utf8');
    check('_toggleSubtaskMetaButtons enables button on subtask selection', () => {
        assert.ok(!/btnPushSubtasks\.disabled\s*=\s*!!\(parentId\)/.test(ticketsJs),
            'must not disable on parentId alone');
        assert.ok(/btnPushSubtasks\.disabled\s*=\s*count\s*===\s*0/.test(ticketsJs),
            'must disable on count === 0, not on parentId');
    });

    check('subtask selection resolves count from parent card', () => {
        assert.ok(/list\.find\(t\s*=>\s*t\.id\s*===\s*parentId\)/.test(ticketsJs),
            'must look up parent ticket by parentId');
    });

    // ── 3. Backend resolves subtask to parent ────────────────────────────

    const providerSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
    check('pushTicketEditsWithSubtasks resolves subtask id to parent', () => {
        assert.ok(/effectiveParentId/.test(providerSrc), 'must have effectiveParentId variable');
        assert.ok(providerSrc.includes('parentId:\\s*(.+)$/m'), 'must use the same parentId regex as _localSubtaskIdsFor');
        assert.ok(/Array\.from\(new Set\(\[effectiveParentId/.test(providerSrc),
            'must push parent + children, deduplicated');
    });

    // ── 4. Status strings relabelled ────────────────────────────────────

    check('all "Push + subtasks" status strings relabelled to "Push all subtasks"', () => {
        // tickets.js fallback strings
        assert.ok(!/Push \+ subtasks:/.test(ticketsJs), 'tickets.js must not have old "Push + subtasks:" strings');
        assert.ok(/Push all subtasks:/.test(ticketsJs), 'tickets.js must have "Push all subtasks:" strings');
        // TaskViewerProvider.ts backend message
        assert.ok(!/Push \+ subtasks:/.test(providerSrc), 'TaskViewerProvider.ts must not have old "Push + subtasks:" message');
        assert.ok(/Push all subtasks:/.test(providerSrc), 'TaskViewerProvider.ts must have "Push all subtasks:" message');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
