'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { loadOutModule, withWorkspace } = require('./integrations/shared/test-harness');
const { installVsCodeMock } = require('./integrations/shared/vscode-mock');
const { SecretStorageMock } = require('./integrations/shared/secret-storage-mock');

async function runTests() {
    console.log('--- Running integration-config-write-guard tests ---');

    const vsMock = installVsCodeMock();
    const { GlobalIntegrationConfigService } = loadOutModule('services/GlobalIntegrationConfigService');
    const { ClickUpSyncService } = loadOutModule('services/ClickUpSyncService');
    const { LinearSyncService } = loadOutModule('services/LinearSyncService');
    vsMock.restore();

    await withWorkspace('write-guard-test', async ({ workspaceRoot }) => {
        // Test 2a: GlobalIntegrationConfigService merge preserves absent keys
        const initialConfig = {
            workspaceId: '6909707',
            selectedSpaceId: 'sp-1',
            selectedFolderId: 'fo-1',
            selectedListId: 'li-1',
            columnMappings: { todo: 'c1' }
        };
        await GlobalIntegrationConfigService.saveConfig('clickup', initialConfig, { replace: true });

        const saveRes2a = await GlobalIntegrationConfigService.saveConfig('clickup', { workspaceId: '6909707', selectedSpaceId: 'sp-2' });
        assert.strictEqual(saveRes2a.saved, true);
        const loaded2a = await GlobalIntegrationConfigService.loadConfig('clickup');
        assert.strictEqual(loaded2a.selectedSpaceId, 'sp-2');
        assert.strictEqual(loaded2a.selectedListId, 'li-1');
        assert.deepStrictEqual(loaded2a.columnMappings, { todo: 'c1' });
        console.log('✓ 2a: GlobalIntegrationConfigService merge preserves absent keys');

        // Test 2b: ClickUpSyncService layer merge over stored config
        const secretStorage = new SecretStorageMock();
        const clickUpService = new ClickUpSyncService(workspaceRoot, secretStorage);
        await clickUpService.saveConfig(initialConfig, { replace: true });

        await clickUpService.saveConfig({ workspaceId: '6909707', selectedSpaceId: 'sp-3' });
        const loaded2b = await GlobalIntegrationConfigService.loadConfig('clickup');
        assert.strictEqual(loaded2b.selectedSpaceId, 'sp-3');
        assert.strictEqual(loaded2b.selectedListId, 'li-1');
        console.log('✓ 2b: ClickUpSyncService layer merges over stored config');

        // Test 3: Explicit clears still work
        await clickUpService.saveConfig({ workspaceId: '6909707', selectedListId: '' });
        const loaded3 = await GlobalIntegrationConfigService.loadConfig('clickup');
        assert.strictEqual(loaded3.selectedListId, '');
        console.log('✓ 3: Explicit clear overwrites stored value');

        // Test 3b: clearConfig removes key
        await GlobalIntegrationConfigService.clearConfig('clickup');
        const loaded3b = await GlobalIntegrationConfigService.loadConfig('clickup');
        assert.strictEqual(loaded3b, null);
        console.log('✓ 3b: clearConfig removes provider key');

        // Test 4: 2026-07-30 corruption replayed & blocked by identity continuity guard
        await GlobalIntegrationConfigService.saveConfig('clickup', initialConfig, { replace: true });
        const badFixture = {
            workspaceId: 'ws-123',
            setupComplete: true
        };
        const res4 = await clickUpService.saveConfig(badFixture);
        assert.strictEqual(res4.saved, false);
        assert.ok(res4.reason.includes('Refusing identity change'));
        const loaded4 = await GlobalIntegrationConfigService.loadConfig('clickup');
        assert.strictEqual(loaded4.workspaceId, '6909707');
        assert.strictEqual(loaded4.selectedListId, 'li-1');
        console.log('✓ 4: Identity continuity guard blocked 2026-07-30 corruption write');

        // Test 4b: Wipe guard refuses all-empty blob
        const emptyBlob = { setupComplete: false, workspaceId: '', selectedSpaceId: '', selectedFolderId: '', selectedListId: '', columnMappings: {}, customFields: {} };
        const res4b = await GlobalIntegrationConfigService.saveConfig('clickup', emptyBlob);
        assert.strictEqual(res4b.saved, false);
        assert.ok(res4b.reason.includes('wipe guard'));
        console.log('✓ 4b: Wipe guard refuses all-empty blob');

        // Test 5: Identity continuity guard truth table
        // 5.1 stored 6909707 -> incoming ws-123 without replace => refused
        const res5_1 = await GlobalIntegrationConfigService.saveConfig('clickup', { workspaceId: 'ws-123' });
        assert.strictEqual(res5_1.saved, false);

        // 5.2 stored 6909707 -> incoming 9999999 without replace => refused
        const res5_2 = await GlobalIntegrationConfigService.saveConfig('clickup', { workspaceId: '9999999' });
        assert.strictEqual(res5_2.saved, false);

        // 5.3 stored 6909707 -> incoming 6909707 => accepted
        const res5_3 = await GlobalIntegrationConfigService.saveConfig('clickup', { workspaceId: '6909707' });
        assert.strictEqual(res5_3.saved, true);

        // 5.4 stored empty -> incoming 6909707 => accepted
        await GlobalIntegrationConfigService.clearConfig('clickup');
        const res5_4 = await GlobalIntegrationConfigService.saveConfig('clickup', { workspaceId: '6909707' });
        assert.strictEqual(res5_4.saved, true);

        // 5.5 stored 6909707 -> incoming ws-123 with replace: true => accepted
        const res5_5 = await GlobalIntegrationConfigService.saveConfig('clickup', { workspaceId: 'ws-123' }, { replace: true });
        assert.strictEqual(res5_5.saved, true);

        // 5.6 non-numeric legitimate-looking id with replace: true => accepted
        const res5_6 = await GlobalIntegrationConfigService.saveConfig('clickup', { workspaceId: 'us-6909707' }, { replace: true });
        assert.strictEqual(res5_6.saved, true);
        console.log('✓ 5: Identity continuity truth table verified');

        // Test 5b: Linear teamId truth table with team key 'ENG'
        await GlobalIntegrationConfigService.saveConfig('linear', { teamId: '11111111-2222-3333-4444-555555555555' }, { replace: true });
        const res5b = await GlobalIntegrationConfigService.saveConfig('linear', { teamId: 'ENG' }, { replace: true });
        assert.strictEqual(res5b.saved, true);
        console.log('✓ 5b: Linear team key accepted with replace option');

        // Test 6: Bare {} and unconfigured blobs accepted
        await GlobalIntegrationConfigService.clearConfig('linear');
        await GlobalIntegrationConfigService.saveConfig('linear', {}, { replace: true });
        const loaded6 = await GlobalIntegrationConfigService.loadConfig('linear');
        assert.deepStrictEqual(loaded6, {});
        console.log('✓ 6: Bare {} blob accepted');

        // Test 7: Deleted keys stay deleted with replace path
        await GlobalIntegrationConfigService.saveConfig('linear', { teamId: 't1', projectId: 'p1' }, { replace: true });
        const linearService = new LinearSyncService(workspaceRoot, secretStorage);
        await linearService.saveConfig({ teamId: 't1', includeProjectNames: ['Proj 1'] }, { replace: true });
        const loaded7 = await GlobalIntegrationConfigService.loadConfig('linear');
        assert.strictEqual(loaded7.projectId, undefined);
        assert.deepStrictEqual(loaded7.includeProjectNames, ['Proj 1']);
        console.log('✓ 7: Replace path deletes omitted keys as expected');

        // Test 9: Stale-id heal
        const { installHttpsMock } = require('./integrations/shared/http-mock-helpers');
        const httpsMock = installHttpsMock();

        await clickUpService.saveConfig({ workspaceId: 'ws-123', setupComplete: true }, { replace: true });
        await secretStorage.store('switchboard.clickup.apiToken', 'test-token');

        httpsMock.queueJson(400, { err: 'Invalid workspace id: ws-123', ECODE: 'SHARD_024' }, (req) => req.path.includes('/team/ws-123/space'));
        httpsMock.queueJson(200, { teams: [{ id: '6909707', name: 'Tech Team' }] }, (req) => req.path === '/api/v2/team');
        httpsMock.queueJson(200, { spaces: [{ id: 'sp1', name: 'Space 1' }] }, (req) => req.path.includes('/team/6909707/space'));

        const spaces9 = await clickUpService.getSpaces();
        assert.strictEqual(spaces9.length, 1);
        assert.strictEqual(spaces9[0].id, 'sp1');
        const reloadedConfig9 = await GlobalIntegrationConfigService.loadConfig('clickup');
        assert.strictEqual(reloadedConfig9.workspaceId, '6909707');
        httpsMock.restore();
        console.log('✓ 9: Stale-id heal re-resolved and updated stored config');

        // Test 9c: Non-JSON raw string body heals on status 400 alone
        const httpsMock9c = installHttpsMock();
        await clickUpService.saveConfig({ workspaceId: 'ws-bad-raw', setupComplete: true }, { replace: true });

        httpsMock9c.queueRaw(400, '<html>Bad Request</html>', (req) => req.path.includes('/team/ws-bad-raw/space'));
        httpsMock9c.queueJson(200, { teams: [{ id: '6909707', name: 'Tech Team' }] }, (req) => req.path === '/api/v2/team');
        httpsMock9c.queueJson(200, { spaces: [{ id: 'sp1', name: 'Space 1' }] }, (req) => req.path.includes('/team/6909707/space'));

        const spaces9c = await clickUpService.getSpaces();
        assert.strictEqual(spaces9c.length, 1);
        httpsMock9c.restore();
        console.log('✓ 9c: Non-JSON body heals on status 400 alone');

        // Test 9d: Classification table
        const classificationCases = [
            { name: '400 + SHARD_024', status: 400, ecode: 'SHARD_024', shouldHeal: true },
            { name: '400 + SHARD_099 (undocumented)', status: 400, ecode: 'SHARD_099', shouldHeal: true },
            { name: '404 + TEAM_001', status: 404, ecode: 'TEAM_001', shouldHeal: true },
            { name: '401 + OAUTH_023', status: 401, ecode: 'OAUTH_023', shouldHeal: false },
            { name: '403 + ACCESS_078', status: 403, ecode: 'ACCESS_078', shouldHeal: false }
        ];

        for (const item of classificationCases) {
            const mock = installHttpsMock();
            await clickUpService.saveConfig({ workspaceId: 'ws-test', setupComplete: true }, { replace: true });
            mock.queueJson(item.status, { err: 'Error', ECODE: item.ecode }, (req) => req.path.includes('/team/ws-test/space'));
            if (item.shouldHeal) {
                mock.queueJson(200, { teams: [{ id: '6909707' }] }, (req) => req.path === '/api/v2/team');
                mock.queueJson(200, { spaces: [{ id: 's1', name: 'S1' }] }, (req) => req.path.includes('/team/6909707/space'));
                const res = await clickUpService.getSpaces();
                assert.strictEqual(res.length, 1);
            } else {
                await assert.rejects(async () => {
                    await clickUpService.getSpaces();
                });
                assert.strictEqual(mock.requests.length, 1); // No /team call was made
            }
            mock.restore();
        }
        console.log('✓ 9d: Classification table verified');

        // Test 10: Legible terminal failure
        const mock10 = installHttpsMock();
        await clickUpService.saveConfig({ workspaceId: 'ws-fail', setupComplete: true }, { replace: true });
        mock10.queueJson(400, { err: 'Specific ClickUp Error Detail', ECODE: 'SHARD_024' }, (req) => req.path.includes('/team/ws-fail/space'));
        mock10.queueJson(400, { err: 'Team fetch failed' }, (req) => req.path === '/api/v2/team');

        await assert.rejects(async () => {
            await clickUpService.getSpaces();
        }, (err) => {
            assert.ok(err.message.includes('workspace ws-fail'));
            assert.ok(err.message.includes('Specific ClickUp Error Detail'));
            return true;
        });
        mock10.restore();
        console.log('✓ 10: Legible terminal failure output verified');
    });

    console.log('All integration-config-write-guard tests passed successfully.');
}

runTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
