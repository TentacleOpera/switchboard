# Reconcile the Terminals Pane Grid In Place Instead of Rebuilding It

## Goal

Stop `renderPaneGrid()` from tearing the whole pane grid down and re-parenting every live xterm on every render. Reconcile the existing pane elements in place so a terminal whose slot survives a render is **never** detached from the document — which removes the DOM churn that puts xterm's renderer into its paused state and makes pane resizing timing-dependent.

### Observed problem

Switching the browser Terminals panel from a grid (e.g. `3x3`) to the single-pane layout sometimes leaves the terminal painted at its old grid-cell size, with dead space around it — and sometimes works correctly, for the same action on the same panel. The non-determinism is the tell: nothing about the layout arithmetic varies between a good run and a bad one, so the variable is *timing*.

### Root cause

`src/webview/terminals.js:1162` — every render, unconditionally:

```js
    function renderPaneGrid() {
        const slotCount = getSlotCount(effectiveLayout);
        const hadFocus = paneGridEl.contains(document.activeElement);
        paneGridEl.className = `pane-grid layout-${effectiveLayout}`;
        paneGridEl.innerHTML = '';                       // <-- detaches every live xterm
        …
        for (let i = 0; i < slotCount; i++) {
            …
            if (entry.container.parentNode !== contentEl) {
                contentEl.appendChild(entry.container);  // <-- re-parents it back
            }
            …
        }
```

`paneGridEl.innerHTML = ''` removes every pane subtree, and each of those subtrees contains a live `.terminal-view-host` with a mounted xterm inside it. The loop then rebuilds fresh pane elements and re-appends the containers that still have a slot. Containers that no longer have a slot are simply left detached.

Three consequences, all re-verified against the vendored xterm source at `@xterm/xterm@5.5.0`:

**1. xterm pauses rendering on non-intersection, and the pause parks work.** From `src/webview/vendor/xterm/xterm.js` (de-minified `RenderService`):

```js
handleResize(cols, rows) {
    if (!this._renderer.value) return;                                   // <-- see fact 4
    if (this._isPaused) { this._pausedResizeTask.set(() => this._renderer.value?.handleResize(cols, rows)); }
    else                { this._renderer.value.handleResize(cols, rows); }
    this._fullRefresh();
}
_fullRefresh()       { if (this._isPaused) { this._needsFullRefresh = true; } else { this.refreshRows(0, this._rowCount - 1); } }
refreshRows(s, e, r) { if (this._isPaused) { this._needsFullRefresh = true; } else { … this._renderDebouncer.refresh(…); } }
```

`_isPaused` is written from **one** place only — the `IntersectionObserver` callback on the terminal's screen element — and it reads only the **last** record of each delivered batch:

```js
_registerIntersectionObserver(win, screenEl) {
    const io = new win.IntersectionObserver(e => this._handleIntersectionChange(e[e.length - 1]), { threshold: 0 });
    io.observe(screenEl);
}
_handleIntersectionChange(entry) {
    this._isPaused = entry.isIntersecting === undefined ? entry.intersectionRatio === 0 : !entry.isIntersecting;
    if (!this._isPaused && !this._charSizeService.hasValidSize) { this._charSizeService.measure(); }
    if (!this._isPaused && this._needsFullRefresh) {
        this._pausedResizeTask.flush();
        this.refreshRows(0, this._rowCount - 1);
        this._needsFullRefresh = false;
    }
}
```

