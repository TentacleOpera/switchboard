'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
    const extensionPath = path.join(__dirname, '..', 'extension.ts');
    const readmePath = path.join(__dirname, '..', '..', '.switchboard', 'README.md');

    const providerSource = fs.readFileSync(providerPath, 'utf8');
    const extensionSource = fs.readFileSync(extensionPath, 'utf8');
    const readmeSource = fs.readFileSync(readmePath, 'utf8');

    assert.match(
        providerSource,
        /private async _reconcileLocalPlansFromRunSheets\(workspaceRoot: string\)[\s\S]*sheet\.planFile[\s\S]*sourceType: 'local'[\s\S]*status: 'active'/,
        'Expected TaskViewerProvider to reconcile active local plans from run sheets into the registry.'
    );
    assert.match(
        providerSource,
        /_collectAndSyncKanbanSnapshot\(workspaceRoot: string, archiveMissing: boolean = true\)[\s\S]*_reconcileLocalPlansFromRunSheets\(workspaceRoot\)/,
        'Expected the DB snapshot refresh path to invoke local plan reconciliation before filtering visible sheets.'
    );

    assert.match(
        providerSource,
        /private async _savePlanRegistry\(workspaceRoot: string\): Promise<void> \{[\s\S]*await db\.upsertPlans\(records\);/,
        'Expected TaskViewerProvider to persist plan registry state through the Kanban DB.'
    );

    assert.match(
        providerSource,
        /new vscode\.RelativePattern\(workspaceRoot, '\.switchboard\/plans\/\*\*\/\*\.md'\)/,
        'Expected _setupPlanWatcher to watch plans recursively so one-level repo folders participate in refreshes.'
    );
    assert.match(
        providerSource,
        /private async _listSupportedLocalPlanPaths\(plansDir: string\): Promise<string\[]>\s*\{[\s\S]*readdir\(plansDir, \{ withFileTypes: true \}\)[\s\S]*entry\.isDirectory\(\)[\s\S]*path\.join\(repoDir, childEntry\.name\)/,
        'Expected on-disk local plan reconciliation to enumerate immediate child directories under .switchboard/plans/.'
    );
    assert.match(
        providerSource,
        /private async _listSupportedLocalPlanPaths\(plansDir: string\): Promise<string\[]>\s*\{[\s\S]*if \(\/\^brain_\[0-9a-f\]\{64\}\\\.md\$\/i\.test\(childEntry\.name\)\) continue;[\s\S]*if \(\/\^ingested_\[0-9a-f\]\{64\}\\\.md\$\/i\.test\(childEntry\.name\)\) continue;/,
        'Expected repo-folder local-plan reconciliation to ignore brain_/ingested_ runtime mirrors.'
    );

    assert.match(
        extensionSource,
        /const collectLegacyFiles = async \(dir: string\): Promise<string\[]> => \{[\s\S]*entry\.isDirectory\(\)[\s\S]*collectLegacyFiles\(fullPath\)/,
        'Expected migrateLegacyPlans to recursively collect files from legacy plan subdirectories.'
    );
    assert.match(
        extensionSource,
        /const legacyDirs = \[[\s\S]*'features'[\s\S]*'antigravity_plans'[\s\S]*\];/,
        'Expected migrateLegacyPlans to stay narrowly scoped to the legacy features/ and antigravity_plans/ folders.'
    );
    assert.match(
        extensionSource,
        /Repo-scoped control-plane folders under[\s\S]*must not be flattened here\./,
        'Expected migrateLegacyPlans documentation to preserve repo-scoped control-plane folders.'
    );

    assert.match(
        readmeSource,
        /\| `plans\/` \| Top-level plan directory tracked by the sidebar; control-plane migrations may add one immediate repo-name sub-folder layer under `plans\/`; deeper nesting is not used \|/,
        'Expected .switchboard README to document the top-level-plus-one-repo-folder plan layout.'
    );
    assert.doesNotMatch(
        readmeSource,
        /\| `plans\/` \| Flat plan directory tracked by the sidebar; legacy subfolders are not used \|/,
        'Expected .switchboard README not to claim the plans directory is flat-only anymore.'
    );

    console.log('plan registry reconciliation test passed');
}

try {
    run();
} catch (error) {
    console.error('plan registry reconciliation test failed:', error);
    process.exit(1);
}
