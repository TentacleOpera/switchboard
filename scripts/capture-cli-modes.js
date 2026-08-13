#!/usr/bin/env node
'use strict';

/**
 * capture-cli-modes — Diagnostic harness for CLI startup DEC private modes.
 *
 * Spawns a CLI on a node-pty master (100×30), records the raw byte stream up to
 * the first prompt, and prints every DEC private mode (`?NNNh`/`?NNNl`) in order
 * plus counts of `\x1b[2J` (full-screen clear) and `\x1b[3J` (erase-scrollback).
 *
 * Used to diagnose the Claude CLI alternate-screen / mouse-grab issue that breaks
 * pane scrollback and the jump-to-latest pill. Re-run whenever a CLI changes its
 * startup sequence — the answer takes one command instead of a bisect.
 *
 * Usage:
 *   node scripts/capture-cli-modes.js <cli> [args...] [-- env KEY=val ...]
 *
 * Examples:
 *   node scripts/capture-cli-modes.js claude
 *   node scripts/capture-cli-modes.js claude -- env CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 CLAUDE_CODE_DISABLE_MOUSE=1
 *   node scripts/capture-cli-modes.js gemini
 *
 * Requires `node-pty` (optional dependency — `npm install node-pty` if missing).
 * The CLI is spawned in the current directory. For CLIs with a trust prompt
 * (e.g. Claude in an untrusted dir), the harness captures up to the trust
 * prompt, not the full REPL — run in a trusted workspace to see the full mode
 * set.
 */

const path = require('path');

let pty;
try {
    pty = require('node-pty');
} catch {
    console.error('node-pty is not installed. Run: npm install node-pty');
    process.exit(1);
}

// Parse args: everything before `--` is the command, everything after `-- env`
// is environment overrides.
const rawArgs = process.argv.slice(2);
const sepIdx = rawArgs.indexOf('--');
let cmdArgs;
let envOverrides = {};
if (sepIdx >= 0) {
    cmdArgs = rawArgs.slice(0, sepIdx);
    const afterSep = rawArgs.slice(sepIdx + 1);
    // Accept `env KEY=val ...` or bare `KEY=val ...`
    const envTokens = afterSep[0] === 'env' ? afterSep.slice(1) : afterSep;
    for (const token of envTokens) {
        const eqIdx = token.indexOf('=');
        if (eqIdx > 0) {
            envOverrides[token.slice(0, eqIdx)] = token.slice(eqIdx + 1);
        }
    }
} else {
    cmdArgs = rawArgs;
}

if (cmdArgs.length === 0) {
    console.error('Usage: node scripts/capture-cli-modes.js <cli> [args...] [-- env KEY=val ...]');
    process.exit(1);
}

const cli = cmdArgs[0];
const cliArgs = cmdArgs.slice(1);
const cols = 100;
const rows = 30;

const childEnv = { ...process.env, ...envOverrides };

let buffer = '';
let done = false;

const proc = pty.spawn(cli, cliArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: childEnv,
});

proc.onData((data) => {
    buffer += data;
    // Stop at the first prompt-like sequence — a line ending with `$ `, `% `,
    // `> `, or Claude's `╭─` / ANSI-styled prompt. We collect a generous window
    // so the full startup stream is captured before the REPL renders.
    if (!done && /[$%>]\s*$/.test(buffer) || buffer.includes('\x1b[?25h')) {
        // Give it a brief moment to finish writing startup modes, then stop.
        if (!done) {
            done = true;
            setTimeout(finish, 500);
        }
    }
});

proc.onExit(({ exitCode }) => {
    if (!done) {
        done = true;
        finish(exitCode);
    }
});

setTimeout(() => {
    if (!done) {
        done = true;
        console.error('[timeout] No prompt detected within 30s — analysing what was captured.');
        finish();
    }
}, 30000);

function finish(exitCode) {
    try { proc.kill(); } catch { /* already exited */ }

    // DEC private mode sequences: \x1b[?NNNh  or  \x1b[?NNNl
    // (NNN can be multi-digit; capture all)
    const decPrivateModeRe = /\x1b\[\?(\d+)([hl])/g;
    const modes = [];
    let m;
    while ((m = decPrivateModeRe.exec(buffer)) !== null) {
        modes.push(`?${m[1]}${m[2]}`);
    }

    // Also catch the set+reset pairs some CLIs emit as \x1b[?NNN;NNNh
    const multiModeRe = /\x1b\[\?([\d;]+)h/g;
    const multiSets = [];
    while ((m = multiModeRe.exec(buffer)) !== null) {
        for (const num of m[1].split(';')) {
            if (!modes.some(x => x === `?${num}h`)) {
                multiSets.push(`?${num}h`);
            }
        }
    }

    const clearScreenCount = (buffer.match(/\x1b\[2J/g) || []).length;
    const eraseScrollbackCount = (buffer.match(/\x1b\[3J/g) || []).length;

    console.log('=== DEC Private Modes (in order) ===');
    if (modes.length === 0 && multiSets.length === 0) {
        console.log('(none)');
    } else {
        console.log(modes.join('  '));
        if (multiSets.length > 0) {
            console.log('  [multi-set additional:] ' + multiSets.join('  '));
        }
    }

    console.log('');
    console.log('=== Clear / Erase Counts ===');
    console.log(`\\x1b[2J  (clear screen):      ${clearScreenCount}`);
    console.log(`\\x1b[3J  (erase scrollback):  ${eraseScrollbackCount}`);

    console.log('');
    console.log('=== Summary ===');
    const hasAltScreen = modes.some(x => x === '?1049h') || multiSets.includes('?1049h');
    const hasMouse = modes.some(x => ['?1000h', '?1002h', '?1003h'].includes(x))
        || ['?1000h', '?1002h', '?1003h'].some(x => multiSets.includes(x));
    console.log(`Alternate screen (?1049h):  ${hasAltScreen ? 'YES — pane scrollback killed' : 'no'}`);
    console.log(`Mouse reporting (1000+):    ${hasMouse ? 'YES — wheel grabbed, selection disabled' : 'no'}`);

    if (exitCode !== undefined) {
        console.log('');
        console.log(`CLI exit code: ${exitCode}`);
    }

    // Dump the raw stream to a temp file for manual inspection.
    const fs = require('fs');
    const os = require('os');
    const dumpPath = path.join(os.tmpdir(), `capture-cli-modes-${Date.now()}.log`);
    fs.writeFileSync(dumpPath, buffer);
    console.log('');
    console.log(`Raw stream dumped to: ${dumpPath}`);

    process.exit(0);
}
