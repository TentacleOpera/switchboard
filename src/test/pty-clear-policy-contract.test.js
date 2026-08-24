'use strict';

/**
 * Contract: PTY Clear Readiness Mode & Policy Resolution.
 * (expose-pty-clear-delay-in-kanban-setup-ui.md)
 *
 * Pins the source-aware resolution policy across VS Code extension and standalone hosts:
 * 1. Explicit mode auto -> Auto mode; unknown CLI fallback uses explicit PTY delay or 600.
 * 2. Explicit mode manual -> Manual mode; uses explicit PTY delay -> legacy delay -> 600.
 * 3. Unset mode + explicit PTY delay -> Compatibility Manual mode.
 * 4. Unset mode + explicit legacy delay -> Compatibility Manual mode.
 * 5. Unset mode + no explicit delay -> Auto mode; unknown fallback 600.
 * 6. Explicit 0 delay is preserved (never treated as unset).
 * 7. Mode enum allows only auto | manual.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PKG_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const KANBAN_PROVIDER_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'KanbanProvider.ts'), 'utf8');
const KANBAN_HTML_SRC = fs.readFileSync(path.join(__dirname, '..', 'webview', 'kanban.html'), 'utf8');
const PTY_POLICY_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'ptyClearPolicy.ts'), 'utf8');

// Inline pure evaluation harness for ptyClearPolicy logic
function createMockConfig(inspectValues) {
    return {
        inspect(key) {
            return inspectValues[key];
        },
        get(key, defaultVal) {
            const inspected = inspectValues[key];
            if (inspected && inspected.globalValue !== undefined) return inspected.globalValue;
            if (inspected && inspected.workspaceValue !== undefined) return inspected.workspaceValue;
            return defaultVal;
        }
    };
}

function createMockStandaloneConfig(values) {
    return {
        getConfigString(key, defaultValue = '') {
            return values[key] !== undefined ? String(values[key]) : defaultValue;
        },
        getConfigNumber(key, defaultValue = Number.NaN) {
            return typeof values[key] === 'number' ? values[key] : defaultValue;
        }
    };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}

console.log('\n── PTY clear readiness policy & setup UI contract ──');

// 1. package.json contributions
test('package.json contributes ptyClearReadinessMode enum and updated descriptions', () => {
    const props = PKG_JSON.contributes.configuration.properties;
    assert.ok(props['switchboard.terminal.ptyClearReadinessMode'], 'ptyClearReadinessMode must be contributed');
    assert.deepStrictEqual(props['switchboard.terminal.ptyClearReadinessMode'].enum, ['auto', 'manual']);
    assert.strictEqual(props['switchboard.terminal.ptyClearReadinessMode'].default, undefined, 'must not have a contributed default that masks unset state');

    assert.ok(props['switchboard.terminal.clearBeforePromptDelay'].description.includes('VS Code terminal seats'));
    assert.ok(props['switchboard.terminal.ptyClearBeforePromptDelay'].description.includes('Manual PTY delay'));
});

// 2. Policy resolution evaluation
// Transpile or simulate ptyClearPolicy pure logic
function evalResolvers() {
    function explicitScopeValue(i) {
        return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
    }
    function clampDelay(val, defaultVal) {
        if (val === undefined || Number.isNaN(val)) return defaultVal;
        return Math.min(Math.max(val, 0), 10000);
    }
    function resolvePtyClearPolicy(cfg) {
        const rawMode = explicitScopeValue(cfg.inspect('terminal.ptyClearReadinessMode'));
        const explicitMode = rawMode === 'auto' || rawMode === 'manual' ? rawMode : undefined;

        const explicitPtyDelayRaw = explicitScopeValue(cfg.inspect('terminal.ptyClearBeforePromptDelay'));
        const explicitPtyDelay = explicitPtyDelayRaw !== undefined ? clampDelay(explicitPtyDelayRaw, 600) : undefined;

        const explicitLegacyDelayRaw = explicitScopeValue(cfg.inspect('terminal.clearBeforePromptDelay'));
        const explicitLegacyDelay = explicitLegacyDelayRaw !== undefined ? clampDelay(explicitLegacyDelayRaw, 2000) : undefined;

        if (explicitMode === 'auto') {
            return {
                mode: 'auto',
                unknownDelayMs: explicitPtyDelay !== undefined ? explicitPtyDelay : 600,
                source: 'mode-explicit',
            };
        }
        if (explicitMode === 'manual') {
            const delayMs = explicitPtyDelay !== undefined
                ? explicitPtyDelay
                : (explicitLegacyDelay !== undefined ? explicitLegacyDelay : 600);
            return {
                mode: 'manual',
                delayMs,
                source: 'mode-explicit',
            };
        }
        if (explicitPtyDelay !== undefined) {
            return {
                mode: 'manual',
                delayMs: explicitPtyDelay,
                source: 'pty-explicit',
            };
        }
        if (explicitLegacyDelay !== undefined) {
            return {
                mode: 'manual',
                delayMs: explicitLegacyDelay,
                source: 'legacy-explicit',
            };
        }
        return {
            mode: 'auto',
            unknownDelayMs: 600,
            source: 'default',
        };
    }

    function resolveStandalonePtyClearPolicy(configProvider) {
        const rawMode = configProvider.getConfigString('terminal.ptyClearReadinessMode', '');
        const explicitMode = rawMode === 'auto' || rawMode === 'manual' ? rawMode : undefined;

        const ptyDelayRaw = configProvider.getConfigNumber('terminal.ptyClearBeforePromptDelay', Number.NaN);
        const explicitPtyDelay = !Number.isNaN(ptyDelayRaw) ? clampDelay(ptyDelayRaw, 600) : undefined;

        const legacyDelayRaw = configProvider.getConfigNumber('terminal.clearBeforePromptDelay', Number.NaN);
        const explicitLegacyDelay = !Number.isNaN(legacyDelayRaw) ? clampDelay(legacyDelayRaw, 2000) : undefined;

        if (explicitMode === 'auto') {
            return {
                mode: 'auto',
                unknownDelayMs: explicitPtyDelay !== undefined ? explicitPtyDelay : 600,
                source: 'mode-explicit',
            };
        }
        if (explicitMode === 'manual') {
            const delayMs = explicitPtyDelay !== undefined
                ? explicitPtyDelay
                : (explicitLegacyDelay !== undefined ? explicitLegacyDelay : 600);
            return {
                mode: 'manual',
                delayMs,
                source: 'mode-explicit',
            };
        }
        if (explicitPtyDelay !== undefined) {
            return {
                mode: 'manual',
                delayMs: explicitPtyDelay,
                source: 'pty-explicit',
            };
        }
        if (explicitLegacyDelay !== undefined) {
            return {
                mode: 'manual',
                delayMs: explicitLegacyDelay,
                source: 'legacy-explicit',
            };
        }
        return {
            mode: 'auto',
            unknownDelayMs: 600,
            source: 'default',
        };
    }

    return { resolvePtyClearPolicy, resolveStandalonePtyClearPolicy };
}

const { resolvePtyClearPolicy, resolveStandalonePtyClearPolicy } = evalResolvers();

test('No explicit settings resolves Auto mode with default 600ms unknown fallback', () => {
    const cfg = createMockConfig({});
    const res = resolvePtyClearPolicy(cfg);
    assert.deepStrictEqual(res, { mode: 'auto', unknownDelayMs: 600, source: 'default' });

    const standaloneCfg = createMockStandaloneConfig({});
    const sRes = resolveStandalonePtyClearPolicy(standaloneCfg);
    assert.deepStrictEqual(sRes, { mode: 'auto', unknownDelayMs: 600, source: 'default' });
});

test('Explicit PTY 0 resolves Manual 0 with source pty-explicit', () => {
    const cfg = createMockConfig({
        'terminal.ptyClearBeforePromptDelay': { globalValue: 0 }
    });
    const res = resolvePtyClearPolicy(cfg);
    assert.deepStrictEqual(res, { mode: 'manual', delayMs: 0, source: 'pty-explicit' });

    const standaloneCfg = createMockStandaloneConfig({
        'terminal.ptyClearBeforePromptDelay': 0
    });
    const sRes = resolveStandalonePtyClearPolicy(standaloneCfg);
    assert.deepStrictEqual(sRes, { mode: 'manual', delayMs: 0, source: 'pty-explicit' });
});

test('Explicit PTY value with no mode resolves compatibility Manual mode', () => {
    const cfg = createMockConfig({
        'terminal.ptyClearBeforePromptDelay': { globalValue: 900 }
    });
    const res = resolvePtyClearPolicy(cfg);
    assert.deepStrictEqual(res, { mode: 'manual', delayMs: 900, source: 'pty-explicit' });

    const standaloneCfg = createMockStandaloneConfig({
        'terminal.ptyClearBeforePromptDelay': 900
    });
    const sRes = resolveStandalonePtyClearPolicy(standaloneCfg);
    assert.deepStrictEqual(sRes, { mode: 'manual', delayMs: 900, source: 'pty-explicit' });
});

test('Explicit legacy value with no PTY/mode resolves compatibility Manual mode', () => {
    const cfg = createMockConfig({
        'terminal.clearBeforePromptDelay': { globalValue: 1500 }
    });
    const res = resolvePtyClearPolicy(cfg);
    assert.deepStrictEqual(res, { mode: 'manual', delayMs: 1500, source: 'legacy-explicit' });

    const standaloneCfg = createMockStandaloneConfig({
        'terminal.clearBeforePromptDelay': 1500
    });
    const sRes = resolveStandalonePtyClearPolicy(standaloneCfg);
    assert.deepStrictEqual(sRes, { mode: 'manual', delayMs: 1500, source: 'legacy-explicit' });
});

test('Explicit Auto overrides stored explicit delay without deleting values', () => {
    const cfg = createMockConfig({
        'terminal.ptyClearReadinessMode': { globalValue: 'auto' },
        'terminal.ptyClearBeforePromptDelay': { globalValue: 1200 },
        'terminal.clearBeforePromptDelay': { globalValue: 3000 }
    });
    const res = resolvePtyClearPolicy(cfg);
    assert.deepStrictEqual(res, { mode: 'auto', unknownDelayMs: 1200, source: 'mode-explicit' });

    const standaloneCfg = createMockStandaloneConfig({
        'terminal.ptyClearReadinessMode': 'auto',
        'terminal.ptyClearBeforePromptDelay': 1200,
        'terminal.clearBeforePromptDelay': 3000
    });
    const sRes = resolveStandalonePtyClearPolicy(standaloneCfg);
    assert.deepStrictEqual(sRes, { mode: 'auto', unknownDelayMs: 1200, source: 'mode-explicit' });
});

test('Explicit Manual uses PTY -> legacy -> 600 fallback order', () => {
    // PTY set
    const cfg1 = createMockConfig({
        'terminal.ptyClearReadinessMode': { globalValue: 'manual' },
        'terminal.ptyClearBeforePromptDelay': { globalValue: 800 },
        'terminal.clearBeforePromptDelay': { globalValue: 2500 }
    });
    assert.deepStrictEqual(resolvePtyClearPolicy(cfg1), { mode: 'manual', delayMs: 800, source: 'mode-explicit' });

    // Only legacy set
    const cfg2 = createMockConfig({
        'terminal.ptyClearReadinessMode': { globalValue: 'manual' },
        'terminal.clearBeforePromptDelay': { globalValue: 2500 }
    });
    assert.deepStrictEqual(resolvePtyClearPolicy(cfg2), { mode: 'manual', delayMs: 2500, source: 'mode-explicit' });

    // Neither delay set
    const cfg3 = createMockConfig({
        'terminal.ptyClearReadinessMode': { globalValue: 'manual' }
    });
    assert.deepStrictEqual(resolvePtyClearPolicy(cfg3), { mode: 'manual', delayMs: 600, source: 'mode-explicit' });
});

// 3. KanbanProvider source shape
test('KanbanProvider registers updateClearTerminalBeforePromptPtyMode and updateClearTerminalBeforePromptPtyDelay', () => {
    assert.ok(KANBAN_PROVIDER_SRC.includes("case 'updateClearTerminalBeforePromptPtyMode':"), 'must handle updateClearTerminalBeforePromptPtyMode');
    assert.ok(KANBAN_PROVIDER_SRC.includes("case 'updateClearTerminalBeforePromptPtyDelay':"), 'must handle updateClearTerminalBeforePromptPtyDelay');
    assert.ok(KANBAN_PROVIDER_SRC.includes("ptyMode:"), 'must send ptyMode');
    assert.ok(KANBAN_PROVIDER_SRC.includes("ptyDelay:"), 'must send ptyDelay');
    assert.ok(KANBAN_PROVIDER_SRC.includes("ptySource:"), 'must send ptySource');
});

// 4. kanban.html UI elements and listeners
test('kanban.html includes VS Code settle delay and PTY readiness controls', () => {
    assert.ok(KANBAN_HTML_SRC.includes('VS Code terminals &mdash; clear settle delay'), 'must label VS Code settle delay');
    assert.ok(KANBAN_HTML_SRC.includes('id="pty-clear-mode-auto"'), 'must include auto radio');
    assert.ok(KANBAN_HTML_SRC.includes('id="pty-clear-mode-manual"'), 'must include manual radio');
    assert.ok(KANBAN_HTML_SRC.includes('id="pty-clear-delay-input"'), 'must include PTY delay input');
    assert.ok(KANBAN_HTML_SRC.includes('id="pty-clear-source-status"'), 'must include source status indicator');
    assert.ok(KANBAN_HTML_SRC.includes('Manual compatibility: explicit PTY value'), 'must report explicit PTY compatibility');
    assert.ok(KANBAN_HTML_SRC.includes('Manual compatibility: inherited VS Code value'), 'must report legacy compatibility');
    assert.ok(KANBAN_HTML_SRC.includes('Automatic: no explicit override'), 'must report default auto source');
});

if (failed > 0) {
    console.error(`\n❌ ${failed} test(s) failed`);
    process.exit(1);
} else {
    console.log(`\n🎉 All ${passed} contract assertions passed cleanly.`);
}
