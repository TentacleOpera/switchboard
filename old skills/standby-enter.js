#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function parseArgs(argv) {
    const args = {
        agent: '',
        pair: false,
        quiet: false,
        workspace: process.cwd(),
        timeoutSec: 1800,
        heartbeatSec: 60
    };

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--agent' && argv[i + 1]) {
            args.agent = String(argv[++i]);
            continue;
        }
        if (token === '--pair') {
            args.pair = true;
            continue;
        }
        if (token === '--quiet') {
            args.quiet = true;
            continue;
        }
        if (token === '--workspace' && argv[i + 1]) {
            args.workspace = path.resolve(String(argv[++i]));
            continue;
        }
        if (token === '--timeout' && argv[i + 1]) {
            const parsed = Number(argv[++i]);
            if (Number.isFinite(parsed) && parsed > 0) args.timeoutSec = parsed;
            continue;
        }
        if (token === '--heartbeat' && argv[i + 1]) {
            const parsed = Number(argv[++i]);
            if (Number.isFinite(parsed) && parsed >= 0) args.heartbeatSec = parsed;
            continue;
        }
    }

    return args;
}

const { agent, pair, quiet, workspace, timeoutSec, heartbeatSec } = parseArgs(process.argv.slice(2));
if (!agent) {
    console.error('Usage: node .agent/scripts/standby-enter.js --agent <name> [--pair] [--quiet] [--workspace <path>] [--timeout <seconds>] [--heartbeat <seconds|0>] (0 disables pulse logs)');
    process.exit(1);
}

const switchboardDir = path.join(workspace, '.switchboard');
const inboxDir = resolveInboxDir(switchboardDir, agent);
const plansDir = path.join(switchboardDir, 'plans');
const watchDir = pair ? plansDir : inboxDir;
const signalFile = pair ? path.join(switchboardDir, 'standby_pair_signal.done') : null;
const locksDir = path.join(switchboardDir, 'locks');
const lockFile = path.join(locksDir, `standby-${agent}.lock.json`);
const sessionsDir = path.join(switchboardDir, 'sessions');
const sessionFile = path.join(sessionsDir, `standby-${agent}.json`);
const sessionStartMs = Date.now();
const sessionStartIso = new Date(sessionStartMs).toISOString();

fs.mkdirSync(watchDir, { recursive: true });
fs.mkdirSync(locksDir, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });
if (pair && signalFile && fs.existsSync(signalFile)) {
    try { fs.unlinkSync(signalFile); } catch { }
}

function resolveInboxDir(root, agentName) {
    const inboxRoot = path.join(root, 'inbox');
    try {
        fs.mkdirSync(inboxRoot, { recursive: true });
    } catch { }

    try {
        const entries = fs.readdirSync(inboxRoot, { withFileTypes: true });
        const directMatch = entries.find(entry =>
            entry.isDirectory() &&
            entry.name.toLowerCase() === agentName.toLowerCase()
        );
        if (directMatch) return path.join(inboxRoot, directMatch.name);

        // Backward-compatible fallback for system-agent rename.
        if (agentName.toLowerCase() === 'standby-agent') {
            const legacy = entries.find(entry => entry.isDirectory() && entry.name.toLowerCase() === 'mcp-agent');
            if (legacy) return path.join(inboxRoot, legacy.name);
        }
    } catch { }

    return path.join(inboxRoot, agentName);
}

function isProcessAlive(pid) {
    if (!pid || !Number.isFinite(pid)) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function getProcessDetails(pid) {
    if (!pid || !Number.isFinite(pid)) return null;
    try {
        if (process.platform === 'win32') {
            const listRaw = cp.execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { windowsHide: true }).toString().trim();
            if (!listRaw || /^INFO:\s*No tasks/i.test(listRaw)) return null;

            const image = listRaw.split(',')[0]?.replace(/^"|"$/g, '').toLowerCase() || '';
            let commandLine = '';
            try {
                const cmd = `powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object -ExpandProperty CommandLine)"`;
                commandLine = cp.execSync(cmd, { windowsHide: true }).toString().trim().toLowerCase();
            } catch {
                // Best effort only.
            }
            return { image, commandLine };
        }

        const image = cp.execSync(`ps -p ${pid} -o comm=`, { windowsHide: true }).toString().trim().toLowerCase();
        if (!image) return null;

        let commandLine = '';
        try {
            commandLine = cp.execSync(`ps -p ${pid} -o args=`, { windowsHide: true }).toString().trim().toLowerCase();
        } catch {
            // Best effort only.
        }
        return { image, commandLine };
    } catch {
        return null;
    }
}

