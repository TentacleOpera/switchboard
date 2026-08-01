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
- **Rename invalidates the badge key.** Badges are keyed by `friendlyName`; a rename changes the key server-side (`ptyFleetService.ts:156-168` deletes and re-inserts the registry entry under the new alias). This is a pre-existing sharp edge in the panel, and the strip inherits it rather than introducing it.
- **The bottom anchor is an inline style, so the two `margin-top: auto` elements will fight.** `buildThemeToggle` sets `btn.style.marginTop = 'auto'` directly on the element (`shell.js:98`). Adding a second auto-margined child to the same column flex container does not stack them — the free space is distributed *between* both auto margins, which parks the terminal section in the middle of the strip and leaves a gap above the toggle. The inline style must be removed from the toggle whenever the terminals section is rendered, and restored (i.e. left in place) when the section is gated off.
- **An operator-closed terminal leaves the fleet entirely; a self-exited one does not.** `kill(name)` deletes the handle from the registry (`ptyFleetService.ts:144-154`), so it stops appearing in `ptyListTerminals`. A process that dies on its own only has `status` set to `'exited'` (`ptyFleetService.ts:101-107`) and stays in the list. The `exited` light therefore only ever appears for the second case — which is correct, but it means "kill a terminal, watch its light go `exited`" is not a valid expectation for the × button.

## Edge-Case & Dependency Audit

**Race Conditions**
- The strip renders before the Terminals iframe has loaded and completed its first `fetchTerminalList`. The section must render empty-but-present (or absent until first payload) rather than flashing a broken list.
- `agentCompleted` can arrive for a terminal that is not in the strip's last-known fleet snapshot (dispatch created it, list not yet refreshed). Accept the badge against the unknown name and let the next `terminalsChanged` refetch reconcile — do not drop the signal.

  > **Superseded:** …let the next `terminalsChanged` refetch reconcile — do not drop the signal. *(as satisfied by the step-1 design, which builds the snapshot from `fleetList` alone)*
  > **Reason:** A snapshot built by mapping over `fleetList` structurally *cannot* carry a badge for a name that is not in `fleetList` — the entry has nothing to hang off. As written, step 1 drops exactly the signal this edge case says must survive, and the reconciliation only happens if some *other* event triggers a refetch. `handleAgentCompleted` does not call `fetchTerminalList` (`terminals.js:1491-1522`), so there is no guarantee one arrives.
  > **Replaced with:** When `handleAgentCompleted` resolves a target that is not present in `fleetList`, call `fetchTerminalList()` — which already ends by relaying (step 1) — so the strip converges on the next tick with the terminal *and* its badge. The badge is set before the refetch, so the relay built from the refreshed list carries it. This is self-reconciling and needs no badge-only placeholder entries in the snapshot schema.
- Rapid create/close churn: the relay is last-write-wins on a whole-fleet snapshot, matching the panel's own list semantics. No incremental diffing, so no ordering race to introduce.
- Terminal exits while a `DONE` badge is outstanding — `exited` and `done` are not mutually exclusive. Define precedence explicitly (below) rather than letting render order decide.

**Security**
- **No terminal bytes reach the strip.** The panel's standing rule (terminal output goes only to `term.write()`, never `innerHTML`) extends here: the relay carries only fleet metadata and board-derived strings. All strip text is assigned via `textContent`.
- **No terminal bytes reach the strip** (continued). The relay carries `friendlyName`, `role`, `worktreePath` and a resolved `light` — all of which originate from `ptyListTerminals` (`bootstrap.ts:995-1007`) or from the panel's own badge map, never from PTY output.
- The relay posts to `window.parent` — target origin must be `location.origin`, not `'*'`. Note that the existing shell→iframe theme fan-out uses `'*'` (`shell.js:131`); that is pre-existing and out of scope, but new code should not copy it.
- The shell must validate inbound relay messages the same way it already guards `switchPanel` — reject non-object payloads and unknown types (`shell.js:196-198`) — **and additionally check `event.origin === location.origin` on the new arm.** The existing listener performs no origin check at all; it only skips `event.source === window` (`shell.js:195`). That is tolerable for a message whose entire effect is "show a panel that is already mounted", but the relay drives rendered content, so it must not accept a payload from an arbitrary frame or opener. Add the check on the new arm rather than retrofitting the whole listener, which would be a behaviour change to shipped code outside this plan's scope.
- The panel-side `focusTerminal` arm receives a message from the shell into an iframe whose own listener also handles synthetic transport events (`transport.js:157-162` dispatches server pushes as `MessageEvent`s on `window`, so they arrive with `origin: ''`). An origin check on the *panel* side would therefore reject the server pushes it needs. Scope the check to the `focusTerminal` arm alone: accept only `event.origin === location.origin`, and leave the existing `terminalsChanged` / `switchboardThemeChanged` / `agentCompleted` arms untouched.

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

