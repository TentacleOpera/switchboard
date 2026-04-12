'use strict';

const fs = require('fs');
const path = require('path');

const FIXTURES_ROOT = path.join(process.cwd(), 'src', 'test', 'integrations', 'fixtures');
const GENERATED_ROOT = path.join(FIXTURES_ROOT, 'generated');

async function withWorkspace(name, run) {
    const workspaceRoot = path.join(
        GENERATED_ROOT,
        `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    );
    const switchboardDir = path.join(workspaceRoot, '.switchboard');
    await fs.promises.mkdir(switchboardDir, { recursive: true });

    try {
        return await run({ workspaceRoot, switchboardDir });
    } finally {
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
}

async function writeJson(filePath, value) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function writeText(filePath, value) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, value, 'utf8');
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

function loadFixtureJson(...segments) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, ...segments), 'utf8'));
}

function loadFixtureText(...segments) {
    return fs.readFileSync(path.join(FIXTURES_ROOT, ...segments), 'utf8');
}

function clearOutModule(relativePath) {
    const absolutePath = path.join(process.cwd(), 'out', relativePath);
    delete require.cache[require.resolve(absolutePath)];
}

function loadOutModule(relativePath, extraPaths = []) {
    for (const modulePath of [relativePath, ...extraPaths]) {
        clearOutModule(modulePath);
    }
    return require(path.join(process.cwd(), 'out', relativePath));
}

function flushPromises() {
    return new Promise((resolve) => setImmediate(resolve));
}

async function withFakeTimers(run) {
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    let nextId = 1;
    const active = new Map();

    global.setTimeout = (fn, ms) => {
        const timer = { id: nextId++, fn, ms, cleared: false };
        active.set(timer.id, timer);
        return timer;
    };
    global.clearTimeout = (timer) => {
        if (!timer) {
            return;
        }
        timer.cleared = true;
        active.delete(timer.id);
    };

    try {
        await run({
            active,
            async fire(timer) {
                active.delete(timer.id);
                return await timer.fn();
            }
        });
    } finally {
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
}

function createPlanRecord(overrides = {}) {
    return {
        planId: 'plan-1',
        sessionId: 'session-1',
        topic: 'Example plan',
        planFile: '',
        kanbanColumn: 'CREATED',
        status: 'active',
        complexity: '5',
        tags: 'backend,tests',
        dependencies: '',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        lastAction: 'created',
        ...overrides
    };
}

module.exports = {
    FIXTURES_ROOT,
    GENERATED_ROOT,
    withWorkspace,
    writeJson,
    writeText,
    readJson,
    readText,
    loadFixtureJson,
    loadFixtureText,
    loadOutModule,
    flushPromises,
    withFakeTimers,
    createPlanRecord
};
