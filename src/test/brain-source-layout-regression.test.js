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
            /const matchingRoot = this\._getAntigravityPlanRoots\(\)[\s\S]*const parts = relativePath\.split\(path\.sep\)\.filter\(Boolean\);[\s\S]*if \(parts\.length < 1 \|\| parts\.length > 2\) return false;[\s\S]*const filename = parts\[parts\.length - 1\];/,
            'Expected _isBrainMirrorCandidate to accept direct-child Antigravity plan files as well as the legacy one-folder-deep layout.'
        );
    });

    it('watches the Antigravity root so knowledge/artifacts plans are observed', () => {
        assert.match(
            source,
            /const antigravityRoot = this\._getAntigravityRoot\(\);[\s\S]*const brainUri = vscode\.Uri\.file\(antigravityRoot\);[\s\S]*const brainFsWatcher = fs\.watch\(antigravityRoot, \{ recursive: true \}/,
            'Expected _setupBrainWatcher to watch the Antigravity root recursively so knowledge/artifacts plans are not missed.'
        );
    });
});
