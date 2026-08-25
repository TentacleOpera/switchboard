#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

const options = {
    binary: '',
    framing: 'paste',
    gap: 40,
    crCount: 1,
    confirmGap: 200,
    payload: '/help',
    readyIdle: 800,
    observe: 1800,
    resizeStorm: 0,
    bashMode: 0,
    bashModeSettle: 400,
    successText: '',
    outputQuiet: 0,
    busyPrompt: '',
    busyDelay: 1200,
    busyFirstGap: 400,
    resizeAt: -1,
    resizeSequence: '',
    payloadPadding: 0,
    clearBefore: 0,
    clearSettle: 600,
    clearReady: '',
    clearReadyQuiet: 100,
};

for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i].replace(/^--/, '');
    const value = process.argv[++i];
    if (key === 'binary' || key === 'framing' || key === 'payload' || key === 'success-text' || key === 'busy-prompt' || key === 'resize-sequence' || key === 'clear-ready') {
        const target = { 'success-text': 'successText', 'busy-prompt': 'busyPrompt', 'resize-sequence': 'resizeSequence', 'clear-ready': 'clearReady' }[key] || key;
        options[target] = value;
    } else if (key === 'gap' || key === 'cr-count' || key === 'confirm-gap' || key === 'ready-idle' || key === 'observe' || key === 'resize-storm' || key === 'bash-mode' || key === 'bash-mode-settle' || key === 'output-quiet' || key === 'busy-delay' || key === 'busy-first-gap' || key === 'resize-at' || key === 'payload-padding' || key === 'clear-before' || key === 'clear-settle' || key === 'clear-ready-quiet') {
        const target = { 'cr-count': 'crCount', 'confirm-gap': 'confirmGap', 'ready-idle': 'readyIdle', 'resize-storm': 'resizeStorm', 'bash-mode': 'bashMode', 'bash-mode-settle': 'bashModeSettle', 'output-quiet': 'outputQuiet', 'busy-delay': 'busyDelay', 'busy-first-gap': 'busyFirstGap', 'resize-at': 'resizeAt', 'payload-padding': 'payloadPadding', 'clear-before': 'clearBefore', 'clear-settle': 'clearSettle', 'clear-ready-quiet': 'clearReadyQuiet' }[key] || key;
        options[target] = Number(value);
    } else {
        throw new Error(`Unknown argument --${key}`);
    }
}

if (!options.binary) {
    throw new Error('Required: --binary <path>');
}
if (!['plain', 'paste'].includes(options.framing)) {
    throw new Error('--framing must be plain or paste');
}
if (![1, 2].includes(options.crCount)) {
    throw new Error('--cr-count must be 1 or 2');
}

const started = process.hrtime.bigint();
const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;
const events = [];
let raw = '';
let sent = false;
let finished = false;
let readyTimer;
let observeTimer;
let quietTimer;
let firstCrSent = false;
let payloadDelivered = false;
let clearReadyBuffer = '';
let clearReadyTimer;
let clearFallbackTimer;
let clearWaiting = false;
let workloadStarted = false;

const child = pty.spawn(options.binary, [], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: { ...process.env, DEVIN_CLI_AUTO_UPDATE: 'false' },
});

function record(direction, data) {
    events.push({ atMs: Number(elapsedMs().toFixed(3)), direction, data });
}

function write(data, label) {
    record('input', label);
    child.write(data);
}

function scheduleTrial() {
    clearTimeout(readyTimer);
    readyTimer = setTimeout(runTrial, options.readyIdle);
}

function runTrial() {
    if (sent || finished) { return; }
    sent = true;
    if (options.clearBefore) {
        write('\x15', 'clear-input');
        setTimeout(() => {
            write('/clear', 'clear-command');
            setTimeout(() => {
                write('\r', 'clear-cr');
                if (options.clearReady === 'devin') {
                    clearWaiting = true;
                    clearFallbackTimer = setTimeout(beginWorkload, options.clearSettle);
                } else {
                    setTimeout(beginWorkload, options.clearSettle);
                }
            }, 40);
        }, 30);
    } else {
        beginWorkload();
    }
}

function beginWorkload() {
    if (workloadStarted || finished) { return; }
    workloadStarted = true;
    clearWaiting = false;
    clearTimeout(clearReadyTimer);
    clearTimeout(clearFallbackTimer);
    if (options.busyPrompt) {
        write('\x1b[200~', 'busy-paste-open');
        write(options.busyPrompt, `busy-payload:${options.busyPrompt}`);
        write('\x1b[201~', 'busy-paste-close');
        setTimeout(() => {
            write('\r', 'busy-cr');
            setTimeout(beginTargetTrial, options.busyDelay);
        }, options.busyFirstGap);
    } else {
        beginTargetTrial();
    }
}

function beginTargetTrial() {
    if (options.bashMode) {
        write('!', 'bash-mode');
        setTimeout(deliverPayload, options.bashModeSettle);
    } else {
        deliverPayload();
    }
}

