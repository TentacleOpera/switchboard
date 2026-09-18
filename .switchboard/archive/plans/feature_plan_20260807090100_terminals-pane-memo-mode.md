# Open the Memo as a Shell Modal Instead of a Full-Screen Panel

## Goal

Make the Memo rail icon in `src/webview/shell.html` open the **existing** memo screen as a modal overlay on top of whatever panel is active, instead of switching the whole content area to it. The memo then becomes reachable from anywhere in the cockpit — including mid-session with the Terminals grid up — without losing the screen you were on.

> **Filename note.** This file keeps its original name (`feature_plan_20260807090100_terminals-pane-memo-mode.md`) because the path is the board's key for this card. The plan it holds was **replaced** — see the superseded callout below. Read the title, not the slug.

> **Superseded: "Add a Memo Pane Mode to the Terminals Grid, Alongside Kanban Mode" (complexity 6).**
> **What it proposed:** widen `paneModes` in `src/webview/terminals.js` from `'terminal' | 'kanban'` to a third `'memo'` value, reclassify ~18 hardcoded `=== 'kanban'` comparisons into `isBoardMode` / `isNonTerminalMode` predicates, and build a *second* memo implementation — `renderMemoPane`, `loadMemoPane`, `scheduleMemoSave`, `flushMemoPane`, `flushMemoPaneOnUnload`, `clearMemoPane`, `sendMemoPane`, `setMemoStatus` plus its own workspace picker — inside the terminals panel.
> **Reason:** the cost was almost entirely in *re-implementing a screen that already exists* and in the teardown discipline that a pane-mounted editor forces. A pane's DOM is destroyed on layout change, mode change, displacement and pop-out, so every one of those paths needed a flush-before-teardown rule, and one missed path (`toggleFocusedPaneKanban`) silently ate the operator's typing. That is a lot of failure surface for "let me jot something down". The user's read — *too clunky* — is correct: the goal was never "a memo inside a terminal pane", it was "reach the memo without leaving what I'm doing".
> **Replaced with:** this plan. The shell already mounts `/memo` as a live iframe at start-up and merely hides it when another panel is selected. Presenting that same frame as an overlay instead of a full-area panel gets the identical outcome with **zero** new memo code, **zero** changes to `memo.html` / `memo.js`, and **zero** teardown risk — the frame is never destroyed, so nothing can be lost.

### Problem analysis and root cause

The shell (`src/webview/shell.js`) mounts **every** enabled panel as a same-origin iframe up front and switches between them by toggling `.is-active` — "All panels stay mounted as iframes (state + live WebSocket preserved across switches)" (`shell.html:12-13`). `selectPanel` (`shell.js:32-44`) is a pure display toggle plus a hash write.

So the memo iframe is *already alive and already loaded* the entire time the cockpit is open. The only thing standing between the operator and their memo is that reaching it means **replacing** the content area — losing sight of the board, or of a 3x3 terminal grid mid-dispatch. That is the whole problem, and it is a presentation problem, not a capability problem.

The root cause is that `shell.js` has exactly one presentation mode. Every manifest entry is a full-area frame selected by the rail; there is no notion of a panel that overlays. The manifest (`getPanelsManifest`, `headlessPanelHtml.ts:496-515`) is explicitly the shell's data-driven extension point — it already carries a `placement` marker for rail position — so the fix is a second marker on the same manifest and a small branch in the shell that honours it.

### Why this is cheap where the pane version was expensive

The three risks that dominated the superseded plan all disappear by construction:

