'use strict';

// Regression tests for the indefinite "syncing" hang.
// Root causes: missing res.on('error'/'aborted') handlers on HTTPS response
// streams, missing signal parameter on httpRequestV3, unbounded conflict-
// detection path, unguarded _checkIdlePlans loop, and status-overwrite race
// between the stall watchdog and late-resolving orphaned syncs.

const assert = require('assert');
const https = require('https');
const { EventEmitter } = require('events');

const {
    withWorkspace,
    loadOutModule,
    flushPromises
} = require('./shared/test-harness');
const { installVsCodeMock } = require('./shared/vscode-mock');
const { SecretStorageMock } = require('./shared/secret-storage-mock');

// ── Pathological HTTPS mock ────────────────────────────────────
// Replaces https.request with a factory controlled per-test via a handler.
function installPathologicalHttps(handler) {
    const original = https.request;
    https.request = (options, callback) => {
        const req = new EventEmitter();
        req.destroy = (err) => {
            req._destroyedWith = err;
            // Do not auto-emit 'error' — tests decide explicitly whether abort
            // propagates via req or via the res stream.
        };
        req.write = () => true;
        req.end = () => {
            setImmediate(() => handler({ options, req, callback }));
        };
        return req;
    };
    return () => { https.request = original; };
}

function createLinearService(workspaceRoot) {
    const installed = installVsCodeMock();
    const { LinearSyncService } = loadOutModule(
        'services/LinearSyncService.js',
        ['services/ClickUpSyncService.js']
    );
    installed.restore();
    return new LinearSyncService(workspaceRoot, new SecretStorageMock({
        'switchboard.linear.apiToken': 'lin_token'
    }));
}

function createClickUpService(workspaceRoot) {
    const installed = installVsCodeMock();
    const { ClickUpSyncService } = loadOutModule(
        'services/ClickUpSyncService.js',
        ['services/LinearSyncService.js']
    );
    installed.restore();
    return new ClickUpSyncService(workspaceRoot, new SecretStorageMock({
        'switchboard.clickup.apiToken': 'clk_token'
    }));
}

// 1. Response error mid-stream — must reject, not hang.
async function testLinearResponseErrorMidStream() {
    await withWorkspace('hang-linear-res-error', async ({ workspaceRoot }) => {
        const service = createLinearService(workspaceRoot);
        const restore = installPathologicalHttps(({ callback }) => {
            const res = new EventEmitter();
            res.statusCode = 200;
            callback(res);
            setImmediate(() => {
                res.emit('data', Buffer.from('{"'));
                res.emit('error', new Error('socket hang up'));
            });
        });
        try {
            await assert.rejects(
                () => service.graphqlRequest('{ viewer { id } }', undefined, 2000),
                /response stream error|socket hang up/
            );
        } finally { restore(); }
    });
}

async function testClickUpResponseErrorMidStream() {
    await withWorkspace('hang-clickup-res-error', async ({ workspaceRoot }) => {
        const service = createClickUpService(workspaceRoot);
        const restore = installPathologicalHttps(({ callback }) => {
            const res = new EventEmitter();
            res.statusCode = 200;
            callback(res);
            setImmediate(() => {
                res.emit('data', Buffer.from('{'));
                res.emit('error', new Error('ECONNRESET'));
            });
        });
        try {
            await assert.rejects(
                () => service.httpRequest('GET', '/task/abc', undefined, 2000),
                /response stream error|ECONNRESET/
            );
        } finally { restore(); }
    });
}

async function testClickUpV3ResponseErrorMidStream() {
    await withWorkspace('hang-clickup-v3-res-error', async ({ workspaceRoot }) => {
        const service = createClickUpService(workspaceRoot);
        const restore = installPathologicalHttps(({ callback }) => {
            const res = new EventEmitter();
            res.statusCode = 200;
            callback(res);
            setImmediate(() => res.emit('error', new Error('TLS reset')));
        });
        try {
            await assert.rejects(
                () => service.httpRequestV3('GET', '/docs/abc', undefined, 2000),
                /v3 response stream error|TLS reset/
            );
        } finally { restore(); }
    });
}

// 2. Response aborted after headers.
async function testResponseAbortedAfterHeaders() {
    await withWorkspace('hang-res-aborted', async ({ workspaceRoot }) => {
        const service = createLinearService(workspaceRoot);
        const restore = installPathologicalHttps(({ callback }) => {
            const res = new EventEmitter();
            res.statusCode = 200;
            callback(res);
            setImmediate(() => res.emit('aborted'));
        });
        try {
            await assert.rejects(
                () => service.graphqlRequest('{ viewer { id } }', undefined, 2000),
                /aborted/
            );
        } finally { restore(); }
    });
}

// 3. Idempotent settle — end+error fire back-to-back without unhandled rejection.
async function testIdempotentSettle() {
    await withWorkspace('hang-idempotent-settle', async ({ workspaceRoot }) => {
        const service = createLinearService(workspaceRoot);
        const restore = installPathologicalHttps(({ callback }) => {
            const res = new EventEmitter();
            res.statusCode = 200;
            callback(res);
            setImmediate(() => {
                res.emit('data', Buffer.from('{"data":{"viewer":{"id":"x"}}}'));
                res.emit('end');
                // Spurious late error — must not cause a second reject nor an
                // unhandled rejection.
                res.emit('error', new Error('late boom'));
            });
        });
        let unhandled = null;
        const handler = (reason) => { unhandled = reason; };
        process.on('unhandledRejection', handler);
        try {
            const result = await service.graphqlRequest('{ viewer { id } }');
            assert.deepStrictEqual(result.data, { viewer: { id: 'x' } });
            await flushPromises();
            await flushPromises();
            assert.strictEqual(unhandled, null, 'spurious late error triggered unhandled rejection');
        } finally {
            process.off('unhandledRejection', handler);
            restore();
        }
    });
}

// 4. Abort during mid-stream — rejects promptly with AbortError.
async function testAbortMidStream() {
    await withWorkspace('hang-abort-mid', async ({ workspaceRoot }) => {
        const service = createLinearService(workspaceRoot);
        const restore = installPathologicalHttps(({ callback }) => {
            const res = new EventEmitter();
            res.statusCode = 200;
            callback(res);
            // Hang — never emit end/error.
        });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 50);
        const start = Date.now();
        try {
            await assert.rejects(
                () => service.graphqlRequest('{ viewer { id } }', undefined, 5000, controller.signal),
                /AbortError/
            );
            assert.ok(Date.now() - start < 500, 'abort should reject within 500ms');
        } finally { restore(); }
    });
}

// 5. httpRequestV3 accepts signal (regression for the missing-param bug).
async function testHttpRequestV3AcceptsSignal() {
    await withWorkspace('hang-v3-signal', async ({ workspaceRoot }) => {
        const service = createClickUpService(workspaceRoot);
        const restore = installPathologicalHttps(() => {
            // Hang forever — caller must abort.
        });
        const controller = new AbortController();
        controller.abort();
        try {
            await assert.rejects(
                () => service.httpRequestV3('GET', '/docs/abc', undefined, 5000, controller.signal),
                /AbortError/
            );
        } finally { restore(); }
    });
}

async function run() {
    await testLinearResponseErrorMidStream();
    await testClickUpResponseErrorMidStream();
    await testClickUpV3ResponseErrorMidStream();
    await testResponseAbortedAfterHeaders();
    await testIdempotentSettle();
    await testAbortMidStream();
    await testHttpRequestV3AcceptsSignal();
    console.log('sync hang regression test passed');
}

run().catch((error) => {
    console.error('sync hang regression test failed:', error);
    process.exit(1);
});
