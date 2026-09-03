# Wire the Tickets sidebar collapse toggle — the « button has markup and CSS but no click listener

<!-- board-collapse-03 -->
> **RESCOPED 2026-09-04 (Board Collapse 03, decision 15).** Signed: **one state mechanism, the host store, wired once.**
> > 
> > **Delete** the `vscode.setState`/`getState` persistence and the instruction forbidding a `persistTab` write "for later". Both were written against a gap that *Give `tickets.root` a single source of truth* now closes: it wires the `restoredTabState` push and fixes the root-scoped `persistTabState` arm.
> > 
> > **New shape:** wire the missing click handler, and persist the collapsed state through the host store, per workspace root, like every other panel preference. **Land after** the `tickets.root` plan; that ordering is not optional, because this plan's persistence depends on the push it wires.


## Goal

Make the `«` collapse toggle in the Tickets sidebar actually collapse and expand the ticket list pane, flip its glyph to `»` while collapsed, and remember the state across panel reloads — on both the editor panel and the browser cockpit.

### Problem

`src/webview/tickets.html:4031-4036` renders the toggle inside the sidebar strip:

```html
<div class="sidebar-toggle-row">
    <button id="tickets-create" class="strip-btn" title="Create New Ticket">+ New Ticket</button>
    <button id="tickets-link-all" class="strip-btn" title="Copy all ticket file paths to clipboard">Link all</button>
    <button id="tickets-import-all-kanban" class="strip-btn" title="Add all tickets to the Kanban board" style="display:none">Kanban all</button>
    <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
</div>
```

Clicking it does nothing at all — no state change, no message, no console error.

### Root cause

**The listener was never carried across the panel extraction.** `tickets.html` loads exactly three scripts (`sharedUtils.js`, `markdownEditor.js`, `tickets.js` — `src/webview/tickets.html:4736-4744`), and `tickets.js` contains **zero** references to `sidebar-toggle-btn`, `toggleSidebarCollapsed`, or `.content-row.collapsed`. The `collapsed` matches in that file are all `_collapsedTicketStatuses` (`src/webview/tickets.js:136`), an unrelated per-status accordion.

The behaviour lives in the panel this one was extracted from. `src/webview/planning.js` defines `applySidebarState` (line 1650), `toggleSidebarCollapsed` (line 1663), applies the initial state per tab (lines 1689-1693) and binds every toggle at init (lines 1696-1697). `design.js` carries its own equivalent (`toggleSidebarCollapsed`, line 594; bound at 926, 1041, 1162, 1234). Tickets got neither.

The CSS, by contrast, was ported **completely** and names `#tree-pane-tickets` explicitly throughout — `src/webview/tickets.html:331-370` (the collapse geometry), `383-395` (the tickets-specific left-justified strip and its collapsed centring), `444-460` (hiding strip buttons when collapsed, with an `!important` comment written specifically for the tickets case), `2016-2018` (hiding the search row when collapsed). Someone wrote and tuned collapsed-state styling for a pane that can never enter the collapsed state, because nothing ever adds the class. This is the known extraction-residue shape: styles and markup ported, the behavioural wiring dropped.

Note also that `.content-row.collapsed` is scoped to the row, and `tickets.html` has exactly one `.content-row` (line 4029, whose first child is `#tree-pane-tickets` at 4030 — which is what the `.content-row.collapsed > :first-child { flex: 0 0 40px }` rule at 348-350 targets), so no tab-scoping logic is needed here — unlike `planning.js`, which had to route the toggle through `getActiveTabName()`.

## Metadata

- **Complexity:** 2
- **Tags:** bugfix, frontend, ui
- **Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- A single static button, bound once at init, toggling one class on one element. The CSS it drives already exists and is already tuned for this pane. No backend change, no new verb, no allow-list edit, no schema edit.

### Complex / Risky

**Choosing a persistence mechanism that actually reads back.** Two mechanisms appear to exist in this panel, and only one of them is live:

