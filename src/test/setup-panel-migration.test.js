'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const implementationPath = path.join(process.cwd(), 'src', 'webview', 'implementation.html');
    const setupPath = path.join(process.cwd(), 'src', 'webview', 'setup.html');
    const providerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const setupProviderPath = path.join(process.cwd(), 'src', 'services', 'SetupPanelProvider.ts');
    const extensionPath = path.join(process.cwd(), 'src', 'extension.ts');
    const packagePath = path.join(process.cwd(), 'package.json');

    const implementationSource = fs.readFileSync(implementationPath, 'utf8');
    const setupSource = fs.readFileSync(setupPath, 'utf8');
    const providerSource = fs.readFileSync(providerPath, 'utf8');
    const setupProviderSource = fs.readFileSync(setupProviderPath, 'utf8');
    const extensionSource = fs.readFileSync(extensionPath, 'utf8');
    const packageSource = fs.readFileSync(packagePath, 'utf8');

    assert.ok(
        implementationSource.includes('id="terminal-operations-fields"') &&
        implementationSource.includes('id="btn-open-central-setup"'),
        'Expected the sidebar to keep terminal operations and expose an Open Setup button.'
    );
    assert.ok(
        !implementationSource.includes('id="custom-agent-list"') &&
        !implementationSource.includes('id="startup-fields"') &&
        !implementationSource.includes('id="db-sync-fields"'),
        'Expected steady-state configuration UI to stay out of the sidebar implementation view.'
    );

    assert.ok(
        setupSource.includes('Control Plane Setup') &&
        setupSource.includes('id="control-plane-fields"') &&
        setupSource.includes('id="btn-control-plane-mode-migrate"') &&
        setupSource.includes('id="btn-control-plane-mode-fresh"') &&
        setupSource.includes('id="btn-detect-control-plane"') &&
        setupSource.includes('id="btn-preview-control-plane"') &&
        setupSource.includes('id="btn-execute-control-plane"') &&
        setupSource.includes('id="btn-fresh-control-plane"') &&
        setupSource.includes('id="control-plane-explicit-root-input"') &&
        setupSource.includes('id="btn-set-control-plane-root"') &&
        setupSource.includes('id="btn-reset-control-plane-root"') &&
        setupSource.includes('id="btn-clear-control-plane-cache"') &&
        !setupSource.includes('id="multi-repo-toggle"'),
        'Expected the setup panel to expose the merged Control Plane Setup accordion with mode switching, explicit-root controls, and no duplicate multi-repo accordion.'
    );
    assert.ok(
        setupSource.indexOf('id="project-mgmt-toggle"') < setupSource.indexOf('id="control-plane-toggle"'),
        'Expected Control Plane Setup to move below Project Management near the bottom of setup.html.'
    );
    assert.ok(
        setupSource.includes('id="project-mgmt-fields"') &&
        setupSource.includes('id="clickup-token-input"') &&
        setupSource.includes('id="clickup-option-create-folder"') &&
        setupSource.includes('id="clickup-option-create-lists"') &&
        setupSource.includes('id="clickup-option-create-custom-fields"') &&
        setupSource.includes('id="clickup-option-enable-realtime-sync"') &&
        setupSource.includes('id="clickup-option-enable-auto-pull"') &&
        setupSource.includes('id="btn-apply-clickup-config"') &&
        setupSource.includes('id="clickup-option-summary"') &&
        setupSource.includes('id="linear-option-map-columns"') &&
        setupSource.includes('id="linear-option-create-label"') &&
        setupSource.includes('id="linear-option-scope-project"') &&
        setupSource.includes('id="linear-option-enable-realtime-sync"') &&
        setupSource.includes('id="linear-option-enable-auto-pull"') &&
        setupSource.includes('id="btn-apply-linear-config"') &&
        setupSource.includes('id="linear-option-summary"') &&
        setupSource.includes('id="notion-option-enable-design-doc"') &&
        setupSource.includes('id="btn-apply-notion-config"') &&
        setupSource.includes('id="notion-option-summary"') &&
        setupSource.includes('id="clickup-mappings-section"') &&
        setupSource.includes('id="clickup-automation-section"') &&
        setupSource.includes('id="linear-automation-section"'),
        'Expected the setup panel to own checkbox-based ClickUp, Linear, and Notion setup with the existing downstream editors intact.'
    );
    assert.ok(
        !setupSource.includes('OPERATION MODE') &&
        !setupSource.includes('btn-setup-coding-mode') &&
        !setupSource.includes('btn-setup-board-mgmt-mode'),
        'Expected the standalone operation-mode setup block to be removed from setup.html.'
    );
    assert.ok(
        setupSource.includes("type: 'getControlPlaneStatus'") &&
        setupSource.includes("type: 'setExplicitControlPlaneRoot'") &&
        setupSource.includes("type: 'resetExplicitControlPlaneRoot'") &&
        setupSource.includes("type: 'clearControlPlaneCache'") &&
        setupSource.includes("type: 'detectControlPlaneCandidate'") &&
        setupSource.includes("type: 'previewControlPlaneMigration'") &&
        setupSource.includes("type: 'executeControlPlaneMigration'") &&
        setupSource.includes("type: 'executeControlPlaneFreshSetup'") &&
        setupSource.includes('controlPlaneStatusResult') &&
        setupSource.includes('controlPlaneOverrideResult') &&
        setupSource.includes('controlPlaneCandidateResult') &&
        setupSource.includes('controlPlaneMigrationPreview') &&
        setupSource.includes('controlPlaneMigrationResult') &&
        setupSource.includes('controlPlaneFreshSetupResult'),
        'Expected setup.html to send and receive the merged Control Plane status, override, and migration messages.'
    );
    assert.ok(
        setupSource.includes("type: 'applyClickUpConfig'") &&
        setupSource.includes("type: 'applyLinearConfig'") &&
        setupSource.includes("type: 'applyNotionConfig'") &&
        setupSource.includes('clickupApplyResult') &&
        setupSource.includes('linearApplyResult') &&
        setupSource.includes('notionApplyResult') &&
        !setupSource.includes("type: 'setupClickUp'") &&
        !setupSource.includes("type: 'setupLinear'") &&
        !setupSource.includes("type: 'setupNotion'") &&
        !setupSource.includes('operationModeChanged'),
        'Expected setup.html to send structured apply payloads and stop depending on the removed mode message.'
    );

    assert.match(
        providerSource,
        /type ClickUpSetupState = \{[\s\S]*folderReady: boolean;[\s\S]*listsReady: boolean;[\s\S]*customFieldsReady: boolean;[\s\S]*realTimeSyncEnabled: boolean;[\s\S]*autoPullEnabled: boolean;/m,
        'Expected TaskViewerProvider to expose detailed ClickUp hydration state for the checkbox UI.'
    );
    assert.match(
        providerSource,
        /type LinearSetupState = \{[\s\S]*mappingsReady: boolean;[\s\S]*labelReady: boolean;[\s\S]*projectScoped: boolean;[\s\S]*realTimeSyncEnabled: boolean;[\s\S]*autoPullEnabled: boolean;/m,
        'Expected TaskViewerProvider to expose detailed Linear hydration state for the checkbox UI.'
    );
    assert.match(
        providerSource,
        /type NotionSetupState = \{[\s\S]*setupComplete: boolean;[\s\S]*designDocEnabled: boolean;[\s\S]*designDocLink: string;/m,
        'Expected TaskViewerProvider to expose a dedicated Notion setup state.'
    );
    assert.ok(
        providerSource.includes('handleApplyClickUpConfig') &&
        providerSource.includes('handleApplyLinearConfig') &&
        providerSource.includes('handleApplyNotionConfig') &&
        !providerSource.includes('handleSetupClickUp') &&
        !providerSource.includes('handleSetupLinear') &&
        !providerSource.includes('handleSetupNotion') &&
        !providerSource.includes("type: 'operationModeChanged'"),
        'Expected TaskViewerProvider to route setup-panel applies through option-aware handlers without rebroadcasting operation mode or keeping unreleased setup wrappers.'
    );

    assert.ok(
        setupProviderSource.includes("case 'getControlPlaneStatus'") &&
        setupProviderSource.includes("case 'setExplicitControlPlaneRoot'") &&
        setupProviderSource.includes("case 'resetExplicitControlPlaneRoot'") &&
        setupProviderSource.includes("case 'clearControlPlaneCache'") &&
        setupProviderSource.includes("case 'detectControlPlaneCandidate'") &&
        setupProviderSource.includes("case 'previewControlPlaneMigration'") &&
        setupProviderSource.includes("case 'executeControlPlaneMigration'") &&
        setupProviderSource.includes("case 'executeControlPlaneFreshSetup'"),
        'Expected SetupPanelProvider to route Control Plane status/override/cache messages alongside detect/preview/execute cases.'
    );
    assert.ok(
        setupProviderSource.includes("case 'applyClickUpConfig'") &&
        setupProviderSource.includes("case 'applyLinearConfig'") &&
        setupProviderSource.includes("case 'applyNotionConfig'") &&
        !setupProviderSource.includes("case 'switchOperationMode'"),
        'Expected SetupPanelProvider to route the new apply messages and drop the legacy mode-switch case.'
    );
    assert.match(
        setupProviderSource,
        /private _getWorkspaceFolderUri\(workspaceRoot\?: string\): vscode\.Uri \| undefined \{[\s\S]*path\.resolve\(folder\.uri\.fsPath\) === path\.resolve\(resolvedRoot\)/m,
        'Expected SetupPanelProvider to resolve the selected workspace folder before falling back to direct configuration reads/writes.'
    );
    assert.match(
        setupProviderSource,
        /await config\.update\(\s*'kanban\.controlPlaneRoot',[\s\S]*folderUri \? vscode\.ConfigurationTarget\.WorkspaceFolder : vscode\.ConfigurationTarget\.Workspace\s*\)/m,
        'Expected fallback Control Plane override writes to stay resource-scoped instead of forcing a workspace-global setting.'
    );
    assert.ok(
        packageSource.includes('switchboard.clearControlPlaneCache') &&
        packageSource.includes('switchboard.kanban.controlPlaneRoot') &&
        extensionSource.includes('switchboard.setupControlPlane') &&
        packageSource.includes('switchboard.setupControlPlane') &&
        packageSource.includes('switchboard.controlPlane.onboardingDismissed'),
        'Expected the extension/package manifests to contribute the Control Plane entry point, cache-clear command, explicit-root setting, and onboarding-dismissal setting.'
    );
    assert.ok(
        !extensionSource.includes('switchboard.setupClickUp') &&
        !extensionSource.includes('switchboard.setupLinear') &&
        !packageSource.includes('switchboard.setupClickUp') &&
        !packageSource.includes('switchboard.setupLinear'),
        'Expected the unreleased ClickUp and Linear setup commands to be removed so the Setup panel is the only setup entry point.'
    );

    console.log('setup panel migration test passed');
}

try {
    run();
} catch (error) {
    console.error('setup panel migration test failed:', error);
    process.exit(1);
}
