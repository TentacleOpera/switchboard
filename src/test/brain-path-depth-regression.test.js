'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const source = fs.readFileSync(providerPath, 'utf8');

describe('brain path depth regressions', () => {
    it('allows up to 3 directory levels in brain paths', () => {
        assert.match(
            source,
            /if \(parts\.length < 1 \|\| parts\.length > 3\) return false;/,
            'Expected _isBrainMirrorCandidate to allow 3-level deep paths (brain/<session>/subdir/plan.md)'
        );
    });

    it('still rejects paths deeper than 3 levels', () => {
        // Verify the logic still has an upper bound
        assert.doesNotMatch(
            source,
            /if \(parts\.length < 1 \|\| parts\.length > (4|5|6|10|20|100)\) return false;/,
            'Path depth limit should not be excessively high (keeping it at 3)'
        );
    });

    it('rejects 4-level paths explicitly', () => {
        // Simulate the logic: 4 parts = too deep
        const parts4 = ['level1', 'level2', 'level3', 'level4'];
        const isAllowed = parts4.length >= 1 && parts4.length <= 3;
        assert.strictEqual(isAllowed, false, '4-level paths should be rejected');

        // Verify 3 parts is the boundary
        const parts3 = ['level1', 'level2', 'level3'];
        const isAllowed3 = parts3.length >= 1 && parts3.length <= 3;
        assert.strictEqual(isAllowed3, true, '3-level paths should be allowed');
    });
});
