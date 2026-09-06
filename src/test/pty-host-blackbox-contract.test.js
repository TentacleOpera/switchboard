'use strict';

/**
 * Language-neutral black-box contract for the Go PTY host.
 * Source-shaped TypeScript greps are not enough: this launches the packaged
 * candidate (when present) or pins the fixture + source behaviour so the
 * migrated host cannot drop payload, receipt, framing, auth, or lifecycle.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'protocol-fixtures', 'pty-host-ready.json'), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'pty-host-artifacts.json'), 'utf8'));

let failures = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err && err.message}`);
    }
}

function nativeTarget() {
    const platform = process.platform === 'win32' ? 'win32' : process.platform;
    const arch = process.arch === 'x64' ? 'amd64' : process.arch;
    return `${platform}-${arch}`;
}

function nativeBinary() {
    const relative = MANIFEST.targets[nativeTarget()];
    if (!relative) { return null; }
    const candidates = [
        path.join(REPO_ROOT, relative),
        path.join(REPO_ROOT, 'dist', relative.replace(/^dist\//, '')),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

function post(port, token, verb, payload) {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify(payload ?? {}));
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: `/api/pty/${encodeURIComponent(verb)}`,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': body.length,
            },
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(raw); } catch { /* non-JSON */ }
                resolve({ status: res.statusCode, json, raw });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

function assertDead(pid, label) {
    if (!pid) { throw new Error(`${label}: missing pid`); }
    try {
        process.kill(pid, 0);
        throw new Error(`${label}: pid ${pid} still alive`);
    } catch (err) {
        if (err && err.code === 'ESRCH') { return; }
        throw err;
    }
}

async function waitDead(pid, label, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try {
            assertDead(pid, label);
            return;
        } catch (err) {
            last = err;
            await new Promise(r => setTimeout(r, 50));
        }
    }
    throw last || new Error(`${label}: pid ${pid} still alive after ${timeoutMs}ms`);
}

function startHost(bin, workspace = REPO_ROOT, extra = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, ['--workspace', workspace], { stdio: ['pipe', 'pipe', 'pipe'], ...extra });
        let buffer = '';
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error('handshake timeout'));
        }, 5000);
        child.stdout.on('data', chunk => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) { continue; }
                try {
                    const msg = JSON.parse(line);
                    if (msg.t === 'ready' && Number.isInteger(msg.port) && msg.token && msg.version === 1) {
                        clearTimeout(timer);
                        resolve({ child, port: msg.port, token: msg.token });
                        return;
                    }
                } catch { /* wait */ }
            }
        });
        child.once('error', err => {
            clearTimeout(timer);
            reject(err);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            reject(new Error(`exited before handshake code=${code} signal=${signal}`));
        });
    });
}

