'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const source = fs.readFileSync(providerPath, 'utf8');

describe('workspace scope enforcement regressions', () => {
    it('auto-claims newly created brain plans and mirrors owned plans in _mirrorBrainPlan', () => {
        assert.match(
            source,
            /const eligibility = this\._isPlanEligibleForWorkspace\(stablePath, workspaceRoot\);[\s\S]*const existingEntry = this\._planRegistry\.entries\[pathHash\];[\s\S]*const shouldAutoClaim = !eligibility\.eligible && allowAutoClaim && !existingEntry;/,
            'Expected _mirrorBrainPlan to check workspace eligibility.'
        );
        assert.match(
            source,
            /if \(!eligibility\.eligible && !shouldAutoClaim\) \{[\s\S]*Mirror skipped/,
            'Expected _mirrorBrainPlan to skip non-owned plans unless auto-claim is allowed.'
        );
        assert.match(
            source,
            /if \(shouldAutoClaim\) \{[\s\S]*await this\._registerPlan\(workspaceRoot, \{[\s\S]*sourceType: 'brain'[\s\S]*status: 'active'[\s\S]*\}\);[\s\S]*Auto-claimed new brain plan:/,
            'Expected _mirrorBrainPlan to auto-claim newly created brain plans.'
        );
        assert.match(
            source,
            /if \(this\._brainPlanBlacklist\.has\(stablePath\)\) \{[\s\S]*Mirror skipped \(brain_plan_blacklist\)/,
            'Expected _mirrorBrainPlan to skip blacklisted brain plans before any mirroring.'
        );
    });

    it('mirror write-back resolves brain path via runsheet lookup with active registry fallback', () => {
        assert.match(
            source,
            /const resolvedBrainPath = await this\._resolveBrainSourcePathForMirrorHash\(workspaceRoot, hash, brainDir\);[\s\S]*if \(!resolvedBrainPath\) return;/,
            'Expected staging watcher to resolve brain path through helper before mirror write-back.'
        );
        assert.match(
            source,
            /private async _resolveBrainSourcePathForMirrorHash\(workspaceRoot: string, hash: string, brainDir: string\): Promise<string \| undefined> \{[\s\S]*await this\._findExistingRunSheetPath\(workspaceRoot, sessionId\)[\s\S]*const entry = this\._planRegistry\.entries\[hash\];[\s\S]*entry\.sourceType === 'brain'[\s\S]*entry\.status === 'active'[\s\S]*this\._isPathWithin\(brainDir, resolvedBrainPath\)/,
            'Expected helper to use runsheet resolution, active registry fallback, and brain-root containment.'
        );
    });

    it('startup scan and runsheet collection functions are removed', () => {
        assert.doesNotMatch(
            source,
            /_scanBrainPlansOnStartup/,
            'Expected _scanBrainPlansOnStartup to be removed.'
        );
        assert.doesNotMatch(
            source,
            /_collectKnownBrainPathsFromRunSheets/,
            'Expected _collectKnownBrainPathsFromRunSheets to be removed.'
        );
        assert.doesNotMatch(
            source,
            /_restoreWorkspaceBrainPathScope/,
            'Expected _restoreWorkspaceBrainPathScope to be removed.'
        );
    });

    it('does not use installEpoch for plan visibility', () => {
        assert.doesNotMatch(
            source,
            /_ensureWorkspaceInstallEpoch/,
            'Expected _ensureWorkspaceInstallEpoch to be removed.'
        );
        assert.doesNotMatch(
            source,
            /installEpoch/,
            'Expected all installEpoch references to be removed.'
        );
    });

    it('_refreshRunSheets derives visibility from owned active registry entries', () => {
        assert.match(
            source,
            /const ownedActiveEntries = Object\.values\(this\._planRegistry\.entries\)\.filter\(\(entry\) =>[\s\S]*entry\.ownerWorkspaceId === this\._workspaceId && entry\.status === 'active'/,
            'Expected _refreshRunSheets to use plan_registry ownership as the visibility source.'
        );
        assert.match(
            source,
            /const bestSheetByPlanId = new Map<string, any>\(\);[\s\S]*if \(!this\._isOwnedActiveRunSheet\(sheet\)\) continue;/,
            'Expected _refreshRunSheets to include only owned active runsheets.'
        );
        assert.match(
            source,
            /for \(const entry of ownedActiveEntries\) \{[\s\S]*if \(entry\.sourceType === 'brain' && entry\.brainSourcePath\) \{[\s\S]*if \(this\._tombstones\.has\(pathHash\)\) continue;[\s\S]*if \(this\._brainPlanBlacklist\.has\(stablePath\)\) continue;/,
            'Expected _refreshRunSheets to apply tombstone/blacklist checks while enumerating owned entries.'
        );
    });

    it('does not allow unregistered local plan fallback visibility', () => {
        assert.doesNotMatch(
            source,
            /Unregistered local plans visible for backward compat/,
            'Expected strict ownership mode to remove unregistered local fallback visibility.'
        );
    });

    it('stores hard ownership metadata in workspace identity and plan registry files', () => {
        assert.match(
            source,
            /private _workspaceId: string \| null = null;/,
            'Expected workspace identity to be tracked in TaskViewerProvider state.'
        );
        assert.match(
            source,
            /private _getWorkspaceIdentityPath\(workspaceRoot: string\): string \{[\s\S]*workspace_identity\.json/,
            'Expected workspace identity path helper.'
        );
        assert.match(
            source,
            /private _getPlanRegistryPath\(workspaceRoot: string\): string \{[\s\S]*plan_registry\.json/,
            'Expected plan registry path helper.'
        );
        assert.match(
            source,
            /ownerWorkspaceId: string;/,
            'Expected plan registry entry schema to include ownerWorkspaceId.'
        );
        assert.doesNotMatch(
            source,
            /Migrate from workspaceBrainPaths/,
            'Expected strict ownership mode to avoid implicit ownership migration from workspaceBrainPaths.'
        );
    });

    it('does not mutate ownership state during startup initialization', () => {
        assert.doesNotMatch(
            source,
            /_sanitizeLegacyBrainOwnershipEntries/,
            'Expected startup initialization to avoid ownership reclassification scans.'
        );
    });

    it('registers merged local plans and archives merged source plan ownership entries', () => {
        assert.match(
            source,
            /await log\.createRunSheet\(mergedSessionId, mergedRunSheet\);[\s\S]*await this\._registerPlan\(workspaceRoot, \{[\s\S]*planId: mergedSessionId,[\s\S]*sourceType: 'local'/,
            'Expected merged plan output to be registered in ownership registry.'
        );
        assert.match(
            source,
            /const sourcePlanId = this\._getPlanIdForRunSheet\(sheet\);[\s\S]*await this\._updatePlanRegistryStatus\(workspaceRoot, sourcePlanId, 'archived'\);/,
            'Expected merged source plans to be archived in ownership registry.'
        );
    });

    it('loads and seeds persisted brain plan blacklist', () => {
        assert.match(
            source,
            /private _brainPlanBlacklist = new Set<string>\(\);/,
            'Expected TaskViewerProvider to store a persisted brain plan blacklist set.'
        );
        assert.match(
            source,
            /this\._loadBrainPlanBlacklist\(workspaceRoot\);[\s\S]*createFileSystemWatcher\(brainPattern\)/,
            'Expected brain watcher setup to load blacklist before processing events.'
        );
        assert.match(
            source,
            /private _collectBrainPlanBlacklistEntries\(brainDir: string\): Set<string> \{[\s\S]*this\._isBrainMirrorCandidate\(brainDir, fullPath\)[\s\S]*this\._getBaseBrainPath\(fullPath\)[\s\S]*entries\.add\(stableKey\)/,
            'Expected blacklist seeding scan to use mirror candidate filtering and stable base-brain keys.'
        );
        assert.match(
            source,
            /private _getBrainPlanBlacklistPath\(workspaceRoot: string\): string \{[\s\S]*brain_plan_blacklist\.json/,
            'Expected persisted blacklist file path to be defined.'
        );
        assert.match(
            source,
            /public async seedBrainPlanBlacklistFromCurrentBrainSnapshot\(\): Promise<void> \{[\s\S]*_saveBrainPlanBlacklist\(workspaceRoot, entries\)/,
            'Expected setup-facing API to seed and persist blacklist entries.'
        );
    });
});
