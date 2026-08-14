# Add View Button to Kanban-Mode Pane Cards in Terminals

## Goal

Give each plan row in the terminals page's kanban-mode pane a one-click jump to that plan's entry in the Project panel, using the same `reviewPlan` verb the Kanban board's review button already uses.

### Problem
The kanban-mode pane in `terminals.html` (rendered by `terminals.js`'s `renderKanbanPane`) shows a live column of plan cards inside a terminal grid slot. Each row currently has two action buttons: **link** (selects the plan in the TaskViewer via `/kanban/verb/selectPlan`) and **Copy Prompt** (copies the advance prompt via `/kanban/verb/promptSelected`).

There is no way from the kanban pane to jump directly to the **Project panel** entry for a plan or feature — the operator must manually switch to the Kanban board or the Project panel to read the full plan content. The Kanban board cards (`kanban.html`) already solve this with their **review** button (pencil icon), which posts a `reviewPlan` verb and switches the shell to the Project panel. The kanban pane lacks an equivalent affordance.

### Root Cause
`renderKanbanPane` builds each row's action group with only `link` and `Copy Prompt` buttons. It never calls the `reviewPlan` verb and never invokes `window.__switchboardSwitchPanel('project')`. The `reviewPlan` verb is already allowlisted for HTTP (`KANBAN_VERBS`) and already has a `__viaHttp` code path that pushes `activateKanbanTabAndSelectPlan` to the browser's Project panel over WS — exactly the path the board's review button uses. The kanban pane simply does not wire to it.

> **Superseded:** The line references in the original Root Cause and audit sections — `renderKanbanPane` at terminals.js:2580–2892, the `__viaHttp` path at KanbanProvider.ts:9904–9916, the card shape at KanbanProvider.ts:7392–7406, the board review button at kanban.html:6574–6575, the drag-disarm listener at terminals.js:442–457, the `reviewPlan` schema at verbSchemas.ts:1468, the CSS block at terminals.html:1019–1031, and the transport injection at headlessPanelHtml.ts:74.
> **Reason:** Every one of those anchors is stale — the files have moved on and a coder following them would edit the wrong region (e.g. terminals.js:2580 lands inside `updatePaneElement`'s curtain handling, not the kanban pane; terminals.html:1019 lands mid-`.kanban-pane-row`, not on a button rule).
> **Replaced with:** Verified anchors at HEAD (2026-08-08):
> - `renderKanbanPane` — `src/webview/terminals.js:2759`; body-signature gate at `2888–2891`; row/button construction `3002–3066`.
> - Insert point for the new button — immediately after `btnGroup.appendChild(linkBtn);` at `src/webview/terminals.js:3023`, before `const copyBtn = …` at `3025`.
> - Drag-disarm `pointerdown` listener — `src/webview/terminals.js:450–468`.
> - `reviewPlan` arm — `src/services/KanbanProvider.ts:9926`; `__viaHttp` WS-only branch at `9950–9962`.
> - Card shape (`planId`, `sessionId`, `planFile`, `column`, `workspaceRoot`, `project`, `isFeature`, `subtaskCount`) — `src/services/KanbanProvider.ts:1866–1889` (active rows) and `1890–1904` (completed rows), built by `_buildBoardCards` (`1846`) and returned by the `getBoardCards` arm (`10741`).
> - Board review button — `src/webview/kanban.html:6620–6643`.
> - `reviewPlan` schema — `src/services/verbSchemas.ts:1473`; validator required/empty-string behaviour at `verbSchemas.ts:62–69`.
> - Pane button CSS — `.kanban-pane-copy-btn` at `src/webview/terminals.html:1096–1109`; `.kanban-pane-link-btn` at `1110–1122`.
> - `__switchboardSwitchPanel` — `src/webview/transport.js:349`; injected into the terminals page by `injectTransportShim` at `src/services/headlessPanelHtml.ts:407` (shim body at `73–88`).

## Metadata
- **Complexity:** 3
- **Tags:** frontend, ui, feature
- **Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- Pure UI addition inside one existing function plus one CSS selector list. No backend changes, no new verbs, no schema changes, no migrations.
- The `reviewPlan` HTTP verb and its `__viaHttp` WS-push path already exist and are exercised by `kanban.html`'s review button on every board render (`kanban.html:6620–6643` → `KanbanProvider.ts:9926`).
- `renderKanbanPane` already makes same-origin `fetch` calls to `/kanban/verb/*` (the `link` and `Copy Prompt` buttons at `terminals.js:3005–3065`), so the transport pattern is established and CSP-clean (`connect-src 'self'` in `getTerminalsHtml`'s CSP, `headlessPanelHtml.ts:397`).
- `window.__switchboardSwitchPanel` is injected by `transport.js:349` via `injectTransportShim` (`headlessPanelHtml.ts:407`) into the very same terminals document whose HTTP fetches already work.
- The card data from `getBoardCards` already carries every field the `reviewPlan` handler reads — `planId`, `sessionId`, `planFile`, `workspaceRoot`, `project`, `column`, `isFeature` (`KanbanProvider.ts:1866–1889`).
- Drag-disarm is generic: the global `pointerdown` listener disarms the row for **any** `<button>` inside a `.kanban-pane-row` (`terminals.js:450–468`), so a new button is covered with zero extra code.
- **Both hosts already have the arm.** The standalone host has its own `reviewPlan` case (`src/standalone/bootstrap.ts:1086–1108`) that broadcasts the same `activateKanbanTabAndSelectPlan` on the `project` surface. PRD contract #7 (two-layer completion) is satisfied by existing code; this change adds no new Layer-1 or Layer-2 work.

### Complex / Risky
- **Failure honesty.** The verb can legitimately fail (`{ success:false, error:'Could not resolve session id' }` when a card carries neither `planId` nor `sessionId`). Switching panels on a failed verb produces a Project panel that shows nothing — a dead-click by PRD contract #6. The click handler must gate the panel switch on the returned `success`.
- **Row width.** `.kanban-pane-row-actions` is `flex-shrink: 0` (`terminals.html:1091–1095`) and `.kanban-pane-row-text` is `flex: 1; min-width: 0` (`1102–1107`). A third button takes roughly 34–40px permanently out of the plan title in every pane slot, and a 4-pane grid slot is already narrow. Mitigated by a 4-character label; the title already ellipsises.

## Edge-Case & Dependency Audit

### Race Conditions
1. **Panel switch vs. WS push.** The `activateKanbanTabAndSelectPlan` push is emitted inside the verb, so awaiting the response before switching guarantees the Project panel has already received it. There is no lost-message window regardless: the shell mounts **all** panel iframes up-front and toggles visibility (`shell.js:5`, `buildFrame` at `229`), so the Project panel's WS listener is live even while hidden.
2. **5s poll re-render vs. transient button state.** `renderKanbanPane` rebuilds the body only when `bodySig` changes (`terminals.js:2888–2891`). The signature covers card identity/topic/complexity/working/project/feature fields — not button state — so a poll tick with an unchanged card set leaves a transient `Failed` label intact. A tick that *does* change the card set wipes it, exactly as it already can for `Copy Prompt`'s `Copied!` state. Accepted, unchanged behaviour; do **not** add the button's state to `bodySig` (that would re-render the list on every state flip and reset its scroll).
3. **Disabled-button drag window.** While the button is disabled (in-flight fetch, or the 2s `Failed` window) a `pointerdown` on it does not reach the disarm listener, so the row stays draggable under the button. Harmless and short-lived; identical to the existing `Copy Prompt` disabled window.

### Security
- No new endpoint, no new verb, no new allowlist entry — `reviewPlan` is already in `KANBAN_VERBS` (`src/generated/verbAllowlist.ts:7`) and already reachable over HTTP from this origin.
- Payload is schema-validated at the HTTP boundary (`verbSchemas.ts:1473`). Undeclared fields (`planId`, `workspaceRoot`, `project`, `column`, `isFeature`) pass through by design — the validator only type-checks declared fields and rejects nothing extra (`verbSchemas.ts:57–76`).
- The verb is read/navigate-only: it resolves an id and pushes a selection message. No writes, no state mutation, no card movement. Unlike the neighbouring `Copy Prompt`, clicking it cannot advance a card.

### Side Effects
4. **`sessionId` is `required` but an empty string satisfies it.** The schema declares `sessionId: { type: 'string', required: true }`. The validator rejects only `undefined`/`null`; `''` is a present string and passes (`verbSchemas.ts:62–69`). The arm then resolves the real id via `_resolveSessionId(msg.planId, msg.sessionId)` (`KanbanProvider.ts:515–520`), which falls back to `planId`. Send `sessionId: card.sessionId || ''` and `planId: card.planId || ''` — byte-identical to what the board's review button sends.
5. **Feature cards.** Feature cards carry `isFeature: true` and `subtaskCount`. The arm forwards `isFeature` into `activateKanbanTabAndSelectPlan` (`KanbanProvider.ts:9948`), and `project.js:626–650` branches on it to open the **Features** tab and resolve a pending feature selection instead of the Kanban tab. Send `isFeature: card.isFeature || false`.
6. **`workspaceRoot` resolution.** The extension-host arm resolves an effective root from `msg.workspaceRoot` (`KanbanProvider.ts:9935–9939`). Cards carry `workspaceRoot`; fall back to `kanbanPaneWorkspace[index]`, the same fallback the `link` button uses (`terminals.js:3016`). The standalone arm ignores `payload.workspaceRoot` and stamps its own single `root` (`bootstrap.ts:1101`) — correct for a single-workspace `npx` host, and not something this change should try to alter.
7. **Contexts where the panel switch is a no-op.** `__switchboardSwitchPanel` posts `{type:'switchPanel'}` to `window.parent` and no-ops when the page is not iframed (`transport.js:343–357`).

> **Superseded:** "`window.__switchboardSwitchPanel` absent in VS Code webview … in the webview the kanban pane's HTTP fetches do not function anyway (no LocalApiServer origin), so this is a browser-cockpit-only affordance."
> **Reason:** The premise is wrong. `terminals.html` is **never** rendered as a VS Code webview — it has no `WebviewPanel`, no `package.json` command, and no provider that loads it. It is served only by `LocalApiServer` (`LocalApiServer.ts:3693`) through `headlessPanelHtml.getTerminalsHtml`, in both the extension host (`TaskViewerProvider.ts:2402`) and the standalone host (`bootstrap.ts:617`). The conclusion ("guard the call") is right; the reason given for it is not, and the reason is what a coder reasons from.
> **Replaced with:** The two real non-shell contexts are (a) a **solo popout window** opened from the rail — `window.open('/terminals?solo=<name>')`, `shell.js:373–400` — where `window.parent === window`; and (b) a bare `/terminals` tab opened directly, outside the shell. In both, the helper silently does nothing. Case (a) cannot arise in practice: solo mode suppresses the pane grid, and `toggleFocusedPaneKanban` returns early when `document.body` carries `is-solo` (`terminals.js:3078–3080`), so no kanban pane exists there. Case (b) is a deliberate developer route. Guard with `typeof window.__switchboardSwitchPanel === 'function'` — the same guard `kanban.html:6640` uses — and accept the no-op.

8. **Drag-disarm.** Automatically covered by the global listener (`terminals.js:450–468`); no per-button wiring.

### Dependencies & Conflicts
9. **Do not resurrect `viewPlan`.** The label is `view`, the verb is `reviewPlan`. A kanban-surface `viewPlan` verb (which opened a raw markdown preview) was **deliberately deleted**, and its removal is pinned by `src/test/kanban-view-plan-removal-regression.test.js` — that test asserts `kanban.html` contains no `type: 'viewPlan'`, `KanbanProvider.ts` contains no `case 'viewPlan'`, and `extension.ts` registers no `switchboard.viewPlanFromKanban`. A coder who "fixes" the verb name to match the label breaks that test and reintroduces removed behaviour. A code comment at the call site states this explicitly.
10. **One-stream discipline (PRD).** This change touches `src/webview/terminals.js` and `src/webview/terminals.html` only. Do not parallelise it with any other terminals-pane work; it does not touch `verbSchemas.ts`, so it does not serialise against the verb-engine burndown.
11. **Ratchet/parity gates unaffected.** No provider `break`→`return` conversions, no allowlist or catalog edits, so `verb-returns:check`, `parity:check`, and `push-routing:check` baselines are untouched.

## Dependencies

- None. No prior session's work is required; every verb, schema, seam, and WS route this change consumes already exists at HEAD in both hosts.

## Adversarial Synthesis

**Risk Summary.** The wiring is safe — `reviewPlan` is allowlisted, schema-permissive, WS-only under `__viaHttp`, and implemented in both hosts — so the residual risks are all presentation-layer: a click that switches panels after a failed verb reads as a broken Project panel (PRD contract #6), a third button squeezes an already-narrow row title, and the `view` label sits one careless refactor away from the deliberately-deleted `viewPlan` verb. Mitigations: gate the panel switch on the returned `success` and surface a 2s `Failed` state instead, keep the label to four characters and reuse the muted `.kanban-pane-link-btn` styling so teal stays reserved for the mutating `Copy Prompt`, and pin the verb choice with a call-site comment naming the removal regression test.

## Proposed Changes

### `src/webview/terminals.js` — add the View button in `renderKanbanPane`

Insert immediately after `btnGroup.appendChild(linkBtn);` (**line 3023**), before `const copyBtn = document.createElement('button');` (**line 3025**).

**Context.** `card` and `index` are in scope from the `for (const card of cards)` loop and the function parameter. `btnGroup` is the `.kanban-pane-row-actions` container created at line 3002.

**Logic.** POST the same payload the board's review button sends, await the response, and switch the shell to the Project panel **only** when the verb reports success.

> **Superseded:** Fire the fetch inside `try { … } catch { /* ignore */ }`, discard the response, and call `window.__switchboardSwitchPanel('project')` unconditionally afterwards.
> **Reason:** It converts a real failure into a silent one. `reviewPlan` returns `{success:false, error:'Could not resolve session id'}` when a card carries neither `planId` nor `sessionId`, and an HTTP-level failure is swallowed by the bare `catch`. In both cases the shell still jumps to the Project panel, which then shows whatever was last selected — the operator reads that as "the button opened the wrong plan". PRD contract #6 (capability-gating honesty — no dead-clicks, no faked success) forbids exactly this shape, and unlike the board's `postMessage` button, the HTTP rail hands us the failure for free.
> **Replaced with:** Await and inspect `data.success`; on failure stay on the terminals page and show a 2s `Failed` label (the pattern `Copy Prompt` already uses at `terminals.js:3025–3065`); on success switch panels.

**Implementation.**

```js
const viewBtn = document.createElement('button');
viewBtn.className = 'kanban-pane-view-btn';
viewBtn.textContent = 'view';
viewBtn.title = 'Open this plan in the Project panel';
viewBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    // The label is `view`; the VERB is `reviewPlan` — the same one the board's
    // review button posts (kanban.html:6620-6643). Do NOT "correct" this to
    // `viewPlan`: that kanban-surface verb was deliberately deleted (it opened a
    // markdown preview) and its removal is pinned by
    // src/test/kanban-view-plan-removal-regression.test.js.
    viewBtn.disabled = true;
    let ok = false;
    try {
        const res = await fetch('/kanban/verb/reviewPlan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: card.sessionId || '',
                planId: card.planId || '',
                planFile: card.planFile || '',
                workspaceRoot: card.workspaceRoot || kanbanPaneWorkspace[index],
                project: card.project || '',
                column: card.column || '',
                isFeature: card.isFeature || false
            })
        });
        const data = await res.json();
        ok = data && data.success === true;
    } catch { /* ok stays false */ }
    if (!ok) {
        // Do not switch: the Project panel received no selection, so jumping there
        // would show a stale entry and read as "opened the wrong plan".
        viewBtn.textContent = 'Failed';
        setTimeout(() => { viewBtn.disabled = false; viewBtn.textContent = 'view'; }, 2000);
        return;
    }
    viewBtn.disabled = false;
    // Shell-only move: panels are same-origin iframes and the shell owns the switch.
    // transport.js:349 posts {type:'switchPanel'} to window.parent, so this is a
    // no-op in a bare /terminals tab (and unreachable in a solo popout, where the
    // pane grid — and therefore this button — does not exist).
    if (typeof window.__switchboardSwitchPanel === 'function') {
        window.__switchboardSwitchPanel('project');
    }
});
btnGroup.appendChild(viewBtn);
```

**Edge cases.** Payload mirrors `kanban.html:6624–6632` field-for-field. `card.planFile` is always present on board cards (`KanbanProvider.ts:1876`, defaulted to `''`). No `bodySig` change — the signature at `terminals.js:2888–2890` must stay as-is so the transient `Failed` label is not re-rendered away on the next 5s poll tick.

### `src/webview/terminals.html` — style the View button

> **Superseded:** A new 11-line `.kanban-pane-view-btn` rule using `border: 1px solid var(--accent-teal); color: var(--accent-teal);` plus a teal hover, described as "the accent-teal border to read as a navigation action (distinct from the muted `link` button), matching the visual language of `.kanban-pane-copy-btn`".
> **Reason:** It inverts the hierarchy it claims to establish. Teal in this row already means *the mutating action*: `Copy Prompt` is teal because clicking it advances the card to the next column. `view` and `link` are both read-only navigation. Painting `view` teal puts two teal buttons beside one muted one and makes the only state-changing control stop standing out — in a pane whose rows are also drag-to-dispatch targets, that is a misclick surface, not a distinction. It also duplicates eleven lines of an existing rule.
> **Replaced with:** Share the existing muted `.kanban-pane-link-btn` rule via a selector list, and add only the `:disabled` state the new transient label needs.

Extend the existing rule at **`src/webview/terminals.html:1110–1122`**:

```css
        .kanban-pane-link-btn,
        .kanban-pane-view-btn {
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
            font-size: 9px;
            font-family: inherit;
            padding: 3px 6px;
            border-radius: 3px;
            cursor: pointer;
            flex-shrink: 0;
            transition: border-color 0.15s, color 0.15s;
        }
        .kanban-pane-link-btn:hover,
        .kanban-pane-view-btn:hover { border-color: var(--border-bright); color: var(--text-primary); }
        .kanban-pane-view-btn:disabled { opacity: 0.5; cursor: default; }
```

**Edge cases.** `--border-color`, `--border-bright`, and `--text-secondary` are already used by the sibling rule, so both the cyber and Claudify themes are covered with no new variable. Button order in the row becomes `link` · `view` · `Copy Prompt`; the two navigation buttons sit together and the mutating one stays at the far edge.

## Verification Plan

### Automated Tests

None added, and none run in this pass (per session directive: skip compilation and skip automated tests). The change is DOM construction plus a CSS selector list — there is no new verb, schema, route, or provider arm for a headless test to assert against, and the verb it consumes is already covered by the board path.

Guard rails for whoever next runs the suite:
- `src/test/kanban-view-plan-removal-regression.test.js` must stay green — it will, because this change adds no `viewPlan` string to `kanban.html`, `KanbanProvider.ts`, or `extension.ts`.
- `npm run verb-returns:check`, `npm run parity:check`, and `npm run push-routing:check` baselines are untouched (no provider edits, no allowlist edits, no new `postMessage` call sites).

### Manual verification (browser cockpit)

1. Open the shell, switch to **Terminals**, and put at least one grid pane into kanban mode with a column that has cards.
2. Confirm each row shows three buttons in order: `link`, `view`, `Copy Prompt` — `link` and `view` muted, `Copy Prompt` teal — and that the plan title still ellipsises rather than being clipped or pushing the buttons out of the row.
3. Click `view` on a plan card → the shell switches to the Project panel, the Kanban tab activates, filters widen then narrow to that plan's workspace/project/column, and the card is selected and scrolled into view.
4. Click `view` on a **feature** card → the shell switches to the Project panel and the **Features** tab opens with that feature selected.
5. Point the pane's workspace picker at a second workspace root (multi-root setups) and click `view` → the Project panel lands on that workspace's plan, not the board's last-selected one.
6. **Failure path:** with the extension's API server stopped (or the plan deleted out from under the pane), click `view` → the button shows `Failed` for ~2s and the shell stays on Terminals. No panel switch, no dialog.
7. **Drag-disarm:** press and drag starting on `view` → the row must not begin a drag; release without moving → the row re-arms and a subsequent drag from the row body still dispatches onto a terminal pane.
8. **No-confirm rule:** `view` acts immediately on click — no confirmation of any kind (CLAUDE.md hard rule).
9. **Standalone parity:** repeat steps 1–4 under `npx switchboard`. The standalone `reviewPlan` arm (`bootstrap.ts:1086`) broadcasts the same `activateKanbanTabAndSelectPlan` on the `project` surface, so behaviour must be identical.

---

**Recommendation: Send to Intern** (Complexity 3).

## Review Findings

The button (`terminals.js:5391–5437`) and the shared CSS rule (`terminals.html:1595–1609`) match the plan, and the risky assumptions all hold: `KanbanProvider.handleServiceVerb` (`:7786`) stamps `__viaHttp: true`, so the click takes the WS-only branch and does not pull focus into VS Code; both hosts' arms return `{success:true, sessionId}` (`KanbanProvider.ts:10414`, `bootstrap.ts:1061`), so the `data.success === true` gate is real and matches the sibling `promptSelected` button's response shape; the schema accepts `sessionId: ''` (`verbSchemas.ts:62–69`); the generic drag-disarm listener (`terminals.js:731–747`) covers the new button; and `bodySig` was correctly left untouched. **The one material finding was the guard rail, not the code:** `src/test/kanban-view-plan-removal-regression.test.js` — the only automated check this plan names — had no `package.json` script and no CI step, and had been failing since before this feature (it asserted `title="Review Plan Ticket"` / `title="Complete Plan"`, which the board replaced with `data-tooltip=`), so the plan's stated protection did not exist. Fixed: repaired the stale assertion to pin the surviving review/complete/copy actions by class and tooltip, added assertions that `terminals.js` posts `reviewPlan` and never `viewPlan` (closing this plan's named refactor hazard, which was previously guarded only by a code comment), added `test:contract:kanban-view-plan-removal`, and wired it into `.github/workflows/integration-tests.yml`. Files changed by this review: `src/test/kanban-view-plan-removal-regression.test.js`, `package.json`, `.github/workflows/integration-tests.yml`; the test now passes and exits 0, and `push-routing:check` / `parity:check` / `verb-returns:check` / `tsc --noEmit` are all green. Remaining risk: unrelated to this plan, `test:contract:ws-surface-scoping` is red at HEAD (`transport.js:242`, a debug log line added in `3b3c6367`, false-positives its "client does not double-filter" regex) and blocks every CI step after it — needs its own fix.
