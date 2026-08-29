'use strict';

/**
 * Contract: Host-enforced auto-clear on WORK-CONTEXT change.
 *
 * When a ptySendPrompt carrying plan identity references a DIFFERENT work
 * context (featureId ?? planId) than the terminal's last dispatch, the host
 * overrides clearBeforePrompt to true so /clear is written before the prompt.
 * Same-context resends preserve false — that covers both a fix resend of one
 * plan AND the next subtask of the same feature (atomic-team lifecycle).
 *
 * Three things this file exists to pin, each of which was once broken:
 *
 *   1. The compare key is the WORK CONTEXT, never the planId. A planId compare
 *      clears between two subtasks of one feature — the per-subtask reset the
 *      atomic-team lifecycle exists to remove. The superseded
 *      `_lastDispatchedPlanByTerminal` map is gone; it was write-only for its
 *      whole life and seven assertions in this very file used to pin it there.
 *
 *   2. Plan identity reaches the lifecycle from EITHER source — the explicit
 *      `dispatch` field or the parse-based backstop. No internal caller sets
 *      `dispatch`: the board's card trigger, batch trigger and configured-column
 *      dispatch all land in _attemptDirectTerminalPush, which sends
 *      name/data/clearBeforePrompt and nothing else. Gating on `dispatch` alone
 *      left the card-move gesture with no team barrier at all.
 *
 *   3. The destination override honours `terminal.clearBeforePrompt`. The roster
 *      barrier always did; the destination did not, so an operator who disabled
 *      clearing still got the one seat the dispatch was aimed at cleared.
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

/**
 * Slice the same-work-context branch out of a barrier body. Both roots open it
 * with the same compare and close it with the same `} else {`.
 */
function sliceSameFeatureBranch(src, label) {
    const open = 'if (lastTeamWorkKey === workContextKey) {';
    const start = src.indexOf(open);
    assert.ok(start >= 0, `${label} must have a same-work-context branch`);
    // Brace-match rather than scanning for the next `} else {`: the branch now
    // contains its own if/else (the deferred-clear intercept), and the first
    // `} else {` is that inner one — a scan stops short and the fallback arm
    // falls outside the slice.
    let depth = 0;
    let i = start + open.length - 1;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    assert.ok(depth === 0 && i < src.length, `${label}'s same-work-context branch must be brace-balanced`);
    return src.slice(start, i + 1);
}

let failures = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failures++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

// --- 1. Both hosts track the LIVE work-context map ---

test('extension host has _lastWorkContextByTerminal as a Map', () => {
    assert.ok(
        /_lastWorkContextByTerminal\s*=\s*new\s+Map/.test(TVP),
        'TaskViewerProvider.ts must declare _lastWorkContextByTerminal as a Map'
    );
    assert.ok(
        /_lastWorkContextByTeam\s*=\s*new\s+Map/.test(TVP),
        'TaskViewerProvider.ts must declare _lastWorkContextByTeam as a Map'
    );
});

test('standalone has lastWorkContextByTerminal as a Map', () => {
    assert.ok(
        /lastWorkContextByTerminal\s*=\s*new\s+Map/.test(BOOT),
        'bootstrap.ts must declare lastWorkContextByTerminal as a Map'
    );
    assert.ok(
        /lastWorkContextByTeam\s*=\s*new\s+Map/.test(BOOT),
        'bootstrap.ts must declare lastWorkContextByTeam as a Map'
    );
});

// --- 2. The superseded planId map must not come back ---

test('the write-only _lastDispatchedPlanByTerminal map stays deleted', () => {
    assert.ok(
        !/_lastDispatchedPlanByTerminal/.test(TVP),
        'TaskViewerProvider.ts must not reintroduce _lastDispatchedPlanByTerminal — it was maintained at five lifecycle sites and read by no decision'
    );
    assert.ok(
        !/lastDispatchedPlanByTerminal/.test(BOOT),
        'bootstrap.ts must not reintroduce lastDispatchedPlanByTerminal'
    );
});

// --- 3. Extension host overrides clearBeforePrompt on work-context change ---

