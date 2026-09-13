// task-complete-instruction-contract.test.js
//
// NO agent is asked to write a summary to complete work. Not a coder, not a
// lead, not anyone. Completion is ASSERTED by the post itself — a responsible
// agent calling the endpoint for that planId. Prose is not the signal and must
// never gate the signal.
//
// This suite exists because both halves of that were broken at once:
//
//  - V77 (307078f3) made `outcome` MANDATORY and rejected any post without it,
//    while updating none of the five places that tell an agent how to call the
//    endpoint. Every documented payload described a call the endpoint refused.
//    Because those instructions also say "until you post, the seat is not
//    cleared", a lead that obeyed them deadlocked its team: measured
//    2026-09-13, seven refusals over an hour with three coders idle behind it.
//
//  - The repair attempted first was to add the field to all five instructions,
//    which turned every close-out into a writing task. That was the wrong side
//    to change and is the thing these assertions now forbid.
//
// The gate is removed and the instructions are back to {from, planId,
// workspaceRoot}. `outcome` is still accepted and stored when a caller offers
// one; it is never required and never requested.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
let failures = 0;
let passes = 0;

function check(name, fn) {
    try { fn(); passes++; console.log(`  ✅ ${name}`); }
    catch (err) { failures++; console.error(`  ❌ ${name}`); console.error(`     ${err && err.message}`); }
}

console.log('\n── task/complete instruction contract ──');

// Every file that builds an agent-facing instruction naming the endpoint.
const SOURCES = [
    'src/services/LocalApiServer.ts',
    'src/services/teamWiring.ts',
    'src/services/standingOrderFragments.ts',
    'src/services/KanbanProvider.ts',
];

check('the endpoint does not require an outcome', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/services/LocalApiServer.ts'), 'utf8');
    assert.ok(
        !/Missing required field: outcome/.test(src),
        'the completion endpoint must not reject a post for lacking an outcome — that gate '
        + 'deadlocked a whole team for an hour and its only remedy is making agents write prose',
    );
});

check('no instruction asks an agent to supply an outcome', () => {
    // Source is joined without newlines because these payloads are built by
    // string concatenation across several lines; a per-line scan misses a field
    // that sits on the next `+` fragment.
    const offenders = [];
    for (const rel of SOURCES) {
        const flat = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\n/g, ' ');
        const re = /task\/complete with \{"from"/g;
        let m;
        while ((m = re.exec(flat)) !== null) {
            const window = flat.slice(m.index, m.index + 400);
            if (/outcome/.test(window)) { offenders.push(`${rel} @ ${m.index}`); }
        }
    }
    assert.deepStrictEqual(
        offenders, [],
        'these instructions ask an agent to write a summary to close work out. Completion is '
        + 'asserted by the post, not by prose:\n       ' + offenders.join('\n       '),
    );
});

check('at least one instruction site exists to protect', () => {
    // Guards the test itself: a rename that moves every instruction elsewhere
    // would otherwise leave this suite green over zero assertions.
    let total = 0;
    for (const rel of SOURCES) {
        const flat = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\n/g, ' ');
        total += (flat.match(/task\/complete with \{"from"/g) || []).length;
    }
    assert.ok(total >= 4, `expected the known instruction sites to still be present, found ${total}`);
});

check('the drive close-out block is gated to the lead role', () => {
    // A coder does not assert completion — it reports, and the HEAD posts
    // /kanban/task/complete (plan: add-a-task-complete-endpoint-for-the-lead).
    // The feature-dispatch call site admitted ['lead','coder','intern'] into the
    // prefix builder, so the lead's close-out contract — "CLOSE OUT EVERY
    // SUBTASK … the coder is not cleared" — was handed to coders and interns,
    // who were then told to assert their own completion.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/services/KanbanProvider.ts'), 'utf8');
    assert.ok(
        /if \(drive && \(role === undefined \|\| role === 'lead'\)\)/.test(src),
        'the drive block must be gated on the lead role — ungated it hands the head\'s '
        + 'completion contract to every coding role',
    );
    assert.ok(
        /_buildFeatureDirectivePrefix\(workspaceRoot, await resolveDrive\(\), plans, role\)/.test(src),
        'the feature-dispatch call site must thread `role` through, or the gate above '
        + 'defaults open for exactly the path that admits coders and interns',
    );
});

if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log(`\nResults: ${passes} passed, ${failures} failed.`);
