// task-complete-instruction-contract.test.js
//
// `POST /kanban/task/complete` rejects any call without a non-empty `outcome`
// (LocalApiServer: "Missing required field: outcome"). That requirement landed
// in 307078f3 and NOT ONE of the five places that tell an agent how to call the
// endpoint was updated, so every instruction in the codebase described a call
// the endpoint refuses.
//
// The cost was not a visible error. The same instructions end with "Until you
// post, the seat is not cleared and you cannot be handed the next subtask", so
// a lead that obeyed them deadlocked its whole team: measured 2026-09-13, a
// Coding lead retried the documented payload seven times over an hour, was
// refused every time, and three coders sat idle behind it.
//
// No existing gate compares instruction TEXT against handler VALIDATION — they
// live in different files and neither imports the other — which is why a
// one-sided change to the contract shipped silently. This test is that
// comparison.

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

check('the endpoint still requires a non-empty outcome', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/services/LocalApiServer.ts'), 'utf8');
    assert.ok(
        /Missing required field: outcome/.test(src),
        'the handler no longer demands `outcome` — if that requirement was deliberately dropped, '
        + 'delete this suite rather than leaving it asserting a contract that no longer exists',
    );
});

check('every task/complete instruction supplies outcome', () => {
    // Source is joined without newlines because these payloads are built by
    // string concatenation across several lines; matching per-line reports a
    // false miss on a payload whose `outcome` sits on the next `+` fragment.
    const offenders = [];
    for (const rel of SOURCES) {
        const flat = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\n/g, ' ');
        // Each occurrence of the documented payload, and the window after it in
        // which its own closing brace must appear alongside `outcome`.
        const re = /task\/complete with \{"from"/g;
        let m;
        while ((m = re.exec(flat)) !== null) {
            const window = flat.slice(m.index, m.index + 400);
            if (!/outcome/.test(window)) {
                offenders.push(`${rel} @ ${m.index}`);
            }
        }
    }
    assert.deepStrictEqual(
        offenders, [],
        'these instructions describe a call the endpoint refuses — an agent that obeys them '
        + 'deadlocks its team, because the same text says the seat is not cleared until the post '
        + 'succeeds:\n       ' + offenders.join('\n       '),
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

if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log(`\nResults: ${passes} passed, ${failures} failed.`);
