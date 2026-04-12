'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const source = fs.readFileSync(providerPath, 'utf8');

describe('brain registry rescue regressions', () => {
    it('normalizes loaded brain registry ids and rewrites stale rows through registerPlan', () => {
        assert.match(
            source,
            /const normalizedPlanId = this\._normalizeRegistryPlanId\(p\.planId \|\| p\.sessionId, p\.sourceType\);[\s\S]*entries\[normalizedPlanId\] = \{[\s\S]*planId: normalizedPlanId[\s\S]*if \(staleEntries\.length > 0\) \{[\s\S]*await this\._registerPlan\(workspaceRoot, staleEntry\);/,
            'Expected _loadPlanRegistry to normalize brain plan ids and rewrite stale DB rows.'
        );
    });

    it('uses canonical antigravity session ids for brain registry persistence', () => {
        assert.match(
            source,
            /private _getRegistrySessionId\([\s\S]*return sourceType === 'brain'[\s\S]*`antigravity_\$\{this\._normalizeRegistryPlanId\(planId, sourceType\)\}`[\s\S]*sessionId: this\._getRegistrySessionId\(planId, entry\.sourceType\)/,
            'Expected registry persistence helpers to derive prefixed brain session ids from raw plan ids.'
        );
    });

    it('rescues unregistered brain mirrors even when local plans already seeded the DB', () => {
        assert.match(
            source,
            /if \(existing\.length > 0\) \{[\s\S]*await this\._rescueBrainMirrorsWithoutRegistryEntry\(workspaceRoot, db, wsId\);[\s\S]*return;/,
            'Expected _migrateLegacyToRegistry to run brain rescue before exiting when the DB already has plans.'
        );
        assert.match(
            source,
            /private async _rescueBrainMirrorsWithoutRegistryEntry\([\s\S]*const stagingDir = path\.join\(workspaceRoot, '\.switchboard', 'plans'\);[\s\S]*await this\._registerPlan\(workspaceRoot, \{[\s\S]*sourceType: 'brain'[\s\S]*status: 'active'/,
            'Expected dedicated brain mirror rescue logic to register recovered plans through _registerPlan.'
        );
        assert.match(
            source,
            /const rescuedPlanIds = new Set<string>\(\);[\s\S]*for \(const \[hash, runSheet\] of runSheetMetadata\.entries\(\)\) \{[\s\S]*await this\._mirrorBrainPlan\(runSheet\.brainSourcePath, true, workspaceRoot, true\);[\s\S]*Rescued brain runsheet without staging mirror/m,
            'Expected brain rescue to recover runsheet-backed plans even when the staging mirror is missing.'
        );
    });

    it('salvages orphan brain mirrors before the reconcile sweep can quarantine them again', () => {
        assert.match(
            source,
            /private async _salvageOrphanBrainPlans\([\s\S]*archive', 'orphan_plans'[\s\S]*this\._recentMirrorWrites\.set\([\s\S]*await this\._registerPlan\(workspaceRoot, \{/,
            'Expected orphan salvage helper to restore files, suppress watcher loops, and re-register rescued brain plans.'
        );
        assert.match(
            source,
            /const salvagedMirrorNames = await this\._salvageOrphanBrainPlans\(workspaceRoot, dbForReconcile \|\| null, wsIdForReconcile\);[\s\S]*for \(const salvagedMirrorName of salvagedMirrorNames\) \{[\s\S]*activeMirrorNames\.add\(salvagedMirrorName\);/,
            'Expected reconciler to merge salvaged mirror names into the active set before the orphan sweep.'
        );
    });

    it('does not auto-select silently rescued brain plans', () => {
        assert.match(
            source,
            /if \(!suppressFollowupSync\) \{[\s\S]*await this\._syncFilesAndRefreshRunSheets\(resolvedWorkspaceRoot\);[\s\S]*this\._view\?\.webview\.postMessage\(\{ type: 'selectSession', sessionId: runSheetId \}\);[\s\S]*\}/,
            'Expected silent brain-plan mirror operations to avoid forcing UI selection changes.'
        );
    });
});
