'use strict';

const assert = require('assert');
const http = require('http');

const { withWorkspace, loadOutModule } = require('./integrations/shared/test-harness');
const { installVsCodeMock } = require('./integrations/shared/vscode-mock');

function createExecFileSuccess() {
    return (file, args, options, callback) => {
        callback(null, 'ollama version 0.11.0\n', '');
        return { pid: 1234 };
    };
}

async function withOllamaApiServer(handler, run) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/api`;
    try {
        await run(baseUrl);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }
}

async function run() {
    const vscodeMock = installVsCodeMock();
    vscodeMock.mock.window.terminals = [];

    try {
        const {
            OllamaSetupService,
            DEFAULT_OLLAMA_CLAUDE_MODEL
        } = loadOutModule('services/OllamaSetupService.js');

        await withWorkspace('ollama-installed', async ({ workspaceRoot }) => {
            const service = new OllamaSetupService(workspaceRoot, {
                execFile: createExecFileSuccess()
            });
            const state = await service.getSetupState({
                enabled: false,
                mode: 'cloud',
                model: DEFAULT_OLLAMA_CLAUDE_MODEL,
                baseUrl: 'https://ollama.com/api'
            });
            assert.strictEqual(state.installed, true, 'Expected successful --version probing to mark Ollama as installed.');
            assert.match(state.version || '', /ollama version/i, 'Expected the detected version string to be surfaced.');
        });

        await withWorkspace('ollama-missing', async ({ workspaceRoot }) => {
            const service = new OllamaSetupService(workspaceRoot, {
                execFile: (file, args, options, callback) => {
                    const error = new Error('spawn ollama ENOENT');
                    error.code = 'ENOENT';
                    callback(error, '', '');
                    return { pid: 1235 };
                }
            });
            const state = await service.getSetupState({
                enabled: false,
                mode: 'cloud',
                model: DEFAULT_OLLAMA_CLAUDE_MODEL,
                baseUrl: 'https://ollama.com/api'
            });
            assert.strictEqual(state.installed, false, 'Expected missing Ollama binary probing to fail closed.');
        });

        await withWorkspace('ollama-launch', async ({ workspaceRoot }) => {
            const terminalCommands = [];
            const terminal = {
                name: 'Switchboard Ollama',
                creationOptions: { name: 'Switchboard Ollama' },
                show() { },
                sendText(command) {
                    terminalCommands.push(command);
                }
            };
            const service = new OllamaSetupService(workspaceRoot, {
                execFile: createExecFileSuccess(),
                createTerminal: () => terminal
            });

            await service.launchClaudeCode(DEFAULT_OLLAMA_CLAUDE_MODEL);
            assert.deepStrictEqual(
                terminalCommands,
                [`ollama launch claude --model ${DEFAULT_OLLAMA_CLAUDE_MODEL}`],
                'Expected Claude Code launch to pass the validated model through to the terminal.'
            );

            await assert.rejects(
                () => service.launchClaudeCode('gemma4:31b-cloud; rm -rf /'),
                /Invalid Ollama model name/i,
                'Expected launch to reject unsafe shell-injection model names.'
            );
        });

        await withWorkspace('ollama-pull-cache', async ({ workspaceRoot }) => {
            let pullRequests = 0;
            await withOllamaApiServer((request, response) => {
                if (request.method === 'GET' && request.url === '/api/version') {
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ version: '0.11.0' }));
                    return;
                }
                if (request.method === 'GET' && request.url === '/api/tags') {
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ models: [] }));
                    return;
                }
                if (request.method === 'POST' && request.url === '/api/pull') {
                    pullRequests += 1;
                    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
                    response.write(JSON.stringify({ status: 'pulling manifest', total: 100, completed: 0 }) + '\n');
                    setTimeout(() => {
                        response.write(JSON.stringify({ status: 'downloading', total: 100, completed: 100 }) + '\n');
                        response.end(JSON.stringify({ status: 'success', total: 100, completed: 100, done: true }) + '\n');
                    }, 25);
                    return;
                }
                response.writeHead(404);
                response.end();
            }, async (localBaseUrl) => {
                const service = new OllamaSetupService(workspaceRoot, {
                    execFile: createExecFileSuccess(),
                    localBaseUrl
                });

                const [firstPull, secondPull] = await Promise.all([
                    service.pullModel('qwen2.5-coder:7b'),
                    service.pullModel('qwen2.5-coder:7b')
                ]);

                assert.strictEqual(firstPull.started, true, 'Expected the first local pull to start.');
                assert.strictEqual(secondPull.started, true, 'Expected duplicate pull requests to reuse the in-flight pull.');
                await new Promise((resolve) => setTimeout(resolve, 80));

                assert.strictEqual(pullRequests, 1, 'Expected duplicate pull requests to be deduplicated at the service layer.');
                const progress = service.getPullProgress('qwen2.5-coder:7b');
                assert.ok(progress, 'Expected pull progress to remain cached while the download completes.');
                assert.strictEqual(progress.done, true, 'Expected cached pull progress to mark the model as complete.');
                assert.strictEqual(progress.percent, 100, 'Expected cached pull progress to reach 100%.');
            });
        });

        console.log('ollama setup service regression test passed');
    } finally {
        vscodeMock.restore();
    }
}

run().catch((error) => {
    console.error('ollama setup service regression test failed:', error);
    process.exit(1);
});
