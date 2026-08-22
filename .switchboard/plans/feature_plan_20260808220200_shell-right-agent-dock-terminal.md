# Right-Hand Agent Dock in the Browser Shell — a Persistent Agent Terminal Where IDE Users Expect Agent Chat

## Goal

Give `src/webview/shell.html` a **right-hand Mission Control dock** that hosts the orchestrator's terminal, mirroring the right-sidebar agent-chat placement users know from Antigravity, Devin Desktop, Cursor and Copilot Chat. The dock:

- lives beside `#content` (never on top of it — no overlay, no floating window),
- is toggled from the left rail's bottom cluster and remembers its open/closed state and width,
- hosts a real PTY seat rendered by the existing `/terminals?solo=<name>` page,
- **is bound to the orchestrator seat** — it shows whatever terminal `autobanState.orchestratorSeat.terminalName` names, and nothing else,
- **never creates or starts that seat.** With no orchestrator seated, the dock shows an empty state pointing at the existing start control.

### The dock's own UI — supersedes the markup in Proposed Changes

The markup in section 1a below is the **original role-configurable** dock and contradicts this rewrite in three places. Where they disagree, this section wins:

| Element in 1a | Fate |
|---|---|
| `#dock-role-btn` ("Choose which agent this dock starts") | **removed** — no role to choose |
| `#dock-role-menu` | **removed** with it |
| `#dock-start` (empty-state start button) | **kept** — it starts Mission Control; see below |
| `#dock-title` | keeps the **seat name**, or "Mission Control" when unseated |
| `#dock-close`, `#dock-splitter`, `#dock-frame` | unchanged — close, resize, and the `?solo=` iframe |

**Header:** the seat's terminal name, a liveness indicator, a close button. Nothing else. The liveness indicator is not decoration — `orchestratorSeat` is adopted and can name a terminal that has exited, and the edge case below requires the dock to follow adopt/re-adopt/clear. A dead pane with a live-looking header reads as a broken terminal rather than an absent persona.

**A link to the Mission Control panel** belongs here too: the dock is the persona's terminal, the panel is what it is working on. Pairing them is the whole point of the name.

**Empty state: a pointer to the existing rail button, plus an intro link.**

**Correction:** `shell.js:271` already provides `#strip-orchestrator` — a rail button that starts and stops the persona, lights with live state, guards double-start (two fast clicks would otherwise spawn `orchestrator-2`), and falls back to clipboard launcher text when no agent is configured. So the dock needs no start control of its own, and adding one would reintroduce the double-start race that button already handles. The empty state names that button and explains what it does.

The reasoning below stands on why an *explicit* start is safe — it just turns out the explicit start already exists.

An earlier revision of this section made the empty state a pointer to the Mission Control panel and argued the dock should never start anything. **Withdrawn.** Two use cases beat it, and the safety argument behind it was mis-aimed:

- **Session restart with in-flight work.** Work continues across sessions; the controller does not. Making every restart a trip to another panel is friction on the most common path, and the dock is exactly where its absence is noticed.
- **First run.** A new user looking at the board has no idea where to begin, and the controller is a good front door — its empty state can carry the intro-docs link.

**Why a button here is safe, where auto-start was not.** The persona gates itself: `switchboard-orchestrator/SKILL.md:148` is *"Resume, or interview?"* and `:206` is *"Propose a goal, then stop"* — *"propose one short statement of what you intend to accomplish… Then **stop and wait.** Nothing runs until the user answers."* So starting it commits to nothing; it starts and asks. The danger was launching as a **side effect of opening a dock** — no human intent anywhere. An explicit click is intent, and the pre-flight is a second gate. My "you cannot see what it would pick up" objection does not hold against a persona that tells you what it intends and waits.

And two controls are fine when they do the *identical* thing. The drift pattern this programme keeps hitting is two instructions saying **different** things about one action (the seat and head queue orders); a dock button and a panel button invoking one start path are not that. Keep both: the dock for reach, the panel for when you are already there. One implementation, two entry points.

**Activation, and what is still unspecified.** The dock is toggled from the rail's bottom cluster and persists its open/closed state and width, and it **starts closed** — creation is explicit-click-only, never on shell load. Two gaps:

- **The first-run default is not specified.** "Remembers its state" says nothing about having no state to remember. Open-on-first-run serves the intro case; closed-by-default avoids taking ~648px from the board for users who would never want it. **Recommending closed, with the rail toggle visibly present** — the intro then lives where every user can reach it, for the reason below.
- **The dock is capability-gated, so it cannot be the only first-run surface.** Below `DOCK_VIABLE_MIN = 980` the toggle renders `disabled` (`48 + 4 + 648 + 280 = 980` is the narrowest viewport fitting both dock and board, and the clamp deliberately makes the dock the loser rather than squeezing the board to 200px), and it renders nothing at all when `node-pty` is absent (`frames.has('terminals')`). So a new user in a narrow or split window, or on an install without `node-pty`, never sees it. **The intro must therefore also exist in the Mission Control panel**, which has no width or pty gate. The dock's empty state is a convenience copy of it, not its home.

**And the terminal itself needs a second home for the same reason.** Below 980px the controller is otherwise reachable only via the full-screen terminals panel or a solo pop-out — the mode switch this dock exists to remove. `mission-control-panel-ui-specification.md` therefore carries a **persistent controller strip** hosting the same `?solo=<seat>` frame: inside the panel there is no board to coexist with, so the 648px terminal floor is met easily at laptop widths. Deliberately panel chrome rather than a peer tab — a terminal in a hidden tab never receives the `panelVisibility` message that releases its shared-pty size vote and its WebGL context, because tab switches do not pass through `selectPanel`. That plan carries the full reasoning. That makes this dock an honest convenience for wide monitors rather than a capability-gated front door.

**Two rail affordances for Mission Control, deliberately.** The UI spec adds a fighter-jet panel icon; this plan adds a bottom-cluster dock toggle. That is defensible — the panel is missions and schedules, the dock is the persona's terminal — but it should be a decision rather than an accident, and the two must not look like duplicates of each other in the rail.

**The intro link is the resident docs URL, not `AGENTS.md`.** `AGENTS.md` is being emptied to a handful of rules by `shrink-the-injected-agent-protocol-block.md`, so it is no longer an intro. The surviving pointer is the docs line — `https://switchboard.dev/docs` — and it should come from the single constant `consolidate-the-docs-url-in-the-extension.md` establishes, not a second literal here.

### Scope change from the original plan: Mission Control, not a general agent dock

This plan was written as a *role-configurable* dock — auto-create a seat on first open using a persisted role, with a picker in the dock header. It is rewritten as a single-purpose surface bound to the orchestrator. What that removes and why:

- **No role picker, no persisted role, no new Setup verb pair.** The whole of former section 4 (`getAgentDockRole` / `setAgentDockRole`, a `package.json` configuration property, and a `npm run catalog:generate` pass) goes. That was the largest piece of backend work in the plan and it exists only to answer "which role does this dock start", a question a bound dock does not ask.
- **No auto-create on first open** — a safety property rather than a simplification. An explicit Start button is a different thing and is kept (see the UI section). Auto-creating an orchestrator seat means *opening a dock launches the orchestrator persona* — and `switchboard-manage-console-skill.md` records exactly that failure from the other direction: invoking the persona as a human *"grouped loose plans into a feature and fired dispatch with no confirmation"*. A UI affordance whose side effect is starting unattended automation is the same defect with a smaller trigger. Opening the dock displays; a deliberate click starts. The AUTOMATION tab's Start orchestrator goes with that tab, so the dock and the Mission Control panel become the two entry points to one start path.
- **The PM-delivery synergy argument no longer applies.** The original plan's strongest case for defaulting the dock to `project_manager` was that `_tryFleetDeliveryForRole('project_manager', …)` would then deliver the sibling plan's `MANAGE` button into it for free. That argument dies with the role config, and the sibling subtask must not silently depend on this dock hosting a PM seat.

**Naming.** "Mission Control" is the right label only if missions land (`staging-streams-parallel-dispatch-and-worktrees.md`) — and it becomes the fourth name in this area after *orchestrator*, *orchestration* and the proposed *operator*. `rename-the-orchestrator-to-the-operator.md` counts 1,067 occurrences across 55 files; if the persona is renamed at all, that plan should absorb this label rather than two renames landing separately. **Pick the word once, there.**

### Problem

The browser cockpit's only terminal surface today is the full-screen `terminals` panel plus per-terminal pop-out windows. Both are *modes*: the operator either looks at the board **or** at a terminal. `shell.js` is explicit about the pop-out being the primary path from the rail:

