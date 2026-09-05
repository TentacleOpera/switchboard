/**
 * Contract test: the remote command vocabulary is closed at two verbs.
 *
 * Asserts:
 * 1. The allowed verb list is exactly ['author_content', 'move_card'] — no
 *    free-text instruction verb exists.
 * 2. The review gate refuses a move to an execution column when the plan has
 *    not passed review, and allows it when it has.
 * 3. The gate fails closed when column configuration is missing.
 * 4. Widening the vocabulary (adding a third verb) would require changing
 *    ALLOWED_REMOTE_VERBS — this test asserts the exact length.
 *
 * See the-remote-command-vocabulary-is-closed.md.
 */

const assert = require('assert');
const {
    ALLOWED_REMOTE_VERBS,
    checkReviewGate,
    isExecutionColumn,
    isReviewedStage,
    formatDispatchReceipt,
    formatRefusalReceipt
} = require('../../dist/remote/RemoteCommandEnforcement');
const { DEFAULT_KANBAN_COLUMNS } = require('../../dist/agentConfig');

describe('Remote command vocabulary contract', () => {

    it('the vocabulary is closed at exactly two verbs', () => {
        assert.strictEqual(ALLOWED_REMOTE_VERBS.length, 2,
            'The remote command vocabulary must be exactly two verbs. ' +
            'A third verb turns a reviewed-plan pipeline into a remote shell. ' +
            'See the-remote-command-vocabulary-is-closed.md.'
        );
        assert.ok(ALLOWED_REMOTE_VERBS.includes('author_content'));
        assert.ok(ALLOWED_REMOTE_VERBS.includes('move_card'));
    });

    it('no verb carries free-text instructions', () => {
        for (const verb of ALLOWED_REMOTE_VERBS) {
            assert.ok(!verb.includes('instruction') && !verb.includes('command') && !verb.includes('exec'),
                `Verb '${verb}' must not carry instruction/command/exec semantics — ` +
                'a free-text instruction channel collapses authoring and triggering. ' +
                'See the-remote-command-vocabulary-is-closed.md.'
            );
        }
    });

    it('the review gate refuses execution dispatch without review', () => {
        const gate = checkReviewGate({
            targetColumn: 'LEAD CODED',
            sourceColumn: 'CREATED',
            columns: DEFAULT_KANBAN_COLUMNS,
            isRemote: true
        });
        assert.strictEqual(gate.allowed, false,
            'A plan moving from CREATED to LEAD CODED must be refused — it has not passed review.'
        );
        assert.ok(gate.refusalReason, 'A refusal must carry a reason.');
    });

    it('the review gate allows execution dispatch after review', () => {
        const gate = checkReviewGate({
            targetColumn: 'LEAD CODED',
            sourceColumn: 'PLAN REVIEWED',
            columns: DEFAULT_KANBAN_COLUMNS,
            isRemote: true
        });
        assert.strictEqual(gate.allowed, true,
            'A plan moving from PLAN REVIEWED to LEAD CODED must be allowed — it passed review.'
        );
    });

    it('the review gate allows non-execution moves without review', () => {
        const gate = checkReviewGate({
            targetColumn: 'PLAN REVIEWED',
            sourceColumn: 'CREATED',
            columns: DEFAULT_KANBAN_COLUMNS,
            isRemote: true
        });
        assert.strictEqual(gate.allowed, true,
            'A move to a non-execution column must be allowed regardless of review status.'
        );
    });

    it('the review gate fails closed when columns are missing', () => {
        const gate = checkReviewGate({
            targetColumn: 'LEAD CODED',
            sourceColumn: 'CREATED',
            columns: [],
            isRemote: true
        });
        assert.strictEqual(gate.allowed, false,
            'The gate must fail closed when column configuration is missing or unresolvable.'
        );
    });

    it('the review gate checks run history — a plan that was once reviewed passes', () => {
        const gate = checkReviewGate({
            targetColumn: 'CODER CODED',
            sourceColumn: 'CREATED',
            columns: DEFAULT_KANBAN_COLUMNS,
            runs: [{ column: 'PLAN REVIEWED' }, { column: 'CREATED' }],
            isRemote: true
        });
        assert.strictEqual(gate.allowed, true,
            'A plan that has ever been in a reviewed column must pass the gate.'
        );
    });

    it('isExecutionColumn identifies all coding columns', () => {
        assert.ok(isExecutionColumn('LEAD CODED', DEFAULT_KANBAN_COLUMNS));
        assert.ok(isExecutionColumn('CODER CODED', DEFAULT_KANBAN_COLUMNS));
        assert.ok(isExecutionColumn('INTERN CODED', DEFAULT_KANBAN_COLUMNS));
        assert.ok(!isExecutionColumn('CREATED', DEFAULT_KANBAN_COLUMNS));
        assert.ok(!isExecutionColumn('PLAN REVIEWED', DEFAULT_KANBAN_COLUMNS));
    });

    it('isReviewedStage identifies review columns', () => {
        assert.ok(isReviewedStage('PLAN REVIEWED', DEFAULT_KANBAN_COLUMNS));
        assert.ok(isReviewedStage('CODE REVIEWED', DEFAULT_KANBAN_COLUMNS));
        assert.ok(!isReviewedStage('CREATED', DEFAULT_KANBAN_COLUMNS));
        assert.ok(!isReviewedStage('LEAD CODED', DEFAULT_KANBAN_COLUMNS));
    });

    it('dispatch receipt names the plan and credential', () => {
        const receipt = formatDispatchReceipt('test-plan-id', 'linear', 'LEAD CODED');
        assert.ok(receipt.includes('test-plan-id'), 'Receipt must name the plan.');
        assert.ok(receipt.includes('linear'), 'Receipt must name the credential source.');
        assert.ok(receipt.includes('LEAD CODED'), 'Receipt must name the target column.');
    });

    it('refusal receipt names the plan, credential, and reason', () => {
        const refusal = formatRefusalReceipt('test-plan-id', 'linear', 'not reviewed');
        assert.ok(refusal.includes('test-plan-id'), 'Refusal must name the plan.');
        assert.ok(refusal.includes('linear'), 'Refusal must name the credential source.');
        assert.ok(refusal.includes('not reviewed'), 'Refusal must name the reason.');
        assert.ok(refusal.includes('REFUSED'), 'Refusal must be labelled as a refusal.');
    });
});
