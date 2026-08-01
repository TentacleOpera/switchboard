# Solo Terminal Pop-Out Window

## Goal

Let a single fleet terminal be opened in its own browser window — one terminal, full window, no sidebar and no layout chrome — so a user can watch or interact with an agent while the cockpit stays on the Board.

### Problem analysis / root cause

The cockpit shows one panel at a time. The app-shell mounts every panel as an iframe and switches by toggling `display` (`shell.js:32-44`); `.panel-frame` is absolutely positioned to fill the content area (`shell.html:135-144`). So "see the Board and a terminal at once" is not expressible in the current shell.

The obvious alternative — a terminal docked to the right of the panels — was evaluated and rejected. The Terminals panel already carries a layout engine with a hard minimum-width floor (`terminals.js:315-321`): `2h` needs 400px, `2x2` needs 500px, `2x3` and `3x3` need 750px, and `resolveFlooredLayout` (`terminals.js:880-900`) steps *down* to a simpler layout when the box is too small, surfacing a fallback banner. A dock at a sane fraction of a 1440px window lands around 450-500px, which floors most layouts permanently. A dock would also require a splitter, a persisted ratio, and restructuring `#content` from an absolute-fill stack into a grid — real work, to produce a terminal too narrow to use the layouts that were just shipped.

A separate window costs almost none of that, because the groundwork already exists:

- **`/terminals` is already a directly navigable top-level route.** `LocalApiServer.ts:3501` serves it through `_handleServePanelById('terminals')`, not only as an iframe target. A second window at that URL works today; there is simply no affordance that opens one.
- **The gateway is already multi-client per terminal.** `clients` is a flat `Set<ClientState>` and every flush filters it by `terminalName` (`terminalWsGateway.ts:127,397`), so N attached clients all receive output. Scrollback sequence numbers are terminal-scoped rather than per-connection — deliberately, so re-attach is idempotent (`terminalWsGateway.ts:88-99`). A second window therefore *mirrors* the terminal rather than stealing it, and gets correct scrollback replay on attach.
- **The window gets its own credentials for free.** The route stamps the terminal token onto the body, which the client reads as `document.body.dataset.terminalToken` (`terminals.js:1288-1291`). A freshly-loaded window is stamped exactly as the iframe is; nothing needs to be passed between windows.

What is missing is (a) a render mode that shows one terminal instead of the full panel, and (b) the guard that stops two views of the same page from fighting over one set of persisted settings.

That second point is the real defect this plan must prevent. The panel persists `terminals.layoutMode`, `terminals.paneAssignments`, `terminals.collapsedWorktrees` and `terminals.osNotify` through shared `saveSetting`/`loadSetting` calls (`terminals.js:363-387`). Two windows loading the same route would both read and both write those keys, last-writer-wins — a popped-out window would silently rewrite the docked panel's layout.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, feature

## User Review Required

- **Solo mode is read-only with respect to persisted layout settings** — a popped-out window never writes `terminals.layoutMode` / `paneAssignments` / `collapsedWorktrees`. Confirm that is right; the alternative (namespaced `terminals.popout.*` keys) is more code for a window that shows exactly one terminal and has no layout to remember.
- **The window does not auto-close when its terminal exits.** It latches read-only instead. Windows that close themselves lose scrollback the user may still be reading.
- Everything else is decided below: URL contract, window naming/reuse, theme propagation, backpressure posture.

## Complexity Audit

### Routine
- The route needs no server change: `/terminals` already exists (`LocalApiServer.ts:3501`) and `_handleServePanelById` ignores the query string, so `?solo=<name>` reaches the client untouched via `location.search`.
- One terminal in a full-window container is the existing `1` layout with `minW: 0, minH: 0` (`terminals.js:316`) — the degenerate case the layout engine already handles, not a new rendering path.
- Terminal creation, attach, resize and teardown are unchanged; solo mode changes what is on screen, not how a terminal works.
- Multi-client attach and scrollback replay need no gateway change (see root-cause analysis).
- `MAX_WEBGL_CONTEXTS` is a per-document budget (`terminals.js:75-76`), so a solo window has its own headroom and cannot exhaust the cockpit's.

### Complex / Risky
- **Shared-settings contamination** — the core risk, described above. Solo mode must be genuinely write-suppressed, not merely "unlikely to write".
- **`sanitizePaneAssignments` and the detach timer assume the full panel's model.** `armDetachTimer` destroys a view 15s after it leaves `paneAssignments` (`terminals.js:73-90`). Solo mode must keep its one terminal permanently assigned, or the window will tear down its own contents.
- **Theme changes do not cross windows.** The shell fans theme out to iframes via `postMessage` over `frames` (`shell.js:129-133`); a separate window is not in that map. Without handling, a popped-out window keeps its server-stamped theme while the cockpit re-tints.
- **Backpressure is per-terminal and pauses the PTY when *any* attached client lags** (`terminalWsGateway.ts:451-520`, high-water at `HIGH_WATER_MARK_BYTES` / `HIGH_WATER_CHARS`). A second attached view raises the chance of a pause slightly. This is the designed behaviour and is accepted, not worked around — but it should be observed under load rather than assumed benign.
- **Popup blocking.** `window.open` must be called synchronously inside the click handler's user-gesture context; any `await` before the call forfeits the gesture and the window is blocked.

