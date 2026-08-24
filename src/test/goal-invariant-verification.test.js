'use strict';

/**
 * Contract: Goal-invariant verification and review escalation.
 * (goal-invariant-verification-and-review-escalation.md)
 *
 * Tests the two structural gaps the plan closes:
 *  1. The reviewer assesses the change against the plan's *steps*, not its *goal*.
 *     Fix: an unconditional GOAL VERDICT clause in reviewerBaseInstructions.
 *  2. A reviewer may change a plan's destination without escalation.
 *     Fix: an ESCALATION ON DESTINATION CHANGE clause + CONSTITUTION.md rule.
 *
 * Source-level assertions (no compile needed) + behavioural assertions
 * (require out/ — run after `npm run compile-tests`).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUILDER_SRC = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'services', 'agentPromptBuilder.ts'), 'utf8'
);
const CONSTITUTION = fs.readFileSync(
    path.join(REPO_ROOT, 'CONSTITUTION.md'), 'utf8'
);
const IMPROVE_PLAN = fs.readFileSync(
    path.join(REPO_ROOT, '.agents', 'protocols', 'improve-plan', 'SKILL.md'), 'utf8'
);
const IMPROVE_FEATURE = fs.readFileSync(
    path.join(REPO_ROOT, '.agents', 'protocols', 'improve-feature', 'SKILL.md'), 'utf8'
);
const VSIX_TEST = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'test', 'vsix-packaging-contract.test.js'), 'utf8'
);

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL ${name}`);
        console.error(`     ${e && e.message ? e.message : e}`);
        failed++;
    }
}

// ── Source-level: GOAL VERDICT clause in reviewerBaseInstructions ───────────

test('reviewerBaseInstructions contains the GOAL VERDICT clause', () => {
    assert.ok(
        BUILDER_SRC.includes('GOAL VERDICT (mandatory'),
        'Expected reviewerBaseInstructions to contain the GOAL VERDICT clause.'
    );
    assert.ok(
        BUILDER_SRC.includes("Assess the change against the plan's stated **goal**"),
        'Expected the goal verdict to assess against the plan goal, not just steps.'
    );
    assert.ok(
        BUILDER_SRC.includes('State whether the goal is achieved'),
        'Expected the goal verdict to demand a stated answer.'
    );
});

test('GOAL VERDICT clause is unconditional base text (no add-on flag)', () => {
    // The clause is appended to reviewerBaseInstructions without any
    // conditional — it must not be gated on an add-on or flag.
    const clauseIdx = BUILDER_SRC.indexOf('GOAL VERDICT (mandatory');
    assert.ok(clauseIdx > 0, 'GOAL VERDICT clause must exist');
    // Check it's inside a string concatenation chain, not inside an if-block.
    const before = BUILDER_SRC.slice(clauseIdx - 200, clauseIdx);
    assert.ok(
        before.includes("reviewerBaseInstructions") || before.includes("+ `\\n\\nGOAL VERDICT"),
        'GOAL VERDICT must be part of reviewerBaseInstructions, not a conditional block.'
    );
});

test('ESCALATION ON DESTINATION CHANGE clause exists in reviewerBaseInstructions', () => {
    assert.ok(
        BUILDER_SRC.includes('ESCALATION ON DESTINATION CHANGE'),
        'Expected reviewerBaseInstructions to contain the escalation clause.'
    );
    assert.ok(
        BUILDER_SRC.includes('### Review Deviations'),
        'Expected the escalation clause to name the Review Deviations section.'
    );
    assert.ok(
        BUILDER_SRC.includes('POST /kanban/move'),
        'Expected the escalation clause to use the sanctioned API path.'
    );
});

test('CARD_MOVE_RULE has the reviewer escalation exception', () => {
    assert.ok(
        BUILDER_SRC.includes('THE ONE EXCEPTION: a reviewer escalating'),
        'Expected CARD_MOVE_RULE to carve out the reviewer escalation exception.'
    );
});

// ── Source-level: pinned strings intact ─────────────────────────────────────

test('pinned string "assess the actual code changes against the plan requirements" is intact', () => {
    assert.ok(
        BUILDER_SRC.includes('assess the actual code changes against the plan requirements'),
        'The pinned string in reviewerExecutionBlock must be byte-identical.'
    );
});

test('pinned string "fix valid material issues, then verify." is intact', () => {
    assert.ok(
        BUILDER_SRC.includes('fix valid material issues, then verify.'),
        'The pinned string in reviewerExecutionBlock must be byte-identical.'
    );
});

// ── Source-level: CONSTITUTION.md escalation rule ───────────────────────────

test('CONSTITUTION.md contains the reviewer escalation rule', () => {
    assert.ok(
        CONSTITUTION.includes('Reviewer escalation on destination or goal change'),
        'Expected CONSTITUTION.md to contain the escalation rule heading.'
    );
    assert.ok(
        CONSTITUTION.includes('### Review Deviations'),
        'Expected the constitution to name the Review Deviations section.'
    );
    assert.ok(
        CONSTITUTION.includes('POST /kanban/move'),
        'Expected the constitution to specify the sanctioned API path.'
    );
    assert.ok(
        CONSTITUTION.includes('never via SQL'),
        'Expected the constitution to forbid SQL for card moves.'
    );
});

// ── Source-level: improve-plan Goal Invariants section ──────────────────────

test('improve-plan SKILL.md offers ### Goal Invariants as recommended', () => {
    assert.ok(
        IMPROVE_PLAN.includes('### Goal Invariants'),
        'Expected improve-plan to offer the Goal Invariants section.'
    );
    assert.ok(
        IMPROVE_PLAN.includes('RECOMMENDED'),
        'Expected the section to be marked recommended, not required.'
    );
    assert.ok(
        IMPROVE_PLAN.includes('Never a gate'),
        'Expected the section to explicitly state it is never a gate.'
    );
    assert.ok(
        IMPROVE_PLAN.includes('executable assertions that name concrete paths'),
        'Expected invariants to require concrete assertions, not prose.'
    );
    assert.ok(
        IMPROVE_PLAN.includes('negative invariant is mandatory'),
        'Expected removal/relocation goals to require a negative invariant.'
    );
    assert.ok(
        IMPROVE_PLAN.includes('paired'),
        'Expected negative invariants to require a paired positive.'
    );
});

test('improve-feature SKILL.md references Goal Invariants', () => {
    assert.ok(
        IMPROVE_FEATURE.includes('Goal Invariants'),
        'Expected improve-feature to reference Goal Invariants for subtasks.'
    );
});

// ── Source-level: vsix-packaging-contract.test.js must-not-exist ────────────

test('vsix-packaging-contract.test.js has must-not-exist assertions', () => {
    assert.ok(
        VSIX_TEST.includes('Must-not-exist assertions'),
        'Expected the packaging test to have a must-not-exist section.'
    );
    assert.ok(
        VSIX_TEST.includes('does NOT ship'),
        'Expected at least one must-not-exist assertion.'
    );
    assert.ok(
        VSIX_TEST.includes('.switchboard'),
        'Expected a must-not-exist assertion for .switchboard/ runtime data.'
    );
});

// ── Source-level: no confirm gates introduced ───────────────────────────────

test('no confirm gates introduced in agentPromptBuilder.ts', () => {
    // The escalation is a plan-file state + API call, not a modal.
    // Check the new text does not introduce confirm/window.confirm/showWarningMessage.
    const goalVerdictIdx = BUILDER_SRC.indexOf('GOAL VERDICT');
    const escalationIdx = BUILDER_SRC.indexOf('ESCALATION ON DESTINATION CHANGE');
    const cardMoveIdx = BUILDER_SRC.indexOf('THE ONE EXCEPTION');
    const region = BUILDER_SRC.slice(
        Math.min(goalVerdictIdx, cardMoveIdx) - 100,
        escalationIdx + 800
    );
    assert.ok(
        !region.includes('confirm('),
        'The escalation text must not introduce a confirm() call.'
    );
    assert.ok(
        !region.includes('window.confirm'),
        'The escalation text must not introduce a window.confirm call.'
    );
    assert.ok(
        !region.includes('showWarningMessage'),
        'The escalation text must not introduce a modal showWarningMessage.'
    );
});

test('no confirm gates introduced in CONSTITUTION.md escalation rule', () => {
    const escalationIdx = CONSTITUTION.indexOf('Reviewer escalation on destination');
    const region = CONSTITUTION.slice(escalationIdx, escalationIdx + 800);
    assert.ok(
        !region.includes('confirm('),
        'The constitution escalation rule must not introduce a confirm() call.'
    );
    assert.ok(
        region.includes('no confirmation dialogs'),
        'Expected the constitution to explicitly state no confirmation dialogs.'
    );
});

// ── Behavioural: reviewer prompt includes goal verdict with no add-ons ──────
// These require compiled output from out/. They are skipped if the module
// is not available (e.g. running without `npm run compile-tests`).

let buildKanbanBatchPrompt = null;
try {
    ({ buildKanbanBatchPrompt } = require('../../out/services/agentPromptBuilder'));
} catch (_e) {
    // Compiled output not available — behavioural tests skip.
}

const mockPlan = [
    { topic: 'test-plan', absolutePath: '/abs/path/to/test.md' }
];

function behaviouralTest(name, fn) {
    if (!buildKanbanBatchPrompt) {
        console.log(`  SKIP ${name} (out/ not compiled — run npm run compile-tests)`);
        return;
    }
    test(name, fn);
}

behaviouralTest('reviewer prompt with no add-ons includes GOAL VERDICT', () => {
    const prompt = buildKanbanBatchPrompt('reviewer', mockPlan, {});
    assert.ok(
        prompt.includes('GOAL VERDICT'),
        'Reviewer prompt with no add-ons must include the GOAL VERDICT clause — it is base text.'
    );
    assert.ok(
        prompt.includes('State whether the goal is achieved'),
        'Reviewer prompt must demand a stated goal verdict.'
    );
});

behaviouralTest('reviewer prompt includes ESCALATION ON DESTINATION CHANGE', () => {
    const prompt = buildKanbanBatchPrompt('reviewer', mockPlan, {});
    assert.ok(
        prompt.includes('ESCALATION ON DESTINATION CHANGE'),
        'Reviewer prompt must include the escalation clause.'
    );
    assert.ok(
        prompt.includes('### Review Deviations'),
        'Reviewer prompt must name the Review Deviations section.'
    );
});

behaviouralTest('planner prompt does NOT include GOAL VERDICT (reviewer-scoped)', () => {
    const prompt = buildKanbanBatchPrompt('planner', mockPlan, {
        plannerWorkflowPath: '.agents/protocols/improve-plan/SKILL.md'
    });
    assert.ok(
        !prompt.includes('GOAL VERDICT'),
        'Planner prompt must NOT include the GOAL VERDICT clause — it is reviewer-scoped.'
    );
});

behaviouralTest('methodology neutrality: GSD workflowFilePath does not change reviewer goal clause', () => {
    // The reviewer goal clause is base text — it does not read workflowFilePath.
    // So the clause is identical regardless of the planner's workflow file.
    const defaultPrompt = buildKanbanBatchPrompt('reviewer', mockPlan, {});
    const gsdPrompt = buildKanbanBatchPrompt('reviewer', mockPlan, {
        plannerWorkflowPath: '.claude/get-shit-done/agents/gsd-planner.md'
    });
    const superpowersPrompt = buildKanbanBatchPrompt('reviewer', mockPlan, {
        plannerWorkflowPath: '.claude/superpowers/skills/writing-plans.md'
    });
    assert.ok(
        defaultPrompt.includes('GOAL VERDICT'),
        'Reviewer goal clause must be present with default workflow path.'
    );
    assert.ok(
        gsdPrompt.includes('GOAL VERDICT'),
        'Reviewer goal clause must be present with GSD workflow path.'
    );
    assert.ok(
        superpowersPrompt.includes('GOAL VERDICT'),
        'Reviewer goal clause must be present with Superpowers workflow path.'
    );
    // The goal clause text must be byte-identical across all three — it reads
    // the goal as written, not a section schema, so the methodology is irrelevant.
    const extractGoalClause = (p) => {
        const start = p.indexOf('GOAL VERDICT');
        const end = p.indexOf('\n\n', start);
        return p.slice(start, end > start ? end : undefined);
    };
    const defaultClause = extractGoalClause(defaultPrompt);
    const gsdClause = extractGoalClause(gsdPrompt);
    const superpowersClause = extractGoalClause(superpowersPrompt);
    assert.strictEqual(defaultClause, gsdClause,
        'Goal clause must be identical under GSD workflow path.');
    assert.strictEqual(defaultClause, superpowersClause,
        'Goal clause must be identical under Superpowers workflow path.');
});

behaviouralTest('no tester dependency: goal verdict present with tester column disabled', () => {
    // The goal verdict is in reviewerBaseInstructions, not testerBase.
    // It must appear regardless of whether the ACCEPTANCE TESTED column is enabled.
    const prompt = buildKanbanBatchPrompt('reviewer', mockPlan, {});
    assert.ok(
        prompt.includes('GOAL VERDICT'),
        'Goal verdict must be present with no tester column — it is reviewer base text.'
    );
});

behaviouralTest('reviewer prompt has no triple newlines (normalisation)', () => {
    const prompt = buildKanbanBatchPrompt('reviewer', mockPlan, {});
    assert.ok(
        !prompt.includes('\n\n\n'),
        'Reviewer prompt must not contain 3+ consecutive newlines after adding the goal clause.'
    );
});

behaviouralTest('pinned strings still present in rendered reviewer prompt', () => {
    const prompt = buildKanbanBatchPrompt('reviewer', mockPlan, {});
    assert.ok(
        prompt.includes('assess the actual code changes against the plan requirements'),
        'Pinned string must be present in rendered prompt.'
    );
    assert.ok(
        prompt.includes('fix valid material issues, then verify.'),
        'Pinned string must be present in rendered prompt.'
    );
});

// ── Summary ─────────────────────────────────────────────────────────────────

if (failed > 0) {
    console.error(`\n${failed} test(s) failed.\n`);
    process.exit(1);
}
console.log(`\nAll goal-invariant verification tests passed (${passed} passed, ${failed} failed).\n`);
