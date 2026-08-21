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

    // Pins the INVARIANT (registry state reaches the DB), not the writer's name.
    //
    // This assertion used to require the literal `await db.upsertPlans(records);`. An
    // auto-commit before code review (760c49c5, 2026-06-22, for an unrelated epic task)
    // swapped both sites to `insertFileDerivedPlan(record)`. Persistence still happens,
    // so the invariant held — but the assertion failed on the method name, and because
    // this file was wired to NEITHER ci NOR package.json, it sat red for two months and
    // nobody saw it. Pinning a call name turns a refactor into a false alarm and trains
    // people to ignore the gate; pinning the invariant catches persistence being removed.
    const savePlanRegistry = providerSource.slice(
        providerSource.indexOf('private async _savePlanRegistry(workspaceRoot: string): Promise<void> {')
    ).split('\n    private ')[0];
    assert.ok(savePlanRegistry.length > 0,
        'Expected TaskViewerProvider._savePlanRegistry to exist.');
    assert.match(
        savePlanRegistry,
        /await db\.(?:upsertPlans|insertFileDerivedPlan)\(/,
        'Expected TaskViewerProvider to persist plan registry state through the Kanban DB.'
    );

    // The compensating writer, pinned because it is what makes the above SAFE.
    //
    // Neither persistence writer can set status on an existing row: upsertPlans updates
    // it only on the deleted→active revival case, and insertFileDerivedPlan hardcodes
    // 'active'/'CREATED' on insert and omits both columns from its ON CONFLICT entirely.
    // So a registry save CANNOT carry a status transition, and archiving/completing a
    // plan depends on _updatePlanRegistryStatus writing it explicitly. If that explicit
    // write is ever dropped in favour of "the save will persist it", statuses silently
    // stop moving — with the board looking correct until a reload.
    assert.match(
        providerSource,
        /private async _updatePlanRegistryStatus\([\s\S]*?await db\.archivePlan\([\s\S]*?await db\.updateStatus\(/,
        'Expected _updatePlanRegistryStatus to write status EXPLICITLY (archivePlan/updateStatus) — the persistence writers cannot carry a status transition.'
    );

    // The load-bearing part is the RECURSIVE glob, not the name of the local holding the
    // root. This used to require the first argument to be spelled `workspaceRoot`; the
    // watcher now loops `for (const folder of safeFolders)` and passes `folder`, which is
    // the same root by another name — a false alarm that masked every assertion after it
    // in this file (assertions run in sequence and the first throw stops the rest).
    assert.match(
        providerSource,
        /new vscode\.RelativePattern\([A-Za-z_$][\w$]*, '\.switchboard\/plans\/\*\*\/\*\.md'\)/,
        'Expected _setupPlanWatcher to watch plans recursively (**/*.md) so one-level repo folders participate in refreshes.'
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
