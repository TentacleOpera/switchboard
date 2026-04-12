'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const implementationPath = path.join(process.cwd(), 'src', 'webview', 'implementation.html');
    const implementationSource = fs.readFileSync(implementationPath, 'utf8');

    assert.doesNotMatch(
        implementationSource,
        /_onboardingRetryTimer\s*=\s*setTimeout\(\(\)\s*=>\s*renderAgentList\(\)/,
        'Expected Terminal Operations onboarding to stop scheduling periodic reopen retries.'
    );

    assert.match(
        implementationSource,
        /if \(elapsed < RECOVERY_THRESHOLD_MS\) \{[\s\S]*return; \/\/ keep current display unchanged during grace period[\s\S]*\}/,
        'Expected the startup grace-period guard to remain in place.'
    );

    assert.match(
        implementationSource,
        /let hasManuallyCollapsedThisSession = false;/,
        'Expected the in-memory manual-collapse guard to remain present.'
    );

    assert.match(
        implementationSource,
        /if \(!hasManuallyCollapsedThisSession\) \{[\s\S]*toFields\.classList\.add\('open'\)[\s\S]*getStartupCommands[\s\S]*getVisibleAgents[\s\S]*getCustomAgents[\s\S]*getJulesAutoSyncSetting/,
        'Expected the one-time Terminal Operations auto-open onboarding branch to remain intact.'
    );

    console.log('terminal operations no periodic reopen test passed');
}

try {
    run();
} catch (error) {
    console.error('terminal operations no periodic reopen test failed:', error);
    process.exit(1);
}
