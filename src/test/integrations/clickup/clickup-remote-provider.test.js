'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { loadOutModule } = require('../shared/test-harness');

const { ClickUpRemoteProvider } = loadOutModule('services/remote/ClickUpRemoteProvider.js');

function makeClickUpService(config, tasksByList = {}) {
    return {
        loadConfig: async () => config,
        getListTasks: async (listId, options) => {
            return tasksByList[listId] || [];
        },
        getTaskDetails: async (taskId) => {
            // Find task across our mocks
            let found = null;
            for (const listId in tasksByList) {
                const matched = tasksByList[listId].find(t => t.id === taskId);
                if (matched) { found = matched; break; }
            }
            if (!found) {
                found = { id: taskId, name: 'Mock Task', markdownDescription: 'Mock Description' };
            }
            return { task: found };
        },
        syncPlan: async (plan) => {
            return { success: true };
        },
        syncPlanContent: async (remoteId, markdown) => {
            return { success: true };
        }
    };
}

function makeDb(plans = []) {
    return {
        findPlanByClickUpTaskId: async (ws, remoteId) => {
            return plans.find(p => p.clickupTaskId === remoteId) || null;
        },
        getAllPlans: async (ws) => {
            return plans;
        },
        updateClickUpTaskIdByPlanFile: async (planFile, ws, remoteId) => {
            const plan = plans.find(p => p.planFile === planFile);
            if (plan) { plan.clickupTaskId = remoteId; }
            return true;
        },
        insertFileDerivedPlan: async (rec) => {
            plans.push(rec);
            return true;
        },
        getPlanByPlanFile: async (planFile, ws) => {
            return plans.find(p => p.planFile === planFile) || null;
        }
    };
}

async function run() {
    const config = {
        setupComplete: true,
        columnMappings: {
            'CREATED': 'list-created',
            'CODING': 'list-coding',
        }
    };

    const task1 = {
        id: 'task-1',
        name: 'Task One',
        markdownDescription: 'Desc One',
        dateUpdated: '1770000000000', // Epoch ms string
        list: { id: 'list-created' }
    };
    const task2 = {
        id: 'task-2',
        name: 'Task Two',
        markdownDescription: 'Desc Two',
        dateUpdated: '1771000000000',
        list: { id: 'list-coding' }
    };

    const tasksByList = {
        'list-created': [task1],
        'list-coding': [task2]
    };

    const clickup = makeClickUpService(config, tasksByList);
    const plansDb = [
        { planFile: '/tmp/p1.md', clickupTaskId: 'task-1', kanbanColumn: 'CREATED' }
    ];
    const db = makeDb(plansDb);

    const provider = new ClickUpRemoteProvider(clickup, {
        db,
        getWorkspaceId: async () => 'ws-1',
        getPlansDir: async () => '/tmp/plans',
    });

    // 1. Verify capabilities
    assert.strictEqual(provider.capabilities.pull, true);
    assert.strictEqual(provider.capabilities.push, true);
    assert.strictEqual(provider.capabilities.projectContextPush, false);
    assert.strictEqual(provider.capabilities.archive, false);

    // 2. Fetch State Deltas
    const deltasResult = await provider.fetchStateDeltas('2026-07-01T00:00:00Z');
    assert.strictEqual(deltasResult.deltas.length, 2);
    
    const d1 = deltasResult.deltas.find(d => d.remoteId === 'task-1');
    assert.ok(d1);
    assert.strictEqual(d1.stateKey, 'list-created');
    assert.strictEqual(d1.description, 'Desc One');

    // 3. stateKeyToColumn
    assert.strictEqual(provider.stateKeyToColumn('list-created'), 'CREATED');
    assert.strictEqual(provider.stateKeyToColumn('list-coding'), 'CODING');
    assert.strictEqual(provider.stateKeyToColumn('unknown'), undefined);

    // 4. importRemotePlan
    const imported = await provider.importRemotePlan('task-2');
    assert.ok(imported);
    assert.strictEqual(imported.clickupTaskId, 'task-2');

    // 5. refreshLocalPlanFromRemote
    // Setup file to verify write
    const testFile = path.join(__dirname, 'test-refresh.md');
    try {
        plansDb.push({ planFile: testFile, clickupTaskId: 'task-1', kanbanColumn: 'CREATED' });
        await provider.refreshLocalPlanFromRemote('task-1');
        const content = fs.readFileSync(testFile, 'utf8');
        assert.ok(content.includes('# Task One'));
        assert.ok(content.includes('Desc One'));
    } finally {
        if (fs.existsSync(testFile)) {
            fs.unlinkSync(testFile);
        }
    }

    console.log('clickup-remote-provider tests passed');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
