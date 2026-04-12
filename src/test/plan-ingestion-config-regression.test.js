'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const providerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const webviewPath = path.join(process.cwd(), 'src', 'webview', 'setup.html');

    const providerSource = fs.readFileSync(providerPath, 'utf8');
    const webviewSource = fs.readFileSync(webviewPath, 'utf8');

    assert.match(
        webviewSource,
        /id="plan-ingestion-folder-input"/,
        'Expected setup UI to expose a plan ingestion folder field.'
    );
    assert.match(
        webviewSource,
        /const planIngestionFolder = document\.getElementById\('plan-ingestion-folder-input'\)\?\.value\.trim\(\) \|\| '';/,
        'Expected save handler to collect the configured plan ingestion folder.'
    );
    assert.match(
        webviewSource,
        /type: 'saveStartupCommands'[\s\S]*planIngestionFolder/,
        'Expected saveStartupCommands payload to include planIngestionFolder.'
    );
    assert.match(
        webviewSource,
        /lastPlanIngestionFolder = message\.planIngestionFolder \|\| '';/,
        'Expected startupCommands load path to restore the saved plan ingestion folder.'
    );

    assert.match(
        providerSource,
        /public async getPlanIngestionFolder\(workspaceRoot\?: string\): Promise<string> \{/,
        'Expected TaskViewerProvider to expose the persisted plan ingestion folder.'
    );
    assert.ok(
        providerSource.includes('this._normalizeConfiguredPlanFolder(data.planIngestionFolder)') &&
        providerSource.includes('_getConfiguredPlanFolderValidationError(normalizedPlanIngestionFolder)') &&
        providerSource.includes('state.planIngestionFolder = normalizedPlanIngestionFolder;') &&
        providerSource.includes('delete state.planIngestionFolder;'),
        'Expected saveStartupCommands to validate, persist, and clear the plan ingestion folder through state.json.'
    );
    assert.match(
        providerSource,
        /await this\._refreshConfiguredPlanWatcher\(\);/,
        'Expected plan-ingestion config changes to reinitialize the configured folder watcher.'
    );
    assert.ok(
        providerSource.includes('private _getManagedImportMirrorFilename(sourcePath: string): string {') &&
        providerSource.includes('private async _syncConfiguredPlanFolder(planFolder: string, workspaceRoot: string, cleanupMissingManagedImports: boolean = false): Promise<void> {') &&
        providerSource.includes('const mirrorFilename = this._getManagedImportMirrorFilename(filePath);') &&
        providerSource.includes('await this._handlePlanCreation(mirrorUri, workspaceRoot, true);'),
        'Expected configured folder ingestion to mirror into the existing .switchboard plan pipeline.'
    );
    assert.doesNotMatch(
        providerSource,
        /if \(!configuredPlanFolder \|\| !fs\.existsSync\(configuredPlanFolder\)\) \{[\s\S]*_syncConfiguredPlanFolder\('', resolvedWorkspaceRoot\)/,
        'Expected watcher refresh to stop watching old folders without purging previously ingested plans.'
    );

    console.log('plan ingestion config regression test passed');
}

try {
    run();
} catch (error) {
    console.error('plan ingestion config regression test failed:', error);
    process.exit(1);
}
