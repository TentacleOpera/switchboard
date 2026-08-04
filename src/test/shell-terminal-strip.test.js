'use strict';

/**
 * Contract tests for the Shell Terminal Strip with Completion Lights.
 *
 * Source-text contracts, not behavioural ones: the strip is browser-only DOM code
 * in an IIFE with no export surface, and every failure mode here is a rendering
 * defect a headless run cannot observe. What CAN be pinned is the handful of
 * decisions that are invisible on inspection and were each wrong in a first pass:
 *
 *   - the bottom anchor is an INLINE style on the theme toggle, so adding a second
 *     `margin-top: auto` child parks the terminal list mid-strip instead of
 *     stacking. The anchor has to MOVE, not be duplicated.
 *   - `assignToFocusedPane` early-returns when the terminal is already in the
 *     focused pane — the most likely case for a click on a lit entry — so the
 *     badge clear cannot be delegated to it.
 *   - the relay must target `location.origin`; the pre-existing theme fan-out uses
 *     '*' and is the wrong thing to copy.
 *   - the light is resolved panel-side so the two surfaces cannot disagree.
 *
 * The first version of this file re-implemented `resolveLight` and the manifest
 * gate locally and asserted against its own copies — it could not fail for any
 * change to the product code. These read the real files.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const terminalsJs = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');
const shellJs = fs.readFileSync(path.join(__dirname, '../webview/shell.js'), 'utf8');
const shellHtml = fs.readFileSync(path.join(__dirname, '../webview/shell.html'), 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}\n     ${e.message}`);
        failed++;
    }
}

function block(code, startMarker, endMarker) {
    const start = code.indexOf(startMarker);
    assert.ok(start !== -1, `marker not found: ${startMarker}`);
    const end = code.indexOf(endMarker, start);
    assert.ok(end !== -1, `end marker not found after "${startMarker}": ${endMarker}`);
    return code.substring(start, end);
}

// ------------------------------------------------------- relay (terminals.js side)

test('light precedence is resolved panel-side as exited > done > active', () => {
    const relay = block(terminalsJs, 'function postFleetStateToShell() {', 'const LAYOUTS = {');

    const activeAt = relay.indexOf("let light = 'active'");
    const exitedAt = relay.indexOf("light = 'exited'");
    const doneAt = relay.indexOf("light = 'done'");

    assert.ok(activeAt !== -1, 'relay must default the light to active');
    assert.ok(exitedAt !== -1, 'relay must resolve an exited light');
    assert.ok(doneAt !== -1, 'relay must resolve a done light');
    assert.ok(activeAt < exitedAt, 'active must be the default the checks below overwrite');
    assert.ok(exitedAt < doneAt, 'the exited check must precede the badge check');

    // `done` must be an ELSE of `exited`, so a terminal that finished AND died reads
    // as exited rather than depending on render order.
    assert.ok(
        /if \(t\.status === 'exited'\)[\s\S]*\} else if \(terminalBadges\.has/.test(relay),
        'the badge check must be an else-branch of the exited check, not an independent if'
    );
});

test('relay targets location.origin and no-ops when there is no parent frame', () => {
    const relay = block(terminalsJs, 'function postFleetStateToShell() {', 'const LAYOUTS = {');
    assert.ok(
        relay.includes('if (window.parent === window) { return; }'),
        'relay must no-op on the standalone/solo page rather than post to itself'
    );
    assert.ok(
        /window\.parent\.postMessage\([\s\S]*\}, location\.origin\)/.test(relay),
        "relay must post with location.origin as target origin, never '*'"
    );
    assert.ok(!relay.includes("'*'"), "relay must not copy the theme fan-out's '*' target origin");
});

test('relay carries only fleet metadata — no terminal bytes', () => {
    const relay = block(terminalsJs, 'function postFleetStateToShell() {', 'const LAYOUTS = {');
    const payload = block(relay, 'return {', '};');
    const names = payload
        .split('\n')
        .slice(1) // drop the `return {` line
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => (l.match(/^(\w+)\s*[:,]?/) || [])[1])
        .filter(Boolean);
    assert.deepStrictEqual(
        names.slice().sort(),
        ['light', 'name', 'role', 'worktreePath'],
        'the relay payload must be exactly the four metadata fields the plan allows'
    );
    for (const n of names) {
        assert.ok(
            ['name', 'role', 'worktreePath', 'light'].includes(n),
            `relay payload field "${n}" is outside the metadata set the plan allows`
        );
    }
});

test('an agentCompleted for a name absent from fleetList triggers a refetch', () => {
    const handler = block(terminalsJs, 'function handleAgentCompleted(msg) {', 'function showCompletionToast(');
    assert.ok(
        /const isKnown = fleetList\.some\([\s\S]*if \(!isKnown\) \{[\s\S]*fetchTerminalList\(\)/.test(handler),
        'a badge for a terminal not yet in fleetList must trigger fetchTerminalList so the strip converges'
    );
    assert.ok(
        handler.indexOf('terminalBadges.set(') < handler.indexOf('fetchTerminalList()'),
        'the badge must be set BEFORE the refetch, or the relayed snapshot will not carry it'
    );
});

// ------------------------------------------------------------- click / badge clear

test('focusTerminal clears the badge itself, not via the seating call', () => {
    const arm = block(terminalsJs, "message.type === 'focusTerminal'", "message.type === 'clearTerminalBadge'");
    const clearAt = arm.indexOf('terminalBadges.delete(');
    // The arm delegates to locateTerminal, which seats the terminal AND hands it
    // the caret — an inbound focus request means "let me type in this one", so the
    // pane assignment alone was never the whole job.
    const seatAt = arm.indexOf('locateTerminal(');
    assert.ok(clearAt !== -1, 'the focusTerminal arm must clear the badge');
    assert.ok(seatAt !== -1, 'the focusTerminal arm must seat the terminal in the focused pane');
    // assignToFocusedPane early-returns when the terminal already occupies the
    // focused pane, which is the most likely case for a click on a lit entry.
    assert.ok(clearAt < seatAt, 'the badge must be cleared BEFORE delegating, to survive the early-return path');
    assert.ok(arm.includes('renderSidebarList()'), 'the arm must repaint the sidebar on the early-return path');
    assert.ok(arm.includes('postFleetStateToShell()'), 'the arm must re-relay so the strip light clears too');
});

test('locateTerminal seats the terminal AND gives it the caret', () => {
    const fn = block(terminalsJs, 'function locateTerminal(name) {', 'function assignToFocusedPane(terminalName) {');
    assert.ok(fn.includes('assignToFocusedPane('), 'locateTerminal must still seat via assignToFocusedPane');
    assert.ok(fn.includes('focusPaneTerminal('), 'locateTerminal must focus the pane, or "focus terminal" cannot be typed into');
});

test('a pane focus change never rebuilds the grid', () => {
    // renderPaneGrid() empties #pane-grid and reparents every live xterm. A
    // re-parented node loses focus, so doing that for a highlight change costs the
    // operator their first click — the two-click-to-type defect.
    const fn = block(terminalsJs, 'function setFocusedPane(index) {', 'function renderPaneGrid() {');
    assert.ok(!fn.includes('renderPaneGrid()'), 'setFocusedPane must not rebuild the grid');
    assert.ok(fn.includes('classList.toggle('), 'setFocusedPane must move the .focused class directly');
    assert.ok(fn.includes('focusPaneTerminal('), 'setFocusedPane must hand the caret to the newly focused pane');
});

test('renderPaneGrid hands the caret back after a forced rebuild', () => {
    // It runs on every terminalsChanged broadcast and every agentCompleted badge,
    // so without this an unrelated terminal spawning yanks the caret mid-keystroke.
    const fn = block(terminalsJs, 'function renderPaneGrid() {', 'function createPaneElement(');
    assert.ok(fn.includes('paneGridEl.contains(document.activeElement)'), 'renderPaneGrid must record whether it owned the caret');
    assert.ok(
        fn.includes('if (hadFocus && !paneGridEl.contains(document.activeElement)) {') || fn.includes('if (hadFocus) {'),
        'renderPaneGrid must restore the caret it displaced'
    );
});

test('assignToFocusedPane re-relays on BOTH of its badge-clear paths', () => {
    const fn = block(terminalsJs, 'function assignToFocusedPane(terminalName) {', 'function undoLastAssignment() {');
    const clears = (fn.match(/terminalBadges\.delete\(/g) || []).length;
    const relays = (fn.match(/postFleetStateToShell\(\)/g) || []).length;
    assert.strictEqual(clears, 2, 'assignToFocusedPane is expected to clear a badge on exactly two paths');
    assert.strictEqual(relays, 2, 'each badge-clear path must relay, or the strip light outlives the panel badge');
});

test('the pop-out click path acknowledges the badge without rearranging the cockpit', () => {
    const handler = block(shellJs, "btn.addEventListener('click', () => {", 'container.appendChild(btn);');
    assert.ok(handler.includes('window.open('), 'the strip click must open the solo pop-out');
    assert.ok(
        handler.includes("type: 'clearTerminalBadge'"),
        'the pop-out path must clear the badge — focusTerminal is only reached on the fallback, so the DONE light would burn forever'
    );
    assert.ok(
        handler.includes("type: 'focusTerminal'"),
        'the blocked-popup / refused-focus fallback must still post focusTerminal'
    );
});

test('the panel accepts badge messages only from its own origin', () => {
    for (const type of ['focusTerminal', 'clearTerminalBadge']) {
        const arm = block(terminalsJs, `message.type === '${type}'`, 'postFleetStateToShell();');
        assert.ok(
            arm.includes('if (event.origin !== location.origin) { return; }'),
            `the ${type} arm must check event.origin`
        );
    }
    // The other three arms receive synthetic transport events dispatched with an
    // empty origin (transport.js), so an origin check there would reject the server
    // pushes the panel depends on.
    const listener = block(terminalsJs, "window.addEventListener('message', (event) => {", "window.addEventListener('resize'");
    for (const type of ['terminalsChanged', 'switchboardThemeChanged', 'agentCompleted']) {
        const armStart = listener.indexOf(`message.type === '${type}'`);
        assert.ok(armStart !== -1, `${type} arm not found`);
        const nextArm = listener.indexOf('} else if', armStart);
        const arm = listener.substring(armStart, nextArm === -1 ? listener.length : nextArm);
        assert.ok(
            !arm.includes('event.origin'),
            `the ${type} arm must NOT check event.origin — transport pushes arrive with origin ''`
        );
    }
});

// ------------------------------------------------------------------ strip rendering

test('the terminal section is gated on the terminals panel actually being mounted', () => {
    const fn = block(shellJs, 'function renderTerminalSection(terminals) {', 'function renderManifest(manifest) {');
    assert.ok(
        fn.includes("if (!frames.has('terminals')) {"),
        'the section must be gated on frames.has(terminals) — the same map the enabled===false skip populates'
    );
    const gateAt = fn.indexOf("if (!frames.has('terminals')) {");
    const buildAt = fn.indexOf("container.id = 'strip-terminals'");
    assert.ok(buildAt !== -1, 'the section container must be created here');
    assert.ok(gateAt < buildAt, 'the gate must precede container creation');
    assert.ok(fn.includes('container.remove()'), 'a gated-off section must be removed, not left as a dead control');
});

test('the bottom anchor MOVES to the section rather than being duplicated', () => {
    // buildThemeToggle owns the anchor inline; two auto margins in one column flex
    // container split the free space and park the list mid-strip.
    const toggle = block(shellJs, 'function buildThemeToggle() {', 'const popoutWindows');
    assert.ok(toggle.includes("btn.style.marginTop = 'auto'"), 'the toggle keeps the inline anchor as its default');

    const fn = block(shellJs, 'function renderTerminalSection(terminals) {', 'function renderManifest(manifest) {');
    assert.ok(
        fn.includes("themeBtn.style.marginTop = 'auto'"),
        'the gated-off branch must restore the inline anchor to the toggle'
    );
    assert.ok(
        fn.includes("themeBtn.style.marginTop = ''"),
        'creating the section must clear the inline anchor from the toggle'
    );
    assert.ok(
        fn.includes('strip.insertBefore(container, themeBtn)'),
        'the section must be inserted BEFORE the toggle — appendChild would land below it'
    );
    assert.ok(
        /#strip-terminals\s*\{[^}]*margin-top:\s*auto/.test(shellHtml),
        '#strip-terminals must carry the anchor in CSS'
    );
    const anchors = (shellHtml.match(/margin-top:\s*auto/g) || []).length;
    assert.strictEqual(anchors, 1, 'exactly one CSS rule may declare margin-top: auto in the strip');
});

test('the section is created eagerly in renderManifest, after the panel loop', () => {
    const fn = block(shellJs, 'function renderManifest(manifest) {', 'function loadManifest() {');
    const themeAt = fn.indexOf('strip.appendChild(themeBtn)');
    const sectionAt = fn.indexOf('renderTerminalSection([])');
    assert.ok(sectionAt !== -1, 'renderManifest must create the section eagerly');
    assert.ok(themeAt !== -1 && themeAt < sectionAt, 'the toggle is appended first; the section then inserts before it');
});

test('the light state is in the accessible name, not only the dot', () => {
    const fn = block(shellJs, 'function renderTerminalSection(terminals) {', 'function renderManifest(manifest) {');
    assert.ok(
        /labelText = `[^`]*\$\{t\.light\}/.test(fn),
        "the button's aria-label must spell out the light state — the dot is decorative markup"
    );
    assert.ok(fn.includes("btn.setAttribute('aria-label', labelText)"), 'the label text must be applied as aria-label');
    assert.ok(fn.includes("'Fleet terminals'"), 'the section needs an aria-label so entries are not announced loose');
    assert.ok(
        /container\.(role = 'group'|setAttribute\('role', 'group'\))/.test(fn),
        'the section must be role=group — #strip is a tablist and terminals are not tabs'
    );
});

test('the three lights differ by shape, not by colour alone', () => {
    const rule = cls => {
        const m = shellHtml.match(new RegExp(`\\.strip-term-dot\\.${cls}\\s*\\{([^}]*)\\}`));
        assert.ok(m, `.strip-term-dot.${cls} rule is missing`);
        return m[1];
    };
    const active = rule('dot-active');
    const done = rule('dot-done');
    const exited = rule('dot-exited');

    // Ring vs filled disc vs square: readable in a monochrome screenshot and to a
    // deuteranopic viewer, which green-vs-accent is not.
    assert.ok(/background:\s*transparent/.test(active) && /border:/.test(active), 'active must be a ring (unfilled)');
    assert.ok(/background-color:/.test(done) && !/background:\s*transparent/.test(done), 'done must be a filled disc');
    assert.ok(/border-radius:\s*50%/.test(done), 'done must stay circular');
    assert.ok(!/border-radius:\s*50%/.test(exited), 'exited must not be another circle — shape is the signal');
});

test('the section scrolls inside itself and adds no second scrollbar block', () => {
    const m = shellHtml.match(/#strip-terminals\s*\{([^}]*)\}/);
    assert.ok(m, '#strip-terminals rule is missing');
    assert.ok(/overflow-y:\s*auto/.test(m[1]), 'the section needs its own scroll region');
    assert.ok(
        /max-height:\s*\d/.test(m[1]),
        'a bare overflow-y on a column-flex child grows to fit; it needs a max-height to actually scroll'
    );
    // Enforced independently by test:contract:panel-scrollbars; restated because this
    // is the plan that was tempted to add one.
    const bare = (shellHtml.match(/(^|[^-\w.])::-webkit-scrollbar\s*\{/g) || []).length;
    assert.strictEqual(bare, 1, 'reuse the existing 6px scrollbar rules — a second bare block fails the scrollbar contract');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