## Adversarial Synthesis

**Risk Summary.** The relay design is sound and confirmed against the code — the Terminals iframe is mounted and live while the Board is visible (`shell.js:154-167`), `agentCompleted` is broadcast on the `common` surface so it reaches the panel regardless of which panel is on screen (`bootstrap.ts:404-410`), and the fleet payload already carries every field the lights need. Three defects were in the plan rather than the code: a snapshot built from `fleetList` alone silently drops the "badge for a terminal not yet in the list" signal the edge-case audit promises to keep; the bottom anchor is an inline style on the theme toggle, so adding a second `margin-top: auto` child parks the terminal list mid-strip rather than stacking; and clicking a lit entry for a terminal already in the focused pane leaves the light burning, because `assignToFocusedPane` early-returns before its badge clear. Mitigations: refetch-on-unknown-name, move the anchor off the toggle when the section exists, and clear the badge in the `focusTerminal` arm itself. Two verification claims were also corrected — `shell.html` *is* covered by the scrollbar contract (so a second `::-webkit-scrollbar` block fails the suite), and the × button removes a terminal from the fleet outright, so "kill it and watch the light go `exited`" was never going to pass.

## Non-Goals

- **No "currently working" light.** The board's activity light is driven by `dispatched_at` being non-null, which is board state the strip has no access to. Surfacing it would need a new `agentDispatched` broadcast symmetric with `agentCompleted`, emitted at the dispatch site that already writes `dispatched_terminal` (`bootstrap.ts:1080-1092`), plus extension-host parity. That is a coherent follow-up, but it is a second feature and it is not what "completion lights" asks for.
- No drag-and-drop onto the strip. Drag-to-column already dispatches (`bootstrap.ts:1054-1092`), and a drop target on a terminal would be a second, ambiguous way to do the same thing — explicitly cut during design.
- No terminal creation, rename, or close from the strip. The strip is a status surface; mutation stays in the panel.
- No strip in the VS Code webview host. This is the browser app-shell only.

## Implementation Steps

### 1. Relay fleet state up to the shell (`terminals.js`)

- Add `postFleetStateToShell()`: builds a compact snapshot from the existing `fleetList` plus `terminalBadges`, and posts `{ type: 'terminalFleetState', terminals: [{ name, role, worktreePath, light }] }` to `window.parent` with `location.origin` as target origin.
- Guard with `if (window.parent === window) return;` so the standalone/solo page (companion plan) does not post to itself.
- Call it from every point where the underlying state changes. These are enumerable, so enumerate them rather than leaving "wherever a badge is cleared" to discovery:
  - the end of the success branch of `fetchTerminalList` (`terminals.js:398-407`) — this is the single funnel for fleet refreshes and already covers create (`terminals.js:1008`), close (`terminals.js:1051`), rename (`terminals.js:1095`), init (`terminals.js:311`) and the `terminalsChanged` broadcast (`terminals.js:293`);
  - the end of `handleAgentCompleted` (`terminals.js:1507-1511`);
  - both badge-clear sites inside `assignToFocusedPane` — the already-in-a-full-grid branch (`terminals.js:718`) and the normal assignment path (`terminals.js:735-737`);
  - the new `focusTerminal` arm from step 5, which clears a badge on a path `assignToFocusedPane` can early-return out of.
- `light` is resolved panel-side, not shell-side, so the two surfaces cannot disagree. Precedence, highest first: `exited` (status `'exited'`) → `done` (badge set) → `active`. A terminal that finished and then died reads as `exited`; the completion is still discoverable in the panel.
- When `handleAgentCompleted` resolves a target that is **not** in `fleetList`, set the badge and then call `fetchTerminalList()`. The refetch relays a snapshot that contains both the new terminal and its badge, which is what makes the "badge for an unknown name" edge case actually converge (see the Edge-Case audit).

