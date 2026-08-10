# Add an "Open Terminal Grid" Button Beside "Open Agent Terminals"

## Metadata

**Complexity:** 2
**Tags:** feature, ui, frontend
**Project:** Browser Switchboard

## Goal

Add a second button — **Open Terminal Grid** — alongside the existing *Open Agent Terminals* control, in the two places that control already lives: the Switchboard status-bar Hub menu and the Terminals sub-tab of `implementation.html`. It opens the already-served PTY cockpit (`http://127.0.0.1:<apiPort>/terminals`) in the user's system browser.

Nothing else changes. No dispatch routing changes, no new rendering surface inside VS Code, no change to the panel or the shared HTML builder.

### What this deliberately does NOT do

**Dispatch behaviour is unchanged.** The existing rule stands: the user must open agent terminals before dispatching prompts, and a prompt sent before that **must keep failing exactly as it does today**. This plan adds a way to *reach* the PTY cockpit; it does not make the fleet a dispatch target from VS Code, does not add a routing preference, and does not touch `allowPtyFleet` / `apiOriginated`.

> **Scope change — user decision, 2026-08-10.**
> **Superseded:** A routing-target selector — two entry points that both open a surface *and* set where terminal prompts are dispatched, persisted per-workspace, with the browser fleet taking precedence when both are open.
> **Reason:** User direction. The premise behind the selector was that a prompt could land somewhere the user cannot see. In practice the user must open terminals before dispatching, and dispatch fails otherwise — so there is no silent-misdelivery window to close and no default-routing problem to solve. The selector would have added persisted state, a resolver over ~9 derivation sites on the shipped dispatch path, and a behaviour change across ~4,000 installs, all to fix something that cannot happen.
> **Replaced with:** A button. The fleet cockpit becomes reachable in one click from the two places the user already goes to open terminals.

### Background — what already exists

The cockpit is already built, already served, and already streaming. Verified live 2026-08-07; line references re-verified 2026-08-08:

- `TaskViewerProvider.ts:1952` spawns `dist/standalone/ptyHost.js`, which reports `{t:'ready', port, token}` on stdout (`:1995-1998`) and listens on its own port.
- `GET /terminals` returns 200 from the extension host's `LocalApiServer` today, via `getPanelHtmlById` → `headlessPanelHtml.getTerminalsHtml` (`:386-414`).
- `TaskViewerProvider.ts:2410-2426` injects `data-terminal-token` and `data-pty-host-origin` onto that page, so terminals stream as soon as it loads.

The only thing missing is a way to reach it without hand-typing a port that changes every launch.

### The one real technical decision — system browser, never Simple Browser

VS Code's Simple Browser is a webview wrapping a cross-origin iframe. Web research (2026-08-09) established that this shape breaks a terminal:

- `navigator.clipboard.writeText()` in a cross-origin iframe inside a webview throws `DOMException: Write permission denied`; `allow="clipboard-write"` does not help, because Electron does not delegate clipboard permission into nested cross-origin renderers (`microsoft/vscode#182642`).
- Electron menu accelerators capture `Cmd/Ctrl+C`, `+V`, `+A`, `+W` before they reach a nested cross-origin iframe; `Cmd+W` closes the editor tab (`microsoft/vscode#129178`, `#180234`).

A terminal that cannot take `Ctrl+C` or copy its own output is not a terminal. **Use `vscode.env.openExternal`. Never `simpleBrowser.show`.**

## User Review Required

None.

## Complexity Audit

### Routine
- One command (`switchboard.openTerminalGrid`) registered via `registerSwitchboardCommand`, plus a `contributes.commands` entry.
- One `QuickPickItem` appended to the Hub's existing `Terminal Controls` group (`extension.ts:2592-2610`).
- One standalone status-bar item at priority 97.5, wired into `updateStatusBarVisibility` under the existing `showTerminalControls` gate.
- One button in `implementation.html`, beside `#createAgentGrid` (`:1577`), with a message arm in `TaskViewerProvider`.
- Reading the API port from `LocalApiServer.getPort()` (`:489`).

**Status-bar context** (measured 2026-08-10). Ten items exist; `statusBar.compactMode` defaults to **true**, so by default all nine Right-side panel/terminal items are hidden and only the `$(circuit-board)` Hub is shown. Current Right-side layout, leftmost first: 101 `$(table) Kanban` · 100 `$(notebook) Artifacts` · 99.5 `$(tag) Tickets` · 99 `$(project) Project` · 98 `$(hubot) Agents` **and** 98 `$(symbol-color) Design` (a pre-existing priority collision) · 97 `$(clear-all) Clear` · 96 `$(stop-circle) Reset` · 95 Hub · 94 `$(comment-discussion) Memo`. Left/100 carries the conditional `$(rocket) Switchboard: Setup Required`.