- `vscode.setState` / `getState`, seeded from `<meta name="sb-initial-state">` (`src/webview/tickets.js:30-40`). **Live on both hosts.** In the editor, `TicketsPanelProvider` injects the seed on revive (`injectInitialWebviewState`, `src/services/TicketsPanelProvider.ts:1186`, driven by `reviveWithRetention` at 1196). In the browser, the transport shim backs `getState`/`setState` with `localStorage['sb-state-tickets']` (`src/webview/transport.js:27, 40-46, 410-417`). This is the mechanism `persistTicketsRoot` already uses (`src/webview/tickets.js:397-407`) and reads back at 8311-8313.
- `persistTab(tabKey, state, workspaceRoot)` → the `persistTabState` verb, read back via `getRestoredState` (`src/webview/tickets.js:59-82`). **Write-only in this panel.** The write lands (`TicketsPanelProvider.ts:1332-1337`), but `getRestoredState` only returns data once the host pushes `restoredTabState` — and `TicketsPanelProvider` **never sends it**. The only producers in the repo are `DesignPanelProvider.ts:2533` and `PlanningPanelProvider.ts:2561, 2611`. `tickets.js` says so in its own comments, twice: "a later slice wires the TicketsPanelProvider push; until then the read is a no-op" (line 392-393) and "before restoredTabState is pushed by TicketsPanelProvider" (line 8309-8310).

