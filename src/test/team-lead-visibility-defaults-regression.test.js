'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readSource(...segments) {
    return fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8');
}

function run() {
    const kanbanProviderSource = readSource('src', 'services', 'KanbanProvider.ts');
    const taskViewerSource = readSource('src', 'services', 'TaskViewerProvider.ts');
    const extensionSource = readSource('src', 'extension.ts');
    const implementationSource = readSource('src', 'webview', 'implementation.html');
    const kanbanSource = readSource('src', 'webview', 'kanban.html');
    const setupSource = readSource('src', 'webview', 'setup.html');
    const agentConfigSource = readSource('src', 'services', 'agentConfig.ts');

    assert.match(
        kanbanProviderSource,
        /const defaults: Record<string, boolean> = \{[\s\S]*'team-lead': false[\s\S]*jules: true \};/m,
        'Expected KanbanProvider visible-agent defaults to keep Team Lead hidden by default.'
    );

    assert.match(
        taskViewerSource,
        /const defaults: Record<string, boolean> = \{[\s\S]*'team-lead': false[\s\S]*jules: true \};/m,
        'Expected TaskViewerProvider visible-agent defaults to keep Team Lead hidden by default.'
    );

    assert.match(
        implementationSource,
        /let lastVisibleAgents = \{[\s\S]*'team-lead': false[\s\S]*jules: true \};/m,
        'Expected implementation.html bootstrap visibility to keep Team Lead hidden by default.'
    );

    assert.match(
        implementationSource,
        /const visibleAgents = \{ lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': lastVisibleAgents\['team-lead'\] === true, jules: true \};/,
        'Expected onboarding save path to preserve the hidden Team Lead visibility state.'
    );

    assert.match(
        implementationSource,
        /const commands = \{\s*\.\.\.lastStartupCommands,\s*'team-lead': lastStartupCommands\['team-lead'\] \|\| ''\s*\};/m,
        'Expected terminal-operations saves to preserve the hidden Team Lead startup command.'
    );
    assert.match(
        implementationSource,
        /const visibleAgents = \{\s*\.\.\.lastVisibleAgents,\s*'team-lead': lastVisibleAgents\['team-lead'\] === true\s*\};/m,
        'Expected terminal-operations launches to use cached visibility state after the built-in controls moved to setup.'
    );

    assert.match(
        setupSource,
        /let lastVisibleAgents = \{[\s\S]*'team-lead': false[\s\S]*jules: true \};/m,
        'Expected setup.html bootstrap visibility to keep Team Lead hidden by default.'
    );

    assert.match(
        setupSource,
        /id="agents-toggle"[\s\S]*id="design-doc-toggle"[\s\S]*class="agent-visible-toggle" data-role="planner"[\s\S]*class="agent-visible-toggle" data-role="jules"[\s\S]*id="default-prompt-override-summary"[\s\S]*id="btn-customize-default-prompts"/m,
        'Expected setup.html to expose an Agents accordion with prompt controls, built-in agent settings, and prompt overrides.'
    );
    assert.match(
        setupSource,
        /id="kanban-structure-toggle"[\s\S]*id="kanban-structure-list"[\s\S]*id="orchestration-toggle"[\s\S]*Orchestration Framework Integration[\s\S]*OpenCode, GitHub Squads[\s\S]*receives instructions[\s\S]*id="team-lead-visible-toggle"[\s\S]*id="team-lead-command-input"[\s\S]*id="team-lead-complexity-cutoff"[\s\S]*id="team-lead-complexity-cutoff-label"/m,
        'Expected setup.html to keep Team Lead in a dedicated orchestration accordion with explanatory copy.'
    );
    assert.doesNotMatch(
        setupSource,
        /id="prompt-overrides-toggle"/m,
        'Expected setup.html to remove the standalone Default Prompt Overrides accordion.'
    );
    assert.doesNotMatch(
        setupSource,
        /<span class="chevron open" id="setup-chevron">▶<\/span>|<div class="startup-fields open" id="startup-fields"/m,
        'Expected the Setup accordion to start collapsed by default.'
    );

    assert.match(
        setupSource,
        /bindAccordion\('agents-toggle', 'agents-fields', 'agents-chevron', \(\) => \{[\s\S]*type: 'getAccurateCodingSetting'[\s\S]*type: 'getAdvancedReviewerSetting'[\s\S]*type: 'getLeadChallengeSetting'[\s\S]*type: 'getAggressivePairSetting'[\s\S]*type: 'getDesignDocSetting'[\s\S]*type: 'getStartupCommands'[\s\S]*type: 'getVisibleAgents'[\s\S]*type: 'getDefaultPromptOverrides'[\s\S]*\}\);/m,
        'Expected the Agents accordion to refresh moved prompt, startup-command, visibility, and prompt-override state when opened.'
    );
    assert.match(
        setupSource,
        /bindAccordion\('orchestration-toggle', 'orchestration-fields', 'orchestration-chevron', \(\) => \{[\s\S]*type: 'getStartupCommands'[\s\S]*type: 'getVisibleAgents'[\s\S]*type: 'getTeamLeadRoutingSettings'[\s\S]*\}\);/m,
        'Expected the orchestration accordion to refresh Team Lead startup, visibility, and routing state when opened.'
    );

    assert.match(
        setupSource,
        /const commands = \{[\s\S]*'team-lead': teamLeadCommandInput\?\.value\.trim\(\) \|\| ''[\s\S]*\};[\s\S]*querySelectorAll\('#agents-fields input\[type="text"\]\[data-role\]'\)\.forEach[\s\S]*const visibleAgents = \{[\s\S]*'team-lead': !!teamLeadVisibleToggle\?\.checked[\s\S]*\};[\s\S]*querySelectorAll\('#agents-fields \.agent-visible-toggle'\)\.forEach[\s\S]*teamLeadComplexityCutoff: Number\(teamLeadComplexityCutoffInput\?\.value \|\| 0\),/m,
        'Expected setup saves to persist moved built-in agent settings plus Team Lead command, visibility, and routing through the shared startup-command payload.'
    );

    assert.match(
        setupSource,
        /if \(teamLeadCommandInput\) \{[\s\S]*lastStartupCommands\['team-lead'\] \|\| ''[\s\S]*\}[\s\S]*querySelectorAll\('#agents-fields input\[type="text"\]\[data-role\]'\)\.forEach/m,
        'Expected setup startup-command hydration to populate the Team Lead command input and moved built-in command inputs.'
    );

    assert.match(
        setupSource,
        /if \(teamLeadVisibleToggle\) \{[\s\S]*lastVisibleAgents\['team-lead'\] !== false[\s\S]*\}[\s\S]*querySelectorAll\('#agents-fields \.agent-visible-toggle'\)\.forEach/m,
        'Expected setup visibility hydration to populate the Team Lead toggle and moved built-in agent toggles.'
    );

    assert.match(
        setupSource,
        /function describeTeamLeadCutoff\(value\) \{[\s\S]*0 \(disabled\)[\s\S]*1 \(all plans\)[\s\S]*high only[\s\S]*medium and above[\s\S]*\}/m,
        'Expected setup.html to describe Team Lead cutoff semantics with a live helper label.'
    );

    assert.match(
        setupSource,
        /case 'teamLeadRoutingSettings':[\s\S]*teamLeadComplexityCutoffInput\.value = String\(message\.complexityCutoff \?\? 0\);[\s\S]*teamLeadComplexityCutoffLabel\.textContent = describeTeamLeadCutoff\(message\.complexityCutoff \?\? 0\);[\s\S]*case 'kanbanStructure':[\s\S]*lastKanbanStructure = message\.items;[\s\S]*renderKanbanStructureList\(\);/m,
        'Expected setup hydration to populate Team Lead routing cutoff and the canonical Kanban structure payload.'
    );

    assert.match(
        setupSource,
        /const PROMPT_ROLES = \[[\s\S]*\{ key: 'team-lead', label: 'Team Lead' \},[\s\S]*\];/m,
        'Expected setup.html custom prompts modal to include Team Lead.'
    );

    assert.doesNotMatch(
        implementationSource,
        /id="onboard-cli-team-lead"/,
        'Expected onboarding to remove the Team Lead command field from the standard agent setup list.'
    );

    assert.doesNotMatch(
        implementationSource,
        /class="onboard-agent-toggle"[^>]*data-role="team-lead"/m,
        'Expected onboarding to remove the Team Lead visibility toggle from the standard agent setup list.'
    );

    assert.doesNotMatch(
        implementationSource,
        /class="agent-visible-toggle"[^>]*data-role="team-lead"/m,
        'Expected terminal operations to remove the Team Lead visibility toggle from the standard agent list.'
    );

    assert.match(
        implementationSource,
        /function shouldShowTeamLeadSidebarRow\(\) \{[\s\S]*lastVisibleAgents\['team-lead'\] !== true[\s\S]*\(lastStartupCommands\['team-lead'\] \|\| ''\)\.trim\(\)[\s\S]*Object\.keys\(lastTerminals \|\| \{\}\)\.some\(key => lastTerminals\[key\]\?\.role === 'team-lead'\)[\s\S]*dispatchInfo\.terminalName[\s\S]*dispatchInfo\.state === 'ready' \|\| dispatchInfo\.state === 'recoverable'[\s\S]*\}/m,
        'Expected implementation.html to gate the Team Lead sidebar row on explicit visibility plus a reachable Team Lead route.'
    );

    assert.match(
        implementationSource,
        /\.\.\.\(shouldShowTeamLeadSidebarRow\(\) \? \['team-lead'\] : \[\]\),/,
        'Expected connected-agent guard logic to reuse the Team Lead sidebar helper.'
    );

    assert.match(
        implementationSource,
        /if \(shouldShowTeamLeadSidebarRow\(\)\) \{[\s\S]*createAgentRow\('TEAM LEAD', 'team-lead',[\s\S]*terminals => Object\.keys\(terminals\)\.find\(key => terminals\[key\]\.role === 'team-lead'\)/m,
        'Expected sidebar agent list to keep the Team Lead dispatch row behind the Team Lead sidebar helper.'
    );

    assert.match(
        extensionSource,
        /const startupCommands = await taskViewerProvider\.getStartupCommands\(\);[\s\S]*const teamLeadCommand = \(startupCommands\['team-lead'\] \|\| ''\)\.trim\(\);[\s\S]*if \(visibleAgents\['team-lead'\] === true && teamLeadCommand\) \{[\s\S]*allBuiltInAgents\.push\(\{ name: 'Team Lead', role: 'team-lead' \}\);[\s\S]*\}[\s\S]*for \(const agent of agents\) \{[\s\S]*let cmd = startupCommands\[agent\.role\];/m,
        'Expected createAgentGrid() to launch Team Lead only when it is explicitly visible and has a configured startup command.'
    );

    assert.match(
        kanbanSource,
        /let lastVisibleAgents = \{[\s\S]*'team-lead': false[\s\S]*jules: true \};/m,
        'Expected kanban.html bootstrap visibility to keep Team Lead hidden by default.'
    );

    assert.match(
        agentConfigSource,
        /\{ id: 'TEAM LEAD CODED', label: 'Team Lead', role: 'team-lead', order: 170, kind: 'coded', autobanEnabled: true, dragDropMode: 'cli', hideWhenNoAgent: true \}/,
        'Expected TEAM LEAD CODED to remain a hideWhenNoAgent column.'
    );

    assert.match(
        kanbanProviderSource,
        /if \(occupiedColumns\.has\(col\.id\)\) return true;/,
        'Expected KanbanProvider to keep occupied hidden columns visible.'
    );

    console.log('team lead visibility defaults regression test passed');
}

try {
    run();
} catch (error) {
    console.error('team lead visibility defaults regression test failed:', error);
    process.exit(1);
}
