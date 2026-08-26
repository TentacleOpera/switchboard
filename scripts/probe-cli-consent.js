#!/usr/bin/env node
'use strict';

/**
 * probe-cli-consent.js — Diagnostic harness for CLI workspace trust / consent gates.
 *
 * Spawns an agent CLI on a node-pty master in a fresh, untrusted directory,
 * measures whether modal trust/ToS prompts appear, tests flag and config-file
 * pre-population suppression mechanisms, and checks whether typed input echoes.
 *
 * Usage:
 *   node scripts/probe-cli-consent.js <cli> [options]
 *
 * Options:
 *   --cli-args "<args>"          CLI flags to pass (e.g. "--skip-trust")
 *   --config-type <type>         Config type to pre-populate: copilot | claude | gemini | agy
 *   --config-key <key>           JSON key for trusted paths (default: "trustedDirectories")
 *   --config-path <relPath>      Custom relative config path under temp HOME
 *   --cwd <dir>                  Working directory (default: fresh temporary directory)
 *   --timeout <ms>               Max run duration before abort (default: 15000)
 *   --type-chars <chars>         Characters to type after prompt (default: "abcdefgh")
 *
 * Examples:
 *   # 1. Baseline: spawn gemini in fresh dir without flags
 *   node scripts/probe-cli-consent.js gemini
 *
 *   # 2. Flag test: spawn gemini with --skip-trust flag
 *   node scripts/probe-cli-consent.js gemini --cli-args "--skip-trust"
 *
 *   # 3. Config-file test: pre-populate copilot trustedDirectories in temporary HOME
 *   node scripts/probe-cli-consent.js copilot --config-type copilot
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let pty;
try {
    pty = require('node-pty');
} catch (err) {
    console.error('node-pty is not installed. Run: npm install node-pty');
    process.exit(1);
}

const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0 || rawArgs.includes('-h') || rawArgs.includes('--help')) {
    console.log(`Usage: node scripts/probe-cli-consent.js <cli> [options]
Options:
  --cli-args "<args>"          CLI flags to pass (e.g. "--skip-trust")
  --config-type <type>         Config type to pre-populate: copilot | claude | gemini | agy
  --config-key <key>           JSON key for trusted paths (default: "trustedDirectories")
  --config-path <relPath>      Custom relative config path under temp HOME
  --cwd <dir>                  Working directory (default: fresh temporary directory)
  --timeout <ms>               Max run duration before abort (default: 15000)
  --type-chars <chars>         Characters to type after prompt (default: "abcdefgh")
`);
    process.exit(0);
}

const cliBinary = rawArgs[0];
const options = {
    cliArgs: [],
    configType: '',
    configKey: 'trustedDirectories',
    configPath: '',
    cwd: '',
    timeout: 15000,
    typeChars: 'abcdefgh',
};

for (let i = 1; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--cli-args' && i + 1 < rawArgs.length) {
        options.cliArgs = rawArgs[++i].split(/\s+/).filter(Boolean);
    } else if (arg === '--config-type' && i + 1 < rawArgs.length) {
        options.configType = rawArgs[++i];
    } else if (arg === '--config-key' && i + 1 < rawArgs.length) {
        options.configKey = rawArgs[++i];
    } else if (arg === '--config-path' && i + 1 < rawArgs.length) {
        options.configPath = rawArgs[++i];
    } else if (arg === '--cwd' && i + 1 < rawArgs.length) {
        options.cwd = rawArgs[++i];
    } else if (arg === '--timeout' && i + 1 < rawArgs.length) {
        options.timeout = parseInt(rawArgs[++i], 10) || 15000;
    } else if (arg === '--type-chars' && i + 1 < rawArgs.length) {
        options.typeChars = rawArgs[++i];
    }
}

// Temporary directory setup
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-consent-probe-'));
const testCwd = options.cwd || path.join(tempDir, 'test-workspace');
if (!fs.existsSync(testCwd)) {
    fs.mkdirSync(testCwd, { recursive: true });
}

// Temporary HOME setup to prevent polluting operator's real config
const tempHome = path.join(tempDir, 'home');
fs.mkdirSync(tempHome, { recursive: true });

// Pre-populate config file if requested
if (options.configType || options.configPath) {
    let relConfigPath = options.configPath;
    let configPayload = {};

    if (!relConfigPath) {
        switch (options.configType.toLowerCase()) {
            case 'copilot':
                relConfigPath = '.copilot/config.json';
                configPayload = { [options.configKey || 'trustedDirectories']: [testCwd] };
                break;
            case 'claude':
                relConfigPath = '.claude/settings.json';
                configPayload = { [options.configKey || 'trustedDirectories']: [testCwd] };
                break;
            case 'gemini':
                relConfigPath = '.gemini/trustedFolders.json';
                configPayload = { [options.configKey || 'trustedDirectories']: [testCwd] };
                break;
            case 'agy':
                relConfigPath = '.gemini/antigravity-cli/settings.json';
                configPayload = { [options.configKey || 'trustedDirectories']: [testCwd] };
                break;
            default:
                console.warn(`[probe] Unrecognized configType: ${options.configType}`);
        }
    }

    if (relConfigPath) {
        const fullConfigPath = path.join(tempHome, relConfigPath);
        fs.mkdirSync(path.dirname(fullConfigPath), { recursive: true });
        fs.writeFileSync(fullConfigPath, JSON.stringify(configPayload, null, 2), 'utf8');
        console.log(`[probe] Pre-populated config at: ${fullConfigPath}`);
    }
}

const started = Date.now();
const elapsedMs = () => Date.now() - started;

let rawBuffer = '';
let typed = false;
let finished = false;
let typedEchoed = false;

const childEnv = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    NO_COLOR: '1',
    DEVIN_CLI_AUTO_UPDATE: 'false',
};

console.log(`[probe] Spawning ${cliBinary} in ${testCwd} with args: [${options.cliArgs.join(' ')}]`);

let child;
try {
    child = pty.spawn(cliBinary, options.cliArgs, {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: testCwd,
        env: childEnv,
    });
} catch (err) {
    console.error(`[probe] Failed to spawn ${cliBinary}:`, err.message);
    cleanup();
    process.exit(1);
}

function finish(statusReason) {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutHandle);
    try { child.kill(); } catch (_) {}

    // Check if typed chars echoed
    if (typed && options.typeChars) {
        typedEchoed = rawBuffer.includes(options.typeChars);
    }

    const hasTrustOrConsentPrompt =
        /trust this (folder|directory|workspace)/i.test(rawBuffer) ||
        /terms of service/i.test(rawBuffer) ||
        /1\.\s*Yes.*2\.\s*No/i.test(rawBuffer) ||
        /remember this folder/i.test(rawBuffer) ||
        /Enter to select/i.test(rawBuffer);

    const report = {
        cli: cliBinary,
        args: options.cliArgs,
        configType: options.configType || null,
        durationMs: elapsedMs(),
        statusReason,
        hasTrustOrConsentPrompt,
        typedSent: typed,
        typedEchoed,
        bufferSnippet: rawBuffer.slice(0, 1000).replace(/\r/g, '\\r').replace(/\n/g, '\\n'),
    };

    console.log('\n=== Probe Result ===');
    console.log(JSON.stringify(report, null, 2));

    cleanup();
    process.exit(0);
}

function cleanup() {
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
}

const timeoutHandle = setTimeout(() => {
    finish('timeout');
}, options.timeout);

child.onData((data) => {
    rawBuffer += data;

    // Detect prompt readiness or initial settle to test typing
    if (!typed && (data.includes('❭') || data.includes('>') || data.includes('?') || elapsedMs() > 2000)) {
        typed = true;
        setTimeout(() => {
            if (finished) return;
            child.write(options.typeChars);
            setTimeout(() => {
                finish('observed');
            }, 1000);
        }, 500);
    }
});

child.onExit(({ exitCode, signal }) => {
    finish(`exit:${exitCode}:${signal}`);
});
