'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const providerSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'),
        'utf8'
    );

    assert.match(
        providerSource,
        /public refresh\(\) \{[\s\S]*this\._refreshConfigurationState\(undefined,\s*false\)/s,
        'Expected passive refresh() calls to skip setup-panel hydration.'
    );
    assert.match(
        providerSource,
        /private async _refreshConfigurationState\(workspaceRoot\?: string,\s*includeSetupPanel: boolean = true\): Promise<void> \{[\s\S]*const tasks: Promise<void>\[\] = \[this\._postSidebarConfigurationState\(workspaceRoot\)\];[\s\S]*if \(includeSetupPanel\) \{[\s\S]*tasks\.push\(this\.postSetupPanelState\(workspaceRoot\)\);[\s\S]*\}[\s\S]*await Promise\.all\(tasks\);[\s\S]*\}/s,
        'Expected setup refresh helper to gate setup-panel hydration behind an includeSetupPanel flag.'
    );
    assert.match(
        providerSource,
        /await Promise\.all\(\[[\s\S]*this\._postSidebarConfigurationState\((?:activeWorkspaceRoot|resolvedWorkspaceRoot|resolvedRoot)\),[\s\S]*this\.postSetupPanelState\((?:activeWorkspaceRoot|resolvedWorkspaceRoot|resolvedRoot)\)[\s\S]*\]\);/s,
        'Expected explicit save rebroadcasts to continue posting refreshed setup state.'
    );

    console.log('setup panel refresh regression test passed');
}

try {
    run();
} catch (error) {
    console.error('setup panel refresh regression test failed:', error);
    process.exit(1);
}
