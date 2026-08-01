# Solo Terminal Pop-Out Window

## Goal

Let a single fleet terminal be opened in its own browser window — one terminal, full window, no sidebar and no layout chrome — so a user can watch or interact with an agent while the cockpit stays on the Board.

### Problem analysis / root cause

The cockpit shows one panel at a time. The app-shell mounts every panel as an iframe and switches by toggling `display` (`shell.js:32-44`); `.panel-frame` is absolutely positioned to fill the content area (`shell.html:135-144`). So "see the Board and a terminal at once" is not expressible in the current shell.

The obvious alternative — a terminal docked to the right of the panels — was evaluated and rejected. The Terminals panel already carries a layout engine with a hard minimum-width floor (`terminals.js:315-321`): `2h` needs 400px, `2x2` needs 500px, `2x3` and `3x3` need 750px, and `resolveFlooredLayout` (`terminals.js:880-900`) steps *down* to a simpler layout when the box is too small, surfacing a fallback banner. A dock at a sane fraction of a 1440px window lands around 450-500px, which floors most layouts permanently. A dock would also require a splitter, a persisted ratio, and restructuring `#content` from an absolute-fill stack into a grid — real work, to produce a terminal too narrow to use the layouts that were just shipped.

A separate window costs almost none of that, because the groundwork already exists:

- **`/terminals` is already a directly navigable top-level route.** `LocalApiServer.ts:3501` serves it through `_handleServePanelById('terminals')`, not only as an iframe target. A second window at that URL works today; there is simply no affordance that opens one.
- **The gateway is already multi-client per terminal.** `clients` is a flat `Set<ClientState>` and every flush filters it by `terminalName` (`terminalWsGateway.ts:127,397`), so N attached clients all receive output. Scrollback sequence numbers are terminal-scoped rather than per-connection — deliberately, so re-attach is idempotent (`terminalWsGateway.ts:88-99`). A second window therefore *mirrors* the terminal rather than stealing it, and gets correct scrollback replay on attach.
- **The window gets its own credentials for free** — though not by the mechanism originally assumed.

  > **Superseded:** The route stamps the terminal token onto the body, which the client reads as `document.body.dataset.terminalToken` (`terminals.js:1288-1291`). A freshly-loaded window is stamped exactly as the iframe is; nothing needs to be passed between windows.
  > **Reason:** `data-terminal-token` is stamped by the **VS Code webview host only** (`TaskViewerProvider.ts:2059`). The standalone browser route does not stamp it: `getTerminalsHtml` injects `data-initial-workspace-root`, `data-panel` and `data-host-capabilities` and nothing else (`headlessPanelHtml.ts:399-403`). In the browser cockpit the `/ws/terminal` upgrade authenticates off the **`sb_session` cookie** instead — `authorizeWsUpgrade` accepts `?token=` *or* `cookies['sb_session']` (`wsUpgradeAuth.ts:61-78`), and `terminals.js:1288-1292` simply appends no `&token=` when the dataset attribute is absent.
  > **Replaced with:** The browser pop-out authenticates by cookie. `sb_session` is a same-origin cookie, so a window opened at a relative URL presents it on both the document request and the WebSocket upgrade with nothing passed between windows. The conclusion — credentials for free, no opener hand-off, no token on the URL — is unchanged. The mechanism is the cookie, not a body stamp. One consequence follows into verification: `test:contract:terminal-token-transport` exercises the extension-host stamping path and does **not** cover the browser pop-out (see Verification Plan).

What is missing is (a) a render mode that shows one terminal instead of the full panel, (b) the guard that stops two views of the same page from fighting over one set of persisted settings, and (c) a pin that keeps the window's one terminal attached to its pane when the panel's fleet-driven bookkeeping would otherwise unassign it.

That second point is the real defect this plan must prevent. The panel persists `terminals.layoutMode`, `terminals.paneAssignments`, `terminals.collapsedWorktrees` and `terminals.osNotify` through shared `saveSetting`/`loadSetting` calls (`terminals.js:363-387`). Two windows loading the same route would both read and both write those keys, last-writer-wins — a popped-out window would silently rewrite the docked panel's layout.

The third point is subtler and only surfaced when the fleet lifecycle was read end-to-end. **`PtyFleetService` removes a terminal from the registry on an operator-initiated close, and keeps it on a natural process exit.** `kill(name)` deletes the handle from the map outright (`ptyFleetService.ts:144-154`), so the name stops appearing in `ptyListTerminals` (`bootstrap.ts:995-1007` maps `list()`, which is the raw map — `ptyFleetService.ts:132-134`). A process that dies on its own is *not* deleted: the exit handler only sets `status = 'exited'` (`ptyFleetService.ts:101-107`), so the entry stays in the list with a terminal status. Two consequences for a single-terminal window:

- `sanitizePaneAssignments` drops any pane whose name is not in the live fleet (`terminals.js:466-470`). On the operator-close path the solo window's only assignment is nulled, the pane renders "Pane 1 (Empty)" with a sidebar that solo mode has hidden, and `armDetachTimer` destroys the view — and its scrollback — 15 seconds later (`terminals.js:78-87`, `terminals.js:869-876`). The window becomes a dead rectangle.
- If the name is already absent on the **first** fetch, `initialAssignmentDone` is still false and the seeding block assigns `fleetList[0]` instead (`terminals.js:493-499`) — the window silently opens a *different* terminal, which is exactly the substitution this plan forbids.