test('extension host overrides clearBeforePrompt on work-context change', () => {
    // The compare key is the WORK CONTEXT (featureId ?? planId), not planId.
    // Comparing planId here clears between two subtasks of ONE feature — the
    // per-subtask reset the atomic-team lifecycle exists to remove. An OR of the
    // two compares is the same defect wearing the new map's name.
    assert.ok(
        /lastWorkKey\s*&&\s*lastWorkKey\s*!==\s*workContextKey/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must compare lastWorkKey !== workContextKey before overriding'
    );
    assert.ok(
        !/lastPlanId\s*&&\s*lastPlanId\s*!==\s*planId/.test(PTY_HOST_VERB_SRC),
        'the superseded planId compare must NOT survive alongside the work-context compare'
    );
    assert.ok(
        /clearBeforePrompt:\s*true/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must set clearBeforePrompt to true on work-context change'
    );
});

// --- 4. Standalone overrides clearBeforePrompt on work-context change ---

test('standalone overrides clearBeforePrompt on work-context change', () => {
    assert.ok(
        /lastWorkKey\s*&&\s*lastWorkKey\s*!==\s*workContextKey/.test(SEND_PROMPT_SRC),
        'ptySendPrompt case must compare lastWorkKey !== workContextKey before overriding'
    );
    assert.ok(
        !/lastPlanId\s*&&\s*lastPlanId\s*!==\s*parsed\.value\.planId/.test(SEND_PROMPT_SRC),
        'the superseded planId compare must NOT survive alongside the work-context compare'
    );
    assert.ok(
        /payload\.clearBeforePrompt\s*=\s*true/.test(SEND_PROMPT_SRC),
        'ptySendPrompt case must set payload.clearBeforePrompt to true on work-context change'
    );
});

// --- 5. The lifecycle is reachable from the parse-based backstop, not only `dispatch` ---

