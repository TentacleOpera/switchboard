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
 *   --settle <ms>                Type this long after spawn even if nothing renders (default: 2500)
 *   --ready-delay <ms>           Type this long after a readiness marker appears (default: 1200)
 *   --keep-env <A,B>             Do NOT strip these trust/auth env vars from the child
 *
 * Exit codes: 0 = measured, 2 = bad arguments, 3 = INCONCLUSIVE (no launch / no input sent).
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
  --settle <ms>                Type this long after spawn even if nothing renders (default: 2500)
  --ready-delay <ms>           Type this long after a readiness marker appears (default: 1200)
  --keep-env <A,B>             Do NOT strip these trust/auth env vars from the child

Exit codes: 0 = measured, 2 = bad arguments, 3 = INCONCLUSIVE (no launch / no input sent).
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
    settleMs: 2500,
    readyDelayMs: 1200,
    keepEnv: [],
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
    } else if (arg === '--settle' && i + 1 < rawArgs.length) {
        options.settleMs = parseInt(rawArgs[++i], 10) || 2500;
    } else if (arg === '--ready-delay' && i + 1 < rawArgs.length) {
        options.readyDelayMs = parseInt(rawArgs[++i], 10) || 1200;
    } else if (arg === '--keep-env' && i + 1 < rawArgs.length) {
        options.keepEnv = rawArgs[++i].split(',').map((v) => v.trim()).filter(Boolean);
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
const CONFIG_TARGETS = {
    copilot: '.copilot/config.json',
    claude: '.claude/settings.json',
    gemini: '.gemini/trustedFolders.json',
    agy: '.gemini/antigravity-cli/settings.json',
};

let configWritten = null;
if (options.configType || options.configPath) {
    let relConfigPath = options.configPath;

    if (!relConfigPath) {
        relConfigPath = CONFIG_TARGETS[options.configType.toLowerCase()];
        if (!relConfigPath) {
            // Hard error, not a warning: degrading to a baseline run while the
            // report still carries `configType` records a config test that never
            // happened, and that lie is what lands in the docs table.
            console.error(
                `[probe] Unrecognized --config-type "${options.configType}". ` +
                `Known types: ${Object.keys(CONFIG_TARGETS).join(', ')}. ` +
                `Use --config-path <relPath> to target a file directly.`
            );
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
            process.exit(2);
        }
    }

    // Built unconditionally: a --config-path run used to skip the switch and
    // write an empty `{}`, testing nothing while reporting as a config test.
    const configPayload = { [options.configKey]: [testCwd] };
    const fullConfigPath = path.join(tempHome, relConfigPath);
    fs.mkdirSync(path.dirname(fullConfigPath), { recursive: true });
    fs.writeFileSync(fullConfigPath, JSON.stringify(configPayload, null, 2), 'utf8');
    configWritten = fullConfigPath;
    console.log(`[probe] Pre-populated config at: ${fullConfigPath}`);
}

const started = Date.now();
const elapsedMs = () => Date.now() - started;

let rawBuffer = '';
let typeScheduled = false;
let typedSent = false;
let typedAtOffset = -1;
let finished = false;
let typedEchoed = false;

// A baseline arm must actually be untrusted. The operator's own shell may already
// export trust/auth overrides for these CLIs; inheriting them pre-consents the
// "without the mechanism" spawn and turns protocol step 1 into a false pass.
const TRUST_ENV_LEAKS = [
    'GEMINI_CLI_TRUST_WORKSPACE',
    'COPILOT_ALLOW_ALL',
    'CLAUDE_TRUSTED_DIRECTORIES',
    'FACTORY_API_KEY',
];

const childEnv = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    XDG_CONFIG_HOME: path.join(tempHome, '.config'),
    NO_COLOR: '1',
    DEVIN_CLI_AUTO_UPDATE: 'false',
};
const strippedEnv = [];
for (const key of TRUST_ENV_LEAKS) {
    if (options.keepEnv.includes(key)) continue;
    if (key in childEnv) strippedEnv.push(key);
    delete childEnv[key];
}

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

