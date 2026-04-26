'use strict';

const assert = require('assert');
const path = require('path');
const { installVsCodeMock } = require('./integrations/shared/vscode-mock');

// The function under test lives in the compiled extension.ts. Tests use the
// existing pattern of installing the vscode mock first, then requiring the
// compiled `out/extension.js`. If the compiled output is missing the test
// hard-fails so CI cannot silently green a skipped regression guard.
function loadBuildSwitchboardMcpEnv() {
    installVsCodeMock();
    // tsc does not copy non-.ts files into out/, so the runtime sibling
    // require of `./kanbanColumnDerivationImpl.js` from the compiled
    // TaskViewerProvider fails. Re-route that one require to the source copy
    // so the rest of the compiled extension can load.
    const Module = require('module');
    const fs = require('fs');
    const realResolve = Module._resolveFilename;
    // tsc does not copy non-.ts sibling files into out/. When the compiled
    // tree requires such a file relatively, fall back to the matching src/ copy.
    Module._resolveFilename = function patched(request, parent, ...rest) {
        try {
            return realResolve.call(this, request, parent, ...rest);
        } catch (e) {
            if (request && request.startsWith('.') && parent && parent.filename && parent.filename.includes(`${path.sep}out${path.sep}`)) {
                const srcParent = parent.filename.replace(`${path.sep}out${path.sep}`, `${path.sep}src${path.sep}`);
                const candidates = [
                    path.resolve(path.dirname(srcParent), request),
                    path.resolve(path.dirname(srcParent), request + '.js'),
                    path.resolve(path.dirname(srcParent), request, 'index.js')
                ];
                for (const c of candidates) {
                    if (fs.existsSync(c)) return c;
                }
            }
            throw e;
        }
    };
    const compiledPath = path.join(__dirname, '..', '..', 'out', 'extension.js');
    let compiled;
    try {
        compiled = require(compiledPath);
    } catch (e) {
        throw new Error(
            `build-switchboard-mcp-env: failed to load ${compiledPath}: ${e && e.message ? e.message : e}. ` +
            `Run \`npm run compile\` before this test.`
        );
    } finally {
        Module._resolveFilename = realResolve;
    }
    if (typeof compiled.buildSwitchboardMcpEnv !== 'function') {
        throw new Error('build-switchboard-mcp-env: compiled extension does not export buildSwitchboardMcpEnv');
    }
    return compiled.buildSwitchboardMcpEnv;
}

function makeContext(secretMap, throwingKeys = new Set()) {
    const requested = [];
    return {
        requested,
        secrets: {
            async get(key) {
                requested.push(key);
                if (throwingKeys.has(key)) {
                    throw new Error(`simulated SecretStorage failure for ${key}`);
                }
                return secretMap[key];
            }
        }
    };
}

(async function run() {
    const buildEnv = loadBuildSwitchboardMcpEnv();

    // Case 1: both tokens present
    {
        const ctx = makeContext({
            'switchboard.linear.apiToken': 'lin_stub',
            'switchboard.clickup.apiToken': 'pk_stub'
        });
        const env = await buildEnv('/ws', '/state', {}, ctx);
        assert.strictEqual(env.SWITCHBOARD_LINEAR_TOKEN, 'lin_stub', 'Linear token should be populated');
        assert.strictEqual(env.SWITCHBOARD_CLICKUP_TOKEN, 'pk_stub', 'ClickUp token should be populated');
        assert.strictEqual(env.SWITCHBOARD_WORKSPACE_ROOT, '/ws');
        assert.strictEqual(env.SWITCHBOARD_STATE_ROOT, '/state');
        assert.ok(ctx.requested.includes('switchboard.linear.apiToken'), 'must query the Linear apiToken key');
        assert.ok(ctx.requested.includes('switchboard.clickup.apiToken'), 'must query the ClickUp apiToken key');
        // Regression guard: ensure the buggy key is NEVER queried again
        assert.ok(!ctx.requested.includes('switchboard.linear.token'), 'must not query the legacy Linear key');
        assert.ok(!ctx.requested.includes('switchboard.clickup.token'), 'must not query the legacy ClickUp key');
    }

    // Case 2: both tokens absent
    {
        const ctx = makeContext({});
        const env = await buildEnv('/ws', '/state', {}, ctx);
        assert.strictEqual(env.SWITCHBOARD_LINEAR_TOKEN, undefined, 'Linear token must be absent');
        assert.strictEqual(env.SWITCHBOARD_CLICKUP_TOKEN, undefined, 'ClickUp token must be absent');
    }

    // Case 3: Linear key throws — must not break ClickUp population
    {
        const ctx = makeContext(
            { 'switchboard.clickup.apiToken': 'pk_only' },
            new Set(['switchboard.linear.apiToken'])
        );
        const env = await buildEnv('/ws', '/state', {}, ctx);
        assert.strictEqual(env.SWITCHBOARD_LINEAR_TOKEN, undefined, 'Linear token absent after throw');
        assert.strictEqual(env.SWITCHBOARD_CLICKUP_TOKEN, 'pk_only', 'ClickUp token still populated');
    }

    console.log('PASS build-switchboard-mcp-env');
})().catch((err) => {
    console.error('FAIL build-switchboard-mcp-env', err);
    process.exit(1);
});