Neither is a bug in the panel: both behaviours are correct for a grid whose panes follow the live fleet. They are simply wrong for a window whose identity *is* one terminal, so solo mode must pin its slot rather than let the fleet model manage it.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, feature

> **Superseded:** **Complexity:** 5
> **Reason:** The improve pass added three changes the original scope did not carry: pinning the solo slot against `sanitizePaneAssignments`, pre-setting `initialAssignmentDone`, and branching the shared WebSocket exit arm on eviction. The last touches a code path both surfaces depend on, which is what pushes this past a clean 5.
> **Replaced with:** **Complexity:** 6 — still majority-routine, three files, but with two moderate risks on shared state (pane-assignment bookkeeping and the exit arm) rather than one.

## User Review Required

- **Solo mode is read-only with respect to persisted layout settings** — a popped-out window never writes `terminals.layoutMode` / `paneAssignments` / `collapsedWorktrees`. Confirm that is right; the alternative (namespaced `terminals.popout.*` keys) is more code for a window that shows exactly one terminal and has no layout to remember.
- **The window does not auto-close when its terminal exits.** It latches read-only instead. Windows that close themselves lose scrollback the user may still be reading. This now covers *both* death paths — natural process exit and an operator closing the terminal from the cockpit — because the solo slot is pinned rather than fleet-managed (see Implementation Steps 1a and the root-cause note above).
- **An evicted client is rendered as a read-only latch, not as a dead process.** The gateway evicts a lagging client with `{ t: 'exit', code: -1, reason: 'Lagging client evicted' }` (`terminalWsGateway.ts:474-481`), which the panel currently renders identically to a real exit — "[Process Exited with code -1]", stdin disabled, and no reconnect because `ws.onclose` returns early on `entry.exited` (`terminals.js:1368-1372`, `terminals.js:1379-1380`). Adding a second attached view to a terminal makes an eviction strictly more likely. This plan reads the `reason` field so an eviction reconnects instead of lying about the process. Confirm that is wanted here; the alternative is to leave the misleading latch in place and treat it as pre-existing.
- **A refused window raise falls back to switching the cockpit to the Terminals panel.** Research confirmed `.focus()` cannot reliably raise an already-open window on macOS — Firefox blocks it outright by default. Rather than let the click do nothing, the plan reuses the blocked-popup fallback. The cost is that on Firefox, clicking a strip entry for an already-open pop-out also navigates the cockpit away from the Board — the very thing this feature exists to avoid. Confirm that is the right trade; the alternative is to accept a silent no-op on that browser.
- Everything else is decided below: URL contract, window naming/reuse, theme propagation, backpressure posture.

## Complexity Audit

### Routine
- The route needs no server change: `/terminals` already exists (`LocalApiServer.ts:3501`) and `_handleServePanelById` ignores the query string, so `?solo=<name>` reaches the client untouched via `location.search`.
- One terminal in a full-window container is the existing `1` layout with `minW: 0, minH: 0` (`terminals.js:316`) — the degenerate case the layout engine already handles, not a new rendering path.
- Terminal creation, attach, resize and teardown are unchanged; solo mode changes what is on screen, not how a terminal works.
- Multi-client attach and scrollback replay need no gateway change (see root-cause analysis). Verified: `clients` is a flat `Set<ClientState>`, `flushOutput` fans a single encoded frame to `clients.filter(c => c.terminalName === name)` (`terminalWsGateway.ts:397-402`), and `setupClient` computes each new client's replay from the terminal-scoped ring using its own `lastSeq` (`terminalWsGateway.ts:569-601`).
- `MAX_WEBGL_CONTEXTS` is a per-document counter (`terminals.js:75-76`), so the solo window starts with a fresh budget of its own rather than inheriting the cockpit's tally.

  > **Superseded:** …so a solo window has its own headroom and cannot exhaust the cockpit's.
  > **Reason:** The *counter* is per-document; the underlying GPU context limit is per-renderer-process and the two windows share it, because a same-origin popup opened without `noopener` stays in the opener's process. Several pop-outs can therefore push the cockpit's terminals past the browser-wide cap even though neither document's own counter has reached `MAX_WEBGL_CONTEXTS`.
  > **Replaced with:** The per-document counter cannot see the other window's contexts, so the shared limit can still be reached across windows. **Confirmed by research:** the practical cap is ~16 live contexts in Chrome, Firefox and Safari, and eviction is LRU *across documents* — creating context #17 in a pop-out can fire `webglcontextlost` on a canvas in the cockpit (Khronos WebGL §5.14.2 leaves the count implementation-defined and permits loss at any time). The consequence is bounded and already handled: `webgl.onContextLoss` fires, the addon is disposed, and the affected terminal drops to the canvas renderer (`terminals.js:120-126`). Degradation, not breakage — no new mitigation is in scope, but do not claim isolation the counter does not provide.

- **Headroom arithmetic, for sizing rather than for action.** The cockpit renders at most nine panes (`3x3`), so its live WebGL count is capped by the layout well below `MAX_WEBGL_CONTEXTS = 12`; each solo window adds exactly one. Reaching the ~16 shared cap therefore takes roughly seven pop-outs open against a full `3x3` grid. Beyond that the oldest contexts drop to canvas and keep rendering. The research suggestion of consolidating onto a single shared context via `OffscreenCanvas` is **not adopted**: xterm's `WebglAddon` owns its context per terminal by design, the existing loss handler already recovers cleanly and permanently, and rewriting the renderer to dodge a limit that needs seven simultaneous pop-outs to reach is disproportionate to this plan.

