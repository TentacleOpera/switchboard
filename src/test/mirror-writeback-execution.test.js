/**
 * Execution-level regression tests for mirror -> brain write-back.
 * Run with: node src/test/mirror-writeback-execution.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { syncMirrorToBrain } = require('../services/mirrorSync');

let passed = 0;
let failed = 0;

function stablePath(p) {
    const normalized = path.normalize(p);
    const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    const root = path.parse(stable).root;
    return stable.length > root.length ? stable.replace(/[\\\/]+$/, '') : stable;
}

function sidecarPaths(baseBrainPath) {
    const dir = path.dirname(baseBrainPath);
    const baseName = path.basename(baseBrainPath);
    const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}\\.resolved(?:\\.\\d+)?$`, 'i');
    return fs.readdirSync(dir)
        .filter((name) => pattern.test(name))
        .map((name) => path.join(dir, name));
}

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (error) {
        console.error(`  FAIL ${name}: ${error.message}`);
        failed++;
    }
}

async function run() {
    console.log('\nRunning mirror write-back execution tests\n');

    await test('syncMirrorToBrain updates base brain file and existing sidecars', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-mirror-sync-'));
        try {
            const brainSessionDir = path.join(root, 'brain', 'session-1');
            const mirrorDir = path.join(root, 'workspace', '.switchboard', 'plans', 'antigravity_plans');
            fs.mkdirSync(brainSessionDir, { recursive: true });
            fs.mkdirSync(mirrorDir, { recursive: true });

            const brainFile = path.join(brainSessionDir, 'implementation_plan.md');
            const sidecar = `${brainFile}.resolved`;
            const mirrorFile = path.join(mirrorDir, 'brain_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.md');

            fs.writeFileSync(brainFile, '# Old Plan\nold\n', 'utf8');
            fs.writeFileSync(sidecar, '# Old Plan\nold sidecar\n', 'utf8');
            fs.writeFileSync(mirrorFile, '# New Plan\nnew content\n', 'utf8');

            const recentBrainWrites = new Map();
            const result = await syncMirrorToBrain({
                mirrorPath: mirrorFile,
                resolvedBrainPath: brainFile,
                getStablePath: stablePath,
                getResolvedSidecarPaths: sidecarPaths,
                recentBrainWrites,
                writeTtlMs: 2000
            });

            assert.strictEqual(result.updatedBase, true, 'Expected base brain file to be updated.');
            assert.ok(result.sidecarWrites >= 1, 'Expected at least one sidecar write.');
            assert.strictEqual(fs.readFileSync(brainFile, 'utf8'), '# New Plan\nnew content\n');
            assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), '# New Plan\nnew content\n');
            assert.ok(recentBrainWrites.size >= 1, 'Expected recent brain write guard to be populated.');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await test('syncMirrorToBrain is a no-op when mirror and brain are already identical', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-mirror-sync-'));
        try {
            const brainSessionDir = path.join(root, 'brain', 'session-2');
            const mirrorDir = path.join(root, 'workspace', '.switchboard', 'plans', 'antigravity_plans');
            fs.mkdirSync(brainSessionDir, { recursive: true });
            fs.mkdirSync(mirrorDir, { recursive: true });

            const content = '# Stable Plan\nsame\n';
            const brainFile = path.join(brainSessionDir, 'implementation_plan.md');
            const sidecar = `${brainFile}.resolved`;
            const mirrorFile = path.join(mirrorDir, 'brain_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md');

            fs.writeFileSync(brainFile, content, 'utf8');
            fs.writeFileSync(sidecar, content, 'utf8');
            fs.writeFileSync(mirrorFile, content, 'utf8');

            const result = await syncMirrorToBrain({
                mirrorPath: mirrorFile,
                resolvedBrainPath: brainFile,
                getStablePath: stablePath,
                getResolvedSidecarPaths: sidecarPaths,
                recentBrainWrites: new Map(),
                writeTtlMs: 2000
            });

            assert.strictEqual(result.changed, false, 'Expected no write when content is already synchronized.');
            assert.strictEqual(result.updatedBase, false, 'Expected base to remain unchanged.');
            assert.strictEqual(result.sidecarWrites, 0, 'Expected sidecars to remain unchanged.');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

void run();