```js
            btn.addEventListener('click', () => {
                const slug = t.name.replace(/[^A-Za-z0-9_-]/g, '_');
                const popoutName = `sb-term-${slug}`;
                const popoutUrl = `/terminals?solo=${encodeURIComponent(t.name)}`;
                const features = 'width=900,height=700';
```
— `src/webview/shell.js:371-376`

and the fallback if the pop-up is blocked is to *replace* the current panel:

```js
                const fallbackToInCockpit = () => {
                    selectPanel('terminals');
```
— `src/webview/shell.js:382-383`

So there is no way to keep an agent visible **next to** the board, project panel, or artifacts panel. Every user coming from an agentic IDE reaches for the right edge of the window and finds nothing there: `shell.html`'s body is a two-child flex row and stops at `#content`.

```html
<body>
    <div id="strip" role="tablist" aria-label="Switchboard panels"></div>
    <div id="content"></div>
    <div id="tooltip-overlay"></div>
```
— `src/webview/shell.html:273-276`

### Root cause

This is not a regression — the shell was **designed** as `rail + single content area`, and every affordance added since (fleet strip, pop-outs, solo mode) extended that design rather than challenging it. The three specific consequences:

1. **No right-edge slot exists.** `body { display:flex; flex-direction:row }` with `#strip` at `flex: 0 0 48px` and `#content` at `flex: 1 1 auto` (`shell.html:49-55`, `:56-68`, `:138-143`). Nothing follows `#content`, and nothing in `shell.js` ever appends to `body` except the tooltip overlay.

2. **Terminals are adopt-only, never created, from the shell.** `renderTerminalSection` renders buttons for terminals the *panel* reported via the `terminalFleetState` relay (`shell.js:274-430`, `:506-509`). The shell has no code path that calls `ptyCreateTerminal`; creation lives entirely inside `terminals.js` (`createTerminal`, `:3654`). A dock whose empty state is "go to the Terminals panel and make one first" is not the affordance the user asked for.

3. **The shell has no config channel except theme.** The only server call `shell.js` makes besides `/panels` is the theme write (`shell.js:190-194`), and `getShellHtml(repoRoot, themeClass?)` stamps nothing else onto the shell body — no workspace root, no host capabilities (`src/services/headlessPanelHtml.ts:151-166`). So "the user can configure which agent starts here" currently has nowhere to live.

### What already works in our favour

