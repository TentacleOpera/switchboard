/**
 * Test suite for Review Team Triage and Apportionment
 * Verifies the 9 goal invariants and behaviors defined in
 * .switchboard/plans/a-review-team-triages-then-fixes-what-it-reviewed.md
 */

const assert = require('assert');
const {
    assignPlansToReviewers,
    triageReviewReports,
    apportionFixes,
    generateReviewLeadArtifact,
    ReviewTriageCategory,
} = require('../../out/services/reviewTriage');
const {
    SEEDED_AGENT_GROUP,
    OFFERED_REVIEW_TEAM_GROUP,
    OFFERED_TEAM_DEFINITIONS,
    TEAM_QUEUE_DONE_ORDER_BODY,
    REVIEW_TEAM_QUEUE_DONE_ORDER_BODY,
    NEW_REVIEW_TEAM_HEAD_PROMPT,
    PRE_TRIAGE_REVIEW_HEAD_PROMPT,
    migrateAgentGroups,
} = require('../../out/services/teamWiring');
const { buildKanbanBatchPrompt } = require('../../out/services/agentPromptBuilder');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL: ${name}`);
        console.error(err);
        failed++;
    }
}

async function runTests() {
    console.log('\n--- Running Review Team Triage Invariant Tests ---');

    // 1. The review turn cannot write
    test('Invariant 1: The review turn cannot write and git policy prohibits code commits', () => {
        const prompt = buildKanbanBatchPrompt({
            role: 'reviewer',
            plans: [{ planId: 'subtask-1', title: 'Task 1', filePath: '.switchboard/plans/p1.md', absolutePath: '/path/to/p1.md' }],
            options: {
                readOnlyReview: true,
                gitCommitStrategy: 'whenDone'
            }
        });
        assert.ok(prompt.includes('READ-ONLY REVIEW TURN'), 'Prompt must indicate read-only review turn');
        assert.ok(prompt.includes('Do NOT fix code during the review turn'), 'Prompt must instruct not to fix code');
        assert.ok(prompt.includes('Do not commit'), 'Git policy must prohibit code commits during read-only review turn');
    });

    // 2. Context survives the report (clear-on-done omitted for review teams)
    test('Invariant 2: Review team standing orders omit the clear-on-done fragment', () => {
        const standardOrder = TEAM_QUEUE_DONE_ORDER_BODY('team-coding');
        assert.ok(standardOrder.includes('clear your terminal, '), 'Standard team queue done order includes clear fragment');

        const reviewTeamOrder = REVIEW_TEAM_QUEUE_DONE_ORDER_BODY('team-review');
        assert.ok(!reviewTeamOrder.includes('clear your terminal, '), 'Review team queue done order omits clear fragment');
        assert.ok(reviewTeamOrder.includes('relay your completion report to your team lead and dispatch'), 'Review team order preserves context relay');
    });

    // 3. Coverage without duplication (8 plans across 6 seats)
    test('Invariant 3: Coverage without duplication across seats', () => {
        const planIds = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
        const seats = ['rev-1', 'rev-2', 'rev-3', 'rev-4', 'rev-5', 'rev-6'];

        const assignments = assignPlansToReviewers(planIds, seats, 2);
        assert.ok(assignments.length > 0, 'Assignments generated');

        const assignedPlans = [];
        for (const a of assignments) {
            assert.ok(a.planIds.length <= 2, `Reviewer ${a.reviewer} received more than 2 plans: ${a.planIds.length}`);
            assignedPlans.push(...a.planIds);
        }

        assert.strictEqual(assignedPlans.length, 8, 'All 8 plans assigned');
        assert.strictEqual(new Set(assignedPlans).size, 8, 'Every plan assigned exactly once (no duplicates)');
    });

    // 4. Batch of two, not two dispatches
    test('Invariant 4: Batch of two renders multi-plan reviewer prompt', () => {
        const prompt = buildKanbanBatchPrompt({
            role: 'reviewer',
            plans: [
                { planId: 'p1', title: 'Task 1', filePath: '.switchboard/plans/p1.md', absolutePath: '/path/to/p1.md' },
                { planId: 'p2', title: 'Task 2', filePath: '.switchboard/plans/p2.md', absolutePath: '/path/to/p2.md' }
            ],
            options: {
                readOnlyReview: true
            }
        });
        assert.ok(prompt.includes('each listed plan') || prompt.includes('For each plan'), 'Renders batch multi-plan phrasing');
        assert.ok(prompt.includes('p1') && prompt.includes('p2'), 'Both plans present in batch');
    });

    // 5. Fixes land with original reviewer
    test('Invariant 5: Category 2 fixes land with originating reviewer', () => {
        const reports = [
            { planId: 'p1', reviewer: 'rev-1', category: ReviewTriageCategory.NEEDS_NO_FIXING },
            { planId: 'p2', reviewer: 'rev-2', category: ReviewTriageCategory.FIXES_NEEDED, files: ['src/a.ts'] },
            { planId: 'p3', reviewer: 'rev-3', category: ReviewTriageCategory.FOLLOW_UPS_NEEDED, files: ['src/b.ts'] },
            { planId: 'p4', reviewer: 'rev-4', category: ReviewTriageCategory.DID_NOT_MEET_INTENT },
        ];

        const waves = apportionFixes(reports);
        assert.ok(waves.length > 0, 'Fix waves generated');

        const allTasks = waves.flat();
        const p2Task = allTasks.find(t => t.planId === 'p2');
        assert.ok(p2Task, 'p2 task present in fixes');
        assert.strictEqual(p2Task.reviewer, 'rev-2', 'p2 fix must be assigned to rev-2');

        const p3Task = allTasks.find(t => t.planId === 'p3');
        assert.ok(p3Task, 'p3 task present in fixes');
        assert.strictEqual(p3Task.reviewer, 'rev-3', 'p3 fix must be assigned to rev-3');
    });

    // 6. Concurrent fixes are file-disjoint
    test('Invariant 6: Concurrent fixes touching same file are split into separate waves', () => {
        const reports = [
            { planId: 'p1', reviewer: 'rev-1', category: ReviewTriageCategory.FIXES_NEEDED, files: ['src/shared.ts', 'src/a.ts'] },
            { planId: 'p2', reviewer: 'rev-2', category: ReviewTriageCategory.FIXES_NEEDED, files: ['src/shared.ts', 'src/b.ts'] },
            { planId: 'p3', reviewer: 'rev-3', category: ReviewTriageCategory.FIXES_NEEDED, files: ['src/c.ts'] },
        ];

        const waves = apportionFixes(reports);
        assert.strictEqual(waves.length, 2, 'Must split into 2 waves because p1 and p2 touch src/shared.ts');

        // Wave 1 contains p1 and p3 (disjoint)
        const wave1PlanIds = waves[0].map(t => t.planId);
        const wave2PlanIds = waves[1].map(t => t.planId);
        assert.ok(wave1PlanIds.includes('p1') || wave1PlanIds.includes('p2'), 'One of conflicting tasks in wave 1');
        assert.ok(wave2PlanIds.includes('p1') || wave2PlanIds.includes('p2'), 'Other conflicting task in wave 2');
    });

    // 7. Intent failures are not fixed and not reopened
    test('Invariant 7: Intent failures (Category 4) and Category 1 are never fixed', () => {
        const reports = [
            { planId: 'p1', reviewer: 'rev-1', category: ReviewTriageCategory.NEEDS_NO_FIXING },
            { planId: 'p4', reviewer: 'rev-4', category: ReviewTriageCategory.DID_NOT_MEET_INTENT, intentNotes: 'Goal violated' },
        ];

        const waves = apportionFixes(reports);
        assert.strictEqual(waves.length, 0, 'No fix tasks generated for categories 1 and 4');
    });

    // 8. One artifact with correct contents
    test('Invariant 8: Single lead artifact carries deferred items, remaining risks, and intent failures', () => {
        const reports = [
            {
                planId: 'p1',
                reviewer: 'rev-1',
                category: ReviewTriageCategory.NEEDS_NO_FIXING
            },
            {
                planId: 'p2',
                reviewer: 'rev-2',
                category: ReviewTriageCategory.FIXES_NEEDED,
                files: ['src/p2.ts']
            },
            {
                planId: 'p3',
                reviewer: 'rev-3',
                category: ReviewTriageCategory.FOLLOW_UPS_NEEDED,
                deferredItems: ['Add benchmark test for large payloads'],
                remainingRisks: ['Lock contention under high load']
            },
            {
                planId: 'p4',
                reviewer: 'rev-4',
                category: ReviewTriageCategory.DID_NOT_MEET_INTENT,
                intentNotes: 'Implementation changed destination without author consent'
            }
        ];

        const artifact = generateReviewLeadArtifact({
            featureId: 'feat-123',
            featureTitle: 'Example Feature',
            reports
        });

        assert.ok(artifact.includes('# Review Findings & Deferred Risks: Example Feature'), 'Artifact has title');
        assert.ok(artifact.includes('## Deferred Items & Follow-ups'), 'Artifact has deferred items section');
        assert.ok(artifact.includes('Add benchmark test for large payloads'), 'Deferred item included');
        assert.ok(artifact.includes('## Remaining Risks'), 'Artifact has remaining risks section');
        assert.ok(artifact.includes('Lock contention under high load'), 'Remaining risk included');
        assert.ok(artifact.includes('## Intent Failures (Remediation Requires New Plan)'), 'Artifact has intent failures section');
        assert.ok(artifact.includes('Implementation changed destination without author consent'), 'Intent notes included');
    });

    // 9. No team seed spawns a CLI & Review team is offered
    test('Invariant 9: SEEDED_AGENT_GROUP has no members and OFFERED_REVIEW_TEAM_GROUP is offered with no members', () => {
        assert.strictEqual(SEEDED_AGENT_GROUP.headRole, 'lead');
        assert.ok(Array.isArray(SEEDED_AGENT_GROUP.members));
        assert.strictEqual(SEEDED_AGENT_GROUP.members.length, 0, 'Seed must have 0 members so no unrequested CLIs spawn');

        assert.strictEqual(OFFERED_REVIEW_TEAM_GROUP.headRole, 'reviewer');
        assert.ok(Array.isArray(OFFERED_REVIEW_TEAM_GROUP.members));
        assert.strictEqual(OFFERED_REVIEW_TEAM_GROUP.members.length, 0, 'Offered review team must have 0 members');
        assert.strictEqual(OFFERED_REVIEW_TEAM_GROUP.headPrompt, NEW_REVIEW_TEAM_HEAD_PROMPT);
        assert.ok(OFFERED_TEAM_DEFINITIONS.includes(OFFERED_REVIEW_TEAM_GROUP), 'OFFERED_REVIEW_TEAM_GROUP must be in OFFERED_TEAM_DEFINITIONS');
    });

    // 10. Pre-triage Review team headPrompt migration
    test('Invariant 10: migrateAgentGroups converts pre-triage Review team to NEW_REVIEW_TEAM_HEAD_PROMPT', () => {
        const preTriageGroup = {
            id: 'g-review',
            name: 'Review',
            headRole: 'reviewer',
            headPrompt: PRE_TRIAGE_REVIEW_HEAD_PROMPT,
            members: [{ role: 'reviewer', count: 3, scope: 'per-team', relationship: 'reports-to-head' }]
        };

        const migrated = migrateAgentGroups([preTriageGroup]);
        assert.ok(migrated, 'Must migrate pre-triage Review team');
        assert.strictEqual(migrated[0].headPrompt, NEW_REVIEW_TEAM_HEAD_PROMPT, 'Head prompt updated to NEW_REVIEW_TEAM_HEAD_PROMPT');
        assert.strictEqual(migrateAgentGroups(migrated), null, 'Idempotent: second pass returns null');
    });

    console.log(`\nReview Team Triage Tests: ${passed} passed, ${failed} failed.\n`);
    if (failed > 0) {
        process.exit(1);
    }
}

runTests();
