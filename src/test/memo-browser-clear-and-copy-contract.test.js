'use strict';
/**
 * Contract: the browser Memo panel's copy/send round trip clears the panel and
 * says so.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { createHeadlessTestHarness } = require('./helpers/verbEngineTestSeams');

async function runTest() {
    const REPO_ROOT = path.join(__dirname, '..', '..');
    const tmpWs = path.join(REPO_ROOT, '.switchboard', 'test-memo-clear-ws');
    fs.mkdirSync(tmpWs, { recursive: true });

    const { taskViewer, seams, recorders } = createHeadlessTestHarness({
        workspaceRoot: tmpWs,
        secrets: {},
    });

    const memoPath = path.join(tmpWs, '.switchboard', 'memo.md');

    // The arm's returned body is routable and reports the clear.
    const result = await taskViewer.handleServiceVerb('memoGeneratePrompt', {
        content: 'Bug: one\n\nBug: two',
        action: 'copy',
        workspaceRoot: tmpWs,
    });

    assert.strictEqual(result.type, 'memoPromptResult');
    assert.strictEqual(result.memoCleared, true);
    assert.strictEqual(result.action, 'copy');
    assert.match(result.message, /copied to clipboard/i);
    assert.strictEqual(fs.readFileSync(memoPath, 'utf8'), '');

    // The clipboard is written host-side through the seam, and prompt is NOT echoed back to browser
    const lastCopy = recorders.clipboardWrites[recorders.clipboardWrites.length - 1];
    assert.ok(typeof lastCopy === 'string' && lastCopy.includes('Issue 1'), 'host-side clipboard seam was not written');
    assert.strictEqual(result.prompt, undefined, 'response body echoes prompt');

    // Send failure preserves memo, says so, and satisfies return contract
    seams.dispatchResult = false;
    const failed = await taskViewer.handleServiceVerb('memoGeneratePrompt', {
        content: 'Bug: one',
        action: 'send',
        workspaceRoot: tmpWs,
    });

    assert.strictEqual(failed.memoCleared, false);
    assert.strictEqual(failed.isError, true);
    assert.strictEqual(failed.success, false);
    assert.ok(typeof failed.error === 'string' && failed.error.length > 0, 'failure body has no error');
    assert.strictEqual(failed.action, 'send');
    assert.notStrictEqual(fs.readFileSync(memoPath, 'utf8'), '');

    // Empty memo path
    const empty = await taskViewer.handleServiceVerb('memoGeneratePrompt', {
        content: '   ',
        action: 'copy',
        workspaceRoot: tmpWs,
    });
    assert.strictEqual(empty.type, 'memoPromptResult');
    assert.strictEqual(empty.memoCleared, false);

    // broadcaster apiServer wiring
    let broadcastRec = [];
    const fakeApiServer = {
        broadcastWs: (msg) => { broadcastRec.push(msg); }
    };
    taskViewer.setApiServer(fakeApiServer);
    await taskViewer.handleServiceVerb('memoLoad', { workspaceRoot: tmpWs });
    assert.ok(broadcastRec.some(b => b.type === 'memoContent'), 'TaskViewer push did not reach WS hub');

    // memo.js checks
    const memoJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'memo.js'), 'utf8');
    assert.match(memoJs, /memoCleared/);
    assert.match(memoJs, /_submittedContent/);

    // cleanup
    fs.rmSync(tmpWs, { recursive: true, force: true });
    console.log('memo-browser-clear-and-copy-contract: OK');
}

runTest().catch((err) => {
    console.error(err);
    process.exit(1);
});
