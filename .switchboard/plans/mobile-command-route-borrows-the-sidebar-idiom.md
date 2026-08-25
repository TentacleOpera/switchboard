# A phone-shaped command route, because the sidebar already solved the layout and the board never serves it

## Goal

Serve a narrow, tap-only command surface from the standalone browser board so the five
away-from-desk functions — dispatch a plan, build a mission, start a mission, write and
send a memo, message a terminal — are reachable from a phone. The layout problem is
already solved; the route does not exist.

### Problem Analysis

**The board is unusable on a phone, and not because of styling.** Every `@media` rule in
`src/webview/*.html` is `prefers-reduced-motion` — there is not one width breakpoint in
`kanban.html`, `shell.html`, `terminals.html`, `planning.html`, `tickets.html`,
`project.html` or `setup.html`. Worse, card moves use HTML5 drag-and-drop (11
`dragstart`/`dragover`/`draggable` references in `kanban.html`), and **HTML5 drag events do
not fire on touch devices at all**. On a phone the board is not cramped, it is inert: you
can read it and you cannot move a card. `terminals.js` has the same problem for pane
reordering (14 drag references against 1 touch reference).

**But a phone-shaped design already exists, by accident.** `src/webview/implementation.html`
is the VS Code sidebar panel, and a sidebar is ~320-400px — the same constraint a phone
imposes. It shows every property the board lacks:

- **Zero drag events** in 3,562 lines. Every control is a `<button>`, a `<select>`, or a tab.
- Fluid layout: `grid-template-columns: 1fr 1fr`, `w-full` stacked buttons, `max-width: 800px`
  as a cap rather than a floor.
- `<meta name="viewport" content="width=device-width, initial-scale=1.0">` already present
  (line 7) — one of only three pages that has it.
- A sub-tab bar (Agents / Terminals / Memo), which is a phone navigation pattern.

**The board never serves it.** `implementation.html` is absent from `getPanelsManifest()`
and from `getPanelHtmlById()` (`headlessPanelHtml.ts:547`, `:571`). The served set is board,
mission-control, agent-control, terminals, project, memo, tickets, planning, design, setup,
connections. The only loader is `TaskViewerProvider.ts:24701`, the extension sidebar. And the
standalone host deliberately went the other way: `bootstrap.ts:2166` records that "the memo
capture UI was relocated from implementation.html to project.html… In standalone/headless mode
there's no TaskViewerProvider to delegate to, so implement the file I/O directly."

**The functions are already reachable over HTTP, which is what makes this cheap.** Four of the
five target functions are existing `LocalApiServer` routes on the same port the board is served
from, so they need no verb bridging:

| Function | Route |
|---|---|
| Dispatch a plan | `POST /kanban/dispatch` — documented at `:1519` as the one-call "advance a card and fire its agent" |
| Build a mission | `POST /kanban/mission/create`, `POST /kanban/mission/member/add` |
| Start a mission | `POST /mission-control/start`, then `POST /mission-control/confirm` (`:567` — "the only path that arms") |
| Write and send a memo | `/memo`, plus `memoSave`/`memoLoad`/`memoClear`/`memoGeneratePrompt` already bridged in standalone |
| Message a terminal | `POST /terminals/relay` — send-only; see the companion answer-back plan |

### Root Cause

Two independent causes.

- **The sidebar was never part of the headless migration.** Of the 38 distinct message types
  `implementation.html` posts, 8 have any presence in `src/standalone/` (`focusTerminal`,
  `sendToTerminal`, `reviewPlan`, `ready`, and the four memo verbs). The page was left as an
  extension-only surface while the browser board grew its own desktop-shaped panel set.
- **Mobile was never a target,** so the responsive work that a sidebar constraint would
  otherwise have generalised into breakpoints stayed local to one webview.

### Non-goals

- **Not a redesign of the board.** `kanban.html` keeps its drag-and-drop and its desktop
  layout. This plan adds a surface; it does not make the existing one responsive.
- **Not a port of `implementation.html`.** The page borrows its *idiom* — narrow, single
  column, tap-only, stacked full-width buttons, sub-tab navigation — not its markup. It has
  no mission controls at all (those are `mcNewMission`/`mcLaunchMission` in
  `KanbanProvider.ts:9870+`), so its control set is the wrong one for this route.
- **No new verbs.** Four of the five functions are existing HTTP routes. If a control needs a
  verb that does not exist, it is out of scope for this plan.
- **No terminals panel, no PTY, no xterm.** Typing into a shell is not a phone interaction.

## Metadata

**Complexity:** 5
**Tags:** ui, ux, frontend, feature, mobile
**Feature:** 1bf7a3ba-465b-4f4d-8cf6-54e8a6e675cc

## User Review Required

Yes — two decisions.

1. **Route name and placement.** `/command` as a first-class manifest entry visible in the
   nav strip, versus an unlisted route reached only by direct URL. Recommendation:
   **manifest entry, `enabled` gated on nothing** — an unlisted route is undiscoverable and
   will rot. If it should not clutter the desktop nav, use `placement: 'bottom'` the way
   `setup` does.
