'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const dbPath = path.join(__dirname, '..', 'services', 'KanbanDatabase.ts');
const providerSource = fs.readFileSync(providerPath, 'utf8');
const dbSource = fs.readFileSync(dbPath, 'utf8');

describe('brain delete tombstone regressions', () => {
    it('resolves existing tombstone targets by plan id instead of hash-shaped session id', () => {
        assert.match(
            providerSource,
            /private async _addTombstone\(workspaceRoot: string, hash: string, sessionId\?: string\): Promise<void> \{[\s\S]*const existing = await db\.getPlanByPlanId\(hash\);/,
            'Expected _addTombstone to look up existing Antigravity rows by planId.'
        );
        assert.match(
            dbSource,
            /public async getPlanByPlanId\(planId: string\): Promise<KanbanPlanRecord \| null> \{[\s\S]*WHERE plan_id = \? LIMIT 1/,
            'Expected KanbanDatabase to expose plan-id lookup for tombstone resolution.'
        );
    });

    it('keeps deleted brain rows as tombstones instead of removing them after delete confirmation', () => {
        assert.match(
            providerSource,
            /const db = await this\._getKanbanDb\(resolvedWorkspaceRoot\);\s*if \(db && !brainSourcePath\) \{\s*await db\.deletePlan\(sessionId\);\s*\}/,
            'Expected _handleDeletePlan to retain deleted brain rows in the DB as tombstones.'
        );
    });
});
