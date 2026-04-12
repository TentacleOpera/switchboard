'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const providerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const setupProviderPath = path.join(process.cwd(), 'src', 'services', 'SetupPanelProvider.ts');
    const setupPath = path.join(process.cwd(), 'src', 'webview', 'setup.html');

    const providerSource = fs.readFileSync(providerPath, 'utf8');
    const setupProviderSource = fs.readFileSync(setupProviderPath, 'utf8');
    const setupSource = fs.readFileSync(setupPath, 'utf8');

    assert.ok(
        setupSource.includes('id="plan-ingestion-folder-input"'),
        'Expected the setup panel to expose an additional plan ingestion folder input.'
    );
    assert.ok(
        setupSource.includes('planIngestionFolder,') && setupSource.includes('customAgents: lastCustomAgents'),
        'Expected saveStartupCommands payload to include the plan ingestion folder.'
    );
    assert.ok(
        setupSource.includes('lastPlanIngestionFolder = message.planIngestionFolder || \'\';'),
        'Expected startupCommands message handling to restore the persisted plan ingestion folder.'
    );

    assert.ok(
        providerSource.includes('public async getPlanIngestionFolder(workspaceRoot?: string): Promise<string>'),
        'Expected TaskViewerProvider to expose a setup-state reader for the plan ingestion folder.'
    );
    assert.ok(
        providerSource.includes("this._normalizeConfiguredPlanFolder(data.planIngestionFolder)") &&
        providerSource.includes('state.planIngestionFolder = normalizedPlanIngestionFolder;') &&
        providerSource.includes('delete state.planIngestionFolder;'),
        'Expected saveStartupCommands to normalize and persist the plan ingestion folder in state.json, clearing it when blank.'
    );
    assert.ok(
        providerSource.includes("this._setupPanelProvider.postMessage({ type: 'startupCommands', ...startupState });") &&
        setupProviderSource.includes("this._panel.webview.postMessage({ type: 'startupCommands', ...startupState });"),
        'Expected setup panel state loading to round-trip the plan ingestion folder back to the setup UI.'
    );
    assert.ok(
        providerSource.includes('private async _refreshConfiguredPlanWatcher(workspaceRoot?: string): Promise<void>'),
        'Expected a dedicated watcher refresh path for the configured plan ingestion folder.'
    );
    assert.ok(
        providerSource.includes("const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');"),
        'Expected the original Antigravity brain watcher to remain intact.'
    );
    assert.ok(
        providerSource.includes("private static readonly MANAGED_IMPORT_PREFIX = 'ingested_';"),
        'Expected managed imported plan mirrors to use a dedicated prefix.'
    );
    assert.ok(
        providerSource.includes('this._configuredPlanWatcher = vscode.workspace.createFileSystemWatcher(configuredPattern);') &&
        providerSource.includes('this._configuredPlanFsWatcher = fs.watch(configuredPlanFolder, { recursive: true }'),
        'Expected configured-folder ingestion to use both VS Code and fs.watch watchers.'
    );
    assert.ok(
        providerSource.includes('await this._refreshConfiguredPlanWatcher();'),
        'Expected saving the setup value to recreate the configured plan watcher immediately.'
    );
    assert.ok(
        providerSource.includes('if (cleanupMissingManagedImports) {') &&
        providerSource.includes('await this._removeManagedImportMirror(mirrorFilename, workspaceRoot);'),
        'Expected clearing/changing the configured folder to clean up stale managed imports.'
    );

    console.log('plan ingestion target regression test passed');
}

try {
    run();
} catch (error) {
    console.error('plan ingestion target regression test failed:', error);
    process.exit(1);
}
