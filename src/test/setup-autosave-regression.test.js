'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const setupSource = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'setup.html'), 'utf8');
    const implementationSource = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'implementation.html'), 'utf8');
    const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');

    assert.ok(!setupSource.includes('id="btn-save-startup"'), 'Expected setup autosave to remove the legacy SAVE CONFIGURATION button.');
    assert.ok(!setupSource.includes('id="btn-apply-git-ignore"'), 'Expected setup autosave to remove the legacy APPLY GIT IGNORE button.');
    assert.ok(setupSource.includes('function collectSetupSavePayload()'), 'Expected setup autosave to define a unified payload collector.');
    assert.ok(setupSource.includes('function queueSetupAutosave('), 'Expected setup autosave to debounce input-driven saves.');
    assert.ok(setupSource.includes('function flushSetupAutosave('), 'Expected setup autosave to support immediate blur-triggered saves.');
    assert.ok(setupSource.includes('julesAutoSyncEnabled'), 'Expected setup autosave payload to include Jules autosync.');
    assert.ok(setupSource.includes('gitIgnoreStrategy'), 'Expected setup autosave payload to include git-ignore strategy.');
    assert.ok(setupSource.includes('gitIgnoreRules'), 'Expected setup autosave payload to include git-ignore rules.');
    assert.ok(setupSource.includes('let lastOllamaSetupState = null;'), 'Expected setup state to track Ollama hydration separately from the autosave payload.');
    assert.ok(setupSource.includes('id="ollama-use-gemma-cloud"'), 'Expected simplified Ollama UI to include the Gemma cloud checkbox.');
    assert.ok(!setupSource.includes('id="ollama-launch-via-claude"'), 'Expected Ollama UI to remove the Claude Code launch checkbox (now mandatory).');
    assert.ok(setupSource.includes('id="ollama-effective-command"'), 'Expected simplified Ollama UI to include the command preview div.');
    assert.ok(!setupSource.includes('id="btn-ollama-save-intern"'), 'Expected simplified Ollama UI to remove the Save Intern Model button.');
    assert.ok(!setupSource.includes('id="btn-ollama-launch"'), 'Expected simplified Ollama UI to remove the Launch Claude Code button.');
    assert.ok(!setupSource.includes('id="btn-ollama-signout"'), 'Expected simplified Ollama UI to remove the Sign Out button.');
    assert.ok(!setupSource.includes('let ollamaDraftMode'), 'Expected simplified Ollama UI to remove the draft mode variable.');
    assert.ok(!setupSource.includes('let ollamaDraftDirty'), 'Expected simplified Ollama UI to remove the draft dirty flag.');
    assert.ok(!setupSource.includes('syncOllamaDraftFromSaved'), 'Expected simplified Ollama UI to remove the draft sync function.');
    assert.ok(!setupSource.includes('startOllamaPullPolling'), 'Expected simplified Ollama UI to remove the pull polling function.');
    assert.match(
        setupSource,
        /case 'ollamaSetupState':[\s\S]*lastOllamaSetupState = cloneOllamaSetupState\([\s\S]*renderOllamaSetupState\(\);[\s\S]*\}/s,
        'Expected simplified Ollama setup hydration to directly render state without draft management.'
    );

    assert.ok(!implementationSource.includes('id="jules-auto-sync-toggle"'), 'Expected Terminal Operations to stop rendering the persistent Jules autosync toggle.');

    assert.match(
        providerSource,
        /handleSaveStartupCommands\(data: any\): Promise<void> \{[\s\S]*gitIgnoreStrategy[\s\S]*gitIgnoreRules/s,
        'Expected handleSaveStartupCommands() to persist git-ignore fields from autosave payloads.'
    );
    assert.match(
        providerSource,
        /await Promise\.all\(\[\s*this\._postSidebarConfigurationState\((?:activeWorkspaceRoot|resolvedWorkspaceRoot|resolvedRoot)\),\s*this\.postSetupPanelState\((?:activeWorkspaceRoot|resolvedWorkspaceRoot|resolvedRoot)\)\s*\]\);/s,
        'Expected autosave to keep rebroadcasting refreshed state to both webviews after save.'
    );

    console.log('setup autosave regression test passed');
}

try {
    run();
} catch (error) {
    console.error('setup autosave regression test failed:', error);
    process.exit(1);
}