| Superseded risk | Why it is gone |
| --- | --- |
| Unflushed text lost on teardown (5 paths) | Closing the modal sets `display: none` on the host. The iframe is **never removed, never re-`src`'d, never reloaded** — its document, its 800 ms autosave debounce (`memo.js:219-233`), its WebSocket and its unsaved text all keep running exactly as they do today when you switch panels. There is no teardown to flush against. |
| Predicate reclassification across `terminals.js` | Not touched. `terminals.js` is not in this plan's file list at all. |
| Cross-surface clobber (pane's `memoLoad` retargeting the memo panel) | There is only ever **one** memo surface in the browser cockpit — the same one there is today. No second editor, no second `memoLoad`, no untagged-broadcast race. |

The `memoLoad` / `memoSave` / `memoClear` / `memoGeneratePrompt` / `memoListWorkspaces` verbs, the workspace picker, the send/copy/clear buttons, the post-click-typing guard and the `memoCleared`-not-`success` clear gate are all **already implemented and shipped** in `memo.js`. This plan reuses them untouched.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, ux, browser-shell
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- A `presentation?: 'panel' | 'modal'` field on `PanelManifestEntry` and one marker on the memo entry.
- A modal host (backdrop + dialog + close button) built in `shell.js` and appended to `#content`.
- CSS for the host in `shell.html`.
- Close on: the × button, backdrop click, Escape, and selecting another rail panel.

### Complex / Risky
- **`selectPanel` is called from four places, not one** — the rail click handler (`shell.js:172`), the `switchPanel` postMessage bridge (`shell.js:485`), the `hashchange` handler (`shell.js:498`) and the load-time deep link (`shell.js:459`). A modal id must be intercepted in `selectPanel` itself, not in the click handler, or `/#memo` and any future `openMemoPanel` bridge silently activate a frame that is parented to the modal host and therefore paints nothing. (Today nothing posts `switchPanel` for memo — `PANEL_SWITCH_VERBS` in `transport.js:231-239` has no memo entry — but the deep link already exists and works.)
- **The frame stays in the `frames` map but leaves `#content`.** `applyThemeToAll` (`shell.js:212-216`) iterates `frames` to fan the theme out to every panel; drop the memo frame from that map and the memo silently stops following theme switches. Re-parent it, do not unregister it. Correspondingly, `selectPanel`'s two toggle loops must **skip** modal ids, or selecting Board strips `.is-active` off the memo frame and un-highlights it while the modal is open.
- **Escape does not cross the iframe boundary.** With focus in the memo textarea, a `keydown` listener on the shell document receives nothing. The frame is same-origin (CSP `frame-src 'self'`, route `/memo` on the same host), so the shell can attach a `keydown` listener to `frame.contentDocument` — but only after load, and the load may already have happened by the time the modal is first opened. Handle both.
- **`src/test/shell-terminal-strip.test.js` asserts on shell source text.** Two assertions are directly in this change's path: the body-markup regex `/<div id="content"><\/div>\s*<div id="tooltip-overlay"><\/div>/` (line 381) means the modal host **must not** be authored in `shell.html`'s body — build it in JS; and `!/\.title\s*=/.test(shellJs)` (line 395) means the close button must use `data-tooltip`, never a native `title`.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - **None of the pane plan's races survive.** No second memo editor exists, so the untagged `memoContent` broadcast (`TaskViewerProvider.ts:12673` → `wsHub.ts:316`) still has exactly one recipient, as today.
  - **Close during a pending save.** The debounce timer lives in the iframe's own document and keeps running while the host is `display: none` — the page is visible, only an element is hidden, so no timer throttling applies. The save fires and lands. Explicitly **do not** add a flush-on-close: it would duplicate `memo.js`'s own save path and reintroduce the two-writer problem this plan exists to avoid.
  - **Open during a pending save.** Opening only unhides; the iframe is not reloaded and no `memoLoad` is re-issued, so a pending debounce cannot be clobbered by a fresh load.
- **Security:** No new endpoint, no new verb, no auth surface. `/panels` gains one string field; `/memo` is unchanged. No new origin is framed — the dialog holds the same same-origin iframe the shell already mounts, under the shell's existing `frame-src 'self'` CSP.
- **Side Effects:**
  - **The memo stops being a full-screen destination in the browser shell.** That is the ask. Direct navigation to `/memo` still serves the full page (`LocalApiServer.ts:3681-3682`, unchanged), and the VS Code sidebar Memo sub-tab is a different surface entirely and is untouched.
  - **`/#memo` changes meaning:** it no longer selects a panel, it opens the modal over the default panel. Preserved as a working deep link, with different mechanics.
  - **The hash is deliberately not written when the modal opens.** One hash slot cannot encode both "which panel" and "modal open" without losing the panel across a reload, and the panel is the more valuable half. Consequence, accepted: the open modal is not bookmarkable and survives no reload.
  - **Terminal pop-outs (`/terminals?solo=…`, `shell.js:360`) have no rail and therefore no memo.** Unchanged from today. Out of scope.
  - Selecting another rail panel closes the modal. Deliberate: clicking Board while the memo floats over it reads as navigation, and the memo is one click away again.
- **Dependencies & Conflicts:**
  - Files: `src/webview/shell.js`, `src/webview/shell.html`, `src/services/headlessPanelHtml.ts`, `src/services/LocalApiServer.ts` (one type widening), plus a new test file.
  - **No conflict with the sibling subtask.** The ALL CODED plan (`feature_plan_20260807090200_terminals-kanban-pane-all-coded-aggregate-column.md`) is confined to `terminals.js` / `terminals.html`. This plan touches neither. The two are now **fully independent and may run in parallel** — the previous revision's strict serialisation constraint was a consequence of the pane design and is void.
  - **No `protocol-catalog.json` regeneration.** `/panels` is already catalogued as a GET route (`protocol-catalog.json:26025`); the catalog records the route, not the response body's fields.
  - **No migration.** The manifest is computed per request and never persisted; nothing on disk or in `kanban.db` records a panel's presentation.
  - `getPanelsManifest` has two callers — `bootstrap.ts:619` (standalone) and `TaskViewerProvider.ts:2402` (extension-hosted). Both get the change with no call-site edit.

## Dependencies

- None. Self-contained; nothing must land first.

## Adversarial Synthesis

**Risk Summary:** The load-bearing risk is a **partial interception of `selectPanel`** — the memo frame lives in the modal host, so any path that reaches it through the normal panel machinery (deep link, hashchange, a future `switchPanel` bridge) activates a frame nobody can see, and the symptom is a blank content area rather than an error. Intercepting inside `selectPanel` rather than at the click site closes every path at once. Second: **dropping the memo frame from the `frames` map** while re-parenting it, which silently severs theme fan-out — re-parent, never unregister, and make `selectPanel`'s toggle loops skip modal ids instead. Third: **Escape not reaching the shell** from inside the iframe, which makes the modal feel stuck for anyone typing — solved with a same-origin `contentDocument` listener attached on load *and* on first open. Everything else the superseded plan feared (flush discipline, teardown ordering, cross-surface clobber) is structurally absent here because the iframe is only ever hidden, never destroyed.

## Proposed Changes

### 1. `src/services/headlessPanelHtml.ts` — a presentation marker on the manifest

Add to `PanelManifestEntry` (beside the existing `placement` marker, line 470-489):

```ts
    /**
     * How the shell presents this panel. Omitted (or 'panel') = a full-area frame
     * in #content, selected by the rail — the default for every panel.
     * 'modal' = the frame is mounted in the shell's modal host and the rail icon
     * TOGGLES an overlay above whatever panel is active, so the panel is reachable
     * without losing the current screen.
     *
     * A marker rather than a separate manifest, for the same reason `placement`
     * is: the shell stays data-driven and the route is unaffected either way —
     * /memo continues to serve the full page for direct navigation and for the
     * VS Code webview.
     */
    presentation?: 'panel' | 'modal';
```

and mark the memo entry (line 507):

```ts
        { id: 'memo', label: 'Memo', icon: `${iconDir}/nav-memo.svg`, route: '/memo', enabled: true, presentation: 'modal' },
```

### 2. `src/services/LocalApiServer.ts` — widen the injected manifest type

`_handleServePanels` does `JSON.stringify(manifest)` (line 783), so extra fields already reach the wire — `placement` has been flowing through untyped since it was added. The declared option type (line 350) should say so rather than rely on that:

```ts
        getPanelsManifest?: () => Array<{
            id: string; label: string; icon: string; route: string; enabled: boolean;
            // Presentation markers pass straight through to /panels — declared here so
            // the wire shape is visible at the boundary that serialises it.
            placement?: string; presentation?: string;
        }>;
```

Behaviour-neutral; it only stops a future reader from "tidying away" a field the shell depends on.

### 3. `src/webview/shell.js` — modal host and presentation branch

**Build the host in JS, not in `shell.html`.** `src/test/shell-terminal-strip.test.js:381` asserts that `#content` and `#tooltip-overlay` are adjacent, empty, body-level siblings — that assertion encodes the tooltip-clipping root cause and must not be weakened. The host is a child of `#content` (which is already `position: relative`), which also means **the rail stays visible and clickable beside the modal**, and the body-level `#tooltip-overlay` (`position: fixed; z-index: 9999`) still paints above everything.

```js
    const modalPanels = new Set();   // manifest ids with presentation === 'modal'
    let openModalId = null;
    let modalReturnFocus = null;
    let modalHost = null, modalDialog = null;

    function ensureModalHost() {
        if (modalHost) { return modalHost; }
        modalHost = document.createElement('div');
        modalHost.id = 'modal-host';
        modalHost.setAttribute('role', 'dialog');
        modalHost.setAttribute('aria-modal', 'true');

        const backdrop = document.createElement('div');
        backdrop.id = 'modal-backdrop';
        backdrop.addEventListener('click', closeModal);
        modalHost.appendChild(backdrop);

        modalDialog = document.createElement('div');
        modalDialog.id = 'modal-dialog';

        const closeBtn = document.createElement('button');
        closeBtn.id = 'modal-close';
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close');
        // data-tooltip, never .title — shell.js is asserted free of native title
        // tooltips (shell-terminal-strip.test.js:395); a native one would
        // double-fire beside the styled overlay.
        closeBtn.dataset.tooltip = 'Close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', closeModal);
        modalDialog.appendChild(closeBtn);

        modalHost.appendChild(modalDialog);
        content.appendChild(modalHost);
        return modalHost;
    }
```

**Open / close are display toggles only.** This is the invariant the whole plan rests on — never remove the frame, never reassign `frame.src`:

```js
    /** Show a modal panel over the current one. The frame is only UNHIDDEN: its
     *  document, its live WebSocket, its pending autosave debounce and any text
     *  the operator has typed all survive, exactly as they do when panels are
     *  switched. Nothing here may destroy or reload the frame. */
    function openModal(id) {
        const frame = frames.get(id);
        if (!frame) { return; }
        ensureModalHost();
        modalHost.classList.add('is-open');
        modalHost.setAttribute('aria-label', frame.getAttribute('aria-label') || id);
        openModalId = id;
        const icon = icons.get(id);
        if (icon) { icon.classList.add('is-active'); icon.setAttribute('aria-expanded', 'true'); }
        modalReturnFocus = icon || null;
        focusModalContent(frame);
    }

    function closeModal() {
        if (!openModalId) { return; }
        const icon = icons.get(openModalId);
        if (icon) { icon.classList.remove('is-active'); icon.setAttribute('aria-expanded', 'false'); }
        if (modalHost) { modalHost.classList.remove('is-open'); }
        openModalId = null;
        // No flush, no save, no postMessage on the way out: memo.js owns its own
        // debounced save and the frame is still alive to run it. Adding a second
        // writer here is exactly the two-writer hazard this design removes.
        if (modalReturnFocus) { try { modalReturnFocus.focus(); } catch { /* ignore */ } }
        modalReturnFocus = null;
    }

    function toggleModal(id) {
        if (openModalId === id) { closeModal(); } else { openModal(id); }
    }
```

**Same-origin reach into the frame** — for Escape and for initial focus. Attached on `load` and re-attempted on open, because the frame may already have loaded long before the modal is first used:

```js
    /** The frame is same-origin (frame-src 'self', /memo on this host), so the
     *  shell can listen inside it. Without this, Escape while typing in the memo
     *  textarea reaches nothing and the dialog feels stuck. */
    function wireModalFrameKeys(frame) {
        try {
            const doc = frame.contentDocument;
            if (!doc || doc.dataset && doc.dataset.sbModalKeys === '1') { return; }
            if (doc.documentElement && doc.documentElement.dataset.sbModalKeys === '1') { return; }
            doc.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { closeModal(); }
            });
            if (doc.documentElement) { doc.documentElement.dataset.sbModalKeys = '1'; }
        } catch { /* cross-origin or not yet loaded — retried on open */ }
    }

    function focusModalContent(frame) {
        wireModalFrameKeys(frame);
        try {
            const doc = frame.contentDocument;
            const ta = doc && doc.querySelector('textarea');
            if (ta) { ta.focus(); return; }
        } catch { /* ignore */ }
        try { frame.focus(); } catch { /* ignore */ }
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && openModalId) { closeModal(); }
    });
```

**Intercept in `selectPanel`, not at the click site** — this is what keeps the deep link, `hashchange` and the `switchPanel` bridge correct, and what stops a non-modal selection from stripping the modal frame's state:

```js
    function selectPanel(id) {
        if (!frames.has(id)) { return; }
        // A modal panel is never "the active panel" — it overlays one. Every
        // caller (rail click, hash deep-link, hashchange, the switchPanel bridge)
        // funnels through here, so intercepting at this single point is what
        // keeps them all correct.
        if (modalPanels.has(id)) { openModal(id); return; }
        closeModal();                       // navigating away dismisses the overlay
        activePanel = id;
        for (const [pid, frame] of frames) {
            if (modalPanels.has(pid)) { continue; }   // modal frames are shown by the host, not by is-active
            frame.classList.toggle('is-active', pid === id);
        }
        for (const [pid, icon] of icons) {
            if (modalPanels.has(pid)) { continue; }   // the modal icon lights only while its overlay is open
            icon.classList.toggle('is-active', pid === id);
        }
        if (window.location.hash !== '#' + id) {
            try { history.replaceState(null, '', '#' + id); } catch { /* ignore */ }
        }
    }
```

**`defaultPanelId`** skips modal entries — a modal can never be the landing screen:

```js
        for (const p of manifest) {
            if (p.enabled === false) { continue; }
            if (p.presentation === 'modal') { continue; }
            return p.id;
        }
```

**`buildIcon`** — a modal entry's icon is a button that opens a dialog, not a tab:

```js
        if (panel.presentation === 'modal') {
            btn.role = 'button';
            btn.setAttribute('aria-haspopup', 'dialog');
            btn.setAttribute('aria-expanded', 'false');
        } else {
            btn.role = 'tab';
        }
```
and its click handler calls `toggleModal(panel.id)` instead of `selectPanel(panel.id)` (clicking the lit icon closes).

**`buildFrame` / `renderManifest`** — register modal ids, and parent their frames to the dialog. The frame stays in `frames` so `applyThemeToAll` (`shell.js:212-216`) still reaches it:

```js
        if (panel.presentation === 'modal') {
            modalPanels.add(panel.id);
            frame.className = 'modal-frame';
            frame.addEventListener('load', () => wireModalFrameKeys(frame));
            ensureModalHost();
            modalDialog.appendChild(frame);
        } else {
            content.appendChild(frame);
        }
```

**Load-time deep link** (`shell.js:457-459`) — `#memo` opens the default panel *and* the modal, so a reload from a bookmarked `#memo` still lands on a usable cockpit:

```js
        const hash = window.location.hash.replace(/^#/, '');
        if (hash && modalPanels.has(hash)) {
            const base = defaultPanelId(manifest);
            if (base) { selectPanel(base); }
            openModal(hash);
        } else {
            const initial = (hash && frames.has(hash)) ? hash : defaultPanelId(manifest);
            if (initial) { selectPanel(initial); }
        }
```

The `hashchange` handler needs no change beyond routing through `selectPanel`, which now intercepts modal ids itself.

### 4. `src/webview/shell.html` — modal CSS

Add after the `.panel-frame` rules (line 144-153). Note the host is scoped **inside `#content`**, which is what leaves the rail visible and interactive:

```css
        /* Modal panel host — a panel presented as an overlay (manifest
           presentation:'modal') rather than as the content area. Scoped inside
           #content on purpose: the rail stays visible and clickable beside it,
           and the body-level #tooltip-overlay (fixed, z-index 9999) still paints
           above. The host is built by shell.js, never authored here — shell.html's
           body markup is asserted to be exactly #strip / #content /
           #tooltip-overlay. */
        #modal-host { position: absolute; inset: 0; z-index: 10; display: none; }
        #modal-host.is-open { display: block; }
        #modal-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.62); }
        #modal-dialog {
            position: absolute;
            top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            width: min(820px, 92%);
            height: min(700px, 88%);
            background: var(--bg-elev);
            border: 1px solid var(--border);
            border-radius: 8px;
            box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
            overflow: hidden;
            display: flex;
        }
        /* A modal frame is shown by its HOST, never by .is-active — selectPanel
           skips modal ids for exactly this reason. */
        .modal-frame {
            flex: 1 1 auto;
            width: 100%;
            height: 100%;
            border: none;
            background: var(--bg);
            display: block;
        }
        #modal-close {
            position: absolute;
            top: 6px; right: 8px;
            z-index: 1;
            width: 26px; height: 26px;
            border: 1px solid transparent;
            border-radius: 4px;
            background: transparent;
            color: var(--text-dim);
            font-family: var(--font);
            font-size: 18px;
            line-height: 1;
            cursor: pointer;
        }
        #modal-close:hover { background: var(--bg); color: var(--text); border-color: var(--border); }
```

## Verification Plan

### Automated Tests

Add `src/test/shell-modal-panel-contract.test.js` — a source-assertion suite in the style of `shell-terminal-strip.test.js`, encoding the four invariants whose violation is silent rather than loud:

1. The memo manifest entry carries `presentation: 'modal'` (line-scoped regex over `headlessPanelHtml.ts`, matching the `placement` assertion's style at `shell-terminal-strip.test.js:414`).
2. `selectPanel` intercepts modal ids **before** it assigns `activePanel` — `modalPanels.has(id)` must appear ahead of `activePanel = id` in the function body. A partial interception paints a blank content area, not an error.
3. Both `selectPanel` toggle loops skip modal ids (`modalPanels.has(pid)) { continue; }` appears twice inside the function).
4. `closeModal` never destroys the frame — the function body must contain no `.src =`, no `.remove()` and no `frames.delete(`. This is the invariant that replaces the superseded plan's entire flush-discipline section.
5. `shell.js` still sets no native `title` tooltips (re-assert `!/\.title\s*=/`) — a cheap guard against the close button reintroducing one.

The existing `src/test/shell-terminal-strip.test.js` must stay green unmodified — in particular its body-markup regex (line 381), which is why the modal host is built in JS.

Run `node src/test/shell-modal-panel-contract.test.js` and `node src/test/shell-terminal-strip.test.js`, plus `npx tsc --noEmit -p tsconfig.json` for the two `.ts` edits.

### Manual

1. **Open.** Load the browser cockpit (`/`). Click the Memo rail icon. The memo opens as a centred dialog over the current panel, the panel remains visible behind a dimmed backdrop, and the rail stays visible and clickable at the left.
2. **Rail icon state.** The Memo icon is highlighted while the modal is open; the underlying panel's icon **stays** highlighted too (it is still the active panel).
3. **From the Terminals grid.** Select Terminals, then open the memo. The grid keeps running behind the dialog — no pane is reflowed, no terminal is torn down, no layout is lost.
4. **It is the real memo.** The dialog shows the shipped memo screen: workspace picker, hint text, textarea, Clear / Copy Prompt / Send to Planner. Type three lines, wait ~1 s, see `Saved`, and confirm the text is in `.switchboard/memo.md` on disk.
5. **Close: ×.** Click the × in the dialog's top-right. The overlay closes; the underlying panel is untouched.
6. **Close: backdrop.** Reopen, click the dimmed area outside the dialog. It closes. Clicking *inside* the dialog does not.
7. **Close: Escape from the textarea.** Reopen, click into the textarea, type, press Escape. It closes — this is the same-origin `contentDocument` listener; without it Escape does nothing while typing.
8. **Close: toggle.** Reopen, then click the Memo rail icon again. It closes.
9. **State survives a close/open cycle.** Type text, close before the 800 ms debounce fires, reopen. **The text is still there**, and it reached the file — the iframe was only hidden. This is the single most important check in this plan.
10. **Navigating away closes it.** With the modal open, click Board. The modal closes and Board is shown.
11. **Deep link.** Load `/#memo` fresh. The default panel (Board) is shown *behind* an open memo modal.
12. **Hash tracks the panel, not the modal.** Select Project, open the memo, then reload. You land back on Project with the modal closed — the deliberate one-slot decision.
13. **Theme fan-out still reaches it.** With the modal open, click the rail's theme toggle. The memo repaints with the rest of the cockpit (this is the `frames`-map registration; a re-parented-but-unregistered frame would stay on the old theme).
14. **Send to Planner still works.** With a planner terminal open, click Send to Planner from inside the modal. The prompt dispatches, the textarea clears, and `.switchboard/memo.md` is empty on disk — no behaviour change from the full-screen memo.
15. **Workspace picker still works.** Switch the memo's workspace inside the modal; confirm it loads that workspace's memo and saves back to it.
16. **Rail tooltips paint above the modal.** With the modal open, hover a rail icon. The tooltip is fully visible over the backdrop (body-level `position: fixed`, `z-index: 9999`).
17. **No other panel changed presentation.** Board, Project, Tickets, Artifacts, Design, Connections, Terminals and Setup all still open full-area, and Setup is still in the bottom rail cluster.
18. **Direct route unaffected.** Navigate straight to `/memo`. The full-page memo still renders as before.
19. **Small viewport.** Narrow the window to ~700px. The dialog clamps to 92% width / 88% height, the memo body scrolls inside it, and the close button stays reachable.

## Recommendation

**Complexity 3 → Send to Coder.**

## Completion Report

Implemented the memo-as-modal overlay. Added `presentation?: 'panel' | 'modal'` to the panel manifest, marked the memo entry as `presentation: 'modal'`, widened `LocalApiServer.ts` to pass the field through, and rewrote `src/webview/shell.js` with `openModal` / `closeModal` / `toggleModal` helpers, same-origin frame key capture, modal host construction, and interception in `selectPanel`. Added modal CSS to `src/webview/shell.html` and added `src/test/shell-modal-panel-contract.test.js` to pin the four silent invariants. No tests or compilation were run per the session directive.

## Review Findings

Reviewer pass 2026-08-11. Two fixes applied: `src/test/shell-modal-panel-contract.test.js:63` was **red on arrival** — its `/\.remove\(/` guard matched `classList.remove('is-active')` inside `closeModal`, so the plan's load-bearing "never destroy the frame" invariant failed against a correct implementation (masked `classList.remove` before the structural check); and the test was defined but invoked by nothing, so it was wired as `test:contract:shell-modal-panel` in `package.json` and added as a CI step in `.github/workflows/integration-tests.yml` beside its `shell-terminal-strip` sibling. Regression tracing cleared the plan's three named hazards: the memo frame stays in the `frames` map so `applyThemeToAll` still reaches it, `panelVisibility` has exactly one consumer (`terminals.js:964`) so the memo losing it is inert, `.panel-frame` has a single reference (`buildFrame:379`) so the `className` reassignment orphans nothing, and every `selectPanel` caller (rail click, `#memo` deep link, `hashchange`, the `switchPanel` bridge) funnels through the single interception. Files changed by this pass: `src/test/shell-modal-panel-contract.test.js`, `package.json`, `.github/workflows/integration-tests.yml`. Validation: `tsc --noEmit` clean apart from 5 pre-existing TS2835 dynamic-import errors present verbatim at HEAD; `shell-modal-panel` 6/6, `shell-terminal-strip` 40/40, plus 11 adjacent panel/terminal contracts all green — remaining risk is cosmetic only (no focus trap; `role="button"` inside `#strip`'s `role="tablist"`, matching the pre-existing theme-toggle and `role="group"` children).