### Complex / Risky
- **The Simple Browser trap.** `simpleBrowser.show` is the obvious "keep the user in the editor" improvement and it ships a terminal that cannot copy or interrupt. The reason must live in a comment at the call site, not only in this plan.
- **Do not join the existing button's state machine.** `#createAgentGrid` in `implementation.html` is stateful — `updateTerminalButtonState()` relabels it to `CLEAR TERMINALS` when terminals are alive (`:1757`, `:2290`, `:2324`, `:2301`). The new button is a plain, always-labelled action. Adding it to that function, or reusing its id prefix in the same query paths, makes it start relabelling itself.
- **Remote hosts.** Under Remote-SSH / Dev Containers / Codespaces the extension host's `127.0.0.1` is not the user's machine. Resolve through `vscode.env.asExternalUri` before opening. Separately, the served page embeds a hardcoded `ws://127.0.0.1:<ptyPort>` (`TaskViewerProvider.ts:2422`) which is **not** tunnel-resolved — so under a remote host the page will load and the terminals will not stream. Pre-existing defect of the browser cockpit, not introduced here; either fix it or hide the button on remote hosts. Decide explicitly rather than shipping a button that opens a cockpit of dead terminals.

## Edge-Case & Dependency Audit

**Race Conditions**
- The pty host reports its port asynchronously with a 5 s handshake timeout (`TaskViewerProvider.ts:1987-2016`). Clicking before the handshake must report "not ready", never open a URL built from an undefined port.

