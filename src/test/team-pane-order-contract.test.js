// team-pane-order-contract.test.js
//
// A registered team seats by its REGISTERED ORDER, head in slot 0, with a slot
// HELD for a member that has not registered yet.
//
// The bug: `getGroupMembers` returns `order.filter(n => live.has(n))`, so a
// member that had not come up at the instant the group seated was dropped and
// everyone behind it shifted up. A team's four seats spawn within ~3 seconds of
// each other, so losing that race put coder-1 top-left and appended the head to
// the last slot — and nothing re-seats afterwards.
//
// The cost was not cosmetic. The operator reads the grid to know which pane is
// the lead, pasted the lead's prompt into the top-left pane, and a coder spent
// the next hour acting as lead: running a dispatch queue on the intern,
// planning its own head commit, reporting sideways instead of up. Observed
// 2026-09-13.
//
// Pins cannot cover this: `pinnedPanes[i]` is never true while
// `paneAssignments[i]` is null, so a pin cannot reserve an empty slot for a
// terminal that has not appeared. A pin protects a seated terminal; this
// protects a seat.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(REPO_ROOT, 'src/webview/terminals.js'), 'utf8');

let failures = 0;
let passes = 0;
function check(name, fn) {
    try { fn(); passes++; console.log(`  ✅ ${name}`); }
    catch (err) { failures++; console.error(`  ❌ ${name}`); console.error(`     ${err && err.message}`); }
}

console.log('\n── team pane order contract ──');

check('seating uses the registered order, not the liveness-filtered list', () => {
    assert.ok(
        /const page = seatOrder\.slice\(/.test(SRC),
        'the page must be cut from the registered seat order — cutting it from the '
        + 'liveness-filtered member list is what collapses the slots',
    );
    assert.ok(
        /Math\.ceil\(seatOrder\.length \/ perPage\)/.test(SRC),
        'paging must count held slots too, or pages renumber as seats come up',
    );
});

check('the head is anchored to slot 0', () => {
    assert.ok(
        /registered\.splice\(headAt, 1\);\s*registered\.unshift\(headName\);/.test(SRC),
        'group.head must be moved to index 0 — a hand-edited definition or an older '
        + 'build can register an order that does not start with the head, and slot 0 is '
        + 'the one position an operator navigates by',
    );
});

check('an offline member HOLDS its slot instead of shifting the rest up', () => {
    assert.ok(
        /seatOrder = registered\.map\(n => \(liveNow\.has\(n\) \? n : null\)\)/.test(SRC),
        'a member that is not live must map to null (a held, empty slot), never be '
        + 'filtered out — filtering is what shifts every later seat up one pane',
    );
});

check('a live member unknown to the registration is appended, never inserted', () => {
    const m = SRC.match(/for \(const n of members\) \{\s*if \(!registered\.includes\(n\)\) \{ seatOrder\.push\(n\); \}/);
    assert.ok(m, 'an unregistered live member must be pushed onto the end, so it cannot '
        + 'displace a registered position');
});

if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log(`\nResults: ${passes} passed, ${failures} failed.`);
