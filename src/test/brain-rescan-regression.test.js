'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const source = fs.readFileSync(providerPath, 'utf8');

describe('brain rescan regressions', () => {
    it('rescans Antigravity source files during heavy refresh to recover missed watcher events', () => {
        assert.match(
            source,
            /private async _rescanAntigravityPlanSources\(workspaceRoot: string\): Promise<void> \{[\s\S]*const candidateFiles = this\._getAntigravityPlanRoots\(\)[\s\S]*await this\._mirrorBrainPlan\(filePath, isRecent, workspaceRoot, true\);/,
            'Expected a targeted Antigravity source rescan that mirrors eligible files when watcher events are missed.'
        );
        assert.match(
            source,
            /private async _syncFilesAndRefreshRunSheets\(workspaceRoot\?: string\) \{[\s\S]*await this\._rescanAntigravityPlanSources\(resolvedWorkspaceRoot\);[\s\S]*await this\._syncFilesToDb\(resolvedWorkspaceRoot\);[\s\S]*await this\._refreshRunSheets\(resolvedWorkspaceRoot\);/,
            'Expected the heavy refresh path to rescan Antigravity source files before syncing DB/UI snapshots.'
        );
    });

    it('can mirror from rescan without recursively triggering another heavy refresh', () => {
        assert.match(
            source,
            /private async _mirrorBrainPlan\([\s\S]*suppressFollowupSync: boolean = false[\s\S]*if \(!suppressFollowupSync\) \{[\s\S]*await this\._syncFilesAndRefreshRunSheets\(resolvedWorkspaceRoot\);/,
            'Expected _mirrorBrainPlan to support rescan-driven mirroring without recursive refresh loops.'
        );
    });

    it('clears stale deleted placeholders when a live Antigravity source file still exists', () => {
        assert.match(
            source,
            /const tombstonedInDb = db \? await db\.isTombstoned\(pathHash\) : false;[\s\S]*if \(this\._tombstones\.has\(pathHash\) \|\| tombstonedInDb\) \{[\s\S]*for \(const candidateSessionId of \[pathHash, runSheetId\]\) \{[\s\S]*if \(staleRow\?\.status === 'deleted'\) \{[\s\S]*await db\.deletePlan\(candidateSessionId\);[\s\S]*this\._tombstones\.delete\(pathHash\);/,
            'Expected _mirrorBrainPlan to purge stale deleted placeholders so live Antigravity source files can re-register.'
        );
    });
});