test('extension host feeds the lifecycle from the parse-based identity too', () => {
    assert.ok(
        /let contextIdentity/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must resolve a contextIdentity independent of the dispatch field'
    );
    assert.ok(
        /contextIdentity\s*=\s*\{\s*\n?\s*planId:\s*parsedDispatchIdentity\.planIds\[0\]/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must set contextIdentity from parsedDispatchIdentity — the board dispatch paths send no dispatch field'
    );
    assert.ok(
        /if \(contextIdentity\) \{/.test(PTY_HOST_VERB_SRC),
        'the work-context lifecycle block must be guarded on contextIdentity, not on hasDispatch'
    );
    // The lifecycle must NOT sit inside the hasDispatch block: the guard that
    // opens the lifecycle has to come after that block closes.
    const hasDispatchIdx = PTY_HOST_VERB_SRC.indexOf('if (hasDispatch) {');
    const lifecycleIdx = PTY_HOST_VERB_SRC.indexOf('if (contextIdentity) {');
    const workCtxIdx = PTY_HOST_VERB_SRC.indexOf('resolveWorkContext(');
    assert.ok(hasDispatchIdx > 0 && lifecycleIdx > hasDispatchIdx, 'contextIdentity guard must follow the hasDispatch block');
    assert.ok(workCtxIdx > lifecycleIdx, 'resolveWorkContext must be called inside the contextIdentity guard');
});

test('standalone feeds the lifecycle from the parse-based identity too', () => {
    assert.ok(
        /let contextIdentity/.test(SEND_PROMPT_SRC),
        'ptySendPrompt case must resolve a contextIdentity independent of the dispatch field'
    );
    assert.ok(
        /extractDispatchIdentity\(payload\.data\)/.test(SEND_PROMPT_SRC),
        'ptySendPrompt case must fall back to extractDispatchIdentity when no dispatch field is supplied'
    );
    assert.ok(
        /if \(contextIdentity\) \{/.test(SEND_PROMPT_SRC),
        'the work-context lifecycle block must be guarded on contextIdentity, not on payload.dispatch'
    );
});

// --- 6. The destination override honours terminal.clearBeforePrompt ---

test('extension host destination override honours terminal.clearBeforePrompt', () => {
    assert.ok(
        /const clearEnabled = vscode\.workspace\.getConfiguration\('switchboard'\)\.get<boolean>\('terminal\.clearBeforePrompt', true\)/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must read terminal.clearBeforePrompt for the lifecycle decision'
    );
    assert.ok(
        /if \(clearEnabled\) \{\s*\n\s*payload = \{ \.\.\.payload, clearBeforePrompt: true \};/.test(PTY_HOST_VERB_SRC),
        'the team-branch destination override must be gated on clearEnabled'
    );
    assert.ok(
        /if \(clearEnabled && lastWorkKey && lastWorkKey !== workContextKey\)/.test(PTY_HOST_VERB_SRC),
        'the non-team destination override must be gated on clearEnabled'
    );
});

test('standalone destination override honours terminal.clearBeforePrompt', () => {
    assert.ok(
        /const clearEnabled = getPromptDeliveryOptions\(\)\.clearBeforePrompt/.test(SEND_PROMPT_SRC),
        'ptySendPrompt case must read the configured clearBeforePrompt for the lifecycle decision'
    );
    assert.ok(
        /if \(clearEnabled\) \{\s*\n\s*payload\.clearBeforePrompt = true;/.test(SEND_PROMPT_SRC),
        'the team-branch destination override must be gated on clearEnabled'
    );
    assert.ok(
        /if \(clearEnabled && lastWorkKey && lastWorkKey !== workContextKey\)/.test(SEND_PROMPT_SRC),
        'the non-team destination override must be gated on clearEnabled'
    );
});

// --- 7. Work-context map maintenance on ptyClearTerminal ---

test('extension host deletes the work-context entry on ptyClearTerminal', () => {
    assert.ok(
        /ptyClearTerminal/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must reference ptyClearTerminal'
    );
    assert.ok(
        /_lastWorkContextByTerminal\.delete/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must delete from _lastWorkContextByTerminal'
    );
});

test('standalone deletes the work-context entry on ptyClearTerminal', () => {
    const clearStart = BOOT.indexOf("case 'ptyClearTerminal':");
    const clearEnd = BOOT.indexOf("case '", clearStart + 50);
    const clearSrc = BOOT.slice(clearStart, clearEnd);
    assert.ok(
        /lastWorkContextByTerminal\.delete/.test(clearSrc),
        'ptyClearTerminal case must delete from lastWorkContextByTerminal'
    );
});

// --- 8. Work-context maps cleared on ptyClearAllTerminals ---

test('extension host clears the work-context maps on ptyClearAllTerminals', () => {
    const branchIdx = PTY_HOST_VERB_SRC.indexOf("else if (verb === 'ptyClearAllTerminals')");
    assert.ok(branchIdx > 0, '_ptyHostVerb must have a ptyClearAllTerminals branch');
    const afterBranch = PTY_HOST_VERB_SRC.slice(branchIdx, branchIdx + 400);
    assert.ok(
        /_lastWorkContextByTerminal\.clear\(\)/.test(afterBranch),
        '_ptyHostVerb must clear _lastWorkContextByTerminal on ptyClearAllTerminals'
    );
    assert.ok(
        /_lastWorkContextByTeam\.clear\(\)/.test(afterBranch),
        '_ptyHostVerb must clear _lastWorkContextByTeam on ptyClearAllTerminals — a stale team run key would skip the next barrier'
    );
});

test('standalone clears the work-context maps on ptyClearAllTerminals', () => {
    const clearAllStart = BOOT.indexOf("case 'ptyClearAllTerminals':");
    const clearAllEnd = BOOT.indexOf("case '", clearAllStart + 50);
    const clearAllSrc = BOOT.slice(clearAllStart, clearAllEnd);
    assert.ok(
        /lastWorkContextByTerminal\.clear\(\)/.test(clearAllSrc),
        'ptyClearAllTerminals case must clear lastWorkContextByTerminal'
    );
    assert.ok(
        /lastWorkContextByTeam\.clear\(\)/.test(clearAllSrc),
        'ptyClearAllTerminals case must clear lastWorkContextByTeam'
    );
});

// --- 9. Work-context entry deleted on ptyCloseTerminal ---

test('extension host deletes the work-context entry on ptyCloseTerminal', () => {
    assert.ok(
        /ptyCloseTerminal.*_lastWorkContextByTerminal\.delete/s.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must delete from _lastWorkContextByTerminal on ptyCloseTerminal'
    );
});

test('standalone deletes the work-context entry on ptyCloseTerminal', () => {
    const closeStart = BOOT.indexOf("case 'ptyCloseTerminal':");
    const closeEnd = BOOT.indexOf("case '", closeStart + 50);
    const closeSrc = BOOT.slice(closeStart, closeEnd);
    assert.ok(
        /lastWorkContextByTerminal\.delete/.test(closeSrc),
        'ptyCloseTerminal case must delete from lastWorkContextByTerminal'
    );
});

// --- 10. Work-context entry renamed on ptyRenameTerminal ---

test('extension host renames the work-context entry on ptyRenameTerminal', () => {
    assert.ok(
        /ptyRenameTerminal/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must reference ptyRenameTerminal'
    );
    assert.ok(
        /_lastWorkContextByTerminal\.get\(payload\.name\).*_lastWorkContextByTerminal\.set\(payload\.alias/s.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must rename the work-context entry from payload.name to payload.alias on ptyRenameTerminal'
    );
});

test('standalone renames the work-context entry on ptyRenameTerminal', () => {
    const renameStart = BOOT.indexOf("case 'ptyRenameTerminal':");
    const renameEnd = BOOT.indexOf("case '", renameStart + 50);
    const renameSrc = BOOT.slice(renameStart, renameEnd);
    assert.ok(
        /lastWorkContextByTerminal\.get\(payload\.name\).*lastWorkContextByTerminal\.set\(payload\.alias/s.test(renameSrc),
        'ptyRenameTerminal case must rename the work-context entry from payload.name to payload.alias'
    );
});

// --- 11. Work-context entry deleted on ptyWrite with /clear (extension host) ---

test('extension host deletes the work-context entry on ptyWrite with /clear', () => {
    // The seat-cache-drop block detects ptyWrite with /clear and deletes
    // the work-context entry alongside the seat cache.
    assert.ok(
        /ptyWrite.*\/clear.*_lastWorkContextByTerminal/s.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must delete from _lastWorkContextByTerminal on ptyWrite with /clear'
    );
});

// --- 12. Same-context and first-dispatch cases preserve the caller's false ---

test('both hosts check work-key existence before overriding (first dispatch is not cleared)', () => {
    assert.ok(
        /lastWorkKey && lastWorkKey !== workContextKey/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must check lastWorkKey existence so a first dispatch does not auto-clear'
    );
    assert.ok(
        /lastWorkKey && lastWorkKey !== workContextKey/.test(SEND_PROMPT_SRC),
        'ptySendPrompt case must check lastWorkKey existence so a first dispatch does not auto-clear'
    );
});

test('both hosts suppress the destination clear for a same-work-context team dispatch', () => {
    // The same-feature branch acquired the deferred-clear intercept between the
    // key compare and the suppression, so this is sliced rather than windowed:
    // a fixed character window silently turns into "the branch got longer" the
    // next time anything is inserted, and the assertion stops meaning anything.
    const extBranch = sliceSameFeatureBranch(PTY_HOST_VERB_SRC, 'TaskViewerProvider.ts');
    assert.ok(
        /clearBeforePrompt: false/.test(extBranch),
        '_ptyHostVerb must send clearBeforePrompt:false when the team already holds this work context'
    );
    const stdBranch = sliceSameFeatureBranch(SEND_PROMPT_SRC, 'bootstrap.ts');
    assert.ok(
        /clearBeforePrompt = false/.test(stdBranch),
        'ptySendPrompt case must send clearBeforePrompt=false when the team already holds this work context'
    );
});

// The suppression is conditional now: a destination sitting in the team's
// deferred-clear set is the one case that must OVERRIDE back to true, because
// its barrier clear was skipped for being mid-turn and the delivery path is
// where it gets paid. Pin both halves, or "always false" passes the test above
// while silently dropping every deferred clear.
test('both hosts override the suppression for a destination in the deferred-clear set', () => {
    const extBranch = sliceSameFeatureBranch(PTY_HOST_VERB_SRC, 'TaskViewerProvider.ts');
    assert.ok(
        /_deferredClearsByTeam\.get\(teamId\)/.test(extBranch) && /clearBeforePrompt: true/.test(extBranch),
        '_ptyHostVerb must override to clearBeforePrompt:true for a deferred destination'
    );
    const stdBranch = sliceSameFeatureBranch(SEND_PROMPT_SRC, 'bootstrap.ts');
    assert.ok(
        /deferredClearsByTeam\.get\(teamId\)/.test(stdBranch) && /clearBeforePrompt = true/.test(stdBranch),
        'ptySendPrompt case must override to clearBeforePrompt=true for a deferred destination'
    );
});

// --- 13. The roster barrier names the seat that failed ---

test('extension host abort message names the failed seat, not its error text', () => {
    // `activeMembers` became `toClear` when the target-set computation moved into
    // computeRosterClearTargets; the array it indexes is what matters, not its name.
    assert.ok(
        /Team preparation clear failed for '\$\{toClear\[failedIdx\]\}'/.test(PTY_HOST_VERB_SRC),
        'the abort message must interpolate the failed member NAME — the result objects carry no name, so failed.error in that slot reported the error twice and the seat never'
    );
});

if (failures > 0) { console.error(`\n${failures} contract failure(s)`); process.exit(1); }
console.log('\nAll host-auto-clear-on-plan-change contract assertions passed.');