### Complex / Risky
- **Shared-settings contamination** — the core risk, described above. Solo mode must be genuinely write-suppressed, not merely "unlikely to write".
- **`sanitizePaneAssignments` and the detach timer assume the full panel's model.** `armDetachTimer` destroys a view 15s after it leaves `paneAssignments` (`terminals.js:73-90`). Solo mode must keep its one terminal permanently assigned, or the window will tear down its own contents. This is not hypothetical: the stale-slot drop at `terminals.js:466-470` unassigns the solo terminal the moment an operator closes it from the cockpit, because `kill()` removes it from the fleet registry entirely (`ptyFleetService.ts:144-154`). Pinning the slot is what makes the stated "latch read-only, keep the scrollback" behaviour true.
- **The first-load seeding path can silently retarget the window.** With `initialAssignmentDone` false and every slot null, `sanitizePaneAssignments` assigns `fleetList[0]` (`terminals.js:493-499`). A window opened for a terminal that died between click and load would show an arbitrary other agent's session under that terminal's name. Solo mode must pre-set `initialAssignmentDone`.
- **Theme changes do not cross windows, and there is no server-stamped theme to fall back on in the browser host.** The shell fans theme out to iframes via `postMessage` over `frames` (`shell.js:129-133`); a separate window is not in that map.

  > **Superseded:** Without handling, a popped-out window keeps its server-stamped theme while the cockpit re-tints.
  > **Reason:** In the browser cockpit nothing stamps a theme at all. `bootstrap.ts:481` calls `sharedGetShellHtml(repoRoot)` and `bootstrap.ts:493-497` calls `sharedGetPanelHtmlById(id, repoRoot, workspaceRoot, caps)` — both omit the optional `themeClass`, and `applyThemeClass` returns the content untouched when it is absent (`headlessPanelHtml.ts:121-127`). The iframe only looks correctly themed because `resolveInitialTheme()` reads the class off `window.parent.document.body` (`terminals.js:156-173`); a pop-out has no parent and falls through to the `cyber-theme-enabled` default.
  > **Replaced with:** A pop-out opened *after* an in-session theme toggle loads in afterburner while the cockpit is claudify, and the theme fan-out fixes only *subsequent* toggles. Solo mode must therefore also resolve its initial theme from `window.opener` — the exact symmetric case of the existing parent-inheritance branch, and same-origin so the read is legal.

- **Backpressure is per-terminal and pauses the PTY when *any* attached client lags** (`terminalWsGateway.ts:451-520`, high-water at `HIGH_WATER_MARK_BYTES` / `HIGH_WATER_CHARS`). A pause is the designed behaviour and is accepted, not worked around. **Eviction is not.**

  > **Superseded:** A second attached view raises the chance of a pause slightly. This is the designed behaviour and is accepted, not worked around — but it should be observed under load rather than assumed benign.
  > **Reason:** A pause is not the only outcome. A client whose `bufferedAmount` stays above the high-water mark for `HIGH_WATER_GRACE_MS` is *evicted*, and the eviction is announced as `{ t: 'exit', code: -1, reason: 'Lagging client evicted' }` (`terminalWsGateway.ts:474-481`). The panel's exit arm renders that as "[Process Exited with code -1]" and sets `entry.exited = true` (`terminals.js:1368-1372`), which then makes `ws.onclose` skip reconnection entirely (`terminals.js:1379-1380`). The view lies about a live process being dead and never recovers. Adding a second attached client to every popped-out terminal doubles the exposure to this path.
  > **Replaced with:** Treat pause as accepted and eviction as a defect to handle. The exit arm must distinguish the two on the `reason` field: a frame carrying an eviction reason is a transport event — surface it as a dimmed "[Disconnected — reconnecting…]" line, leave `entry.exited` false so the existing backoff reconnect runs, and let the terminal-scoped `lastSeq` replay restore the missed tail on re-attach. A frame with no eviction reason keeps today's behaviour exactly.

- **Popup blocking.** `window.open` must be called synchronously inside the click handler's user-gesture context; any `await` before the call forfeits the gesture and the window is blocked. `noopener` must not appear in the features string — it forces a `null` return, which would be indistinguishable from a blocked popup and would also keep the handle out of the theme fan-out set.

## Edge-Case & Dependency Audit

