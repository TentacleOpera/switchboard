/**
 * Unit tests for _handleDeletePlan deletion logic (AP-1 through AP-4).
 * Tests the deletion order, failure propagation, and brainSourcePath handling
 * without requiring a live VS Code environment.
 *
 * Run with: node src/test/delete-plan.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}: ${e.message}`);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// Standalone reimplementation of the deletion sequence extracted from
// _handleDeletePlan for isolated testing.  Matches the AP-1/AP-2/AP-4 logic.
// ---------------------------------------------------------------------------
async function runDeletionSequence({ brainSourcePath, mirrorPath, runSheetPath, fsImpl }) {
    const expectedBrainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

    // AP-2: Windows-safe brain path guard
    if (brainSourcePath) {
        const brainNorm = process.platform === 'win32' ? brainSourcePath.toLowerCase() : brainSourcePath;
        const brainDirNorm = process.platform === 'win32' ? expectedBrainDir.toLowerCase() : expectedBrainDir;
        if (!brainNorm.startsWith(brainDirNorm + path.sep)) {
            brainSourcePath = undefined; // treat as local plan
        }
    }

    // AP-1: Atomic deletion — brain → mirror → runsheet
    if (brainSourcePath && fsImpl.existsSync(brainSourcePath)) {
        await fsImpl.unlink(brainSourcePath); // throws on failure; caller catches
    }
    if (mirrorPath && fsImpl.existsSync(mirrorPath)) {
        await fsImpl.unlink(mirrorPath);
    }
    if (runSheetPath && fsImpl.existsSync(runSheetPath)) {
        await fsImpl.unlink(runSheetPath);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run() {
    console.log('\n🧪 Delete Plan Tests\n');

    // ---- a) Brain file is unlinked before mirror file ----------------------
    await test('AP-1a: brain file is deleted before mirror file', async () => {
        const deleteOrder = [];
        const brainFile = path.join(os.homedir(), '.gemini', 'antigravity', 'brain', 'implementation_plan.md');
        const mirrorFile = '/workspace/.switchboard/plans/antigravity_plans/implementation_plan.md';
        const runSheet = '/workspace/.switchboard/sessions/abc.json';

        const fsImpl = {
            existsSync: () => true,
            unlink: async (p) => { deleteOrder.push(p); }
        };

        await runDeletionSequence({
            brainSourcePath: brainFile,
            mirrorPath: mirrorFile,
            runSheetPath: runSheet,
            fsImpl
        });

        assert.strictEqual(deleteOrder[0], brainFile, 'brain file should be deleted first');
        assert.strictEqual(deleteOrder[1], mirrorFile, 'mirror file should be deleted second');
        assert.strictEqual(deleteOrder[2], runSheet, 'runsheet should be deleted third');
    });

    // ---- b) Failure of brain unlink prevents mirror deletion ---------------
    await test('AP-1b: brain unlink failure halts sequence (mirror not deleted)', async () => {
        const deleteOrder = [];
        const brainFile = path.join(os.homedir(), '.gemini', 'antigravity', 'brain', 'implementation_plan.md');
        const mirrorFile = '/workspace/.switchboard/plans/antigravity_plans/implementation_plan.md';

        const fsImpl = {
            existsSync: () => true,
            unlink: async (p) => {
                if (p === brainFile) throw new Error('Permission denied');
                deleteOrder.push(p);
            }
        };

        let threw = false;
        try {
            await runDeletionSequence({
                brainSourcePath: brainFile,
                mirrorPath: mirrorFile,
                runSheetPath: null,
                fsImpl
            });
        } catch {
            threw = true;
        }

        assert.ok(threw, 'should throw when brain unlink fails');
        assert.strictEqual(deleteOrder.length, 0, 'mirror should NOT be deleted after brain failure');
    });

    // ---- c) Missing brainSourcePath falls back to local-only delete --------
    await test('AP-4c: missing brainSourcePath falls back to local-only delete', async () => {
        const deleteOrder = [];
        const mirrorFile = '/workspace/.switchboard/plans/antigravity_plans/implementation_plan.md';
        const runSheet = '/workspace/.switchboard/sessions/abc.json';

        const fsImpl = {
            existsSync: () => true,
            unlink: async (p) => { deleteOrder.push(p); }
        };

        // No brainSourcePath provided (AP-4)
        await runDeletionSequence({
            brainSourcePath: undefined,
            mirrorPath: mirrorFile,
            runSheetPath: runSheet,
            fsImpl
        });

        assert.ok(!deleteOrder.includes(undefined), 'no undefined paths deleted');
        assert.ok(deleteOrder.includes(mirrorFile), 'mirror file deleted');
        assert.ok(deleteOrder.includes(runSheet), 'runsheet deleted');
        assert.strictEqual(deleteOrder.length, 2, 'only 2 files deleted (no brain)');
    });

    // ---- d) AP-2: brain path outside expected dir is rejected --------------
    await test('AP-2d: brainSourcePath outside expected brain dir is rejected', async () => {
        const deleteOrder = [];
        // This path is outside ~/.gemini/antigravity/brain/
        const suspiciousPath = path.join(os.homedir(), 'Documents', 'important.md');
        const mirrorFile = '/workspace/.switchboard/plans/antigravity_plans/plan.md';

        const fsImpl = {
            existsSync: () => true,
            unlink: async (p) => { deleteOrder.push(p); }
        };

        await runDeletionSequence({
            brainSourcePath: suspiciousPath,
            mirrorPath: mirrorFile,
            runSheetPath: null,
            fsImpl
        });

        assert.ok(!deleteOrder.includes(suspiciousPath), 'suspicious path should NOT be deleted');
        assert.ok(deleteOrder.includes(mirrorFile), 'mirror file should still be deleted');
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

run().catch(e => {
    console.error('Test runner error:', e);
    process.exit(1);
});
