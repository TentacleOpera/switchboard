'use strict';
/**
 * Contract test: the remote command vocabulary is closed at two verbs.
 *
 * The remote surface may AUTHOR CONTENT and MOVE A CARD. Nothing else. A third
 * verb — a free-text instruction channel — collapses authoring and triggering
 * into a single write and removes the invariant the whole design rests on: what
 * gets executed was reviewed. Widening the vocabulary must fail here, in CI,
 * rather than pass review as a small helpful feature.
 *
 * Asserts:
 *   1. ALLOWED_REMOTE_VERBS is exactly ['author_content', 'move_card'].
 *   2. No verb carries instruction/command/exec semantics.
 *   3. The review gate refuses a move into an execution column from an
 *      unreviewed one, and allows it from a reviewed one.
 *   4. The gate FAILS CLOSED when the column configuration cannot be resolved
 *      — a gate that fails open is worse than no gate, because it looks handled.
 *   5. The gate keys on column ROLE/KIND, not on a label string, so renaming a
 *      column does not silently open it.
 *   6. Dispatch and refusal receipts both name the plan and the credential, and
 *      a refusal is labelled as one. A refusal nobody can see is
 *      indistinguishable from a trigger that silently did not fire.
 *   7. RemoteControlService actually CALLS the gate on its dispatch path — a
 *      module nobody invokes is a boundary that does not exist.
 *
 * See the-remote-command-vocabulary-is-closed.md.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'out');

const {
    ALLOWED_REMOTE_VERBS,
    checkReviewGate,
    isExecutionColumn,
    isReviewedStage,
    formatDispatchReceipt,
    formatRefusalReceipt,
} = require(path.join(OUT, 'services', 'remote', 'RemoteCommandEnforcement.js'));
const { DEFAULT_KANBAN_COLUMNS } = require(path.join(OUT, 'services', 'agentConfig.js'));

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.message}`);
    }
}

check('the vocabulary is closed at exactly two verbs', () => {
    assert.strictEqual(ALLOWED_REMOTE_VERBS.length, 2,
        'The remote command vocabulary must be exactly two verbs. A third turns a ' +
        'reviewed-plan pipeline into a remote shell. See the-remote-command-vocabulary-is-closed.md.');
    assert.ok(ALLOWED_REMOTE_VERBS.includes('author_content'), 'author_content must be present');
    assert.ok(ALLOWED_REMOTE_VERBS.includes('move_card'), 'move_card must be present');
});

check('no verb carries free-text instruction semantics', () => {
    for (const verb of ALLOWED_REMOTE_VERBS) {
        assert.ok(!/instruction|command|exec|prompt|run|shell/.test(verb),
            `Verb '${verb}' must not carry instruction/command/exec semantics.`);
    }
});

check('the review gate refuses execution dispatch without review', () => {
    const gate = checkReviewGate({
        targetColumn: 'LEAD CODED', sourceColumn: 'CREATED',
        columns: DEFAULT_KANBAN_COLUMNS, isRemote: true,
    });
    assert.strictEqual(gate.allowed, false, 'CREATED → LEAD CODED must be refused.');
    assert.ok(gate.refusalReason, 'A refusal must carry a reason — a silent refusal hides probing.');
});

check('the review gate allows execution dispatch after review', () => {
    const gate = checkReviewGate({
        targetColumn: 'LEAD CODED', sourceColumn: 'PLAN REVIEWED',
        columns: DEFAULT_KANBAN_COLUMNS, isRemote: true,
    });
    assert.strictEqual(gate.allowed, true, 'PLAN REVIEWED → LEAD CODED must be allowed.');
});

check('the review gate allows non-execution moves without review', () => {
    const gate = checkReviewGate({
        targetColumn: 'PLAN REVIEWED', sourceColumn: 'CREATED',
        columns: DEFAULT_KANBAN_COLUMNS, isRemote: true,
    });
    assert.strictEqual(gate.allowed, true, 'A move to a non-execution column is always allowed.');
});

check('the review gate fails closed when columns are unresolvable', () => {
    for (const columns of [[], undefined, null]) {
        const gate = checkReviewGate({
            targetColumn: 'LEAD CODED', sourceColumn: 'CREATED', columns, isRemote: true,
        });
        assert.strictEqual(gate.allowed, false,
            'The gate must fail CLOSED when column configuration is missing or unresolvable.');
    }
});

check('the gate keys on role/kind, not on the label string', () => {
    // Same roles and kinds, every label renamed. The gate must behave identically.
    const renamed = DEFAULT_KANBAN_COLUMNS.map(c => ({ ...c, label: `Zzz ${c.id}` }));
    assert.strictEqual(
        checkReviewGate({ targetColumn: 'LEAD CODED', sourceColumn: 'CREATED', columns: renamed }).allowed,
        false, 'Renaming a column must not open the gate.');
    assert.strictEqual(
        checkReviewGate({ targetColumn: 'LEAD CODED', sourceColumn: 'PLAN REVIEWED', columns: renamed }).allowed,
        true, 'Renaming a column must not close a path review already opened.');
});

check('isExecutionColumn identifies every built-in coding column', () => {
    for (const id of ['LEAD CODED', 'CODER CODED', 'INTERN CODED']) {
        assert.ok(isExecutionColumn(id, DEFAULT_KANBAN_COLUMNS), `${id} must read as execution`);
    }
    for (const id of ['CREATED', 'PLAN REVIEWED', 'COMPLETED']) {
        assert.ok(!isExecutionColumn(id, DEFAULT_KANBAN_COLUMNS), `${id} must NOT read as execution`);
    }
});

check('isReviewedStage identifies review columns and rejects unreviewed ones', () => {
    for (const id of ['PLAN REVIEWED', 'CODE REVIEWED']) {
        assert.ok(isReviewedStage(id, DEFAULT_KANBAN_COLUMNS), `${id} must read as reviewed`);
    }
    for (const id of ['CREATED', 'LEAD CODED']) {
        assert.ok(!isReviewedStage(id, DEFAULT_KANBAN_COLUMNS), `${id} must NOT read as reviewed`);
    }
});

check('dispatch receipt names the plan, credential and target column', () => {
    const receipt = formatDispatchReceipt('test-plan-id', 'linear', 'LEAD CODED');
    assert.ok(receipt.includes('test-plan-id'), 'Receipt must name the plan.');
    assert.ok(receipt.includes('linear'), 'Receipt must name the credential source.');
    assert.ok(receipt.includes('LEAD CODED'), 'Receipt must name the target column.');
});

check('refusal receipt names the plan, credential and reason, and is labelled a refusal', () => {
    const refusal = formatRefusalReceipt('test-plan-id', 'linear', 'not reviewed');
    assert.ok(refusal.includes('test-plan-id'), 'Refusal must name the plan.');
    assert.ok(refusal.includes('linear'), 'Refusal must name the credential source.');
    assert.ok(refusal.includes('not reviewed'), 'Refusal must name the reason.');
    assert.ok(refusal.includes('REFUSED'), 'Refusal must be labelled as a refusal.');
});

check('RemoteControlService calls the gate on its dispatch path', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/services/RemoteControlService.ts'), 'utf8');
    assert.ok(src.includes('checkReviewGate('),
        'RemoteControlService must call checkReviewGate — an enforcement module nobody ' +
        'invokes is a boundary that does not exist.');
    assert.ok(src.includes('formatRefusalReceipt('),
        'A refused trigger must post a receipt; a refusal nobody can see is ' +
        'indistinguishable from a trigger that silently did not fire.');
});

check('the enforcement point is wired at the single remote construction site', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/services/KanbanProvider.ts'), 'utf8');
    assert.ok(/getColumns\s*:/.test(src),
        'The RemoteControlService deps must supply getColumns, or the review gate has ' +
        'no column configuration and every remote dispatch bypasses it.');
    assert.ok(/credentialSource\s*:/.test(src),
        'The RemoteControlService deps must supply credentialSource, or receipts cannot ' +
        'name which credential acted.');
});

if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
}
console.log('\nAll remote command vocabulary contract assertions passed.');
