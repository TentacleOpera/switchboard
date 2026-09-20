'use strict';

/**
 * Contract: Host dispatch paths issue NO forced clear.
 *
 * The dispatch path (ptySendPrompt in both composition roots) must NOT
 * override clearBeforePrompt to true. A seat is cleared at rest (when its
 * work is accepted, a round closes, a feature completes, or a queue item
 * pops) or once when a new feature run starts — never by a dispatch. The
 * roster barrier still runs on a work-context change, but it is decoupled
 * from the destination's prompt: it clears siblings concurrently, does not
 * block delivery, and does not clear the destination.
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
 *   3. The dispatch path issues no clear. The destination was already cleaned
 *      by the at-rest path (clearSeatAtRest) or the previous feature barrier.
 *      Same-context resends preserve false. The manual stand-down clear
 *      (empty data + clearBeforePrompt: true in TaskViewerProvider) is the
 *      ONLY host-forced true and is excluded from the negative assertion.
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

// --- 3. Extension host dispatch path issues NO forced clear ---

test('extension host dispatch path does not force clearBeforePrompt true', () => {
    // The dispatch path (_ptyHostVerb) must NOT override clearBeforePrompt to
    // true. The destination was already cleaned by the at-rest path or the
    // previous feature barrier. The manual stand-down clear (empty data +
    // clearBeforePrompt: true) lives in a DIFFERENT method and is excluded
    // from this slice by construction — PTY_HOST_VERB_SRC is the _ptyHostVerb
    // method body only.
    assert.ok(
        !/clearBeforePrompt:\s*true/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must NOT set clearBeforePrompt to true — the dispatch path issues no clear'
    );
    assert.ok(
        !/lastPlanId\s*&&\s*lastPlanId\s*!==\s*planId/.test(PTY_HOST_VERB_SRC),
        'the superseded planId compare must NOT survive alongside the work-context compare'
    );
});

// --- 4. Standalone dispatch path issues NO forced clear ---

test('standalone dispatch path does not force clearBeforePrompt true', () => {
    assert.ok(
        !/payload\.clearBeforePrompt\s*=\s*true/.test(SEND_PROMPT_SRC),
        'ptySendPrompt case must NOT set payload.clearBeforePrompt to true — the dispatch path issues no clear'
    );
    assert.ok(
        !/lastPlanId\s*&&\s*lastPlanId\s*!==\s*parsed\.value\.planId/.test(SEND_PROMPT_SRC),
        'the superseded planId compare must NOT survive alongside the work-context compare'
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

// --- 6. The roster barrier still reads terminal.clearBeforePrompt ---

test('extension host roster barrier honours terminal.clearBeforePrompt', () => {
    assert.ok(
        /const clearEnabled = vscode\.workspace\.getConfiguration\('switchboard'\)\.get<boolean>\('terminal\.clearBeforePrompt', true\)/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must read terminal.clearBeforePrompt for the roster barrier decision'
    );
    // The destination override is GONE. The barrier clears siblings, not the
    // destination. The dispatch path issues no clear.
    assert.ok(
        !/if \(clearEnabled && lastTeamWorkKey && lastTeamWorkKey !== workContextKey\) \{\s*\n\s*payload = \{ \.\.\.payload, clearBeforePrompt: true \};/.test(PTY_HOST_VERB_SRC),
        'the team-branch destination override must be gone — the dispatch path issues no clear'
    );
    assert.ok(
        !/if \(clearEnabled && lastWorkKey && lastWorkKey !== workContextKey\)/.test(PTY_HOST_VERB_SRC),
        'the non-team destination override must be gone — the dispatch path issues no clear'
    );
});

test('standalone roster barrier honours terminal.clearBeforePrompt', () => {
    assert.ok(
        /const clearEnabled = getPromptDeliveryOptions\(\)\.clearBeforePrompt/.test(SEND_PROMPT_SRC),
        'ptySendPrompt case must read the configured clearBeforePrompt for the roster barrier decision'
    );
    assert.ok(
        !/if \(clearEnabled && lastTeamWorkKey && lastTeamWorkKey !== workContextKey\) \{\s*\n\s*payload\.clearBeforePrompt = true;/.test(SEND_PROMPT_SRC),
        'the team-branch destination override must be gone — the dispatch path issues no clear'
    );
    assert.ok(
        !/if \(clearEnabled && lastWorkKey && lastWorkKey !== workContextKey\)/.test(SEND_PROMPT_SRC),
        'the non-team destination override must be gone — the dispatch path issues no clear'
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

// --- 12. Same-context dispatch preserves false; first dispatch is not cleared ---

test('both hosts compare the team work-context key for the same-feature branch', () => {
    // The same-feature branch comparison still drives the roster barrier
    // (same-context → no barrier; different-context → barrier clears siblings).
    // The destination override is gone, so "first dispatch is not cleared" is
    // now trivially true: the dispatch path issues no clear at all.
    assert.ok(
        /lastTeamWorkKey === workContextKey/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must compare lastTeamWorkKey === workContextKey for the same-feature branch'
    );
    assert.ok(
        /lastTeamWorkKey === workContextKey/.test(SEND_PROMPT_SRC),
        'ptySendPrompt case must compare lastTeamWorkKey === workContextKey for the same-feature branch'
    );
    // The destination override check is GONE — no lastWorkKey/lastTeamWorkKey
    // gate on a clearBeforePrompt = true override.
    assert.ok(
        !/lastWorkKey\s*&&\s*lastWorkKey\s*!==\s*workContextKey/.test(PTY_HOST_VERB_SRC),
        '_ptyHostVerb must NOT have a lastWorkKey destination-override check — the dispatch path issues no clear'
    );
    assert.ok(
        !/lastWorkKey\s*&&\s*lastWorkKey\s*!==\s*workContextKey/.test(SEND_PROMPT_SRC),
        'ptySendPrompt case must NOT have a lastWorkKey destination-override check — the dispatch path issues no clear'
    );
});

test('both hosts suppress the destination clear for a same-work-context team dispatch', () => {
    // The same-feature branch sets clearBeforePrompt: false explicitly.
    // Sliced rather than windowed: a fixed character window silently turns
    // into "the branch got longer" the next time anything is inserted.
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

// The deferred-clear intercept is GONE. A deferred seat gets its clear from
// the at-rest path (clearSeatAtRest) or the next feature barrier — never from
// a dispatch. Pin the absence, or "always false" passes the test above while
// silently dropping every deferred clear.
test('both hosts do NOT intercept a deferred-clear set on the same-feature branch', () => {
    const extBranch = sliceSameFeatureBranch(PTY_HOST_VERB_SRC, 'TaskViewerProvider.ts');
    assert.ok(
        !/_deferredClearsByTeam\.get\(teamId\)/.test(extBranch),
        '_ptyHostVerb must NOT check a deferred-clear set on the same-feature branch — the intercept is gone'
    );
    assert.ok(
        !/clearBeforePrompt: true/.test(extBranch),
        '_ptyHostVerb same-feature branch must NOT set clearBeforePrompt:true — the dispatch path issues no clear'
    );
    const stdBranch = sliceSameFeatureBranch(SEND_PROMPT_SRC, 'bootstrap.ts');
    assert.ok(
        !/deferredClearsByTeam\.get\(teamId\)/.test(stdBranch),
        'ptySendPrompt case must NOT check a deferred-clear set on the same-feature branch — the intercept is gone'
    );
    assert.ok(
        !/clearBeforePrompt = true/.test(stdBranch),
        'ptySendPrompt same-feature branch must NOT set clearBeforePrompt=true — the dispatch path issues no clear'
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

// --- 14. The roster-clear barrier's stable-state invariants (feature a7513ffb) ---
//
// Nine barrier findings landed with manual verification only. These are the
// cheap source-text discriminators for the ones a green suite could otherwise
// hide — every one of them was a live defect at some point.

test('the already-clean filter has the write it depends on, in both hosts', () => {
    // The filter reads _lastWorkContextByTerminal to mean "dispatched to since
    // its last clear". The team branch never wrote that map, so the filter
    // emptied toClear on EVERY team dispatch and the barrier cleared nobody.
    assert.ok(
        /const toClear = rawToClear\.filter\(name => this\._lastWorkContextByTerminal\.has\(name\) && this\._lastWorkContextByTerminal\.get\(name\) !== workContextKey\);/.test(PTY_HOST_VERB_SRC),
        'extension barrier must exclude already-clean seats from toClear'
    );
    assert.ok(
        /const toClear = rawToClear\.filter\(name => lastWorkContextByTerminal\.has\(name\) && lastWorkContextByTerminal\.get\(name\) !== workContextKey\);/.test(SEND_PROMPT_SRC),
        'standalone barrier must exclude already-clean seats from toClear'
    );
    const extTeamBranch = PTY_HOST_VERB_SRC.slice(
        PTY_HOST_VERB_SRC.indexOf('if (teamInfo && teamInfo.id)'),
        PTY_HOST_VERB_SRC.indexOf('} else if (workContextKey && payload.name)')
    );
    assert.ok(
        /this\._lastWorkContextByTerminal\.set\(payload\.name, workContextKey\)/.test(extTeamBranch),
        'extension TEAM branch must record the destination per-terminal work-context key — without it the already-clean filter empties toClear forever'
    );
    const stdTeamBranch = SEND_PROMPT_SRC.slice(
        SEND_PROMPT_SRC.indexOf('if (teamInfo && teamInfo.id)'),
        SEND_PROMPT_SRC.indexOf('} else if (workContextKey && payload.name)')
    );
    assert.ok(
        /lastWorkContextByTerminal\.set\(payload\.name, workContextKey\)/.test(stdTeamBranch),
        'standalone TEAM branch must record the destination per-terminal work-context key'
    );
});

test('the barrier does NOT prune a deferred set — the set is gone, in both hosts', () => {
    assert.ok(
        !/dropDeferredClear\(this\._deferredClearsByTeam/.test(PTY_HOST_VERB_SRC),
        'extension barrier must NOT call dropDeferredClear — the deferred-clear set is gone'
    );
    assert.ok(
        !/dropDeferredClear\(deferredClearsByTeam/.test(SEND_PROMPT_SRC),
        'standalone barrier must NOT call dropDeferredClear — the deferred-clear set is gone'
    );
    assert.ok(
        !/_deferredClearsByTeam/.test(PTY_HOST_VERB_SRC),
        'extension _ptyHostVerb must NOT reference _deferredClearsByTeam — the set is gone'
    );
    assert.ok(
        !/deferredClearsByTeam/.test(SEND_PROMPT_SRC),
        'standalone ptySendPrompt case must NOT reference deferredClearsByTeam — the set is gone'
    );
});

test('the work-context key is recorded unconditionally after the barrier, in both hosts', () => {
    assert.ok(
        !/if \(toClear\.length > 0 \|\| deferred\.length === 0\)/.test(PTY_HOST_VERB_SRC),
        'extension barrier must NOT gate the work-context record on toClear/deferred — a team whose only idle seat is the head never recorded it and re-ran the barrier on every dispatch'
    );
    assert.ok(
        !/if \(toClear\.length > 0 \|\| deferred\.length === 0\)/.test(SEND_PROMPT_SRC),
        'standalone barrier must NOT gate the work-context record on toClear/deferred'
    );
});

test('resolveTeamGroupForTerminal backfills head on the member branch', () => {
    const wcr = read('src/services/workContextResolver.ts');
    assert.ok(
        /head: g\.head \|\| terminalName/.test(wcr),
        'the member branch must backfill head — a legacy team row with no head made the head exclusion inert and an idle lead was cleared mid-feature'
    );
});

test("LocalApiServer's busy window comes from an option that both roots wire", () => {
    const lapi = read('src/services/LocalApiServer.ts');
    assert.ok(
        !/const livenessWindowMs = 90000/.test(lapi),
        'the hardcoded 90000 literal must be gone from LocalApiServer'
    );
    assert.ok(
        /livenessWindowMs\?: number;/.test(lapi),
        'LocalApiServerOptions must declare livenessWindowMs'
    );
    // A declared option no root passes is a dead seam — the failure mode
    // CLAUDE.md names: the setting moves and nothing changes.
    assert.ok(
        /livenessWindowMs: vscode\.workspace\.getConfiguration\('switchboard'\)\.get<number>\('activityLight\.livenessWindowMs'/.test(TVP),
        'the extension composition root must pass livenessWindowMs to LocalApiServer'
    );
    assert.ok(
        /livenessWindowMs: configProvider\.getConfigNumber\('activityLight\.livenessWindowMs'/.test(BOOT),
        'the standalone composition root must pass livenessWindowMs to LocalApiServer'
    );
});

test('standalone triggerAction dispatches through the roster barrier, not deliverPrompt', () => {
    // Anchored on the brace form: a bare `case 'triggerAction':` also appears in
    // the verb-name switch at :1700 and slicing from there reads the wrong body.
    const triggerStart = BOOT.indexOf("case 'triggerAction': {");
    assert.ok(triggerStart > 0, "triggerAction case must exist in bootstrap.ts");
    const triggerEnd = BOOT.indexOf("\n                case '", triggerStart + 50);
    const TRIGGER_SRC = BOOT.slice(triggerStart, triggerEnd > 0 ? triggerEnd : undefined);
    assert.ok(
        /handlePtyVerb\('ptySendPrompt'/.test(TRIGGER_SRC),
        'the triggerAction case must route through ptySendPrompt so the roster barrier runs — calling deliverPrompt directly gave board drags no roster protection on this host'
    );
    assert.ok(
        !/await deliverPrompt\(terminal, prompt/.test(TRIGGER_SRC),
        'the triggerAction case must not call deliverPrompt directly'
    );
    assert.ok(
        /deliveryReceipt\.success === false/.test(TRIGGER_SRC),
        'routing through the verb replaced a throw with a returned envelope — triggerAction must check success:false or it stamps and moves a card for a prompt that never landed'
    );
});

test('standalone clearTerminalContext does NOT push standing orders after a clear', () => {
    const ctxStart = BOOT.indexOf('const clearTerminalContext');
    const ctxSrc = ctxStart > 0
        ? BOOT.slice(ctxStart, ctxStart + 6000)
        : BOOT;
    assert.ok(
        !/deliverStandingOrdersAfterClear/.test(ctxSrc),
        'standalone clearTerminalContext must NOT push standing orders after a clear: orders ride every '
        + 'prompt delivery, so the next dispatch carries them. The push fired into a seat that was still '
        + 'settling and delivered a task-less orders block nobody acted on.'
    );
});

test('no after-clear orders envelope survives anywhere', () => {
    // The envelope ("No action is required. Wait for your next dispatch.") existed
    // only to reframe a bare orders block pushed at a seat that had no task. With
    // the push gone there is no task-less delivery to reframe, so the text must not
    // reappear -- in the provider or in the shared renderer.
    assert.ok(
        !/No action is required\. Wait for your next dispatch\./.test(TVP),
        'the after-clear envelope must be gone with the delivery it wrapped'
    );
    assert.ok(
        !/isAfterClear/.test(TVP),
        'nothing should still branch on an after-clear delivery that no longer exists'
    );
    const so = read('src/services/standingOrders.ts');
    assert.ok(
        !/No action is required/.test(so),
        'the envelope must NOT leak into renderStandaloneOrdersBlock — that renderer is shared with applyStandingOrders, where the block IS appended to a real task'
    );
});

test('completion side-effects are not gated on the write transition', () => {
    const lapi = read('src/services/LocalApiServer.ts');
    assert.ok(
        !/if \(result\.success && !result\.idempotent && this\._options\.onTeamReleased\)/.test(lapi),
        'onTeamReleased must not be gated on !idempotent — a team is released because the card is complete, not because a particular POST wrote the timestamp'
    );
    assert.ok(
        !/if \(!isTeamMember && this\._options\.clearTerminalContext\)/.test(lapi),
        'the queue/done clear must not exclude team members — that guard and the idempotent return formed a closed loop with no exit'
    );
    assert.ok(
        /_isSeatCurrentDispatchedCard/.test(lapi),
        'the clear must be guarded on the seat\'s CURRENT dispatched card, not on the write transition'
    );
});

// --- 15. Shared clearSeatAtRest helper centralizes all at-rest clears ---

test('LocalApiServer declares a shared clearSeatAtRest helper', () => {
    const lapi = read('src/services/LocalApiServer.ts');
    assert.ok(
        /private async clearSeatAtRest\(/.test(lapi),
        'LocalApiServer must declare a private clearSeatAtRest helper'
    );
    assert.ok(
        /this\.markSeatAtRest\(workspaceRoot, seat, planId\)/.test(lapi),
        'clearSeatAtRest must call markSeatAtRest on a successful clear'
    );
    assert.ok(
        /this\._options\.onTerminalContextCleared/.test(lapi),
        'clearSeatAtRest must fire onTerminalContextCleared on a successful clear'
    );
});

test('all at-rest clear paths route through clearSeatAtRest, not inline clearTerminalContext', () => {
    const lapi = read('src/services/LocalApiServer.ts');
    // Each of the five at-rest paths must call clearSeatAtRest, not inline
    // clearTerminalContext. The reason tag identifies which caller asked.
    // 'releaseCardInternal' is gone: V81 deleted the release valve along with the
    // in-flight gate it existed to work around. The remaining four at-rest paths
    // still route through clearSeatAtRest.
    for (const reason of ['completeCardInternal', 'round-complete', 'feature-complete', 'queue-done']) {
        assert.ok(
            new RegExp(`clearSeatAtRest\\(workspaceRoot, [^,]+, [^,]+, '${reason}'`).test(lapi),
            `the '${reason}' path must call clearSeatAtRest with its reason tag`
        );
    }
});

test('_handleKanbanRoundComplete clears coder seats through clearSeatAtRest, not inline', () => {
    const lapi = read('src/services/LocalApiServer.ts');
    // Anchor on the METHOD DECLARATION, not the first mention: clearSeatAtRest's
    // own docblock names _handleKanbanRoundComplete as a caller, so a bare
    // indexOf() slices the docblock and the assertions below read an empty body.
    const rcStart = lapi.indexOf('private async _handleKanbanRoundComplete');
    assert.ok(rcStart > 0, '_handleKanbanRoundComplete must exist');
    const rcEnd = lapi.indexOf('\n    private ', rcStart + 100);
    const rcSrc = lapi.slice(rcStart, rcEnd > 0 ? rcEnd : undefined);
    // The handler has TWO coder-seat clear loops, and that is correct: the
    // stateless fallback (a team with zero registered rounds) returns before
    // the round-aware path is reached, so they are mutually exclusive branches,
    // never two clears of one roster. The plan's "twice in one handler" reading
    // came from a line-number scan, not the control flow. Pin the count so a
    // THIRD loop — or a merge that makes the two reachable in sequence — fails.
    const clearCalls = rcSrc.match(/clearSeatAtRest\(workspaceRoot, name, undefined, 'round-complete'\)/g) || [];
    assert.strictEqual(
        clearCalls.length, 2,
        'round-complete must clear coder seats through clearSeatAtRest in exactly its two mutually exclusive branches'
    );
    // No inline clearTerminalContext calls in the round-complete handler.
    assert.ok(
        !/this\._options\.clearTerminalContext\(workspaceRoot, name\)/.test(rcSrc),
        'round-complete handler must NOT call clearTerminalContext inline — use clearSeatAtRest'
    );
});

// --- 16. Goal invariant: the automatic-clear budget ---

test('the clear seam has exactly two callers: the at-rest helper and the operator clear', () => {
    // The plan's budget: TWO automatic clear triggers (seat-at-rest and the
    // feature-receipt roster barrier) plus the operator-initiated ones. Inside
    // LocalApiServer the at-rest trigger is `clearSeatAtRest` and the
    // operator-initiated one is `_handleTerminalsClear`. A third CALL of the
    // seam is a third independent decider — the exact accumulation this plan
    // reversed — so pin the call count and the two owning methods.
    const lapi = read('src/services/LocalApiServer.ts');
    const calls = lapi.match(/this\._options\.clearTerminalContext\(/g) || [];
    assert.strictEqual(
        calls.length, 2,
        `clearTerminalContext must be CALLED exactly twice (clearSeatAtRest + _handleTerminalsClear), found ${calls.length}`
    );
    const sliceMethod = (name) => {
        const i = lapi.indexOf(name);
        assert.ok(i > 0, `${name} must exist`);
        const j = lapi.indexOf('\n    private ', i + 100);
        return lapi.slice(i, j > 0 ? j : undefined);
    };
    assert.ok(
        /this\._options\.clearTerminalContext\(workspaceRoot, seat\)/.test(sliceMethod('private async clearSeatAtRest(')),
        'clearSeatAtRest must own the automatic at-rest clear'
    );
    assert.ok(
        /this\._options\.clearTerminalContext\(/.test(sliceMethod('private async _handleTerminalsClear(')),
        '_handleTerminalsClear must own the operator-initiated clear'
    );
});

if (failures > 0) { console.error(`\n${failures} contract failure(s)`); process.exit(1); }
console.log('\nAll host-auto-clear-on-plan-change contract assertions passed.');
