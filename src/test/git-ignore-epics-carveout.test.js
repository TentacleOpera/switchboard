'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const excludeServiceSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'services', 'WorkspaceExcludeService.ts'),
        'utf8'
    );

    // Assert the features carve-out exists in TARGETED_RULES, after the plans carve-out
    // and before the sessions carve-out (order matters for gitignore negation rules).
    assert.ok(
        excludeServiceSource.includes("'!.switchboard/features/',"),
        'Expected TARGETED_RULES to include !.switchboard/features/ carve-out.'
    );

    // Assert ordering: features must come after plans and before sessions
    const plansIdx = excludeServiceSource.indexOf("'!.switchboard/plans/',");
    const featuresIdx = excludeServiceSource.indexOf("'!.switchboard/features/',");
    const sessionsIdx = excludeServiceSource.indexOf("'!.switchboard/sessions/',");
    assert.ok(plansIdx > -1 && featuresIdx > -1 && sessionsIdx > -1, 'All three carve-outs must exist.');
    assert.ok(plansIdx < featuresIdx && featuresIdx < sessionsIdx,
        'Expected order: plans/ → features/ → sessions/ in TARGETED_RULES.');

    console.log('git-ignore features carveout test passed');
}

try {
    run();
} catch (error) {
    console.error('git-ignore features carveout test failed:', error);
    process.exit(1);
}
