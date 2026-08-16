'use strict';

/**
 * Contract: proactive /clear at rest.
 *
 * A lead clears a coder terminal when it stands that terminal down. That is the ONLY
 * clear those coders ever get: the same skill mandates `clearBeforePrompt: false` on
 * every send, so the dispatch path never resets them. Every failure mode here is
 * silent — a rest instruction that loses its "only when at rest" precondition has a
 * lead wipe a working coder; a lead that clears itself destroys an unrecoverable
 * driving context; and trading `clearBeforePrompt: false` away for inline clearing
 * breaks every resend while paying the settle window back.
 *
 * Verb existence on both hosts is covered by pty-route-surface-contract.test.js
 * against a live server — deliberately not duplicated here.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const SKILL = '.agents/skills/terminal-coder-dispatch/SKILL.md';
const ORCH = '.agents/skills/switchboard-orchestration/SKILL.md';

let failures = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failures++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

test('the head-agent contract teaches ptyClearTerminal', () => {
    const skill = read(SKILL);
    assert.ok(/ptyClearTerminal/.test(skill), 'terminal-coder-dispatch never names ptyClearTerminal');
    assert.ok(/at rest|resting|stand it down|put it down/i.test(skill), 'the rest step is undocumented');
});

test('the rest instruction carries its precondition and both prohibitions', () => {
    const skill = read(SKILL);
    assert.ok(/[Nn]ever clear yourself/.test(skill), 'the self-clear prohibition is missing');
    assert.ok(/ptyClearAllTerminals/.test(skill), 'the clear-all prohibition is missing');
    assert.ok(/no busy check/i.test(skill), 'the "writes unconditionally, no busy check" precondition is missing');
});

test('proactive clearing did NOT trade away clearBeforePrompt: false', () => {
    const skill = read(SKILL);
    assert.ok(/`clearBeforePrompt: false` is mandatory/.test(skill), 'the clearBeforePrompt: false mandate was removed');
    assert.ok(
        !/"clearBeforePrompt"\s*:\s*true/.test(skill),
        'the skill now shows a dispatch with clearBeforePrompt: true — that is the race this contract removes'
    );
});

test('the orchestration HTTP surface documents the clear verb', () => {
    const orch = read(ORCH);
    assert.ok(/ptyClearTerminal/.test(orch), 'switchboard-orchestration §4b omits ptyClearTerminal');
});

test('neither contract re-states a retired standing-order cap', () => {
    // MAX_ORDERS / MAX_INSTRUCTION_CHARS / MAX_BLOCK_CHARS were removed from the runtime;
    // standing-orders-marker-contract.test.js pins their absence in source. The skills
    // documented them for months after they were gone.
    for (const rel of [SKILL, ORCH]) {
        for (const cap of ['MAX_ORDERS', 'MAX_INSTRUCTION_CHARS', 'MAX_BLOCK_CHARS']) {
            assert.ok(
                !new RegExp(`\\b${cap}\\b`).test(read(rel)),
                `${rel} documents ${cap}, which no longer exists`
            );
        }
    }
});

test('neither contract claims an omitted clearBeforePrompt defaults to true', () => {
    // Both hosts treat an absent field as FALSE and inject the config default only on
    // an explicit clearBeforePromptFromConfig opt-in. The rule (pass false) stands; the
    // old justification did not.
    for (const rel of [SKILL, ORCH]) {
        const text = read(rel);
        assert.ok(
            !/[Oo]mit(ting)? (the field|it)[^.]{0,80}(wipes|sends `\/clear`)/.test(text),
            `${rel} still claims an omitted clearBeforePrompt clears the terminal — both hosts default it to false`
        );
    }
});

if (failures > 0) { console.error(`\n${failures} contract failure(s)`); process.exit(1); }
console.log('\nAll proactive-clear contract assertions passed.');
