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
        builderSource.includes('function buildReviewerExecutionModeLine(expectation: string): string'),
        'Expected shared reviewer execution mode helper.'
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
        builderSource.includes('Run verification checks (typecheck/tests as applicable) and include results.'),
        'Expected reviewer batch prompt to request per-plan review findings/results.'
    );

    assert.ok(
        builderSource.includes('When you output the adversarial critique (Grumpy and Balanced sections)'),
        'Expected reviewer prompt to include chat critique directive.'
    );

    console.log('autoban reviewer prompt regression test passed');
}

run().catch((error) => {
    console.error('autoban reviewer prompt regression test failed:', error);
    process.exit(1);
});
