'use strict';

/**
 * Contract: Host-enforced auto-clear on plan change.
 *
 * When a ptySendPrompt with a dispatch field references a DIFFERENT planId
 * than the terminal's last dispatched plan, the host overrides
 * clearBeforePrompt to true so /clear is written before the prompt.
 * Same-planId resends preserve false (context kept for fix prompts).
 *
 * Source-level contract tests — read source text, assert on patterns.
 * Mirrors the style of terminal-coder-dispatch-contract.test.js.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const TVP = read('src/services/TaskViewerProvider.ts');
const BOOT = read('src/standalone/bootstrap.ts');

// Extract the _ptyHostVerb method body from TaskViewerProvider.ts.
const ptyHostVerbStart = TVP.indexOf('private async _ptyHostVerb(');
assert.ok(ptyHostVerbStart > 0, '_ptyHostVerb method must exist in TaskViewerProvider.ts');
// Use the next method definition as the boundary.
const ptyHostVerbEnd = TVP.indexOf('\n    private ', ptyHostVerbStart + 100);
assert.ok(ptyHostVerbEnd > 0, '_ptyHostVerb must have a closing boundary');
const PTY_HOST_VERB_SRC = TVP.slice(ptyHostVerbStart, ptyHostVerbEnd);

// Extract the ptySendPrompt case body from bootstrap.ts.
const sendPromptStart = BOOT.indexOf("case 'ptySendPrompt':");
assert.ok(sendPromptStart > 0, "ptySendPrompt case must exist in bootstrap.ts");
const sendPromptEnd = BOOT.indexOf("case '", sendPromptStart + 50);
assert.ok(sendPromptEnd > 0, 'ptySendPrompt case must have a closing boundary');
const SEND_PROMPT_SRC = BOOT.slice(sendPromptStart, sendPromptEnd);

let failures = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failures++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

// --- 1. Extension host has the map ---

test('extension host has _lastDispatchedPlanByTerminal as a Map', () => {
    assert.ok(
        /_lastDispatchedPlanByTerminal\s*=\s*new\s+Map/.test(TVP),
        'TaskViewerProvider.ts must declare _lastDispatchedPlanByTerminal as a Map'
    );
});

// --- 2. Standalone has the map ---

test('standalone has lastDispatchedPlanByTerminal as a Map', () => {
    assert.ok(
        /lastDispatchedPlanByTerminal\s*=\s*new\s+Map/.test(BOOT),
        'bootstrap.ts must declare lastDispatchedPlanByTerminal as a Map'
    );
});

// --- 3. Extension host overrides clearBeforePrompt on plan change ---

test('extension host overrides clearBeforePrompt on plan change', () => {
    assert.ok(
        /lastPlanId\s*&&\s*lastPlanId\s*!==\s*planId/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must compare lastPlanId !== planId before overriding'
    );
    assert.ok(
        /clearBeforePrompt:\s*true/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must set clearBeforePrompt to true on plan change'
    );
});

// --- 4. Standalone overrides clearBeforePrompt on plan change ---

test('standalone overrides clearBeforePrompt on plan change', () => {
    assert.ok(
        /lastPlanId\s*&&\s*lastPlanId\s*!==\s*parsed\.value\.planId/.test(SEND_PROMPT_SRC),
        'ptySendPrompt case must compare lastPlanId !== parsed.value.planId before overriding'
    );
    assert.ok(
        /payload\.clearBeforePrompt\s*=\s*true/.test(SEND_PROMPT_SRC),
        'ptySendPrompt case must set payload.clearBeforePrompt to true on plan change'
    );
});

// --- 5. Map is cleared on ptyClearTerminal ---

test('extension host deletes map entry on ptyClearTerminal', () => {
    // The seat-cache-drop block handles ptyClearTerminal and deletes the map.
    assert.ok(
        /ptyClearTerminal/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must reference ptyClearTerminal'
    );
    assert.ok(
        /_lastDispatchedPlanByTerminal\.delete/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must delete from _lastDispatchedPlanByTerminal'
    );
});

test('standalone deletes map entry on ptyClearTerminal', () => {
    const clearStart = BOOT.indexOf("case 'ptyClearTerminal':");
    const clearEnd = BOOT.indexOf("case '", clearStart + 50);
    const clearSrc = BOOT.slice(clearStart, clearEnd);
    assert.ok(
        /lastDispatchedPlanByTerminal\.delete/.test(clearSrc),
        'ptyClearTerminal case must delete from lastDispatchedPlanByTerminal'
    );
});

// --- 6. Map is cleared on ptyClearAllTerminals ---

test('extension host clears map on ptyClearAllTerminals', () => {
    assert.ok(
        /ptyClearAllTerminals/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must reference ptyClearAllTerminals'
    );
    // Find the actual branch (else if), not comment mentions.
    const branchIdx = PTY_HOST_VERB_SRC.indexOf("else if (verb === 'ptyClearAllTerminals')");
    assert.ok(branchIdx > 0, '_ptyHostVerb must have a ptyClearAllTerminals branch');
    const afterBranch = PTY_HOST_VERB_SRC.slice(branchIdx, branchIdx + 300);
    assert.ok(
        /_lastDispatchedPlanByTerminal\.clear\(\)/.test(afterBranch),
        '_ptyHostVerb must clear _lastDispatchedPlanByTerminal on ptyClearAllTerminals'
    );
});

test('standalone clears map on ptyClearAllTerminals', () => {
    const clearAllStart = BOOT.indexOf("case 'ptyClearAllTerminals':");
    const clearAllEnd = BOOT.indexOf("case '", clearAllStart + 50);
    const clearAllSrc = BOOT.slice(clearAllStart, clearAllEnd);
    assert.ok(
        /lastDispatchedPlanByTerminal\.clear\(\)/.test(clearAllSrc),
        'ptyClearAllTerminals case must clear lastDispatchedPlanByTerminal'
    );
});

// --- 7. Map entry is deleted on ptyCloseTerminal ---

test('extension host deletes map entry on ptyCloseTerminal', () => {
    assert.ok(
        /ptyCloseTerminal.*_lastDispatchedPlanByTerminal\.delete/s.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must delete from _lastDispatchedPlanByTerminal on ptyCloseTerminal'
    );
});

test('standalone deletes map entry on ptyCloseTerminal', () => {
    const closeStart = BOOT.indexOf("case 'ptyCloseTerminal':");
    const closeEnd = BOOT.indexOf("case '", closeStart + 50);
    const closeSrc = BOOT.slice(closeStart, closeEnd);
    assert.ok(
        /lastDispatchedPlanByTerminal\.delete/.test(closeSrc),
        'ptyCloseTerminal case must delete from lastDispatchedPlanByTerminal'
    );
});

// --- 8. Map entry is renamed on ptyRenameTerminal ---

test('extension host renames map entry on ptyRenameTerminal', () => {
    assert.ok(
        /ptyRenameTerminal/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must reference ptyRenameTerminal'
    );
    assert.ok(
        /_lastDispatchedPlanByTerminal\.get\(payload\.name\).*_lastDispatchedPlanByTerminal\.set\(payload\.alias/s.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must rename map entry from payload.name to payload.alias on ptyRenameTerminal'
    );
});

test('standalone renames map entry on ptyRenameTerminal', () => {
    const renameStart = BOOT.indexOf("case 'ptyRenameTerminal':");
    const renameEnd = BOOT.indexOf("case '", renameStart + 50);
    const renameSrc = BOOT.slice(renameStart, renameEnd);
    assert.ok(
        /lastDispatchedPlanByTerminal\.get\(payload\.name\).*lastDispatchedPlanByTerminal\.set\(payload\.alias/s.test(renameSrc),
        'ptyRenameTerminal case must rename map entry from payload.name to payload.alias'
    );
});

// --- 9. Same-planId dispatch does NOT override clearBeforePrompt ---

test('extension host checks lastPlanId !== planId (not just existence)', () => {
    // The condition must include the !== check, so a same-plan resend
    // preserves false.
    assert.ok(
        /lastPlanId\s*!==\s*planId/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must check lastPlanId !== planId so same-plan resends preserve false'
    );
});

test('standalone checks lastPlanId !== parsed.value.planId (not just existence)', () => {
    assert.ok(
        /lastPlanId\s*!==\s*parsed\.value\.planId/.test(SEND_PROMPT_SRC),
        'ptySendPrompt case must check lastPlanId !== parsed.value.planId so same-plan resends preserve false'
    );
});

// --- 10. First dispatch does NOT override clearBeforePrompt ---

test('extension host checks lastPlanId existence before overriding', () => {
    // The condition must check lastPlanId is truthy before comparing, so a
    // fresh terminal (no entry) is not redundantly cleared.
    assert.ok(
        /lastPlanId\s*&&\s*lastPlanId\s*!==\s*planId/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must check lastPlanId existence so first dispatch does not auto-clear'
    );
});

test('standalone checks lastPlanId existence before overriding', () => {
    assert.ok(
        /lastPlanId\s*&&\s*lastPlanId\s*!==\s*parsed\.value\.planId/.test(SEND_PROMPT_SRC),
        'ptySendPrompt case must check lastPlanId existence so first dispatch does not auto-clear'
    );
});

// --- 11. Map is deleted on ptyWrite with /clear (extension host) ---

test('extension host deletes map entry on ptyWrite with /clear', () => {
    // The seat-cache-drop block detects ptyWrite with /clear and deletes
    // the map entry alongside the seat cache.
    assert.ok(
        /ptyWrite.*\/clear.*_lastDispatchedPlanByTerminal/s.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must delete from _lastDispatchedPlanByTerminal on ptyWrite with /clear'
    );
});

if (failures > 0) { console.error(`\n${failures} contract failure(s)`); process.exit(1); }
console.log('\nAll host-auto-clear-on-plan-change contract assertions passed.');