function classifyStandbyWatcherProcess(pid, agentName) {
    if (!pid || !Number.isFinite(pid)) return 'dead';
    if (!isProcessAlive(pid)) return 'dead';

    const details = getProcessDetails(pid);
    if (!details) return 'unknown_alive';
    if (!details.image.includes('node')) return 'other_process';

    const cmd = details.commandLine || '';
    if (!cmd) return 'unknown_alive';

    const normalizedAgent = String(agentName || '').toLowerCase();
    const isStandbyWatcher = cmd.includes('standby-enter.js') &&
        cmd.includes('--agent') &&
        cmd.includes(normalizedAgent);

    return isStandbyWatcher ? 'same_watcher' : 'other_process';
}

function acquireLockOrExit() {
    const lockPayload = JSON.stringify({
        pid: process.pid,
        startedAt: sessionStartIso,
        agent,
        workspace
    }, null, 2);
    const tryCreateLock = () => {
        const fd = fs.openSync(lockFile, 'wx');
        fs.writeFileSync(fd, lockPayload, 'utf8');
        fs.closeSync(fd);
    };

    try {
        tryCreateLock();
        return;
    } catch (e) {
        if (e?.code !== 'EEXIST') {
            throw e;
        }
    }

    try {
        const existing = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        const existingPid = Number(existing?.pid);
        const classification = classifyStandbyWatcherProcess(existingPid, agent);
        if (classification === 'same_watcher') {
            console.error(`[Standby] Existing watcher already active for ${agent} (PID ${existingPid}). Exiting.`);
            process.exit(0);
        }
        if (classification === 'unknown_alive') {
            console.error(`[Standby] Existing watcher lock points to live PID ${existingPid}, but process identity is unreadable. Exiting to avoid duplicate standby watchers.`);
            process.exit(0);
        }
    } catch {
        // Keep going: we will attempt to replace a stale/corrupt lock.
    }

    try {
        fs.unlinkSync(lockFile);
    } catch { }

    try {
        tryCreateLock();
    } catch (e) {
        if (e?.code === 'EEXIST') {
            console.error(`[Standby] Existing watcher lock was recreated for ${agent}. Exiting.`);
            process.exit(0);
        }
        throw e;
    }
}

function releaseLock() {
    try {
        if (!fs.existsSync(lockFile)) return;
        const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (Number(current?.pid) === process.pid) {
            fs.unlinkSync(lockFile);
        }
    } catch { }
}

function isFreshEventFile(name) {
    const filePath = path.join(watchDir, name);
    if (!fs.existsSync(filePath)) return false;
    try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < sessionStartMs) return false;
        if (!pair && name.endsWith('.json')) {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (parsed?.createdAt) {
                const createdAtMs = Date.parse(parsed.createdAt);
                if (Number.isFinite(createdAtMs) && createdAtMs < sessionStartMs) {
                    return false;
                }
            }
        }
        return true;
    } catch {
        return false;
    }
}

acquireLockOrExit();
fs.writeFileSync(sessionFile, JSON.stringify({ agent, mode: pair ? 'pair' : 'default', startedAt: sessionStartIso, pid: process.pid }, null, 2), 'utf8');

if (!quiet) {
    console.error(`[Standby] Agent=${agent} Mode=${pair ? 'pair' : 'default'} Watching=${watchDir}`);
    console.error(`[Standby] Idle watch active. Heartbeat=${heartbeatSec}s Timeout=${timeoutSec > 0 ? `${timeoutSec}s` : 'none'}`);
}

let heartbeatTimer = null;
if (!quiet && heartbeatSec > 0) {
    heartbeatTimer = setInterval(() => {
        console.error(`[Standby] Heartbeat: watching ${watchDir} (pid=${process.pid})`);
    }, heartbeatSec * 1000);
}

const watcher = fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    const name = String(filename);

    if (name.endsWith('.tmp') || name.endsWith('.crswap') || name.endsWith('.lock') || name.endsWith('~')) return;
    if (!pair && !name.endsWith('.json')) return;
    if (!isFreshEventFile(name)) return;

    if (pair && signalFile) {
        try {
            fs.writeFileSync(signalFile, JSON.stringify({
                event: eventType,
                file: name,
                timestamp: new Date().toISOString(),
                sessionStartedAt: sessionStartIso
            }, null, 2));
        } catch { }
    }

    console.error(`[Standby] Wake-up trigger: ${name}`);
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    releaseLock();
    process.exit(0);
});

process.on('SIGINT', () => {
    try { watcher.close(); } catch { }
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    releaseLock();
    process.exit(0);
});

if (timeoutSec > 0) {
    setTimeout(() => {
        try { watcher.close(); } catch { }
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        console.error('[Standby] Watch cycle ended with no trigger.');
        releaseLock();
        process.exit(0);
    }, timeoutSec * 1000);
}

process.on('exit', () => {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    releaseLock();
});