(async function main() {
    console.log('\n── PTY host black-box contract ──');

    await test('fixtures encode prompt framing and receipt fields', () => {
        assert.strictEqual(FIXTURES.bytes.chunkBoundary, 256);
        assert.ok(FIXTURES.verbs.ptySendPrompt.request.prompt);
        assert.strictEqual(FIXTURES.verbs.ptySendPrompt.framing, 'bracketed-paste');
    });

    await test('Go source preserves data payload, isolated CR, logs, and parent-death', () => {
        const mainGo = fs.readFileSync(path.join(REPO_ROOT, 'cmd', 'switchboard-pty-host', 'main.go'), 'utf8');
        const promptGo = fs.readFileSync(path.join(REPO_ROOT, 'cmd', 'switchboard-pty-host', 'prompt.go'), 'utf8');
        const logGo = fs.readFileSync(path.join(REPO_ROOT, 'cmd', 'switchboard-pty-host', 'log.go'), 'utf8');
        assert.ok(promptGo.includes('strField') || mainGo.includes('strField(payload, "data")'));
        assert.ok(promptGo.includes('confirmEnterDelay'));
        assert.ok(promptGo.includes('bracketedPasteOpen'));
        assert.ok(promptGo.includes('"bytesWritten"'));
        assert.ok(promptGo.includes('"promptSeq"'));
        assert.ok(promptGo.includes('"cleared"'));
        assert.ok(promptGo.includes('waitReadiness'));
        assert.ok(!/sleep\(20 \* time\.Millisecond\)/.test(promptGo), 'boot readiness must not be a fixed 20ms sleep');
        assert.ok(logGo.includes('## '));
        assert.ok(mainGo.includes('io.Copy(io.Discard, os.Stdin)'));
        assert.ok(mainGo.includes('os.Getppid()'));
        assert.ok(mainGo.includes('SIGTERM'));
        const fleet = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'goPtyFleetProjection.ts'), 'utf8');
        assert.ok(fleet.includes("t: 'resize'"), 'GoPtyFleetProjection must send live resize over WebSocket');
        assert.ok(fleet.includes("message.t === 'output'"), 'GoPtyFleetProjection must fan out onData from the live stream');
        assert.ok(fleet.includes("message.t === 'exit'"), 'GoPtyFleetProjection must fan out onExit from the live stream');
    });

    const bin = nativeBinary();
    if (!bin) {
        console.log('  ⚠️  native Go PTY host absent — handshake probe skipped (build scripts/build-pty-host.sh)');
    } else {
        await test('native host handshake + prompt receipt against data payload', async () => {
            const { child, port, token } = await startHost(bin);
            try {
                const created = await post(port, token, 'ptyCreateTerminal', { role: 'coder', name: 'blackbox-coder-1' });
                assert.strictEqual(created.status, 200);
                assert.ok(created.json && created.json.success !== false, created.raw);
                const sent = await post(port, token, 'ptySendPrompt', { name: 'blackbox-coder-1', data: 'hello from blackbox' });
                assert.strictEqual(sent.status, 200);
                assert.ok(sent.json, sent.raw);
                assert.strictEqual(typeof sent.json.bytesWritten, 'number');
                assert.ok(sent.json.bytesWritten > 0, 'data payload must reach the PTY');
                assert.strictEqual(typeof sent.json.deliveredAt, 'number');
                assert.ok(sent.json.promptSeq >= 1);
                const listed = await post(port, token, 'ptyListTerminals', {});
                assert.ok(Array.isArray(listed.json.terminals));
                const badJson = await new Promise((resolve, reject) => {
                    const req = http.request({
                        hostname: '127.0.0.1', port,
                        path: '/api/pty/ptyWrite', method: 'POST',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': 3 },
                    }, res => {
                        const chunks = [];
                        res.on('data', c => chunks.push(c));
                        res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
                    });
                    req.on('error', reject);
                    req.end('{{{');
                });
                assert.strictEqual(badJson.status, 400);
                const unknown = await post(port, token, 'notAVerb', {});
                assert.ok(unknown.json && unknown.json.code === 'unknown_verb');
                assert.ok(sent.json.readiness, 'prompt readiness must be reported');
                assert.notStrictEqual(sent.json.readiness.reason, undefined);
                assert.ok(sent.json.readiness.elapsedMs >= 0);
            } finally {
                try { child.stdin.end(); } catch { /* ignore */ }
                child.kill('SIGTERM');
            }
        });

        await test('websocket auth, replay, input, resize, logging, close, parent-death, process-tree', async () => {
            const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-blackbox-'));
            const { child, port, token } = await startHost(bin, workspace);
            const name = 'blackbox-ws-1';
            try {
                const created = await post(port, token, 'ptyCreateTerminal', { role: 'coder', name });
                assert.strictEqual(created.status, 200, created.raw);
                const pid = created.json.terminal.pid;
                assert.ok(pid > 0);

                const emptyToken = await new Promise((resolve, reject) => {
                    const req = http.request({
                        hostname: '127.0.0.1', port, path: `/ws/terminal?name=${name}&token=`,
                        method: 'GET',
                        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
                    }, res => resolve(res.statusCode));
                    req.on('error', reject);
                    req.end();
                });
                assert.strictEqual(emptyToken, 401);

                const wrongToken = await new Promise((resolve, reject) => {
                    const req = http.request({
                        hostname: '127.0.0.1', port, path: `/ws/terminal?name=${name}&token=wrong`,
                        method: 'GET',
                        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
                    }, res => resolve(res.statusCode));
                    req.on('error', reject);
                    req.end();
                });
                assert.strictEqual(wrongToken, 401);

                const wsUrl = `ws://127.0.0.1:${port}/ws/terminal?name=${encodeURIComponent(name)}&token=${encodeURIComponent(token)}`;
                const ws = new WebSocket(wsUrl);
                const frames = [];
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('ws hello timeout')), 5000);
                    ws.on('error', err => { clearTimeout(timer); reject(err); });
                    ws.on('message', raw => {
                        const msg = JSON.parse(String(raw));
                        frames.push(msg);
                        if (msg.t === 'hello') { clearTimeout(timer); resolve(); }
                    });
                });
                assert.strictEqual(frames[0].t, 'hello');

                const marker = `BLACKBOX_${Date.now()}`;
                ws.send(JSON.stringify({ t: 'input', data: `echo ${marker}\r` }));
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('ws output timeout')), 5000);
                    const onMsg = raw => {
                        const msg = JSON.parse(String(raw));
                        frames.push(msg);
                        if ((msg.t === 'output' || msg.t === 'replay') && String(msg.data).includes(marker)) {
                            clearTimeout(timer);
                            ws.off('message', onMsg);
                            resolve();
                        }
                    };
                    ws.on('message', onMsg);
                });

                const lastSeq = frames.filter(f => typeof f.seq === 'number').reduce((m, f) => Math.max(m, f.seq), 0);
                ws.close();

                const ws2 = new WebSocket(`${wsUrl}&lastSeq=0`);
                const replayed = [];
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('replay timeout')), 5000);
                    ws2.on('error', err => { clearTimeout(timer); reject(err); });
                    ws2.on('message', raw => {
                        const msg = JSON.parse(String(raw));
                        replayed.push(msg);
                        if (msg.t === 'replay' && String(msg.data).includes(marker)) {
                            clearTimeout(timer);
                            resolve();
                        }
                    });
                });
                assert.ok(replayed.some(f => f.t === 'replay' && String(f.data).includes(marker)), 'replay must re-send earlier output');
                assert.ok(lastSeq >= 1);
                ws2.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }));
                await new Promise(r => setTimeout(r, 150));
                ws2.close();

                const rolled = await post(port, token, 'ptyRollLogSession', { name });
                assert.ok(rolled.json && rolled.json.success !== false, rolled.raw);
                const logDir = path.join(workspace, '.switchboard', 'logs');
                const logs = fs.existsSync(logDir) ? fs.readdirSync(logDir) : [];
                assert.ok(logs.some(f => f.startsWith(name) && f.endsWith('.md')), `expected session log under ${logDir}, got ${logs.join(',')}`);

                const closed = await post(port, token, 'ptyCloseTerminal', { name });
                assert.ok(closed.json && closed.json.success !== false, closed.raw);
                await waitDead(pid, 'explicit close');

                const created2 = await post(port, token, 'ptyCreateTerminal', { role: 'coder', name: 'blackbox-tree-1' });
                const treePid = created2.json.terminal.pid;
                try { child.stdin.end(); } catch { /* ignore */ }
                await new Promise(resolve => child.once('exit', resolve));
                await waitDead(treePid, 'stdin EOF process-tree');

                const parentWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-parent-'));
                const wrapper = spawn('bash', ['-c', `"${bin}" --workspace "${parentWorkspace}"`], { stdio: ['pipe', 'pipe', 'pipe'] });
                let buffer = '';
                const parentHost = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('parent-wrapper handshake timeout')), 5000);
                    wrapper.stdout.on('data', chunk => {
                        buffer += chunk.toString('utf8');
                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? '';
                        for (const line of lines) {
                            if (!line.trim()) { continue; }
                            try {
                                const msg = JSON.parse(line);
                                if (msg.t === 'ready') { clearTimeout(timer); resolve(msg); }
                            } catch { /* wait */ }
                        }
                    });
                    wrapper.once('error', err => { clearTimeout(timer); reject(err); });
                });
                const created3 = await post(parentHost.port, parentHost.token, 'ptyCreateTerminal', { role: 'coder', name: 'blackbox-parent-1' });
                const childPid = created3.json.terminal.pid;
                process.kill(wrapper.pid, 'SIGKILL');
                await waitDead(childPid, 'parent-death', 5000);
                try { fs.rmSync(parentWorkspace, { recursive: true, force: true }); } catch { /* ignore */ }
            } finally {
                try { child.kill('SIGTERM'); } catch { /* already gone */ }
                try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
            }
        });
    }

    if (failures > 0) { process.exit(1); }
    console.log('PTY host black-box contract passed.');
})();