## Edge-Case & Dependency Audit

**Race Conditions**
- The named terminal no longer exists when the window loads (killed between click and load). Render an explicit "terminal not found" state; do not create a terminal to fill the gap and do not fall back to an arbitrary one.
- The terminal exits while the solo window is open → latch read-only in place, same as the panel's existing `entry.exited` behaviour.
- The terminal is renamed while a solo window is open. `?solo=` carries the `friendlyName`, which is the rename key; the window's terminal is unaffected on the wire but its identity label goes stale. Refresh the title from the next fleet list; if the name is gone, show the not-found state rather than silently retargeting.
- Repeated clicks on the same terminal must focus the existing window, not spawn duplicates — hence the deterministic window name below.
- The cockpit and the solo window both attached and both typing: the gateway serialises input per terminal through `enqueueInput` (`terminalWsGateway.ts:133-153`), so this is interleaving, not corruption. It is the same semantics as two humans on one tmux pane and needs no arbitration.

**Security**
- Same-origin only. The window is opened with a relative URL against the cockpit's own origin; no cross-origin surface is introduced.
- The terminal token is stamped server-side into the new document (`terminals.js:1288-1291`) — it is never read from the opener, passed on the URL, or copied through `postMessage`.
- The `?solo=` value is a terminal name used for lookup and display only. It is matched against the fleet list and rendered via `textContent`; it must never be interpolated into markup, and an unmatched value produces the not-found state.
- Terminal bytes continue to go only to `term.write()`, never `innerHTML`.

**Side Effects**
- A second attached client means one extra copy of every output frame on the wire for that terminal, plus a second xterm doing its own rendering. Both are bounded per-terminal and neither touches terminals the window is not showing.
- No new WebSocket *seat* semantics to reason about beyond what the gateway already supports for reconnects.

**Dependencies & Conflicts**
- **Depends on `shell-terminal-strip-completion-lights.md`** for the click affordance — that plan owns the strip and its click handler, and explicitly keeps that handler in one function so this plan can swap it. This plan is independently *testable* by navigating to `/terminals?solo=<name>` directly, and could ship before the strip with a pop-out button placed in the panel's own toolbar instead.
- No database change, no new endpoint, no verb-schema change.
- Touches `terminals.js` in the render-mode region; the strip plan touches it in the relay-emit region. Both also touch the window `message` listener (`terminals.js:289-299`), which is the one overlap point — sequence them rather than coding both simultaneously.
- Browser-cockpit only; the VS Code webview host has no `window.open` equivalent and is out of scope.

## Dependencies

- `shell-terminal-strip-completion-lights.md` — provides the strip entry whose click opens the window. Not a hard build dependency (the URL works standalone), but the intended entry point.

## Non-Goals

- No multi-terminal pop-out. One window, one terminal — the full panel already handles grids, and a second grid surface would reintroduce the shared-layout-state problem this plan exists to avoid.
- No cross-window layout sync, tiling, or window-position persistence. The OS window manager owns geometry.
- No pop-out in the VS Code webview host.
- No change to backpressure, flow control, or the frame protocol.

## Implementation Steps

### 1. Solo render mode (`terminals.js`)

- Read `solo` from `location.search` during init, before any settings load.
- When present: skip `loadLayoutSettings()` entirely, force `currentLayout`/`effectiveLayout` to `1`, and set `paneAssignments` to the single named terminal so the detach timer's `paneAssignments.includes(name)` check (`terminals.js:81-84`) always holds.
- Suppress every `saveSetting` call for the duration of the session. Implement as a single guard inside `saveSetting` itself (early return when solo), not as call-site conditionals — one guard cannot be forgotten by a later change, twelve call sites can.
- `loadSetting` for `terminals.osNotify` may still be read: notification preference is a user-level choice, not layout state, and reading it does not contaminate anything. Do not *write* it from solo mode.
- Resolve the terminal against the fleet list on load; if absent, render the not-found state and stop.

### 2. Solo chrome (`terminals.html`, `terminals.js`)