### 2. Render the terminal section in the strip (`shell.js`, `shell.html`)

- Extend the `message` listener (`shell.js:194-205`) with a `terminalFleetState` arm that stores the snapshot and re-renders the section.
- Create the empty `#strip-terminals` container **eagerly inside `renderManifest`**, after the panel-icon loop and before `strip.appendChild(themeBtn)` (`shell.js:167-170`). Creating it lazily on the first relay would append it *after* the theme toggle, because `appendChild` always appends to the end.
- Move the bottom anchor onto the container, and remove it from the toggle. `buildThemeToggle` sets `btn.style.marginTop = 'auto'` inline (`shell.js:98`); leaving that in place while adding a second auto-margined child splits the free space between the two, parking the terminal list mid-strip. When the section is rendered: `#strip-terminals` carries `margin-top: auto`, the toggle carries none. When the section is gated off (step 4): the toggle keeps its inline anchor exactly as today.
- Each entry is a button in the existing `.strip-icon` idiom, so it inherits hover, focus and the `.strip-label` flyout (`shell.html:110-128`). The strip is 48px wide with 36px buttons, so the *button content* is a compact glyph — the role's first letter — and all identifying text lives in the one `.strip-label` flyout: `friendlyName · role · worktree-basename`. (The earlier phrasing named the flyout twice, for two different payloads; `.strip-label` *is* the flyout, and there is only one.) The basename is included because it disambiguates same-role agents across sibling checkouts, and basenames themselves collide — so use `title` on the button for the full `worktreePath`.
- The light is a small dot positioned on the entry, coloured from the three states. Do not rely on colour alone — vary the dot (filled / ring / hollow) so the state survives a colourblind viewer and a monochrome screenshot.
- A thin separator above the section so terminals read as a distinct group, not more panels.
- **Accessibility:** `#strip` is `role="tablist"` and the panel icons are `role="tab"` (`shell.html:189`, `shell.js:58`). Terminal entries are not tabs and must not claim to be. Give `#strip-terminals` `role="group"` with an `aria-label` (e.g. "Fleet terminals") and leave its buttons with their default button role, so a screen reader does not announce nine terminals as panel tabs. Put the light's state in the accessible name too — the dot is decorative markup and conveys nothing on its own.

### 3. Bound the strip's scroll (`shell.html`)

- Give `#strip-terminals` its own `overflow-y: auto` with a `max-height` (`40vh` is a reasonable starting value — it leaves room for seven panel icons plus the toggle on a 700px-tall window). A bare `overflow-y: auto` on a column-flex child is not enough on its own: without a `max-height` or `min-height: 0` the child grows to fit its content instead of scrolling.
- Reuse the existing 6px scrollbar treatment already defined for the shell (`shell.html:158-184`), including the Firefox `@supports not selector(::-webkit-scrollbar)` gate — do not hoist those rules or add a second, competing scrollbar block. This is **enforced, not advisory**: `shell.html` is inside the `test:contract:panel-scrollbars` discovery set (see Verification Plan), and that contract asserts exactly one bare `::-webkit-scrollbar {` block per file and no `scrollbar-width` / `scrollbar-color` outside the `@supports` gate. The existing rules are unscoped selectors, so they already apply to the new scroller — no new CSS is needed for it at all.

### 4. Gate the section (`shell.js`)

- Render `#strip-terminals` only when a `terminals` panel is present and enabled in the manifest. The shell already skips disabled panels (`shell.js:160`), so the check is against the same manifest entry that produced (or omitted) the Terminals icon — matching the fail-closed rule at `headlessPanelHtml.ts:426`. In practice the cheapest correct test is `frames.has('terminals')` after the panel loop: `frames` is populated only from panels that survived the `enabled === false` skip, so it cannot disagree with what the strip actually rendered.
- When the section is gated off, the shell must not listen for or warn about `terminalFleetState` — it simply never arrives. It cannot: the Terminals iframe is what sends it, and a gated-off Terminals panel is never mounted (`shell.js:154-167`). No defensive branch is needed beyond not creating the container.
- Note the load-bearing property behind the whole design: the shell mounts every enabled panel as an iframe up-front and only toggles `display` (`shell.js:32-44`, `shell.js:161-166`). The Terminals iframe is therefore live — with its transport socket connected and its `agentCompleted` handler running — while the user is looking at the Board. If panels were ever lazily mounted, the relay would go silent and this plan would need its own socket after all.

