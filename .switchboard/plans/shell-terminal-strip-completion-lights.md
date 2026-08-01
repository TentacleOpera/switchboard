# Shell Terminal Strip with Completion Lights

## Goal

Give the browser cockpit's app-shell a persistent, always-visible list of fleet terminals with a per-terminal status light, so a user working on the Board can see that an agent finished without switching panels.

### Problem analysis / root cause

The user-reported annoyance is the round-trip: work in Kanban → dispatch a card → switch to Terminals to check → switch back. Investigation shows that trip is mostly a **notification** problem, not a layout problem.

The completion signal already exists and already works. `handleAgentCompleted` (`terminals.js:1491-1521`) fires on the `agentCompleted` broadcast and does three things: sets a `DONE` badge in `terminalBadges` for the resolved terminal, pops an in-panel toast, and — if enabled — raises an OS notification. The failure is *where those land*:

- **The toast and badge are painted inside a hidden iframe.** The shell mounts every panel as an iframe up-front and switches by toggling `display` (`shell.js:32-44`, `.panel-frame.is-active` in `shell.html:135-144`). While the user is on the Board, the Terminals iframe is `display:none`. The one UI element designed to say "your agent finished" is rendered onto a surface nobody is looking at.
- **The OS notification is off by default.** `terminals.osNotify` loads with a `false` default (`terminals.js:366`) and permission is only requested on explicit opt-in (`terminals.js:274-281`). It is a real escape hatch, but most users will never have found it.
- **The shell has no concept of panel activity at all.** `shell.js` handles exactly two inbound messages — `switchPanel` and `switchboardThemeChanged` (`shell.js:194-205`) — and renders the strip purely from the static `/panels` manifest (`shell.js:146-175`). There is no badge, dot, or count anywhere in the strip.

So when a coder finishes while the user is on the Board, **nothing on screen changes**. That is what produces the speculative "let me go look" switch, and no amount of terminal real-estate fixes it better than a light in the strip would.

A secondary finding shaped the design: the shell has **no WebSocket of its own**. `getShellHtml` (`headlessPanelHtml.ts:143-158`) does not call `injectTransportShim` — unlike `getTerminalsHtml`, which does (`headlessPanelHtml.ts:399`). Giving the shell its own socket would also mean a second WS seat per browser and an unfiltered surface subscription, because `transport.js` derives its surface filter from `document.body.dataset.panel` (`transport.js:118-121`) and the shell body has no `data-panel`. The Terminals panel already holds both the fleet list and the completion events, and the iframe→shell `postMessage` bridge already exists (`shell.js:194-205`). Relaying up that bridge is strictly cheaper than a second socket.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, feature

## User Review Required

- **Light states are deliberately limited to `active` / `done` / `exited` in this plan.** A "currently working" state is *not* included — see Non-Goals for why and what it would cost. Confirm that a light which distinguishes "finished" from "still there" is the ask, rather than a full activity indicator.
- **Click behaviour in this plan is "select the Terminals panel and focus that terminal."** Pop-out-on-click is the companion plan (`terminal-solo-popout-window.md`) and replaces this handler. If pop-out is the only behaviour you want, this plan still needs to ship first — it owns the strip that the click lives on.
- Everything else is decided below: relay mechanism, strip placement, overflow behaviour, badge-clear propagation.

## Complexity Audit

### Routine
- Rendering a list into `#strip` — the shell already builds buttons with masked SVG glyphs, hover labels and active state (`shell.js:46-91`), and the terminal entries reuse that vocabulary.
- Fetching the fleet: the panel already does it via `POST /terminals/verb/ptyListTerminals` (`terminals.js:390-412`), and the payload already carries everything the strip needs — `friendlyName`, `role`, `status`, `worktreePath` (`bootstrap.ts:995-1007`).
- `status` is already exactly the two-valued `'active' | 'exited'` the lights need (`ptyFleetService.ts:19,32`).
- The panel already re-fetches on `terminalsChanged` (`terminals.js:292-293`), so the relay has a natural, already-correct firing point.
- The iframe→parent message bridge exists and is already listened to (`shell.js:194-205`); this adds message types, not a mechanism.