**Race Conditions**
- The named terminal no longer exists when the window loads (killed between click and load). Render an explicit "terminal not found" state; do not create a terminal to fill the gap and do not fall back to an arbitrary one. Note this is the case the `initialAssignmentDone` seeding path would otherwise handle *wrongly* (`terminals.js:493-499`).
- **A failed fleet fetch is not a missing terminal.** `fetchTerminalList` swallows network and non-OK responses and leaves `fleetList` at its previous value (`terminals.js:390-412`), so on the very first load a failure is indistinguishable from an empty fleet unless solo mode tracks it. Only render not-found when a fetch actually *succeeded* and the name was absent from the returned list; on a failed first fetch show a transient "connecting…" state and let the next `terminalsChanged` refetch resolve it.
- The terminal exits while the solo window is open → latch read-only in place, same as the panel's existing `entry.exited` behaviour. Both death paths reach the client the same way: `untrackTerminalData` drains pending output, sends `{ t: 'exit' }` to every attached client and closes the socket (`terminalWsGateway.ts:430-438`). What differs is the *fleet list* — an operator close removes the name, a natural exit leaves it with `status: 'exited'` — which is why the pin, not the fleet, must hold the pane.
- The terminal is renamed while a solo window is open. `?solo=` carries the `friendlyName`, which is the rename key; the window's terminal is unaffected on the wire but its identity label goes stale. `rename()` re-keys the registry entry (`ptyFleetService.ts:156-168`), so after a rename the old name is genuinely absent from the fleet — indistinguishable from a close by name lookup alone. Refresh the title from the next fleet list; if the name is gone, keep the pinned pane and its scrollback and show a "terminal no longer listed" header state rather than destroying the view or silently retargeting.
- Repeated clicks on the same terminal must focus the existing window, not spawn duplicates — hence the deterministic window name below.
- The cockpit and the solo window both attached and both typing: the gateway serialises input per terminal through `enqueueInput` (`terminalWsGateway.ts:133-153`), so this is interleaving, not corruption. It is the same semantics as two humans on one tmux pane and needs no arbitration.

**Security**
- Same-origin only. The window is opened with a relative URL against the cockpit's own origin; no cross-origin surface is introduced.
- Credentials are never handed between windows. In the browser host the WebSocket upgrade authenticates off the same-origin `sb_session` cookie (`wsUpgradeAuth.ts:61-78`); in the extension host the token is stamped server-side into the document (`TaskViewerProvider.ts:2059`, read at `terminals.js:1288-1291`). Under neither host is a credential read from the opener, placed on the URL by client code, or copied through `postMessage`.
- The window reads `window.opener.document.body.classList` for the initial theme only. That is a same-origin read of a CSS class, wrapped in the same `try`/`catch` the existing parent-inheritance branch uses (`terminals.js:160-171`), and it must never be widened into a general opener-data channel.
- The `?solo=` value is a terminal name used for lookup and display only. It is matched against the fleet list and rendered via `textContent`; it must never be interpolated into markup, and an unmatched value produces the not-found state.
- Terminal bytes continue to go only to `term.write()`, never `innerHTML`.

**Side Effects**
- A second attached client means one extra copy of every output frame on the wire for that terminal, plus a second xterm doing its own rendering. Both are bounded per-terminal and neither touches terminals the window is not showing.
- No new WebSocket *seat* semantics to reason about beyond what the gateway already supports for reconnects. The terminal socket is `/ws/terminal`, entirely separate from the panel transport socket, and the solo document opens exactly one of each — the same pair the docked iframe already opens.
- Backpressure accounting is per-client but pausing is per-terminal: `checkBackpressure` pauses on `maxUnacked` / `maxBuffered` across all attached clients (`terminalWsGateway.ts:531-537`). A slow pop-out therefore throttles the cockpit's view of the same terminal. Accepted — it is the mechanism working — but it is a shared-fate property worth knowing before blaming the panel.

**Dependencies & Conflicts**
- **Depends on `shell-terminal-strip-completion-lights.md`** for the click affordance — that plan owns the strip and its click handler, and explicitly keeps that handler in one function so this plan can swap it. This plan is independently *testable* by navigating to `/terminals?solo=<name>` directly, and could ship before the strip with a pop-out button placed in the panel's own toolbar instead.
- No database change, no new endpoint, no verb-schema change.
- Touches `terminals.js` in the render-mode region; the strip plan touches it in the relay-emit region. Both also touch the window `message` listener (`terminals.js:289-299`), which is the one overlap point — sequence them rather than coding both simultaneously.
- Browser-cockpit only; the VS Code webview host has no `window.open` equivalent and is out of scope.

## Dependencies

- `shell-terminal-strip-completion-lights.md` — provides the strip entry whose click opens the window. Not a hard build dependency (the URL works standalone), but the intended entry point.

## Adversarial Synthesis

**Risk Summary.** The plan's stated behaviour — "close the terminal from the cockpit and the pop-out latches read-only with its scrollback intact" — does not hold against the current code: an operator close deletes the terminal from the fleet registry, `sanitizePaneAssignments` nulls the pane, and the detach timer destroys the view and its scrollback 15 seconds later; on a first load the same emptiness routes into the seeding branch and silently shows a different agent's terminal. Two further assumptions were wrong in the browser host — the terminal token is stamped only by the VS Code webview (browser auth is the `sb_session` cookie), and no theme is stamped at all, so a pop-out opened after a theme toggle loads mis-themed and the fan-out fix does not reach it. Mitigations: pin the solo slot instead of letting the fleet manage it, pre-set `initialAssignmentDone`, inherit the initial theme from `window.opener`, branch the shared exit arm so a lagging-client eviction reconnects rather than reporting a fake process exit, and separate "fetch not yet landed" from "terminal not found". Browser-specific `window.open` behaviour was the plan's remaining unknown and has since been researched and closed: the features string is honoured on creation and ignored on reuse, `noopener` returns null, the WebGL context pool is shared with the opener at ~16 contexts with cross-document LRU eviction, and `.focus()` cannot reliably raise a window on macOS — so a refused raise is now detected via a same-origin `hasFocus()` probe and routed into the existing no-dead-click fallback. The one residual risk is the shared-path exit-arm edit, covered by a new contract test and explicit UAT.

