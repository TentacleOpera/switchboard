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
const terminalsHtml = fs.readFileSync(path.join(__dirname, '../webview/terminals.html'), 'utf8');
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
        ['doneStamp', 'iconUri', 'light', 'name', 'role', 'worktreePath'],
        'the relay payload must be the six metadata fields; doneStamp is a monotonic completion sequence, iconUri is a resolved same-origin SVG path, not terminal bytes'
    );
    for (const n of names) {
        assert.ok(
            ['name', 'role', 'worktreePath', 'light', 'doneStamp', 'iconUri'].includes(n),
            `relay payload field "${n}" is outside the metadata set the plan allows`
        );
    }
    // iconUri is one of 18 server-stamped same-origin SVG paths, not PTY output —
    // but it must never be an empty src (a broken-image glyph in the rail). The
    // relay must fall back to the default icon when there is no agent label.
    assert.ok(
        /const iconKey = brandIconForCliLabel\(agentLabel\) \|\| 'default'/.test(relay),
        'the relay must fall back to the default icon key when there is no agent label'
    );
    assert.ok(
        /brandIconUri\(iconKey\) \|\| brandIconUri\('default'\)/.test(relay),
        'an unresolvable key must still yield the default URI — never an empty src'
    );
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
    const fn = block(terminalsJs, 'function locateTerminal(name) {', 'function assignToFocusedPane(terminalName, opts = {}) {');
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

test('renderPaneGrid hands the caret back only when it actually took it', () => {
    // It runs on every terminalsChanged broadcast and every agentCompleted badge,
    // so without this an unrelated terminal spawning yanks the caret mid-keystroke.
    const fn = block(terminalsJs, 'function renderPaneGrid() {', 'function createPaneElement(');
    assert.ok(fn.includes('paneGridEl.contains(document.activeElement)'), 'renderPaneGrid must record whether it owned the caret');
    // The predicate is BEFORE-and-AFTER, not a bare `if (hadFocus)`. Since the grid
    // reconciles in place, most renders destroy no caret at all, so an unconditional
    // restore re-steals focus from wherever the operator just put it. The legacy form
    // must NOT be accepted here — this suite is the canary for that regression.
    assert.ok(
        fn.includes('if (hadFocus && !paneGridEl.contains(document.activeElement)) {'),
        'renderPaneGrid must restore the caret only when the reconcile displaced it'
    );
});

