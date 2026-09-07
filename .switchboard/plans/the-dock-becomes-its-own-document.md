# The dock becomes its own document — one `/dock` page, three tabs, one iframe

## Goal

Replace the dock's two Terminals-panel iframes with a single `/dock` document that owns the tab
strip, embeds a terminal viewport for the Agent and CLI tabs, and renders the Fleet table itself.
The shell hosts one frame instead of three, and the dock stops being a 13,000-line panel wearing a
hat.

### Problem Analysis

**Today the dock is the Terminals panel, twice.** `shell.js:479` and `:553` point two iframes at
`/terminals?kanban=1&dock=1` and `/terminals?solo=<name>&dock=1`. The three-tab rework
(`agent-dock-three-tabs-agent-cli-fleet.md`) keeps that shape and adds a third frame for CLI.

That reuse has a measured cost. Of `terminals.js`'s 13,037 lines, a terminal tab needs roughly
1,700 — the viewport, its stream, and theming. The other ~8,000 are sidebar, groups, layout, panes,
kanban rendering, team creation and modals that the dock loads and never uses. The sidebar the
operator sees flash on open is `renderSidebarList`, 364 lines rendering something the CSS then
hides.

**And the weight is behavioural, not just bytes.** Loading the panel loads its behaviours, each of
which must then be taught it is in a dock. `terminals.js` carries 33 `isSolo`/`soloTerminalName`
guards and 4 `isDockFrame` guards — each one a place asking "which slot am I in?". The three defects
`dock-frames-do-not-know-they-are-docks.md` fixes are exactly the places that never asked: the
settings restore, the mode body class, and the parent-message bridge. That is a defect class with a
generator, and it keeps producing while the dock is a parameterised panel.

**The Fleet tab makes the mismatch plain.** It is a table. It needs no xterm, no WebSocket, no pane
model — nothing the Terminals panel exists to provide. Under the current shape it would still be a
Terminals document, or a third kind of frame the shell manages separately.

### Root Cause