- **Solo mode is a complete single-terminal page.** `?solo=<name>` pins one pane, force-sets `currentLayout='1'`, hides the sidebar and toolbar, and shows a `#solo-status` element for the not-yet-connected / not-found states (`terminals.js:71-78`, `:422-430`, `:636-641`; `terminals.html`'s `#solo-status`). The dock reuses it verbatim — no new terminal renderer.
- **The pty gateway is genuinely multi-client.** `reconcileTerminalSize` takes the MIN of every *rendering* client's viewport and ignores `rendered:false` frames (`src/standalone/terminalWsGateway.ts:983-1012`), so a dock and the Terminals panel can both attach to the same seat without one destroying the other.
- **The orchestrator seat is already durable, named state.** `autobanState.orchestratorSeat` carries a `terminalName` (`TaskViewerProvider.ts:1722`, `:6373`, `:11307`), and `:6362` already treats `orchestratorSeat || orchestratorArmed` as the "orchestrator present" signal. So the dock has a name to solo on and a presence check to gate its empty state — both existing, neither new.
- **The manifest already gates on pty availability**, fail-closed: `terminals: ptyReady` in standalone (`bootstrap.ts:617`) and `terminals: ptyHostReady()` in the extension's browser cockpit (`TaskViewerProvider.ts:2402`), with `terminalsEnabled = availability?.terminals === true` (`headlessPanelHtml.ts:502`). The dock reads the same manifest entry the rail does, so it disappears on a node-pty-less install with no new probe.
- **The dock frame themes itself on load with no code.** `resolveInitialTheme()` inherits the theme class from the same-origin parent body when the host injected none (`terminals.js:337-354`). The dock iframe is inside the shell, so its first paint is already correct; only the **live** toggle needs the fan-out fix in edge case 10.
- **Binding to a seat rather than a role sidesteps the adoption question.** `orchestratorSeat` is *adopted* (`:11307`, `:11520`), not created by the dock, so the dock never competes with the adoption path: it renders whatever is currently adopted and follows a re-adoption. A role-based dock would have had to decide what happens when a second terminal of the same role appears.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, ui, ux, feature, backend
- **Project:** Browser Switchboard

## User Review Required

- **First-run default: closed or open?** Recommending closed, because the dock is width- and pty-gated and so cannot be relied on as the intro surface anyway.
- **Two rail affordances** — fighter-jet panel icon plus dock toggle. Confirm both, and that they read as distinct things.
- **Two start entry points, one implementation.** The dock's empty state and the Mission Control panel both start the persona, replacing the AUTOMATION tab's control. Confirm they share one code path — the risk is not two buttons, it is two behaviours.
- **Confirm the dock is orchestrator-only.** The parent feature's stated goal is that *"every agent surface in Switchboard is reachable from where the operator is standing"*, with this dock as the general front door. Binding it to one persona narrows that deliberately — a decision about the feature's intent, not just this subtask.
- **The label depends on the rename.** See Naming above: settle the persona's word in `rename-the-orchestrator-to-the-operator.md` rather than introducing a fourth name here.

## Complexity Audit

**Routine (Band A):**
- The dock's CSS: a third flex child, a splitter, a header bar. `shell.html` already owns its full token set (`--bg`, `--bg-elev`, `--border`, `--accent`, `--font`) and a working `theme-claudify` override, so no palette work.
- Persisting two scalars (`open`, `widthPx`) — `localStorage` is correct here (per-browser UI chrome, not shared state) and needs no server round-trip.
- Reusing `/terminals?solo=` as the dock's iframe `src`.
- The `SetupPanelProvider` verb pair: `getProtocolTarget` / `setProtocolTarget` (`SetupPanelProvider.ts:764-780`) is a line-for-line template for a string setting with a default, and the seam methods it uses (`getConfigStringWithDefault`, `updateConfigGlobal`) exist in **both** host bundles (`hostSeams.ts:125,181`; `standalone/hostServices.ts:124,151`).

**Complex / Risky (Band B):**
- **Anchor arithmetic in the rail.** `applyBottomAnchor()` hands `margin-top:auto` to exactly ONE member of the bottom cluster and neutralises `#strip-terminals` inline when something precedes it; two auto margins split the free space and park the cluster mid-rail (`shell.js:255-272`, and the warning at `shell.html:182-192`). The dock toggle is a new bottom-cluster member and MUST be inserted into that reconciliation, not appended blind.
- **Seat lifecycle.** Adopt-if-present-else-create, keyed by a stable dock seat name, with the fleet-relay as the only source of truth about whether the seat is still alive. Getting this wrong yields either duplicate seats on every reload or a dock permanently pointed at a dead terminal. The de-duplication behaviour is **not** what a first reading suggests — see edge case 4.
- **Cross-frame plumbing.** The dock iframe is a *second* `/terminals` page. It will post `terminalFleetState` to `window.parent` exactly like the main one, so `shell.js`'s relay handler must not let the dock's (identical) snapshot fight the panel's.
- ~~Persisting the role choice server-side~~ — removed with the role picker. No new verb, no `package.json` property, no catalog regeneration.
- **The empty state is the first-run surface, so it carries real weight.** It is what a new user sees before anything is configured: a Start button and one intro link. That argues for it being legible rather than minimal — but it must not grow into an onboarding panel, because the dock is narrow and the panel exists for depth.
- **Reacting to a seat change while the dock is open.** The dock must follow `orchestratorSeat` when it is adopted, re-adopted or cleared, not read it once on open. A dock pinned to a stale terminal name shows a dead pane that looks like a broken terminal rather than an absent orchestrator.
- **Column width is a product constraint, not a cosmetic one.** A PTY does not reflow like a chat pane. The dock's minimum and default widths decide whether the agent CLI inside it is usable at all — see edge case 13, which supersedes the plan's original numbers.

## Edge-Case & Dependency Audit

1. **Shared-seat resize squash.** If the dock and the Terminals panel are both seated on the same terminal, `reconcileTerminalSize` takes the MIN across rendering clients (`terminalWsGateway.ts:995-1012`). A narrow dock therefore narrows the pty for the full-width panel too. **Decision:** the dock owns a *dedicated* seat, so the common case is one client. This is a real consequence when the user deliberately seats the dock terminal in the panel as well — accepted, documented in the dock header tooltip, not defended against in code.

2. **`terminalFleetState` relay collision.** `terminals.js` posts fleet snapshots to `window.parent` (`terminals.js:684-687`) and `shell.js` renders them (`shell.js:506-509`). The relay already no-ops for pop-outs via `if (window.parent === window) { return; }` (`terminals.js:660`) — but the dock iframe **has** a parent, so that guard does not cover it. Both snapshots come from the same `ptyListTerminals`, so they are equal in content — but a dock reload can deliver a stale snapshot after the panel's fresh one, and the dock frame never calls `fetchAgentNames()` (solo mode skips it, `terminals.js:642-654`), so `agentLabelForRole` returns `''` for every role and the dock's snapshot would repaint the whole rail with **default brand icons**. **Fix:** the dock iframe gets `&dock=1`; `terminals.js` returns early from `postFleetStateToShell` when that param is present. One guard inside the function covers all seven call sites (`:602`, `:616`, `:833`, `:1783`, `:1869`, `:5073`, and the poll path). Do NOT filter on the shell side by `event.source` alone — the frame map is keyed by panel id and the dock frame is not in it.

3. **`node-pty` absent.** `terminalsEnabled` is fail-closed (`headlessPanelHtml.ts:502`) and `/terminals` 404s when the manifest entry is disabled (`LocalApiServer._handleServePanelById`, `:807-814`). The dock must read `frames.has('terminals')` — the same test `renderTerminalSection` already makes (`shell.js:282`) — and render neither toggle nor dock. A dock iframe pointed at a 404 would paint an error page in the operator's sidebar.

4. **Auto-create races the pop-out, and the de-dup fallback discards the requested name.**

   > **Superseded:** "`PtyFleetService.create()` de-duplicates names by suffixing a counter (`ptyFleetService.ts:141-146`), so the second tab silently gets `dock-coder-2`."
   > **Reason:** Factually wrong, and the error is load-bearing. The loop is
   > ```ts
   > let name = friendlyName || `${role}-1`;
   > let counter = 1;
   > while (this.terminals.has(name)) { counter++; name = `${role}-${counter}`; }
   > ```
   > — `ptyFleetService.ts:141-146`. On collision the requested `friendlyName` is **discarded entirely** and the name falls back to the *role* series. A second `dock-coder` request yields `coder-2`, not `dock-coder-2`. Worse: `handle.onExit` sets `status = 'exited'` but does **not** delete the entry from `this.terminals` (`:196-204`; only `kill()` deletes, `:282-290`), so the very first restart after the dock agent exits normally already collides — the dock's second seat is named `project_manager-2`. The `dock-` prefix therefore cannot be relied on as an identifier, and the original verification step "fleet strip shows exactly one `dock-*` entry" would fail on the second run.
   > **Replaced with:** Two changes. (a) Creation stays explicit-click-only — clicking the dock's "Start Mission Control" button in the empty state, never implicitly on shell load — so two shell tabs cannot both auto-create. (b) The dock **never keys on the seat name pattern**. It persists the `friendlyName` the server actually returned (`data.terminal.friendlyName`) and treats that string as opaque. The requested name stays `dock-<role>` because it is a good default label for the operator, not because anything reads it back. Before creating, the dock also offers to adopt: if a live seat with the persisted name exists, mount it; otherwise show the start button.

5. **Role has no CLI configured.** `injectStartupCommand` returns silently when `commands[role]` is empty (`ptyFleetService.ts:227-229`) — the seat is a plain shell. `ptyVisibleRoles` already returns `hasCommand` per role (`terminals.js:3584-3586`); the picker must label a CLI-less role the way `onNewTerminalClicked` does (`terminals.js:3630-3632`) rather than pretending an agent will appear.

6. **Splitter vs iframes.** Dragging a splitter over an iframe loses `mousemove` to the frame's document. Standard fix, required here: `pointer-events:none` on `.panel-frame` and the dock frame for the duration of the drag, plus `setPointerCapture` on the splitter.

7. **Width clamp, and what happens when the two floors conflict.** The dock must not be draggable past the point where `#content` collapses. Clamp and re-clamp on `resize` — otherwise a narrowed window strands the board at 0px with no way back. `#content` itself is safe from min-content pressure: every `.panel-frame` is `position:absolute` (`shell.html:144-152`), so absolutely-positioned children contribute nothing to `#content`'s min-content size and it can shrink freely.

   *Clarification (implied by the corrected widths in edge case 13, not new scope).* With `DOCK_MIN = 648` the dock floor and the content floor can no longer both be satisfied on a narrow window: `48 + 4 + 648 + 280 = 980px` is the smallest viewport that fits both. The existing clamp expression resolves the conflict in the dock's favour (`Math.max(DOCK_MIN, …)` is the outer call), which would squeeze the board to 200px on a 900px window. That is the wrong loser. **Decision:** below `DOCK_VIABLE_MIN = 980`, the dock is not offered at all — the rail toggle renders `disabled` with the tooltip *"Window too narrow for the agent dock (needs 980px)"*, and an open dock auto-closes on the `resize` handler that crosses the threshold. Honest capability gating (PRD contract #6) beats either an illegible terminal or an unusable board. Do **not** solve this by lowering `DOCK_MIN` — that is the whole point of edge case 13.

8. **CSP.** `getShellHtml`'s CSP already allows `frame-src 'self'`, `script-src 'nonce-…' 'self'` and the ws origins (`headlessPanelHtml.ts:162`); the dock iframe is same-origin and the added `sharedDefaults.js` tag (see change 1b) is `'self'` with the nonce, so **no CSP change**. Do not add anything — the shell's CSP is `default-src 'none'` and every addition widens the cockpit.

9. **Auth.** The dock iframe inherits the `sb_session` cookie like every other panel frame — the one-time token exchange lands on `/` and the 8-hour cookie flows into each same-origin iframe unchanged (`LocalApiServer.ts:722-736`), so no token handling.

10. **Theme.** `applyThemeToAll` fans the theme change to `frames` and `popoutWindows` only (`shell.js:205-226`). The dock frame is in neither collection — it must be added, or a **live** theme toggle leaves the dock in the old palette until reload. First paint needs no work (see "What already works in our favour").

11. **Standalone shell renders theme-less.** `bootstrap.ts:606` calls `sharedGetShellHtml(repoRoot)` with **no** `themeClass`, while the extension passes `getTheme()` (`TaskViewerProvider.ts:2401`). Pre-existing, out of scope for this plan, but do not "fix" it as a side effect — it changes first-paint for every standalone user and belongs in its own change. (Consequence for the dock: in standalone the shell body carries no theme class until the first toggle, so `resolveInitialTheme` in the dock frame falls through to `cyber-theme-enabled` — the same default the shell itself paints. Consistent, so nothing to do here.)

12. **Two hosts, one shell.** `shell.html`/`shell.js` are served by both `bootstrap.ts` and `TaskViewerProvider`. Everything in this plan must work identically under both; the only host-specific input is the manifest's `terminals.enabled`. `ptyCreateTerminal` is contract-identical across them: standalone returns `{success, terminal:{friendlyName, role, status}}` (`bootstrap.ts:1184-1193`) and the extension proxies to `ptyHost.ts:69-84`, which builds the same object from the same `fleet.create` call.

13. **Column width is the product, not the chrome.** *(New — this is the finding that decides whether the feature achieves its goal.)* xterm is constructed with `fontSize: 13` and a mono family (`terminals.js:4351-4352`). Measured advance widths at that size are **7.80px** for Menlo (macOS) and DejaVu Sans Mono (Linux) and **7.20px** for Consolas (Windows); xterm's `CharSizeService` measures this for real via `CanvasRenderingContext2D.measureText`, and `FitAddon.proposeDimensions()` divides the available width by that measured `dimensions.css.cell.width` — so the column count is a direct, non-negotiable function of the dock's pixel width. Subtracting ~24px of chrome (pane-grid padding at `terminals.html:583-587`, borders, and xterm's scrollbar overlay), a **380px dock yields ≈46 columns and a 280px dock ≈33**. Agent CLIs — Claude Code, Codex CLI, Aider, Cursor/Gemini CLI — hard-wrap and draw box-framed tool output at an 80-column baseline; at 40–50 columns diffs fold two to three times per line and box-drawing borders collide with their own content. The IDE surfaces named in the Goal (Antigravity, Cursor, Copilot Chat) are *chat* panes rendering reflowable prose — a PTY carrying code and diffs is not, and that is the one structural difference between the model and the implementation.

    > **Superseded:** `width: 380px; min-width: 280px;` with `const DOCK_MIN = 280, DOCK_MAX = 720`.
    > **Reason:** Both the default and the minimum sit below the width at which the agent CLI inside the dock is legible. The plan would pass every one of its own acceptance steps — the terminal renders, the CLI boots, scrollback survives a panel switch — while the actual deliverable ("a persistent agent terminal") is unusable. A green checklist is not the goal.
    > **Replaced with:** `const DOCK_MIN = 648, DOCK_DEFAULT = 648, DOCK_MAX = 1100, DOCK_MIN_CONTENT = 280, DOCK_VIABLE_MIN = 980;` and `#agent-dock { width: 648px; min-width: 648px; }`.
    >
    > **Arithmetic.** 80 columns × 7.80px (the *worst-case* per-column advance, macOS/Linux) + 24px chrome = **648px**. Windows/Consolas gets ~86 columns at the same width. 648px is therefore the smallest width that guarantees the 80-column floor on every platform — one number, no per-OS branching.
    >
    > **Why default = minimum, and not the 100-column comfort width (804px).** This is a *board-first* cockpit with a dock beside it, not a dock-first layout. At 804px the board is left 424px on a 1280px laptop and 584px on a 1440px one — a kanban board that no longer works. At 648px it keeps 628px and 788px respectively. The default is the guarantee, not the ideal; `DOCK_MAX = 1100` (~137 columns) is there for anyone on a wide monitor who wants to drag it out. Deliberate, and not to be "tuned" back down.

    For reference, the IDE sidebars this dock is modelled on bottom out far lower — VS Code's secondary side bar at 220px, Cursor's agent panel at 300px, JetBrains tool windows at 200px. They can, because they host reflowable chat. This dock cannot, and that difference is the entire justification for a 648px floor sitting three times wider than its inspiration.

14. **`hidden` does not hide an element the author stylesheet gives a `display` to.** *(New.)* The UA rule `[hidden] { display: none }` is a **user-agent** declaration; any author declaration of `display` on the same element wins the cascade on origin, before specificity is even consulted. The original markup relies on `emptyEl.hidden = true` while the CSS declares `#dock-empty { display: flex; … }` — so the empty state would stay painted permanently, on top of the mounted terminal.

    > **Superseded:** hiding `#dock-empty` (and `#dock-role-menu`) via the `hidden` attribute while their CSS declares `display`.
    > **Reason:** Dead code path — the attribute has no effect once the author stylesheet sets `display` on the element. `#agent-dock` and `#dock-splitter` escaped this only because the plan happens to toggle a class (`.is-open`) that carries the hiding as well.
    > **Replaced with:** the codebase's own idiom, `.panel-frame` / `.panel-frame.is-active` (`shell.html:144-153`): a base rule with `display:none` and an `.is-visible` class that turns it on. Keep the `hidden` attribute alongside it for assistive tech, but never as the mechanism.
    > ```css
    > #dock-empty { display: none; flex: 1 1 auto; flex-direction: column; align-items: center;
    >                justify-content: center; gap: 8px; padding: 16px; text-align: center; }
    > #dock-empty.is-visible { display: flex; }
    > #dock-frame { display: none; flex: 1 1 auto; border: none; width: 100%; background: var(--bg); }
    > #dock-frame.is-visible { display: block; }
    > #dock-role-menu { display: none; position: fixed; z-index: 9999; }
    > #dock-role-menu.is-visible { display: block; }
    > ```

15. **The shell has no role-label table.** *(New.)* `BUILT_IN_AGENT_LABELS` (and `DEFAULT_VISIBLE_AGENTS`) live in `src/webview/sharedDefaults.js`, which is injected into **panel** HTML by `injectTransportShim` (`headlessPanelHtml.ts:73-88`). `getShellHtml` (`:151-166`) performs no such injection and `shell.html` loads exactly one script. So the header picker cannot render "Project Manager" — only the raw key `project_manager` — and the empty state's "Start Project Manager" is unimplementable as originally written. Hardcoding a second copy of the label table in `shell.js` is precisely the divergence the PRD's anti-divergence contract exists to prevent. **Fix:** add the `sharedDefaults.js` script tag to `shell.html` directly (change 1b). `getShellHtml` already does `content.replace(/\{\{NONCE\}\}/g, nonce)` **globally**, so a second `{{NONCE}}` placeholder is substituted with no change to `getShellHtml`'s signature, body, or CSP. `transport.js` is deliberately NOT added — the shell is not a panel and needs no `acquireVsCodeApi` shim.

16. **The dock frame keeps polling after the dock is closed.** *(New.)* `init()` calls `startFleetPoll()` unconditionally (`terminals.js:656`), so the dock frame issues one `ptyListTerminals` every 5s for the lifetime of the cockpit — the shell tab stays visible, so the `visibilityState === 'hidden'` skip (`:3125`) never fires. **This is accepted, not fixed:** the poll is the dock's own liveness source for `checkSoloNotFound` (`:849-871`), and suppressing it would leave a closed-then-reopened dock unable to detect a dead seat. The kanban pane poll is *not* an added cost — `startKanbanPoll` only runs when a pane is in kanban mode (`terminals.js:2152-2156`) and solo mode forces terminal mode. Net addition: one 5s HTTP poll, matching what the Terminals panel already costs.

17. **The dock toggle must not reuse `nav-terminals.svg`.** *(New.)* The Terminals panel already has a rail icon using exactly that glyph — it is a manifest entry with no `placement`, so it sits in the top group (`headlessPanelHtml.ts:509`). Two pixel-identical icons in one 48px rail, one selecting a panel and one toggling a dock, is an unresolvable affordance. The icon set is `icons/nav-*.svg` (10 files, served at `/static/icons`), and none of them reads as "dock". Add one `icons/nav-dock.svg` in the same single-colour, codicon-shaped house style as its siblings so the CSS-mask/`currentColor` path in `buildMaskedGlyph` keeps working.

18. **Migration.** `switchboard.agentDock.role` is a brand-new setting that has never shipped, defaulting to `project_manager`. Nothing to migrate; absence reads as the default through `getConfigStringWithDefault`. The dock's `localStorage` key is likewise new. No `*.migrated.bak`, no import-before-delete.

## Dependencies

- No upstream planning sessions — this plan is self-contained.
- Existing `/terminals` panel + solo mode (`terminals.js`, `terminals.html`).
- `/terminals/verb/ptyCreateTerminal` and `/terminals/verb/ptyVisibleRoles` (standalone: `bootstrap.ts:1177-1234`, wired at `:1661-1666`; extension: `TaskViewerProvider.ts:2054-2126`'s pty-host proxy). Note `/terminals/verb/*` is dispatched with **no** allowlist gate (`LocalApiServer.ts:1688-1754`) — both verbs already exist and need no catalog work.
- `/panels` manifest (`headlessPanelHtml.ts:496-515`).
- `SetupPanelProvider.handleServiceVerb` for the new persisted setting, plus `npm run catalog:generate` to regenerate `src/generated/verbAllowlist.ts` and `protocol-catalog.json`.
- `src/webview/sharedDefaults.js` — newly consumed by the shell (edge case 15).
- **Sibling, non-blocking:** `feature_plan_20260808220300_project-manager-entry-point-browser-standalone.md` adds a board `MANAGE` button that delivers the management prompt into a live `project_manager` terminal. The two plans compose — this one creates the seat that one targets — but neither blocks the other and they touch no common file.

## Adversarial Synthesis

**Risk summary.** The structural choice (a third flex child iframing `/terminals?solo=&dock=1`) is correct and the rail/relay/auth/CSP analysis holds; the failure modes are all in the details. Key risks: the dock's original width budget yields ~46 columns and would ship an agent terminal its own CLI cannot draw in; `hidden` is a no-op against the plan's own `display` rules, leaving the empty state permanently painted over the terminal; `PtyFleetService.create` discards the requested name on collision (and exited handles never leave the map), so any logic keyed on a `dock-` prefix breaks on the first restart; and `shell.js` has no access to the role-label table it needs. Mitigations: raise the min/default width to clear 80 columns, switch to the codebase's `.is-visible` class idiom, treat the returned `friendlyName` as opaque, and inject `sharedDefaults.js` into `shell.html` via the existing global `{{NONCE}}` substitution.

## Proposed Changes

### 1a. `src/webview/shell.html` — dock markup + CSS
> **Superseded in part.** The role picker (`#dock-role-btn`, `#dock-role-menu`) and the empty-state start button (`#dock-start`) below are from the original role-configurable design. Build the header and empty state per "The dock's own UI" above; the splitter, frame, close button and CSS carry over unchanged.

Add the dock as a **third flex child**, after `#content`:

```html
<body>
    <div id="strip" role="tablist" aria-label="Switchboard panels"></div>
    <div id="content"></div>
    <div id="dock-splitter" role="separator" aria-orientation="vertical"
         aria-label="Resize agent dock" hidden></div>
    <aside id="agent-dock" aria-label="Agent dock" hidden>
        <div id="dock-header">
            <button id="dock-role-btn" type="button" class="dock-chip"
                    data-tooltip="Choose which agent this dock starts"></button>
            <span id="dock-title"></span>
            <button id="dock-close" type="button" class="dock-icon-btn"
                    aria-label="Close agent dock">&times;</button>
        </div>
        <div id="dock-role-menu" hidden></div>
        <div id="dock-empty">
            <button id="dock-start" type="button" class="dock-start-btn"></button>
            <div id="dock-empty-hint"></div>
        </div>
        <iframe id="dock-frame" title="Agent terminal"
                allow="clipboard-read; clipboard-write" hidden></iframe>
    </aside>
    <div id="tooltip-overlay"></div>
```

CSS, using the file's existing tokens only. Visibility follows the file's own `.panel-frame` / `.panel-frame.is-active` idiom (`shell.html:144-153`) — never the `hidden` attribute alone, per edge case 14:

```css
        /* 648px = 80 columns × 7.80px (worst-case mono advance at fontSize 13,
           Menlo/DejaVu) + 24px chrome. Below this the agent CLI inside the dock
           folds its own diffs and box frames — see edge case 13. Do not lower. */
        #agent-dock {
            flex: 0 0 auto;
            width: 648px;
            min-width: 648px;
            background: var(--bg-elev);
            border-left: 1px solid var(--border);
            display: none;
            flex-direction: column;
            overflow: hidden;
        }
        #agent-dock.is-open { display: flex; }
        #dock-splitter {
            flex: 0 0 4px;
            cursor: col-resize;
            background: transparent;
            display: none;
        }
        #dock-splitter.is-open { display: block; }
        #dock-splitter:hover, #dock-splitter.is-dragging { background: var(--accent-dim); }
        #dock-header {
            flex: 0 0 32px;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 0 6px;
            border-bottom: 1px solid var(--border);
            font-size: 11px;
            color: var(--text-dim);
        }
        #dock-title {
            flex: 1 1 auto;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: var(--text);
        }
        .dock-chip {
            background: transparent;
            border: 1px solid var(--border);
            border-radius: 4px;
            color: var(--text-dim);
            font-family: var(--font);
            font-size: 11px;
            padding: 2px 6px;
            cursor: pointer;
        }
        .dock-chip:hover { color: var(--text); border-color: var(--accent-dim); }
        /* Visibility via a class, NOT the hidden attribute: [hidden]{display:none}
           is a USER-AGENT rule and loses the cascade to any author `display`
           declaration on the same element, regardless of specificity. The
           attribute stays on the markup for assistive tech; the class is the
           mechanism. Same pattern as .panel-frame / .panel-frame.is-active. */
        #dock-frame { display: none; flex: 1 1 auto; border: none; width: 100%; background: var(--bg); }
        #dock-frame.is-visible { display: block; }
        #dock-empty {
            display: none;
            flex: 1 1 auto;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 8px;
            padding: 16px;
            text-align: center;
        }
        #dock-empty.is-visible { display: flex; }
        #dock-empty-hint { font-size: 11px; color: var(--text-dim); line-height: 1.5; }
        /* position:fixed escapes #agent-dock's overflow:hidden — no ancestor here
           establishes a fixed-position containing block (no transform/filter/
           will-change/contain). Same idiom as #tooltip-overlay. */
        #dock-role-menu {
            display: none;
            position: fixed;
            z-index: 9999;
            background: var(--bg-elev);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 4px;
            min-width: 180px;
        }
        #dock-role-menu.is-visible { display: block; }
        /* Splitter drag: iframes swallow mousemove, so both the panel frames and
           the dock frame go pointer-inert for the duration of the drag. Without
           this the drag dies the instant the cursor crosses into a frame. */
        body.dock-dragging .panel-frame,
        body.dock-dragging #dock-frame { pointer-events: none; }
```

**Do not introduce any `margin-top: auto` in this CSS.** `shell-terminal-strip.test.js` asserts `(shellHtml.match(/margin-top:\s*auto/g)).length === 1` — the rail's single anchor is a hard contract.

### 1b. `src/webview/shell.html` — load `sharedDefaults.js`

Per edge case 15, one line above the existing shell script:

```html
    <script nonce="{{NONCE}}" src="/static/webview/sharedDefaults.js"></script>
    <script nonce="{{NONCE}}" src="/static/webview/shell.js"></script>
```

`getShellHtml` replaces `{{NONCE}}` **globally** (`headlessPanelHtml.ts:163`), so this needs no change to `getShellHtml` and no CSP change (`script-src 'nonce-…' 'self'` already covers it). `transport.js` is deliberately not added — the shell is not a panel.

### 2. `src/webview/shell.js` — dock module

**a. State + persistence (browser-local UI chrome).**

```js
    const DOCK_STATE_KEY = 'sb.agentDock';
    // 648 = 80 cols × 7.80px worst-case advance + 24px chrome. Default IS the
    // floor: this is a board-first cockpit, and 804px (100 cols) would leave a
    // 1280px laptop only 424px of board. See edge case 13.
    const DOCK_MIN = 648, DOCK_DEFAULT = 648, DOCK_MAX = 1100;
    const DOCK_MIN_CONTENT = 280;
    // Smallest viewport that fits rail + splitter + dock floor + board floor.
    // Below it the dock is disabled rather than shrunk — edge case 7.
    const DOCK_VIABLE_MIN = 48 + 4 + DOCK_MIN + DOCK_MIN_CONTENT; // 980

    let dockOpen = false;
    let dockRole = 'project_manager';   // replaced by the boot fetch in (g)
    let lastFleet = [];

    function readDockState() {
        try {
            const raw = localStorage.getItem(DOCK_STATE_KEY);
            const s = raw ? JSON.parse(raw) : {};
            return {
                open: s.open === true,
                width: clampDockWidth(Number(s.width) || DOCK_DEFAULT),
                seat: typeof s.seat === 'string' ? s.seat : null,
            };
        } catch { return { open: false, width: DOCK_DEFAULT, seat: null }; }
    }
    function writeDockState(patch) {
        const next = { ...readDockState(), ...patch };
        try { localStorage.setItem(DOCK_STATE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
        return next;
    }
    function clampDockWidth(px) {
        const max = Math.min(DOCK_MAX, window.innerWidth - 48 - 4 - DOCK_MIN_CONTENT);
        return Math.max(DOCK_MIN, Math.min(px, Math.max(DOCK_MIN, max)));
    }
```

The **role** is NOT stored here — it is a workspace-level setting (change 4), so it follows the workspace across browsers. `seat` holds the `friendlyName` the server returned and is treated as an **opaque string** (edge case 4).

**b. Rail toggle, wired through the existing anchor reconciliation.**

```js
    function buildDockToggle() {
        const btn = document.createElement('button');
        btn.className = 'strip-icon strip-placement-bottom dock-toggle-btn';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Agent Dock');
        btn.dataset.tooltip = 'Agent Dock';
        btn.setAttribute('aria-expanded', 'false');
        btn.appendChild(buildMaskedGlyph('/static/icons/nav-dock.svg'));
        btn.addEventListener('click', () => setDockOpen(!dockOpen));
        return btn;
    }
```

> **Superseded:** `btn.appendChild(buildMaskedGlyph('/static/icons/nav-terminals.svg'));`
> **Reason:** `nav-terminals.svg` is already the Terminals **panel** icon in the same rail (`headlessPanelHtml.ts:509`), which sits in the top group. Two identical glyphs with different actions is an unresolvable affordance.
> **Replaced with:** a new `icons/nav-dock.svg`, authored in the same single-colour codicon-shaped style as its nine siblings so the CSS-mask/`currentColor` path in `buildMaskedGlyph` keeps working.

It carries `strip-placement-bottom`, so `applyBottomAnchor()` already treats it as a cluster member — `strip.querySelectorAll('.strip-placement-bottom')` (`shell.js:259`) picks it up with **no change to that function**. Insert it in `renderManifest` *before* the Setup icon so the cluster reads `Dock | Setup | Toggle Theme`:

```js
        // Bottom cluster, in rail order: dock toggle → settings panels → theme
        // toggle. Only added when the host actually has a Terminals panel —
        // `enabled:false` panels are omitted from `frames` entirely (see the
        // comment at renderManifest), so this is the same test the fleet strip
        // makes, and it fails closed on a node-pty-less install.
        if (frames.has('terminals')) { strip.appendChild(buildDockToggle()); }
        for (const icon of bottomPanels) { strip.appendChild(icon); }
```

**Verified consequence, do not re-derive:** `renderTerminalSection` inserts `#strip-terminals` before `strip.querySelector('.strip-placement-bottom')` (`shell.js:312-316`), which is now the dock toggle. `applyBottomAnchor` then hands `margin-top:auto` to `members[0]` — also the dock toggle. Final rail: `[top group] [fleet list] ←free space→ [Dock][Setup][Theme]`, the same shape as today with one more member. The existing assertions at `shell-terminal-strip.test.js:412` (`for (const icon of bottomPanels)` precedes `buildThemeToggle()`) and `:427` (anchor on `members[0]`) both still hold.

**c. Open/close, resize, theme fan-out.**

```js
    function setDockOpen(open) {
        dockOpen = !!open;
        dockEl.classList.toggle('is-open', dockOpen);
        splitterEl.classList.toggle('is-open', dockOpen);
        dockEl.hidden = !dockOpen;
        splitterEl.hidden = !dockOpen;
        const toggle = strip.querySelector('.dock-toggle-btn');
        if (toggle) {
            toggle.classList.toggle('is-active', dockOpen);
            toggle.setAttribute('aria-expanded', String(dockOpen));
        }
        writeDockState({ open: dockOpen });
        if (dockOpen) {
            // Apply the persisted width BEFORE the frame gets a box, so the pty is
            // sized once. Without this the dock always reopens at the CSS default
            // and the saved width is write-only.
            dockEl.style.width = clampDockWidth(readDockState().width) + 'px';
            syncDockSeat();
        }
    }
```

> **Superseded:** a `setDockOpen` that persists `{open}` and calls `syncDockSeat()` but never applies `readDockState().width`.
> **Reason:** the width was written on drag-end and clamped on read, but never assigned back to the element — so "reopens at the saved width" (an explicit acceptance criterion) could not pass.
> **Replaced with:** the explicit `dockEl.style.width = …` above, applied before `syncDockSeat()` so the frame's first layout is already the final one.

Add the dock frame to the theme fan-out in `applyThemeToAll` — the frame is not in `frames`, so it is otherwise missed:

```js
        for (const [_, frame] of frames) { /* existing */ }
        try {
            dockFrame.contentWindow?.postMessage(
                { type: 'switchboardThemeChanged', theme: themeName }, '*');
        } catch { /* ignore */ }
```

Splitter drag with pointer capture:

```js
    splitterEl.addEventListener('pointerdown', (e) => {
        splitterEl.setPointerCapture(e.pointerId);
        splitterEl.classList.add('is-dragging');
        document.body.classList.add('dock-dragging');
        const startX = e.clientX, startW = dockEl.getBoundingClientRect().width;
        const onMove = (ev) => {
            dockEl.style.width = clampDockWidth(startW + (startX - ev.clientX)) + 'px';
        };
        const onUp = (ev) => {
            splitterEl.releasePointerCapture(ev.pointerId);
            splitterEl.classList.remove('is-dragging');
            document.body.classList.remove('dock-dragging');
            splitterEl.removeEventListener('pointermove', onMove);
            splitterEl.removeEventListener('pointerup', onUp);
            writeDockState({ width: dockEl.getBoundingClientRect().width });
        };
        splitterEl.addEventListener('pointermove', onMove);
        splitterEl.addEventListener('pointerup', onUp);
    });
    window.addEventListener('resize', () => {
        if (!dockOpen) { return; }
        dockEl.style.width = clampDockWidth(dockEl.getBoundingClientRect().width) + 'px';
    });
```

Note `applyThemeToAll` reassigns `document.body.className` wholesale (`shell.js:207-211`). `dock-dragging` is only ever set inside a single pointer gesture, so it cannot collide — but for the same reason, **never** encode dock state as a body class.

**d. Seat resolution — adopt, never implicitly create.**

`shell.js` already receives every fleet snapshot (`shell.js:506-509`). Cache it and use it as the liveness oracle:

```js
    // set in the terminalFleetState handler, alongside renderTerminalSection
    // lastFleet = data.terminals;

    function dockSeatName(role) { return `dock-${role}`; }

    function syncDockSeat() {
        const saved = readDockState();
        // `saved.seat` is the friendlyName the SERVER returned, treated as opaque —
        // PtyFleetService drops the requested name entirely on collision and falls
        // back to the `<role>-N` series (ptyFleetService.ts:141-146), so nothing may
        // key on the `dock-` prefix. dockSeatName() is only the request-time default.
        const wanted = saved.seat || dockSeatName(dockRole);
        const live = lastFleet.find(t => t.name === wanted && t.light !== 'exited');
        if (live) { mountDockFrame(wanted); return; }
        showDockEmptyState();   // "Start <Role>" button — the ONLY create path
    }

    function mountDockFrame(name) {
        const url = `/terminals?solo=${encodeURIComponent(name)}&dock=1`;
        if (dockFrame.getAttribute('src') !== url) { dockFrame.src = url; }
        dockFrame.hidden = false;
        dockFrame.classList.add('is-visible');
        emptyEl.hidden = true;
        emptyEl.classList.remove('is-visible');
        dockTitleEl.textContent = name;
        writeDockState({ seat: name });
    }

    function showDockEmptyState() {
        dockFrame.hidden = true;
        dockFrame.classList.remove('is-visible');
        emptyEl.hidden = false;
        emptyEl.classList.add('is-visible');
        // label + hint filled from the cached ptyVisibleRoles response (see f)
    }
```

`showDockEmptyState` paints the start button labelled from `BUILT_IN_AGENT_LABELS` (now reachable — change 1b) and, when `hasCommand[dockRole] !== true`, the same honest hint `onNewTerminalClicked` gives (`terminals.js:3630-3632`): *"no agent CLI configured — this opens a plain shell."*

**e. Create on explicit click only.**

```js
    async function startDockTerminal() {
        startBtn.disabled = true;
        try {
            const res = await fetch('/terminals/verb/ptyCreateTerminal', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: dockRole, name: dockSeatName(dockRole) })
            });
            const data = await res.json();
            if (data && data.success && data.terminal) {
                mountDockFrame(data.terminal.friendlyName);
            } else {
                dockEmptyHint.textContent = (data && data.error) || 'Could not start the terminal.';
            }
        } catch (err) {
            dockEmptyHint.textContent = 'Could not reach the terminal service.';
        } finally {
            startBtn.disabled = false;
        }
    }
```

`data.terminal.friendlyName` — **not** the requested name — is what gets mounted and persisted. On a collision the server returns something from the `<role>-N` series instead (edge case 4), and the dock must follow it. `/terminals/verb/*` carries no allowlist gate (`LocalApiServer.ts:1688-1754`), so this verb is reachable today in both hosts with no catalog work.

**f. Role picker in the dock header.**

`/terminals/verb/ptyVisibleRoles` returns `{visibleAgents, hasCommand}` (`terminals.js:3575-3591`; standalone arm at `bootstrap.ts:1179-1182`, extension arm at `TaskViewerProvider.ts:2055-2058` — note it is the one pty verb served even when the fleet is unavailable). Fetch it once when the dock first opens and cache it. The header chip toggles `#dock-role-menu.is-visible`, built from that response with the same `SYSTEM_ROLES` exclusion `onNewTerminalClicked` applies (`terminals.js:3605-3607`) and labels from `BUILT_IN_AGENT_LABELS`:

```js
    const SYSTEM_ROLES = new Set(['orchestrator', 'mcp_monitor']);
    const labelForRole = (role) => {
        const meta = BUILT_IN_AGENT_LABELS.find(r => r.key === role);
        return meta ? meta.label : role;
    };
```

Selecting a role persists it (change 4), updates `dockRole`, and re-runs `syncDockSeat()` — which lands on the empty state for the new role's seat, exactly as intended: changing the agent means starting that agent. The previously running seat is **not** killed; it stays in the fleet strip.

**g. Boot: fetch the persisted role before first paint of the dock.**

*(New — the original plan referenced `dockRole` without ever populating it.)*

```js
    async function loadDockRole() {
        try {
            const res = await fetch('/setup/verb/getAgentDockRole', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            });
            const data = await res.json();
            if (data && data.success && typeof data.role === 'string' && data.role) {
                dockRole = data.role;
            }
        } catch { /* keep the built-in default */ }
    }
```

Called from `renderManifest` only when `frames.has('terminals')`, then followed by `if (readDockState().open) { setDockOpen(true); }` so a dock left open across a reload comes back open, at its saved width, adopting its saved seat. This read is the shell's second-ever server call and follows the same read-the-HTTP-body pattern as the theme write (`shell.js:186-199`) — the shell is not a panel and receives no `postMessage` push.

### 3. `src/webview/terminals.js` — suppress the dock frame's fleet relay

Read the flag next to the existing `solo` parse (`terminals.js:71-78`):

```js
    let isDockFrame = false;
    try {
        const urlParams = new URLSearchParams(location.search);
        if (urlParams.has('solo')) { soloTerminalName = urlParams.get('solo'); }
        isDockFrame = urlParams.get('dock') === '1';
    } catch { /* ignore */ }
```

and guard inside `postFleetStateToShell`, immediately after the existing pop-out guard (`terminals.js:659-660`):

```js
    function postFleetStateToShell() {
        if (window.parent === window) { return; }
        // The right-hand dock is a SECOND /terminals page inside the same shell.
        // The guard above covers pop-outs (no parent) but NOT the dock, which has
        // one. Its snapshot comes from the same ptyListTerminals, so relaying it
        // only adds a racing writer for the rail's fleet strip — and a WORSE one:
        // solo mode skips fetchAgentNames (:642-654), so agentLabelForRole returns
        // '' for every role and the dock's snapshot would repaint the whole rail
        // with default brand icons. The panel is the single relay; the dock is mute.
        if (isDockFrame) { return; }
        // …unchanged…
    }
```

One guard inside the function covers all seven call sites (`:602`, `:616`, `:833`, `:1783`, `:1869`, `:5073`, and the fleet poll). Everything else in solo mode is unchanged — the dock is an ordinary solo page.

### 4. ~~Persist the dock role~~ — REMOVED

This section is deleted with the role picker. Its content (a `getAgentDockRole` / `setAgentDockRole` verb pair, a `package.json` configuration property, and a catalog regeneration) is retained below only so a reader can see what was dropped and why — **do not implement it.**

#### Dropped: persist the dock role — new Setup verb pair

**`src/services/SetupPanelProvider.ts`**, modelled on the `getProtocolTarget` / `setProtocolTarget` pair (`:764-780`) rather than the boolean `persistPanels` pair — same string-with-default shape:

```ts
                case 'getAgentDockRole': {
                    const pathConfig = this._seams().pathConfig;
                    const role = pathConfig.getConfigStringWithDefault('agentDock.role', 'project_manager');
                    this.postMessage({ type: 'agentDockRole', role });
                    return { success: true, role };
                }
                case 'setAgentDockRole': {
                    const pathConfig = this._seams().pathConfig;
                    const role = typeof message.role === 'string' && message.role.trim()
                        ? message.role.trim()
                        : 'project_manager';
                    await pathConfig.updateConfigGlobal('agentDock.role', role);
                    this.postMessage({ type: 'agentDockRole', role });
                    return { success: true, role };
                }
```

Both **return** the value in the body (PRD contract #4) — `shell.js` is not a panel and receives no `postMessage` push; it reads the HTTP body directly. Note these are the provider's first return-in-body arms; the file's own TODO at `:79-84` documents that the rest still `break`. They add no `break`, so `npm run verb-returns:check` is unaffected and no baseline edit is needed.

Both hosts persist for real: the extension seam writes the config file **and** `vscode.workspace.getConfiguration('switchboard').update(key, value, true)` (`hostSeams.ts:181-185`), and standalone writes `.switchboard/config.json` (`standalone/hostServices.ts:151-155`).

**`src/services/verbSchemas.ts`** — PRD contract #5 (validate at the HTTP boundary). Add to the setup block:

```ts
    setAgentDockRole: {
        fields: {
            role: { type: 'string', required: true },
        },
    },
```

> **Superseded:** the original plan listed no `verbSchemas.ts` change.
> **Reason:** `handleServiceVerb` runs `validateVerbPayload('setup', verb, payload)` at the network boundary (`SetupPanelProvider.ts:74-77`), and a verb with no schema passes through unvalidated (`verbSchemas.ts:54-55`). A write verb reaching the arm on garbage is exactly what contract #5 exists to stop. `getAgentDockRole` takes no fields and needs none.
> **Replaced with:** the `setAgentDockRole` schema above.

**`package.json`** — new configuration property next to `switchboard.persistPanels`:

```json
    "switchboard.agentDock.role": {
      "type": "string",
      "default": "project_manager",
      "description": "Agent role started by the browser cockpit's right-hand agent dock."
    }
```

This is load-bearing in the extension host: `updateConfigGlobal` calls `vscode.workspace.getConfiguration().update()`, which **rejects an unregistered key**. Dotted sub-keys are already the house style (`switchboard.protocol.target`, `switchboard.cli.command`, `switchboard.planWatcher.*`).

Default is `project_manager`: it is `true` in `DEFAULT_VISIBLE_AGENTS` (`sharedDefaults.js:15`), present in `BUILT_IN_AGENT_LABELS`, and is the role whose whole job is driving the board — the closest match to "the agent chat in my IDE's right sidebar", and the role `_tryFleetDeliveryForRole` targets for the management console.

**Regenerate the allowlist** — `src/generated/verbAllowlist.ts` is auto-generated from `protocol-catalog.json` (header: *"do not edit; run `npm run catalog:generate`"*):

```
npm run catalog:generate
```

> **Superseded:** "`SETUP_VERBS` gates the route (`LocalApiServer._handleSetupVerb`). Without this the two new verbs 4xx."
> **Reason:** Wrong location and wrong status code, which sends a debugger to the wrong file. `_handleSetupVerb` (`LocalApiServer.ts:1910-1956`) performs auth and a `SECRET_WRITE_VERBS` check only — it never consults `SETUP_VERBS`. The gate is in `SetupPanelProvider.handleServiceVerb`: `if (!SETUP_VERBS.has(verb)) { throw new Error(\`Unknown Setup verb: '${verb}'\`); }` (`:69-71`). A throw is caught by the route's aggregate handler and answered **500**, not 4xx.
> **Replaced with:** the generator step is still mandatory — without it, `getAgentDockRole` / `setAgentDockRole` throw inside `handleServiceVerb` and the shell sees an HTTP 500 with `{success:false, error:"Unknown Setup verb: …"}`. Commit `protocol-catalog.json` and `src/generated/verbAllowlist.ts` together; never hand-edit the generated file.

### 5. Files touched

| File | Change |
|---|---|
| `src/webview/shell.html` | Dock markup (aside + splitter + header + empty state + iframe); dock CSS on existing tokens using the `.is-visible` idiom; `body.dock-dragging` pointer-inert rule; `sharedDefaults.js` script tag |
| `src/webview/shell.js` | Dock module: state/persistence, boot role fetch, rail toggle (bottom cluster), open/close with width restore, splitter drag, seat adopt/create, role picker, theme fan-out to the dock frame, `lastFleet` cache |
| `src/webview/terminals.js` | `dock=1` parse; early return in `postFleetStateToShell` for the dock frame |
| `src/services/SetupPanelProvider.ts` | `getAgentDockRole` / `setAgentDockRole` arms (return-in-body) |
| `src/services/verbSchemas.ts` | `setAgentDockRole` schema in the setup block |
| `package.json` | `switchboard.agentDock.role` configuration property |
| `icons/nav-dock.svg` | New single-colour rail glyph, house style, served at `/static/icons` |
| `src/generated/verbAllowlist.ts`, `protocol-catalog.json` | Regenerated via `npm run catalog:generate` — never hand-edited |

### 6. Explicitly NOT in scope

- No change to `applyBottomAnchor()` itself. The toggle carries `strip-placement-bottom` and is picked up by the existing query; touching the anchor logic risks the mid-rail-cluster bug its own comment documents (`shell.js:238-254`).
- No change to `getShellHtml`'s signature, body, or CSP. The `sharedDefaults.js` tag goes in `shell.html`, where the existing global `{{NONCE}}` substitution already covers it.
- No dock in the VS Code webview sidebar — the editor already has a terminal panel and its own view container; this is a browser-cockpit affordance.
- No implicit terminal creation on shell load (edge case 4).
- Not fixing standalone's missing `themeClass` on the shell (edge case 11).
- No `transport.js` in the shell — it is not a panel and needs no `acquireVsCodeApi` shim.
- No change to `PtyFleetService.create`'s de-duplication. The dock adapts to it (edge case 4); changing it would rename seats for every existing caller.
- Not suppressing the dock frame's 5s fleet poll (edge case 16) — it is the dock's own liveness source.

## Resolved Assumptions

Two figures in this plan could not be read out of the repository and were confirmed by web research before hand-off. Both are now settled; the coder should **not** re-derive or re-tune them.

1. **Per-column advance width at `fontSize: 13` — settled at 7.80px worst case.** Menlo (macOS) and DejaVu Sans Mono (Linux) both run 0.600em → **7.80px**; Consolas (Windows) runs 0.5538em → **7.20px**. xterm's `CharSizeService` measures this for real (`CanvasRenderingContext2D.measureText`, with a hidden `xterm-char-measure-element` DOM fallback) and stores it on `RenderService.dimensions.css.cell.width`; `FitAddon.proposeDimensions()` divides the available width by that **measured** value, not a nominal ratio. So sizing the dock in pixels sizes it in columns, deterministically. Taking 7.80px as the worst case makes 648px a floor on every platform rather than only on Windows.

2. **The 80-column floor for agent CLIs — confirmed, and it is a floor, not a preference.** Claude Code and OpenAI Codex CLI hard-wrap at 80 columns; Aider's unified-diff and SEARCH/REPLACE output assumes the same baseline; Cursor and Gemini CLI prompt boxes and status footers clip below roughly the same width. Behaviour by width: at 40 columns diffs are unusable (indentation plus `+`/`-` flags leave under 25 characters of code, folding every line two to three times) and box-drawing borders collide with their content; at 50 it is cramped and only viable for prose replies; 64 is marginal; 80 is where full unified diffs, line numbers, file paths and framed tool output render natively. Modern TUI frameworks reflow *paragraphs* on `COLUMNS`/`TIOCGWINSZ`, but code and structured diffs are non-reflowable horizontal data — which is exactly why the chat-pane analogy in the Goal does not transfer.

Everything else in this plan — the rail anchor reconciliation, the relay guard, the `PtyFleetService` de-duplication behaviour, the `[hidden]` cascade rule, the `sharedDefaults.js` injection path, the `SETUP_VERBS` gate location, the two hosts' `ptyCreateTerminal` contracts, the CSP and cookie posture — was read directly from source and needed no research.

## Verification Plan

Per the dispatch directive for this pass, **compilation and automated-test execution are excluded**. The assertions below are what the implementing change must *add or update*; running them is the reviewer's step, not this one.

### Automated Tests

1. **`src/test/shell-terminal-strip.test.js`** — update in the same change. The dock toggle is a new `.strip-placement-bottom` member, so any assertion on cluster composition or member count must include it, and the file's `margin-top: auto` count assertion (currently `=== 1`) must stay at 1 — the dock CSS introduces no second anchor.
2. **New `src/test/shell-agent-dock.test.js`** (static source assertions, matching the style of the existing shell tests):
   - `shell.html` contains `#agent-dock`, `#dock-splitter`, and the `body.dock-dragging` pointer-inert rule; the dock is a **sibling after** `#content`, not a child of it.
   - Neither `#dock-empty` nor `#dock-frame` nor `#dock-role-menu` relies on `hidden` alone — each declares a base `display:none` and an `.is-visible` companion rule. This is the edge-case-14 regression guard.
   - `shell.html` loads `sharedDefaults.js` **before** `shell.js`, and both carry `nonce="{{NONCE}}"`.
   - `#agent-dock`'s declared `min-width` and `width` are both ≥ 648px, and `shell.js`'s `DOCK_MIN` is ≥ 648 — the edge-case-13 guard, so a future "tidy" cannot silently shrink the dock back below the 80-column floor. Assert the constant and the CSS separately; they are two places the number can drift.
   - `shell.js` declares `DOCK_VIABLE_MIN` and the dock toggle consults it — the edge-case-7 guard against a narrow window squeezing the board instead of gating the dock.
   - `shell.js` builds the toggle **only** inside a `frames.has('terminals')` guard, and its glyph URL is not `nav-terminals.svg`.
   - `shell.js` contains no `ptyCreateTerminal` call outside `startDockTerminal` (asserting "no implicit create"), and no string-prefix test against `'dock-'` on a fleet entry (asserting the seat name is opaque).
   - `applyThemeToAll` references the dock frame.
   - `setDockOpen` assigns `dockEl.style.width` from persisted state.
   - `terminals.js` returns early from `postFleetStateToShell` on the dock flag, and that guard sits **after** the `window.parent === window` guard and **before** the `fleetList.map`.
3. **`src/test/browser-panel-verb-routing.test.js`** — extend to assert `getAgentDockRole` / `setAgentDockRole` are present in `SETUP_VERBS` after regeneration and reachable on `/setup/verb/*`.
4. **`src/test/pty-route-surface-contract.test.js`** — no change expected; the `/panels` manifest gating is untouched. Included so an unexpected diff here is treated as a regression signal.

### Manual (standalone, `npx` host, node-pty present)

5. Open `/`. Rail bottom cluster reads `Dock | Setup | Toggle Theme`, all three flush to the bottom with one gap above them (no mid-rail cluster), and the dock glyph is visually distinct from the Terminals panel glyph in the top group.
6. Click Dock → panel opens on the right at 648px, board narrows (is not overlapped), empty state shows `Start Project Manager`.
7. Click Start → a seat appears in the fleet strip; the dock renders a live terminal; the configured PM CLI boots in it. **Run `tput cols` (or `echo $COLUMNS`) inside it and confirm ≥ 80** — this is the edge-case-13 acceptance check and the one that decides whether the feature met its goal.
8. Switch panels (Board → Project → Artifacts): the dock stays mounted and the terminal keeps its scrollback and WebSocket (no reconnect flicker).
9. Drag the splitter across the board area and over the terminal — the drag tracks the cursor the whole way (the `pointer-events:none` check) and clamps at both ends (648px floor, 1100px ceiling). Widen to the ceiling and confirm `tput cols` grows with it.
9a. **Narrow-window gate (edge case 7).** With the dock open, drag the browser window below 980px wide → the dock auto-closes and the rail toggle goes `disabled` with the "window too narrow" tooltip; the board keeps the full content area and is never squeezed to 200px. Widen back above 980px → the toggle re-enables. The dock does **not** reopen by itself (closing was a forced action, not a user preference — leave `open:false` written).
10. Reload: dock reopens **at the dragged width**, adopts the existing seat without creating a second one. Fleet strip is unchanged.
11. Toggle the theme: dock chrome **and** the terminal inside it repaint without a reload.
12. Change the dock role via the header chip → menu shows human labels ("Lead Coder", "Reviewer"), not raw keys; dock returns to the empty state for the new role; the previous seat stays alive in the fleet strip (it is not killed).
13. Pick a role with no CLI configured → the start button's hint says plain shell; starting it yields a bare shell, no phantom agent.
14. Close the dock, reload → stays closed; the seat survives in the fleet.
15. **Restart cycle (edge case 4).** Exit the agent inside the dock terminal so it self-exits, then click Start again. The dock mounts whatever `friendlyName` the server returned — confirm it renders and takes input even though the name is now from the `<role>-N` series, and that the dock did **not** strand itself on the dead seat.
16. **Relay isolation (edge case 2).** With the dock open on a live seat, confirm the rail's fleet strip still shows correct per-terminal brand icons and lights — not the default glyph. Reload the dock frame and confirm the strip does not flicker to defaults.

### Manual (extension browser cockpit)

17. `switchboard.openInBrowser` → repeat steps 5-8 and 12. Terminals is enabled via `ptyHostReady()`, so the dock must behave identically against the out-of-process pty host, and the role must persist to VS Code settings (check `switchboard.agentDock.role` in the Settings UI).

### Manual (negative)

18. On a build/install where `isPtyAvailable()` is false (or with the `terminals` manifest entry forced to `enabled:false`): no dock toggle in the rail, no dock element rendered, no request to `/terminals`, and the rest of the shell is untouched.

---

**Recommendation: Send to Lead Coder** (complexity 7).
