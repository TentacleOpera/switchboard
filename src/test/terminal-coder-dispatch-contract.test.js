'use strict';

/**
 * Contract: Terminal Coder Dispatch bounds — retargeted to the enriched drive prefix.
 *
 * The skill file (.agents/protocols/terminal-coder-dispatch/SKILL.md) was deleted;
 * its 7 load-bearing behavioral rules were inlined into _buildDrivePrefix in
 * KanbanProvider.ts. This contract now pins those rules against the prefix source
 * text so deletions or accidental regressions fail CI immediately.
 *
 * Retargeting decisions (per the plan's per-assertion table):
 * - finding-cites-plan-clause → RETARGET to prefix wording
 * - name-defect-not-mechanism → RETARGET to prefix wording (drop "The one exception" sub-assertion)
 * - git-verb prohibition → RETARGET to prefix wording (drop enumerated-verbs sub-assertion)
 * - clear-at-rest → RETARGET to prefix wording (drop "mandatory for correctness" sub-assertion)
 * - §5.6 unattended → RETARGET the 4 inlined unattended rules
 * - §6 escalation → RETARGET to prefix REVIEW line
 * - authority order → DROP (full authority ladder not in prefix)
 * - review conformance (§5) → DROP (review-methodology detail not in 7 rules)
 * - never-message-a-working-seat → DROP (specific wording not in prefix)
 * - §7 regression rules → DROP (operational details enforced by system)
 * - All observed-failure anecdotes → DROP (illustrative, not operational)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const KANBAN_PROVIDER = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'services', 'KanbanProvider.ts'), 'utf8'
);

// Extract the _buildDrivePrefix method body from the source text. The rules are
// inlined as string literals inside the `block` array literal within that method.
const drivePrefixStart = KANBAN_PROVIDER.indexOf('_buildDrivePrefix');
assert.ok(drivePrefixStart > 0, '_buildDrivePrefix method must exist in KanbanProvider.ts');
const drivePrefixEnd = KANBAN_PROVIDER.indexOf('return block.join', drivePrefixStart);
assert.ok(drivePrefixEnd > 0, '_buildDrivePrefix must have a return block.join statement');
const DRIVE_PREFIX_SRC = KANBAN_PROVIDER.slice(drivePrefixStart, drivePrefixEnd);

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

test('finding-cites-plan-clause rule is inlined in the drive prefix', () => {
    assert.ok(
        /Every finding cites a plan clause/.test(DRIVE_PREFIX_SRC),
        'finding citation rule is missing from the drive prefix'
    );
    assert.ok(
        /Quote the section or line the diff violates/.test(DRIVE_PREFIX_SRC),
        'instruction to quote violated section or line is missing from the drive prefix'
    );
});

test('name-the-defect-not-the-mechanism rule is inlined in the drive prefix', () => {
    assert.ok(
        /Name the defect, never the mechanism/.test(DRIVE_PREFIX_SRC),
        'name defect not mechanism rule is missing from the drive prefix'
    );
    assert.ok(
        /Where the plan itself names a mechanism, quote the plan verbatim/.test(DRIVE_PREFIX_SRC),
        'the plan-quoting exception for naming mechanism is missing from the drive prefix'
    );
});

test('git-verb prohibition is inlined in the drive prefix', () => {
    assert.ok(
        /Never issue a git verb/.test(DRIVE_PREFIX_SRC),
        'git-verb prohibition is missing from the drive prefix'
    );
    assert.ok(
        /coders never commit/.test(DRIVE_PREFIX_SRC),
        'rule that coders never commit is missing from the drive prefix'
    );
});

test('clear-at-rest rule is inlined in the drive prefix', () => {
    assert.ok(
        /Clear a terminal only when at rest/.test(DRIVE_PREFIX_SRC),
        'clear-at-rest rule is missing from the drive prefix'
    );
});

test('§5.6 unattended rules are inlined in the drive prefix', () => {
    assert.ok(
        /You are unattended when no human is demonstrably reading/.test(DRIVE_PREFIX_SRC),
        'unattended entry condition is missing from the drive prefix'
    );
    assert.ok(
        /When you cannot tell, assume unattended/.test(DRIVE_PREFIX_SRC),
        'unattended tie-break default is missing from the drive prefix'
    );
    assert.ok(
        /Record a question report to .switchboard\/orchestrator\/reports\/ and continue in the same turn/.test(DRIVE_PREFIX_SRC),
        'record-and-continue rule is missing from the drive prefix'
    );
    assert.ok(
        /Subtask blocked after escalation: record blocked, leave the card, move to the next subtask/.test(DRIVE_PREFIX_SRC),
        'blocked-after-escalation rule is missing from the drive prefix'
    );
    assert.ok(
        /Anything irreversible.*destructive git.*pushing.*deleting data or cards.*stop and record/.test(DRIVE_PREFIX_SRC),
        'irreversible-action rule is missing from the drive prefix'
    );
});

test('§6 escalation ladder is in the drive prefix REVIEW line', () => {
    assert.ok(
        /Escalate after two failures on the same subtask: intern → coder → lead/.test(DRIVE_PREFIX_SRC),
        'escalation ladder is missing from the drive prefix REVIEW line'
    );
});

test('the skill file pointer has been removed from the drive prefix', () => {
    assert.ok(
        !/terminal-coder-dispatch\/SKILL\.md/.test(DRIVE_PREFIX_SRC),
        'the drive prefix must not reference the deleted skill file'
    );
});

test('the SUBTASKS section has been removed from the drive prefix', () => {
    assert.ok(
        !/SUBTASKS:/.test(DRIVE_PREFIX_SRC),
        'the drive prefix must not contain a SUBTASKS section (plan IDs are in the feature file)'
    );
});

test('the FEATURE FILE line is present in the drive prefix', () => {
    assert.ok(
        /FEATURE FILE:/.test(DRIVE_PREFIX_SRC),
        'the drive prefix must contain a FEATURE FILE line pointing at the feature file'
    );
    assert.ok(
        /Team Dispatch Instructions/.test(DRIVE_PREFIX_SRC),
        'the FEATURE FILE line must reference the Team Dispatch Instructions section'
    );
});

test('DRIVE_FEATURE_PREFIX fallback does not reference the deleted skill file', () => {
    const fallbackMatch = KANBAN_PROVIDER.match(/const DRIVE_FEATURE_PREFIX = '([^']*)'/);
    assert.ok(fallbackMatch, 'DRIVE_FEATURE_PREFIX constant must exist');
    assert.ok(
        !/terminal-coder-dispatch/.test(fallbackMatch[1]),
        'DRIVE_FEATURE_PREFIX fallback must not reference the deleted skill file'
    );
});

if (failures > 0) {
    console.error(`\n${failures} contract failure(s)`);
    process.exit(1);
}
console.log('\nAll terminal-coder-dispatch contract assertions passed.');
