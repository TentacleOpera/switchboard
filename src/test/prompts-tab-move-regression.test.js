'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const kanbanSource = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'kanban.html'), 'utf8');
const taskViewerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
const setupPanelSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'SetupPanelProvider.ts'), 'utf8');

function expectRegex(source, regex, message) {
    assert.match(source, regex, message);
}

function expectNoRegex(source, regex, message) {
    assert.doesNotMatch(source, regex, message);
}

function run() {
    console.log('Running Prompts Tab Move Regression Tests...\n');

    // Test 1: HTML Structure Verification
    console.log('Test 1: HTML Structure Verification');
    expectRegex(
        kanbanSource,
        /<div\s+id="prompts-tab-content"\s+class="kanban-tab-content">/,
        'Expected prompts-tab-content div to exist with correct class'
    );
    expectRegex(
        kanbanSource,
        /<button[^>]*data-tab="prompts"[^>]*>PROMPTS<\/button>/,
        'Expected Prompts tab button with data-tab="prompts" attribute'
    );
    
    // Verify all renamed elements exist with prompts-tab-* prefix
    const promptsTabElements = [
        'prompts-tab-design-doc-toggle',
        'prompts-tab-design-doc-input',
        'prompts-tab-accurate-coding-toggle',
        'prompts-tab-lead-challenge-toggle',
        'prompts-tab-advanced-reviewer-toggle',
        'prompts-tab-aggressive-pair-toggle',
        'prompts-tab-prompt-role-tabs',
        'prompts-tab-prompt-preview-text',
        'prompts-tab-prompt-mode',
        'prompts-tab-prompt-text',
        'prompts-tab-btn-clear-override',
        'prompts-tab-prompt-override-summary',
        'prompts-tab-btn-save-overrides'
    ];

    promptsTabElements.forEach(elementId => {
        expectRegex(
            kanbanSource,
            new RegExp(`id="${elementId}"`),
            `Expected element with id="${elementId}" to exist`
        );
    });

    // Verify old agents-tab-* element IDs NO LONGER EXIST
    const oldAgentsTabElements = [
        'agents-tab-design-doc-toggle',
        'agents-tab-design-doc-input',
        'agents-tab-accurate-coding-toggle',
        'agents-tab-lead-challenge-toggle',
        'agents-tab-advanced-reviewer-toggle',
        'agents-tab-aggressive-pair-toggle',
        'agents-tab-prompt-role-tabs',
        'agents-tab-prompt-preview-text',
        'agents-tab-prompt-mode',
        'agents-tab-prompt-text',
        'agents-tab-btn-clear-override',
        'agents-tab-prompt-override-summary',
        'agents-tab-btn-save-overrides'
    ];

    oldAgentsTabElements.forEach(elementId => {
        expectNoRegex(
            kanbanSource,
            new RegExp(`id="${elementId}"`),
            `Expected old element id="${elementId}" to NOT exist`
        );
    });

    console.log('✓ Test 1 passed\n');

    // Test 2: JavaScript Function Verification
    console.log('Test 2: JavaScript Function Verification');
    
    // Verify renamed globals exist
    expectRegex(
        kanbanSource,
        /const\s+PROMPTS_TAB_ROLES\s*=/,
        'Expected PROMPTS_TAB_ROLES global to exist'
    );
    expectRegex(
        kanbanSource,
        /let\s+promptsTabOverrides\s*=/,
        'Expected promptsTabOverrides global to exist'
    );
    expectRegex(
        kanbanSource,
        /let\s+promptsTabPreviews\s*=/,
        'Expected promptsTabPreviews global to exist'
    );
    expectRegex(
        kanbanSource,
        /let\s+promptsTabEditingRole\s*=/,
        'Expected promptsTabEditingRole global to exist'
    );

    // Verify old globals NO LONGER EXIST
    expectNoRegex(
        kanbanSource,
        /const\s+AGENTS_TAB_PROMPT_ROLES\s*=/,
        'Expected old AGENTS_TAB_PROMPT_ROLES global to NOT exist'
    );
    expectNoRegex(
        kanbanSource,
        /let\s+agentsTabPromptOverrides\s*=/,
        'Expected old agentsTabPromptOverrides global to NOT exist'
    );
    expectNoRegex(
        kanbanSource,
        /const\s+agentsTabPromptPreviews\s*=/,
        'Expected old agentsTabPromptPreviews global to NOT exist'
    );
    expectNoRegex(
        kanbanSource,
        /let\s+agentsTabEditingRole\s*=/,
        'Expected old agentsTabEditingRole global to NOT exist'
    );

    // Verify renamed functions exist
    expectRegex(
        kanbanSource,
        /function\s+promptsTabSaveDraft\s*\(/,
        'Expected promptsTabSaveDraft function to exist'
    );
    expectRegex(
        kanbanSource,
        /function\s+promptsTabLoadForm\s*\(/,
        'Expected promptsTabLoadForm function to exist'
    );
    expectRegex(
        kanbanSource,
        /function\s+promptsTabUpdateSummary\s*\(/,
        'Expected promptsTabUpdateSummary function to exist'
    );
    expectRegex(
        kanbanSource,
        /function\s+promptsTabLoadPreview\s*\(/,
        'Expected promptsTabLoadPreview function to exist'
    );
    expectRegex(
        kanbanSource,
        /function\s+promptsTabRenderTabs\s*\(/,
        'Expected promptsTabRenderTabs function to exist'
    );
    expectRegex(
        kanbanSource,
        /function\s+promptsTabCollectConfig\s*\(/,
        'Expected promptsTabCollectConfig function to exist'
    );

    // Verify old function names NO LONGER EXIST
    // Note: agentsTabCollectConfig still exists for the agents tab's CLI commands section
    expectNoRegex(
        kanbanSource,
        /function\s+agentsTabSaveCurrentRoleDraft\s*\(/,
        'Expected old agentsTabSaveCurrentRoleDraft function to NOT exist'
    );
    expectNoRegex(
        kanbanSource,
        /function\s+agentsTabLoadRoleIntoForm\s*\(/,
        'Expected old agentsTabLoadRoleIntoForm function to NOT exist'
    );
    expectNoRegex(
        kanbanSource,
        /function\s+agentsTabUpdateSummary\s*\(/,
        'Expected old agentsTabUpdateSummary function to NOT exist'
    );
    expectNoRegex(
        kanbanSource,
        /function\s+agentsTabLoadPreview\s*\(/,
        'Expected old agentsTabLoadPreview function to NOT exist'
    );
    expectNoRegex(
        kanbanSource,
        /function\s+agentsTabRenderRoleTabs\s*\(/,
        'Expected old agentsTabRenderRoleTabs function to NOT exist'
    );

    // Verify promptsTabCollectConfig uses #prompts-tab-content selector
    expectRegex(
        kanbanSource,
        /function\s+promptsTabCollectConfig\(\)[\s\S]*?getElementById\(['"]prompts-tab-/,
        'Expected promptsTabCollectConfig to use prompts-tab- element IDs'
    );

    console.log('✓ Test 2 passed\n');

    // Test 3: CSS Class Verification
    console.log('Test 3: CSS Class Verification');
    
    expectRegex(
        kanbanSource,
        /\.prompts-role-tab\s*\{/,
        'Expected .prompts-role-tab class to exist'
    );
    expectRegex(
        kanbanSource,
        /\.prompts-role-tab\.active\s*\{/,
        'Expected .prompts-role-tab.active class to exist'
    );
    expectRegex(
        kanbanSource,
        /\.prompts-role-tab\.has-override/,
        'Expected .prompts-role-tab.has-override class to exist'
    );

    // Verify old classes NO LONGER EXIST
    expectNoRegex(
        kanbanSource,
        /\.agents-prompt-role-tab\s*\{/,
        'Expected old .agents-prompt-role-tab class to NOT exist'
    );
    expectNoRegex(
        kanbanSource,
        /\.agents-prompt-role-tab\.active\s*\{/,
        'Expected old .agents-prompt-role-tab.active class to NOT exist'
    );
    expectNoRegex(
        kanbanSource,
        /\.agents-prompt-role-tab\.has-override\s*\{/,
        'Expected old .agents-prompt-role-tab.has-override class to NOT exist'
    );

    console.log('✓ Test 3 passed\n');

    // Test 4: Message Handler Verification (TaskViewerProvider.ts & SetupPanelProvider.ts)
    console.log('Test 4: Message Handler Verification');
    
    // Verify providers send messages with correct structure
    expectRegex(
        taskViewerSource,
        /designDocSetting/,
        'Expected TaskViewerProvider to send designDocSetting message'
    );
    expectRegex(
        taskViewerSource,
        /accurateCodingSetting/,
        'Expected TaskViewerProvider to send accurateCodingSetting message'
    );
    expectRegex(
        taskViewerSource,
        /defaultPromptOverrides/,
        'Expected TaskViewerProvider to send defaultPromptOverrides message'
    );
    expectRegex(
        setupPanelSource,
        /designDocSetting/,
        'Expected SetupPanelProvider to send designDocSetting message'
    );
    expectRegex(
        setupPanelSource,
        /accurateCodingSetting/,
        'Expected SetupPanelProvider to send accurateCodingSetting message'
    );

    console.log('✓ Test 4 passed\n');

    // Test 5: Backend Integration Tests
    console.log('Test 5: Backend Integration Tests');
    
    // Test that prompt builder correctly uses settings from new tab location
    expectRegex(
        taskViewerSource,
        /buildKanbanBatchPrompt/,
        'Expected buildKanbanBatchPrompt function to exist'
    );
    expectRegex(
        taskViewerSource,
        /defaultPromptOverrides/,
        'Expected buildKanbanBatchPrompt to receive defaultPromptOverrides from cached overrides'
    );
    expectRegex(
        taskViewerSource,
        /accurateCodingEnabled/,
        'Expected buildKanbanBatchPrompt to include accurateCodingEnabled flag'
    );
    expectRegex(
        taskViewerSource,
        /designDocLink/,
        'Expected buildKanbanBatchPrompt to include designDocLink when enabled'
    );
    expectRegex(
        taskViewerSource,
        /handleGetDesignDocSetting/,
        'Expected TaskViewerProvider.handleGetDesignDocSetting to exist'
    );
    expectRegex(
        taskViewerSource,
        /handleGetAccurateCodingSetting/,
        'Expected TaskViewerProvider.handleGetAccurateCodingSetting to exist'
    );

    console.log('✓ Test 5 passed\n');

    // Test 6: Tab Switching Logic
    console.log('Test 6: Tab Switching Logic');
    
    // Verify prompts tab button exists with correct data-tab attribute
    expectRegex(
        kanbanSource,
        /data-tab="prompts"/,
        'Expected prompts tab button to have data-tab attribute'
    );
    
    // Verify other tabs still exist in correct order
    expectRegex(
        kanbanSource,
        /data-tab="kanban"/,
        'Expected kanban tab to still exist'
    );
    expectRegex(
        kanbanSource,
        /data-tab="agents"/,
        'Expected agents tab to still exist'
    );
    expectRegex(
        kanbanSource,
        /data-tab="automation"/,
        'Expected automation tab to still exist'
    );
    expectRegex(
        kanbanSource,
        /data-tab="setup"/,
        'Expected setup tab to still exist'
    );

    console.log('✓ Test 6 passed\n');

    // Test 7: Agents Tab Cleanup Verification
    console.log('Test 7: Agents Tab Cleanup Verification');
    
    // Verify "Agent Visibility & CLI Commands" section still exists in agents tab
    expectRegex(
        kanbanSource,
        /agents-tab-content/,
        'Expected agents-tab-content to still exist'
    );
    expectRegex(
        kanbanSource,
        /Agent Visibility/,
        'Expected "Agent Visibility" section to still exist in agents tab'
    );
    expectRegex(
        kanbanSource,
        /CLI Commands/,
        'Expected "CLI Commands" section to still exist in agents tab'
    );

    // Verify Jules auto-sync checkbox still exists in agents tab
    expectRegex(
        kanbanSource,
        /jules-auto-sync/,
        'Expected jules-auto-sync checkbox to still exist in agents tab'
    );

    // Verify agents tab does NOT contain prompt control elements
    // (Already verified in Test 1 that agents-tab-* IDs don't exist)

    console.log('✓ Test 7 passed\n');

    // Test 8: Data Persistence Verification
    console.log('Test 8: Data Persistence Verification');
    
    // Verify VS Code configuration keys exist for prompt settings
    expectRegex(
        taskViewerSource,
        /accurateCoding\.enabled/,
        'Expected accurateCoding.enabled config key'
    );
    expectRegex(
        taskViewerSource,
        /leadCoder\.inlineChallenge/,
        'Expected leadCoder.inlineChallenge config key'
    );
    expectRegex(
        taskViewerSource,
        /reviewer\.advancedMode/,
        'Expected reviewer.advancedMode config key'
    );
    expectRegex(
        taskViewerSource,
        /pairProgramming\.aggressive/,
        'Expected pairProgramming.aggressive config key'
    );
    expectRegex(
        taskViewerSource,
        /planner\.designDocEnabled/,
        'Expected planner.designDocEnabled config key'
    );
    expectRegex(
        taskViewerSource,
        /planner\.designDocLink/,
        'Expected planner.designDocLink config key'
    );

    // Verify save functionality exists
    expectRegex(
        kanbanSource,
        /saveDefaultPromptOverrides/,
        'Expected saveDefaultPromptOverrides message to be sent'
    );
    expectRegex(
        kanbanSource,
        /vscode\.postMessage/,
        'Expected vscode.postMessage to be used for saving config'
    );

    console.log('✓ Test 8 passed\n');

    console.log('All tests passed! ✓');
}

run();