2. **Does the route render its own shell, or live inside `shell.html`?** Recommendation:
   **its own minimal shell.** `shell.html` carries a nav strip, panel chrome and iframe
   messaging sized for a desktop; inheriting it re-imports the layout problem this route
   exists to avoid.

## Complexity Audit

### Routine

- A manifest entry in `getPanelsManifest()` and a case in `getPanelHtmlById()`.
- A single-column page of stacked full-width buttons and a plan `<select>`, in the existing
  industrial-UI token set (`--accent-primary`, `--panel-bg`, Hanken Grotesk) so it does not
  read as a different product.
- `fetch()` calls against five existing routes, with the bearer token the board already holds.

### Complex / Risky

- **Deliberate subsetting, not wholesale reuse.** `implementation.html` opens with an
  onboarding container containing a **PAT input field** (line 1411) and multi-repo clone
  scaffolding (`scaffoldMultiRepo`, `airlock_syncRepo`). None of that may appear on a route
  reached from a phone. The mobile route must be built as an allowlist of controls, never as
  "the sidebar minus a few buttons" — a subtraction list silently regains whatever is added
  to the sidebar later.
- **Mission start is a two-step arm.** `/mission-control/start` does not arm; `:567` records
  that `/mission-control/confirm` "is the only path that arms" and requires
  `.switchboard/mission-control/session.md` to exist. A one-tap "start mission" that skips
  the confirm step will appear to work and arm nothing. The two-step shape must survive onto
  the phone, which means the button reports *which* state it reached.
- **Tap targets.** Sidebar controls run 11-12px type in compact buttons — below the 44px
  minimum. Raising them is cheap but changes the vertical rhythm the sidebar idiom depends on,
  so it is a real layout pass rather than a font-size bump.
- **Destructive controls on a pocket device.** The board's standing rule is no confirmation
  dialogs — delete buttons delete immediately, and `window.confirm()` is a silent no-op in
  webviews anyway. That rule holds here, which means the answer to accidental taps is
  **omission, not a gate**: no delete, no reset, no deregister on this route at all.
- **Failure legibility.** A phone link drops mid-request routinely. Every control needs a
  distinct "not sent" versus "sent, outcome unknown" state, because a dispatch that may or
  may not have fired is the one outcome that costs real work.

## Edge-Case & Dependency Audit

**Race conditions**
- Two dispatches from a flaky link: the same tap retried after a timeout must not advance a
  card twice. `POST /kanban/dispatch` advances a column and fires an agent, so a duplicate is
  a real double-dispatch. Either the route is made idempotent per card+column or the client
  disables the control until it has a definite answer.
- Mission arm racing the desk: the operator may be arming the same mission from the board.
  Report the state the server actually reached rather than the state the tap intended.

**Security**
- This route is the first surface designed to be reached from a device that is not the
  operator's desk, which makes its control set a security decision rather than a UX one. No
  onboarding, no PAT field, no repo scaffolding, no shell access, no destructive verbs.
- The four loopback guards are untouched. This plan adds a page; it does not change the bind
  address, the peer check, the Host guard or the CLI hostname validation. Reaching the route
  from a phone is the companion access plan's problem, not this one's.
