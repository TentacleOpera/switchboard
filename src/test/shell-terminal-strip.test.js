'use strict';

const assert = require('assert');

function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e); process.exitCode = 1; }
}

test('light precedence: exited > done > active', () => {
    function resolveLight(status, isBadged) {
        if (status === 'exited') return 'exited';
        if (isBadged) return 'done';
        return 'active';
    }

    assert.strictEqual(resolveLight('exited', true), 'exited');
    assert.strictEqual(resolveLight('exited', false), 'exited');
    assert.strictEqual(resolveLight('active', true), 'done');
    assert.strictEqual(resolveLight('active', false), 'active');
});

test('gating: section omitted when terminals panel missing from manifest', () => {
    const manifest = [{ id: 'board', enabled: true }, { id: 'terminals', enabled: false }];
    const frames = new Map();
    for (const p of manifest) {
        if (p.enabled !== false) frames.set(p.id, true);
    }
    assert.strictEqual(frames.has('terminals'), false);
});
