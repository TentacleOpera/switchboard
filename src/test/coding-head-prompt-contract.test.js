'use strict';

/**
 * Contract: Coding team head prompt invariants.
 *
 * Invariants:
 *  1. Live coding head prompt contains no targetColumn.
 *  2. Live coding head prompt contains no reviewer roster check.
 *  3. Card movement is stated as unconditional, with no named exception.
 *  4. The completion post uses the subtask's planId, not the FEATURE planId.
 *  5. The prompt states POST /kanban/queue/next as the "ask for the next card" call.
 *  6. teamWiring.ts, terminals.js, and kanban.html copies are byte-identical.
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/coding-head-prompt-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const TEAM_WIRING_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'teamWiring.ts'), 'utf8');
const TERMINALS_JS_SRC = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'terminals.js'), 'utf8');
const KANBAN_HTML_SRC = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'kanban.html'), 'utf8');

function readQuotedChain(src, i) {
    if (src[i] !== "'") { return null; }
    let value = '';
    for (;;) {
        if (src[i] !== "'") { break; }
        let j = i + 1;
        let seg = '';
        while (j < src.length && src[j] !== "'") {
            if (src[j] === '\\') { seg += src[j] + src[j + 1]; j += 2; continue; }
            seg += src[j]; j++;
        }
        value += seg;
        i = j + 1;
        while (i < src.length && /\s/.test(src[i])) { i++; }
        if (src[i] === '+') { i++; while (i < src.length && /\s/.test(src[i])) { i++; } continue; }
        break;
    }
    return value.replace(/\\n/g, '\n').replace(/\\'/g, "'");
}

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
    console.log('\ncoding-head-prompt-contract\n');

    // Extract NEW_CODING_HEAD_PROMPT from teamWiring.ts
    const twAnchor = /NEW_CODING_HEAD_PROMPT\s*=\s*/.exec(TEAM_WIRING_SRC);
    assert.ok(twAnchor, 'NEW_CODING_HEAD_PROMPT not found in teamWiring.ts');
    const twPrompt = readQuotedChain(TEAM_WIRING_SRC, twAnchor.index + twAnchor[0].length);
    assert.ok(twPrompt, 'could not extract NEW_CODING_HEAD_PROMPT from teamWiring.ts');

    // Extract NEW_CODING_HEAD_PROMPT_CLIENT from terminals.js
    const tjAnchor = /NEW_CODING_HEAD_PROMPT_CLIENT\s*=\s*/.exec(TERMINALS_JS_SRC);
    assert.ok(tjAnchor, 'NEW_CODING_HEAD_PROMPT_CLIENT not found in terminals.js');
    const tjPrompt = readQuotedChain(TERMINALS_JS_SRC, tjAnchor.index + tjAnchor[0].length);
    assert.ok(tjPrompt, 'could not extract NEW_CODING_HEAD_PROMPT_CLIENT from terminals.js');

    // Extract Coding headPrompt from kanban.html
    const khStart = KANBAN_HTML_SRC.indexOf("name: 'Coding'");
    assert.ok(khStart >= 0, 'Coding team not found in kanban.html');
    const khHpAnchor = /headPrompt:\s*/.exec(KANBAN_HTML_SRC.slice(khStart));
    assert.ok(khHpAnchor, 'Coding headPrompt not found in kanban.html');
    const khPrompt = readQuotedChain(KANBAN_HTML_SRC, khStart + khHpAnchor.index + khHpAnchor[0].length);
    assert.ok(khPrompt, 'could not extract Coding headPrompt from kanban.html');

    // ── 1. Byte-identity across all 3 source files ──────────────────────

    check('NEW_CODING_HEAD_PROMPT in teamWiring.ts and NEW_CODING_HEAD_PROMPT_CLIENT in terminals.js are byte-identical', () => {
        assert.strictEqual(twPrompt, tjPrompt, 'teamWiring.ts and terminals.js must be byte-identical');
    });

    check('NEW_CODING_HEAD_PROMPT in teamWiring.ts and Coding headPrompt in kanban.html are byte-identical', () => {
        assert.strictEqual(twPrompt, khPrompt, 'teamWiring.ts and kanban.html must be byte-identical');
    });

    // ── 2. Reviewer roster check and targetColumn removed ───────────────

    check('live coding head prompt contains no targetColumn', () => {
        assert.ok(!twPrompt.includes('targetColumn'), 'prompt must not contain targetColumn');
    });

    check('live coding head prompt contains no reviewer roster check', () => {
        assert.ok(!twPrompt.includes('with role "reviewer"'), 'prompt must not check for reviewer seat in roster');
        assert.ok(!twPrompt.includes('If your team has a reviewer seat'), 'prompt must not branch on reviewer seat existence');
        assert.ok(!twPrompt.includes('If your team has NO reviewer seat'), 'prompt must not branch on absence of reviewer seat');
    });

    // ── 3. Unconditional card movement ──────────────────────────────────

    check('card movement is stated as unconditional, with no named exception', () => {
        assert.ok(twPrompt.includes('Never move a card backwards to an earlier pipeline stage — only Mission Control may do that.'),
            'prompt must include backwards movement rule');
        assert.ok(twPrompt.includes('Never move a card to a new column yourself — that is not your role.'),
            'prompt must state no column move rule unconditionally');
        assert.ok(!twPrompt.includes('your only card action is'),
            'prompt must not state any exception to card movement rule');
        assert.ok(!twPrompt.includes('/kanban/dispatch'),
            'prompt must not instruct calling /kanban/dispatch');
    });

    // ── 4. Subtask completion post (not feature planId) ─────────────────

    check('the completion post uses the subtask planId, not the FEATURE planId', () => {
        assert.ok(twPrompt.includes('POST /kanban/task/complete with {"from":"{head}","planId":"<the subtask\'s planId>","workspaceRoot":"<your current working directory>"}'),
            'prompt must instruct POST /kanban/task/complete with subtask planId');
        assert.ok(!twPrompt.includes('<the FEATURE planId>'),
            'prompt must not reference <the FEATURE planId>');
    });

    // ── 5. queue/next instruction ───────────────────────────────────────

    check('the prompt states next as the "ask for the next card" call', () => {
        assert.ok(twPrompt.includes('run node "<cliPath>" next --from "{head}" (or switchboard next --from "{head}"); if it returns a dispatched card, work it; if it returns dispatched: null, report that the queue is empty and stop.'),
            'prompt must instruct next to ask for next card');
    });

    // ── 6. Commit instruction marker present ────────────────────────────

    check('the prompt includes the durable commit instruction marker', () => {
        assert.ok(twPrompt.includes('create a single commit with a descriptive message'),
            'prompt must contain the commit instruction marker');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