- Auth is the board's existing model: `sb_session` cookie for a browser, `Authorization:
  Bearer` for an agent. A phone that keeps a session across days wants the durable
  `switchboard.apiToken` (`npx switchboard token rotate`), not the one-time launch token.

**Side effects**
- A new manifest entry appears in the desktop nav strip unless placed. Confirm it does not
  displace an existing panel's position, which operators navigate by muscle memory.
- Capability gating has a precedent: the manifest fails closed on `terminals`
  (`availability?.terminals === true`). This route should state its own precondition rather
  than render buttons that 503.

**Migration**
- None. A new route, a new page; no state, settings, files or formats change. `implementation.html`
  is not modified, so the extension sidebar is unaffected.

## Dependencies

- **Soft prerequisite:** the answer-back plan. Four of the five functions work without it; the
  fifth ("message a terminal and get an answer") is send-only until that lands, so this route
  should ship the send half and gain the return half when it exists.
- **Not a prerequisite:** the tailnet access plan. This route is testable today over an SSH
  tunnel from a laptop browser resized to 390px, and from a phone with an SSH client.
- **Independent of** the verb-bridging question. The five target functions are HTTP routes.

## Adversarial Synthesis

Key risks: (1) building the page as "the sidebar minus some buttons", which silently regains
the PAT field and repo scaffolding the next time the sidebar grows; (2) shipping a one-tap
mission start that calls `/mission-control/start` and never `/confirm`, so it appears to work
and arms nothing; (3) inheriting `shell.html` and with it the desktop layout this route exists
to escape; (4) a dropped mobile connection turning one tap into two dispatches. Mitigations:
build the control set as an explicit allowlist; make the arm sequence visible in the UI and
report the state actually reached; render a minimal own shell; disable each control until it
has a definite answer, and confirm `POST /kanban/dispatch` is safe to retry before relying on it.

## Proposed Changes

1. **Manifest and route.** Add a `command` entry to `getPanelsManifest()` and a case to
   `getPanelHtmlById()` in `src/services/headlessPanelHtml.ts`, with its own `getCommandHtml`
   generator following the existing per-request CSP-nonce pattern.
2. **The page.** Single column, own minimal shell, existing design tokens. An explicit
   allowlist of controls:
   - Plan `<select>` + **DISPATCH** → `POST /kanban/dispatch`
   - **NEW MISSION** (name + member picker) → `POST /kanban/mission/create`, `/member/add`
   - **START MISSION** → `POST /mission-control/start` then `/confirm`, with the two steps
     visible and the reached state reported
   - **MEMO** (textarea, append-only, save) → `/memo`
   - **MESSAGE TERMINAL** (target picker + textarea) → `POST /terminals/relay`
   - Read-only status: active plans, live terminals, current mission state
3. **Tap-target pass.** 44px minimum on every control, with the vertical rhythm re-tuned
   rather than the type merely enlarged.
4. **Explicitly absent:** onboarding, PAT entry, repo scaffolding, terminal grids, agent
   deregistration, plan deletion, setup, and any xterm surface.
5. **Failure states.** Per-control "not sent" / "sent, outcome unknown" / "confirmed",
   distinct from empty.

### Migration

None — a new route and page. No shipped state, file, setting or format changes, and
`implementation.html` is untouched so the extension sidebar cannot regress.

## Verification Plan

1. **Real phone, real tunnel.** Reach `/command` from a phone browser (SSH client holding a
   local forward, or the companion access plan once it lands). Every control operable
   one-handed, no horizontal scroll, no pinch-to-read.
2. **Each of the five functions end-to-end**, verified at the *effect* rather than the
   response: a card actually advances and its agent fires; a mission exists on the board with
   the members chosen; the mission is genuinely armed (not merely started); the memo line
   appears in `.switchboard/memo.md`; the message arrives in the target terminal.
3. **Mission arm is not skippable.** Call start without confirm and assert the UI reports
   "started, not armed" rather than success.
4. **Relay never clears.** Send into a working terminal and confirm its context survives —
   `/terminals/relay` hardcodes `clearBeforePrompt: false` and this route must not reintroduce
   a path around it.
5. **Dropped connection.** Kill the link mid-dispatch. Assert the control shows "outcome
   unknown", not success and not failure, and that retrying does not double-dispatch.
6. **Allowlist holds.** Grep the served page for `password`, `PAT`, `scaffold`, `airlock`,
   `deregister`, `delete` and assert none are reachable. Add a test asserting the control set,
   so a later sidebar addition cannot leak in.
7. **Desktop unregressed.** Open the extension sidebar and confirm `implementation.html` is
   byte-identical in behaviour; confirm the new nav entry displaces no existing panel.
8. **Guards unchanged.** Re-run `loopback-hostname-contract` and confirm a non-loopback peer
   and a non-loopback Host still 403. This plan must be exposure-neutral.
9. **Capability gating.** Serve the route on a host without `node-pty` and confirm the
   terminal-message control states its precondition rather than 503-ing on tap.

## Cross-reference: a read-only board already travels without the host

*Appended after a sweep of existing plans.*

`board-anywhere-cloud-mobile-snapshot.md` publishes a self-contained, pre-rendered `board.html`
alongside `board.json`/`board.md` on the `switchboard/board` orphan branch, via
`BoardSnapshotPublisher` (which already debounces, hash-dedupes, single-flights and force-pushes on
every board mutation). It is viewable on a phone through static hosting of that branch **with the
local machine off entirely** — no tunnel, no terminator, no exposure of the host at all.

That is strictly better than this plan for *looking* at the board, and it does not compete with it:
this route exists to **act** — dispatch, build and start missions, memo, message a seat — which a
published snapshot cannot do.

**Two consequences worth carrying:**

- **Do not add board-viewing to this route's scope.** If the operator's need turns out to be mostly
  "what's the state", the snapshot answers it more cheaply and more safely, and this route's
  justification narrows to the action set. Keep the read-only status display here minimal — enough
  context to act, not a board.
- **It weakens the access plan, not this one.** `a-phone-on-the-tailnet-has-nothing-to-connect-to.md`
  spends guard 2's protective effect against tailnet peers. If viewing is the main want, that
  spend buys little, because the snapshot already delivers viewing at zero exposure. The access plan
  is justified only by the *acting* half — which is this plan. Worth re-reading that trade with the
  snapshot in mind before committing to it.

One more finding from that plan, relevant to earlier discussion of artifact-based surfaces: "Claude
artifacts run under a strict CSP that blocks all network requests, so an artifact can never poll
`localhost` or any API." An artifact can render a snapshot; it can never be a live cockpit.
