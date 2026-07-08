'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function run() {
    const providerPath = path.join(process.cwd(), 'src', 'services', 'PlanningPanelProvider.ts');
    const providerSource = await fs.promises.readFile(providerPath, 'utf8');

    // 1. Verify field declaration
    assert.ok(
        providerSource.includes('private _projectPanelOpening: Promise<void> | undefined;'),
        'PlanningPanelProvider should declare _projectPanelOpening field'
    );

    // 2. Verify _projectPanelOpening guard in openProject
    assert.ok(
        providerSource.includes('if (this._projectPanelOpening) {'),
        'openProject should check _projectPanelOpening lock'
    );
    assert.ok(
        providerSource.includes('await this._projectPanelOpening;'),
        'openProject should await in-flight _projectPanelOpening'
    );

    // 3. Verify three locations setting it to undefined on dispose
    // We count the occurrences of setting both _projectPanel = undefined AND _projectPanelOpening = undefined
    const searchString1 = 'this._projectPanel = undefined;\n                this._projectPanelReady = false;\n                this._projectPanelOpening = undefined;';
    const searchString2 = 'this._projectPanel = undefined;\n                    this._projectPanelReady = false;\n                    this._projectPanelOpening = undefined;';

    // Count how many times these patterns appear.
    // Clean up windows line endings if any.
    const normalizedSource = providerSource.replace(/\r\n/g, '\n');

    let occurrences1 = 0;
    let pos = 0;
    while ((pos = normalizedSource.indexOf(searchString1, pos)) !== -1) {
        occurrences1++;
        pos += searchString1.length;
    }

    let occurrences2 = 0;
    pos = 0;
    while ((pos = normalizedSource.indexOf(searchString2, pos)) !== -1) {
        occurrences2++;
        pos += searchString2.length;
    }

    const totalOccurrences = occurrences1 + occurrences2;
    assert.strictEqual(
        totalOccurrences,
        3,
        `Expected exactly 3 locations clearing _projectPanelOpening on dispose, found ${totalOccurrences}`
    );

    console.log('project panel opening lock test passed');
}

run().catch((error) => {
    console.error('project panel opening lock test failed:', error);
    process.exit(1);
});
