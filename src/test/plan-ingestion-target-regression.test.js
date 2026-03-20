'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const providerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const implementationPath = path.join(process.cwd(), 'src', 'webview', 'implementation.html');

    const providerSource = fs.readFileSync(providerPath, 'utf8');
    const implementationSource = fs.readFileSync(implementationPath, 'utf8');

    assert.ok(
        implementationSource.includes('id="plan-ingestion-folder-input"'),
        'Expected the setup panel to expose an additional plan ingestion folder input.'
    );
    assert.ok(
        implementationSource.includes('planIngestionFolder, customAgents: lastCustomAgents'),
        'Expected saveStartupCommands payload to include the plan ingestion folder.'
    );
    assert.ok(
        implementationSource.includes('lastPlanIngestionFolder = message.planIngestionFolder || \'\';'),
        'Expected startupCommands message handling to restore the persisted plan ingestion folder.'
    );

    assert.ok(
        providerSource.includes('public async getPlanIngestionFolder(workspaceRoot?: string): Promise<string>'),
        'Expected TaskViewerProvider to expose a setup-state reader for the plan ingestion folder.'
    );
    assert.ok(
        providerSource.includes("const normalizedPlanIngestionFolder = this._normalizeConfiguredPlanFolder(data.planIngestionFolder);") &&
        providerSource.includes('state.planIngestionFolder = normalizedPlanIngestionFolder;') &&
        providerSource.includes('delete state.planIngestionFolder;'),
        'Expected saveStartupCommands to normalize and persist the plan ingestion folder in state.json, clearing it when blank.'
    );
    assert.ok(
        providerSource.includes("this._view?.webview.postMessage({ type: 'startupCommands', commands: cmds, planIngestionFolder });"),
        'Expected getStartupCommands/ready handling to round-trip the plan ingestion folder back to the setup UI.'
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
        providerSource.includes('file.startsWith(TaskViewerProvider.MANAGED_IMPORT_PREFIX)') &&
        providerSource.includes('await this._removeManagedImportMirror(file, workspaceRoot);'),
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