### 5. Click behaviour (this plan's version)

- Clicking a strip entry calls the existing `selectPanel('terminals')` and posts `{ type: 'focusTerminal', name }` down to the Terminals iframe, with `location.origin` as target origin.
- Add a `focusTerminal` arm to the panel's `message` listener (`terminals.js:289-299`) that assigns that terminal to the focused pane — the same operation a sidebar click already performs — and clears its badge.
- **Clear the badge in the arm itself, before delegating to `assignToFocusedPane`.** That function clears badges on its own two paths (`terminals.js:718`, `terminals.js:735-737`) but early-returns at `terminals.js:701` when the terminal is *already in the focused pane* — the single most likely case for a click on a lit strip entry, since the user is being told that terminal just finished. Relying on `assignToFocusedPane` alone leaves the light burning after the click. Clear the badge, then call `assignToFocusedPane`, then `renderSidebarList()` / `renderPaneGrid()` / `postFleetStateToShell()` so the early-return path still repaints both surfaces.
- An unknown name is ignored — not an error, not a console warning. The strip can legitimately be one refresh behind the fleet.
- This handler is the seam the companion pop-out plan replaces. Keep it in one function so the swap is a one-line change, not a refactor.

## Proposed Changes

### `src/webview/terminals.js`
- **Context:** The Terminals panel's client script — already holds the fleet list, the badge map and the `agentCompleted` handler. It is the only surface that has all three, which is why the relay originates here.
- **Logic:** `postFleetStateToShell()` emitting `terminalFleetState` to `window.parent` at `location.origin`; called at the end of `fetchTerminalList`'s success branch, at the end of `handleAgentCompleted`, at both badge-clear sites in `assignToFocusedPane`, and from the new `focusTerminal` arm. `handleAgentCompleted` additionally triggers `fetchTerminalList()` when its resolved target is absent from `fleetList`. New `focusTerminal` arm on the window `message` listener that clears the badge, assigns the named terminal to the focused pane and repaints both surfaces.
- **Implementation:** The light is resolved here, once, so the strip and the panel cannot disagree. `focusTerminal` is the only arm that checks `event.origin`; the other three receive synthetic transport events with an empty origin and must not be touched.
- **Edge cases:** No-op when `window.parent === window` (solo/popout page). Light precedence `exited` > `done` > `active`. `focusTerminal` for an unknown name is ignored, not an error. A click on a terminal already in the focused pane still clears the light, despite `assignToFocusedPane` early-returning.

### `src/webview/shell.js`
- **Context:** The app-shell. Renders the strip from the `/panels` manifest and mounts every enabled panel as an always-live iframe; deliberately has no WebSocket of its own.
- **Logic:** `terminalFleetState` arm on the existing message listener; `renderTerminalSection()` building `.strip-icon`-styled entries with a state dot and a single combined flyout; `#strip-terminals` created eagerly in `renderManifest` between the panel icons and the theme toggle; section gated on `frames.has('terminals')`; click selects the Terminals panel and posts `focusTerminal` down at `location.origin`.
- **Implementation:** The bottom anchor moves from the toggle's inline `style.marginTop` to the container whenever the section exists, and stays on the toggle when it does not.
- **Edge cases:** Snapshot arriving before/after first render both converge (store-then-render). Unknown message shapes rejected alongside the existing `switchPanel` guard, plus an origin check on the new arm. Theme toggle stays bottom-anchored with no mid-strip gap. Nine terminals scroll inside the section without pushing the panel icons or the toggle out of reach.

### `src/webview/shell.html`
- **Context:** The shell's markup and its entire stylesheet; `#strip` is the document's only scroller.
- **Logic:** `#strip-terminals` container styles — bounded `max-height` with its own `overflow-y: auto`, separator, and the state-dot classes (filled / ring / hollow, plus colour).
- **Implementation:** No new scrollbar CSS — the existing unscoped `::-webkit-scrollbar` rules already cover the new scroller.
- **Edge cases:** Reuses the existing 6px scrollbar rules and their Firefox `@supports` gate rather than adding a second block — `test:contract:panel-scrollbars` fails on a second bare block. No literal `<body>` tag written in comments — `applyThemeClass` stamps the first match in the file (see the standing warning at `shell.html:37-42`).

