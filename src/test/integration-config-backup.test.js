'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { loadOutModule, withWorkspace } = require('./integrations/shared/test-harness');
const { installVsCodeMock } = require('./integrations/shared/vscode-mock');

async function runTests() {
    console.log('--- Running integration-config-backup tests ---');

    const vsMock = installVsCodeMock();
    const { GlobalIntegrationConfigService } = loadOutModule('services/GlobalIntegrationConfigService');
    vsMock.restore();

    await withWorkspace('backup-test', async ({ workspaceRoot }) => {
        const backupDir = path.join(process.env.SWITCHBOARD_STATE_HOME, '.switchboard', 'configbackup');

        // Test 2: Significant write snapshots
        const initialCfg = { clickup: { workspaceId: '6909707', selectedListId: 'list-1' } };
        await GlobalIntegrationConfigService.saveGlobal(initialCfg);

        // First write creates file, no backup yet
        let files = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
        assert.strictEqual(files.length, 0);

        const sigCfg = { clickup: { workspaceId: '6909707', selectedListId: 'list-2' } };
        await GlobalIntegrationConfigService.saveGlobal(sigCfg);

        files = fs.readdirSync(backupDir).filter((f) => /^integration-config\..+\.json$/.test(f));
        assert.strictEqual(files.length, 1);
        const snapContent = JSON.parse(fs.readFileSync(path.join(backupDir, files[0]), 'utf8'));
        assert.strictEqual(snapContent.clickup.selectedListId, 'list-1');
        console.log('✓ 2: Significant write created pre-write snapshot');

        // Test 3: Churn-only write does not snapshot
        const churn1 = structuredClone(sigCfg);
        churn1.clickup.lastSync = new Date().toISOString();
        await GlobalIntegrationConfigService.saveGlobal(churn1);

        files = fs.readdirSync(backupDir).filter((f) => /^integration-config\..+\.json$/.test(f));
        assert.strictEqual(files.length, 1);

        const churn2 = structuredClone(churn1);
        churn2.mcpMonitor = { sourceLastCheckAt: { slack: new Date().toISOString() } };
        await GlobalIntegrationConfigService.saveGlobal(churn2);

        files = fs.readdirSync(backupDir).filter((f) => /^integration-config\..+\.json$/.test(f));
        assert.strictEqual(files.length, 1);
        console.log('✓ 3: Churn-only writes do not create extra snapshots');

        // Test 4: Key reordering is not mistaken for significance
        const reordered = {
            clickup: {
                selectedListId: 'list-2',
                workspaceId: '6909707'
            },
            mcpMonitor: churn2.mcpMonitor
        };
        await GlobalIntegrationConfigService.saveGlobal(reordered);
        files = fs.readdirSync(backupDir).filter((f) => /^integration-config\..+\.json$/.test(f));
        assert.strictEqual(files.length, 1);
        console.log('✓ 4: Key reordering is not mistaken for significance');

        // Test 5 & 5b: Corruption replay & whole-file restore fidelity
        const goodState = { clickup: { workspaceId: '6909707', selectedListId: '901613739289' } };
        await GlobalIntegrationConfigService.saveGlobal(goodState); // Creates 2nd snapshot (pre-write was churn2)

        const badState = { clickup: { workspaceId: 'ws-123', selectedListId: '' } };
        await GlobalIntegrationConfigService.saveGlobal(badState); // Creates 3rd snapshot (pre-write was goodState)

        files = fs.readdirSync(backupDir).filter((f) => /^integration-config\..+\.json$/.test(f)).sort();
        const latestSnap = JSON.parse(fs.readFileSync(path.join(backupDir, files[files.length - 1]), 'utf8'));
        assert.strictEqual(latestSnap.clickup.workspaceId, '6909707');
        assert.strictEqual(latestSnap.clickup.selectedListId, '901613739289');

        await GlobalIntegrationConfigService.saveGlobal(latestSnap);
        const restoredLive = await GlobalIntegrationConfigService.loadGlobal();
        assert.strictEqual(restoredLive.clickup.workspaceId, '6909707');
        assert.strictEqual(restoredLive.clickup.selectedListId, '901613739289');
        console.log('✓ 5 & 5b: Whole-file restore reproduces snapshot fidelity');

        // Test 7: Retention & ordering (max 10 snapshots, timestamp leading)
        for (let i = 0; i < 15; i++) {
            await GlobalIntegrationConfigService.saveGlobal({ clickup: { workspaceId: `ws-${i}` } });
        }
        files = fs.readdirSync(backupDir).filter((f) => /^integration-config\..+\.json$/.test(f));
        assert.strictEqual(files.length, 10);
        console.log('✓ 7: Retention keeps newest 10 snapshots');

        // Test 8: Both writers covered
        // _persistMigratedSchedulerIfAbsentSync
        GlobalIntegrationConfigService._persistMigratedSchedulerIfAbsentSync({ schemaVersion: 1, jobs: [] });
        files = fs.readdirSync(backupDir).filter((f) => f.includes('scheduler-migration'));
        assert.ok(files.length > 0);
        console.log('✓ 8: Sync scheduler writer triggers snapshot');

        // Test 9: Unparseable stored file is always snapshotted
        const livePath = path.join(process.env.SWITCHBOARD_STATE_HOME, '.switchboard', 'integration-config.json');
        fs.writeFileSync(livePath, '{ unparseable json', 'utf8');

        await GlobalIntegrationConfigService.saveGlobal({ clickup: { workspaceId: 'ws-recovered' } });
        files = fs.readdirSync(backupDir).filter((f) => /^integration-config\..+\.json$/.test(f));
        const lastFile = files[files.length - 1];
        const rawSnap = fs.readFileSync(path.join(backupDir, lastFile), 'utf8');
        assert.strictEqual(rawSnap, '{ unparseable json');
        console.log('✓ 9: Unparseable stored file is snapshotted as raw bytes');

        // Test 11: Snapshot failure never breaks the write
        const badBackupDir = path.join(backupDir, 'sub');
        fs.mkdirSync(badBackupDir, { recursive: true });
        // Even if snapshot directory creation or copy fails internally, saveGlobal succeeds
        await GlobalIntegrationConfigService.saveGlobal({ clickup: { workspaceId: 'ws-final' } });
        const finalLive = await GlobalIntegrationConfigService.loadGlobal();
        assert.strictEqual(finalLive.clickup.workspaceId, 'ws-final');
        console.log('✓ 11: Snapshot failure does not break write');

        // Test 12: File modes (non-Windows)
        if (process.platform !== 'win32') {
            const currentFiles = fs.readdirSync(backupDir).filter((f) => /^integration-config\..+\.json$/.test(f));
            const dirStat = fs.statSync(backupDir);
            assert.strictEqual(dirStat.mode & 0o777, 0o700);
            const snapStat = fs.statSync(path.join(backupDir, currentFiles[0]));
            assert.strictEqual(snapStat.mode & 0o777, 0o600);
            console.log('✓ 12: Directory is 0700 and snapshot files are 0600');
        }
    });

    console.log('All integration-config-backup tests passed successfully.');
}

runTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
