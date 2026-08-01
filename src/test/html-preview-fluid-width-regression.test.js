'use strict';

/**
 * Regression test for HTML preview fluid page width collapsing.
 *
 * Exercises:
 * 1. computeReportedWidth classification logic (DesignPanelProvider.ts):
 *    - clientWidth === 0 -> null (zero layout frame guard)
 *    - scrollWidth === clientWidth (fluid page) -> null
 *    - scrollWidth > clientWidth (intrinsic width page) -> raw width number
 *    - classic scrollbar false-positive (scrollWidth === innerWidth > clientWidth) -> null
 * 2. Consumer damping contract (simulated):
 *    - msg.w === null following an intrinsic width report preserves existing explicit width.
 */

const assert = require('assert');
const { installVscodeTrap } = require('./helpers/verbEngineTestSeams');
installVscodeTrap();

const { computeReportedWidth } = require('../../out/services/DesignPanelProvider');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(`     ${e && e.message ? e.message : e}`);
        failed++;
    }
}

async function runTests() {
    console.log('Running HTML Preview Fluid Width regression tests...');

    await test('clientWidth === 0 returns null (zero layout bail)', async () => {
        const res = computeReportedWidth(1000, 0, 1000);
        assert.strictEqual(res, null);
    });

    await test('fluid page (scrollWidth === clientWidth) returns null', async () => {
        const res = computeReportedWidth(800, 800, 800);
        assert.strictEqual(res, null);
    });

    await test('intrinsic width page (scrollWidth > clientWidth) returns raw width', async () => {
        const res = computeReportedWidth(1200, 800, 800);
        assert.strictEqual(res, 1200);
    });

    await test('classic scrollbar false-positive (scrollWidth === innerWidth > clientWidth) returns null', async () => {
        // innerWidth (800) includes 15px vertical scrollbar; clientWidth is 785px.
        // scrollWidth is 800px due to layout holding scrollWidth to full inner width.
        const res = computeReportedWidth(800, 785, 800);
        assert.strictEqual(res, null);
    });

    await test('sub-pixel 1px tolerance preserves fluid classification', async () => {
        // rawW is 801, maxView is 800 -> 801 is not > 801 -> returns null
        const res = computeReportedWidth(801, 800, 800);
        assert.strictEqual(res, null);
    });

    await test('consumer damping logic retains existing pixel width on null msg.w', async () => {
        const vp = { style: { width: '1200px', height: '600px' } };
        const wrapper = { clientWidth: 800 };
        const msg = { w: null, h: 700 };

        // Simulate consumer logic
        const h = msg.h;
        vp.style.height = h + 'px';
        let w;
        if (typeof msg.w === 'number') {
            w = msg.w;
            vp.style.width = w + 'px';
        } else {
            w = vp.style.width && vp.style.width.endsWith('px')
                ? parseFloat(vp.style.width)
                : wrapper.clientWidth;
        }

        assert.strictEqual(vp.style.width, '1200px');
        assert.strictEqual(w, 1200);
        assert.strictEqual(vp.style.height, '700px');
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed.`);
    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Unhandled test runner error:', err);
    process.exit(1);
});
