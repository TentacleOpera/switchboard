'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const excludeServiceSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'services', 'WorkspaceExcludeService.ts'),
        'utf8'
    );

    // Assert the features carve-out exists in TARGETED_RULES, after the plans carve-out.
    assert.ok(
        excludeServiceSource.includes("'!.switchboard/features/',"),
        'Expected TARGETED_RULES to include !.switchboard/features/ carve-out.'
    );

    // Assert ordering: features must come after plans
    const plansIdx = excludeServiceSource.indexOf("'!.switchboard/plans/',");
    const featuresIdx = excludeServiceSource.indexOf("'!.switchboard/features/',");
    assert.ok(plansIdx > -1 && featuresIdx > -1, 'Both carve-outs must exist.');
    assert.ok(plansIdx < featuresIdx, 'Expected order: plans/ → features/ in TARGETED_RULES.');

    // Assert sessions carve-out is gone and control plane dirs are ignored
    assert.ok(!excludeServiceSource.includes("'!.switchboard/sessions/',"), 'sessions/ carve-out must be removed.');
    assert.ok(excludeServiceSource.includes("'.agents/',"), '.agents/ must be ignored.');
    assert.ok(excludeServiceSource.includes("'.claude/',"), '.claude/ must be ignored.');

    console.log('git-ignore features carveout test passed');
}

try {
    run();
} catch (error) {
    console.error('git-ignore features carveout test failed:', error);
    process.exit(1);
}
