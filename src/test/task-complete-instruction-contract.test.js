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

check('no instruction-shaped string — including error bodies — tells an agent to supply an outcome', () => {
    // The original `task/complete with {"from"` scan missed the 409 in-flight
    // body at LocalApiServer.ts:3735 because that body says
    // `task/complete with a non-empty outcome` — a different shape. It was
    // prose in an error string, not a payload template, so the gate never saw
    // it. A seat that hit the 409 followed its remedy, assembled a 3389-byte
    // body with `outcome: "finished"`, and went reading source to break the
    // tie when the endpoint rejected it.
    //
    // This check scans for instruction-shaped strings that mention
    // `task/complete` in ANY form (`task/complete with ...`,
    // `POST /kanban/task/complete ...`) and fails if any such string within a
    // bounded window also instructs the caller to supply an `outcome`
    // (`non-empty outcome`, `outcome:`, `"outcome"`). The assertion is "no
    // instruction *tells an agent to supply* an outcome", not "no source string
    // contains the word outcome" — the endpoint's own JSDoc legitimately
    // documents `outcome` as an accepted, optional field, so a bare `outcome`
    // match would false-positive there. Scope is instruction-shaped text (a
    // `task/complete` call description), not bare occurrences of the word.
    const offenders = [];
    for (const rel of SOURCES) {
        const flat = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\n/g, ' ');
        // Match any instruction-shaped string that names the endpoint:
        // `task/complete with ...` or `POST /kanban/task/complete ...`.
        const re = /(?:task\/complete with |POST \/kanban\/task\/complete )/g;
        let m;
        while ((m = re.exec(flat)) !== null) {
            const window = flat.slice(m.index, m.index + 400);
            if (/(?:non-empty outcome|outcome\s*:|["']outcome["'])/i.test(window)) {
                offenders.push(`${rel} @ ${m.index}`);
            }
        }
    }
    assert.deepStrictEqual(
        offenders, [],
        'these instruction-shaped strings (including error bodies) tell an agent to supply an '
        + 'outcome. Completion is asserted by the post, not by prose, and the 409 in-flight body '
        + 'is now lead-facing — it must not teach a payload the endpoint does not want:\n       '
        + offenders.join('\n       '),
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

check('done never 409s a card it released', () => {
    // The `done` / `queue/done` call has SUCCEEDED by the time the pop runs —
    // the working-state latch cleared and the relay fired — so the response
    // must resolve 200 regardless of the pop's status. Forwarding `pop.status`
    // produced a 409 carrying `released: <planId>`: a contradiction a caller
    // cannot act on (the seat that hit this in production read non-zero exit
    // + the 409 body and concluded its `done` had failed, then spent its
    // remaining turns reading source to work out what to send). The pop's own
    // refusal (team still in flight because `completed_at` is the lead's
    // separate post) is nested under `next` for diagnostics, not forwarded as
    // the `done` call's own failure.
    //
    // Source-shape assertion in the same style as the suite's existing checks;
    // a runtime blackbox is out of scope for this contract suite (a static
    // source scan).
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/services/LocalApiServer.ts'), 'utf8');
    // The success branch of _runQueueDone resolves status 200 (not pop.status).
    assert.ok(
        /resolve\(\{ status: 200, payload \}\)/.test(src),
        '_runQueueDone must resolve status: 200 on the success branch (after clearWorkingState '
        + 'transitioned), not forward pop.status — a 409 carrying `released` is a contradiction '
        + 'a caller cannot act on',
    );
    // No resolved payload carries both status: 409 and a released field. The
    // only `resolve({ status:` shapes in _runQueueDone are the 200 success
    // branch, the 200-duplicate branch, and the 400/500 fail() branches (which
    // do not carry `released`). Assert the 200 branch is the one that carries
    // `released`.
    assert.ok(
        /released: held\.planId,/.test(src),
        'the success-branch payload must carry released: held.planId so the caller can record '
        + 'which card was released',
    );
    // The pop's refusal is nested under `next`, not left at top level as
    // success: false + error (the "released AND refused" contradiction).
    assert.ok(
        /\.\.\.\(popFailed \? \{ next: \{\s*\n\s*status: pop\.status,\s*\n\s*error: popPayload\.error,/.test(src),
        'the pop\'s refusal (status/error) must be nested under a `next` key for diagnostics, '
        + 'not forwarded as the done call\'s own failure at top level',
    );
    // `next` must carry the pop's OWN diagnostic objects, both of them. Dropping
    // `dependencyBlocked` on the floor leaves a dependency refusal with nothing
    // but a status code, which is how the borrowed 'team in flight' label got
    // read as a measurement in the first place.
    for (const field of ['inFlight', 'dependencyBlocked']) {
        assert.ok(
            new RegExp(`popPayload\\.${field} \\? \\{ ${field}: popPayload\\.${field} \\}`).test(src),
            `the next-refusal diagnostic must carry popPayload.${field} when the pop set it`,
        );
    }
    // The refusal REASON is derived from which diagnostic the pop actually set —
    // never one label standing in for three different refusals. A default that
    // behaves like a measured value is the failure mode CLAUDE.md names.
    assert.ok(
        /popPayload\.inFlight\s*\n\s*\? 'team in flight'\s*\n\s*: popPayload\.dependencyBlocked\s*\n\s*\? 'dependency blocked'\s*\n\s*: 'next dispatch refused'/.test(src),
        'the done payload\'s reason for a refused pop must discriminate inFlight / dependencyBlocked / '
        + 'dispatch-refused, not label every refusal \'team in flight\'',
    );
});

if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log(`\nResults: ${passes} passed, ${failures} failed.`);
