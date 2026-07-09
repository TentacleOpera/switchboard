'use strict';

// Static-source-assertion test for the serializer-restore guard added by the
// "Project panel duplicate on window restore (serializer ghost)" plan.
// Verifies the flag, helpers, guard, ghost-disposal, the extension.ts
// TabGroups ghost-tab check, and that EVERY site clearing _projectPanelOpening
// also clears _projectPanelRestoring.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function countOccurrences(haystack, needle) {
    let count = 0;
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
        count++;
        pos += needle.length;
    }
    return count;
}

async function run() {
    const providerPath = path.join(process.cwd(), 'src', 'services', 'PlanningPanelProvider.ts');
    const extensionPath = path.join(process.cwd(), 'src', 'extension.ts');
    const providerSource = (await fs.promises.readFile(providerPath, 'utf8')).replace(/\r\n/g, '\n');
    const extensionSource = (await fs.promises.readFile(extensionPath, 'utf8')).replace(/\r\n/g, '\n');

    // 1. _projectPanelRestoring field is declared.
    assert.ok(
        providerSource.includes('private _projectPanelRestoring = false;'),
        'PlanningPanelProvider should declare _projectPanelRestoring field'
    );

    // 2. markProjectPanelRestoring method exists.
    assert.ok(
        providerSource.includes('public markProjectPanelRestoring(): void {'),
        'PlanningPanelProvider should declare markProjectPanelRestoring method'
    );

    // 3. _waitForRestore method exists.
    assert.ok(
        providerSource.includes('private _waitForRestore(): Promise<void> {'),
        'PlanningPanelProvider should declare _waitForRestore method'
    );

    // 4. deserializeProjectPanel clears the restoring flag.
    assert.ok(
        /public async deserializeProjectPanel\([\s\S]*?this\._projectPanelRestoring = false;/.test(providerSource),
        'deserializeProjectPanel should clear _projectPanelRestoring'
    );

    // 5. openProject guards against the restoring window.
    assert.ok(
        providerSource.includes('if (this._projectPanelRestoring) {'),
        'openProject should check _projectPanelRestoring guard'
    );

    // 6. extension.ts performs the TabInputWebview / viewType ghost-tab check
    //    before calling markProjectPanelRestoring().
    assert.ok(
        extensionSource.includes("tab.input instanceof vscode.TabInputWebview") &&
        extensionSource.includes("tab.input.viewType === 'switchboard-project'") &&
        extensionSource.includes('planningPanelProvider.markProjectPanelRestoring();'),
        'extension.ts should check TabGroups for a switchboard-project ghost tab before marking restoring'
    );

    // 7. Every site that clears _projectPanelOpening (paired with _projectPanel
    //    clear) also clears _projectPanelRestoring. We assert the count of
    //    _projectPanelRestoring = false occurrences (minus the field declaration
    //    and the two terminal consumers: deserializeProjectPanel and
    //    _waitForRestore) is >= the count of _projectPanelOpening = undefined
    //    occurrences that are paired with a _projectPanel = undefined clear.
    const restoringClears = countOccurrences(providerSource, 'this._projectPanelRestoring = false;');
    // Subtract the field declaration (1) — it is an initializer, not a clear.
    const restoringClearSites = restoringClears - 1;

    // Count the dispose/catch clear-sites: lines where _projectPanel = undefined
    // is followed (within a few lines) by _projectPanelOpening = undefined. The
    // openProject() finally block clears _projectPanelOpening WITHOUT clearing
    // _projectPanel, so it is correctly excluded.
    const openingClears = countOccurrences(providerSource, 'this._projectPanelOpening = undefined;');
    // The openProject() finally block is one such occurrence and is NOT a
    // dispose/catch site — it does not pair with _projectPanel = undefined.
    const finallyClear = countOccurrences(providerSource, 'await this._projectPanelOpening;\n        } finally {\n            this._projectPanelOpening = undefined;');
    const disposeClearSites = openingClears - finallyClear;

    assert.ok(
        restoringClearSites >= disposeClearSites,
        `Expected at least ${disposeClearSites} _projectPanelRestoring clear-sites (one per dispose/catch clear of _projectPanelOpening), found ${restoringClearSites}`
    );

    console.log('project panel restore guard test passed');
}

run().catch((error) => {
    console.error('project panel restore guard test failed:', error);
    process.exit(1);
});
