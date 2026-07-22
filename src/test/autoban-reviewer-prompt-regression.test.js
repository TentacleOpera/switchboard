'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function run() {
    const builderPath = path.join(process.cwd(), 'src', 'services', 'agentPromptBuilder.ts');
    const builderSource = await fs.promises.readFile(builderPath, 'utf8');

    assert.ok(
        builderSource.includes('function buildReviewerExecutionIntro(planCount: number): string'),
        'Expected shared reviewer execution intro helper.'
    );
    assert.ok(
        builderSource.includes('The implementation for each of the following ${planCount} plans is complete. Execute a direct reviewer pass in-place for each plan.'),
        'Expected reviewer batch intro to describe implementation review rather than plan review.'
    );
    assert.ok(
        builderSource.includes('assess the actual code changes against the plan requirements'),
        'Expected reviewer batch prompt to anchor review against implementation/code and plan requirements.'
    );
    assert.ok(
        builderSource.includes('Run verification checks (typecheck/tests as applicable) and include results, unless specified otherwise in this prompt.'),
        'Expected reviewer batch prompt to request per-plan review findings/results.'
    );

    assert.ok(
        builderSource.includes('Stage 1 (Grumpy): adversarial findings'),
        'Expected reviewer prompt to include Grumpy adversarial critique instructions.'
    );

    // Prompt-content presence tests (not behavior tests) — guard against the
    // gate-wiring audit and skip-tests disclosure steps being silently dropped
    // from DEFAULT_REVIEWER_BASE_INSTRUCTIONS. These assert text presence in
    // the builder source, not that the reviewer actually acts on the steps.
    assert.ok(
        builderSource.includes('Gate-wiring audit: for every automated check named in the plan'),
        'Expected reviewer base instructions to include the gate-wiring audit step.'
    );
    assert.ok(
        builderSource.includes('verify it is actually invoked by CI'),
        'Expected gate-wiring audit step to require CI invocation verification.'
    );
    assert.ok(
        builderSource.includes('Skip-tests disclosure: if this prompt includes a SKIP TESTS or SKIP'),
        'Expected reviewer base instructions to include the skip-tests disclosure step.'
    );
    assert.ok(
        builderSource.includes('Verification was static-only'),
        'Expected skip-tests disclosure step to state the static-only constraint.'
    );

    console.log('autoban reviewer prompt regression test passed');
}

run().catch((error) => {
    console.error('autoban reviewer prompt regression test failed:', error);
    process.exit(1);
});