**Security**
- Loopback only. The URL is built from `LocalApiServer.getPort()` and `asExternalUri`; never from user input.
- No new auth surface. `LocalApiServer._checkAuth` short-circuits to loopback trust when `getAuthToken()` is empty (`:544-547`), always the case under the extension host, so the browser needs no token or cookie. If a token setter is ever added (`_sendUnauthorized`'s note anticipates it), this button needs a session grant.
- The terminal token already ships in the served page's markup, unchanged by this plan.

**Side Effects**
- Clicking twice yields two browser tabs on the same terminals. Two live clients on one terminal exercise the gateway's replay (`lastSeq`) and send-lock paths — already reachable today by opening the URL twice by hand, so one smoke test is proportionate.
- Nothing about `vscode.window.terminals`, dispatch resolution, `allowPtyFleet`, or the existing *Open Agent Terminals* action changes.

**Dependencies & Conflicts**
- Touches `src/extension.ts`, `src/webview/implementation.html`, `src/services/TaskViewerProvider.ts` (one message arm + one accessor) and `package.json`. **No change** to `terminals.js`, `terminals.html`, or `headlessPanelHtml.ts` — so this does not contend with the in-flight terminals work (sidebar groups/grids IA, terminal peek, role-grid fill, hidden-terminal create) and can run beside them.
- The Hub's `Terminal Controls` group is already gated by the `statusBar.showTerminalControls` setting (`extension.ts:2592`); the new item joins that group and inherits the gate.

## Dependencies

None.

**Does NOT unblock:** removal of the `allowPtyFleet` / `apiOriginated` surface flag. VS Code still cannot see the fleet in-process. `dispatch-surface-as-request-context-not-threaded-flag.md` remains the live route for that problem — it is **not** superseded by this plan.

## Adversarial Synthesis

**Risk Summary.** The change is a button and a URL; the risk is entirely in what a reasonable implementer substitutes for it. Routing to Simple Browser instead of the system browser yields a terminal that cannot copy or interrupt, and looks like better UX until someone tries to `Ctrl+C` a runaway agent. Wiring the new button into `updateTerminalButtonState()` makes it inherit the existing control's `CLEAR TERMINALS` relabelling. And under a remote host the cockpit opens with terminals that never stream, which reads as a working panel. Mitigations: comment the Simple Browser prohibition at the call site, keep the new button out of the existing state machine, gate on pty readiness, and decide the remote case explicitly.

## Proposed Changes

### `src/extension.ts`

- **Context:** Command registration and the Hub quick-pick.
- **Logic:**
  1. Register `switchboard.openTerminalGrid` via `registerSwitchboardCommand`. Handler: check pty readiness and `LocalApiServer.isListening()`; if either is false, report the reason and return. Otherwise build `http://127.0.0.1:${apiPort}/terminals`, pass through `await vscode.env.asExternalUri(...)`, hand to `vscode.env.openExternal(...)`.
  2. Comment at the call site: *Simple Browser is a webview wrapping a cross-origin iframe — clipboard and `Ctrl+C` do not survive it (`microsoft/vscode#182642`, `#129178`). Do not "improve" this to `simpleBrowser.show`.*
  3. Append to the Hub's `Terminal Controls` group, directly after `$(hubot) Agents` (`:2592-2610`): `{ label: '$(browser) Terminal Grid', description: 'Open the PTY terminal grid in your browser', command: 'switchboard.openTerminalGrid' }`.
  4. Add a standalone status-bar item at **priority 97.5, Right** — between `$(hubot) Agents` (98) and `$(clear-all) Clear` (97), so it sits adjacent to Agents: `$(browser) Grid`, tooltip *Open Terminal Grid (browser)*, command `switchboard.openTerminalGrid`. Register it in `context.subscriptions` alongside the other three.
  5. Wire it into `updateStatusBarVisibility` (`:2396+`) under the **existing `showTerminalControls` gate** — it is a terminal control and must appear and disappear with Agents/Clear/Reset. Add its `.hide()` to the compact branch and its `.show()`/`.hide()` pair to the non-compact branch.
- **Edge Cases:**
  - Never build a URL from an undefined port; report a reason rather than opening nothing silently (PRD contract #6 — no dead click).
  - **Both entry points are required, and the Hub one reaches everybody.** `statusBar.compactMode` defaults to **true** (`:2403`), which hides every individual item and shows only the `$(circuit-board)` Hub. So the standalone item is visible only to users who opted out of compact mode; the Hub entry is what the default install sees. Shipping only the standalone item would make the button invisible by default.
  - **`enabledCount += 3` is a hardcoded count** (`:2416`, compact branch) representing the three terminal controls; it drives whether the Hub icon shows at all. Adding a fourth terminal control makes it `+= 4`. Easy to miss, and getting it wrong skews the "should the hub appear" arithmetic.
  - Priority 97.5 is deliberate: `$(hubot) Agents` and `$(symbol-color) Design` both sit at 98 already, so adding a third item at 98 would make a three-way ordering ambiguity worse. Do not reuse 98.

### `src/webview/implementation.html`

- **Context:** The Terminals sub-tab (`:1566`), whose content div (`:1576`) currently holds the single `#createAgentGrid` button (`:1577`).
- **Logic:** Add a sibling button — `id="openTerminalGrid"`, label `OPEN TERMINAL GRID`, matching the existing `secondary-btn w-full` shape — posting `{ type: 'openTerminalGrid' }` on click.
- **Edge Cases:** **Do not** register it with `updateTerminalButtonState()` (`:1757`, `:2290`, `:2324`) — it has one label, always. Hide or disable it when the host reports no pty capability, consistent with contract #6.

### `src/services/TaskViewerProvider.ts`

- **Logic:** Add an `openTerminalGrid` arm to `_handleMessage` that executes the command through the commands seam (not `vscode.commands` directly — PRD contract #3). Add a narrow public accessor returning `{ apiPort?: number; ready: boolean }` rather than widening `_ptyHostPort` / `_localApiServer` separately, so the pair cannot be read half-updated across an await.
- **Edge Cases:** no change to dispatch, resolution, or `allowPtyFleet`. `_terminalSessionToken` stays private.

### `package.json`

- **Logic:** Add `switchboard.openTerminalGrid` to `contributes.commands`, titled `Switchboard: Open Terminal Grid`. No `contributes.views` entry — nothing renders inside VS Code.

## Verification Plan

Compilation and automated test execution are out of scope for this planning session; the checks below are specified for the implementing change.

### Automated
1. With the pty host not ready or the API server not listening, the command opens nothing and reports a reason.
2. The opened URI is built from the live `LocalApiServer.getPort()` and passed through `asExternalUri`; assert it is never constructed from an undefined port.
3. The implementation calls `vscode.env.openExternal` and does **not** reference `simpleBrowser.show` — assert by source scan, since this is the specific regression the plan exists to prevent.
4. `implementation.html` contains both `#createAgentGrid` and `#openTerminalGrid`, and `updateTerminalButtonState` references only the former.

### Manual (VS Code extension host)
1. **Hub menu (default config).** With `statusBar.compactMode` at its default `true`, open the Switchboard hub (`$(circuit-board)`); *Terminal Grid* appears under *Terminal Controls*, below *Agents*. Clicking it opens the cockpit in the system browser with live terminals.
2. **Standalone item (compactMode off).** Set `statusBar.compactMode` to `false`; `$(browser) Grid` appears immediately right of `$(hubot) Agents`. Set `statusBar.showTerminalControls` to `false`; it disappears along with Agents/Clear/Reset. Set compactMode back to `true`; it hides and the Hub returns.
3. **Panel button.** In the sidebar's Terminals sub-tab, the new button sits beside *OPEN AGENT TERMINALS* and does the same thing.
4. **No relabelling.** Open agent terminals so the existing button flips to *CLEAR TERMINALS*; confirm the new button's label is unchanged.
5. **It is a real terminal.** In the opened tab: type, copy output, and `Ctrl+C` a running command.
6. **Dispatch unchanged.** With no agent terminals open, dispatch a prompt from the board and confirm it fails exactly as it does today — opening the grid must not have made the fleet a target.
7. **No pty.** With `node-pty` unavailable, the Hub entry, the status-bar item and the panel button are all absent or disabled with a reason — no dead click.
8. **Remote.** Under Remote-SSH or a Dev Container, confirm the decision taken on the un-tunnelled `data-pty-host-origin` (fixed, or button hidden) behaves as decided.
9. **Everything else unchanged.** `vscode.window.terminals`, the existing open/clear/reset controls, and the standalone browser cockpit all behave as before.

## Design History — four rejected in-VS-Code rendering designs

Recorded so they are not re-attempted. Each failed for a different reason and each looked correct on paper.

1. **Native webview hosting via `asWebviewUri`** *(rejected 2026-08-08 — dead panel).* `terminals.js` never calls `acquireVsCodeApi` (zero references) and reaches its server through **21 root-relative `fetch()` calls** against `location.origin`, documented at `:5257`. Inside a webview `location.origin` is `vscode-webview://<id>`, so all 21 fail — including `ptyListTerminals` (`:810`), which populates the sidebar, pane grid and seating. The panel renders as chrome with no terminals while every proposed automated check passes.
2. **Cross-origin iframe inside a thin webview** *(rejected 2026-08-09 — clipboard and keyboard).* Fixes the origin problem, but clipboard permission cannot be delegated into a nested cross-origin renderer and Electron eats `Cmd/Ctrl+C/V/A/W`. Also breaks under Codespaces, where third-party auth cookies are blocked in framed contexts. Same finding that rules out Simple Browser. The in-repo precedent that motivated it (`DesignPanelProvider.ts:4341`, `PlanningPanelProvider.ts:1982`) holds only for static preview HTML — no keyboard, no clipboard, no WebSocket.
3. **Native hosting + injected `data-api-base`** *(designed, dropped on scope 2026-08-09).* Technically sound — xterm owns the top-level webview DOM so keyboard and clipboard work, and an injected API base fixes the 21 fetches. Cost: a mode parameter on the shared HTML builder, an additive edit to the contended `terminals.js` (including `buildLinkPrompt` at `:5273`, which bakes `location.origin` into a curl command handed to an agent), a clipboard bridge, two `asExternalUri` resolutions, and an unresolved VS Code Web WS-origin question (`wsUpgradeAuth.ts:32-43` allows `vscode-webview:` but not `https://<id>.vscode-cdn.net`). Scored 7. Dropped because an in-editor rendering surface is not wanted — PTY terminals get too little space inside the editor to be worth it.
4. **Dispatch-target selector** *(rejected 2026-08-10 — solves a problem that cannot occur).* Two entry points that also set where prompts route, persisted per-workspace, fleet winning ties. Would have replaced the ~9 `allowPtyFleet = !!options?.apiOriginated` derivations (`TaskViewerProvider.ts:4752, 5432, 10116, 19370, 21642`; `apiOriginated` at `:4532, 19606, 24448`; `PlanningPanelProvider.ts:1274`) with one resolver, and rewritten the `browser-stray-dispatch-surface.test.js` contract test. Unnecessary: dispatch already requires terminals to be open and fails otherwise, so no prompt can land unseen.

A fifth option — proxying each fleet PTY into `vscode.window.createTerminal({ pty })` via the Pseudoterminal API — was raised and not chosen. It is the only design that would genuinely merge the two terminal sets and unblock the `allowPtyFleet` removal, at the cost of the entire cockpit UI (pane grid, seating groups, saved layouts, role sidebar, badges). `Pseudoterminal` is used nowhere in this repo today (all six `createTerminal` sites pass shell options). Recorded as the strongest candidate if the surface-flag problem is ever attacked from this direction.

## Uncertain Assumptions

One external detail, cheaper to test than to research: whether `vscode.env.openExternal` already performs loopback tunnel resolution on remote hosts, making the explicit `asExternalUri` call redundant. Calling both is harmless — locally `asExternalUri` is an identity no-op — so implement both and drop one only if testing shows a double-resolve.

No web research is required. The platform questions that mattered were answered by the 2026-08-09 research recorded in Design History; the rest is repo-local.

## Recommendation

Complexity 2 → **Send to Intern.** One command, one Hub entry, one panel button, one message arm, one accessor. Two things must survive review: the browser choice (`vscode.env.openExternal`, never `simpleBrowser.show`) and keeping the new button out of `updateTerminalButtonState()`. Comment both at their call sites so the next reader inherits the reasons and not just the rules.
