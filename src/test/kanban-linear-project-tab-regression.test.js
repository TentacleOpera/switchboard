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
    assert.doesNotMatch(
        implementationSource,
        /<button[^>]*data-tab="project">/,
        'Expected the main implementation sidebar to not expose a Project tab.'
    );
    assert.doesNotMatch(
        implementationSource,
        /id="integration-tab-btn"/,
        'Expected integration tab button to be absent.'
    );
    assert.ok(
        !implementationSource.includes('id="agent-list-project"'),
        'Expected the implementation sidebar to not define a dedicated Project tab panel container.'
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
            !implementationSource.includes(`id="${id}"`),
            `Expected the implementation sidebar to not include #${id}.`
        );
    });
    assert.doesNotMatch(
        implementationSource,
        /project: agentListProject/,
        'Expected sidebar tab switching to not include project tab.'
    );
    assert.doesNotMatch(
        implementationSource,
        /renderSidebarLinearProjectPanel/,
        'Expected sidebar to not render Linear project panel.'
    );
    assert.doesNotMatch(
        implementationSource,
        /loadLinearProject/,
        'Expected sidebar to not load Linear project.'
    );
    assert.doesNotMatch(
        implementationSource,
        /type: 'clickupLoadProject'/,
        'Expected sidebar to not load ClickUp project.'
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
        /projectName =[\s\S]*team-wide/s,
        'Expected sidebar Linear project loading to fall back to team-wide issues when no project is configured.'
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
            taskViewerSource.includes(messageName) || providerSource.includes(messageName),
            `Expected background/Kanban provider Linear project wiring to reference "${messageName}".`
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