function deliverPayload() {
    if (options.resizeStorm > 0) {
        let resizeCount = 0;
        const resizeTimer = setInterval(() => {
            child.resize(100 + resizeCount % 3, 30 + resizeCount % 2);
            resizeCount++;
        }, 2);
        setTimeout(() => clearInterval(resizeTimer), options.resizeStorm);
    }
    const effectivePayload = options.payload + (options.payloadPadding > 0 ? ` #${'x'.repeat(options.payloadPadding)}` : '');
    if (options.framing === 'paste') {
        write('\x1b[200~', 'paste-open');
        write(effectivePayload, `payload:${effectivePayload}`);
        write('\x1b[201~', 'paste-close');
    } else {
        write(effectivePayload, `payload:${effectivePayload}`);
    }
    if (options.resizeAt >= 0) {
        setTimeout(() => {
            record('input', 'resize:101x31');
            child.resize(101, 31);
        }, options.resizeAt);
    }
    if (options.resizeSequence) {
        options.resizeSequence.split(',').map(Number).filter(Number.isFinite).forEach((offset, index) => {
            setTimeout(() => {
                const cols = 101 + index % 2;
                const rows = 30 + index % 2;
                record('input', `resize:${cols}x${rows}`);
                child.resize(cols, rows);
            }, offset);
        });
    }
    payloadDelivered = true;
    if (options.outputQuiet === 0) {
        setTimeout(sendFirstCr, options.gap);
    }
}

function armQuietTimer() {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(sendFirstCr, options.outputQuiet);
}

function sendFirstCr() {
    if (firstCrSent || finished) { return; }
    firstCrSent = true;
    write('\r', 'cr-1');
    if (options.crCount === 2) {
        setTimeout(() => {
            write('\r', 'cr-2');
            observeTimer = setTimeout(() => finish('observed'), options.observe);
        }, options.confirmGap);
    } else {
        observeTimer = setTimeout(() => finish('observed'), options.observe);
    }
}

child.onData(data => {
    raw += data;
    record('output', data);
    if (clearWaiting) {
        clearTimeout(clearReadyTimer);
        clearReadyBuffer += data;
        const disabledAt = clearReadyBuffer.lastIndexOf('\x1b[?2004l');
        const enabledAt = clearReadyBuffer.lastIndexOf('\x1b[?2004h');
        const afterEnable = enabledAt >= 0 ? clearReadyBuffer.slice(enabledAt) : '';
        if (disabledAt >= 0 && enabledAt > disabledAt && afterEnable.includes('\x1b[?25h') && afterEnable.includes('\x1b[?2026l')) {
            clearReadyTimer = setTimeout(beginWorkload, options.clearReadyQuiet);
        }
    }
    if (options.outputQuiet > 0 && payloadDelivered && !firstCrSent) {
        armQuietTimer();
    }
    if (!sent && raw.includes('❭ ') && raw.includes('\x1b[?25h')) {
        scheduleTrial();
    }
});

child.onExit(({ exitCode, signal }) => {
    finish('child-exit', { exitCode, signal });
});

function finish(reason, extra = {}) {
    if (finished) { return; }
    finished = true;
    clearTimeout(readyTimer);
    clearTimeout(observeTimer);
    clearTimeout(quietTimer);
    clearTimeout(clearReadyTimer);
    clearTimeout(clearFallbackTimer);
    try { child.kill(); } catch {}
    const outputPath = path.join(os.tmpdir(), `devin-submit-probe-${path.basename(path.dirname(path.dirname(options.binary)))}-${options.framing}-${options.gap}ms-${options.crCount}cr-${process.pid}-${Date.now()}.json`);
    const result = {
        options,
        reason,
        durationMs: Number(elapsedMs().toFixed(3)),
        sent,
        raw,
        events,
        ...extra,
    };
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    const afterFirstCr = events.findIndex(event => event.direction === 'input' && event.data === 'cr-1');
    const closeEvent = events.find(event => event.direction === 'input' && event.data === 'paste-close');
    const crEvent = events[afterFirstCr];
    const actualCloseToCrMs = closeEvent && crEvent ? Number((crEvent.atMs - closeEvent.atMs).toFixed(3)) : undefined;
    const outputAfterCr = events.slice(afterFirstCr + 1).filter(event => event.direction === 'output').map(event => event.data).join('');
    const helpOpened = outputAfterCr.includes('/steps') && outputAfterCr.includes('/workspace');
    const succeeded = options.successText ? outputAfterCr.includes(options.successText) : helpOpened;
    console.log(JSON.stringify({
        binaryVersion: path.basename(path.dirname(path.dirname(options.binary))),
        framing: options.framing,
        gapMs: options.gap,
        outputQuietMs: options.outputQuiet,
        actualCloseToCrMs,
        crCount: options.crCount,
        durationMs: result.durationMs,
        succeeded,
        helpOpened,
        outputAfterCrBytes: Buffer.byteLength(outputAfterCr),
        failurePreview: succeeded ? undefined : JSON.stringify(outputAfterCr.slice(-1200)),
        outputPath,
    }, null, 2));
}

setTimeout(() => finish('timeout'), 60000);