### Complex / Risky
- **Strip overflow.** `#strip` is `overflow-y: auto` and is the document's only scroller (`shell.html:56-68`, and the comment at `shell.html:152-155`). Seven panel icons plus a nine-terminal fleet will overflow on short windows. The terminal section needs its own bounded scroll region so panel navigation never scrolls out of reach.
- **The theme toggle is bottom-anchored via `margin-top: auto`** (`shell.js:98`). Inserting a terminal section between the panel icons and the toggle interacts with that flex behaviour; naive `appendChild` ordering will put terminals below the toggle or defeat the anchor.
- **Badge lifecycle is owned by the panel, mirrored by the strip.** `terminalBadges` lives in `terminals.js` and is cleared on acknowledge. Two surfaces showing one piece of state means the clear must propagate, or the strip keeps a light burning after the user has already dismissed it in the panel.
- **Fail-closed gating.** Terminals is capability-gated and *omitted*, not greyed, when node-pty is unavailable (`headlessPanelHtml.ts:426` uses `availability?.terminals === true`; the shell skips disabled panels entirely at `shell.js:160`). The strip section must follow the same rule — a terminal section with no terminals panel behind it is a dead control.
- **Rename invalidates the badge key.** Badges are keyed by `friendlyName`; a rename changes the key server-side. This is a pre-existing sharp edge in the panel, and the strip inherits it rather than introducing it.

## Edge-Case & Dependency Audit

**Race Conditions**
- The strip renders before the Terminals iframe has loaded and completed its first `fetchTerminalList`. The section must render empty-but-present (or absent until first payload) rather than flashing a broken list.
- `agentCompleted` can arrive for a terminal that is not in the strip's last-known fleet snapshot (dispatch created it, list not yet refreshed). Accept the badge against the unknown name and let the next `terminalsChanged` refetch reconcile — do not drop the signal.
- Rapid create/close churn: the relay is last-write-wins on a whole-fleet snapshot, matching the panel's own list semantics. No incremental diffing, so no ordering race to introduce.
- Terminal exits while a `DONE` badge is outstanding — `exited` and `done` are not mutually exclusive. Define precedence explicitly (below) rather than letting render order decide.

**Security**
- **No terminal bytes reach the strip.** The panel's standing rule (terminal output goes only to `term.write()`, never `innerHTML`) extends here: the relay carries only fleet metadata and board-derived strings. All strip text is assigned via `textContent`.
- The relay posts to `window.parent` — target origin must be `location.origin`, not `'*'`. Note that the existing shell→iframe theme fan-out uses `'*'` (`shell.js:131`); that is pre-existing and out of scope, but new code should not copy it.
- The shell must validate inbound relay messages the same way it already guards `switchPanel` — reject non-object payloads and unknown types (`shell.js:196-198`).

**Side Effects**
- The strip adds a second render path for fleet state. It is metadata-only (no xterm instances, no sockets), so the cost is a small DOM update per `terminalsChanged`, not per output frame.
- No new WebSocket, no new WS seat, no new surface subscription — deliberately, per the root-cause analysis above.

**Dependencies & Conflicts**
- Depends on shipped work only: the `agentCompleted` broadcast and `dispatched_terminal` targeting from `terminals-panel-v2-layouts-worktree-tabs.md`, and the fleet registry behind `ptyListTerminals`.
- No database change. No new HTTP endpoint. No verb-schema change.
- The extension host is unaffected: the app-shell is a browser-cockpit surface only, and Terminals is already standalone-gated, so the shipped extension's behaviour is untouched.
- Conflicts with nothing in flight on `claude/terminal-panel-layout-8cli4r` beyond the terminals panel itself; the companion pop-out plan touches `terminals.js` in a different region (render mode), and this plan's `terminals.js` change is confined to the relay emit.

