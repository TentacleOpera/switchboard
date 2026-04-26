'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const kanbanSource = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'kanban.html'), 'utf8');
    const implementationSource = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'implementation.html'), 'utf8');
    const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
    const taskViewerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');

    assert.ok(
        kanbanSource.includes('<div class="kanban-board" id="kanban-board"></div>'),
        'Expected AUTOBAN to render the kanban board directly without an extra project view wrapper.'
    );
    [
        'main-view-tabs',
        'project-view-toggle',
        'kanban-view-toggle',
        'project-panel',
        'project-list-view',
        'project-task-view',
        'linear-project-search',
        'detail-ask-agent',
        'renderLinearProjectPanel',
        'linearLoadProject'
    ].forEach((unexpected) => {
        assert.ok(
            !kanbanSource.includes(unexpected),
            `Expected AUTOBAN to no longer include stale project-view artifact "${unexpected}".`
        );
    });
    assert.match(
        implementationSource,
        /<button[^>]*data-tab="project">/,
        'Expected the main implementation sidebar to expose a visible Project tab alongside Agents, Planning, and Autoban.'
    );
    assert.match(
        implementationSource,
        /id="integration-tab-btn"/,
        'Expected integration tab button to have id for dynamic label updates.'
    );
    assert.ok(
        implementationSource.includes('id="agent-list-project"'),
        'Expected the implementation sidebar to define a dedicated Project tab panel container.'
    );
    [
        'sidebar-project-list-view',
        'sidebar-project-task-view',
        'sidebar-linear-project-search',
        'sidebar-linear-state-filter',
        'sidebar-linear-project-refresh',
        'sidebar-linear-project-empty',
        'sidebar-linear-project-open-setup',
        'sidebar-linear-issues-container',
        'sidebar-task-back-button',
        'sidebar-detail-task-title',
        'sidebar-detail-task-identifier',
        'sidebar-detail-task-state',
        'sidebar-detail-task-assignee',
        'sidebar-detail-task-description',
        'sidebar-detail-subtasks-list',
        'sidebar-detail-comments-list',
        'sidebar-detail-attachments-list',
        'sidebar-detail-ask-agent',
        'sidebar-detail-import-task'
    ].forEach((id) => {
        assert.ok(
            implementationSource.includes(`id="${id}"`),
            `Expected the implementation sidebar Project tab to include #${id}.`
        );
    });
    assert.match(
        implementationSource,
        /const tabs = \{ agents: agentListStandard, autoban: agentListAutoban, webai: agentListWebai, project: agentListProject \};/,
        'Expected sidebar tab switching to include the new Project tab panel.'
    );
    assert.match(
        implementationSource,
        /if \(tab === 'project'\) \{[\s\S]*renderSidebarLinearProjectPanel\(\);[\s\S]*loadLinearProject\(\);/s,
        'Expected the sidebar Project tab to render and load Linear data when selected.'
    );
    assert.match(
        implementationSource,
        /(const newHtml = )?filteredIssues\.map\(\(issue\) => `[\s\S]*escapeHtml\(issue\.title \|\| issue\.identifier \|\| issue\.id\)[\s\S]*escapeHtml\(issue\.state\?\.name \|\| 'Unknown state'\)/s,
        'Expected the sidebar Project list rendering to escape issue titles and state labels before injecting HTML.'
    );
    assert.match(
        implementationSource,
        /(const plainHtml = )?escapeHtml\(\(issue\.description \|\| ''\)\.trim\(\) \|\| 'No description provided\.'\)\.replace\(\/\\n\/g, '<br>'\)/,
        'Expected the sidebar Project detail rendering to escape issue descriptions before injecting HTML.'
    );
    assert.match(
        implementationSource,
        /type: 'copyTextToClipboard'/,
        'Expected the sidebar Project tab to support copying agent context.'
    );
    assert.match(
        implementationSource,
        /type: 'linearImportTask'/,
        'Expected the sidebar Project tab to support importing Linear tasks.'
    );
    assert.match(
        implementationSource,
        /type: 'openSetupPanel', section: 'project-mgmt'/,
        'Expected the sidebar Project tab to deep-link into Project Management setup.'
    );
    assert.doesNotMatch(
        implementationSource,
        /project-scope-required|Configure Linear project scope/,
        'Expected the sidebar Project tab not to block loading when no Linear project scope is configured.'
    );
    assert.doesNotMatch(
        taskViewerSource,
        /status:\s*'project-scope-required'/,
        'Expected the sidebar provider not to emit a project-scope-required gate for Linear project loading.'
    );
    assert.doesNotMatch(
        providerSource,
        /status:\s*'project-scope-required'/,
        'Expected the Kanban provider not to emit a project-scope-required gate for Linear project loading.'
    );
    assert.match(
        taskViewerSource,
        /const projectId = String\(config\.projectId \|\| ''\)\.trim\(\) \|\| undefined;[\s\S]*queryIssues\(\{[\s\S]*projectId,[\s\S]*\}\);[\s\S]*projectName = projectId[\s\S]*team-wide/s,
        'Expected sidebar Linear project loading to fall back to team-wide issues when no project is configured.'
    );
    assert.match(
        providerSource,
        /const projectId = String\(config\.projectId \|\| ''\)\.trim\(\) \|\| undefined;[\s\S]*queryIssues\(\{[\s\S]*projectId,[\s\S]*\}\);[\s\S]*projectName = projectId[\s\S]*team-wide/s,
        'Expected Kanban Linear project loading to fall back to team-wide issues when no project is configured.'
    );
    [
        'linearLoadProject',
        'linearLoadTaskDetails',
        'linearImportTask',
        'copyTextToClipboard',
        'linearProjectLoaded',
        'linearTaskDetailsLoaded',
        'linearTaskImported',
        'linearError'
    ].forEach((messageName) => {
        assert.ok(
            implementationSource.includes(messageName) || taskViewerSource.includes(messageName) || providerSource.includes(messageName),
            `Expected sidebar Linear project wiring to reference "${messageName}".`
        );
    });
    assert.match(
        taskViewerSource,
        /case 'linearLoadProject': \{[\s\S]*type: 'linearProjectLoaded'[\s\S]*case 'linearLoadTaskDetails': \{[\s\S]*type: 'linearTaskDetailsLoaded'[\s\S]*case 'linearImportTask': \{[\s\S]*type: 'linearTaskImported'[\s\S]*case 'copyTextToClipboard': \{[\s\S]*vscode\.env\.clipboard\.writeText\(text\);/s,
        'Expected the sidebar provider to serve Linear project data, imports, and clipboard actions.'
    );

    console.log('kanban linear project tab regression test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban linear project tab regression test failed:', error);
    process.exit(1);
}
