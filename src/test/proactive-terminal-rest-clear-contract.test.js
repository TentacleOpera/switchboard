'use strict';

/**
 * Contract: proactive /clear at rest — retargeted to the enriched drive prefix.
 *
 * The skill file (.agents/protocols/terminal-coder-dispatch/SKILL.md) was deleted;
 * its rules were inlined into _buildDrivePrefix in KanbanProvider.ts. The
 * "clear at rest" rule and the clearBeforePrompt: false mandate (in the curl
 * template) are now pinned against the prefix source text.
 *
 * Verb existence on both hosts is covered by pty-route-surface-contract.test.js
 * against a live server — deliberately not duplicated here.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const KANBAN_PROVIDER = read('src/services/KanbanProvider.ts');
const ORCH = '.agents/protocols/switchboard-mission-control-http/SKILL.md';

// Extract the _buildDrivePrefix method body from the source text.
const drivePrefixStart = KANBAN_PROVIDER.indexOf('_buildDrivePrefix');
assert.ok(drivePrefixStart > 0, '_buildDrivePrefix method must exist in KanbanProvider.ts');
const drivePrefixEnd = KANBAN_PROVIDER.indexOf('return block.join', drivePrefixStart);
assert.ok(drivePrefixEnd > 0, '_buildDrivePrefix must have a return block.join statement');
const DRIVE_PREFIX_SRC = KANBAN_PROVIDER.slice(drivePrefixStart, drivePrefixEnd);

let failures = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failures++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

test('the drive prefix teaches clear-at-rest', () => {
    assert.ok(/Clear a terminal only when at rest/.test(DRIVE_PREFIX_SRC), 'the drive prefix must teach clear-at-rest');
    assert.ok(/at rest|resting|stand it down|put it down/i.test(DRIVE_PREFIX_SRC), 'the rest step is undocumented in the drive prefix');
});

test('the rest instruction carries its precondition', () => {
    assert.ok(/completion received AND next work goes elsewhere/.test(DRIVE_PREFIX_SRC), 'the clear-at-rest precondition is missing from the drive prefix');
});

test('proactive clearing did NOT trade away clearBeforePrompt: false', () => {
    assert.ok(
        /"clearBeforePrompt":false/.test(DRIVE_PREFIX_SRC),
        'the drive prefix curl template must use clearBeforePrompt: false'
    );
    assert.ok(
        !/"clearBeforePrompt"\s*:\s*true/.test(DRIVE_PREFIX_SRC),
        'the drive prefix must not show a dispatch with clearBeforePrompt: true — that is the race this contract removes'
    );
});

test('the Mission Control HTTP surface documents the clear verb', () => {
    const orch = read(ORCH);
    assert.ok(/ptyClearTerminal/.test(orch), 'switchboard-mission-control-http §4b omits ptyClearTerminal');
});

test('neither contract re-states a retired standing-order cap', () => {
    // MAX_ORDERS / MAX_INSTRUCTION_CHARS / MAX_BLOCK_CHARS were removed from the runtime;
    // standing-orders-marker-contract.test.js pins their absence in source. The skills
    // documented them for months after they were gone.
    for (const rel of [ORCH]) {
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
    for (const rel of [ORCH]) {
        const text = read(rel);
        assert.ok(
            !/[Oo]mit(ting)? (the field|it)[^.]{0,80}(wipes|sends `\/clear`)/.test(text),
            `${rel} still claims an omitted clearBeforePrompt clears the terminal — both hosts default it to false`
        );
    }
});

if (failures > 0) { console.error(`\n${failures} contract failure(s)`); process.exit(1); }
console.log('\nAll proactive-clear contract assertions passed.');
