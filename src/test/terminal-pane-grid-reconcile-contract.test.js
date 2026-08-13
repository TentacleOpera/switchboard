'use strict';

/**
 * Contract: the Terminals pane grid reconciles IN PLACE.
 *
 * Source-text contract, not behavioural: the panel is a browser-only IIFE with no
 * export surface, and "the xterm element was not re-inserted" is not observable
 * from Node. What CAN be pinned is the handful of decisions that are invisible on
 * inspection and each of which was wrong in a first pass.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8');

let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

function block(startMarker, endMarker) {
    const start = SRC.indexOf(startMarker);
    assert.ok(start !== -1, `marker not found: ${startMarker}`);
    const end = SRC.indexOf(endMarker, start);
    assert.ok(end !== -1, `end marker not found after "${startMarker}": ${endMarker}`);
    return SRC.substring(start, end);
}

test('the grid is never blanked wholesale', () => {
    const grid = block('function renderPaneGrid() {', 'function createPaneElement(');
    // innerHTML = '' detached every live xterm and is the churn that put xterm's
    // RenderService into its paused state on every render.
    assert.ok(!grid.includes("paneGridEl.innerHTML = ''"), 'renderPaneGrid must not blank the grid');
    assert.ok(SRC.includes('function createPaneElement('), 'pane creation must be its own function');
    assert.ok(SRC.includes('function updatePaneElement('), 'pane patching must be its own function');
});

test('a terminal container moves only when its slot changed', () => {
    const update = block('function updatePaneElement(', 'function resolveFlooredLayout() {');
    assert.ok(
        update.includes('entry.container.parentNode !== contentEl'),
        'the in-place invariant must be guarded, not re-appended unconditionally'
    );
});

test('detach timers are still swept against the FULL assignment array', () => {
    const grid = block('function renderPaneGrid() {', 'function createPaneElement(');
    assert.ok(grid.includes('armDetachTimer'), 'the sweep must survive the restructure');
    assert.ok(grid.includes('cancelDetachTimer'), 'the sweep must survive the restructure');
    // paneAssignments is padded to getMaxSlotCount() (nine) regardless of layout, so a
    // terminal parked beyond the rendered slots is still assigned. Narrowing this to
    // getSlotCount(effectiveLayout) would destroy parked terminals on every shrink.
    assert.ok(
        grid.includes('!paneAssignments.includes(name)'),
        'the sweep must test the whole assignment array, not the rendered slice'
    );
});

test('button labels are re-assigned every reconcile and never condensed by layout name', () => {
    // Still a function, not a per-render const: it is now read by the input-state
    // chip alone (syncInputStateChip), and other spans in this suite use its
    // declaration as a block delimiter.
    assert.ok(SRC.includes('function isTerseLayout('), 'the dense-header flag must be a function, not a per-render const');
    const update = block('function updatePaneElement(', 'function resolveFlooredLayout() {');
    assert.ok(update.includes("clearBtn.textContent = 'clear'"), 'the clear label must be re-assigned on every reconcile');
    assert.ok(update.includes("hideBtn.textContent = 'hide'"), 'the hide label must be re-assigned on every reconcile');
    // The condensation was keyed on the LAYOUT NAME (2x3/3x3), never on measured
    // header width, so `c`/`h` fired on wide monitors where the words fit with room
    // to spare. .pane-title carries min-width: 0 + text-overflow: ellipsis and
    // .pane-actions is flex-shrink: 0, so a genuinely narrow header truncates the
    // title first and the buttons stay readable — that is the degradation order.
    assert.ok(!update.includes("terse ? 'c'"), 'the layout-name-keyed clear condensation must not come back');
    assert.ok(!update.includes("terse ? 'h'"), 'the layout-name-keyed hide condensation must not come back');
});

test('pane listeners are attached at creation, never per render', () => {
    const update = block('function updatePaneElement(', 'function resolveFlooredLayout() {');
    assert.ok(
        !update.includes('addEventListener'),
        'a reused pane element gains one listener per render if update attaches any'
    );
    const create = block('function createPaneElement(', 'function isTerseLayout(');
    assert.ok(create.includes('addEventListener'), 'createPaneElement is where listeners belong');
});

test('pane action handlers re-read the slot instead of closing over a name', () => {
    const create = block('function createPaneElement(', 'function isTerseLayout(');
    const reads = create.split('paneAssignments[index]').length - 1;
    // Both the clear and the hide handler must read the live slot; the original clear
    // handler closed over `assignedName`, which goes stale on a reused element.
    assert.ok(reads >= 2, `both pane action handlers must re-read paneAssignments[index] (found ${reads})`);
    assert.ok(!create.includes('clearTerminal(assignedName)'), 'the clear handler must not close over a captured name');
});

test('the caret is reclaimed only when the reconcile actually took it', () => {
    const grid = block('function renderPaneGrid() {', 'function createPaneElement(');
    assert.ok(
        grid.includes('hadFocus && !paneGridEl.contains(document.activeElement)'),
        'restore must compare before-and-after, not test for document.body'
    );
    // `document.activeElement === document.body` is true whenever the operator clicked
    // page background, so restoring on it steals the caret on every badge render.
    assert.ok(
        !grid.includes('document.activeElement === document.body'),
        'the body test steals focus and must not come back'
    );
});

test('the empty-slot placeholder is re-derived without destroying its children', () => {
    const update = block('function updatePaneElement(paneEl, index) {', 'function resolveFlooredLayout()');
    // The placeholder text changes with the lock ("Click a terminal to add it to
    // this group" vs the free-composition string), so it must be re-derived every
    // reconcile — panes are REUSED, and a slot that was empty before the lock
    // would otherwise keep stale text forever.
    assert.ok(
        update.includes('Click a terminal to add it to this group'),
        'an empty pane under a lock must invite the click that now fills it'
    );
    // ...but the placeholder also carries the `kanban mode` toggle button as a
    // child. Assigning `.textContent` on the existing node replaces EVERY child,
    // so the first reconcile after a pane emptied would permanently delete the
    // only entry point to kanban pane mode — silently, for the life of the page.
    const reDerive = update.slice(update.indexOf('Re-derive the placeholder text'));
    assert.ok(
        reDerive.length > 0,
        'the re-derive branch must exist and be commented'
    );
    assert.ok(
        !/existing\.textContent\s*=/.test(reDerive),
        're-deriving the placeholder must not assign textContent — that deletes the kanban-mode toggle child'
    );
    assert.ok(
        /nodeType === 3/.test(reDerive) && /nodeValue = label/.test(reDerive),
        'the re-derive must update the leading text node only, leaving element children intact'
    );
    // The creation branch is what appends that toggle; if it stops, the assertion
    // above is guarding nothing.
    assert.ok(
        update.includes("kanbanToggle.className = 'pane-mode-toggle'") &&
        update.includes('emptySlot.appendChild(kanbanToggle)'),
        'the empty slot must still offer the kanban-mode toggle'
    );
});

console.log(failed === 0 ? '\nAll pane-grid reconcile contracts passed.' : `\n${failed} contract(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