Getting this wrong is not cosmetic-and-obvious — it is cosmetic-and-*silent*: the write succeeds, the verb returns `{success: true}`, and the state simply never comes back. That is the same fake-wiring shape this whole feature exists to remove (PRD contract #6).

No migration concerns: this key has never shipped in any released version, so there is nothing to migrate — a missing key simply reads as "expanded", the current behaviour.

## Edge-Case & Dependency Audit

### Race Conditions

| Case | Required behaviour |
| --- | --- |
| Restored state vs first paint | `vscode.getState()` is read synchronously at script load (`src/webview/tickets.js:40`), before `initTicketsTab` runs (`src/webview/tickets.js:8320-8324`). Applying the class inside `initTicketsTab` therefore settles before the user sees anything — **no push to wait for, and no flash**. This is strictly better than the push-based path, which lands after first paint by construction. |
| Double-click / rapid clicking | `classList.toggle` is idempotent per click; `setState` is a synchronous local write with no debounce needed. |
| Multiple browser tabs open on the Tickets surface | `localStorage` is per-origin, so a collapse in one tab is visible to the other **on its next load**, not live. Acceptable — it is a shared panel preference, matching how the sibling panels behave. Do **not** add cross-tab `storage`-event syncing. |

### Security

- None. No user input, no path handling, no network.

### Side Effects

| Case | Required behaviour |
| --- | --- |
| Glyph direction | `«` when expanded (click to collapse), `»` when collapsed (click to expand). Must be updated in both the `apply` and `toggle` paths, so a restored-collapsed panel does not boot showing `«`. |
| Collapsed pane still needs the toggle reachable | Already handled by CSS: `.content-row.collapsed #tree-pane-tickets > *:not(.sidebar-toggle-row)` (`src/webview/tickets.html:366-370`) hides everything except the strip, and `.sidebar-toggle-row` centres its lone button (`390-395`). Confirm at runtime — this CSS has never actually executed. |
| `New Ticket` / `Link all` / `Kanban all` while collapsed | Hidden by `src/webview/tickets.html:458-460` (`!important`). Verify `Kanban all`, which also carries an inline `style="display:none"` toggled by JS — the `!important` rule exists precisely for this collision. |
| Search input while collapsed | Hidden twice over: by the generic `> *:not(.sidebar-toggle-row)` rule at 366-370 and by the explicit `#tree-pane-tickets .sidebar-search-row` rule at 2016-2018. Verify the input is genuinely `display:none`, not merely clipped, so tabbing does not land focus in an invisible field. |
| Panel revived after a window reload (editor) | `getState()` is undefined on revive; the `<meta name="sb-initial-state">` seed runs first (`src/webview/tickets.js:30-37`) and `TicketsPanelProvider` injects that meta at `1186`. The collapse key rides along with everything else in the state object. |
| Existing keys in `vscode.getState()` | `persistTicketsRoot` stores `ticketsWorkspaceRoot` in the same object. The write must be a merge (`Object.assign({}, cur, {...})`), never a replacement, or the root selection is destroyed on the first collapse. |

### Dependencies & Conflicts

| Case | Required behaviour |
| --- | --- |
| **Feature siblings** | No content overlap — the other two subtasks touch `renderAttachmentsList`, the chip handler, and the `attachment*` message arms. This plan touches the init-bindings region and adds a helper. Per the project PRD's *one agent stream per provider file* rule, it must still be **serialised** against them in the same working tree, not run in parallel. |
| Regression surface: `_collapsedTicketStatuses` | The per-status accordion (`src/webview/tickets.js:136`, toggled at `5456-5460`) shares the word "collapsed" and nothing else. Do not touch it. |
| `persistTab` / `getRestoredState` | Left in place, unused by this plan. Do **not** add a `persistTab('tickets.layout', …)` write "for later" — a write nothing reads is exactly the dead wiring this feature is deleting elsewhere. |

## Dependencies

- None. No prior session artifacts are required.

## Adversarial Synthesis

**Risk Summary.** The one real risk was silent non-persistence: the original design routed collapse through `persistTab`/`getRestoredState`, whose read leg depends on a `restoredTabState` push that `TicketsPanelProvider` does not send — the write would succeed, the verb would return success, and the state would never come back. Corrected to `vscode.setState`/`getState`, which is live on both hosts and already carries `ticketsWorkspaceRoot` in this same panel. The remaining risks are a state-object clobber (mitigated by merging rather than replacing) and CSS rules that have literally never executed, which is why the manual steps exercise each collapsed-state rule individually rather than eyeballing the pane once.

## Proposed Changes

### 1. `src/webview/tickets.js` — add the collapse helpers

Place near the other sidebar/init helpers (e.g. just above `persistTicketsRoot`, around line 397):

```js
// ── Sidebar collapse ────────────────────────────────────────────────────────
// tickets.html ships the toggle button (line ~4035) and the full
// `.content-row.collapsed #tree-pane-tickets` CSS (lines ~331-460, ~2016-2018),
// but the panel extraction never carried over the listener that lives in
// planning.js:1663/1696. Without it the class is never applied and every one of
// those rules is dead. This panel has exactly ONE .content-row, so no
// per-tab routing is needed.
//
// Persistence uses vscode.setState/getState — NOT persistTab. persistTab's read
// leg (getRestoredState) only returns data once the host pushes `restoredTabState`,
// and TicketsPanelProvider never sends it (only Design/Planning do). A persistTab
// write here would succeed, return success, and never come back. setState is the
// mechanism persistTicketsRoot already uses, and it is live on both hosts: the
// editor seeds it from <meta name="sb-initial-state"> on revive, and the browser
// shim backs it with localStorage (transport.js:410-417).
let _ticketsSidebarCollapsed = false;

function applyTicketsSidebarCollapsed(collapsed) {
    _ticketsSidebarCollapsed = !!collapsed;
    const row = document.querySelector('.content-row');
    if (row) row.classList.toggle('collapsed', _ticketsSidebarCollapsed);
    const btn = document.querySelector('.sidebar-toggle-btn');
    if (btn) btn.textContent = _ticketsSidebarCollapsed ? '»' : '«';
}

function toggleTicketsSidebarCollapsed() {
    applyTicketsSidebarCollapsed(!_ticketsSidebarCollapsed);
    if (vscode) {
        // MERGE, never replace: persistTicketsRoot keeps ticketsWorkspaceRoot in
        // this same object and a replacement would wipe the root selection.
        const cur = vscode.getState() || {};
        vscode.setState(Object.assign({}, cur, { ticketsSidebarCollapsed: _ticketsSidebarCollapsed }));
    }
}
```

> **Superseded:** Persist the collapse flag with `persistTab('tickets.layout', { sidebarCollapsed: _ticketsSidebarCollapsed })` and restore it from `getRestoredState('tickets.layout')` inside a `restoredPanelState` message arm.
> **Reason:** Two separate defects. (1) There is no `restoredPanelState` message type anywhere in `src/` — the arm in `tickets.js` is `case 'restoredTabState':` (line 6922); code added to a `restoredPanelState` arm would be dead on arrival. (2) More importantly, `TicketsPanelProvider` **never pushes `restoredTabState` at all** — the only producers are `DesignPanelProvider.ts:2533` and `PlanningPanelProvider.ts:2561, 2611`, and `tickets.js` documents the gap in its own comments at lines 392-393 and 8309-8310. So `getRestoredState` would always return `undefined` and the collapse state would silently never restore, while `persistTabState` happily returned `{success: true}`. The original plan's own framing — "panel-level layout preference, so it belongs in the panel bucket of `persistTab`" — is also moot: the `persistTabState` arm (`TicketsPanelProvider.ts:1332-1337`) ignores `workspaceRoot` entirely and always writes the panel bucket.
> **Replaced with:** `vscode.setState` / `getState`, merged into the existing state object, restored synchronously at init. Live on both hosts today (editor: `injectInitialWebviewState` at `TicketsPanelProvider.ts:1186` + the seed at `tickets.js:30-37`; browser: `localStorage['sb-state-tickets']` via `transport.js:27, 40-46, 410-417`), and already proven in this panel by `persistTicketsRoot` (`tickets.js:397-407`). It also removes the flash-of-expanded-layout problem entirely, because the read is synchronous at load rather than a post-paint push.

### 2. `src/webview/tickets.js` — bind and restore at init

Inside `initTicketsTab` (`src/webview/tickets.js:4715`), alongside the other one-time bindings (near the `btn-view-attachments` / `btn-close-attachments-modal` block at 5234 / 4860):

```js
document.querySelector('.sidebar-toggle-btn')?.addEventListener('click', toggleTicketsSidebarCollapsed);
applyTicketsSidebarCollapsed(!!(persistedState && persistedState.ticketsSidebarCollapsed));
```

A single `querySelector` bind is correct here: the button is static markup in `tickets.html` and is never re-rendered, unlike `planning.js`/`design.js`, which rebind after each dynamic strip render. `persistedState` is the module-scoped `vscode.getState()` read at `src/webview/tickets.js:40`, which already runs before `initTicketsTab` fires (`8320-8324`).

### 3. No change to `src/webview/tickets.html`

The markup and every collapsed-state rule are already present and already tuned for `#tree-pane-tickets`. This plan makes them reachable; it does not rewrite them. If UAT (steps 4-7 below) shows a rule that never worked because it never ran, fix it there rather than pre-emptively rewriting CSS that has never been observed.

### 4. No change to the `restoredTabState` arm

Deliberately untouched. When a later slice wires the `restoredTabState` push into `TicketsPanelProvider`, moving this key into the panel bucket becomes a one-line follow-up — but adding the read now would be dead code.

## Verification Plan

> Session directive: this pass does **not** run compilation or automated tests. The gate commands below are listed for CI / the implementing session, not executed here.

### Automated Tests

1. New test `src/test/tickets-sidebar-collapse.test.js`:
   - assert `.sidebar-toggle-btn` in `tickets.html` has a bound click listener after `tickets.js` init (the direct regression guard — today there is none);
   - click it, assert `.content-row` gains `collapsed` and the button reads `»`; click again, assert both revert;
   - stub `vscode.getState`/`setState`; click, and assert `setState` received an object that **still contains** a pre-seeded `ticketsWorkspaceRoot` alongside `ticketsSidebarCollapsed: true` (the merge guard);
   - seed `getState()` with `{ ticketsSidebarCollapsed: true }` before init and assert the class and glyph are applied without a click;
   - assert **no** `persistTabState` message is posted for the collapse (the write-only path must not be reintroduced).
2. CI gates (run on merge, not in this session): `npm run parity:check`, `npm run push-routing:check`. Neither should move — this change adds no verb and no `postMessage`.

### Static guards

- `grep -n "sidebar-toggle-btn" src/webview/tickets.js` → non-zero. The absence of this reference is precisely the bug.
- `grep -n "restoredPanelState" src/` → **zero** hits (it is not a real message type; only the `_restoredPanelState` local variable exists).
- `grep -n "tickets.layout" src/` → **zero** hits (the write-only key must not have been added).

### Manual — VS Code editor panel

3. Open the Tickets panel, click `«`. The ticket list must shrink to the 40px rail; the preview pane must expand to fill; the glyph must read `»`.
4. While collapsed, confirm `+ New Ticket`, `Link all` and the search input are all hidden (not merely clipped) and the toggle is centred in the rail. Tab through the panel — focus must not land in a hidden input.
5. Enable the `Kanban all` button (so its inline `display:none` is cleared), then collapse. It must hide — this exercises the `!important` rule at `tickets.html:458-460`, which has never executed.
6. Click `»` to expand: the list, search row and strip buttons all return; the glyph reverts to `«`.
7. Reload the window with the sidebar collapsed. The panel must come back collapsed, with `»` shown, and without a visible flash of the expanded layout.
8. **Merge guard:** select a non-default tickets workspace root, collapse the sidebar, reload. Both the collapsed state **and** the selected root must survive.

### Manual — browser cockpit (the pinned surface)

9. Repeat steps 3, 4 and 6 in the browser cockpit against the running standalone host.
10. Collapse in the browser, reload the tab, confirm the collapsed state is restored. In devtools → Application → Local Storage, `sb-state-tickets` must contain `ticketsSidebarCollapsed: true`. In devtools → Network/WS, confirm the click issues **no** request at all — the persistence is purely client-side.

### Regression guard

11. Confirm the per-status accordion collapse (`_collapsedTicketStatuses`, `src/webview/tickets.js:136`, `5456-5460`) is unaffected — it shares the word "collapsed" but nothing else.

---

**Recommendation: Send to Intern** (complexity 2).
