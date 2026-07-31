'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const { loadOutModule, withWorkspace } = require('./integrations/shared/test-harness');

async function runTests() {
    console.log('--- Running global-config-sandbox tests ---');

    // Test (a): Real file untouched
    const realConfigPath = path.join(os.homedir(), '.switchboard', 'integration-config.json');
    let realContentBefore = null;
    if (fs.existsSync(realConfigPath)) {
        realContentBefore = fs.readFileSync(realConfigPath, 'utf8');
    }

    const { installVsCodeMock } = require('./integrations/shared/vscode-mock');
    const vsMock = installVsCodeMock();
    const { ClickUpSyncService } = loadOutModule('services/ClickUpSyncService');
    vsMock.restore();
    await withWorkspace('sandbox-test', async ({ workspaceRoot }) => {
        const service = new ClickUpSyncService(workspaceRoot);
        const badFixture = {
            workspaceId: 'ws-123',
            setupComplete: true
        };
        await service.saveConfig(badFixture);

        const sandboxedStatePath = path.join(process.env.SWITCHBOARD_STATE_HOME, '.switchboard', 'integration-config.json');
        if (!fs.existsSync(sandboxedStatePath)) {
            throw new Error(`Expected sandboxed config file at ${sandboxedStatePath}`);
        }
        const sandboxedContent = fs.readFileSync(sandboxedStatePath, 'utf8');
        if (!sandboxedContent.includes('ws-123')) {
            throw new Error(`Sandboxed config file content missing ws-123: ${sandboxedContent}`);
        }
    });

    if (realContentBefore !== null) {
        const realContentAfter = fs.readFileSync(realConfigPath, 'utf8');
        if (realContentAfter !== realContentBefore) {
            throw new Error('Real integration-config.json was modified by test!');
        }
    }
    console.log('✓ (a) Real file untouched and sandboxed config written correctly');

    // Test (b): Fail-closed works
    const nodeCodeFailClosed = `
        delete process.env.SWITCHBOARD_STATE_HOME;
        process.env.SWITCHBOARD_TEST = '1';
        const { stateHome } = require('./out/utils/stateHome');
        stateHome();
    `;
    const envClean = { ...process.env };
    delete envClean.SWITCHBOARD_STATE_HOME;
    const resFailClosed = childProcess.spawnSync(process.execPath, ['-e', nodeCodeFailClosed], {
        cwd: process.cwd(),
        env: envClean,
        encoding: 'utf8'
    });
    if (resFailClosed.status === 0 || !resFailClosed.stderr.includes('SWITCHBOARD_STATE_HOME')) {
        throw new Error(`Expected fail-closed throw, got status ${resFailClosed.status}, stderr: ${resFailClosed.stderr}`);
    }
    console.log('✓ (b) Fail-closed guard threw as expected');

    // Test (c): No false positive in production shape
    const tempProdScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-prod-entry-'));
    const tempProdScript = path.join(tempProdScriptDir, 'app.js');
    fs.writeFileSync(tempProdScript, `
        delete process.env.SWITCHBOARD_STATE_HOME;
        delete process.env.SWITCHBOARD_TEST;
        const { isTestProcess, stateHome } = require(${JSON.stringify(path.join(process.cwd(), 'out', 'utils', 'stateHome'))});
        if (isTestProcess() !== false) { process.exit(10); }
        if (stateHome() !== require('os').homedir()) { process.exit(11); }
        process.exit(0);
    `);
    const resProd = childProcess.spawnSync(process.execPath, [tempProdScript], {
        cwd: process.cwd(),
        env: envClean,
        encoding: 'utf8'
    });
    fs.rmSync(tempProdScriptDir, { recursive: true, force: true });

    if (resProd.status !== 0) {
        throw new Error(`Expected production process to succeed with 0 exit code, got ${resProd.status}`);
    }
    console.log('✓ (c) Production process shape did not false-positive');

    console.log('All global-config-sandbox tests passed successfully.');
}

runTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