## Uncertain Assumptions

**Resolved — web research run, findings folded into the steps below.** All three items below were browser-behaviour questions that could not be answered from this codebase. Sources: HTML Living Standard §8.5.2 (window open steps), Khronos WebGL 1.0/2.0 §5.14.2 (Context Lost), and current Chrome/Safari/Firefox vendor behaviour on macOS. Nothing remains open; no item blocks implementation.

1. **WebGL context pool is shared across the two windows — confirmed.** The cap is per-renderer-process (Chrome), per-principal (Firefox), per-WebProcess (Safari), and a same-origin `window.open` popup opened *without* `noopener` shares the opener's process. Practical cap is **~16 live contexts** in all three engines, and eviction is **LRU across documents**: creating context #17 in the pop-out can fire `webglcontextlost` on a canvas in the **cockpit**. This confirms the superseded callout in the Complexity Audit — the per-document `MAX_WEBGL_CONTEXTS = 12` counter (`terminals.js:75-76`) cannot see across windows, so two documents can jointly exceed the browser budget. Impact is bounded and already handled (see Complexity Audit); no architectural change is adopted.
2. **A non-empty features string yields a real window, and features are ignored on reuse — confirmed.** `width=…,height=…` from inside a user gesture opens a separate popup window rather than a background tab in Chrome, Safari and Firefox on macOS (a user's explicit "always open links in tabs" setting can override). Per HTML LS §8.5.2, when the target name matches an existing browsing context the browser **navigates the existing window and ignores the features string entirely** — repeat clicks will not resize or reposition. That is consistent with this plan's Non-Goal on window geometry. `noopener` forcing a `null` return is also confirmed.
3. **`.focus()` is NOT reliable on macOS — this changed the plan.** Firefox blocks programmatic window raising by default (`dom.disable_window_flip = true`); Chrome and Safari are subject to macOS focus-stealing prevention and can refuse even from inside a click handler. `.focus()` returns `void`, so refusal is not detectable synchronously — but because the windows are same-origin, `popup.document.hasFocus()` read shortly after the call **is** a reliable check. Step 3 now uses it rather than treating refusal as invisible.

The prompt that produced these answers is kept at the end of this file under **Research Prompt** for audit.

## Non-Goals

- No multi-terminal pop-out. One window, one terminal — the full panel already handles grids, and a second grid surface would reintroduce the shared-layout-state problem this plan exists to avoid.
- No cross-window layout sync, tiling, or window-position persistence. The OS window manager owns geometry.
- No pop-out in the VS Code webview host.
- No change to backpressure, flow control, or the frame protocol.

## Implementation Steps

### 1. Solo render mode (`terminals.js`)

- Read `solo` from `location.search` during init, before any settings load. Hold it in a module-level `soloTerminalName` (null when absent) — every guard below reads that one variable.
- When present: skip `loadLayoutSettings()` entirely, force `currentLayout`/`effectiveLayout` to `1`, and set `paneAssignments[0]` to the single named terminal so the detach timer's `paneAssignments.includes(name)` check (`terminals.js:81-84`) always holds.
- Set `initialAssignmentDone = true` before the first `fetchTerminalList()`. Without it, a solo slot that is empty or nulled on the first pass falls into the seeding branch and the window opens `fleetList[0]` instead (`terminals.js:493-499`).
- Suppress every `saveSetting` call for the duration of the session. Implement as a single guard inside `saveSetting` itself (early return when solo), not as call-site conditionals — one guard cannot be forgotten by a later change, twelve call sites can.
- `loadSetting` for `terminals.osNotify` may still be read: notification preference is a user-level choice, not layout state, and reading it does not contaminate anything. Do not *write* it from solo mode.
- Resolve the terminal against the fleet list on the first *successful* fetch; if the fetch succeeded and the name is absent, render the not-found state and stop. A failed fetch is not an absent terminal — see step 1b.

### 1a. Pin the solo slot against fleet churn (`terminals.js`)

- In `sanitizePaneAssignments`, exempt the solo name from the stale-slot drop (`terminals.js:466-470`): when `soloTerminalName` is set, slot 0 keeps that name whether or not it is in `liveNames`. Everything else in the function is inert in solo mode (there is no undo snapshot, no second slot, and seeding is disabled by step 1).
- This is what makes the window's stated behaviour true. An operator closing the terminal from the cockpit removes it from the registry (`ptyFleetService.ts:144-154`), and a rename re-keys it (`ptyFleetService.ts:156-168`); without the exemption either event nulls the pane and `armDetachTimer` destroys the view and its scrollback 15 seconds later.
- The read-only latch stays driven by the WebSocket, not by the fleet list: `untrackTerminalData` sends `{ t: 'exit' }` and closes the socket on both death paths (`terminalWsGateway.ts:430-438`), and the existing exit arm already disables stdin.
- Reflect the fleet's view in the pane header only — "exited", or "no longer listed" after a close or rename — never by unassigning the pane.

### 1b. Distinguish transport eviction from process exit (`terminals.js`)

- In the `frame.t === 'exit'` arm (`terminals.js:1368-1372`), branch on the frame's `reason`. An eviction frame (`code: -1` with `reason: 'Lagging client evicted'`, `terminalWsGateway.ts:474-481`) must **not** set `entry.exited`, must not disable stdin, and must write a dimmed `[Disconnected — reconnecting…]` line instead of a process-exit line. Leaving `entry.exited` false is what lets the existing `ws.onclose` backoff run (`terminals.js:1379-1380`); the terminal-scoped `lastSeq` replay then restores the missed tail on re-attach.
- Any exit frame without an eviction reason keeps today's behaviour byte for byte.
- This is a shared-path change, so it improves the docked panel too. It is included because a second attached client per popped-out terminal makes eviction materially more likely, and the current rendering claims a live process is dead.

### 1c. Not-found vs not-yet-loaded (`terminals.js`)

- Track whether a fetch has completed successfully at least once. `fetchTerminalList` swallows both network errors and non-OK responses (`terminals.js:390-412`), so "no fetch has landed" and "fetch landed, name absent" are otherwise the same state.
- Before the first successful fetch: a neutral "connecting…" state. After it: not-found if the name was absent, and no terminal is created either way.

### 2. Solo chrome (`terminals.html`, `terminals.js`)

- Hide the sidebar (`terminals.html:652-667`), the layout toolbar with its picker and Clear All (`terminals.html:669-684`) and the fallback banner (`terminals.html:685-687`) via a body-level `is-solo` class rather than removing elements, so the existing markup and its contract-test coverage stay intact. `renderSidebarList()` still runs and still writes `listEl.innerHTML` into the hidden container — that is harmless and is cheaper than special-casing it, but note that the same function also toggles `emptyStateEl` / `paneGridEl` display (`terminals.js:502-511`), so an empty fleet hides the grid in solo mode too. The not-found state must therefore be rendered somewhere that is not `#pane-grid`.
- Keep the per-terminal header (name, role, clear) so the window is not a bare rectangle, and keep the existing Clear button — its scoping was already fixed to exclude non-layout buttons from the layout-picker query (`terminals.js:260-266`), so the solo chrome must not reintroduce an unscoped `.btn-layout` selector.
- Set `document.title` to the terminal name so the OS window switcher is usable with several pop-outs open.

### 3. Open the window (`shell.js`)

- Replace the strip's click handler (the seam the companion plan leaves at step 5) with a synchronous `window.open(url, name, features)` inside the click handler — no `await` before the call, or the popup is blocked.
- URL: `/terminals?solo=` + `encodeURIComponent(friendlyName)`.
- Window name: a deterministic `sb-term-<slug>` where `<slug>` is the `friendlyName` with every character outside `[A-Za-z0-9_-]` replaced by `_`, so a repeat click reuses the window. The slug is a *window handle only* — the URL still carries the exact, unsanitised name, so two terminals whose names differ only in punctuation would share a window; accept that, or include a short hash of the full name in the slug.
- Features: a non-empty features string (e.g. `width=900,height=700`) is what makes this a window rather than a background tab — confirmed across Chrome, Safari and Firefox on macOS when called from a user gesture. **Never include `noopener`** — it forces a `null` return (HTML LS §8.5.2), which is indistinguishable from a blocked popup and also keeps the handle out of the theme fan-out set.
- Note that on a **reuse** call the features string is ignored entirely: per HTML LS §8.5.2 a matching target name navigates the existing browsing context and never re-applies features. Repeat clicks therefore cannot resize or reposition the window, which is consistent with the Non-Goal on window geometry — do not write code that expects otherwise.
- Handle a null return (blocked) by falling back to the in-cockpit behaviour: select the Terminals panel and focus that terminal. A blocked popup must never be a dead click.
- **Focus, and detecting when it is refused.** Call `.focus()` on the returned handle — reuse alone does not raise the window — but do not assume it worked. Research confirms `.focus()` is unreliable on macOS: Firefox blocks programmatic window raising by default (`dom.disable_window_flip = true`), and Chrome/Safari are subject to OS focus-stealing prevention even from inside a click handler. It returns `void`, so refusal is not detectable synchronously.
  - Because both windows are same-origin, read `handle.document.hasFocus()` on a short timeout (~100ms) after the call. `true` means the window came forward; `false` means the raise was refused.
  - On refusal, apply the **same** fallback as a blocked popup: select the Terminals panel and focus that terminal in the cockpit. The rule is unchanged — a click must never do nothing visible — and reusing one fallback avoids a second code path. The pop-out stays open and keeps mirroring; the user simply gets the terminal in front of them either way.
  - Wrap the `hasFocus()` read in `try`/`catch` and treat a throw as "focused" (do nothing). A closed or navigating window must not turn a successful open into a spurious panel switch.
  - Considered and not adopted: posting a message to the pop-out so it flashes its own title bar. It only helps if the window is already visible on screen, which is exactly the case where focus refusal does not matter.

### 4. Theme propagation across windows (`shell.js`, `terminals.js`)

- **Initial theme (`terminals.js`).** Extend `resolveInitialTheme()` (`terminals.js:156-173`) with an `window.opener` branch alongside the existing `window.parent` branch: same-origin, same `try`/`catch`, same `ALL_THEME_CLASSES` lookup, same afterburner fallback when neither is available. Without this a pop-out opened after an in-session toggle loads in the wrong theme, because the browser host stamps no theme at all (`bootstrap.ts:481`, `bootstrap.ts:493-497` both omit `themeClass`).
- **Subsequent toggles (`shell.js`).** Keep the handles returned by `window.open` in a set and include them in `applyThemeToAll`'s fan-out (`shell.js:122-134`) alongside the iframes, using `location.origin` as target origin.
- Prune closed windows on each fan-out by checking `.closed`, so the set does not grow across a session.
- The solo page already listens for `switchboardThemeChanged` (`terminals.js:294-295`) and needs no change to receive it. A toggle fired before the new window's script has run is simply lost — harmless, because the opener-inheritance branch above already gave it the right theme at load.

## Proposed Changes

### `src/webview/terminals.js`
- **Context:** The panel's single client script — owns layout state, pane assignment, the fleet fetch, the per-terminal WebSocket and the theme resolution. Solo mode is a mode *of this file*, not a second file.
- **Logic:** Solo mode detected from `location.search` into a module-level `soloTerminalName`; layout forced to `1` with the named terminal pinned to slot 0; `initialAssignmentDone` pre-set so the seeding branch cannot retarget the window; the solo name exempted from the stale-slot drop in `sanitizePaneAssignments`; a single write-suppression guard inside `saveSetting`; a first-successful-fetch flag separating "connecting" from "not found"; the exit arm branching on an eviction `reason` so a transport eviction reconnects instead of latching; `resolveInitialTheme()` extended with a `window.opener` branch; `document.title` set from the terminal name.
- **Implementation:** All guards read the one `soloTerminalName` variable; the write suppression is a single early return at the top of `saveSetting` (`terminals.js:352`), never per call site. The eviction branch and the opener-theme branch are shared-path improvements that keep their non-solo behaviour byte-identical.
- **Edge cases:** Detach timer never fires (pinned assignment survives fleet removal). Operator close, natural exit and rename all keep the pane and its scrollback and change only the header state. Failed first fetch renders "connecting…", not "not found". `window.parent === window` in a popped-out window, so the strip relay from the companion plan correctly no-ops.

### `src/webview/terminals.html`
- **Context:** Single source of truth for the panel's palette and chrome markup; served by `getTerminalsHtml` for both hosts.
- **Logic:** `is-solo` body class hiding the sidebar (`652-667`), the layout toolbar (`669-684`) and the fallback banner (`685-687`) while leaving the markup in place. A solo not-found / connecting container that is not inside `#pane-grid`.
- **Implementation:** CSS-only hiding — no element removal, no markup reordering.
- **Edge cases:** Does not reintroduce an unscoped `.btn-layout` query (regression guard for the Clear All scoping fix). Keeps exactly one `SHARED_DEFAULTS_SCRIPT` marker. Adds no second bare `::-webkit-scrollbar {` block — `test:contract:panel-scrollbars` asserts exactly one per browser-served file. No literal `<body>` tag in comments — `applyThemeClass` stamps the first match in the file.

### `src/webview/shell.js`
- **Context:** The app-shell. Owns the strip, the iframe map and the theme fan-out; has no WebSocket of its own.
- **Logic:** Strip click opens `sb-term-<slug>` synchronously and focuses it; blocked-popup fallback to in-cockpit focus; open-window handles tracked and included in the theme fan-out with `.closed` pruning.
- **Implementation:** `window.open` is the first statement in the handler — nothing awaited before it. Features string sets a window size and omits `noopener`. A ~100ms `hasFocus()` probe after `.focus()` detects a refused raise (same-origin read, `try`/`catch`-wrapped, throw treated as success).
- **Edge cases:** Repeat clicks reuse the named window rather than duplicating, and cannot resize it (features ignored on reuse). Null handle never produces a dead click. A refused `.focus()` falls back to in-cockpit focus rather than silently doing nothing. Closed windows pruned from the fan-out set.

## Verification Plan

### Automated Tests

- New contract test: with `?solo=` set, no `saveSetting` call is issued for `terminals.layoutMode`, `terminals.paneAssignments` or `terminals.collapsedWorktrees` across a full init-and-render cycle. This is the plan's central guarantee and needs a regression guard, not just a UAT step.
- New contract test: `?solo=<unknown>` renders the not-found state and creates no terminal.
- New contract test: the solo slot survives fleet removal. Given `?solo=A` and a subsequent fleet list that no longer contains `A`, `paneAssignments[0]` is still `A` and no detach timer is armed for it. This is the guard on the window's central promise — "kill it from the cockpit and the scrollback stays" — and it is the behaviour that fails today.
- New contract test: an exit frame carrying `reason: 'Lagging client evicted'` leaves `entry.exited` false and does not disable stdin; an exit frame without a reason still sets both.
- `npm run test:contract:panel-scrollbars` — `shell.html` and `terminals.html` are both inside this contract's discovery set (it regexes `path.join(repoRoot, 'src', 'webview', '<file>.html')` out of `headlessPanelHtml.ts`, which matches both `getShellHtml` and `getTerminalsHtml`). The panel's markup is class-gated, not removed, so it should pass unchanged; a failure means elements were deleted rather than hidden, or a second bare `::-webkit-scrollbar` block was added.
- `npm run test:contract:shim-injection` — unchanged expectations. The contract only requires the `SHARED_DEFAULTS_SCRIPT` marker in files that dereference a `sharedDefaults.js` binding, and neither the solo chrome nor `shell.html` introduces one.
- `npm run test:contract:terminal-token-transport` — **does not cover this plan.** It exercises the extension-host stamping path (`injectBodyAttributes` + `getTerminalsHtml` + the `dataset.terminalToken` read) and the browser pop-out never takes that path; it authenticates by `sb_session` cookie. Run it as an unrelated regression guard, and do not record it as evidence that the solo window authenticates correctly — that is a UAT observation, not a covered contract.
- `npm run compile` and `npm run lint` clean.

### Manual UAT (darwin)

- Click a strip terminal → a window opens showing exactly that terminal, full-window, no sidebar or layout picker; the window title is the terminal name.
- Type in the pop-out and in the cockpit's Terminals panel alternately → both views show all output from both, in order; neither view stalls.
- Return to the cockpit, open Terminals, change the layout to `2x2`, reload the cockpit → the layout is `2x2`. This is the shared-settings regression check: before the guard, the pop-out would have reset it.
- Click the same strip terminal again → the existing window is reused, not duplicated. Run this twice with the pop-out **behind** the cockpit: on a browser that raises it, the window comes forward; on Firefox (which blocks window flipping by default) the raise is refused and the cockpit must instead switch to the Terminals panel with that terminal focused. Neither outcome may be a dead click, and neither may open a second window.
- **Close** the terminal from the cockpit's × button → the pop-out latches read-only, keeps its scrollback, and does not close. This is the operator-close path, which removes the terminal from the fleet registry (`ptyFleetService.ts:144-154`); without the slot pin the pane empties and the view is destroyed 15s later, so this step is the pin's acceptance check.
- **Let a process exit on its own** (`exit` at the shell prompt) → same read-only latch, and the terminal remains in the cockpit's sidebar with an `exited` status. Verifying both paths matters because the fleet registry treats them differently.
- Rename the terminal from the cockpit while the pop-out is open → the pop-out keeps its pane, its scrollback and its socket; the header reports the name is no longer listed rather than going blank or retargeting.
- Navigate directly to `/terminals?solo=<name-that-does-not-exist>` → not-found state, no terminal created, no console errors.
- Open a pop-out, then stop the API server and reload the pop-out → "connecting…", not "not found". Restart the server → it resolves without a manual reload.
- Toggle the theme in the cockpit, *then* open a pop-out → the new window opens already in the cockpit's theme (this is the opener-inheritance check; it fails today because the browser host stamps no theme). Toggle again with the pop-out open → the pop-out re-tints. Close the pop-out and toggle again → no console errors from posting to a closed window.
- Run a high-output command (`yes`, or a large build) with both views attached → confirm flow control still recovers. If a client is evicted, the affected view must print `[Disconnected — reconnecting…]`, reconnect on its own, and replay the missed tail — it must never claim the process exited with code -1.
- Open seven or more pop-outs against a full `3x3` cockpit grid → some terminals drop to the canvas renderer as the shared ~16-context GPU budget is exceeded. Confirm they keep rendering (no blank panes, no thrown errors) — this is the accepted LRU-eviction degradation path, not a bug.
- Confirm no `confirm()` or two-click gate anywhere in the new UI.

## Recommendation

**Send to Coder.** Complexity 6 — three files, no server change, but two of the edits sit on state the docked panel also depends on (pane-assignment bookkeeping and the WebSocket exit arm), so the new contract tests are not optional.

## Research Prompt

**Already run — answers are recorded under Uncertain Assumptions and folded into steps 3 and 4.** Kept for audit only; no action required. The prompt below is what produced them.

```text
Research current (2026) browser behaviour for three window.open / WebGL questions,
targeting Chrome, Safari and Firefox on macOS. Cite the spec (HTML Living Standard,
WebGL spec) and current browser-source or vendor documentation, not blog posts,
wherever possible. Note explicitly where behaviour differs by browser or version.

1. WebGL context limits across browsing contexts.
   - Is the live WebGL context cap per-document, per-renderer-process, or per-browser?
   - Do contexts created in a separate top-level window opened via window.open count
     against the same pool as the opener's contexts?
   - What are the current practical caps in Chrome, Safari and Firefox, and what is
     the eviction policy when the cap is exceeded (oldest context lost? creation
     refused?) — specifically, does an over-cap creation cause an EXISTING context in
     ANOTHER document to fire webglcontextlost?

2. window.open features strings and named-window reuse.
   - Does a non-empty features string (e.g. "width=900,height=700") still reliably
     produce a separate popup window rather than a background tab in Chrome, Safari
     and Firefox on macOS, given current popup and tab-preference behaviour?
   - When window.open is called with a window NAME that matches an already-open
     window, are the features honoured, ignored, or partially applied to the existing
     window?
   - Confirm that including "noopener" in the features string forces a null return
     value, and that omitting it returns a usable WindowProxy for same-origin windows.

3. Programmatic focus of an existing window.
   - Does calling .focus() on a WindowProxy returned by window.open reliably raise an
     already-open window on macOS, or is it subject to focus-stealing prevention?
   - Does it matter whether the call happens inside a user-gesture (click) context?
   - Is there any reliable way to detect that focus() was refused?

Deliver a short answer per question with a clear "confirmed / varies by browser /
not reliable" verdict, plus the implications for a same-origin popped-out terminal
window that must (a) reuse rather than duplicate on repeat clicks, and (b) not
degrade the opener's WebGL-rendered terminals.
```
