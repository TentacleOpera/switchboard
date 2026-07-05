'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const kanbanSource = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'kanban.html'), 'utf8');
const taskViewerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
const setupPanelSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'SetupPanelProvider.ts'), 'utf8');
const kanbanProviderSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');

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
        /<div\s+id="prompts-tab-content"\s+class="shared-tab-content">/,
        'Expected prompts-tab-content div to exist with correct class'
    );
    expectRegex(
        kanbanSource,
        /<button[^>]*data-tab="prompts"[^>]*>PROMPTS<\/button>/,
        'Expected Prompts tab button with data-tab="prompts" attribute'
    );
    
    // Verify prompts tab elements exist with actual IDs used in the HTML
    const promptsTabElements = [
        'prompts-tab-content',
        'prompts-tab-workflow-path-status',
        'roleSelect',
        'workflowFilePath',
        'validateWorkflowPath',
        'plannerAddonSwitchboardSafeguards',
        'plannerAddonDependencyCheck',
        'plannerAddonPlanningFeature',
        'plannerAddonDesignSystemDoc',
        'plannerAddonAggressivePairProgramming',
        'plannerAddonGitProhibition',
        'plannerAddonClearAntigravityContext',
        'roleAddonsDesc',
        'roleAddonsGroup',
        'promptPreview'
    ];

    promptsTabElements.forEach(elementId => {
        expectRegex(
            kanbanSource,
            new RegExp(`id="${elementId}"`),
            `Expected element with id="${elementId}" to exist`
        );
    });

    // Verify old agents-tab-* and removed prompts tab elements NO LONGER EXIST
    const removedElements = [
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
        'agents-tab-btn-save-overrides',
        'rolePromptTextarea',
        'refreshPreview'
    ];

    removedElements.forEach(elementId => {
        expectNoRegex(
            kanbanSource,
            new RegExp(`id="${elementId}"`),
            `Expected old/removed element id="${elementId}" to NOT exist`
        );
    });

    console.log('✓ Test 1 passed\n');

    // Test 2: JavaScript Function Verification
    console.log('Test 2: JavaScript Function Verification');
    
    // Verify prompts tab functions exist
    expectRegex(
        kanbanSource,
        /function\s+handleRoleChange\s*\(/,
        'Expected handleRoleChange function to exist'
    );
    expectRegex(
        kanbanSource,
        /function\s+saveRoleConfig\s*\(/,
        'Expected saveRoleConfig function to exist'
    );
    expectRegex(
        kanbanSource,
        /function\s+renderRoleAddons\s*\(/,
        'Expected renderRoleAddons function to exist'
    );
    expectRegex(
        kanbanSource,
        /function\s+refreshPreview\s*\(/,
        'Expected refreshPreview function to exist'
    );
    expectRegex(
        kanbanSource,
        /function\s+initPromptsTabListeners\s*\(/,
        'Expected initPromptsTabListeners function to exist'
    );

    // Verify old function names NO LONGER EXIST
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

    // Verify the broken promptsTabCollectConfig has been removed
    expectNoRegex(
        kanbanSource,
        /function\s+promptsTabCollectConfig\s*\(/,
        'Expected broken promptsTabCollectConfig function to NOT exist (referenced non-existent element IDs)'
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
        /handleGetAccurateCodingSetting/,
        'Expected TaskViewerProvider.handleGetAccurateCodingSetting to exist'
    );
    
    // Verify accurateCodingEnabled is passed in KanbanProvider.ts prompt preview paths
    expectRegex(
        kanbanProviderSource,
        /accurateCodingEnabled:\s*\(role\s*===\s*'coder'\s*\|\|\s*role\s*===\s*'lead'\)\s*\?\s*promptsConfig\.accurateCodingEnabled\s*:\s*undefined/,
        'Expected accurateCodingEnabled to be passed to buildKanbanBatchPrompt in KanbanProvider.ts'
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

    // Verify position of AUTOMATION and SETUP tabs
    expectRegex(
        kanbanSource,
        /data-tab="automation"[\s\S]*?data-tab="setup"/,
        'Expected AUTOMATION tab to be positioned before SETUP'
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



    // Verify save functionality exists (saveRoleConfig uses postKanbanMessage)
    expectRegex(
        kanbanSource,
        /saveRoleConfig/,
        'Expected saveRoleConfig function to exist for saving role config'
    );
    expectRegex(
        kanbanSource,
        /postKanbanMessage/,
        'Expected postKanbanMessage to be used for saving config'
    );

    console.log('✓ Test 8 passed\n');

    // Test 9: Header Unification Verification
    console.log('Test 9: Header Unification Verification');
    
    // Verify .subsection-header uses var(--accent-teal) color
    expectRegex(
        kanbanSource,
        /\.subsection-header\s*\{[^}]*color:\s*var\(--accent-teal\)/,
        'Expected .subsection-header to use var(--accent-teal) color'
    );

    // Verify no dep-tree-header, dep-tree-title, dep-tree-actions CSS classes remain
    expectNoRegex(
        kanbanSource,
        /\.dep-tree-header\s*\{/,
        'Expected .dep-tree-header CSS to be removed'
    );
    expectNoRegex(
        kanbanSource,
        /\.dep-tree-title\s*\{/,
        'Expected .dep-tree-title CSS to be removed'
    );
    expectNoRegex(
        kanbanSource,
        /\.dep-tree-actions\s*\{/,
        'Expected .dep-tree-actions CSS to be removed'
    );
    expectNoRegex(
        kanbanSource,
        /\.setup-section-title\s*\{/,
        'Expected .setup-section-title CSS to be removed'
    );
    expectNoRegex(
        kanbanSource,
        /\.prompts-tab\s+h2\s*\{/,
        'Expected .prompts-tab h2 CSS to be removed'
    );
    expectNoRegex(
        kanbanSource,
        /\.config-section\s+h3\s*\{/,
        'Expected .config-section h3 CSS to be removed'
    );

    // Verify .subsection-actions CSS exists
    expectRegex(
        kanbanSource,
        /\.subsection-actions\s*\{/,
        'Expected .subsection-actions CSS to exist'
    );

    // Verify no "AGENT CONFIGURATION" top-level heading in agents tab
    expectNoRegex(
        kanbanSource,
        /AGENT CONFIGURATION/,
        'Expected "AGENT CONFIGURATION" heading to be removed from agents tab'
    );

    // Verify no "Prompt Configuration" h2 in prompts tab
    expectNoRegex(
        kanbanSource,
        /<h2[^>]*>Prompt Configuration<\/h2>/,
        'Expected <h2>Prompt Configuration</h2> to be removed from prompts tab'
    );

    // Verify subsection headers exist in remaining tabs
    expectRegex(
        kanbanSource,
        /<div class="subsection-header"><span>User Acceptance Testing<\/span><\/div>/,
        'Expected "User Acceptance Testing" subsection header in UAT tab'
    );
    expectRegex(
        kanbanSource,
        /<div class="subsection-header"><span>Routing Configuration<\/span><\/div>/,
        'Expected "Routing Configuration" subsection header in Setup tab'
    );

    // Verify action buttons are in .subsection-actions rows
    expectRegex(
        kanbanSource,
        /<div class="subsection-actions">[\s\S]*?btn-refresh-uat/,
        'Expected UAT tab refresh button in .subsection-actions row'
    );

    console.log('✓ Test 9 passed\n');

    console.log('Test 10: Accurate Coding Preview Regression');
    expectRegex(
        kanbanProviderSource,
        /case\s+'getPromptPreview':[\s\S]*?accurateCodingEnabled:\s*\(role\s*===\s*'coder'\s*\|\|\s*role\s*===\s*'lead'\)\s*\?\s*promptsConfig\.accurateCodingEnabled\s*:\s*undefined[\s\S]*?break;/m,
        'Expected KanbanProvider getPromptPreview to pass accurateCodingEnabled'
    );
    console.log('✓ Test 10 passed\n');

    console.log('All tests passed! ✓');
}

run();
