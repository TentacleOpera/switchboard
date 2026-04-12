'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const source = fs.readFileSync(providerPath, 'utf8');

describe('brain duplicate dedupe regressions', () => {
    it('classifies nested artifact directories separately from canonical brain sources', () => {
        assert.match(
            source,
            /private _getAntigravitySourceKind\(candidate: string\): 'brain' \| 'artifact' \| undefined \{[\s\S]*path\.join\(antigravityRoot, 'brain', 'knowledge', 'artifacts'\),[\s\S]*path\.join\(antigravityRoot, 'knowledge', 'artifacts'\)[\s\S]*return 'artifact';[\s\S]*path\.join\(antigravityRoot, 'brain'\)[\s\S]*return 'brain';/,
            'Expected Antigravity source classification to treat artifact fallback roots separately from canonical brain roots.'
        );
    });

    it('skips artifact-backed duplicates when a live canonical brain plan already exists', () => {
        assert.match(
            source,
            /const sourceKind = this\._getAntigravitySourceKind\(baseBrainPath\);[\s\S]*const duplicateKey = this\._getAntigravityDuplicateKey\(topic, baseBrainPath\);[\s\S]*if \(sourceKind === 'artifact' && await this\._hasPreferredAntigravityDuplicate\(resolvedWorkspaceRoot, runSheetId, duplicateKey\)\) \{[\s\S]*Skipping duplicate artifact-backed Antigravity plan/,
            'Expected _mirrorBrainPlan to suppress artifact-backed duplicates once a canonical brain-backed card exists.'
        );
    });

    it('cleans up stale artifact-backed cards before rebuilding the board snapshot', () => {
        assert.match(
            source,
            /private async _collectAndSyncKanbanSnapshot\(workspaceRoot: string, archiveMissing: boolean = true\): Promise<any\[]> \{[\s\S]*await this\._cleanupDuplicateAntigravityPlans\(workspaceRoot\);[\s\S]*const allSheets = await this\._getSessionLog\(workspaceRoot\)\.getRunSheets\(\);/,
            'Expected heavy snapshot sync to purge duplicate artifact-backed Antigravity cards before refreshing the board.'
        );
        assert.match(
            source,
            /private async _cleanupDuplicateAntigravityPlans\(workspaceRoot: string\): Promise<void> \{[\s\S]*this\._getAntigravitySourceKind\(plan\.brainSourcePath\) !== 'artifact'[\s\S]*preferredDuplicateKeys\.has\(duplicateKey\)[\s\S]*await this\._removeAntigravityDuplicatePlan\(workspaceRoot, plan\);/,
            'Expected duplicate cleanup to retire lower-priority artifact cards when a canonical brain card with the same topic+filename exists.'
        );
    });
});
