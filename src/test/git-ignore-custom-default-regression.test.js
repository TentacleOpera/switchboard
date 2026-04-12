'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readSource(...segments) {
    return fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8');
}

function run() {
    const packageJson = JSON.parse(readSource('package.json'));
    const setupSource = readSource('src', 'webview', 'setup.html');
    const providerSource = readSource('src', 'services', 'TaskViewerProvider.ts');
    const excludeServiceSource = readSource('src', 'services', 'WorkspaceExcludeService.ts');
    const vscodeSettings = JSON.parse(readSource('.vscode', 'settings.json'));

    assert.strictEqual(
        packageJson.contributes.configuration.properties['switchboard.workspace.ignoreStrategy'].default,
        'targetedGitignore',
        'Expected switchboard.workspace.ignoreStrategy to keep targetedGitignore as the default strategy.'
    );

    assert.deepStrictEqual(
        packageJson.contributes.configuration.properties['switchboard.workspace.ignoreRules'].default,
        [],
        'Expected switchboard.workspace.ignoreRules to default to an empty array for fresh workspaces.'
    );

    assert.match(
        setupSource,
        /let lastGitIgnoreConfig = \{[\s\S]*strategy: 'targetedGitignore',[\s\S]*rules: \[\],[\s\S]*targetedRulesDisplay: ''[\s\S]*\};/m,
        'Expected setup.html to initialize editable git-ignore rules as empty.'
    );
    assert.match(
        setupSource,
        /const rules = Array\.isArray\(message\.rules\)[\s\S]*message\.rules\.map\(rule => String\(rule\)\.trim\(\)\)\.filter\(Boolean\)[\s\S]*: \[\];/m,
        'Expected setup.html hydration to fall back to an empty rules array when no saved rules exist.'
    );
    assert.ok(
        setupSource.includes('Cloud coders (e.g., Jules) require .switchboard/plans/ to be in the repository'),
        'Expected setup.html warning copy to explain the cloud-agent .switchboard/plans/ requirement.'
    );
    assert.ok(
        setupSource.includes('avoid blanket .switchboard/* rules'),
        'Expected setup.html warning copy to warn against blanket .switchboard/* exclusions.'
    );

    assert.match(
        providerSource,
        /config\.get<string\[]>\('ignoreRules', \[\]\)/,
        'Expected TaskViewerProvider to hydrate ignoreRules with an empty default array.'
    );

    assert.match(
        excludeServiceSource,
        /private static readonly DEFAULT_RULES: string\[] = \[\];/,
        'Expected WorkspaceExcludeService to use an empty default rules array.'
    );
    assert.match(
        excludeServiceSource,
        /config\.get\('ignoreRules', WorkspaceExcludeService\.DEFAULT_RULES\)/,
        'Expected WorkspaceExcludeService.apply() to continue sourcing editable rules from DEFAULT_RULES.'
    );

    assert.ok(
        !Object.prototype.hasOwnProperty.call(vscodeSettings, 'switchboard.workspace.ignoreStrategy'),
        'Expected .vscode/settings.json not to override the default git-ignore strategy.'
    );
    assert.ok(
        !Object.prototype.hasOwnProperty.call(vscodeSettings, 'switchboard.workspace.ignoreRules'),
        'Expected .vscode/settings.json not to seed shared ignoreRules overrides for fresh users.'
    );

    console.log('git-ignore custom default regression test passed');
}

try {
    run();
} catch (error) {
    console.error('git-ignore custom default regression test failed:', error);
    process.exit(1);
}
