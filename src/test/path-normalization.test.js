
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const source = fs.readFileSync(providerPath, 'utf8');

describe('TaskViewerProvider path-stability contracts', () => {
    it('uses stable hashing in mirror path generation', () => {
        assert.match(
            source,
            /const stablePath = this\._getStablePath\(brainFilePath\);[\s\S]*?createHash\('sha256'\)\.update\(stablePath\)\.digest\('hex'\)/,
            'Expected _mirrorBrainPlan to hash the stable path'
        );
    });

    it('uses stable hashing in legacy migration', () => {
        assert.match(
            source,
            /const stableBrainSourcePath = this\._getStablePath\(brainSourcePath\);[\s\S]*?createHash\('sha256'\)\.update\(stableBrainSourcePath\)\.digest\('hex'\)/,
            'Expected _migrateLegacyPrimaryFiles to hash stableBrainSourcePath'
        );
    });

    it('uses case-safe containment helper for mirror -> brain security gate', () => {
        assert.match(
            source,
            /if \(!this\._isPathWithin\(brainDir, resolvedBrainPath\)\) return;/,
            'Expected mirror->brain guard to use _isPathWithin'
        );
    });

    it('defines stable path normalization with Windows lowercase behavior', () => {
        assert.match(source, /private _getStablePath\(p: string\): string/);
        assert.match(source, /process\.platform === 'win32' \? normalized\.toLowerCase\(\) : normalized/);
    });
});
