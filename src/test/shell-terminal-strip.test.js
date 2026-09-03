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

test('per-terminal rail buttons are absent and ungrouped terminals have no strip buttons', () => {
    assert.ok(!shellJs.includes('buildTerminalButton'), 'buildTerminalButton must not exist in shell.js');
    const fn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function requestFleetState(');
    assert.ok(!fn.includes('buildTerminalButton'), 'renderTerminalSection must not call buildTerminalButton');
    assert.ok(!fn.includes('term:'), 'pulsedDoneStamps term: branch must be removed');
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

test('the bottom anchor moves to the first cold group icon and theme toggle is removed', () => {
    assert.ok(!shellJs.includes('buildThemeToggle'), 'buildThemeToggle must be removed from shell.js');
    assert.ok(!shellJs.includes('buildDockToggle'), 'buildDockToggle must be removed from shell.js');
    assert.ok(!shellHtml.includes('theme-toggle-btn'), 'theme-toggle-btn CSS must not exist');
    assert.ok(!shellHtml.includes('dock-toggle-btn'), 'dock-toggle-btn CSS must not exist');

    const fn = block(shellJs, 'function applyBottomAnchor() {', 'function renderTerminalSection(terminals, teams) {');
    assert.ok(
        fn.includes(".strip-group-cold'"),
        'applyBottomAnchor must query for .strip-group-cold icons'
    );
    assert.ok(
        fn.includes("coldIcons[0].style.marginTop = 'auto'"),
        'applyBottomAnchor must hand margin-top: auto to the first cold-group icon'
    );
});

test('the section is created eagerly in renderManifest between primary and cold groups', () => {
    const fn = block(shellJs, 'function renderManifest(manifest) {', 'function loadManifest() {');
    const primaryAt = fn.indexOf('for (const icon of primaryIcons) { strip.appendChild(icon); }');
    const containerAt = fn.indexOf('strip.appendChild(container);');
    const coldAt = fn.indexOf('for (const icon of coldIcons) { strip.appendChild(icon); }');
    const sectionAt = fn.indexOf('renderTerminalSection([])');
    assert.ok(primaryAt !== -1 && containerAt !== -1 && coldAt !== -1, 'manifest must partition into primary, container, and cold');
    assert.ok(primaryAt < containerAt && containerAt < coldAt, 'order in DOM must be primary -> strip-terminals -> cold');
    assert.ok(sectionAt !== -1 && coldAt < sectionAt, 'renderTerminalSection must be called after cold group is mounted');
});

test('the per-terminal light labelling is gone and the section is still named', () => {
    // Was: "the light state is in the accessible name, not only the dot".
    // Per-terminal rail buttons and their light states are deleted (rail
    // restructure + colour plans), so the subject of that assertion no longer
    // exists — it is rewritten to assert absence, per the plan. The team slot's
    // own name/tooltip contract is pinned separately by 'the team button tooltip
    // is just the team name'; do not re-add state to it here without changing
    // that decision first.
    const fn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
    assert.ok(!/\$\{t\.light\}/.test(fn), 'no per-terminal light may reach an accessible name — those buttons are deleted');
    assert.ok(!/labelText/.test(fn), 'the per-terminal labelText construction must not survive');
    assert.ok(fn.includes("'Fleet terminals'"), 'the section needs an aria-label so entries are not announced loose');
    assert.ok(
        /container\.(role = 'group'|setAttribute\('role', 'group'\))/.test(fn),
        'the section must be role=group — #strip is a tablist and terminals are not tabs'
    );
});

test('selection is expressed as a left-edge bar shape and team icons are accent', () => {
    const activeRule = shellHtml.match(/\.strip-icon\.is-active\s*\{([^}]*)\}/);
    assert.ok(activeRule, '.strip-icon.is-active rule must exist');
    assert.ok(/border-left:\s*2px\s+solid\s+var\(--text\)/.test(activeRule[1]),
        'active panel selection must be indicated by a 2px var(--text) left border bar');
    assert.ok(!/color:\s*var\(--accent\)/.test(activeRule[1]),
        'active panel icon must NOT use var(--accent) text colour');
    assert.ok(!/border-color:\s*var\(--accent-dim\)/.test(activeRule[1]),
        'active panel icon must NOT use var(--accent-dim) border colour');

    const teamIconRule = shellHtml.match(/\.strip-team-icon\s*\{([^}]*)\}/);
    assert.ok(teamIconRule, '.strip-team-icon rule must exist');
    assert.ok(/color:\s*var\(--accent\)/.test(teamIconRule[1]) || /fill:\s*var\(--accent\)/.test(teamIconRule[1]),
        '.strip-team-icon must carry var(--accent)');

    assert.ok(!/@keyframes strip-term-done-pulse\b/.test(shellHtml),
        'no @keyframes strip-term-done-pulse may exist');
    assert.ok(!/\.strip-team-queue-depth\b/.test(shellHtml),
        'no .strip-team-queue-depth CSS may exist');
    assert.ok(!/\.strip-term-exited\b/.test(shellHtml),
        'no .strip-term-exited CSS may exist');
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
    const icon = block(shellJs, 'function buildIcon(panel) {', 'const popoutWindows');
    assert.ok(
        icon.includes('btn.dataset.tooltip = panel.label || panel.id'),
        'panel icons must tooltips from the manifest label, falling back to the id (never silently none)'
    );
    const section = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function requestFleetState(');
    assert.ok(
        section.includes('btn.dataset.tooltip = team.name'),
        'team buttons must set data-tooltip to team.name'
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
    // #top-right-cluster is a fourth body-level element between the dock and the
    // overlay. What must hold is that the overlay is a body-level sibling, not
    // that it is any particular one's immediate next sibling.
    const cluster = shellHtml.includes('<div id="top-right-cluster"')
        ? block(shellHtml, '<div id="top-right-cluster"', '</div>')
        : '';
    assert.ok(!cluster.includes('tooltip-overlay'), 'the overlay must NOT live inside #top-right-cluster');
    assert.ok(
        /(?:<div id="content"><\/div>|<\/aside>|<div id="top-right-cluster"[^>]*><\/div>)[\s\S]{0,200}?<div id="tooltip-overlay"><\/div>/.test(body),
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

test('manifest entries use group: primary | cold and setup is railHidden', () => {
    const manifestSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'headlessPanelHtml.ts'), 'utf8');
    assert.ok(!manifestSrc.includes("placement?: 'bottom'"), 'placement must be removed from PanelManifestEntry');
    assert.ok(manifestSrc.includes("group: 'primary' | 'cold'"), 'group must be required on PanelManifestEntry');
    assert.ok(/\{\s*id:\s*'setup',[^\n]*railHidden:\s*true/.test(manifestSrc),
        'the setup manifest entry must carry railHidden: true');
    assert.ok(/\{\s*id:\s*'memo',[^\n]*railHidden:\s*true/.test(manifestSrc),
        'the memo manifest entry must carry railHidden: true');
    assert.ok(/\{\s*id:\s*'connections',[^\n]*railHidden:\s*true/.test(manifestSrc),
        'the connections manifest entry must carry railHidden: true');

    const shellSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'shell.js'), 'utf8');
    assert.ok(shellSrc.includes('panel.railHidden'), 'renderManifest must skip railHidden panels from rail icon creation');
});

test('the bottom anchor is applied to the first cold group icon', () => {
    const fn = block(shellJs, 'function applyBottomAnchor() {', 'function renderTerminalSection(terminals, teams) {');
    assert.ok(
        fn.includes(".strip-group-cold'"),
        'the reconciler must target cold group icons'
    );
    assert.ok(
        /coldIcons\[0\]\.style\.marginTop = 'auto'/.test(fn),
        'the anchor belongs to the first cold group icon'
    );
    assert.ok(
        /container\.style\.marginTop = '0'/.test(fn),
        'container top margin is neutralized when cold group is present'
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

// -------------------------------------------------- completion ring pulse lifecycle deleted

test('pulse ledger, DONE_PULSE_MS, and pulse keyframes are deleted', () => {
    assert.ok(!shellJs.includes('pulsedDoneStamps'), 'pulsedDoneStamps must be absent from shell.js');
    assert.ok(!shellJs.includes('DONE_PULSE_MS'), 'DONE_PULSE_MS must be absent from shell.js');
    assert.ok(!shellHtml.includes('strip-term-done-pulse'), 'strip-term-done-pulse must be absent from shell.html');
    assert.ok(!shellHtml.includes('strip-term-done-pulse-reduced'), 'strip-term-done-pulse-reduced must be absent from shell.html');
});

test('buildTeamsForShell does not relay light or doneStamp', () => {
    const fn = block(terminalsJs, 'function buildTeamsForShell() {', 'const LAYOUTS = {');
    assert.ok(!/light\s*:\s*light/.test(fn), 'buildTeamsForShell must not include light in teams entries');
    assert.ok(!/doneStamp\s*:\s*doneStamp/.test(fn), 'buildTeamsForShell must not include doneStamp in teams entries');
});

// ---------------------------------------------- Mission Control rail icon (UFO) deleted

test('the UFO Mission Control button and relay are fully deleted and .is-dormant is promoted', () => {
    assert.ok(!shellJs.includes('createMissionControlIcon'), 'createMissionControlIcon must be absent from shell.js');
    assert.ok(!shellJs.includes('ensureMissionControlIcon'), 'ensureMissionControlIcon must be absent from shell.js');
    assert.ok(!shellJs.includes('renderMissionControlIcon'), 'renderMissionControlIcon must be absent from shell.js');
    assert.ok(!shellJs.includes('strip-mission-control'), 'strip-mission-control must be absent from shell.js');
    assert.ok(!shellHtml.includes('#strip-mission-control'), '#strip-mission-control CSS must be absent from shell.html');
    assert.ok(!terminalsJs.includes('missionControlState'), 'missionControlState relay must be absent from terminals.js');
    assert.ok(!shellJs.includes('missionControlState'), 'missionControlState handler must be absent from shell.js');
    assert.ok(shellHtml.includes('.strip-icon.is-dormant'), '.strip-icon.is-dormant CSS class must exist in shell.html');
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
    // When team.iconUri is empty, the shell must go straight to the jet
    // glyph — the headTerm.iconUri arm (brand mark) must be gone.
    const iconBlock = block(fn, 'if (team.iconUri) {', "btn.addEventListener('click'");
    assert.ok(
        !/headTerm\.iconUri/.test(iconBlock),
        'the head brand-mark fallback arm must not survive — a team with no icon shows the jet'
    );
    assert.ok(
        /buildMaskedGlyph\('\/static\/icons\/nav-jet\.svg'\)/.test(iconBlock),
        'the jet glyph must be the fallback when there is no team icon'
    );
    assert.ok(
        !/roleChar/.test(iconBlock),
        'the role letter must not creep back into the team fallback'
    );
});

test('buildTeamsForShell does not fall back to the head brand mark', () => {
    const fn = block(terminalsJs, 'function buildTeamsForShell() {', 'const LAYOUTS = {');
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

test('the team button click posts switchToTeam when running and ptyStartTeam when dormant', () => {
    const fn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function renderManifest(manifest) {');
    // Scope to the team button click handler — the btn.addEventListener inside
    // the team loop.
    const teamHandler = block(fn, "btn.addEventListener('click', async () => {", 'container.appendChild(btn);');
    assert.ok(
        teamHandler.includes("type: 'switchToTeam'"),
        'the team button click must post a switchToTeam message to the terminals panel when running'
    );
    assert.ok(
        teamHandler.includes("ptyStartTeam"),
        'the team button click must call ptyStartTeam when dormant'
    );
    assert.ok(
        !teamHandler.includes('window.open('),
        'the team button click must NOT open a pop-out window — in-place navigation only'
    );
    assert.ok(
        teamHandler.includes("selectPanel('terminals')"),
        'the team button click must switch to the terminals panel before posting switchToTeam'
    );
    assert.ok(
        !teamHandler.includes("type: 'clearTeamBadges'"),
        'the clearTeamBadges relay must be deleted'
    );
    assert.ok(!shellJs.includes('clearTeamBadges'), 'clearTeamBadges must be absent from shell.js');
});

test('the popoutTeam message handler is removed from the shell', () => {
    assert.ok(
        !/data\.type === 'popoutTeam'/.test(shellJs),
        "the popoutTeam message handler must not survive — the team click no longer sends popoutTeam"
    );
});

test('ungrouped terminals do not render rail buttons and teams mode is the only mode', () => {
    const fn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function requestFleetState(');
    assert.ok(!fn.includes('buildTerminalButton'), 'buildTerminalButton must not be called');
    assert.ok(!fn.includes('term:'), 'no per-terminal key pulse tracking in renderTerminalSection');
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
    for (const id of ['#btn-start-all-teams', '#btn-open-all', '#btn-fill-grid', '#fill-grid-form', '#btn-start-team', '#start-team-form', '#btn-clear-all', '#btn-save-group', '#btn-link-up']) {
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

test('top-right cluster exists and satisfies invariants', () => {
    assert.ok(shellHtml.includes('id="top-right-cluster"'), '#top-right-cluster must exist in shell.html');
    assert.ok(/#top-right-cluster\s*\{[^}]*position:\s*fixed/.test(shellHtml), '#top-right-cluster must have position: fixed');
    assert.ok(/#top-right-cluster\s*\{[^}]*z-index:\s*40/.test(shellHtml), '#top-right-cluster must have z-index: 40');
    assert.ok(/#top-right-cluster\s*\{[^}]*calc\(var\(--dock-width,\s*0px\)\s*\+\s*6px\)/.test(shellHtml),
        '#top-right-cluster right offset must track --dock-width');

    const fn = block(shellJs, 'function renderTopRightCluster(manifest) {', 'function renderManifest(manifest) {');
    assert.ok(fn.includes('dock-toggle-btn'), 'cluster must create dock button with .dock-toggle-btn');
    assert.ok(fn.includes("'setup'"), 'cluster must create setup button');
    assert.ok(fn.includes("'memo'"), 'cluster must create memo button');
    assert.ok(fn.includes("'connections'"), 'cluster must create connections button');

    assert.ok(!shellJs.includes('buildDockToggle'), 'buildDockToggle must be removed from shell.js');
    assert.ok(/document\.documentElement\.style\.setProperty\('--dock-width'/.test(shellJs),
        '--dock-width must be written to documentElement');
});

test('three fixed team slots in the rail and showStripToast kept alive', () => {
    // 1. DEFAULT_TEAM_DEFINITIONS in teamWiring
    const teamWiringTs = fs.readFileSync(path.join(__dirname, '../services/teamWiring.ts'), 'utf8');
    assert.ok(teamWiringTs.includes('export const DEFAULT_TEAM_DEFINITIONS: any[] = ['),
        'DEFAULT_TEAM_DEFINITIONS must be exported from teamWiring.ts');
    assert.ok(teamWiringTs.includes("id: 'planning-team'"), 'planning-team must be declared');
    assert.ok(teamWiringTs.includes("id: 'feature-implementation'"), 'feature-implementation must be declared');
    assert.ok(teamWiringTs.includes("id: 'review-team'"), 'review-team must be declared');

    // 2. buildTeamsForShell emits 3 fixed slots in definition order
    const fn = block(terminalsJs, 'function buildTeamsForShell() {', 'const LAYOUTS = {');
    assert.ok(fn.includes('DEFAULT_TEAM_DEFINITIONS'), 'buildTeamsForShell must iterate DEFAULT_TEAM_DEFINITIONS');
    assert.ok(/\n\s*running,/.test(fn) || fn.includes('running:'),
        'buildTeamsForShell must emit a running boolean on every slot');
    // A member-less default team registers no terminals.groups row, so the slot's
    // running state cannot come from the group lookup alone.
    assert.ok(/t\.role === headRole/.test(fn),
        'buildTeamsForShell must detect a running member-less team by its live head role');

    // 3. renderTerminalSection renders dormant slots with .is-dormant
    const renderFn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function requestFleetState(');
    assert.ok(renderFn.includes("team.running ? '' : ' is-dormant'"),
        'renderTerminalSection must mark non-running slots as is-dormant');
    assert.ok(renderFn.includes('/terminals/verb/ptyStartTeam'),
        'clicking a dormant slot must call ptyStartTeam');

    // 4. showStripToast survival
    assert.ok(shellJs.includes('function showStripToast(text) {'),
        'showStripToast must be present in shell.js for start-failure feedback');

    // 5. The webview carries its own copy of the definitions (it cannot import
    //    TypeScript). Two declarations of one team is the drift shape teamWiring
    //    already carries scars from, so pin id + headRole across the boundary.
    const idsAndRoles = (src) => {
        const out = [];
        const re = /id:\s*'([a-z-]+)',\s*\n\s*name:\s*'[^']*',\s*\n\s*headRole:\s*'([a-z_]+)'/g;
        let m;
        while ((m = re.exec(src)) !== null) { out.push(m[1] + ':' + m[2]); }
        return out;
    };
    const tsDefs = idsAndRoles(block(teamWiringTs, 'export const DEFAULT_TEAM_DEFINITIONS: any[] = [', '];'));
    const jsDefs = idsAndRoles(block(terminalsJs, 'const DEFAULT_TEAM_DEFINITIONS = [', '];'));
    assert.strictEqual(tsDefs.length, 3, 'teamWiring.ts must declare exactly three default team definitions');
    assert.deepStrictEqual(jsDefs, tsDefs,
        'terminals.js DEFAULT_TEAM_DEFINITIONS has drifted from teamWiring.ts — id and headRole must match, in order');
});

test('dispatched state reaches the rail and is rendered as a shape indicator', () => {
    // 1. resolveTeamInFlight exported from LocalApiServer.ts
    const localApiServerTs = fs.readFileSync(path.join(__dirname, '../services/LocalApiServer.ts'), 'utf8');
    assert.ok(localApiServerTs.includes('export async function resolveTeamInFlight('),
        'resolveTeamInFlight must be exported from LocalApiServer.ts');

    // 2. GET /terminals/teams/<groupId>/queue includes inFlight
    assert.ok(localApiServerTs.includes('const check = await resolveTeamInFlight(db, roster);'),
        'GET /terminals/teams/<groupId>/queue must check resolveTeamInFlight');
    assert.ok(localApiServerTs.includes('res.end(JSON.stringify({ ...result, inFlight }));'),
        'GET /terminals/teams/<groupId>/queue must include inFlight in response');

    // 3. terminals.js stores and relays dispatched
    assert.ok(terminalsJs.includes('const _teamInFlight = new Map();'),
        '_teamInFlight map must be present in terminals.js');
    const buildFn = block(terminalsJs, 'function buildTeamsForShell() {', 'const LAYOUTS = {');
    assert.ok(buildFn.includes('dispatched:'), 'buildTeamsForShell must emit dispatched boolean');

    // 4. shell.html and shell.js render .is-dispatched
    assert.ok(shellHtml.includes('.strip-team-btn.is-dispatched::after'),
        '.strip-team-btn.is-dispatched::after CSS must be declared in shell.html');
    const renderFn = block(shellJs, 'function renderTerminalSection(terminals, teams) {', 'function requestFleetState(');
    assert.ok(renderFn.includes("isDispatched ? ' is-dispatched' : ''"),
        'renderTerminalSection must apply is-dispatched class');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