- Hide the sidebar, the layout picker and the fallback banner (`terminals.html:669-689`) via a body-level `is-solo` class rather than removing elements, so the existing markup and its contract-test coverage stay intact.
- Keep the per-terminal header (name, role, clear) so the window is not a bare rectangle, and keep the existing Clear button — its scoping was already fixed to exclude non-layout buttons from the layout-picker query (`terminals.js:260-266`), so the solo chrome must not reintroduce an unscoped `.btn-layout` selector.
- Set `document.title` to the terminal name so the OS window switcher is usable with several pop-outs open.

### 3. Open the window (`shell.js`)

- Replace the strip's click handler (the seam the companion plan leaves at step 5) with a synchronous `window.open(url, name, features)` inside the click handler — no `await` before the call, or the popup is blocked.
- URL: `/terminals?solo=` + `encodeURIComponent(friendlyName)`.
- Window name: a deterministic `sb-term-<friendlyName>` so a repeat click reuses the window. Follow the call with `.focus()` on the returned handle — reuse alone does not raise the window.
- Handle a null return (blocked) by falling back to the in-cockpit behaviour: select the Terminals panel and focus that terminal. A blocked popup must never be a dead click.

### 4. Theme propagation across windows (`shell.js`)

- Keep the handles returned by `window.open` in a set and include them in `applyThemeToAll`'s fan-out (`shell.js:122-134`) alongside the iframes, using `location.origin` as target origin.
- Prune closed windows on each fan-out by checking `.closed`, so the set does not grow across a session.
- The solo page already listens for `switchboardThemeChanged` (`terminals.js:294-295`) and needs no change to receive it.

## Proposed Changes

### `src/webview/terminals.js`
- **Logic:** Solo mode detected from `location.search`; layout forced to `1` with the named terminal permanently pane-assigned; a single write-suppression guard inside `saveSetting`; not-found state for an unresolvable name; `document.title` set from the terminal name.
- **Edge cases:** Detach timer never fires (permanent assignment). Rename refreshes the title from the fleet list and falls to not-found if the name disappears. Exit latches read-only without closing the window. `window.parent === window` in a popped-out window, so the strip relay from the companion plan correctly no-ops.

### `src/webview/terminals.html`
- **Logic:** `is-solo` body class hiding the sidebar, layout picker and fallback banner while leaving the markup in place.
- **Edge cases:** Does not reintroduce an unscoped `.btn-layout` query (regression guard for the Clear All scoping fix). Keeps exactly one `SHARED_DEFAULTS_SCRIPT` marker. No literal `<body>` tag in comments — `applyThemeClass` stamps the first match in the file.

### `src/webview/shell.js`
- **Logic:** Strip click opens `sb-term-<name>` synchronously and focuses it; blocked-popup fallback to in-cockpit focus; open-window handles tracked and included in the theme fan-out with `.closed` pruning.
- **Edge cases:** Repeat clicks focus rather than duplicate. Null handle never produces a dead click. Closed windows pruned from the fan-out set.

## Verification Plan

### Automated Tests

- New contract test: with `?solo=` set, no `saveSetting` call is issued for `terminals.layoutMode`, `terminals.paneAssignments` or `terminals.collapsedWorktrees` across a full init-and-render cycle. This is the plan's central guarantee and needs a regression guard, not just a UAT step.
- New contract test: `?solo=<unknown>` renders the not-found state and creates no terminal.
- `npm run test:contract:panel-scrollbars` and `npm run test:contract:shim-injection` — the panel's markup is class-gated, not removed, so both should pass unchanged; a failure means elements were deleted rather than hidden.
- `npm run test:contract:terminal-token-transport` — confirms the solo document is stamped and reads its token by the same path as the iframe.
- `npm run compile` and `npm run lint` clean.

### Manual UAT (darwin)

- Click a strip terminal → a window opens showing exactly that terminal, full-window, no sidebar or layout picker; the window title is the terminal name.
- Type in the pop-out and in the cockpit's Terminals panel alternately → both views show all output from both, in order; neither view stalls.
- Return to the cockpit, open Terminals, change the layout to `2x2`, reload the cockpit → the layout is `2x2`. This is the shared-settings regression check: before the guard, the pop-out would have reset it.
- Click the same strip terminal again → the existing window is focused, not duplicated.
- Kill the terminal from the cockpit → the pop-out latches read-only, keeps its scrollback, and does not close.
- Navigate directly to `/terminals?solo=<name-that-does-not-exist>` → not-found state, no terminal created, no console errors.
- Toggle the theme in the cockpit with a pop-out open → the pop-out re-tints. Close the pop-out and toggle again → no console errors from posting to a closed window.
- Run a high-output command (`yes`, or a large build) with both views attached → confirm flow control still recovers and neither client is evicted under normal conditions; note the behaviour if a pause is observed.
- Confirm no `confirm()` or two-click gate anywhere in the new UI.