## Dependencies

- none — no session dependencies. Shipped file-level dependencies are listed under **Edge-Case & Dependency Audit**.

## Non-Goals

- **No "currently working" light.** The board's activity light is driven by `dispatched_at` being non-null, which is board state the strip has no access to. Surfacing it would need a new `agentDispatched` broadcast symmetric with `agentCompleted`, emitted at the dispatch site that already writes `dispatched_terminal` (`bootstrap.ts:1080-1092`), plus extension-host parity. That is a coherent follow-up, but it is a second feature and it is not what "completion lights" asks for.
- No drag-and-drop onto the strip. Drag-to-column already dispatches (`bootstrap.ts:1054-1092`), and a drop target on a terminal would be a second, ambiguous way to do the same thing — explicitly cut during design.
- No terminal creation, rename, or close from the strip. The strip is a status surface; mutation stays in the panel.
- No strip in the VS Code webview host. This is the browser app-shell only.

## Implementation Steps

### 1. Relay fleet state up to the shell (`terminals.js`)

- Add `postFleetStateToShell()`: builds a compact snapshot from the existing `fleetList` plus `terminalBadges`, and posts `{ type: 'terminalFleetState', terminals: [{ name, role, worktreePath, light }] }` to `window.parent` with `location.origin` as target origin.
- Guard with `if (window.parent === window) return;` so the standalone/solo page (companion plan) does not post to itself.
- Call it from the three points where the underlying state changes: the end of `fetchTerminalList` (`terminals.js:398-407`), the end of `handleAgentCompleted` (`terminals.js:1506-1510`), and wherever a badge is cleared on acknowledge.
- `light` is resolved panel-side, not shell-side, so the two surfaces cannot disagree. Precedence, highest first: `exited` (status `'exited'`) → `done` (badge set) → `active`. A terminal that finished and then died reads as `exited`; the completion is still discoverable in the panel.

### 2. Render the terminal section in the strip (`shell.js`, `shell.html`)

- Extend the `message` listener (`shell.js:194-205`) with a `terminalFleetState` arm that stores the snapshot and re-renders the section.
- Insert a `#strip-terminals` container between the panel icons and the theme toggle. Because the toggle is anchored with `margin-top: auto` (`shell.js:98`), build the strip as: panel icons → `#strip-terminals` → theme toggle, and move the auto-margin onto the terminals container so the toggle stays pinned to the bottom and the terminal list stays adjacent to the panel icons.
- Each entry is a button in the existing `.strip-icon` idiom, so it inherits hover, focus and the `.strip-label` flyout (`shell.html:110-128`). The label shows `friendlyName` plus role; the flyout shows the worktree basename, since basenames collide across sibling checkouts.
- The light is a small dot positioned on the entry, coloured from the three states. Do not rely on colour alone — vary the dot (filled / ring / hollow) so the state survives a colourblind viewer and a monochrome screenshot.
- A thin separator above the section so terminals read as a distinct group, not more panels.

### 3. Bound the strip's scroll (`shell.html`)

- Give `#strip-terminals` its own `overflow-y: auto` with a `max-height`, so a large fleet scrolls within the section and the panel icons plus theme toggle remain reachable at any window height.
- Reuse the existing 6px scrollbar treatment already defined for the shell (`shell.html:158-184`), including the Firefox `@supports not selector(::-webkit-scrollbar)` gate — do not hoist those rules or add a second, competing scrollbar block.

### 4. Gate the section (`shell.js`)

- Render `#strip-terminals` only when a `terminals` panel is present and enabled in the manifest. The shell already skips disabled panels (`shell.js:160`), so the check is against the same manifest entry that produced (or omitted) the Terminals icon — matching the fail-closed rule at `headlessPanelHtml.ts:426`.
- When the section is gated off, the shell must not listen for or warn about `terminalFleetState` — it simply never arrives.

