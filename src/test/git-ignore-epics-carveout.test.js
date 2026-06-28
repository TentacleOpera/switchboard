'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const excludeServiceSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'services', 'WorkspaceExcludeService.ts'),
        'utf8'
    );

    // Assert the epics carve-out exists in TARGETED_RULES, after the plans carve-out
    // and before the sessions carve-out (order matters for gitignore negation rules).
    assert.ok(
        excludeServiceSource.includes("'!.switchboard/epics/',"),
        'Expected TARGETED_RULES to include !.switchboard/epics/ carve-out.'
    );

    // Assert ordering: epics must come after plans and before sessions
    const plansIdx = excludeServiceSource.indexOf("'!.switchboard/plans/',");
    const epicsIdx = excludeServiceSource.indexOf("'!.switchboard/epics/',");
    const sessionsIdx = excludeServiceSource.indexOf("'!.switchboard/sessions/',");
    assert.ok(plansIdx > -1 && epicsIdx > -1 && sessionsIdx > -1, 'All three carve-outs must exist.');
    assert.ok(plansIdx < epicsIdx && epicsIdx < sessionsIdx,
        'Expected order: plans/ → epics/ → sessions/ in TARGETED_RULES.');

    console.log('git-ignore epics carveout test passed');
}

try {
    run();
} catch (error) {
    console.error('git-ignore epics carveout test failed:', error);
    process.exit(1);
}
