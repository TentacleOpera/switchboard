'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const source = fs.readFileSync(providerPath, 'utf8');

describe('brain source layout regressions', () => {
    it('recognizes canonical and fallback Antigravity plan roots', () => {
        assert.match(
            source,
            /private _getAntigravityPlanRoots\(\): string\[] \{[\s\S]*path\.join\(antigravityRoot, 'brain', 'knowledge', 'artifacts'\),[\s\S]*path\.join\(antigravityRoot, 'knowledge', 'artifacts'\),[\s\S]*path\.join\(antigravityRoot, 'brain'\)/,
            'Expected TaskViewerProvider to recognize canonical brain paths plus both artifact fallback roots.'
        );
    });

    it('accepts direct-child plan files instead of requiring brain/<session>/<file>.md', () => {
        assert.match(
            source,
            /const matchingRoot = this\._getAntigravityPlanRoots\(\)[\s\S]*const parts = relativePath\.split\(path\.sep\)\.filter\(Boolean\);[\s\S]*if \(parts\.length < 1 \|\| parts\.length > \d+\) return false;[\s\S]*const filename = parts\[parts\.length - 1\];/,
            'Expected _isBrainMirrorCandidate to accept direct-child Antigravity plan files as well as the legacy one-folder-deep layout.'
        );
    });

    it('watches the Antigravity root so knowledge/artifacts plans are observed', () => {
        assert.match(
            source,
            /(?:const|let) roots = this\._getAntigravityRoots\(\);[\s\S]*for\s*\(.*roots[\s\S]*vscode\.Uri\.file\(.*\)[\s\S]*vscode\.workspace\.createFileSystemWatcher/,
            'Expected _setupBrainWatcher to iterate over multiple Antigravity roots for watcher setup.'
        );
    });
});
