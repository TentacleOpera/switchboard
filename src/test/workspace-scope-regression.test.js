'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const source = fs.readFileSync(providerPath, 'utf8');

describe('workspace scope enforcement regressions', () => {
    it('enforces mirror eligibility with auto-registration for new plans in _mirrorBrainPlan', () => {
        assert.match(
            source,
            /const eligibility = this\._isPlanEligibleForWorkspace\(stablePath, workspaceRoot\);[\s\S]*if \(!eligibility\.eligible\) \{/,
            'Expected _mirrorBrainPlan to check workspace eligibility.'
        );
        assert.match(
            source,
            /if \(runSheetKnown\) \{[\s\S]*Mirror skipped/,
            'Expected _mirrorBrainPlan to skip existing plans from other workspaces.'
        );
        assert.match(
            source,
            /Auto-registered new brain plan to workspace/,
            'Expected _mirrorBrainPlan to auto-register new plans (no runsheet) to the workspace.'
        );
        assert.match(
            source,
            /if \(this\._historicalBrainBaseline\.has\(stablePath\)\) \{[\s\S]*Mirror skipped \(historical_baseline\)/,
            'Expected _mirrorBrainPlan to skip historical baseline plans before auto-registration.'
        );
        assert.doesNotMatch(
            source,
            /const hasExistingScopeData = knownPaths\.size > 0;/,
            'Expected legacy empty-scope bypass to be removed.'
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

    it('_refreshRunSheets filters by registry and tombstones', () => {
        assert.match(
            source,
            /const registry = new Set\(\s*this\._context\.workspaceState[\s\S]*get<string\[\]>\('switchboard\.workspaceBrainPaths'[\s\S]*\.map\(\(entry\) => this\._getStablePath\(entry\)\)/,
            'Expected _refreshRunSheets to load the workspace registry.'
        );
        assert.match(
            source,
            /if \(this\._tombstones\.has\(pathHash\)\) return false;/,
            'Expected _refreshRunSheets to exclude tombstoned plans.'
        );
        assert.match(
            source,
            /return registry\.has\(stablePath\);/,
            'Expected _refreshRunSheets to require registry membership for brain-sourced plans.'
        );
    });

    it('local plans without brainSourcePath are always visible', () => {
        assert.match(
            source,
            /if \(!sheet\.brainSourcePath\) return true;/,
            'Expected local plans (no brainSourcePath) to bypass registry check.'
        );
    });

    it('captures baseline before watcher registration', () => {
        assert.match(
            source,
            /private _historicalBrainBaseline = new Set<string>\(\);/,
            'Expected TaskViewerProvider to store a historical brain baseline set.'
        );
        assert.match(
            source,
            /this\._populateBrainBaseline\(brainDir\);[\s\S]*createFileSystemWatcher\(brainPattern\)/,
            'Expected startup baseline capture to happen before brain watcher registration.'
        );
        assert.match(
            source,
            /private _populateBrainBaseline\(brainDir: string\): void \{[\s\S]*this\._isBrainMirrorCandidate\(brainDir, fullPath\)[\s\S]*this\._getBaseBrainPath\(fullPath\)[\s\S]*this\._historicalBrainBaseline\.add\(stableKey\)/,
            'Expected baseline population to use mirror candidate filtering and stable base-brain keys.'
        );
    });
});
