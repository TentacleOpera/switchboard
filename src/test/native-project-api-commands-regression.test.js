'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readSource(...segments) {
    return fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8');
}

function run() {
    const extensionSource = readSource('src', 'extension.ts');
    const clickupSource = readSource('src', 'services', 'ClickUpSyncService.ts');
    const linearSource = readSource('src', 'services', 'LinearSyncService.ts');
    const providerSource = readSource('src', 'services', 'TaskViewerProvider.ts');

    [
        'switchboard.clickupFindList',
        'switchboard.clickupFindTask',
        'switchboard.clickupSearchTasks',
        'switchboard.clickupGetSubtasks',
        'switchboard.clickupCreateTask',
        'switchboard.clickupUpdateTask',
        'switchboard.clickupAddComment',
        'switchboard.linearQueryIssues',
        'switchboard.linearGetIssue',
        'switchboard.linearUpdateState',
        'switchboard.linearAddComment',
        'switchboard.linearUpdateDescription'
    ].forEach((commandId) => {
        const escapedCommandId = commandId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assert.match(
            extensionSource,
            new RegExp(`registerCommand\\([\\s\\S]*'${escapedCommandId}'`),
            `Expected extension.ts to register ${commandId}.`
        );
    });

    assert.match(
        clickupSource,
        /export interface ClickUpList \{[\s\S]*id: string;[\s\S]*name: string;/m,
        'Expected ClickUpSyncService to export a ClickUpList type for native command responses.'
    );
    assert.match(
        clickupSource,
        /export interface ClickUpTask \{[\s\S]*id: string;[\s\S]*name: string;[\s\S]*description: string;/m,
        'Expected ClickUpSyncService to export a ClickUpTask type for native command responses.'
    );
    assert.match(
        clickupSource,
        /public async findList\(listName: string\): Promise<ClickUpList\[]>/m,
        'Expected ClickUpSyncService to expose findList for native commands.'
    );
    assert.match(
        clickupSource,
        /public async findTask\(listId: string, taskName: string\): Promise<ClickUpTask\[]>/m,
        'Expected ClickUpSyncService to expose findTask for native commands.'
    );
    assert.match(
        clickupSource,
        /public async searchTasks\(query: string, listId\?: string\): Promise<ClickUpTask\[]>/m,
        'Expected ClickUpSyncService to expose searchTasks for native commands.'
    );
    assert.match(
        clickupSource,
        /public async getSubtasks\(parentId: string\): Promise<ClickUpTask\[]>/m,
        'Expected ClickUpSyncService to expose getSubtasks for native commands.'
    );
    assert.match(
        clickupSource,
        /public async createTask\([\s\S]*\): Promise<ClickUpTask \| null>/m,
        'Expected ClickUpSyncService to expose createTask for native commands.'
    );
    assert.match(
        clickupSource,
        /public async updateTask\([\s\S]*\): Promise<void>/m,
        'Expected ClickUpSyncService to expose updateTask for native commands.'
    );
    assert.match(
        clickupSource,
        /public async addTaskComment\(taskId: string, comment: string\): Promise<void>/m,
        'Expected ClickUpSyncService to expose addTaskComment for native commands.'
    );

    assert.match(
        linearSource,
        /export interface LinearIssue \{[\s\S]*identifier: string;[\s\S]*title: string;/m,
        'Expected LinearSyncService to export a LinearIssue type for native command responses.'
    );
    assert.match(
        linearSource,
        /public async queryIssues\(\s*options: \{[\s\S]*search\?: string;[\s\S]*stateId\?: string;[\s\S]*\}\): Promise<LinearIssue\[]>/m,
        'Expected LinearSyncService to expose queryIssues with search support for native commands.'
    );
    assert.match(
        linearSource,
        /public async getIssue\(issueIdOrIdentifier: string\): Promise<LinearIssue \| null>/m,
        'Expected LinearSyncService to expose getIssue for native commands.'
    );
    assert.match(
        linearSource,
        /public async updateIssueState\(issueId: string, stateId: string\): Promise<void>/m,
        'Expected LinearSyncService to expose updateIssueState for native commands.'
    );
    assert.match(
        linearSource,
        /public async addIssueComment\(issueId: string, comment: string\): Promise<void>/m,
        'Expected LinearSyncService to expose addIssueComment for native commands.'
    );
    assert.match(
        linearSource,
        /public async updateIssueDescription\(issueId: string, description: string\): Promise<void>/m,
        'Expected LinearSyncService to expose updateIssueDescription for native commands.'
    );

    [
        'handleClickupFindList',
        'handleClickupFindTask',
        'handleClickupSearchTasks',
        'handleClickupGetSubtasks',
        'handleClickupCreateTask',
        'handleClickupUpdateTask',
        'handleClickupAddComment',
        'handleLinearQueryIssues',
        'handleLinearGetIssue',
        'handleLinearUpdateState',
        'handleLinearAddComment',
        'handleLinearUpdateDescription'
    ].forEach((handlerName) => {
        assert.ok(
            providerSource.includes(`public async ${handlerName}`),
            `Expected TaskViewerProvider to expose ${handlerName} for native integration commands.`
        );
    });

    assert.match(
        providerSource,
        /public async handleLinearQueryIssues\(options\?: \{[\s\S]*search\?: string;[\s\S]*stateId\?: string;[\s\S]*\}\): Promise<\{ success: boolean; issues: LinearIssue\[]; count: number; error\?: string \}>/m,
        'Expected TaskViewerProvider to forward Linear query search options.'
    );
    assert.match(
        extensionSource,
        /'switchboard\.linearQueryIssues'[\s\S]*async \(options\?: \{ search\?: string; stateId\?: string; assigneeId\?: string; projectId\?: string; limit\?: number \}\)/m,
        'Expected extension.ts to register Linear query command with search-aware options.'
    );

    console.log('native project API command regression test passed');
}

try {
    run();
} catch (error) {
    console.error('native project API command regression test failed:', error);
    process.exit(1);
}