const escapeCtl = (str) => str.replace(/\r/g, '\\r').replace(/\n/g, '\\n');

function finish(statusReason) {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutHandle);
    clearTimeout(settleTimer);
    clearTimeout(typeTimer);
    try { child.kill(); } catch (_) {}

    // Search only output produced AFTER the write. Searching the whole buffer can
    // match the payload in text the CLI never echoed back.
    if (typedSent && options.typeChars) {
        typedEchoed = rawBuffer.slice(typedAtOffset).includes(options.typeChars);
    }

    const hasTrustOrConsentPrompt =
        /trust this (folder|directory|workspace)/i.test(rawBuffer) ||
        /do you trust/i.test(rawBuffer) ||
        /terms of service/i.test(rawBuffer) ||
        // [\s\S], not `.`: copilot renders one option per line, and its "No" is
        // option 3, not 2. The old /1\.\s*Yes.*2\.\s*No/ matched neither.
        /1\.\s*Yes[\s\S]{0,240}?\d\.\s*No\b/i.test(rawBuffer) ||
        /remember this folder/i.test(rawBuffer) ||
        /Enter to select/i.test(rawBuffer);

    // A CLI that never launched, or died before rendering, measured nothing.
    // Reporting hasTrustOrConsentPrompt:false for it reads as "no prompt" — the
    // exact false negative that would propagate into the docs table.
    const launched = rawBuffer.length > 0;
    const inconclusive = !launched || !typedSent;
    const inconclusiveReason = !launched
        ? 'no output — the CLI did not launch or rendered nothing'
        : (!typedSent ? 'the probe never sent input, so echo was not measured' : null);

    const report = {
        cli: cliBinary,
        args: options.cliArgs,
        configType: options.configType || null,
        configWritten,
        strippedEnv,
        durationMs: elapsedMs(),
        statusReason,
        verdict: inconclusive
            ? 'INCONCLUSIVE'
            : (hasTrustOrConsentPrompt ? 'PROMPT_BLOCKED' : (typedEchoed ? 'CLEAR' : 'NO_PROMPT_NO_ECHO')),
        inconclusiveReason,
        hasTrustOrConsentPrompt,
        typedSent,
        typedEchoed,
        bufferHead: escapeCtl(rawBuffer.slice(0, 1200)),
        bufferTail: rawBuffer.length > 1200 ? escapeCtl(rawBuffer.slice(-1200)) : '',
    };

    console.log('\n=== Probe Result ===');
    console.log(JSON.stringify(report, null, 2));

    cleanup();
    // Non-zero on INCONCLUSIVE so a scripted sweep cannot silently record a
    // failed launch as "no prompt".
    process.exit(inconclusive ? 3 : 0);
}

function cleanup() {
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
}

function sendTypeChars() {
    if (finished || typedSent) return;
    typedAtOffset = rawBuffer.length;
    typedSent = true;
    try { child.write(options.typeChars); } catch (_) {}
    setTimeout(() => finish('observed'), 1000);
}

function scheduleType(delayMs) {
    if (typeScheduled) return;
    typeScheduled = true;
    clearTimeout(settleTimer);
    typeTimer = setTimeout(sendTypeChars, delayMs);
}

const timeoutHandle = setTimeout(() => {
    finish('timeout');
}, options.timeout);

let typeTimer = null;
// Fires even when the CLI renders nothing at all (grok's measured case). Without
// it the probe never reaches protocol step 3 for a silent CLI, so a silent CLI
// could never qualify no matter what the mechanism did.
const settleTimer = setTimeout(() => scheduleType(0), options.settleMs);

child.onData((data) => {
    rawBuffer += data;
    if (data.includes('❭') || data.includes('>') || data.includes('?')) {
        scheduleType(options.readyDelayMs);
    }
});

child.onExit(({ exitCode, signal }) => {
    finish(`exit:${exitCode}:${signal}`);
});