test('assignToFocusedPane re-relays on BOTH of its badge-clear paths', () => {
    const fn = block(terminalsJs, 'function assignToFocusedPane(terminalName, opts = {}) {', 'function undoLastAssignment() {');
    const clears = (fn.match(/terminalBadges\.delete\(/g) || []).length;
    const relays = (fn.match(/postFleetStateToShell\(\)/g) || []).length;
    assert.strictEqual(clears, 2, 'assignToFocusedPane is expected to clear a badge on exactly two paths');
    assert.strictEqual(relays, 2, 'each badge-clear path must relay, or the strip light outlives the panel badge');
});

test('the strip click peeks in-cockpit and acknowledges the badge on every branch', () => {
    // The per-terminal click handler lives in buildTerminalButton (extracted
    // from renderTerminalSection so teams mode and terminals mode share it).
    // Scope the block to that function so the team button's window.open does
    // not false-trigger the "no single-terminal window" assertion.
    const fn = block(shellJs, 'function buildTerminalButton(t, seenKeys) {', 'function requestFleetState(');
    const handler = block(fn, "btn.addEventListener('click', () => {", 'return btn;');
    // Peek replaced the pop-out: instant AND non-destructive, which is the third
    // option the old acknowledge-only comment was working around the absence of.
    assert.ok(!handler.includes('window.open('), 'the strip click must no longer open a single-terminal window');
    assert.ok(!/setTimeout\(/.test(handler), 'the 100ms failed-pop-out focus re-check must be gone');
    assert.ok(
        handler.includes("type: 'peekTerminal'"),
        'the strip click must post peekTerminal into the terminals panel'
    );
    // Panel activation is required, not optional: the strip is visible while other
    // panels are active, so a peek alone reads as a dead click.
    assert.ok(
        handler.indexOf("selectPanel('terminals')") < handler.indexOf("type: 'peekTerminal'"),
        'the panel must be switched BEFORE the peek is posted'
    );
    // An already-open solo window wins over a peek — but that branch reaches no peek
    // arm, so it must clear the badge itself or the DONE light burns forever.
    const existingBranch = block(handler, 'if (existing) {', 'selectPanel(');
    assert.ok(
        existingBranch.includes("type: 'clearTerminalBadge'"),
        'the already-open-pop-out branch must clear the badge before it returns'
    );
    assert.ok(
        existingBranch.indexOf("type: 'clearTerminalBadge'") < existingBranch.indexOf('existing.focus()'),
        'the badge clear must precede the early return, matching the focusTerminal arm ordering'
    );
});

test('the panel clears the badge on peek before any early-return', () => {
    const fn = block(terminalsJs, 'function peekTerminal(name) {', 'function wireTerminalDropTarget');
    const clearAt = fn.indexOf('terminalBadges.delete(name)');
    assert.ok(clearAt > -1, 'peekTerminal must clear the badge — it IS the acknowledgement');
    assert.ok(
        clearAt < fn.indexOf('if (index === -1) { return; }'),
        'the badge clear must precede the unseated early-return, or the DONE light survives the peek'
    );
});

test('pop-out windows stay owned by the shell, so theme fan-out keeps working', () => {
    // The pane-header control posts to the parent; the shell does the window.open and
    // adds it to popoutWindows, which applyThemeToAll iterates. Opening it from inside
    // the iframe would silently stop every pop-out following the cockpit theme.
    const arm = block(shellJs, "data.type === 'popoutTerminal'", 'popoutBlocked');
    assert.ok(arm.includes('if (event.origin !== location.origin) { return; }'), 'the popoutTerminal arm must check event.origin');
    assert.ok(arm.includes('window.open('), 'the shell performs the window.open');
    assert.ok(arm.includes('popoutWindows.add(popout)'), 'the opened window must land in popoutWindows for theme fan-out');
    assert.ok(
        /replace\(\/\[\^A-Za-z0-9_-\]\/g, '_'\)/.test(arm),
        'the incoming name is untrusted — keep the window-name slug sanitisation'
    );
    assert.ok(arm.includes('encodeURIComponent('), 'the ?solo= value stays encoded');
    assert.ok(
        !arm.includes('window.open') || arm.includes("type: 'popoutBlocked'") || shellJs.includes("type: 'popoutBlocked'"),
        'a blocked window must be reported back to the panel, not fail silently'
    );
});

test('the peek is a presentation override — it never writes layout or seating state', () => {
    for (const fn of ['function applyPeekClasses() {', 'function dismissPeek() {']) {
        const body = block(terminalsJs, fn, '\n    }');
        for (const forbidden of ['effectiveLayout =', 'currentLayout =', 'paneAssignments =', 'pinnedPanes[']) {
            assert.ok(!body.includes(forbidden), `${fn.trim()} must not assign ${forbidden}`);
        }
    }
    // Re-derived on every render, never set once: a resize mid-peek re-runs
    // applyLayoutFloor -> renderPaneGrid, and a peek asserted once evaporates.
    const floor = block(terminalsJs, 'function applyLayoutFloor(opts) {', 'Attempt schedule for the settle ladder');
    assert.ok(floor.includes('applyPeekClasses()'), 'applyLayoutFloor must re-assert the peek classes');
    const grid = block(terminalsJs, 'function applyPeekClasses() {', 'function afterPeekTransition');
    assert.ok(grid.includes('peekTerminalName'), 'the classes must be derived from peekTerminalName, the single source of truth');
});

test('Esc dismisses a peek only when the caret is not inside the peeked terminal', () => {
    const handler = block(terminalsJs, "document.addEventListener('keydown', (e) => {", '});');
    assert.ok(handler.includes("e.key !== 'Escape'"), 'the binding is on Escape');
    assert.ok(
        handler.includes('peekedPane.contains(document.activeElement)'),
        'Esc must stand down while the caret is inside the peeked pane — it is a terminal key'
    );
    assert.ok(handler.includes('dismissPeek()'), 'otherwise it dismisses');
});

test('peek is cleared when its terminal dies or is renamed', () => {
    const sanitize = block(terminalsJs, 'function sanitizePaneAssignments() {', 'function renderSidebarList() {');
    assert.ok(
        /if \(peekTerminalName && !liveNames\.has\(peekTerminalName\)\)/.test(sanitize),
        'a peeked terminal that exits must clear peekTerminalName rather than peeking a dead pane'
    );
    const rename = block(terminalsJs, 'async function renameTerminal(name, alias) {', 'The undo snapshot must follow the rename too');
    assert.ok(
        rename.includes('if (peekTerminalName === name) { peekTerminalName = next; }'),
        'peekTerminalName must be re-keyed in the same block paneAssignments is'
    );
});

test('the peek control is leftmost in the row action cluster, away from close', () => {
    const row = block(terminalsJs, "const peekBtn = document.createElement('button');", 'itemDiv.appendChild(actions);');
    const peekAt = row.indexOf('actions.appendChild(peekBtn)');
    const clearAt = row.indexOf('actions.appendChild(clearBtn)');
    assert.ok(peekAt > -1 && clearAt > -1, 'both controls are appended');
    assert.ok(peekAt < clearAt, 'peek must be leftmost — a misfire next to the destructive close is unrecoverable');
    assert.ok(!/\bconfirm\(/.test(row), 'no confirm gate — window.confirm() is a silent no-op in a webview');
});

test('the panel accepts badge messages only from its own origin', () => {
    // requestFleetState joins the guarded set: it is driven by a REAL shell postMessage
    // (shell.js requestFleetState), never by transport.js's synthetic origin-'' dispatch,
    // and it fires a ptyListTerminals round trip — so a foreign framer must not reach it.
    for (const type of ['focusTerminal', 'clearTerminalBadge', 'requestFleetState']) {
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
    const fn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
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

    const fn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
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
    const fn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
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

test('terminal state is encoded without a separate dot — exited fades, done rings, active is bare', () => {
    const exited = shellHtml.match(/\.strip-term-btn\.strip-term-exited\s+\.strip-term-icon\s*\{([^}]*)\}/);
    assert.ok(exited, '.strip-term-exited .strip-term-icon rule is missing');
    assert.ok(/grayscale\(1\)/.test(exited[1]), 'exited must desaturate the icon — the monochrome-survivable signal');
    assert.ok(/brightness\(/.test(exited[1]), 'exited must lift brightness — grayscale alone sinks the dark-fill brands into the rail');
    assert.ok(/opacity:\s*0\./.test(exited[1]), 'exited must fade the icon');

    // done is now a one-shot PULSE, not a permanent state class. The permanence
    // being removed is the whole point of the change: no bare .strip-term-done rule
    // may survive (it would ring the icon for as long as the badge holds).
    assert.ok(!/\.strip-term-btn\.strip-term-done\s*\{/.test(shellHtml),
        'no bare .strip-term-done rule may survive — the ring is now a transient notification, not a permanent state');

    const pulseKeyframes = shellHtml.match(/@keyframes strip-term-done-pulse\s*\{([\s\S]*?)\n        \}/);
    assert.ok(pulseKeyframes, '@keyframes strip-term-done-pulse must exist — the ring is a CSS animation now');
    assert.ok(/border-color:/.test(pulseKeyframes[1]) && /box-shadow:/.test(pulseKeyframes[1]),
        'the pulse keyframes must animate both border-color and box-shadow — ring AND glow, shape plus salience');
    assert.ok(/#22c55e/.test(pulseKeyframes[1]),
        'the pulse must use the hardcoded #22c55e green — the shape-not-hue rationale the old rule carried');
    assert.ok(!/var\(--accent/.test(pulseKeyframes[1]),
        'done must not borrow the accent — that is the panel-SELECTION colour in this rail, and --accent-dim is near-invisible under theme-claudify');

    const pulsingRule = shellHtml.match(/\.strip-term-btn\.strip-term-done\.is-pulsing\s*\{([^}]*)\}/);
    assert.ok(pulsingRule, '.strip-term-done.is-pulsing rule is missing — the pulse is gated on a live window class');
    assert.ok(/\b1\b/.test(pulsingRule[1]) && /both/.test(pulsingRule[1]),
        'the pulse must be a ONE-SHOT animation (iteration count 1, fill-mode both) — not an infinite loop');

    // active is the null state: no rule may fade or ring it, or it collapses into exited/done.
    assert.ok(!/\.strip-term-btn\.strip-term-active\b/.test(shellHtml),
        'active must stay unmodified — the absence of a ring/fade IS the live signal');

    // The old dot rules must be fully removed.
    assert.ok(!/\.strip-term-dot/.test(shellHtml), 'no .strip-term-dot CSS may survive — the dot is replaced by the brand icon');
    assert.ok(!/dot-active|dot-done|dot-exited/.test(shellHtml), 'no dot-* state classes may survive in shell.html');
});

test('the strip renders a coloured brand-icon img from the relayed iconUri', () => {
    const fn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
    assert.ok(
        /createElement\('img'\)[\s\S]*strip-term-icon[\s\S]*icon\.src = t\.iconUri/.test(fn),
        'the strip must render an <img class="strip-term-icon"> whose src is the relayed t.iconUri'
    );
    assert.ok(
        /strip-term-' \+ t\.light/.test(fn),
        'the button must carry a strip-term-<light> state class so CSS can encode exited/done'
    );
    assert.ok(!/strip-term-dot/.test(fn), 'the strip must no longer create a .strip-term-dot element');
    assert.ok(
        /icon\.alt = ''/.test(fn),
        "alt must be empty — the button's aria-label already carries the identity; a brand name here double-announces"
    );
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

// ------------------------------------------------------------------ strip tooltips

test('every strip button builder sets a non-empty data-tooltip', () => {
    const icon = block(shellJs, 'function buildIcon(panel) {', 'function buildThemeToggle() {');
    assert.ok(
        icon.includes('btn.dataset.tooltip = panel.label || panel.id'),
        'panel icons must tooltips from the manifest label, falling back to the id (never silently none)'
    );
    const toggle = block(shellJs, 'function buildThemeToggle() {', 'const popoutWindows');
    assert.ok(toggle.includes("btn.dataset.tooltip = 'Toggle Theme'"), 'the theme toggle must carry a tooltip');
    const section = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
    assert.ok(
        /btn\.dataset\.tooltip = t\.worktreePath \? `[^`]*labelText[^`]*\\n[^`]*` : labelText/.test(section),
        'terminal buttons must tooltip the aria text (light state included) plus the full worktreePath on a second line'
    );
});

test('the old in-flow .strip-label system is fully deleted', () => {
    // The dead hover element that only "worked" if someone removed the strip's
    // overflow is what made this bug invisible — no trace of it may survive.
    assert.ok(!shellHtml.includes('strip-label'), 'no .strip-label CSS may survive in shell.html');
    assert.ok(!shellJs.includes('strip-label'), 'no .strip-label JS may survive in shell.js');
});

test('the tooltip overlay is a direct child of body, outside the strip clip box', () => {
    // This assertion encodes the root cause: #strip and #strip-terminals both
    // clip overflow on both axes, so an overlay nested inside either is painted
    // but invisible. Re-nesting it must break the build, not the UI.
    const stripDiv = block(shellHtml, '<div id="strip"', '</div>');
    assert.ok(!stripDiv.includes('tooltip-overlay'), 'the overlay must NOT live inside #strip');
    const body = block(shellHtml, '<body>', '<script');
    // #agent-dock is a third body-level flex child between #content and the
    // overlay, so the overlay is no longer #content's immediate next sibling.
    // What must still hold is that it is not nested inside ANY clipping box:
    // #strip (above), #content, or the dock (which is overflow:hidden).
    const dockAside = shellHtml.includes('<aside id="agent-dock"')
        ? block(shellHtml, '<aside id="agent-dock"', '</aside>')
        : '';
    assert.ok(!dockAside.includes('tooltip-overlay'), 'the overlay must NOT live inside #agent-dock');
    assert.ok(
        /(?:<div id="content"><\/div>|<\/aside>)\s*<div id="tooltip-overlay"><\/div>/.test(body),
        'the overlay must be a body-level sibling of #strip, #content and #agent-dock'
    );
    const css = block(shellHtml, '#tooltip-overlay {', '}');
    assert.ok(/position:\s*fixed/.test(css), 'the overlay must be position:fixed to escape ancestor clips');
    assert.ok(/z-index:\s*9999/.test(css), 'the overlay must paint above the iframe content');
    assert.ok(/pointer-events:\s*none/.test(css), 'the overlay must never swallow clicks');
    assert.ok(/white-space:\s*pre-line/.test(css), 'the overlay must render the terminal worktreePath second line');
});

test('no strip button sets a native title tooltip', () => {
    // Native title tooltips are painted by the browser chrome, so a leftover one
    // double-fires beside the styled overlay — the asymmetry that hid this bug.
    assert.ok(!/\.title\s*=/.test(shellJs), 'shell.js must not set native title tooltips');
});

test('the overlay hides on rail scroll, click, and terminal-section rebuild', () => {
    // A position:fixed tooltip does not follow a scrolling or removed target.
    assert.ok(
        /addEventListener\('scroll',[\s\S]*?true\)/.test(shellJs),
        'scroll hide must listen in the capture phase — scroll does not bubble'
    );
    assert.ok(shellJs.includes("document.addEventListener('click', hideStripTooltip)"), 'click must hide the tooltip');
    const section = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
    const hideAt = section.indexOf('hideStripTooltip();');
    // The rebuild no longer wipes via `container.innerHTML = ''` — that would
    // destroy #strip-mission-control (a first child of the container) every 5s
    // poll. It now removes only the fleet buttons via a selective
    // `:scope > .strip-term-btn` loop. The load-bearing ordering guarantee this
    // test exists to protect is unchanged: hideStripTooltip() must still occur
    // BEFORE the button removal, or a mid-hover fleet update strands the overlay.
    // The selector now includes .strip-team-btn (team buttons share the container)
    // but the ordering guarantee is unchanged.
    const wipeAt = section.indexOf("querySelectorAll(':scope > .strip-term-btn");
    assert.ok(hideAt !== -1 && wipeAt !== -1 && hideAt < wipeAt,
        'the section must hide the tooltip BEFORE removing the fleet buttons, or a mid-hover fleet update strands it');
});

test('the Setup icon is placed in the bottom rail cluster', () => {
    const manifestSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'headlessPanelHtml.ts'), 'utf8');
    // Line-scoped, not `[^}]*`: the entry interpolates `${iconDir}`, so a brace-
    // excluding class can never reach the end of the row it is meant to match.
    assert.ok(/\{\s*id:\s*'setup',[^\n]*placement:\s*'bottom'/.test(manifestSrc),
        "the setup manifest entry must carry placement: 'bottom'");
    const shellSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'shell.js'), 'utf8');
    // Ordering is the whole point: bottom icons must be appended after the top
    // group and BEFORE the theme toggle, so the whole cluster sits at the foot of
    // the rail.
    assert.ok(shellSrc.indexOf('bottomPanels.push(icon)') !== -1, 'placement must be honoured in renderManifest');
    assert.ok(shellSrc.indexOf('for (const icon of bottomPanels)') < shellSrc.indexOf('const themeBtn = buildThemeToggle()'),
        'bottom icons must be appended before the theme toggle');
});

test('the bottom anchor is reconciled onto the FIRST cluster member, not just the toggle', () => {
    // DOM order alone does not move an icon to the bottom: the free space collapses
    // into whichever child holds the auto top margin, and everything before that
    // child stays packed with the top group. So appending Setup ahead of
    // #strip-terminals / the toggle leaves it under the workspace panels with the
    // gap BELOW it — the exact defect this cluster exists to avoid.
    const fn = block(shellJs, 'function applyBottomAnchor() {', 'function renderTerminalSection(terminals, teams) {');
    assert.ok(
        fn.includes(".strip-placement-bottom'"),
        'the reconciler must consider placement icons as cluster members'
    );
    assert.ok(
        /const first = members\[0\]/.test(fn),
        'the anchor belongs to the FIRST member — anything earlier is not "at the bottom"'
    );
    assert.ok(
        /container\.style\.marginTop = '0'/.test(fn),
        "#strip-terminals owns the anchor in CSS; it must be neutralised inline when something precedes it, or the free space splits"
    );
    // Both composition changes must reconcile: Terminals present (container created)
    // and Terminals absent (container removed, toggle takes the inline default).
    const section = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
    assert.strictEqual(
        (section.match(/applyBottomAnchor\(\)/g) || []).length, 2,
        'both branches of renderTerminalSection must reconcile the anchor'
    );
});

// ------------------------------------------------------ fleet-state presence recovery

test('fetchTerminalList relays on its FAILURE path, not only on success', () => {
    // The reported bug: a transient ptyListTerminals failure left the rail dark because
    // the catch/fall-through path never pushed. Relaying the STALE fleetList there is
    // deliberate — stale terminals beat no terminals, and the next poll corrects it.
    const fn = block(terminalsJs, 'async function fetchTerminalList() {', 'function checkSoloNotFound() {');
    const relays = (fn.match(/postFleetStateToShell\(\)/g) || []).length;
    assert.strictEqual(relays, 2,
        'fetchTerminalList must relay on BOTH exit paths — the success return AND the failure fall-through');
    const tail = fn.slice(fn.indexOf('} catch (err) {'));
    assert.ok(/postFleetStateToShell\(\)/.test(tail),
        'the relay must sit on the post-catch fall-through, which is the path a network error / non-OK / non-array payload all reach');
});

test('the shell can request fleet state instead of only waiting to be pushed', () => {
    // Without a pull path the rail depends entirely on the iframe's one-directional
    // push; a push lost before the shell's listener was ready left it empty forever.
    assert.ok(
        /termFrame\.contentWindow\.postMessage\(\{ type: 'requestFleetState' \}, location\.origin\)/.test(shellJs),
        'shell.js must post requestFleetState to the terminals frame, targeted at its own origin'
    );
    const manifest = block(shellJs, 'function renderManifest(manifest) {', 'function loadManifest() {');
    assert.ok(
        /addEventListener\('load'[\s\S]*requestFleetState/.test(manifest),
        'the request must be armed off the terminals iframe load event — attached synchronously in renderManifest, so the event cannot be missed'
    );
    const arm = block(terminalsJs, "message.type === 'requestFleetState'", '} else if');
    assert.ok(
        /postFleetStateToShell\(\);/.test(arm),
        'the panel must answer requestFleetState by relaying immediately — a fresh fetch alone re-opens the dark window it exists to close'
    );
});

// -------------------------------------------------- completion ring pulse lifecycle

test('the relay sources doneStamp from the badge value, not a parallel Map', () => {
    // A parallel stamp Map would have seven delete sites to keep in sync with
    // terminalBadges; folding the stamp into the value makes it impossible to leak.
    const relay = block(terminalsJs, 'function postFleetStateToShell() {', 'const LAYOUTS = {');
    assert.ok(
        /doneStamp = terminalBadges\.get\(t\.friendlyName\)\.stamp/.test(relay),
        'doneStamp must be read from the badge value (.stamp), so a badge delete cannot leave a stamp behind'
    );
});

test('handleAgentCompleted writes a strictly increasing stamp inside the badge set', () => {
    const handler = block(terminalsJs, 'function handleAgentCompleted(msg) {', 'function showCompletionToast(');
    assert.ok(
        /terminalBadges\.set\([^,]+,\s*\{\s*label:\s*'DONE',\s*stamp:\s*\+\+badgeStampSeq\s*\}\)/.test(handler),
        'handleAgentCompleted must write { label: \'DONE\', stamp: ++badgeStampSeq } — a second completion of an already-badged terminal re-pulses'
    );
    assert.ok(
        terminalsJs.includes('let badgeStampSeq = 0;'),
        'badgeStampSeq must be declared as a module-level counter so ++ is monotonic across completions'
    );
});

test('renderTerminalSection pulses once per stamp and resumes across rebuilds', () => {
    const fn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
    // The stamp gate: a new stamp arms the pulse; a repeated stamp does not re-arm.
    assert.ok(
        /prev\.stamp !== t\.doneStamp/.test(fn),
        'the pulse must be armed only when the incoming doneStamp differs from the last recorded one — a stamp gate, not a boolean'
    );
    // The elapsed guard: STRICTLY less than. An offset that reaches the duration
    // lands the element on its 100% keyframe under fill-mode both, flashing green
    // on an already-expired completion.
    assert.ok(
        /elapsed < DONE_PULSE_MS/.test(fn),
        'the elapsed guard must be STRICTLY less than DONE_PULSE_MS — never <=, or an expired completion flashes its end keyframe'
    );
    // The resume: a negative animation-delay picks up where the destroyed predecessor
    // was killed. Without this the pulse is truncated by the next rebuild.
    assert.ok(
        /animationDelay\s*=\s*'-' \+ Math\.floor\(pulseElapsed\)/.test(fn),
        'a rebuilt element must carry a negative animation-delay equal to the elapsed time — resume, do not restart'
    );
    // FLOOR, not round. The elapsed guard admits values strictly below DONE_PULSE_MS,
    // but Math.round(2199.6) === 2200 hands the animation a delay whose magnitude
    // EQUALS the duration — the post-active phase, where fill-mode `both` paints the
    // 100% keyframe for a frame. Rounding silently defeats the strict comparison above.
    assert.ok(
        !/Math\.round\(pulseElapsed\)/.test(fn),
        'the resume offset must be floored, never rounded — rounding can reach DONE_PULSE_MS and flash the end keyframe'
    );
});

test('both early-return branches of renderTerminalSection clear the pulse ledger', () => {
    const fn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
    const clears = (fn.match(/pulsedDoneStamps\.clear\(\)/g) || []).length;
    assert.ok(clears >= 2,
        'both early-return branches (no terminals frame, empty fleet) must clear the ledger, or it retains entries for a fleet that went to zero');
});

test('a visibilitychange to visible clears the pulse ledger', () => {
    assert.ok(
        /document\.addEventListener\('visibilitychange'[\s\S]*visibilityState === 'visible'[\s\S]*pulsedDoneStamps\.clear\(\)/.test(shellJs),
        'returning to a visible tab must clear the ledger so a completion missed in a background tab is re-announced exactly once'
    );
});

test('DONE_PULSE_MS equals the CSS animation duration', () => {
    const msMatch = shellJs.match(/const DONE_PULSE_MS = (\d+)/);
    assert.ok(msMatch, 'DONE_PULSE_MS must be declared in shell.js');
    const ms = parseInt(msMatch[1], 10);
    const durMatch = shellHtml.match(/animation:\s*strip-term-done-pulse\s+([\d.]+)s/);
    assert.ok(durMatch, 'the pulse animation duration must be declared in shell.html');
    const seconds = parseFloat(durMatch[1]);
    assert.strictEqual(
        seconds * 1000, ms,
        `DONE_PULSE_MS (${ms}) must equal the CSS duration (${seconds * 1000}) — two files, one number, nothing else keeps them honest`
    );
});

test('the reduced-motion variant overrides animation-name only, with a distinct keyframes name', () => {
    assert.ok(
        /@keyframes strip-term-done-pulse-reduced\s*\{/.test(shellHtml),
        '@keyframes strip-term-done-pulse-reduced must exist — a distinct name, not a second same-named declaration'
    );
    // Select the reduced-motion block by CONTENT, not by position. A bare
    // `.match` (no /g) returns the FIRST @media block in the file, which is a
    // silent-wrong-assertion hazard: a second reduced-motion block added
    // elsewhere (e.g. the Mission Control icon's own guard) would either break
    // this test for an unrelated reason or — worse — pass while checking the
    // wrong block. Collect ALL reduced-motion blocks and select the one whose
    // body contains `strip-term-done-pulse-reduced` — that is the block this
    // test means. A second reduced-motion block elsewhere is harmless.
    const allMedia = [...shellHtml.matchAll(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}\s*\}/g)];
    assert.ok(allMedia.length > 0, 'at least one prefers-reduced-motion media block must exist');
    const media = allMedia.find(m => /strip-term-done-pulse-reduced/.test(m[1]));
    assert.ok(media, 'a prefers-reduced-motion media block containing strip-term-done-pulse-reduced must exist');
    assert.ok(/animation-name:\s*strip-term-done-pulse-reduced/.test(media[1]),
        'the reduced-motion variant must override animation-name only — duration, iteration count and fill-mode are inherited');
    // No second same-named @keyframes inside the media query (the rejected approach).
    const reducedBlock = media[1];
    // `\s*\{`, not `\b`: a word boundary sits between "pulse" and "-reduced", so `\b`
    // would also flag the legitimate case of the -reduced track being moved inside the
    // media query. Only a same-NAMED re-declaration is the hazard.
    assert.ok(!/@keyframes strip-term-done-pulse\s*\{/.test(reducedBlock),
        'the media query must NOT re-declare @keyframes strip-term-done-pulse — a second same-named block is invisible to this test and reorder-unsafe');
});

// ---------------------------------------------- Mission Control rail icon (UFO)

test('the Mission Control icon is created and inserted as the first child of #strip-terminals', () => {
    // The UFO button must sit at the top of the fleet container, above the
    // terminal buttons, and carry the id the rest of the file keys off.
    const fn = block(shellJs, 'function createMissionControlIcon() {', 'function ensureMissionControlIcon() {');
    assert.ok(/btn\.id\s*=\s*'strip-mission-control'/.test(fn),
        'createMissionControlIcon must stamp id="strip-mission-control" on the button');
    assert.ok(/container\.insertBefore\(btn,\s*container\.firstChild\)/.test(fn),
        'the Mission Control button must be inserted as the FIRST child of #strip-terminals, not appended');
});

test('the Mission Control icon is an inline <svg>, not an <img> with a /static/icons/ src', () => {
    // The SVG is inlined into the shell document so shell.html's CSS can select
    // into its sub-elements (.light-a/.light-b for the dimmed freeze and the
    // reduced-motion guard). An <img src="/static/icons/mission-control-ufo.svg">
    // would be a separate document and those rules would be inert.
    const fn = block(shellJs, 'function createMissionControlIcon() {', 'function ensureMissionControlIcon() {');
    assert.ok(/<svg[^>]*aria-hidden="true"/.test(fn),
        'the icon must be an inline <svg> with aria-hidden="true" (no double-announce beside the button aria-label)');
    assert.ok(/class="strip-mc-icon"/.test(fn),
        'the inline <svg> must carry the .strip-mc-icon class (sizing + pointer-events:none)');
    assert.ok(!/mission-control-ufo\.svg/.test(fn),
        'the icon must NOT reference /static/icons/mission-control-ufo.svg — the SVG is inlined, the file is deleted');
    assert.ok(!/createElement\('img'\)/.test(fn),
        'createMissionControlIcon must not create an <img> — the SVG is inlined via innerHTML');
    // ids must be prefixed to avoid document-wide collisions now that they are global.
    assert.ok(/sb-mc-cyan-glow/.test(fn) && /sb-mc-beam/.test(fn),
        'inlined SVG ids must be prefixed (sb-mc-*) to avoid collisions in the shell document');
    assert.ok(/url\(#sb-mc-cyan-glow\)/.test(fn) && /url\(#sb-mc-beam\)/.test(fn),
        'url(#...) references must match the prefixed ids');
    // Class names on sub-elements must be kept — shell.html selectors depend on them.
    assert.ok(/class="light-a"/.test(fn) && /class="light-b"/.test(fn),
        'the inlined SVG must keep .light-a/.light-b class names — shell.html animation rules depend on them');
});

test('lit-click navigates (no /mission-control/stop) and dimmed-click posts /mission-control/start', () => {
    // The rail button is navigational — every other button in #strip-terminals
    // navigates (team → selectPanel + switchToTeam, ungrouped → focus/peek), so
    // the lit Mission Control click reveals the controller terminal rather than
    // ending the session. The end-session control moved to the controller's
    // own scoped ops block (#btn-controller-stop in terminals.html), where it
    // can carry a label — the rail icon cannot. The singleton guard in
    // ptyFleetService.create() is the duplicate-controller protection now, not
    // a client flag or a stop-on-lit-click.
    const fn = block(shellJs, 'function createMissionControlIcon() {', 'function ensureMissionControlIcon() {');
    assert.ok(/missionControlActive\)/.test(fn),
        'the click handler must branch on missionControlActive (lit vs dimmed)');
    // Lit path must NOT post /mission-control/stop — it navigates instead.
    assert.ok(!/fetch\('\/mission-control\/stop'/.test(fn),
        'the lit-click path must NOT POST /mission-control/stop — the rail button is navigational');
    assert.ok(/selectPanel\('terminals'\)/.test(fn),
        "the lit-click path must navigate via selectPanel('terminals')");
    assert.ok(/switchToController/.test(fn),
        'the lit-click path must post switchToController to the terminals panel');
    assert.ok(/fetch\('\/mission-control\/start'/.test(fn),
        'the dimmed-click path must POST /mission-control/start');
});

test('the dimmed-click response branches on result.mode (terminal vs clipboard)', () => {
    // The server decides the path; the shell must branch on `mode` so a
    // clipboard result (no agent configured) does not toast "check the
    // Mission Control terminal" for a terminal that was never created.
    const fn = block(shellJs, 'function createMissionControlIcon() {', 'function ensureMissionControlIcon() {');
    assert.ok(/result\.success\s*&&\s*result\.mode\s*===\s*'terminal'/.test(fn),
        "the dimmed-click handler must branch on result.mode === 'terminal'");
    assert.ok(/result\.success\s*&&\s*result\.mode\s*===\s*'clipboard'/.test(fn),
        "the dimmed-click handler must branch on result.mode === 'clipboard'");
});

test('the dimmed-click in-flight flag is a UI affordance, not the duplicate guard', () => {
    // The duplicate-controller guard now lives in ptyFleetService.create(),
    // which consults the singleton identity before the collision loop and
    // returns the existing live handle rather than minting mission-control-2.
    // The client-side missionControlStartInFlight flag is demoted to a UI
    // affordance: it disables the button while a start fetch is pending so a
    // double-click does not fire two fetches — a UX nicety, not a correctness
    // gate. The old comment said "the server seat guard cannot help here";
    // the service guard CAN help now, which is why the flag is no longer the
    // protection.
    const fn = block(shellJs, 'function createMissionControlIcon() {', 'function ensureMissionControlIcon() {');
    assert.ok(/missionControlStartInFlight/.test(fn),
        'the dimmed-click handler must still check the missionControlStartInFlight flag (UI affordance)');
    assert.ok(/if\s*\(missionControlStartInFlight\)\s*\{\s*return;\s*\}/.test(fn),
        'a second click while a start fetch is pending must be a silent no-op (UI disable)');
    assert.ok(/btn\.disabled\s*=\s*true/.test(fn),
        'the button must be disabled while a start fetch is pending (UI affordance, not just a guard)');
    assert.ok(/\.finally\(/.test(fn),
        'the in-flight flag and disabled state must be cleared in both success and failure paths (via .finally)');
});

test('the Mission Control icon is ensured to exist independently of an missionControlState message', () => {
    // CRITICAL 1 regression guard: renderMissionControlIcon is the only OTHER
    // creator and it only runs when an 'missionControlState' postMessage arrives.
    // On a cold load with no autoban state change, NO icon would exist and the
    // start control would be unreachable. ensureMissionControlIcon() must be
    // called (a) once during shell init after the rail/manifest is built, and
    // (b) at the END of renderTerminalSection in BOTH branches — including the
    // early-return !frames.has('terminals') branch, which removes the container
    // (and the icon with it). renderMissionControlIcon itself must NOT create —
    // it only updates classes/tooltip on an icon that already exists.
    assert.ok(/function ensureMissionControlIcon\(\)\s*\{/.test(shellJs),
        'ensureMissionControlIcon() must be declared');
    assert.ok(/getElementById\('strip-mission-control'\)\)\s*\{\s*return;\s*\}/.test(shellJs),
        'ensureMissionControlIcon() must be a no-op when the icon already exists (idempotent)');
    // renderMissionControlIcon must NOT call createMissionControlIcon — it only updates.
    const render = block(shellJs, 'function renderMissionControlIcon(state) {', "// Delegation via mouseover/mouseout");
    assert.ok(!/createMissionControlIcon\(\)/.test(render),
        'renderMissionControlIcon must NOT create the icon — ensureMissionControlIcon() owns creation, or the cold-load gap returns');
    // Init call: after renderTerminalSection([]) in renderManifest.
    const manifest = block(shellJs, 'function renderManifest(manifest) {', 'function loadManifest() {');
    assert.ok(/renderTerminalSection\(\[\]\);[\s\S]*?ensureMissionControlIcon\(\)/.test(manifest),
        'renderManifest must call ensureMissionControlIcon() after the initial renderTerminalSection([])');
    // Both branches of renderTerminalSection must call ensureMissionControlIcon().
    const section = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
    const ensures = (section.match(/ensureMissionControlIcon\(\)/g) || []).length;
    assert.strictEqual(ensures, 2,
        'renderTerminalSection must call ensureMissionControlIcon() in BOTH branches (early-return and normal exit) — the early-return removes the container and takes the icon with it');
});

// ---------------------------------------------- UAT: shell strip team icons

test('the rail mode toggle is fully removed', () => {
    assert.ok(!/ensureRailModeToggle/.test(shellJs), 'ensureRailModeToggle must not survive in shell.js');
    assert.ok(!/updateRailModeIcon/.test(shellJs), 'updateRailModeIcon must not survive in shell.js');
    assert.ok(!/railMode/.test(shellJs), 'the railMode variable must not survive in shell.js');
    assert.ok(!/sb-rail-mode/.test(shellJs), 'the sb-rail-mode localStorage key must not survive in shell.js');
    assert.ok(!/strip-rail-mode/.test(shellHtml), 'the .strip-rail-mode-btn CSS must not survive in shell.html');
});

test('the member-count badge is fully removed', () => {
    assert.ok(!/strip-team-count/.test(shellJs), 'the .strip-team-count badge must not survive in shell.js');
    assert.ok(!/strip-team-count/.test(shellHtml), 'the .strip-team-count CSS must not survive in shell.html');
});

test('the team button tooltip is just the team name', () => {
    const fn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
    // The team button must set aria-label and data-tooltip to team.name only —
    // no member count, no roster, no light state in the tooltip.
    assert.ok(
        /btn\.setAttribute\('aria-label', team\.name\)/.test(fn),
        'the team button aria-label must be just team.name'
    );
    assert.ok(
        /btn\.dataset\.tooltip = team\.name/.test(fn),
        'the team button data-tooltip must be just team.name'
    );
    // The verbose labelText and roster constructions must be gone — the
    // memberCount variable was only used for the badge and the verbose label.
    assert.ok(!/memberCount/.test(fn), 'the memberCount variable must not survive — it was only used for the badge and verbose tooltip');
    assert.ok(!/roster/.test(fn), 'the roster tooltip construction must not survive');
});

test('the team icon fallback skips the head brand mark', () => {
    const fn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
    // When team.iconUri is empty, the shell must go straight to the role letter
    // glyph — the headTerm.iconUri arm (brand mark) must be gone.
    const iconBlock = block(fn, 'if (team.iconUri) {', 'Queue-depth badge');
    assert.ok(
        !/headTerm\.iconUri/.test(iconBlock),
        'the head brand-mark fallback arm must not survive — a team with no icon shows the role letter'
    );
    assert.ok(
        /glyph\.textContent = roleChar/.test(iconBlock),
        'the role letter glyph must be the fallback when there is no team icon'
    );
});

test('buildTeamsForShell does not fall back to the head brand mark', () => {
    const fn = block(terminalsJs, 'function buildTeamsForShell() {', 'function relayMissionControlStateToShell');
    // The brand-mark fallback block must be gone — the relay sends iconUri or
    // empty string, and the shell handles the empty case with the role letter.
    assert.ok(
        !/brandIconForCliLabel\(headAgentLabel\)/.test(fn),
        'buildTeamsForShell must not resolve the head brand mark as a team icon fallback'
    );
    assert.ok(
        /iconUri: iconUri \|\| ''/.test(fn),
        "buildTeamsForShell must send iconUri: iconUri || '' — the team icon or empty string, never the brand mark"
    );
});

test('the team button click posts switchToTeam, not window.open', () => {
    const fn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
    // Scope to the team button click handler — the btn.addEventListener inside
    // the team loop, before the ungrouped-terminals loop.
    const teamHandler = block(fn, "btn.addEventListener('click', () => {", 'container.appendChild(btn);');
    assert.ok(
        teamHandler.includes("type: 'switchToTeam'"),
        'the team button click must post a switchToTeam message to the terminals panel'
    );
    assert.ok(
        !teamHandler.includes('window.open('),
        'the team button click must NOT open a pop-out window — in-place navigation only'
    );
    assert.ok(
        teamHandler.includes("selectPanel('terminals')"),
        'the team button click must switch to the terminals panel before posting switchToTeam'
    );
    // The clearTeamBadges relay must survive — clicking a done team still
    // acknowledges the completion.
    assert.ok(
        teamHandler.includes("type: 'clearTeamBadges'"),
        'the clearTeamBadges relay must survive the click handler rewrite'
    );
});

test('the popoutTeam message handler is removed from the shell', () => {
    assert.ok(
        !/data\.type === 'popoutTeam'/.test(shellJs),
        "the popoutTeam message handler must not survive — the team click no longer sends popoutTeam"
    );
});

test('ungrouped terminals render as .strip-term-btn via buildTerminalButton', () => {
    const fn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
    // The ungrouped-terminal loop must call buildTerminalButton (which stamps
    // .strip-term-btn), not create a .strip-team-btn. A terminal not claimed
    // by any team is a per-terminal button, not a team button.
    assert.ok(
        /for \(const t of terminals\) \{[\s\S]*claimedNames\.has\(t\.name\)[\s\S]*buildTerminalButton\(t, seenKeys\)/.test(fn),
        'ungrouped terminals must be rendered via buildTerminalButton, not as team buttons'
    );
    // The legacy terminals-mode else branch must be gone — teams mode is the
    // only mode.
    assert.ok(
        !/Terminals mode \(legacy\)/.test(fn),
        'the legacy terminals-mode else branch must not survive — teams mode is the only mode'
    );
});

test('terminals.js has a switchToTeam message handler with an origin guard', () => {
    const arm = block(terminalsJs, "message.type === 'switchToTeam'", '} else if');
    assert.ok(
        arm.includes('if (event.origin !== location.origin) { return; }'),
        'the switchToTeam arm must check event.origin — same guard as every other shell-driven arm'
    );
    assert.ok(
        /enterTeamScope\(message\.groupId\)/.test(arm),
        'the switchToTeam arm must call enterTeamScope with the groupId'
    );
});

test('enterTeamScope sets teamScopeId before calling switchToGroup', () => {
    const fn = block(terminalsJs, 'function enterTeamScope(groupId) {', 'function exitTeamScope(');
    // The guard at switchToGroup (teamScopeId && id !== teamScopeId) means
    // teamScopeId MUST be set before switchToGroup is called, or the guard
    // rejects the switch.
    const scopeAt = fn.indexOf('teamScopeId = groupId');
    const switchAt = fn.indexOf('switchToGroup(groupId)');
    assert.ok(scopeAt !== -1, 'enterTeamScope must set teamScopeId');
    assert.ok(switchAt !== -1, 'enterTeamScope must call switchToGroup');
    assert.ok(scopeAt < switchAt, 'teamScopeId must be set BEFORE switchToGroup — the guard rejects otherwise');
    assert.ok(
        fn.includes("document.body.classList.add('is-team-scoped')"),
        'enterTeamScope must add the is-team-scoped body class'
    );
    assert.ok(
        /isSpawnedTeamGroup\(group\)/.test(fn),
        'enterTeamScope must verify the group is a spawned team before entering scope'
    );
});

test('exitTeamScope clears all team-scoped state and re-renders the fleet', () => {
    const fn = block(terminalsJs, 'function exitTeamScope() {', 'function scopedFleet(');
    assert.ok(
        /teamScopeId = null/.test(fn),
        'exitTeamScope must clear teamScopeId'
    );
    assert.ok(
        fn.includes("document.body.classList.remove('is-team-scoped')"),
        'exitTeamScope must remove the is-team-scoped body class'
    );
    assert.ok(
        /activeGroupId = null/.test(fn),
        'exitTeamScope must clear the group lock'
    );
    assert.ok(
        /setLayoutMode\(layoutForFleetCount/.test(fn),
        'exitTeamScope must reset the layout to a fleet-count-appropriate mode'
    );
    assert.ok(
        fn.includes('renderSidebarList()') && fn.includes('renderPaneGrid()'),
        'exitTeamScope must re-render the sidebar and pane grid'
    );
});

test('the team header is a context bar — the exit affordance lives in the tab strip', () => {
    // The header used to own the "← ALL TERMINALS" button because the tab strip
    // was hidden in team-scoped mode. The strip is visible now and carries a
    // "← All" tab, so a second exit control in the header would be two
    // affordances for one verb, sitting one row apart.
    const fn = block(terminalsJs, 'function renderTeamHeader() {', 'function fetchTeamQueue');
    assert.ok(
        !/team-header-back/.test(fn),
        'renderTeamHeader must NOT create a back button — the "← All" tab in the strip exits team scope'
    );
    assert.ok(
        !/exitTeamScope/.test(fn),
        'renderTeamHeader must not call exitTeamScope — that is the tab strip\'s job now'
    );
    // It is still a header: icon area, name, live counts.
    assert.ok(fn.includes('header.appendChild(iconArea)'), 'the header must still render its icon area');
    assert.ok(fn.includes('team-header-count'), 'the header must still render the member counts');

    // The exit control is in the strip, and it is the FIRST thing in the row.
    const strip = block(terminalsJs, 'function renderGroupTabStrip() {', 'function terminalNameSuffix(');
    assert.ok(
        /exitTeamScope\(\)/.test(strip),
        'renderGroupTabStrip must wire the "← All" tab to exitTeamScope'
    );
    const allAt = strip.indexOf("'← All'");
    const rowAppendAt = strip.indexOf('tabRow.appendChild(allTab)');
    assert.ok(allAt !== -1, 'the strip must label the exit tab "← All"');
    assert.ok(rowAppendAt !== -1 && allAt < rowAppendAt, 'the "← All" tab must be appended to the tab row');
});

test('team-scoped CSS hides general-purpose sidebar buttons', () => {
    for (const id of ['#btn-start-all-teams', '#btn-fill-grid', '#fill-grid-form', '#btn-start-team', '#start-team-form', '#btn-clear-all', '#btn-save-group', '#btn-link-up']) {
        assert.ok(
            new RegExp(`body\\.is-team-scoped\\s+${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(terminalsHtml),
            `team-scoped CSS must hide ${id}`
        );
    }
    // The team-relevant controls must NOT be hidden by the CSS — they are
    // shown/hidden by renderSidebarList based on teamScopeId.
    assert.ok(
        !/body\.is-team-scoped\s+#btn-team-orders/.test(terminalsHtml),
        'team-scoped CSS must NOT hide #btn-team-orders — it is team-relevant'
    );
    assert.ok(
        !/body\.is-team-scoped\s+#btn-team-automations/.test(terminalsHtml),
        'team-scoped CSS must NOT hide #btn-team-automations — it is team-relevant'
    );
});

test('the team-header-back CSS died with the button it styled', () => {
    // Orphaned selectors are the residue this repo keeps tripping over: the
    // rule stays green in every gate while nothing on screen wears it.
    assert.ok(!/\.team-header-back\s*\{/.test(terminalsHtml), '.team-header-back CSS must be deleted — no element carries the class');
    assert.ok(!/\.team-header-back:hover\s*\{/.test(terminalsHtml), '.team-header-back:hover CSS must be deleted');
    // The header itself still needs its own row treatment below the tab row.
    const header = block(terminalsHtml, '.team-header {', '.team-header-icon {');
    assert.ok(/border-top:\s*1px solid var\(--border-color\)/.test(header),
        '.team-header must carry a border-top — it is now a second row under the tab row');
});

// ------------------------------- UAT: the team action bar lives in the sidebar

test('the team action verbs are static sidebar buttons, not a header strip', () => {
    // The action bar was a horizontal strip on top of the team header. The
    // intent was always that team controls TAKE THE PLACE of the generic fleet
    // buttons, so they are static `.sidebar-ops` buttons shown by teamScopeId —
    // the same pattern #btn-team-orders already used.
    const expected = [
        ['btn-team-clear', 'CLEAR ALL CONTEXTS'],
        ['btn-team-clear-members', 'CLEAR MEMBERS (KEEP HEAD)'],
        ['btn-team-close', 'STOP ALL TERMINALS'],
        ['btn-team-restart', 'RESTART EXITED MEMBERS'],
        ['btn-team-ack', 'RELEASE'],
        ['btn-team-add', 'ADD TERMINAL'],
        ['btn-team-automations', 'SCHEDULED AUTOMATIONS'],
        ['btn-team-orders', 'STANDING ORDERS']
    ];
    const ops = block(terminalsHtml, '<div class="sidebar-ops">', '<div id="terminals-list"');
    for (const [id, label] of expected) {
        assert.ok(
            new RegExp(`id="${id}"[\\s\\S]*?>${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`).test(ops),
            `#${id} must be a .sidebar-ops button labelled "${label}"`
        );
    }
    // Every relocated button starts hidden — the fleet view must not grow six
    // team-only controls.
    for (const [id] of expected) {
        assert.ok(
            new RegExp(`id="${id}"[\\s\\S]*?hidden`).test(ops),
            `#${id} must be hidden by default and shown only in team-scoped mode`
        );
    }
});

test('the old header action bar and its abbreviated buttons are gone', () => {
    const fn = block(terminalsJs, 'function renderTeamHeader() {', 'function fetchTeamQueue');
    for (const gone of ['mkActionBtn', 'team-action-bar', "'ORDERS'", "'AUTOS'", 'CLEAR BADGES', 'RESTART MISSING', 'CLOSE TEAM']) {
        assert.ok(
            !fn.includes(gone),
            `renderTeamHeader must not still build "${gone}" — the verbs moved to the sidebar and were renamed`
        );
    }
    // The dead styles must go with the elements, or the next reader thinks a
    // header action bar is still a thing.
    assert.ok(
        !/\.team-action-b(ar|tn)|\.team-header-add|\.team-header-orders/.test(terminalsHtml),
        'the header action-bar / add / orders CSS must not outlive the elements it styled'
    );
});

test('every relocated sidebar button is wired and toggled by teamScopeId', () => {
    const ids = ['btn-team-clear', 'btn-team-clear-members', 'btn-team-close', 'btn-team-restart', 'btn-team-ack', 'btn-team-add'];
    const wiring = block(terminalsJs, 'function wireTeamActionBar()', 'let currentTeamAutosTeamId');
    for (const id of ids) {
        assert.ok(
            wiring.includes(`getElementById('${id}')`),
            `#${id} must get a click handler at init — a static button nothing listens to is a dead control`
        );
    }
    const sidebar = block(terminalsJs, 'function renderSidebarList()', 'function renderPaneGrid()');
    for (const id of ids) {
        assert.ok(
            new RegExp(`getElementById\\('${id}'\\)`).test(sidebar),
            `#${id} must be shown/hidden by renderSidebarList based on teamScopeId`
        );
    }
    // RESTART EXITED MEMBERS carries a dynamic disabled state that moved out of
    // renderTeamHeader with it.
    assert.ok(
        /btnTeamRestart\.disabled = !hasDefinition/.test(sidebar),
        'the RESTART disabled state must be re-evaluated in renderSidebarList — it moved out of renderTeamHeader'
    );
});

test('entering and leaving team scope re-reads the settings for that scope', () => {
    // mapSettingKey prefixes the layout-family keys with
    // `terminals.team.<groupId>.` whenever teamScopeId is set. In-place scope
    // switching therefore has to reload on BOTH edges: entering without a load
    // lets switchToGroup's saveLayoutSettings() stamp the fleet's layout over
    // the team's, and leaving without one lets the team's layout be written
    // back over the fleet's.
    const enter = block(terminalsJs, 'async function enterTeamScope(groupId) {', 'async function exitTeamScope()');
    const scopeAt = enter.indexOf('teamScopeId = groupId');
    const loadAt = enter.indexOf('await loadLayoutSettings()');
    const switchAt = enter.indexOf('switchToGroup(groupId)');
    assert.ok(loadAt !== -1, 'enterTeamScope must reload the layout settings under the new scope');
    assert.ok(scopeAt < loadAt && loadAt < switchAt,
        'the load must sit between setting teamScopeId and switchToGroup — before the scope is set it reads the fleet keys, after switchToGroup it is too late');
    assert.ok(
        enter.includes('getScopedTeamGroup()') && enter.includes('queueMode'),
        'enterTeamScope must read the Manual/Auto toggle from the group record — in-place entry is the only entry path left'
    );

    const exit = block(terminalsJs, 'async function exitTeamScope()', 'function scopedFleet(');
    const clearAt = exit.indexOf('teamScopeId = null');
    const exitLoadAt = exit.indexOf('await loadLayoutSettings()');
    assert.ok(exitLoadAt !== -1, "exitTeamScope must reload the fleet's own layout settings");
    assert.ok(clearAt < exitLoadAt, 'the scope must be cleared before the load, or it re-reads the team keys');
    // Comments stripped: the body explains in prose why the call is gone, and
    // the assertion is about executable statements, not the explanation.
    const exitCode = exit.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(
        !/seatActiveGroupPage\(\)/.test(exitCode),
        'exitTeamScope must not call seatActiveGroupPage — activeGroupId is null by then, so it early-returns and never reseats'
    );
});

// ------------------------- UAT: team tab unification (one strip, both modes)

test('the tab strip no longer early-returns in team-scoped mode', () => {
    const strip = block(terminalsJs, 'function renderGroupTabStrip() {', 'function terminalNameSuffix(');
    const guard = strip.split('\n')[1];
    assert.ok(
        /if \(!groupTabStripEl \|\| soloTerminalName\) \{ return false; \}/.test(guard),
        'the guard must be groupTabStripEl + soloTerminalName only'
    );
    assert.ok(
        !/teamScopeId/.test(guard),
        'teamScopeId must NOT be in the early-return guard — the strip renders in team-scoped mode too'
    );
    assert.ok(
        /const inTeamScope = !!teamScopeId;/.test(strip),
        'the strip must branch internally on an inTeamScope flag'
    );
});

test('in team-scoped mode the strip renders "← All" plus team tabs only', () => {
    const strip = block(terminalsJs, 'function renderGroupTabStrip() {', 'function terminalNameSuffix(');
    const teamBranch = block(strip, 'if (inTeamScope) {', '} else {');
    assert.ok(
        /getAllGroups\(\)\.filter\(g => isSpawnedTeamGroup\(g\)\)/.test(teamBranch),
        'the team-scoped branch must show spawned team groups only — regular groups belong to the fleet view'
    );
    assert.ok(
        !/group-tab-delete/.test(teamBranch),
        'team tabs carry no delete button — teams are managed from the team view'
    );
    assert.ok(
        !/group-tab-add/.test(teamBranch),
        'team-scoped mode has no "+" tab — it has its own Add Terminal sidebar button'
    );
    // No "+" means addBtn stays null, so every later reference has to tolerate it.
    assert.ok(
        /const addBtnWidth = addBtn \? addBtn\.offsetWidth : 0;/.test(strip),
        'the overflow measurement must tolerate a null addBtn'
    );
    assert.ok(
        /if \(addBtn\) \{\s*tabRow\.insertBefore\(overflowContainer, addBtn\);/.test(strip),
        'the » container must be appended rather than inserted before a null addBtn'
    );
});

test('a team tab enters team scope — and is never inert because it holds the group lock', () => {
    const strip = block(terminalsJs, 'function renderGroupTabStrip() {', 'function terminalNameSuffix(');
    const handlers = strip.split("tab.addEventListener('click', () => {");
    assert.strictEqual(handlers.length, 3, 'the strip must wire exactly two tab click handlers (team-scoped + fleet)');

    // Team-scoped branch: re-entering the SAME scope is the only no-op.
    const teamHandler = handlers[1];
    assert.ok(/if \(teamScopeId === g\.id\) \{ return; \}/.test(teamHandler),
        'the team-scoped tab must no-op only on the already-scoped team');
    assert.ok(/enterTeamScope\(g\.id\)/.test(teamHandler),
        'the team-scoped tab must switch scope with enterTeamScope');

    // Fleet branch: the isSpawnedTeamGroup test must come BEFORE the
    // activeGroupId lock guard. startTeam (switchToTeamGroup) and the load-time
    // lock restore both leave a team group as activeGroupId WITHOUT entering
    // scope; behind the lock guard that tab is dead on click forever.
    const fleetHandler = handlers[2];
    const teamAt = fleetHandler.indexOf('isSpawnedTeamGroup(g)');
    const lockAt = fleetHandler.indexOf('activeGroupId === g.id');
    assert.ok(teamAt !== -1, 'the fleet tab handler must test isSpawnedTeamGroup');
    assert.ok(lockAt !== -1, 'the fleet tab handler must keep the activeGroupId guard for regular groups');
    assert.ok(teamAt < lockAt,
        'the team branch must precede the activeGroupId guard — a team group holding the lock must still be enterable');
    assert.ok(/enterTeamScope\(g\.id\)/.test(fleetHandler),
        'a team tab in the fleet strip must call enterTeamScope');
    assert.ok(/switchToGroup\(g\.id\)/.test(fleetHandler),
        'a regular group tab must still call switchToGroup');
});

test('the » overflow menu enters team scope for team entries and hides fleet-only items', () => {
    const strip = block(terminalsJs, 'function renderGroupTabStrip() {', 'function terminalNameSuffix(');
    const menuHandler = block(strip, "menuItem.addEventListener('click', () => {", 'menu.appendChild(menuItem)');
    const teamAt = menuHandler.indexOf('isSpawnedTeamGroup(g)');
    const activeAt = menuHandler.indexOf('activeId !== g.id');
    assert.ok(teamAt !== -1, 'the overflow item must test isSpawnedTeamGroup — otherwise switchToGroup reproduces the bug through the » menu');
    assert.ok(/enterTeamScope\(g\.id\)/.test(menuHandler), 'an overflowed team entry must call enterTeamScope');
    assert.ok(activeAt !== -1 && teamAt < activeAt,
        'the team branch must precede the active-id guard, exactly as the in-strip tab does');

    // Fleet-only menu items must sit behind the !inTeamScope guard.
    const guardAt = strip.indexOf('if (!inTeamScope) {');
    const roleToggleAt = strip.indexOf('const roleToggle = document.createElement');
    const restoreAt = strip.indexOf('group-tab-overflow-restore');
    assert.ok(guardAt !== -1, 'the fleet-only overflow items must sit behind an if (!inTeamScope) guard');
    assert.ok(roleToggleAt > guardAt, 'the role-grouping toggle is fleet-only');
    assert.ok(restoreAt > guardAt, 'the hidden-groups restore is fleet-only');

    // With nothing overflowed and no fleet items, team-scoped mode builds no » at all.
    assert.ok(
        /if \(inTeamScope && overflowing\.length === 0\)/.test(strip),
        'team-scoped mode must skip the » entirely when no tab overflowed'
    );
    // And the strip's own `group:*` picker is fleet-only — there is no "+" to open it.
    assert.ok(
        /if \(!inTeamScope && pickerState && pickerState\.key/.test(strip),
        "the group:* picker mount must be fleet-only — team pickers use team:* keys"
    );
});

test('renderTeamHeader appends below the tab row instead of wiping it', () => {
    const fn = block(terminalsJs, 'function renderTeamHeader() {', 'function fetchTeamQueue');
    assert.ok(
        !/groupTabStripEl\.innerHTML = ''/.test(fn),
        "renderTeamHeader must NOT clear groupTabStripEl — that wipes the tab row renderGroupTabStrip just built"
    );
    assert.ok(
        /groupTabStripEl\.appendChild\(header\)/.test(fn),
        'the header must be appended to the strip element'
    );
});

test('reloadTerminalGroups guards its bare strip redraw out of team scope', () => {
    // renderSidebarList renders the strip AND (in team scope) appends the team
    // header into the same element. An unguarded renderGroupTabStrip() here
    // re-wipes groupTabStripEl and takes the header — plus any live team:*
    // role picker mounted beside it — with it, on every terminalsGroupsChanged
    // push (team spawn, team restart, cross-panel group edit). The behavioural
    // twin of this lives in standing-orders-marker-contract's reload harness.
    const fn = block(terminalsJs, 'async function reloadTerminalGroups() {', 'async function fetchTerminalList()');
    assert.ok(/renderSidebarList\(\)/.test(fn), 'reloadTerminalGroups must still re-render the sidebar');
    assert.ok(
        /if \(!teamScopeId\) \{ renderGroupTabStrip\(\); \}/.test(fn),
        'the bare strip redraw must be guarded on !teamScopeId'
    );
});

test('renderSidebarList renders BOTH the strip and the team header in team scope', () => {
    const fn = block(terminalsJs, 'function renderSidebarList() {', 'function syncLayoutPickerUI()');
    assert.ok(
        !/!soloTerminalName && !teamScopeId/.test(fn),
        'the strip call must no longer be gated on !teamScopeId'
    );
    const stripAt = fn.indexOf('if (renderGroupTabStrip())');
    const headerAt = fn.indexOf('if (renderTeamHeader())');
    assert.ok(stripAt !== -1 && headerAt !== -1, 'both renderers must be called');
    assert.ok(stripAt < headerAt,
        'the strip must render BEFORE the header — the header appends into the element the strip clears'
    );
});

test('a direct team-to-team switch saves the namespaced layout keys and only those', () => {
    const enter = block(terminalsJs, 'async function enterTeamScope(groupId) {', 'async function exitTeamScope()');
    const saveAt = enter.indexOf('saveTeamScopedLayoutSettings()');
    const scopeAt = enter.indexOf('teamScopeId = groupId');
    assert.ok(saveAt !== -1, 'enterTeamScope must persist the outgoing scope layout on a direct switch');
    assert.ok(saveAt < scopeAt,
        'the save must precede the teamScopeId change — mapSettingKey resolves the namespace synchronously off the CURRENT scope'
    );
    assert.ok(
        /if \(teamScopeId && teamScopeId !== groupId\) \{/.test(enter),
        'the save must be guarded to direct switches only — first entry from the fleet has nothing team-scoped to save'
    );
    // Comments stripped: the body explains in prose that switchToGroup ends in
    // saveLayoutSettings(), and the assertion is about executable statements.
    const enterCode = enter.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(
        !/\bsaveLayoutSettings\(\)/.test(enterCode),
        'enterTeamScope must not call the full saveLayoutSettings — it writes the fleet-wide groups array'
    );

    // The scoped save must cover every namespaced key and neither of the two
    // fleet-wide ones: `terminals.groups` raced the loadLayoutSettings() read
    // two statements later, which is the race exitTeamScope snapshots
    // terminalGroups to survive.
    const keysBlock = block(terminalsJs, 'const TEAM_NAMESPACED_KEYS = new Set([', ']);');
    const keys = keysBlock.match(/'terminals\.[a-zA-Z]+'/g) || [];
    assert.ok(keys.length >= 9, 'TEAM_NAMESPACED_KEYS must still hold the layout family');
    const scopedSave = block(terminalsJs, 'function saveTeamScopedLayoutSettings() {', 'async function reloadTerminalGroups()');
    for (const key of keys) {
        assert.ok(scopedSave.includes(key), `saveTeamScopedLayoutSettings must save ${key}`);
    }
    assert.ok(!scopedSave.includes("'terminals.groups'"), 'the scoped save must NOT write the fleet-wide groups array');
    assert.ok(!scopedSave.includes("'terminals.groupPrefs'"), 'the scoped save must NOT write the fleet-wide groupPrefs');
});

test('a direct team-to-team switch clears the outgoing queue before the scope changes', () => {
    const enter = block(terminalsJs, 'async function enterTeamScope(groupId) {', 'async function exitTeamScope()');
    const itemsAt = enter.indexOf('_queueItems = []');
    const modeAt = enter.indexOf("_queueMode = 'manual'");
    const scopeAt = enter.indexOf('teamScopeId = groupId');
    assert.ok(itemsAt !== -1 && modeAt !== -1, 'enterTeamScope must reset the queue cache and mode');
    assert.ok(itemsAt < scopeAt && modeAt < scopeAt,
        'the reset must precede the scope change, or the outgoing team\'s items paint for a frame under the new team'
    );
    // The mode is then read from group config, never left at the reset default.
    assert.ok(
        enter.indexOf('getScopedTeamGroup()') > modeAt,
        'the Manual/Auto mode must be re-derived from the group record after the reset'
    );
});

test('the CSS that hid the tab row in team-scoped mode is gone', () => {
    assert.ok(
        !/body\.is-team-scoped\s+\.group-tab-strip\s*>\s*\.group-tab-row/.test(terminalsHtml),
        'the tab row must not be hidden in team-scoped mode — it carries "← All" and the sibling team tabs'
    );
    // The rest of the team-scoped CSS is untouched: the fleet-only sidebar
    // buttons stay hidden (asserted above) and the strip itself is only
    // suppressed in SOLO mode.
    assert.ok(
        /body\.is-solo \.group-tab-strip \{/.test(terminalsHtml),
        'solo mode must still hide the whole strip'
    );
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