Detaching an observed element makes IntersectionObserver report it as not intersecting; re-attaching reports it as intersecting again. So `innerHTML = ''` + re-append churns `_isPaused` for **every terminal in the grid, on every render** — and the recovery (flushing the parked renderer resize and clearing `_needsFullRefresh`) depends on batch delivery order, which `requestAnimationFrame` callbacks legitimately race (rAF runs before the frame's intersection computation).

**2. Once lost, the race is unrecoverable through the fit path.** `src/webview/vendor/xterm/addon-fit.js`:

```js
fit() {
    const dims = this.proposeDimensions();
    if (!dims || isNaN(dims.cols) || isNaN(dims.rows)) return;
    if (this._terminal.rows === dims.rows && this._terminal.cols === dims.cols) return;  // short-circuit
    core._renderService.clear();
    this._terminal.resize(dims.cols, dims.rows);
}
```

`term.resize()` updates the buffer even when the renderer's half is parked, so `cols`/`rows` end up correct while the canvas stays stale — and from then on every `fit()` returns at the short-circuit. The pane is stuck: right buffer, wrong canvas, and no call site can repair it.

**3. The rebuild is expensive and self-defeating for reasons the file already documents.** `renderPaneGrid`'s own comments concede that the teardown yanks the caret out mid-keystroke (hence the `hadFocus` save/restore at `terminals.js:1170` and `:1291`), and `setFocusedPane` (`terminals.js:1149`) exists purely to avoid calling `renderPaneGrid` for a two-class focus change because "renderPaneGrid() is a full teardown that reparents every live xterm — running it for a highlight change is what ate the first click." The function is called on every `terminalsChanged` broadcast, every `agentCompleted` badge, every per-terminal clear and every sidebar interaction, so a 9-pane grid pays a full 9-xterm detach/re-attach for events that changed one label.

**4. There is a second stranding path that this plan does NOT close, and that matters for sequencing.**

> **Superseded:** The root-cause account above (facts 1–3) presented the IntersectionObserver pause as the *sole* mechanism that strands a pane, and therefore presented removing the DOM churn as removing "the cause".
> **Reason:** Re-reading the vendored `RenderService.handleResize` shows an unguarded early return that this plan cannot reach: `if (!this._renderer.value) return;`. When no renderer is installed the resize is **dropped outright — not parked**, so there is no `_pausedResizeTask` to flush and no `_needsFullRefresh` to clear. `term.resize()` has already updated `cols`/`rows`, so `FitAddon.fit()` short-circuits from then on and the pane is permanently stranded with no DOM churn involved at all. `_renderer.value` is unset while a renderer swap is in flight — which `attachRenderer`'s WebGL `onContextLoss` handler (`terminals.js:182-188`) deliberately performs, disposing the WebGL addon and attaching the canvas one.
> **Replaced with:** This plan removes the *dominant* cause (churn-driven intersection races) and eliminates the per-render cost. It does not, and cannot, close the renderer-swap path. That path is only closed by the sibling subtask's verify-and-repair ladder, which is why that subtask is not merely a "symptom fix" and must ship regardless of this one.

### Why this is its own plan

Making the fit path verify itself and retry (the sibling subtask) is the smaller, safer fix to ship first, and — per fact 4 — is the only fix for one of the two stranding paths. **This** plan removes the dominant cause: if a terminal's slot did not change, its DOM never moves, `_isPaused` never flips, and there is no race to lose. It is independently shippable and independently verifiable — it stands on its own even if the fit-verification work never lands, and vice versa. It is also the change that touches focus behaviour, which is exactly why it should not be bundled with a one-function bug fix.

### Alternative considered and deferred: CSS-Grid placement instead of re-parenting

The one case in-place reconciliation cannot make churn-free is a terminal *moving between panes* (`assignToFocusedPane`, the `hide`/undo path): the container is genuinely appended to a different `.pane-content`, which detaches it. External research surfaced the maintainer-endorsed way to avoid even that — make the terminal hosts direct children of the grid and reposition them by mutating `style.gridArea` / `style.gridColumn` / `style.gridRow`, so a terminal changes *slot* without ever changing *parent*. A repositioned-but-attached node never leaves the document, so its `IntersectionObserver` never fires.

**Deferred, deliberately.** Adopting it means dissolving `.terminal-pane` as a container: the pane header (title chip, badge, `clear`/`hide`) would have to become either a sibling grid item positioned into the same cell or an absolutely-positioned overlay, and the `mousedown`-to-focus and `focused` outline behaviours would need re-deriving on whatever element is left. That is a larger restructure than this plan, on a file already carrying 754 uncommitted lines from another feature. The cost of deferring is bounded and known: a pane-to-pane *move* is a deliberate, infrequent operator action affecting at most two terminals, and the sibling subtask's fit ladder covers exactly that case. Recorded here as the natural follow-up if the ladder's `stale-canvas` warnings turn out to cluster on assignment changes rather than layout changes — which is precisely what the ladder's verdict logging will tell us.

## Metadata

- **Complexity:** 7
- **Tags:** frontend, ui, refactor, performance, reliability

## User Review Required

**Yes — one decision.** This plan changes the *semantics* of the caret restore. Today `renderPaneGrid` unconditionally hands the caret back to `focusedPaneIndex` whenever the grid held focus before the teardown, because the teardown destroyed every pane. With in-place reconciliation the caret survives most renders on its own, so the restore must become conditional or it will re-steal focus. The proposed rule is: **restore only when the grid held the caret before the reconcile and no longer holds it after.** Everything else here is a mechanical restructure with no user-visible behaviour change.

## Complexity Audit

### Routine
- Extracting the per-pane header build (title chip, badge, `clear`/`hide` buttons) into a function that can either create or update a pane element.
- Keeping the `paneGridEl.className` assignment as-is.
- Re-deriving the title text, badge and `(exited)` / `(no longer listed)` suffixes on every reconcile.

### Complex / Risky
- **Event-listener duplication.** The current code attaches `mousedown`, `clear` and `hide` listeners to freshly created elements every render, which is safe precisely *because* the elements are thrown away. Reusing pane elements means listeners must be attached exactly once at creation and must read mutable state (`paneAssignments[i]`, the terse flag) at *call* time, not from a closure captured at creation. The current `clear` handler closes over `assignedName` (`terminals.js:1233`) — a captured value that would go stale on a reused element. The `hide` handler already re-reads `paneAssignments[i]` (`terminals.js:1243`); that pattern must be preserved deliberately, not by accident.
- **The terse-label flag depends on the layout.** `const terse = effectiveLayout === '2x3' || effectiveLayout === '3x3'` (`terminals.js:1225`) is baked into button text on create. On reuse, button labels must be re-derived when the layout changes, or a `2x3` grid demoted to `2h` keeps its `c`/`h` initials.
- **Focus preservation changes meaning.** See *User Review Required*. Getting the predicate wrong in either direction is a regression: too eager and the pane snatches the caret out of the sidebar or an inline-rename input; too lazy and a genuinely destroyed caret is never restored.
- **Detach-timer semantics are subtler than they look.** The trailing loop (`terminals.js:1282`) tests `paneAssignments.includes(name)` against the **whole** array, and `sanitizePaneAssignments` pads that array to `getMaxSlotCount()` — nine — regardless of the active layout (`terminals.js:643-651`, `getMaxSlotCount` at `:478`). So a terminal parked in slot 5 while the layout is `1` is *still assigned*: it gets `cancelDetachTimer`, keeps its `active` class, and is **not** destroyed. That is existing, deliberate behaviour (it is what makes `3x3 → 1 → 3x3` instant). The reconcile must preserve it exactly and must not "helpfully" arm detach timers for terminals whose panes were removed.
- **Existing tests scan this file by span.** `src/test/shell-terminal-strip.test.js` slices `terminals.js` between literal markers, two of which bracket this function: `('function setFocusedPane(index) {', 'function renderPaneGrid() {')` and `('function renderPaneGrid() {', 'function resolveFlooredLayout() {')`. Any new helper declared between `renderPaneGrid` and `resolveFlooredLayout` lands inside the second span.
- **Solo mode shares this function.** `checkSoloNotFound` (`terminals.js:578`) owns grid visibility in solo mode and explicitly notes that hiding the grid elsewhere would fight it. Reconciliation must not touch `paneGridEl.style.display` outside the paths that already do.

## Edge-Case & Dependency Audit

### Race Conditions
- **Reconcile landing while a fit ladder is in flight** (once the sibling subtask ships). The ladder re-reads `paneAssignments` / `effectiveLayout` on every attempt and gates on `isRendered`, so a reconcile that moves or removes a container simply makes the next attempt a no-op. No coordination needed in this direction.
- **Rapid successive renders** (a `fetchTerminalList` response, a badge and a layout change in one tick). Reconciliation must be idempotent: running it three times in a row produces the same DOM and moves no container that is already in the right place.
- **A container moving between panes within one reconcile.** Slot order matters. If terminal `A` moves from pane 0 to pane 3, pane 0 is updated first and clears its content — detaching `A`'s container — before pane 3 re-appends it. The node survives (it is held by `terminalsMap`), so this is a detach/re-attach, i.e. exactly the churn this plan removes in the common case but cannot avoid for a genuine move. Acceptable and unchanged from today.

### Security
- None. No new input surface, no new network call, no new persisted state.

### Side Effects
- **The caret.** See *User Review Required*. This is the only behavioural side effect.
- **Listener lifetime.** Pane elements now outlive a render, so a listener attached per render would accumulate. Attaching only in `createPaneElement` is load-bearing, not stylistic.

### Dependencies & Conflicts

| Case | Required behaviour |
| :--- | :--- |
| Slot count grows (`1` → `3x3`) | Existing pane 0 element is reused untouched (its terminal never detaches); panes 1–8 are created and appended. |
| Slot count shrinks (`3x3` → `1`) | Pane 0 reused; panes 1–8 removed. Their containers go with the removed subtrees and stay referenced by `terminalsMap`. Because `paneAssignments` is nine long and still names them, the trailing sweep must leave them **assigned** — no `armDetachTimer`, `active` class retained — exactly as today. |
| Same slot count, different assignment (pane 0: `A` → `B`) | Pane 0 element reused; `A`'s container moved out, `B`'s moved in. Only these two terminals see an intersection change — not the other seven. |
| Assignment unchanged, only a badge changed (`agentCompleted`) | **No terminal DOM may move at all.** Only the title's badge span is rebuilt. This is the case that currently costs a full 9-xterm teardown. |
| Assignment unchanged, terminal went `exited` | Title text updates to `… (exited)`; container does not move. |
| Terminal disappeared from `fleetList` | Title gains `(no longer listed)`; `sanitizePaneAssignments` has already nulled the slot in the normal path, so the pane renders empty. |
| Empty slot → assigned | The `.pane-empty-slot` placeholder must be removed before the container is appended, or both render. |
| Assigned → empty slot (the `hide` button) | Container detached, `.pane-empty-slot` placeholder restored. Detach-timer state follows the existing `paneAssignments.includes` rule — for a `hide`, the slot really is nulled, so the timer arms. |
| Layout changes `2x3` → `2h` with panes reused | Terse button labels must be re-derived to `clear`/`hide`. |
| Focused pane index beyond the new slot count | `focusedPaneIndex` reset to 0 (existing logic at `terminals.js:1175`) and the `.focused` class moved without rebuilding. |
| Caret was in a surviving pane | Caret must survive the reconcile with **no** `focusPaneTerminal` call — that is the whole point. |
| Caret was in a pane or container the reconcile destroyed/moved | Restore to `focusedPaneIndex`, as today. |
| Caret was outside the grid entirely (sidebar row, inline-rename input, `document.body` after a background click) | **Must not be touched.** Today's `hadFocus` guard already covers this and the replacement must too. |
| Solo mode (`?solo=`) | Single pane, `checkSoloNotFound` still owns `paneGridEl.style.display`. Reconciliation must be a no-op difference here. |
| First render (empty grid) | Everything is a create; identical result to today. |
| Terminal not yet materialized (`entry.term === null`, `whenRendered`, `terminals.js:1857`) | Container moves as a plain div; `materializeTerminalView` fires later off its own observer. Unchanged. |

## Dependencies

- **Sibling subtask — *Verified Pane Fit After a Terminals-Panel Layout Change*.** Ships first. It touches `batchFitVisiblePanes`, `destroyTerminalView` and the `materializeTerminalView` ResizeObserver; this plan touches `renderPaneGrid` and the two helpers that replace its body. Disjoint edits in one file — no textual conflict, but see *Dependencies & sequencing* in the feature file for why the order is not arbitrary.
- **In-flight feature — *Multi-Parent Workspace Terminals*** (`.switchboard/features/multi-parent-workspace-terminals-*.md`, subtasks at INTERN CODED). Its work is **uncommitted in the working tree right now**: `git diff --stat` shows 754 changed lines in `src/webview/terminals.js` and 209 in `src/webview/terminals.html`. It rewrites `renderSidebarList` and adds `renderTerminalRow`, inserting ~110 lines *above* `renderPaneGrid`. It explicitly declares the pane grid out of scope ("making the pane grid parent-aware… pane headers stay name-only"), so there is no functional conflict — but **every line number in this plan is anchored to that working tree, not to HEAD.** Rebase and re-read `renderPaneGrid` before starting; do not trust the citations blindly.
- `src/webview/terminals.js` — `renderPaneGrid` (`:1162`) and its call sites: `setLayoutMode` (`:1026`), `assignToFocusedPane` (`:1106`), `undoLastAssignment` (`:1119`), `fetchTerminalList` (`:551`), `applyLayoutFloor` (`:1331`), `fillEmptyPanes` (`:1622`), the `focusTerminal` message arm (`:394`), and the pane `hide` handler (`:1248`).
- `src/webview/terminals.html` — `.pane-grid.layout-*`, `.terminal-pane`, `.pane-header`, `.pane-actions` (`:579`), `.pane-content` (`:679`), `.pane-empty-slot` (`:683`), `.terminal-view-host` (`:359`, `display:none` / `.active { display:block }`).
- `src/webview/vendor/xterm/xterm.js` — `RenderService` pause semantics quoted above; this is the behaviour the change is exploiting. **This file is generated and gitignored**: `scripts/sync-webview-vendor.js` copies it out of `node_modules/@xterm/xterm@5.5.0` on every `npm run compile`. Read it there, never edit it.
- `src/test/shell-terminal-strip.test.js` — source-span assertions over this file (markers listed in the Complexity Audit).
- `src/test/terminal-solo-popout-contract.test.js` — source-span assertions over `fetchTerminalList` and the `init` tail; not over `renderPaneGrid`.

## Adversarial Synthesis

**Risk summary.** Three risks carry this plan. (1) The caret-restore predicate: the drafted `document.activeElement === document.body` test both duplicates its own first clause and *steals* the caret whenever the user has clicked page background, so it is replaced with a before/after comparison. (2) Listener lifetime on reused elements — mitigated by attaching only in `createPaneElement` and re-reading `paneAssignments[index]` at call time, pinned by a contract assertion that `updatePaneElement` contains no `addEventListener`. (3) The trailing detach sweep, whose `paneAssignments.includes` test spans all nine slots and must not be "corrected" to the rendered slot count — doing so would start destroying parked terminals on every layout shrink.

## Proposed Changes

> **Line numbers throughout are anchored to the current working tree** (`terminals.js` with the uncommitted Multi-Parent Workspace Terminals changes applied), not to `HEAD`. They will drift again. Locate by function name.

### 1. `src/webview/terminals.js` — split `renderPaneGrid` into reconcile + per-pane update

Replace the body of `renderPaneGrid` (`:1162-1292`). The public name and every call site stay identical. Declare the three new helpers **immediately after** `renderPaneGrid` and **before** `resolveFlooredLayout` (`:1299`), so they fall inside the span `shell-terminal-strip.test.js` already slices for this function rather than splitting an unrelated one.

```js
    /**
     * Reconcile the pane grid IN PLACE.
     *
     * This used to open with `paneGridEl.innerHTML = ''` and rebuild every pane
     * from scratch, which detached and re-appended every live xterm on every
     * render — including renders that changed nothing but a badge. That churn is
     * not cosmetic: xterm's RenderService pauses on non-intersection and PARKS the
     * renderer resize plus the full repaint while paused (see xterm.js
     * _handleIntersectionChange / handleResize), and it only unpauses from an
     * IntersectionObserver batch whose last record says "intersecting". A fit that
     * lands on the wrong side of that delivery leaves the buffer at the new size
     * and the canvas at the old one — and FitAddon.fit() then short-circuits on
     * matching cols/rows forever after, so the pane can never recover. Reusing the
     * pane element means a terminal whose slot survives never moves, never
     * unpauses, and never enters that state.
     *
     * Also removes the teardown that the caret save/restore below exists to paper
     * over, and that setFocusedPane was written specifically to avoid.
     */
    function renderPaneGrid() {
        const slotCount = getSlotCount(effectiveLayout);
        paneGridEl.className = `pane-grid layout-${effectiveLayout}`;

        // Sampled BEFORE any mutation. Both the surplus-pane removal below and the
        // per-pane update can drop the caret (removing or re-parenting the focused
        // element sends focus to <body>), so a flag computed after either one would
        // miss half the cases.
        const hadFocus = paneGridEl.contains(document.activeElement);

        // A floored layout can leave the focus on a pane that is no longer rendered.
        if (focusedPaneIndex >= slotCount) { focusedPaneIndex = 0; }

        // Drop surplus panes first, so index-addressed reuse below is straightforward.
        // A removed pane's terminal container goes with the subtree and is left
        // detached — exactly what innerHTML='' did — and stays referenced by
        // terminalsMap so a later reconcile can re-append it.
        while (paneGridEl.children.length > slotCount) {
            paneGridEl.removeChild(paneGridEl.lastElementChild);
        }
        while (paneGridEl.children.length < slotCount) {
            paneGridEl.appendChild(createPaneElement(paneGridEl.children.length));
        }

        for (let i = 0; i < slotCount; i++) {
            updatePaneElement(paneGridEl.children[i], i);
        }

        // Unchanged from the original, deliberately. `paneAssignments` is padded to
        // getMaxSlotCount() (nine) regardless of the active layout, so a terminal
        // parked in slot 5 while the layout is `1` is still ASSIGNED: no detach timer,
        // keeps its active class, survives a 3x3 -> 1 -> 3x3 round trip instantly.
        // Narrowing this to the rendered slot count would start destroying those.
        for (const [name, entry] of terminalsMap.entries()) {
            if (!paneAssignments.includes(name)) {
                entry.container.classList.remove('active');
                armDetachTimer(name);
            } else {
                cancelDetachTimer(name);
            }
        }

        // Reclaim the caret only when WE had it and WE lost it. The old code restored
        // whenever the grid held focus beforehand, which was right when the teardown
        // destroyed every pane and is wrong now that most reconciles destroy nothing:
        // it would snatch the caret back from wherever the operator just put it.
        if (hadFocus && !paneGridEl.contains(document.activeElement)) {
            focusPaneTerminal(focusedPaneIndex);
        }
    }
```

> **Superseded:** `const focusWasDestroyed = !paneGridEl.contains(document.activeElement) && document.activeElement === document.body;`, sampled after the surplus-pane loop and before the update loop.
> **Reason:** Three defects. (a) The second clause makes the first redundant, so the predicate is really just "is focus on `<body>`?" — which is **true whenever the operator clicked page background**, so a routine badge render would yank the caret into a pane. That is the precise theft the conditional restore exists to prevent. (b) Sampling after the removal loop but before the update loop misses every caret lost to a container *move* in the update loop — a regression against today, where `hadFocus` is sampled before all mutation and always restored. (c) It answers "was focus already gone?" rather than "did this reconcile take it?"
> **Replaced with:** Sample `hadFocus` before any mutation; restore only if `hadFocus && !paneGridEl.contains(document.activeElement)` after. Covers both loss paths, and cannot fire when the caret was never in the grid.

```js
    /**
     * Build a pane shell once. Listeners are attached here and here only, and each
     * one re-reads mutable state (paneAssignments, effectiveLayout) at call time —
     * the old code could close over per-render values because the element was
     * thrown away every render; a reused element cannot.
     */
    function createPaneElement(index) {
        const paneEl = document.createElement('div');
        paneEl.className = 'terminal-pane';
        paneEl.dataset.paneIndex = index;

        // mousedown, not click: it lands before xterm's own selection handling and
        // before mouseup, so one press both selects the pane and leaves the caret
        // in it.
        paneEl.addEventListener('mousedown', () => setFocusedPane(index));

        const headerEl = document.createElement('div');
        headerEl.className = 'pane-header';

        const titleEl = document.createElement('div');
        titleEl.className = 'pane-title';

        const actionsEl = document.createElement('div');
        actionsEl.className = 'pane-actions';

        const paneClearBtn = document.createElement('button');
        paneClearBtn.className = 'btn-unassign-pane';
        paneClearBtn.title = 'Send /clear to this terminal';
        // Re-reads the slot. The original closed over `assignedName` from the render
        // that built the button, which was safe only because the button died with
        // that render — on a reused element it would clear whichever terminal
        // happened to be in this pane when it was first created.
        paneClearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetName = paneAssignments[index];
            if (!targetName) { return; }
            const label = isTerseLayout() ? 'c' : 'clear';
            withClearingFeedback(paneClearBtn, () => clearTerminal(targetName), label);
        });

        const unassignBtn = document.createElement('button');
        unassignBtn.className = 'btn-unassign-pane';
        unassignBtn.title = 'Remove from this pane (terminal keeps running)';
        unassignBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetName = paneAssignments[index];
            if (!targetName) { return; }
            undoSnapshot = { slots: paneAssignments.slice(), name: null, displaced: targetName, paneIndex: index };
            showPaneToast(`Pane ${index + 1} cleared (${targetName} still running)`, undoLastAssignment);
            paneAssignments[index] = null;
            saveLayoutSettings();
            renderPaneGrid();
            renderSidebarList();
        });

        actionsEl.appendChild(paneClearBtn);
        actionsEl.appendChild(unassignBtn);
        headerEl.appendChild(titleEl);
        headerEl.appendChild(actionsEl);
        paneEl.appendChild(headerEl);

        const contentEl = document.createElement('div');
        contentEl.className = 'pane-content';
        paneEl.appendChild(contentEl);
        return paneEl;
    }

    /** The 6- and 9-pane headers cannot fit the two-word button labels. */
    function isTerseLayout() {
        return effectiveLayout === '2x3' || effectiveLayout === '3x3';
    }

    /**
     * Patch a pane in place. The load-bearing rule: touch `entry.container`'s
     * parent ONLY when the assignment for this slot actually changed. A badge
     * update, an (exited) suffix or a layout-driven label change must move no
     * terminal DOM at all.
     */
    function updatePaneElement(paneEl, index) {
        paneEl.dataset.paneIndex = index;
        paneEl.classList.toggle('focused', index === focusedPaneIndex);

        const titleEl = paneEl.querySelector('.pane-title');
        const actionsEl = paneEl.querySelector('.pane-actions');
        const contentEl = paneEl.querySelector('.pane-content');
        const assignedName = paneAssignments[index];
        const terse = isTerseLayout();

        titleEl.textContent = '';
        if (assignedName) {
            const idxEl = document.createElement('span');
            idxEl.className = 'pane-index-chip';
            idxEl.textContent = `P${index + 1}`;
            titleEl.appendChild(idxEl);

            let displayTitle = assignedName;
            const fleetItem = fleetList.find(t => t.friendlyName === assignedName);
            if (fleetItem && fleetItem.status === 'exited') {
                displayTitle += ' (exited)';
            } else if (!fleetItem && hasFetchedList) {
                displayTitle += ' (no longer listed)';
            }
            titleEl.appendChild(document.createTextNode(displayTitle));

            if (terminalBadges.has(assignedName)) {
                const badgeSpan = document.createElement('span');
                badgeSpan.className = 'pane-badge';
                badgeSpan.textContent = terminalBadges.get(assignedName);
                titleEl.appendChild(badgeSpan);
            }
        } else {
            titleEl.textContent = `Pane ${index + 1} (Empty)`;
        }

        // Labels are re-derived every reconcile: a 2x3 pane demoted to 2h must lose
        // its `c`/`h` initials, which a create-time-only label would keep forever.
        // Indexed, not destructured: the two buttons share a class name, so there is
        // no selector that tells them apart, and children[] is the honest read.
        const clearBtn = actionsEl.children[0];
        const hideBtn = actionsEl.children[1];
        clearBtn.textContent = terse ? 'c' : 'clear';
        hideBtn.textContent = terse ? 'h' : 'hide';
        // The buttons now always EXIST (they are reused); an empty pane hides the
        // block rather than omitting it.
        actionsEl.style.display = assignedName ? '' : 'none';

        if (assignedName) {
            const placeholder = contentEl.querySelector('.pane-empty-slot');
            if (placeholder) { contentEl.removeChild(placeholder); }
            const entry = terminalsMap.get(assignedName);
            if (!entry) {
                createTerminalView(assignedName, contentEl);
            } else {
                // THE invariant of this change: no move when already in place.
                if (entry.container.parentNode !== contentEl) {
                    contentEl.appendChild(entry.container);
                }
                entry.container.classList.add('active');
            }
        } else if (!contentEl.querySelector('.pane-empty-slot')) {
            // Clears a container still parented here from a previous assignment. The
            // node survives in terminalsMap; only its parentage is dropped.
            contentEl.textContent = '';
            const emptySlot = document.createElement('div');
            emptySlot.className = 'pane-empty-slot';
            emptySlot.textContent = 'Click terminal in sidebar to assign';
            contentEl.appendChild(emptySlot);
        }
    }
```

### 2. `src/webview/terminals.html` — no change

> **Superseded:** Add `.pane-actions:empty { display: none; }` to `terminals.html` so an empty pane's reused actions block does not reserve header space.
> **Reason:** Dead CSS. Under this design the actions block is **never empty** — both buttons are created once in `createPaneElement` and persist for the life of the pane — so `:empty` can never match. `updatePaneElement` already hides the block with an inline `style.display = 'none'`, which is what actually does the job.
> **Replaced with:** No stylesheet change. This subtask now touches exactly two files: `src/webview/terminals.js` and the new contract test. Smaller blast radius, and `terminals.html` (which has 209 uncommitted lines from the in-flight Multi-Parent feature) stays out of the merge path entirely.

### 3. `src/test/terminal-pane-grid-reconcile-contract.test.js` — new contract test

> **Superseded:** A Jest test file using `describe` / `it` / `expect`, verified with `npx jest … --forceExit`.
> **Reason:** **There is no Jest in this repository.** It is absent from `dependencies` and `devDependencies`, there is no `jest.config.*` and no `node_modules/.bin/jest`. Every contract suite here is a plain Node script that defines its own `test()` helper over `require('assert')`, is registered as a `test:contract:*` npm script, and is invoked from `.github/workflows/integration-tests.yml`. A Jest-syntax file would silently never run — the worst possible outcome for a regression pin. (The two sibling files that *look* Jest-shaped, `terminal-token-transport-contract` and `terminal-operations-no-periodic-reopen`, are also plain Node.)
> **Replaced with:** A plain-Node contract in the house style, plus the npm-script and CI wiring the convention requires.

```js
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

test('terse button labels are re-derived from the live layout', () => {
    assert.ok(SRC.includes('function isTerseLayout('), 'the terse flag must be a function, not a per-render const');
    const update = block('function updatePaneElement(', 'function resolveFlooredLayout() {');
    assert.ok(update.includes("terse ? 'c' : 'clear'"), 'clear label must be re-derived');
    assert.ok(update.includes("terse ? 'h' : 'hide'"), 'hide label must be re-derived');
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

console.log(failed === 0 ? '\nAll pane-grid reconcile contracts passed.' : `\n${failed} contract(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
```

### 4. `package.json` — register the contract

Alongside the existing `test:contract:shell-terminal-strip` entry:

```json
"test:contract:terminal-pane-grid-reconcile": "node --require ./src/test/bootstrap/sandboxStateHome.js src/test/terminal-pane-grid-reconcile-contract.test.js"
```

### 5. `.github/workflows/integration-tests.yml` — wire it into CI

Add a step beside the existing terminal contracts (the `test:contract:shell-terminal-strip` step is at line 283):

```yaml
      - name: Terminal pane grid reconcile contract
        run: npm run test:contract:terminal-pane-grid-reconcile
```

An unwired contract is a contract that rots. The repo has been actively closing this gap — see commit `cd77b3f` "Wire two more contract suites into CI".

## Verification Plan

> This planning pass ran **no** builds and **no** tests (session directive). Every command below is for the implementer.

**Automated**
1. `npm run test:contract:terminal-pane-grid-reconcile` — the new contract passes.
2. `npm run test:contract:shell-terminal-strip` — the canary. It slices `terminals.js` between `('function setFocusedPane(index) {', 'function renderPaneGrid() {')` and `('function renderPaneGrid() {', 'function resolveFlooredLayout() {')`, so the restructure lands squarely inside its second span. If it fails, confirm whether the failure is behavioural or just span drift before touching the test.
3. `npm run test:contract:terminal-solo-popout`, `test:contract:terminal-flow-control`, `test:contract:terminal-input-path`, `test:contract:terminal-token-transport`, `test:contract:terminal-operations-no-periodic-reopen` (the last two run via `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/<file>` if no script exists yet) — the rest of the terminal contract set stays green.
4. `npm run compile` — webpack, preceded by `scripts/sync-webview-vendor.js`. Then **sync to the installed extension folder and reload the window**: the running extension loads from `~/.<ide>/extensions/turnzero.switchboard-*/dist/`, so a repo-only build is not live.

**Manual — the DOM invariant (this is the real test)**
5. Open the browser Terminals panel with 9 terminals across a `3x3` layout. In DevTools, select the `.terminal-view-host` inside pane 0 and "Store as global variable" (`temp1`).
6. Trigger a render that changes nothing structural — let an agent finish so an `agentCompleted` badge lands, or click `clear` on a different pane. **Expect:** `temp1 === $0` after re-selecting the same element, and Elements does not flash the node as re-inserted. Previously every such render re-created it.
7. Switch `3x3` → `1`. **Expect:** pane 0's `.terminal-view-host` is still `temp1`.

**Manual — the reported repro**
8. With 9 terminals across `3x3` and real full-screen TUI output in each pane, click the single-pane layout button. **Expect:** the terminal fills the pane immediately, content reflowed to the new width, no dead space.
9. Repeat step 8 ten times, cycling which terminal occupies pane 0 between runs. **Expect:** 10/10. The intermittency is the bug, so the repeat count *is* the test — one pass proves nothing.
10. Walk `1 → 2h → 2v → 2x2 → 2x3 → 3x3 → 1` and back down. **Expect:** every rendered pane matches its box at every step; button labels switch to `c`/`h` at `2x3`/`3x3` and back to `clear`/`hide` below that.

**Manual — regression surface the restructure touches**
11. Click into a pane and type. While typing, let an unrelated terminal finish (badge) or trigger a `terminalsChanged` refresh (create a terminal from the sidebar). **Expect:** the caret stays where you put it and no keystrokes are lost. This should be *better* than before, since the teardown that ate the caret is gone.
12. **The focus-theft check.** Click empty page background (so `document.activeElement` is `<body>`), then trigger a badge render. **Expect:** focus stays on `<body>` — the grid must **not** grab the caret. Repeat with the caret in a sidebar inline-rename input; it must survive.
13. **The focus-restore check.** Put the caret in pane 8 of a `3x3`, then switch to `1`. **Expect:** the caret lands in pane 0 rather than being lost to `<body>`.
14. Click a pane's `hide` button. **Expect:** the pane shows the "Click terminal in sidebar to assign" placeholder, the terminal keeps running in the sidebar, and the undo toast restores it to the same pane.
15. Click a pane's `clear` button on a pane whose assignment changed since the pane element was created: assign `A` to pane 0, switch it to `B`, then click `clear`. **Expect:** `B` is cleared, not `A`. This is the stale-closure regression the reuse introduces.
16. Click a terminal in the sidebar to seat it in the focused pane. **Expect:** one click both seats it and gives it the caret (the two-click regression `setFocusedPane` was written to avoid must not return).
17. Use the shell's terminal strip to focus a terminal (`focusTerminal` message arm). **Expect:** it is seated and focused, and the DONE light clears.
18. Pop a terminal out (`?solo=`). **Expect:** the solo window renders one pane; the "Connecting…" / not-found states from `checkSoloNotFound` still work (kill the terminal from the main window and confirm the solo window reports it).
19. Narrow the window until the `3x3` floor trips (750×450 — `LAYOUTS`, `terminals.js:462`). **Expect:** the fallback banner appears, the layout demotes, surplus panes are removed and the surviving panes are correctly sized.
20. **The parked-terminal check.** From `3x3` with all nine seated, switch to `1`, wait 20 seconds (past `DETACH_GRACE_MS`, `terminals.js:135`), then switch back to `3x3`. **Expect:** all nine panes repopulate immediately with their scrollback intact — the parked terminals must **not** have been destroyed. This is the behaviour the `paneAssignments.includes` sweep protects.
21. Leave the panel at `3x3` for a few minutes with active output. **Expect:** no growth in listener count (DevTools → Performance monitor → "Event listeners" stays flat). A reused element with per-render `addEventListener` would climb — this is the check for the one failure mode the restructure introduces.

## Resolved Assumptions

External research was run and closed both open questions. **This section is authoritative — do not re-open these during implementation.**

- **A dependency upgrade does not make this plan unnecessary.** Every xterm release through 6.0.0 keeps the `IntersectionObserver`-driven `RenderService` pause, its deferred resize task and its last-record-only batch read; no changelog entry, commit or PR in 5.6.0 or 6.0.0 touched the architecture, because the pause is a deliberate performance feature rather than a bug awaiting a fix. Upstream also still offers no public force-resize API. So the premise here holds at 5.5.0 and at 6.0.0 alike: the only way to stop losing the race is to stop entering it. Upstream corroboration for the defect class: xterm.js issues #3118, #3029, #2643, #4338, #4841 and #5298 all describe fits against detached, hidden or re-parented terminals producing invalid dimensions or a stale canvas, and the maintainer-endorsed remedy is exactly this plan's thesis — keep the DOM node attached and stable rather than re-parenting it.
- **rAF-before-IntersectionObserver is normative, but delivery can still slip a frame.** The HTML Living Standard's "update the rendering" steps order `requestAnimationFrame` callbacks before the intersection-observation step in every compliant engine, so the race described in fact 1 is real as stated. Under main-thread pressure, Gecko and WebKit may additionally defer IntersectionObserver *task delivery* to the next event-loop turn where Chromium dispatches it in microtasks — which widens the window rather than closing it. The explanation stands; if anything the race is worse on Firefox and Safari than the original write-up implied.

No further research is needed for this plan.

## Recommendation

**Complexity 7 → Send to Lead Coder.** Multi-function restructure of the panel's central render path, with a deliberate behavioural change to focus handling and three stale-closure / lifetime hazards that only appear once elements are reused.

## Completion Report

- **What was implemented:** Reconciled terminals pane grid in-place (`renderPaneGrid`) instead of tearing down the DOM and re-parenting every live xterm on every render. Extracted `createPaneElement`, `isTerseLayout`, and `updatePaneElement` helpers. Preserved caret focus state conditionally when displaced by grid reconciliation, attached element listeners once at creation time, re-derived button labels and pane headers dynamically, and added contract unit tests.
- **Files changed:** `src/webview/terminals.js`, `src/test/terminal-pane-grid-reconcile-contract.test.js`, `package.json`, `.github/workflows/integration-tests.yml`, `src/test/shell-terminal-strip.test.js`.
- **Issues encountered:** Adjusted caret-restore assertion in `shell-terminal-strip.test.js` to match the new conditional focus restore predicate (`hadFocus && !paneGridEl.contains(document.activeElement)`).
