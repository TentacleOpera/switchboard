'use strict';

/**
 * Contract: Terminal Coder Dispatch bounds.
 *
 * A head agent driving a feature through coder terminals must dispatch, review against
 * the plan, and report. It must not author design, must not add scope, must not issue
 * git verbs to its seats, and must not send a second message into a seat that has not reported.
 *
 * This contract test pins the load-bearing rules and bounds in the skill documentation
 * so that deletions or accidental regressions fail CI immediately.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const SKILL = '.agents/skills/terminal-coder-dispatch/SKILL.md';
const CLAUDE_SKILL = '.claude/skills/terminal-coder-dispatch/SKILL.md';

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failures++;
        console.error(`  ❌ ${name}\n     ${e.message}`);
    }
}

for (const target of [SKILL, CLAUDE_SKILL]) {
    console.log(`\nValidating contract on ${target}:`);

    test(`[${target}] authority order appears and names the plan file as last`, () => {
        const skill = read(target);
        assert.ok(/authority order/i.test(skill), 'authority order section is missing');
        assert.ok(/The user/i.test(skill), 'authority order missing "The user"');
        assert.ok(/Project contracts/i.test(skill), 'authority order missing "Project contracts"');
        assert.ok(
            /The plan file[\s\S]{0,120}last in authority/i.test(skill) || /plan file[\s\S]{0,80}last/i.test(skill),
            'authority order does not state the plan file is last'
        );
    });

    test(`[${target}] a finding-must-cite-a-plan-clause rule exists with observed failure`, () => {
        const skill = read(target);
        assert.ok(
            /[Ee]very finding cites a plan clause/.test(skill),
            'finding citation rule is missing'
        );
        assert.ok(
            /Quote the section or line/i.test(skill),
            'instruction to quote violated section or line is missing'
        );
        // Anchored on wording unique to THIS rule. A looser "resolver ... dead store"
        // regex is satisfied by rule 2's observed failure, so deleting rule 1's whole
        // paragraph left the gate green.
        assert.ok(
            /[Oo]bserved failure[\s\S]{0,400}matches four existing[\s\S]{0,200}dead store[\s\S]{0,300}three-subtask defect/i.test(skill),
            'observed failure for finding citation (an existing-but-wrong resolver accepted, then propagated) is missing'
        );
    });

    test(`[${target}] name-the-defect-not-the-mechanism rule exists, and its plan-quoting exception exists`, () => {
        const skill = read(target);
        assert.ok(
            /[Nn]ame the defect, never the mechanism/.test(skill),
            'name defect not mechanism rule is missing'
        );
        assert.ok(
            /[Tt]he one exception[\s\S]{0,120}where the plan (itself )?names a mechanism[\s\S]{0,80}quote the plan verbatim/i.test(skill),
            'the plan-quoting exception for naming mechanism is missing or incomplete'
        );
        assert.ok(
            /[Oo]bserved failure[\s\S]{0,350}(?:invented a resolver|designed a replacement)/i.test(skill),
            'observed failure for invented mechanism is missing'
        );
    });

    test(`[${target}] git-verb prohibition exists and names commit`, () => {
        const skill = read(target);
        assert.ok(
            /[Nn]ever issue a git verb to a team seat/.test(skill),
            'git-verb prohibition is missing'
        );
        assert.ok(
            /No `?commit`?, `?push`?, `?branch`?, `?merge`?/i.test(skill),
            'git-verb prohibition does not enumerate prohibited verbs including commit'
        );
        assert.ok(
            /A team commits \*\*once\*\*, as its head/i.test(skill) || /Coders in a team never commit/i.test(skill),
            'rule that coders never commit is missing'
        );
        // The cost half is pinned too: without it the failure reads as a style slip
        // rather than an unscoped commit on main that the git policy forbids unwinding.
        assert.ok(
            /[Oo]bserved failure[\s\S]{0,350}sw(?:ept|eeping) seven subtasks[\s\S]{0,200}unscoped commit on/i.test(skill),
            'observed failure for git commit verb is missing (or its unscoped-commit-on-main cost was dropped)'
        );
    });

    test(`[${target}] review turn (§5) includes mechanism conformance verification`, () => {
        const skill = read(target);
        assert.ok(
            /Where the plan names a mechanism, verify the seat used \*\*that\*\*\s+mechanism/i.test(skill),
            '§5 conformance step for plan-named mechanism is missing'
        );
        assert.ok(
            /The function exists and has other call sites.*is not conformance/i.test(skill),
            '§5 warning that existing function with call sites is not conformance is missing'
        );
    });

    test(`[${target}] never-message-a-working-seat and single-instruction rules exist`, () => {
        const skill = read(target);
        assert.ok(
            /[Nn]ever message a seat that has not reported/.test(skill),
            'never-message-a-working-seat rule is missing'
        );
        // Anchored to the working-seat sentence: a bare /mid-turn/ also matches §3.5's
        // pre-existing "it will not interrupt you mid-turn", so the rationale was unpinned.
        assert.ok(
            /have not heard from is\s+mid-turn/i.test(skill),
            'mid-turn rationale for working seat is missing'
        );
        assert.ok(
            /[Cc]orrecting an instruction already delivered is a clear plus one authoritative dispatch/i.test(skill),
            'clear plus one dispatch rule for correcting delivered instruction is missing'
        );
        assert.ok(
            /[Pp]refer an idle seat over a second item/i.test(skill),
            'prefer idle seat over piling on busy seat rule is missing'
        );
    });

    test(`[${target}] clear-at-rest rule is stated as mandatory for correctness`, () => {
        const skill = read(target);
        assert.ok(
            /mandatory for correctness/i.test(skill),
            'clear-at-rest is not marked as mandatory for correctness'
        );
        assert.ok(
            /[Cc]lear at rest, always/.test(skill),
            'clear at rest, always directive is missing'
        );
    });

    test(`[${target}] §5.6 driving unattended section exists with core asymmetry, complete default-action table, and turn bounds`, () => {
        const skill = read(target);
        assert.ok(
            /## 5\.6\. Driving unattended/i.test(skill) || /driving unattended/i.test(skill),
            'driving unattended section is missing'
        );
        assert.ok(
            /asking costs the whole night; acting wrongly on a reversible thing costs one card/i.test(skill),
            'core asymmetry sentence is missing'
        );

        // A mode with no entry condition never fires: a head that cannot tell which
        // mode it is in reads the attended rules and stalls, which is the whole bug.
        assert.ok(
            /[Ww]hich mode you are in/.test(skill),
            'the unattended mode has no stated entry condition — a head cannot tell which mode governs'
        );
        assert.ok(
            /[Ww]hen you cannot tell, you\s+are unattended/i.test(skill),
            'the tie-break defaulting an undetermined head to unattended is missing'
        );

        // Verify default-action table rows
        assert.ok(/Which seat takes the next item/i.test(skill), 'table row "Which seat takes the next item" missing');
        assert.ok(/Order of remaining work/i.test(skill), 'table row "Order of remaining work" missing');
        assert.ok(/A defect with no citable plan clause/i.test(skill), 'table row "A defect with no citable plan clause" missing');
        assert.ok(/A seat fails the same subtask twice/i.test(skill), 'table row "A seat fails the same subtask twice" missing');
        assert.ok(/The team's work is complete/i.test(skill), 'table row "The team\'s work is complete" missing');
        assert.ok(/A card looks superseded or redundant/i.test(skill), 'table row "A card looks superseded or redundant" missing');
        assert.ok(/A seat has reported and its next work is a different surface/i.test(skill), 'table row "A seat has reported..." missing');
        assert.ok(/Keeping a seat's context across subtasks/i.test(skill), 'table row "Keeping a seat\'s context across subtasks" missing');
        assert.ok(/Any decision not listed above/i.test(skill), 'catch-all table row "Any decision not listed above" missing');
        assert.ok(/Anything irreversible/i.test(skill), 'table row "Anything irreversible" missing');

        // Verify irreversible block bounds
        assert.ok(/Destructive git/i.test(skill), 'irreversible block does not name destructive git');
        assert.ok(/force push/i.test(skill), 'irreversible block does not name force push');
        assert.ok(/deleting user data or board cards/i.test(skill), 'irreversible block does not name deleting user data or board cards');

        // Bounding rules
        assert.ok(/A default is never an invention/i.test(skill), 'rule "A default is never an invention" missing');
        assert.ok(/Recording is not asking/i.test(skill), 'rule "Recording is not asking" missing');
        assert.ok(/Recording does not end your turn/i.test(skill), 'rule "Recording does not end your turn" missing');
        assert.ok(/The head commits as the team's head, not via a seat/i.test(skill), 'rule "The head commits as the team\'s head" missing');
    });

    test(`[${target}] §6 resend & escalation ladder includes unattended terminal rung`, () => {
        const skill = read(target);
        assert.ok(
            /Unattended:[\s\S]{0,200}retires \*\*that card\*\*, not the session/i.test(skill) ||
            /retires \*\*that card\*\*, not the session/i.test(skill),
            '§6 unattended ladder terminal rung retiring the card and proceeding to next queue item is missing'
        );
    });

    test(`[${target}] §7 original load-bearing rules survive (regression guard)`, () => {
        const skill = read(target);
        assert.ok(
            /[Nn]ever clear yourself/.test(skill),
            'regression: "Never clear yourself" was dropped'
        );
        assert.ok(
            /ptyClearAllTerminals/.test(skill),
            'regression: ptyClearAllTerminals warning was dropped'
        );
        assert.ok(
            /[Oo]nly clear a terminal that is genuinely at rest/.test(skill),
            'regression: "Only clear a terminal that is genuinely at rest" was dropped'
        );
        assert.ok(
            /no busy check/i.test(skill),
            'regression: "no busy check" warning was dropped'
        );
        assert.ok(
            /[Ss]tanding orders survive a clear/.test(skill),
            'regression: "Standing orders survive a clear" was dropped'
        );
    });
}

if (failures > 0) {
    console.error(`\n${failures} contract failure(s)`);
    process.exit(1);
}
console.log('\nAll terminal-coder-dispatch contract assertions passed.');
