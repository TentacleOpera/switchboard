'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function readSource(...segments) {
    return fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8');
}

function run() {
    const packageJson = JSON.parse(readSource('package.json'));
    const gitignoreSource = readSource('.gitignore');
    const setupSource = readSource('src', 'webview', 'setup.html');
    const providerSource = readSource('src', 'services', 'TaskViewerProvider.ts');
    const excludeServiceSource = readSource('src', 'services', 'WorkspaceExcludeService.ts');
    // `.vscode/settings.json` is deliberately UNTRACKED and gitignored: VS Code
    // writes it whenever a user changes a `scope: resource` setting through the
    // Settings UI, so a committed copy carries one machine's absolute paths to
    // every other clone (it was holding a `c:/Users/...` brain path on a macOS
    // checkout). It may still exist locally — read it if so, skip if not.
    const vscodeSettingsPath = path.join(process.cwd(), '.vscode', 'settings.json');
    const vscodeSettings = fs.existsSync(vscodeSettingsPath)
        ? JSON.parse(fs.readFileSync(vscodeSettingsPath, 'utf8'))
        : null;

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
        setupSource.includes('Cloud coders (e.g., Jules) require .switchboard/plans/ and .switchboard/features/ to be in the repository'),
        'Expected setup.html warning copy to explain the cloud-agent .switchboard/plans/ and .switchboard/features/ requirements.'
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
        !gitignoreSource.includes('!.switchboard/workspace-id'),
        'Expected .gitignore not to re-include the machine-local .switchboard/workspace-id file.'
    );
    assert.ok(
        !excludeServiceSource.includes("'!.switchboard/workspace-id'"),
        'Expected targeted managed gitignore rules not to re-add .switchboard/workspace-id.'
    );

    // The invariant that actually protects a fresh clone: the file is not TRACKED.
    // The two assertions below used to be the whole guard, and they were red —
    // the committed copy carried both keys. Untracking is the structural fix;
    // asserting absence from the index is what keeps it fixed.
    const tracked = execFileSync('git', ['ls-files', '--', '.vscode/settings.json'], {
        cwd: process.cwd(), encoding: 'utf8',
    }).trim();
    assert.strictEqual(tracked, '',
        'Expected .vscode/settings.json to be untracked — a committed copy carries one machine\'s absolute paths and seeds non-default config to every fresh clone.');

    // A local copy setting these keys is a legitimate developer preference and is
    // NOT a failure — that is the whole point of untracking the file. Warn only,
    // so the developer knows their own workspace is not exercising the default.
    if (vscodeSettings) {
        for (const key of ['switchboard.workspace.ignoreStrategy', 'switchboard.workspace.ignoreRules']) {
            if (Object.prototype.hasOwnProperty.call(vscodeSettings, key)) {
                console.warn(`  note: your local .vscode/settings.json sets ${key} — harmless for other clones now that the file is untracked, but your workspace is not exercising the default.`);
            }
        }
    }

    console.log('git-ignore custom default regression test passed');
}

try {
    run();
} catch (error) {
    console.error('git-ignore custom default regression test failed:', error);
    process.exit(1);
}