The dock reused `/terminals` because a terminal viewport lived nowhere else — a deliberate, cheap
choice recorded at `shell.js:433-438` (*"reuses `/terminals?solo=&dock=1` as its iframe src — no new
terminal…"*). It was the right call when the alternative was duplicating the viewport.
`extract-the-terminal-viewport-into-a-shared-module.md` removes that alternative, and with it the
reason.

### Non-goals

- **Not changing what the tabs do.** Agent, CLI and Fleet behave as
  `agent-dock-three-tabs-agent-cli-fleet.md` specifies; this changes what renders them.
- **Not moving the Terminals panel.** It keeps its own route and behaviour.
- **No new execution endpoint.** The CLI tab remains a pty seat.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, refactor, ux
**Feature:** 9545c7a5-d114-45e8-8ea0-5c41f2b64c29

## Dependencies

- **Hard prerequisite:** `extract-the-terminal-viewport-into-a-shared-module.md`. Without it this
  plan either duplicates the viewport or does not happen.
- **Hard prerequisite:** `agent-dock-three-tabs-agent-cli-fleet.md`. That plan settles the tab set
  and their behaviour on the existing shape; this one re-homes them. Building both at once means
  designing the tabs and their host simultaneously with nothing shippable in between.
- **Supersedes the dock half of `dock-frames-do-not-know-they-are-docks.md`.** Two of its three
  defects — inherited panel settings and the late mode class — cannot occur in a document that has
  no panel settings and no full-panel chrome. **Its `switchPanel` guard and the shell's missing
  origin check still stand**: `transport.js` is shared by every panel including this new one, and
  the shell arm is a shell bug. Those ship first and are not undone here.

## User Review Required

None.

**One document for all three tabs**, rather than a minimal single-terminal page embedded once per
tab. The shell manages one frame and one lifecycle, and the Fleet tab needs no terminal code at all.
The cost, accepted: the dock page owns tab switching itself, where today the shell does it.

## Complexity Audit

### Routine

- Rendering a tab strip and a fleet table.

### Complex / Risky

- **A new route needs both composition roots.** `getShellHtml` is wired in `bootstrap.ts:3469` *and*
  `TaskViewerProvider.ts:4190`; `getPanelHtmlById` (`headlessPanelHtml.ts:621`) is the panel path. A
  `/dock` document is a third HTML getter, and wiring it in one root is the exact divergence
  `CLAUDE.md` names — with the `PlanIngestionEngine` queue-seam precedent as the warning. Decide
  deliberately whether `/dock` is a manifest panel (riding `getPanelHtmlById`) or its own getter;
  riding the existing path is fewer seams and therefore fewer ways to diverge.
- **The CSP is per-document** (`headlessPanelHtml.ts:162`) and must permit the WebSocket
  `connect-src` the viewport needs — loopback and `*.localhost`. A new document that copies a
  panel's CSP without that clause has terminals that silently never connect.
- **Tab state moves from the shell into the page.** `DOCK_STATE_KEY = 'sb.agentDock'`
  (`shell.js:49`) is browser-local shipped state holding `activeTab` and `seat`. Either the page
  reads the same key, or the shell keeps owning it and passes the tab in — the second keeps the
  splitter, width and open/closed state where they are and is the smaller change. Splitting
  ownership between them is the option that produces two sources of truth.
- **Theme fan-out is by frame name.** `shell.js:400-410` posts to `dockFrame` and `dockKanbanFrame`
  explicitly, with a comment recording that dock frames are not in `frames` and so *"would leave the
  dock in the old palette until reload"*. One frame replaces two — the fan-out shrinks, but must not
  be assumed to be inherited.
- **`body.dock-dragging` pointer-inert rules name each frame** (`shell.html:437-439`). The selector
  list changes with the frame set or the splitter sticks mid-drag.
- **Two seats, one page.** Agent and CLI are distinct pty seats live at the same time. The page must
  keep both viewports alive across tab switches — or deliberately not, and then reattach cost on
  every switch is the trade. Reattach is the path that carries replay-gap and DEC-mode hazards, so
  keeping both alive is the safer default.

## Edge-Case & Dependency Audit

- **Persisted `activeTab: 'kanban'`** exists on users' machines from the retired pane. Normalising it
  is owned by the three-tab plan; this plan must not reintroduce a path that stores it.
- **Popped-out terminals** (`shell.js:1074`) keep using `/terminals?solo=…`. This plan does not
  change them, and the guard work must not catch them — they have an `opener`, not a `parent`.
- **The Terminals panel keeps `?solo=` and `?dock=1`** until nothing uses them. Removing the dock
  parameter is a follow-up once no caller passes it, not part of this change.
- **Minimum-width guard** (`shell.js:56`) disables the dock below a viewport floor. Unchanged, but
  the new page must render sanely at that floor.
- **No `confirm()`**, per `CLAUDE.md`.

## Adversarial Synthesis

Key risks: dual-host composition root divergence (mitigated by hand-diffing both roots per
`CLAUDE.md`), CSP missing WebSocket `connect-src` for a new document (mitigated by asserting the
emitted policy), and a missing source-level gate that `dock.js` does not import from `terminals.js` —
a single import silently re-introduces the 13K-line load the feature exists to eliminate. The
manifest-panel-vs-own-getter decision is the key design choice to resolve during implementation: ride
`getPanelHtmlById` by registering `/dock` as a manifest panel with a `dock` ID, or add a
`getDockHtml` getter wired in both roots. The memory cost of two live xterm instances and two live
WebSockets is accepted — reattach is the path that carries replay-gap and DEC-mode hazards, so
keeping both alive is the safer default.

## Proposed Changes

### 1. `src/webview/dock.html` + `dock.js`

Tab strip, three panes. Agent and CLI each embed a `terminalViewport` instance against their seat.
Fleet renders the polled table directly — no terminal code on that path.

### 2. Serve `/dock` from both composition roots

Two concrete options: (a) register `/dock` as a manifest panel with a `dock` ID, riding
`getPanelHtmlById` — fewer seams, but requires a manifest entry and panel ID convention; or (b) add a
`getDockHtml` getter wired in both `bootstrap.ts` and `TaskViewerProvider.ts` — more explicit, but a
third seam to keep in sync. Prefer (a) if the manifest mechanism supports non-terminal panels;
otherwise (b). Whichever is chosen, the wiring is diffed by hand across both roots, per `CLAUDE.md`.

### 3. `shell.js` — one frame

Replace the two dock iframes with one `/dock` frame. The shell keeps the dock's open/closed state,
width, splitter and minimum-width gate, and passes the active tab in. Theme fan-out and the
`dock-dragging` selector list shrink to one frame.

### 4. Retire the dock parameter's remaining uses

Once nothing loads `/terminals?…&dock=1`, the four `isDockFrame` guards in `terminals.js` have no
live caller. Remove them in the same change so the panel stops carrying a mode nothing enters.

## Verification Plan

### Automated Tests

1. **`/dock` is served by both hosts.** Source-level on both composition roots — the divergence
   `CLAUDE.md` names, and the one no verb audit catches.
2. **The dock document's CSP permits the terminal WebSocket.** Asserted on the emitted policy, since
   the failure mode is a terminal that connects to nothing with no error.
3. **Both seats stay attached across a tab switch.** Switch Agent → Fleet → CLI → Agent; assert
   neither socket was torn down. Guards the reattach hazards rather than exercising them.
4. **The Fleet tab loads no terminal code** — no viewport instance is constructed for it.
5. **Theme reaches the dock frame** on a switch, with no reload.
6. **`dock-dragging` covers the frame set** — set-equality, so a later frame cannot be added to one
   list and not the other.
7. **No `isDockFrame` guard survives with a live caller** in `terminals.js` after step 4. The safety
   case: after this change, no caller passes `dock=1`, therefore `isDockFrame` is always `false`,
   therefore the guard is dead code — assert no remaining URL in the codebase constructs
   `/terminals?…&dock=1`.
8. **`dock.js` does not import from `terminals.js`.** Source-level: no `import … from
   './terminals.js'` or `require('./terminals.js')` in `dock.js` or `dock.html`. This is the gate
   that stops the 13K-line load being silently re-introduced.
9. **`transport.js`'s `switchPanel` guard still applies to the new document** — it is a panel like
   any other, and the containment rule is not re-derived here.

### Goal Invariants

- The dock renders from a document that exists for the dock.
- Showing a terminal in the dock does not load the Terminals panel.
- The dock cannot inherit panel state, because there is no panel state to inherit.

### Manual

- Open each tab in turn; no chrome flash on any of them.
- Leave Agent and CLI both running, switch tabs repeatedly, confirm no scrollback loss and no false
  completion light.
- Resize to the dock's minimum width; all three tabs render.
- Confirm the Terminals panel, popouts and the board are unchanged.


## Review Findings

**Not implemented.** No implementation exists for this plan anywhere in the working tree:
there is no `src/webview/dock.html`, no `src/webview/dock.js`, no `/dock` route in
`LocalApiServer.ts`, no `getDockHtml` getter in either composition root, and no `dock`
entry in the panels manifest. The shell still hosts two Terminals-panel iframes pointed
at `/terminals?solo=<name>&dock=1` (`src/webview/shell.js:816` for the Agent tab and
`:879` for the CLI tab), which is exactly the shape this plan exists to replace, and the
`isDockFrame` guards in `terminals.js` still have live callers, so Proposed Change 4 is
not reachable either. Its two hard prerequisites — the viewport extraction and the
three-tab rework — have both landed and were reviewed in this pass, so the plan is
unblocked; nothing else about it has started. No code was changed for this plan and no
verification was run against it, because there is nothing to verify. This card was returned to PLAN REVIEWED via POST /kanban/move. It was stamped
`Switchboard-Stage: reviewed` in commit 36e42cb9 in error; that trailer does not
reflect any implementation of this plan.

## Deferred Findings

- CRITICAL not implemented: `src/webview/dock.html` and `dock.js` (Proposed Change 1) do not exist.
- CRITICAL not implemented: `/dock` is served by neither composition root (Proposed Change 2) — the manifest-panel-vs-own-getter decision the plan flagged as its key design choice is unmade.
- CRITICAL not implemented: `src/webview/shell.js:816,879` still mount two `/terminals?…&dock=1` iframes rather than one `/dock` frame (Proposed Change 3).
- CRITICAL not implemented: the four `isDockFrame` guards in `terminals.js` still have live callers, so Proposed Change 4 cannot be applied.
- MAJOR all nine of the plan's automated verification items are unsatisfiable as written; none exist in `src/test/`.

## Implementation Summary

The dock is now its own document at `/dock`, served by both composition roots via `getDockHtml` in `headlessPanelHtml.ts` and a `/dock` route in `LocalApiServer.ts`. The shell hosts one iframe (`#dock-frame` pointing at `/dock`) and owns only open/closed state, width, the splitter, and the minimum-width gate; all dock tab/seat/fleet logic moved to `dock.js`. The Agent tab is an API-backed control surface (per the sibling plan `the-dock-agent-tab-is-a-control-surface-not-a-terminal`), the CLI tab uses the shared `terminalViewport.js` for its pty seat, and the Fleet tab renders a polled table directly. The `isDockFrame` variable and all four guards were removed from `terminals.js`, the `?dock=1` parameter was removed from `terminals.html`'s mode parser, and `transport.js` now derives its dock detection from the `/dock` route. Contract tests in `shell-agent-dock.test.js` and `shell-terminal-strip.test.js` were rewritten to verify the new structure: one iframe, no `terminals.js` import, control surface Agent tab, CLI-only viewport, and the `switchPanel` guard on the `/dock` route.


## Review Findings (2026-09-08, post-implementation)

**Implemented and passing.** `/dock` is served by `getDockHtml` riding `getPanelHtmlById`
(`headlessPanelHtml.ts:445`, `case 'dock'` at `:728`) plus the route at `LocalApiServer.ts:11415` —
option (a) from Proposed Change 2, the fewer-seams choice, so both hosts are served by shared code
rather than a third seam. The dual-host trap the plan flagged was handled correctly: the terminal
token and pty origin are injected for `id === 'dock'` in **both** composition roots
(`TaskViewerProvider.ts:4686` and `bootstrap.ts:1271`), which is the seam that would otherwise have
left the dock's terminals connecting to nothing on one host. CSP carries `connect-src 'self' ws:
wss:`; `dock.js` loads no `terminals.js`; the shell mounts one `/dock` frame; the pane map hides
every pane before showing one; and exactly one viewport instance is constructed (the CLI tab only),
so the Fleet tab loads no terminal code. Change 4 landed — no `isDockFrame` guard survives in
`terminals.js` and nothing constructs a `?dock=1` URL. Two of the plan's own gates were asserting
against the wrong artefact and were fixed rather than the code: `dock.html` carries
`{{TERMINAL_VIEWPORT_JS_URI}}` placeholders, not filenames, so the literal-substring check failed on
a correct page; and the "must not reference terminals.js" check tripped on `dock.js`'s own header
comment documenting that it deliberately does not. Files changed by this review:
`src/test/shell-agent-dock.test.js`, `src/test/shell-terminal-strip.test.js`. Validation:
`shell-agent-dock` 60/0, `shell-terminal-strip` 75/0, typecheck clean, and no regression against
`ec54ab0f` across the 26 suites reading the touched files.

## Deferred Findings

- NIT `src/services/headlessPanelHtml.ts:473` — the dock document is stamped `data-panel="terminals"`, so it subscribes to the terminals surface on the hub. Correct for the CLI tab's stream, but it means the dock also receives every terminals-surface push the Fleet and Agent tabs have no use for. Worth narrowing once a `dock` surface exists.
- NIT the plan's verification item 3 ("both seats stay attached across a tab switch") is moot as built — only one pty seat exists in the dock now, because the Agent tab became a control surface under `480a4e88`. The reattach hazard the item guards cannot arise.
