'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readSource(...segments) {
    return fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8');
}

function run() {
    const excludeServiceSource = readSource('src', 'services', 'WorkspaceExcludeService.ts');
    const providerSource = readSource('src', 'services', 'TaskViewerProvider.ts');

    assert.match(
        excludeServiceSource,
        /public static normalizeStrategy\(rawStrategy: unknown\): 'targetedGitignore' \| 'localExclude' \| 'custom' \| 'none' \{[\s\S]*return 'targetedGitignore';[\s\S]*const strategy = WorkspaceExcludeService\.normalizeStrategy\([\s\S]*config\.get\('ignoreStrategy', 'targetedGitignore'\)/m,
        'Expected WorkspaceExcludeService.apply() to normalize legacy or invalid ignore strategies before writing managed blocks.'
    );

    assert.match(
        providerSource,
        /private _normalizeGitIgnoreConfig\([\s\S]*const strategy = WorkspaceExcludeService\.normalizeStrategy\(rawStrategy\);/m,
        'Expected TaskViewerProvider git-ignore normalization to share the same strategy mapping as WorkspaceExcludeService.'
    );

    console.log('workspace exclude strategy regression test passed');
}

try {
    run();
} catch (error) {
    console.error('workspace exclude strategy regression test failed:', error);
    process.exit(1);
}
