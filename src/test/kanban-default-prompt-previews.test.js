'use strict';

const assert = require('assert');
const path = require('path');
const { buildKanbanBatchPrompt } = require('../../out/services/agentPromptBuilder');

/**
 * Unit tests for KanbanProvider._getDefaultPromptPreviews
 */
async function run() {
    console.log('Running KanbanProvider._getDefaultPromptPreviews unit tests...');

    // Mock KanbanProvider
    const KanbanProvider = {
        // Properties used by the method
        _taskViewerProvider: {
            getPersonaForRole: async (role) => `Mock persona for ${role}`
        },

        // Mocked method settings
        promptsConfig: {
            plannerWorkflowPath: '.agent/workflows/improve-plan.md',
            dependencyCheckEnabled: true,
            aggressivePairProgramming: true,
            splitPlan: true,
            advancedReviewerEnabled: true,
            gitProhibitionByRole: {},
            switchboardSafeguardsByRole: {},
            researchPlanner: {
                enableDeepPlanning: false,
                researchDepth: 'deep'
            }
        },

        defaultPromptOverrides: {},

        async _getDefaultPromptOverrides(workspaceRoot) {
            return this.defaultPromptOverrides;
        },

        async _getPromptsConfig(workspaceRoot) {
            return this.promptsConfig;
        },

        // The actual implementation of _getDefaultPromptPreviews copied from KanbanProvider.ts
        async _getDefaultPromptPreviews(workspaceRoot) {
            const previews = {};
            const roles = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst', 'research_planner'];
            const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
            for (const role of roles) {
                try {
                    const promptsConfig = await this._getPromptsConfig(workspaceRoot);
                    const personaContent = await this._taskViewerProvider?.getPersonaForRole(role);
                    const preview = buildKanbanBatchPrompt(role, [], {
                        workspaceRoot,
                        personaContent: personaContent?.trim() || undefined,
                        defaultPromptOverrides,
                        gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.[role] ?? true,
                        switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role] ?? true,
                        enableDeepPlanning: promptsConfig.researchPlanner?.enableDeepPlanning,
                        researchDepth: promptsConfig.researchPlanner?.researchDepth,
                        // Planner-specific options (matching _generateBatchPlannerPrompt pattern)
                        plannerWorkflowPath: role === 'planner' ? promptsConfig.plannerWorkflowPath : undefined,
                        dependencyCheckEnabled: role === 'planner' ? promptsConfig.dependencyCheckEnabled : undefined,
                        aggressivePairProgramming: role === 'planner' ? promptsConfig.aggressivePairProgramming : undefined,
                        splitPlan: role === 'planner' ? promptsConfig.splitPlan : undefined,
                        // Reviewer-specific options (matching _generateBatchReviewerPrompt pattern)
                        advancedReviewerEnabled: role === 'reviewer' ? promptsConfig.advancedReviewerEnabled : undefined
                    });
                    previews[role] = preview;
                } catch (err) {
                    previews[role] = 'Preview not available: ' + err.message;
                }
            }
            return previews;
        }
    };

    // TEST 1: Default configuration
    // Verify default options are passed correctly
    KanbanProvider.promptsConfig.plannerWorkflowPath = '.agent/workflows/improve-plan.md';
    KanbanProvider.promptsConfig.dependencyCheckEnabled = false;
    KanbanProvider.promptsConfig.aggressivePairProgramming = false;
    KanbanProvider.promptsConfig.splitPlan = false;
    KanbanProvider.promptsConfig.advancedReviewerEnabled = false;

    let previews = await KanbanProvider._getDefaultPromptPreviews('/root');
    
    // Check planner workflow path defaults (should have the default workflow string)
    assert.ok(previews.planner.includes('Read .agent/workflows/improve-plan.md and follow it step-by-step'), 'Planner preview should include default workflow path instructions');
    assert.ok(!previews.planner.includes('DEPENDENCY CHECK ENABLED'), 'Planner preview should not include dependency check when disabled');
    assert.ok(!previews.planner.includes('PAIR PROGRAMMING OPTIMISATION'), 'Planner preview should not include aggressive pair programming when disabled');
    assert.ok(!previews.planner.includes('SPLIT PLAN MODE'), 'Planner preview should not include split-plan mode when disabled');
    assert.ok(!previews.reviewer.includes('ADVANCED REGRESSION ANALYSIS'), 'Reviewer preview should not include advanced regression block when disabled');

    // TEST 2: Custom / Enabled options
    KanbanProvider.promptsConfig.plannerWorkflowPath = '.custom/workflows/my-planner.md';
    KanbanProvider.promptsConfig.dependencyCheckEnabled = true;
    KanbanProvider.promptsConfig.aggressivePairProgramming = true;
    KanbanProvider.promptsConfig.splitPlan = true;
    KanbanProvider.promptsConfig.advancedReviewerEnabled = true;

    previews = await KanbanProvider._getDefaultPromptPreviews('/root');

    // Check planner custom options are reflected
    assert.ok(previews.planner.includes('Read .custom/workflows/my-planner.md and follow it step-by-step'), 'Planner preview should reflect custom workflow path');
    assert.ok(previews.planner.includes('DEPENDENCY CHECK ENABLED'), 'Planner preview should reflect enabled dependency check');
    assert.ok(previews.planner.includes('PAIR PROGRAMMING OPTIMISATION'), 'Planner preview should reflect enabled aggressive pair programming');
    assert.ok(previews.planner.includes('SPLIT PLAN MODE'), 'Planner preview should reflect enabled split plan');

    // Check reviewer custom options are reflected
    assert.ok(previews.reviewer.includes('ADVANCED REGRESSION ANALYSIS'), 'Reviewer preview should reflect advanced regression option');

    // TEST 3: Non-planner / Non-reviewer roles should not receive role-specific options
    // For example, lead coder should not have planner workflow path or advanced reviewer enabled
    assert.ok(!previews.lead.includes('Read .custom/workflows/my-planner.md'), 'Lead Coder preview should not include planner-specific workflow path');
    assert.ok(!previews.lead.includes('ADVANCED REGRESSION ANALYSIS'), 'Lead Coder preview should not include reviewer-specific advanced regression analysis');

    console.log('All KanbanProvider._getDefaultPromptPreviews unit tests passed!');
}

run().catch(err => {
    console.error('Tests failed:', err);
    process.exit(1);
});