## Verification Plan

### Automated Tests

- `npm run test:contract:panel-scrollbars` — **resolved: `shell.html` IS inside the discovery set.** The contract does not enumerate via `getPanelHtmlById`; it regexes `path.join(repoRoot, 'src', 'webview', '<file>.html')` straight out of `headlessPanelHtml.ts` (`browser-panel-scrollbar-contract.test.js:43-51`), and `getShellHtml` contains exactly that pattern for `shell.html`. So the 6px + Firefox-gate rules are enforced here, and the specific assertion this plan can break is "exactly one bare `::-webkit-scrollbar` rule" — a second block for `#strip-terminals` fails the suite. Reuse, do not duplicate.
- `npm run test:contract:shim-injection` — unchanged expectations; this plan deliberately does **not** inject the transport shim into the shell. Precisely: the contract requires the `SHARED_DEFAULTS_SCRIPT` marker only in webview HTML files that dereference a `sharedDefaults.js` binding (`webview-shim-injection-contract.test.js:142-156`). `shell.html` dereferences none today, so it is out of scope — and stays out of scope only if the new strip code introduces no such binding.
- New contract test: light precedence. Given a terminal that is both `exited` and badged `DONE`, the relayed `light` is `exited`.
- New contract test: the terminal section is absent from the rendered strip when the manifest reports `terminals` disabled.
- New contract test: bottom anchoring. With the section rendered, exactly one strip child carries `margin-top: auto` and it is `#strip-terminals`; with the section gated off, exactly one carries it and it is the theme toggle. This is the failure that a screenshot review would wave through and a user would notice immediately.
- New contract test: a `focusTerminal` for a terminal already occupying the focused pane clears its badge — the `assignToFocusedPane` early-return path (`terminals.js:701`).
- `npm run compile` and `npm run lint` clean.

### Manual UAT (darwin)

- Open the cockpit on the Board with two agents running. Dispatch a card, let the agent finish → the strip light turns `done` **while the Board is still the visible panel**, with no panel switch.
- Click the lit entry → Terminals panel opens with that terminal in the focused pane and the badge cleared. Return to the Board → light is no longer lit.
- Repeat the previous step for a terminal that was **already** in the focused pane when the light lit → the light still clears. This is the `assignToFocusedPane` early-return path and it is the most common case, since a completing agent is usually the one you were already watching.
- Let a terminal's process **exit on its own** (type `exit` at its prompt) → its light goes `exited` and the entry stays in the strip.
- **Close** a terminal with the panel's × button → the entry disappears from the strip entirely. That is correct, not a dropped signal: `kill()` removes the terminal from the fleet registry (`ptyFleetService.ts:144-154`), so it is genuinely gone, whereas a self-exited process stays listed with `status: 'exited'`.
- Let a terminal finish and then die → light reads `exited`, and the completion is still visible as a badge inside the panel.
- Dispatch a card that spawns a **new** terminal and let it complete quickly → the strip shows the new terminal *and* its `done` light without waiting for an unrelated refresh. This is the unknown-name reconcile path.
- Spawn nine terminals on a short window → the terminal section scrolls internally; all panel icons and the theme toggle remain clickable without scrolling the section out of view. Check that the section sits directly under the panel icons with no gap above the toggle — a mid-strip terminal list means the toggle's inline `margin-top: auto` was left in place.
- Run against a host with node-pty unavailable → no Terminals icon **and** no terminal section; no console warnings about missing relay messages.
- Toggle the theme with the section populated → dots and labels re-tint with the strip, and the toggle stays pinned to the bottom.
- Confirm no `confirm()` or two-click gate is introduced anywhere in the new UI.
- Tab through the strip with a screen reader running → terminal entries are announced as buttons in a "Fleet terminals" group, not as panel tabs, and each announces its light state in words.

## Recommendation

**Send to Coder.** Complexity 5 — three files, no server change, no new socket. The three corrections above (unknown-name reconcile, bottom anchor, early-return badge clear) are each small but each is a visible defect if skipped, so their contract tests carry the plan.
