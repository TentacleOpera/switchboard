'use strict';
/**
 * Contract: the memo panel binds to the CURRENT workspace, and a generated
 * planner prompt's plansDir and PROJECT PIN come from the SAME workspace.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { createHeadlessTestHarness } = require('./helpers/verbEngineTestSeams');

async function runTest() {
    const REPO_ROOT = path.join(__dirname, '..', '..');
    const tmpWsA = path.join(REPO_ROOT, '.switchboard', 'test-memo-ws-a');
    const tmpWsB = path.join(REPO_ROOT, '.switchboard', 'test-memo-ws-b');
    fs.mkdirSync(tmpWsA, { recursive: true });
    fs.mkdirSync(tmpWsB, { recursive: true });

    const { taskViewer, kanbanProvider, apiOptions, recorders } = createHeadlessTestHarness({
        workspaceRoot: tmpWsA,
        secrets: {},
    });

    const lastPrompt = () => recorders.clipboardWrites[recorders.clipboardWrites.length - 1] || '';

    // 1. The served panel carries the CURRENT root
    taskViewer.__setWorkspaceRoot(tmpWsA);
    let html = (await apiOptions.serveStatic.getPanelHtml('memo')).html;
    assert.ok(html.includes(encodeURIComponent(tmpWsA)), 'memo panel HTML missing ws-a root');

    taskViewer.__setWorkspaceRoot(tmpWsB);
    html = (await apiOptions.serveStatic.getPanelHtml('memo')).html;
    assert.ok(html.includes(encodeURIComponent(tmpWsB)), 'memo panel HTML did not update to ws-b root');

    // 2. A project that does not exist in destination workspace is NOT pinned
    kanbanProvider._projectFilter = 'Browser Switchboard';
    kanbanProvider._currentWorkspaceRoot = tmpWsA;
    await taskViewer.handleServiceVerb('memoGeneratePrompt', {
        content: 'Bug: one',
        action: 'copy',
        workspaceRoot: tmpWsB,
    });
    assert.ok(lastPrompt().includes(tmpWsB), 'plansDir wrong');
    assert.ok(!/PROJECT PIN/.test(lastPrompt()), 'emitted PROJECT PIN for non-existent project in destination workspace');

    // 3. Project that DOES exist is pinned when workspace matches
    const dbB = await taskViewer._getKanbanDb(tmpWsB);
    if (dbB) {
        const wsIdB = (await dbB.getWorkspaceId?.()) || (await dbB.getDominantWorkspaceId?.()) || '';
        if (wsIdB && typeof dbB.addProject === 'function') {
            await dbB.addProject(wsIdB, 'Real Project');
        }
    }
    kanbanProvider._projectFilter = 'Real Project';
    kanbanProvider._currentWorkspaceRoot = tmpWsB;
    await taskViewer.handleServiceVerb('memoGeneratePrompt', {
        content: 'Bug: one',
        action: 'copy',
        workspaceRoot: tmpWsB,
    });
    assert.match(lastPrompt(), /PROJECT PIN[\s\S]*Real Project/);

    // 3b. Same filter is NOT pinned when board is on another workspace
    kanbanProvider._currentWorkspaceRoot = tmpWsA;
    await taskViewer.handleServiceVerb('memoGeneratePrompt', {
        content: 'Bug: one',
        action: 'copy',
        workspaceRoot: tmpWsB,
    });
    assert.ok(!/PROJECT PIN/.test(lastPrompt()), 'in-memory _projectFilter leaked across workspaces');

    // 4. memo.js check
    const memoJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'memo.js'), 'utf8');
    assert.match(memoJs, /workspaceChanged/);
    assert.ok(!/workspaceRoot:\s*WS_ROOT/.test(memoJs), 'memo.js posts WS_ROOT directly');

    // Cleanup
    fs.rmSync(tmpWsA, { recursive: true, force: true });
    fs.rmSync(tmpWsB, { recursive: true, force: true });
    console.log('memo-panel-workspace-binding-contract: OK');
}

runTest().catch((err) => {
    console.error(err);
    process.exit(1);
});
