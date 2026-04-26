'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function extractArrayBlock(source, arrayName) {
    const match = source.match(new RegExp(`const ${arrayName} = \\[([\\s\\S]*?)\\];`));
    return match ? match[1] : '';
}

function run() {
    const setupPath = path.join(process.cwd(), 'src', 'webview', 'setup.html');
    const setupProviderPath = path.join(process.cwd(), 'src', 'services', 'SetupPanelProvider.ts');
    const packagePath = path.join(process.cwd(), 'package.json');

    const setupSource = fs.readFileSync(setupPath, 'utf8');
    const setupProviderSource = fs.readFileSync(setupProviderPath, 'utf8');
    const packageSource = fs.readFileSync(packagePath, 'utf8');

    assert.ok(
        setupSource.includes('Control Plane Setup') &&
        setupSource.includes('id="btn-control-plane-mode-fresh"') &&
        !setupSource.includes('id="multi-repo-toggle"') &&
        setupSource.includes('id="multi-repo-parent-dir"') &&
        setupSource.includes('id="multi-repo-workspace-name"') &&
        setupSource.includes('id="multi-repo-repo-urls"') &&
        setupSource.includes('id="multi-repo-pat"') &&
        setupSource.includes('id="btn-scaffold-multi-repo"') &&
        setupSource.includes('id="multi-repo-scaffold-status"'),
        'Expected setup.html to keep the scaffold inputs inside the merged Control Plane Setup fresh-setup pane.'
    );
    assert.ok(
        setupSource.includes("type: 'scaffoldMultiRepo'") &&
        setupSource.includes("case 'multiRepoScaffoldResult'") &&
        setupSource.includes("message.section === 'control-plane:fresh-setup'") &&
        setupSource.includes("message.section === 'multi-repo-control-plane'"),
        'Expected setup.html to send scaffoldMultiRepo and keep both merged and legacy open-section routes working.'
    );

    const instantAutosaveBlock = extractArrayBlock(setupSource, 'instantAutosaveSelectors');
    const textAutosaveBlock = extractArrayBlock(setupSource, 'textAutosaveSelectors');
    assert.ok(setupSource.includes('id="multi-repo-pat"'), 'Expected the transient PAT input to exist.');
    assert.doesNotMatch(
        instantAutosaveBlock,
        /multi-repo-(parent-dir|workspace-name|repo-urls|pat)/,
        'Expected Multi-Repo scaffold controls to stay out of instant autosave selectors.'
    );
    assert.doesNotMatch(
        textAutosaveBlock,
        /multi-repo-(parent-dir|workspace-name|repo-urls|pat)/,
        'Expected Multi-Repo scaffold controls to stay out of text autosave selectors.'
    );

    assert.match(
        setupProviderSource,
        /case 'scaffoldMultiRepo': \{[\s\S]*type: 'multiRepoScaffoldResult'/m,
        'Expected SetupPanelProvider to route scaffoldMultiRepo and always post a multiRepoScaffoldResult payload.'
    );

    assert.ok(
        packageSource.includes('"command": "switchboard.scaffoldMultiRepo"') &&
        packageSource.includes('"title": "Multi-Repo: Scaffold Control Plane"'),
        'Expected package.json to contribute the Multi-Repo Control Plane command.'
    );

    console.log('multi-repo scaffolding regression test passed');
}

try {
    run();
} catch (error) {
    console.error('multi-repo scaffolding regression test failed:', error);
    process.exit(1);
}