### 5. Click behaviour (this plan's version)

- Clicking a strip entry calls the existing `selectPanel('terminals')` and posts `{ type: 'focusTerminal', name }` down to the Terminals iframe.
- Add a `focusTerminal` arm to the panel's `message` listener (`terminals.js:289-299`) that assigns that terminal to the focused pane — the same operation a sidebar click already performs — and clears its badge.
- This handler is the seam the companion pop-out plan replaces. Keep it in one function so the swap is a one-line change, not a refactor.

## Proposed Changes

### `src/webview/terminals.js`
- **Logic:** `postFleetStateToShell()` emitting `terminalFleetState` to `window.parent` at `location.origin`; called after `fetchTerminalList`, after `handleAgentCompleted`, and on badge clear. New `focusTerminal` arm on the window `message` listener that assigns the named terminal to the focused pane and clears its badge.
- **Edge cases:** No-op when `window.parent === window` (solo/popout page). Light precedence `exited` > `done` > `active` resolved here so both surfaces agree. `focusTerminal` for an unknown name is ignored, not an error.

### `src/webview/shell.js`
- **Logic:** `terminalFleetState` arm on the existing message listener; `renderTerminalSection()` building `.strip-icon`-styled entries with a state dot and worktree flyout; section gated on the manifest's `terminals` entry; click selects the Terminals panel and posts `focusTerminal` down.
- **Edge cases:** Snapshot arriving before/after first render both converge (store-then-render). Unknown message shapes rejected alongside the existing `switchPanel` guard. Theme toggle stays bottom-anchored when the section is inserted.

### `src/webview/shell.html`
- **Logic:** `#strip-terminals` container styles — bounded `max-height` with its own `overflow-y: auto`, separator, and the state-dot classes.
- **Edge cases:** Reuses the existing 6px scrollbar rules and their Firefox `@supports` gate rather than adding a second block. No literal `<body>` tag written in comments — `applyThemeClass` stamps the first match in the file (see the standing warning at `shell.html:37-42`).

## Verification Plan

### Automated Tests

- `npm run test:contract:panel-scrollbars` — confirm first whether the shell is inside this contract's discovery set (it enumerates via `headlessPanelHtml.ts`, and the shell is served by `getShellHtml`, not `getPanelHtmlById`). If it is, the new `#strip-terminals` scroller must satisfy the 6px + Firefox-gate rule; if it is not, state that plainly rather than claiming coverage that does not exist.
- `npm run test:contract:shim-injection` — unchanged expectations; this plan deliberately does **not** inject the transport shim into the shell, and the test should continue to reflect that.
- New contract test: light precedence. Given a terminal that is both `exited` and badged `DONE`, the relayed `light` is `exited`.
- New contract test: the terminal section is absent from the rendered strip when the manifest reports `terminals` disabled.
- `npm run compile` and `npm run lint` clean.

### Manual UAT (darwin)

- Open the cockpit on the Board with two agents running. Dispatch a card, let the agent finish → the strip light turns `done` **while the Board is still the visible panel**, with no panel switch.
- Click the lit entry → Terminals panel opens with that terminal in the focused pane and the badge cleared. Return to the Board → light is no longer lit.
- Kill a terminal → its light goes `exited` and stays in the list (not silently dropped).
- Let a terminal finish and then die → light reads `exited`, and the completion is still visible as a badge inside the panel.
- Spawn nine terminals on a short window → the terminal section scrolls internally; all panel icons and the theme toggle remain clickable without scrolling the section out of view.
- Run against a host with node-pty unavailable → no Terminals icon **and** no terminal section; no console warnings about missing relay messages.
- Toggle the theme with the section populated → dots and labels re-tint with the strip, and the toggle stays pinned to the bottom.
- Confirm no `confirm()` or two-click gate is introduced anywhere in the new UI.
