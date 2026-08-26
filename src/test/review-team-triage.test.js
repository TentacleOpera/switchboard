/**
 * Contract: the Review team's shape and its standing orders.
 * (a-review-team-triages-then-fixes-what-it-reviewed.md)
 *
 * This flow is PROMPT-LEVEL orchestration, and that is deliberate. The lead
 * reads its head prompt, assigns plans to its reviewer seats over ptySendPrompt,
 * reads the reports back, triages them, and writes one artifact — all in
 * conversation. Team seats never receive a board-composed prompt (LocalApiServer
 * relays lead-authored text and never calls generateUnifiedPrompt), so there is
 * no seam where a deterministic assignment/triage/apportionment service could be
 * called.
 *
 * An earlier revision of this suite exercised exactly such a service
 * (src/services/reviewTriage.ts) by importing it directly. Every assertion
 * passed and nothing in either host imported the module — which made a green
 * gate report "triage implemented" when what was implemented was a paragraph.
 * The module and those assertions are deleted. Do NOT reintroduce them: if this
 * behaviour needs pinning, pin the PROMPT TEXT the lead actually reads, as the
 * head-prompt test below does.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    SEEDED_AGENT_GROUP,
    TEAM_QUEUE_DONE_ORDER_BODY,
    REVIEW_TEAM_QUEUE_DONE_ORDER_BODY,
    NEW_REVIEW_TEAM_HEAD_PROMPT,
    migrateAgentGroups,
} = require('../../out/services/teamWiring');
const { buildKanbanBatchPrompt } = require('../../out/services/agentPromptBuilder');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

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
    console.log('\n--- Running Review Team contract tests ---');

    // 1. The head prompt IS the implementation, so it is what gets pinned.
    test('the Review team head prompt carries the whole flow', () => {
        const p = NEW_REVIEW_TEAM_HEAD_PROMPT;
        assert.ok(/batches of up to two per reviewer/.test(p), 'assigns in batches of two');
        assert.ok(/review turn is read-only/.test(p), 'the review turn is read-only');
        assert.ok(/append\s+their findings to the plan files and report back/.test(p),
            'reviewers append findings and report to the lead');
        assert.ok(/\(1\) needs no fixing/.test(p) && /\(2\) fixes needed/.test(p)
            && /\(3\) follow-ups needed/.test(p) && /\(4\) did not meet intent/.test(p),
            'all four triage categories are named');
        assert.ok(/Apportion categories 2 and 3 back to the reviewer that reviewed them/.test(p),
            'fixes go back to the reviewer that formed the opinion');
        assert.ok(/Do not fix categories 1 or 4/.test(p), 'categories 1 and 4 are never fixed');
        assert.ok(/Write one markdown artifact to the plans folder/.test(p), 'one artifact, in the plans folder');
        assert.ok(/Never move a card backwards/.test(p), 'the card-movement rule is present');
    });

    // 2. The review-team order body exists AND is installed. A variant body that
    //    no call site selects is indistinguishable from no variant at all.
    test('the review-team queue-done order body exists and its call site selects it', () => {
        const standardOrder = TEAM_QUEUE_DONE_ORDER_BODY('team-coding');
        assert.ok(standardOrder.includes('context is preserved for review'),
            'the standard body preserves context for review');
        assert.ok(standardOrder.includes('POST /kanban/task/complete'),
            'the standard body names the acceptance POST');

        const reviewOrder = REVIEW_TEAM_QUEUE_DONE_ORDER_BODY('team-review');
        assert.ok(reviewOrder.includes('relay your completion report to your team lead and dispatch'),
            'the review-team body relays without the clear fragment');
        assert.notStrictEqual(reviewOrder, standardOrder, 'the two bodies must differ');

        // The wiring half. applyTeamQueueOrders has exactly one caller; if it
        // stops passing isReviewTeam, the variant is defined, tested and never
        // installed — which is how it shipped the first time.
        const server = fs.readFileSync(
            path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        assert.ok(/applyTeamQueueOrders\(\{[\s\S]{0,400}?isReviewTeam:/.test(server),
            'the applyTeamQueueOrders call site must pass isReviewTeam, or the review body is never installed');
    });

    // 3. A two-plan assignment is one batched dispatch, not two.
    test('a batch of two renders the multi-plan reviewer prompt', () => {
        const prompt = buildKanbanBatchPrompt('reviewer', [
            { planId: 'p1', title: 'Task 1', filePath: '.switchboard/plans/p1.md', absolutePath: '/path/to/p1.md' },
            { planId: 'p2', title: 'Task 2', filePath: '.switchboard/plans/p2.md', absolutePath: '/path/to/p2.md' }
        ], {});
        assert.ok(prompt.includes('each listed plan') || prompt.includes('For each plan'),
            'renders batch multi-plan phrasing');
        assert.ok(prompt.includes('p1') && prompt.includes('p2'), 'both plans present in the batch');
    });

    // 4. The release gate the old Coding-team migration exists to hold.
    test('SEEDED_AGENT_GROUP has no members, so no unrequested CLI spawns', () => {
        assert.strictEqual(SEEDED_AGENT_GROUP.headRole, 'lead');
        assert.ok(Array.isArray(SEEDED_AGENT_GROUP.members));
        assert.strictEqual(SEEDED_AGENT_GROUP.members.length, 0,
            'the seed must have 0 members so no unrequested CLIs spawn');
    });

    // 5. Structural repair survives; prompt-text migration is gone.
    // The frozen snapshots and their recognisers were deleted — spawned teams
    // have never shipped, so a persisted stale prompt is a clean break, not a
    // migration target. The member-shape repair must still fire.
    test('migrateAgentGroups repairs structure but never rewrites a persisted head prompt', () => {
        const persisted = {
            id: 'g-review',
            name: 'Review',
            headRole: 'reviewer',
            headPrompt: 'a stale persisted review head prompt',
            members: [{ role: 'reviewer', count: 3 }]
        };

        const migrated = migrateAgentGroups([persisted]);
        assert.ok(migrated, 'the structural member-shape repair must still fire');
        assert.strictEqual(migrated[0].headPrompt, persisted.headPrompt,
            'prompt text is never rewritten — the snapshots were deleted deliberately');
        assert.strictEqual(migrated[0].members[0].scope, 'per-team');
        assert.strictEqual(migrated[0].members[0].relationship, 'reports-to-head');
        assert.strictEqual(migrateAgentGroups(migrated), null, 'idempotent: a second pass returns null');
    });

    console.log(`\nReview team contract: ${passed} passed, ${failed} failed.\n`);
    if (failed > 0) {
        process.exit(1);
    }
}

runTests();
