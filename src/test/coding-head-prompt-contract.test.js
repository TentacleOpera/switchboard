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
 *  6. teamWiring.ts and agent-control.js copies are byte-identical. The terminals.js
 *     client mirror (NEW_CODING_HEAD_PROMPT_CLIENT) was retired when system
 *     protocol composition moved to delivery-time fragment composition. The
 *     shipped gallery copy lives in agent-control.js's SHIPPED_TEAM_TYPES since
 *     the tabs left kanban.html.
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
const AGENT_CONTROL_JS_SRC = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'agent-control.js'), 'utf8');

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

    // The client mirror (NEW_CODING_HEAD_PROMPT_CLIENT) is retired.
    assert.ok(
        !/NEW_CODING_HEAD_PROMPT_CLIENT/.test(TERMINALS_JS_SRC),
        'terminals.js must NOT declare NEW_CODING_HEAD_PROMPT_CLIENT — the client mirror is retired'
    );

    // Extract Coding headPrompt from agent-control.js (SHIPPED_TEAM_TYPES)
    const khStart = AGENT_CONTROL_JS_SRC.indexOf("name: 'Coding'");
    assert.ok(khStart >= 0, 'Coding team not found in agent-control.js');
    const khHpAnchor = /headPrompt:\s*/.exec(AGENT_CONTROL_JS_SRC.slice(khStart));
    assert.ok(khHpAnchor, 'Coding headPrompt not found in agent-control.js');
    const khPrompt = readQuotedChain(AGENT_CONTROL_JS_SRC, khStart + khHpAnchor.index + khHpAnchor[0].length);
    assert.ok(khPrompt, 'could not extract Coding headPrompt from agent-control.js');

    // ── 1. Byte-identity across the 2 surviving source files ──────────

    check('NEW_CODING_HEAD_PROMPT in teamWiring.ts and Coding headPrompt in agent-control.js are byte-identical', () => {
        assert.strictEqual(twPrompt, khPrompt, 'teamWiring.ts and agent-control.js must be byte-identical');
    });

    check('NEW_CODING_HEAD_PROMPT_CLIENT is absent from terminals.js (client mirror retired)', () => {
        assert.ok(
            !/NEW_CODING_HEAD_PROMPT_CLIENT/.test(TERMINALS_JS_SRC),
            'terminals.js must NOT declare NEW_CODING_HEAD_PROMPT_CLIENT — system protocol is composed at delivery'
        );
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
        assert.ok(twPrompt.includes('run node "<cliPath>" accept --plan "<the subtask\'s planId>"'),
            'prompt must instruct accept --plan with the subtask planId (the CLI resolves from)');
        assert.ok(!twPrompt.includes('<the FEATURE planId>'),
            'prompt must not reference <the FEATURE planId>');
    });

    // ── 5. queue/next instruction ───────────────────────────────────────

    check('the prompt states next as the "ask for the next card" call', () => {
        assert.ok(twPrompt.includes('run node "<cliPath>" next (or switchboard next); if it returns a dispatched card, work it; if it returns dispatched: null, report that the queue is empty and stop.'),
            'prompt must instruct next to ask for next card');
        assert.ok(!/--from/.test(twPrompt),
            'no prompt may pass --from: done, accept and next all read SWITCHBOARD_TERMINAL, which the host injects into every seat');
    });

    // ── 6. Commit instruction marker present ────────────────────────────

    check('the prompt includes the durable commit instruction marker', () => {
        assert.ok(twPrompt.includes('create a single commit with a descriptive message'),
            'prompt must contain the commit instruction marker');
    });

    // ── 7. Wake guarantee and sleep prohibition ─────────────────────────

    check('the prompt contains the wake guarantee and sleep prohibition', () => {
        assert.ok(twPrompt.includes('delivers a completion prompt into this terminal'),
            'prompt must state that a completion prompt is delivered to this terminal');
        assert.ok(twPrompt.includes('Do not sleep, poll, loop, or run any timer to find out whether a coder is done'),
            'prompt must forbid sleeping, polling, looping, or running timers');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
