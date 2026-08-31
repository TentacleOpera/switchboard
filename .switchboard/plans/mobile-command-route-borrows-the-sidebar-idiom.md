# A phone-shaped command route, because the sidebar already solved the layout and the board never serves it

## Goal

Serve a narrow, tap-only command surface from the standalone browser board so the five
away-from-desk functions — dispatch a plan, build a mission, launch one and watch it run, move
a card to any column, and see what a team is doing — are reachable without the desktop board. It must be
**snappy, branded, and good-looking in two form factors**: a phone held vertically, and an
iPad sitting in landscape on a desk. The route does not exist.

**Buttons and dropdowns only. There is no text input on this surface — not one field,
anywhere.** This is the route's defining constraint, not a simplification of it: it is a
touch command surface for a CLI-backed board, and every control is a tap or a select. A
control that needs typing is not a control this route can carry.

**Five functions, four views — the two counts are both correct and are not interchangeable.**
Earlier revisions of this document say "four functions" in places, because *Teams* was
appended on 2026-08-31 after those sentences were written, and one enumeration still listed
only three view names under a heading saying four. Fixed throughout; recorded here so the
arithmetic is checkable rather than inferred:

| # | Function | View |
|---|---|---|
| 1 | Dispatch a plan or feature | Dispatch |
| 2 | Move a card to any column | Move |
| 3 | Build a mission | Mission |
| 4 | Launch a mission and watch it run | Mission |
| 5 | See what a team is doing | Teams (phone) / rail icons (tablet) |

Functions 3 and 4 share the Mission view — that is why five functions fit behind four nav
destinations. **VIEW is not a fifth view**: it is a full-pane overlay reached from a card in
Dispatch or Move, with a Back button, and it occupies no nav slot.

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

**The functions are already reachable over HTTP, which is what makes this cheap.** Every
target function is an existing `LocalApiServer` route on the same port the board is served
from, so none needs verb bridging. All seven routes below were confirmed present in
`src/services/LocalApiServer.ts`:

| Function | Route |
|---|---|
| Dispatch a plan | `POST /kanban/dispatch` — documented at `:1519` as the one-call "advance a card and fire its agent" |
| Build a mission | `POST /kanban/mission/create`, `POST /kanban/mission/member/add` |
| Launch a mission | `POST /kanban/queue/next` — the path `launchMission` itself fans out through (`KanbanProvider.ts:14864`); launching is dispatching the mission card |
| Move a card to any column | `POST /kanban/move` (`LocalApiServer.ts:3720`) — takes an arbitrary `targetColumn`, so forward, backward and non-adjacent are one call; resolves the workspace root by card identity; inherits the feature→subtask cascade and the Linear/ClickUp sync fan-out. Distinct from `/kanban/dispatch`: it moves without firing an agent |
| See what a team is doing | The roster comes from the `terminals.groups` config, read through `_getScopedSetting` (`KanbanProvider.ts:823`); team icons from `GET /terminals/icon-palette`; the head's output from the existing `/ws/terminal` gateway (`terminalWsGateway.ts`), read-only. No new transport |
| Star / unstar (the Move filter) | `PUT /kanban/plans/priority` — writes `plans.priority_starred`, the same flag `kanbanOrdering.ts` sorts on. Reused, not invented |

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
- **No new verbs.** Every function is an existing HTTP route. If a control needs a
  verb that does not exist, it is out of scope for this plan.
- **No text input, of any kind.** No textarea, no `<input type="text">`, no
  contenteditable, no search box. Every control is a button or a `<select>`. This is not a
  preference to be traded against a control's usefulness — a control that cannot be driven
  by tapping does not go on this surface, it goes in the CLI.
- **No terminal *input*.** No PTY, no xterm, no relay control, no send field. Reading a lead's
  output is in scope as of 2026-08-31 (see *Teams: the fifth function*); writing to it is not,
  and the distinction is the whole rule. Typing into a shell is
  not a phone interaction, and the send-only relay control this plan originally carried has been
  removed from the allowlist (2026-08-31) — see *Scope revision* below.

## Metadata

**Complexity:** 8
**Tags:** ui, ux, frontend, feature, mobile
**Feature:** 7a679748-e1bd-45fd-a54d-81d59cebdfb5
**Project:** Browser Switchboard

> **Superseded:** Complexity 6.
> **Reason:** the score predates three sections appended on 2026-08-31 — the optimistic-update
> contract, Teams (a roster plus a read-only reader on the `/ws/terminal` gateway), and the
> VIEW document preview — each of which is a deliverable in its own right. What is actually
> being built is a new top-level page with its own shell and CSP, two genuinely different
> layouts at real breakpoints, a four-destination sub-nav, a second consumer of a WebSocket
> transport, a markdown preview pane, and a per-operation optimistic layer with three
> different optimism policies. That is not a 6, and a 4-6 score routes it to a Coder seat.
> **Replaced with:** Complexity 8 — Send to Lead Coder.

> **Superseded:** `**Feature:** 1bf7a3ba-465b-4f4d-8cf6-54e8a6e675cc`
> **Reason:** a dangling pin. That UUID belongs to
> `.switchboard/features/command-switchboard-from-a-phone-1bf7a3ba-….md`, which has been
> deleted; this plan is now a subtask of *Driving Switchboard From Another Device*. The line
> is inert today (the DB link is already correct, and `**Feature:**` applies with
> apply-if-empty semantics on import), but it points a reader at a file that no longer exists.
> **Replaced with:** `7a679748-e1bd-45fd-a54d-81d59cebdfb5`, matching the live feature file.

## User Review Required

**None.** Both items an earlier draft listed here were posed as a choice between two options,
and both turn out not to be a choice at all — the serving model already gives you both halves.
Settled below.

### The serving model (settled — they are not alternatives)

The two questions were "manifest entry, or unlisted route?" and "own shell, or inside
`shell.html`?", each framed as an either/or. Reading `_handleServePanel`
(`LocalApiServer.ts:1424-1475`) settles both at once: **a manifest entry and a bare top-level
page are the same thing, served by the same handler.**

Every panel route returns the panel's own HTML document with the panel's own CSP
(`_widenCspForRequest(result.csp, req)`), as a complete top-level response. What `shell.html`
does is *additionally* mount that same URL in an `<iframe>` and draw a rail icon for it — the
shell's own comment says panels "stay mounted as iframes (state + live WebSocket preserved
across switches)". So one manifest entry buys, with no extra work:

- **`GET /command`** — the bare page, no rail, no shell chrome, full viewport. This is the
  phone and tablet target, and it is where the layout work is aimed.
- **the rail icon on the desktop shell** — the same page in an iframe, discoverable, no
  separate route to rot.

So: **add the manifest entry, and write the page as a standalone document.** Both former
recommendations, and no conflict between them.

Three consequences a coder must not miss:

1. **The page owns its entire `<head>`.** It is a top-level document, not a fragment. It needs
   its own `<meta name="viewport">` (with `viewport-fit=cover` — see below), its own font
   `@font-face`, its own token block, and its own CSP built in its own generator. It inherits
   nothing from `shell.html`.
2. **Design for the bare URL, not the iframe.** Inside the shell the rail eats horizontal
   space and there is an extra scroll container; at 390px that is not the surface being
   designed. The one-screen requirement (Verification: *One screen, measured*) is a claim
   about `GET /command`.
3. **`placement: 'bottom'` does not exist.** The manifest entry fields are
   `group: 'primary' | 'cold'`, `railHidden`, and `presentation: 'panel' | 'modal'`
   (`headlessPanelHtml.ts`, `PanelManifestEntry`); `setup` uses `group: 'cold'` with
   `railHidden: true`, not a `placement`. Use `group: 'cold'` to keep it out of the primary
   rail group. Do **not** set `railHidden: true` — that is what makes a route undiscoverable,
   which was the objection in the first place.

### Standalone-only, and that is not a divergence

`serveStatic` — the option carrying `getPanelsManifest` and `getPanelHtml` — is wired in
exactly one composition root, `bootstrap.ts:3466`. The extension's `LocalApiServer`
(`TaskViewerProvider.ts:3788`) passes none, and every serving handler 503s without it. So this
route is reachable from the standalone/npx host only. Per `CLAUDE.md` the audit that matters is
the seams each root *wires*: this plan adds no new seam and changes no wiring, it adds a case
to a shared module that the already-wired root already calls. **There is nothing to mirror in
`extension.ts`, and adding a wiring there would be net-new scope, not parity.** Say so
explicitly rather than leaving the next reviewer to re-derive it.

## Complexity Audit

### Routine

- A manifest entry in `getPanelsManifest()` and a case in `getPanelHtmlById()`.
- A single-column page of stacked full-width buttons and a plan `<select>`, in the existing
  industrial-UI token set (`--accent-primary`, `--panel-bg`, Hanken Grotesk) so it does not
  read as a different product.
- `fetch()` calls against four existing routes, with the bearer token the board already holds.

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

- **None blocking.** The former soft prerequisite on the answer-back plan existed solely
  because of the terminal-messaging control, which is no longer in scope. Every function is
  now backed by a shipped HTTP route, so this route is independently buildable.
- **Sibling, not a prerequisite:** `board-commands-in-the-switchboard-cli.md`. Both are
  front-ends over the same HTTP routes, and neither blocks the other. They are **not** meant to
  reach parity: the CLI is heading for the full Switchboard interface, this route for a small
  thumb-friendly subset. A control added to the CLI is not an argument for adding it here.
- **Not a prerequisite:** the tailnet access plan, which no longer exists — `switchboard
  tailnet` ships the bind policy and reachability is solved. This route is testable today from
  a phone against the running `switchboard tailnet`, and over an SSH tunnel from a laptop
  browser resized to 390px.
- **Independent of** the verb-bridging question. Every target function is an existing HTTP
  route.

### Shared surface with the sibling subtask

*The board is reachable only by typing a tailnet address* (`board-installs-to-the-home-screen-as-a-standalone-app.md`)
is the other subtask of this feature. **Neither blocks the other** — both are buildable and
shippable in either order — but they meet on three surfaces, and each is a "whoever lands
second finishes the job" obligation. Recording them here so the second coder does not have to
find them:

1. **The CSP, and it is not two copies.** That plan says `manifest-src 'self'` must be added
   "in both places" — `headlessPanelHtml.ts:162` and the `<meta http-equiv>` in
   `shell.html:17`. This plan adds a **third**: `getCommandHtml` builds its own policy string,
   as all thirteen generators in that file do. The phone install points at `/command`, so this
   page's policy is the one that decides whether a phone install works at all. If that subtask
   landed first, add the directive here; if this one landed first, that subtask's mechanical
   CSP assertion must be written over the *set* of shell-class policies, not two named sites.
2. **`viewport-fit=cover`.** That subtask adds it to `shell.html`'s viewport meta. This page
   has its own `<head>` and inherits nothing, so it needs its own. `env(safe-area-inset-*)`
   resolves to `0px` without it, which makes the safe-area requirement both plans carry into
   dead CSS that reads as implemented. Two pages, two metas, one rule.
3. **`start_url`.** That subtask ships one manifest at `start_url: /`, which lands on the
   desktop board — a surface that is *inert* on a phone (no width breakpoint anywhere, and
   card moves are HTML5 drag-and-drop, which does not fire on touch). Full-screen does not fix
   an unusable surface. **Resolution, agreed across both plans: one manifest at `/`, and the
   phone reaches `/command` by a tap on the rail** — which the manifest entry above already
   provides. Do not add a second manifest or a second installed icon speculatively; the option
   stays cheap precisely because that plan stayed static.

## Adversarial Synthesis

Key risks: (1) building the page as "the sidebar minus some buttons", which silently regains
the PAT field and repo scaffolding the next time the sidebar grows; (2) a dropped mobile
connection turning one tap into two dispatches, since `/kanban/dispatch` both advances a column
and fires an agent; (3) shipping one stretched column and calling the tablet done, which the
tablet layout is explicitly not; (4) **building from the layout study rather than the prose** —
it is the oldest artifact in this document, it is a picture, and its Mission block and status
strip are both superseded. Mitigations: build the control set as an explicit allowlist and
assert it in a test; disable each control until it has a definite answer, and confirm
`POST /kanban/dispatch` is safe to retry before relying on it; assert a non-`prefers-reduced-motion`
width breakpoint mechanically rather than trusting the eye; and read the superseded callout
above the study before drawing a single control from it.

## Proposed Changes

1. **Manifest and route.** Add a `command` entry to `getPanelsManifest()` and a case to
   `getPanelHtmlById()` in `src/services/headlessPanelHtml.ts`, with its own `getCommandHtml`
   generator following the existing per-request CSP-nonce pattern.
2. **The page.** Own minimal shell, existing design tokens, a **workspace-and-project selector in the header**
   scoping every view, and **four views behind a sub-nav**
   — Dispatch, Move, Mission, Teams — one visible at a time. The nav sits along the bottom on a phone
   (a nav pressed often belongs under the thumb) and becomes a left rail on a tablet. There are
   no board statistics anywhere: the strip that would have carried per-column counts carries the
   nav instead. **Every view fits its screen exactly**; the starred list absorbs the slack and is
   the only element permitted to scroll, so the action button never moves. An explicit allowlist
   of controls:
   - Plan `<select>` + **DISPATCH** → `POST /kanban/dispatch`
   - **NEW MISSION** (member picker only, no name field) → `POST /kanban/mission/create`,
     `/member/add`. The name is **not typed**: omit `name` from the body and
     `createMission` assigns a collision-checked codename via `_uniqueCodename`
     (`KanbanDatabase.ts:11537`) — the same path the board's own new-mission button takes
     (`KanbanProvider.ts:10083`, which passes `workspaceId` and nothing else). Renaming, if
     wanted, happens at the desk.
   - **LAUNCH** → dispatches the mission card (`POST /kanban/queue/next`, the path
     `launchMission` itself uses). Replaced by a progress display while the mission is in
     flight. No arm, ready or confirm control. See *Mission: launch it, or watch it run*.
   - **COLUMN SELECT** (card picker + column `<select>` + MOVE) → `POST /kanban/move`.
     Its list is the chosen column's cards, with a star toggle filtering to starred; the
     selection **never auto-advances**. See *The list is the column's cards*.
     The tap-only equivalent of dropping a card on a column, and the only route to a
     *backward* move on a touch device — the board's backward path
     (`kanban.html:10475` → `moveCardBackwards`) is reachable only from a drop event,
     and HTML5 drag does not fire on touch. Moves only; never dispatches.
   - **TEAMS** (nav destination) → the team roster from `terminals.groups`, and on tap the
     head's terminal **read-only**: output and scrollback, no input line. On the tablet, team
     icons additionally sit in the left rail. See *Teams: the fifth function*.
   - **VIEW** → a read-only markdown preview of the selected card's plan or feature file,
     rendered in the project panel's preview idiom (`#kanban-preview-content` /
     `#features-preview-content`) but carrying **none of that panel's controls** — no edit mode,
     no metadata bar buttons, no save. A header with a Back button and the file path, a scrolling
     body, nothing else. It covers the view pane only: on the tablet the nav rail stays visible
     and usable behind it.
   - Read-only status: **none**. Per-column counts are not actionable and were cut; the only
     state shown is per-control (the chip) and the mission's armed state.
3. **Tap-target pass.** 44px minimum on every control, with the vertical rhythm re-tuned
   rather than the type merely enlarged.
3c. **The page's own `<head>`, and three things in it that are easy to omit.** This is a
   top-level document (see *The serving model*), so none of these is inherited:
   - `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">`.
     **The `viewport-fit=cover` is load-bearing, not decoration:** under the default
     `viewport-fit: auto`, `env(safe-area-inset-*)` resolves to `0px`, so the safe-area
     padding this plan requires is dead CSS that still reads as implemented. No page in
     `src/webview/` carries it today — all eleven viewport metas are the plain
     `width=device-width, initial-scale=1.0`.
   - `manifest-src 'self'` in this page's CSP, and the PWA head tags (`<link rel="manifest">`,
     `<link rel="apple-touch-icon">`, `apple-mobile-web-app-capable`,
     `apple-mobile-web-app-status-bar-style`) **if the sibling subtask has already landed** —
     see *Shared surface with the sibling subtask* under Dependencies. A phone install points
     at this route, not at `/`, and a page whose CSP omits `manifest-src` silently declines to
     install as an app with the only evidence in the console.
   - The `@font-face` for Hanken Grotesk (`/static/designs/HankenGrotesk-Variable.woff2`) and
     the token block. "Branded" fails at the first paint if the font never loads.
3a. **Two real layouts**, phone-portrait and tablet-landscape, at genuine breakpoints — not
   one column allowed to stretch. Thumb-zone control placement on the phone; a two-pane or
   grid arrangement on the tablet. Branded to the existing token set.
3b. **Optimistic update layer**: ledger, window, guaranteed reconciliation, applied per
   operation per the contract above.
4. **Explicitly absent:** onboarding, PAT entry, repo scaffolding, terminal grids, agent
   deregistration, plan deletion, setup, memo capture, and any xterm surface.
5. **Failure states.** Per-control "not sent" / "sent, outcome unknown" / "confirmed",
   distinct from empty — and distinct from the optimistic "applied, awaiting confirmation"
   state, which is a fourth thing and the most common one.

### Migration

None — a new route and page. No shipped state, file, setting or format changes, and
`implementation.html` is untouched so the extension sidebar cannot regress.

## Verification Plan

Renumbered 2026-08-31. The previous sequence ran `1,2,3,4,5,6,5a,6a,7,8,7b,7a,7d,7c,8a,9,10,11`
— every section appended that day inserted a suffixed item next to a thematically related one,
so the list had four separate places where "the next item" was not the next number. No item was
dropped or reworded in the renumber; grouping is by what is being verified.

### Automated Tests

Mechanical assertions, in the order they are cheapest to run. Items 1-5 are greppable or
unit-testable against the served HTML and need no device.

1. **No text input, asserted mechanically.** Grep the served `/command` HTML for `<textarea`,
   `<input` and `contenteditable` and assert **zero** matches. This is a served-HTML assertion,
   not a visual check, so it holds against a later well-meaning addition. A visual check would
   pass a field that is merely hard to reach.
2. **Allowlist holds.** Grep the served page for `password`, `PAT`, `scaffold`, `airlock`,
   `deregister`, `delete` and `memo` and assert none are reachable. Add a test asserting the
   control set itself, so a later sidebar addition cannot leak in — the control set is an
   allowlist, and a subtraction list silently regains whatever the sidebar grows.
3. **The terminal view carries no write path.** Assert the served Teams pane contains no
   `<input>`, no send control, and no key handler bound to the pty.
4. **The document view is read-only.** Assert the served VIEW pane contains no control that
   writes — no edit toggle, no save, no metadata-bar buttons.
5. **The page's own head is complete.** Assert the served `/command` document contains
   `viewport-fit=cover` in its viewport meta (without it the safe-area padding in item 14 is
   dead CSS that still reads as implemented), a `@font-face` for Hanken Grotesk, and — once the
   sibling PWA subtask has landed — `manifest-src` in its CSP.
6. **Guards unchanged.** Re-run `loopback-hostname-contract` and confirm a non-loopback peer
   and a non-loopback `Host` still 403. This plan must be exposure-neutral: it adds a page, it
   does not change the bind address, the peer check, the Host guard or the CLI hostname
   validation.
7. **Desktop unregressed.** Confirm `implementation.html` is byte-identical in behaviour in the
   extension sidebar, and that the new manifest entry displaces no existing panel — operators
   navigate the rail by muscle memory.

### Functional — each function at its effect, not its response code

8. **Dispatch.** A card actually advances **and** its agent fires. A 200 is not the assertion.
9. **Move, and move only.** Move a card from a late column to an earlier one and confirm it
   lands and stays there after a board refresh. Then confirm **no agent was dispatched** —
   `/kanban/move` and `/kanban/dispatch` are separate routes and the column control must never
   reach the second. Verify against the board's own classification
   (`kanban.html:10470-10475`), which routes forward moves through
   `triggerAction`/`triggerBatchAction` and backward moves through `moveCardBackwards` with no
   dispatch. This is the only route to a backward move on a touch device, since the board's
   backward path is reachable only from a drop event and HTML5 drag does not fire on touch.
10. **Build a mission.** A mission exists on the board with the members chosen, and with a
    server-assigned codename — assert no name was typed and none was sent.
11. **Launch, then progress.** Launch a mission and assert its members dispatch through
    `/kanban/queue/next`. Assert the LAUNCH control is **absent** while the mission is in
    flight, and that the view then reports per-member state. Assert **no control on this
    surface writes `ready`, calls `/mission-control/start`, or calls `/confirm`** — those seat
    and arm the Mission Control persona, which is not what this view does.
12. **Seating, holding and locking.** Assert an unseated declared team renders with the dormant
    treatment and that tapping it **seats** rather than opening a terminal. Assert a team held
    by a mission renders in the held state and that no dispatch control targets it. Launch a
    mission and assert Dispatch and Move are disabled with the banner shown, then assert the
    lock lifts when the mission stops.
13. **The roster is project-scoped.** Write a project-tier `terminals.groups` for one project,
    select it, and assert both the phone Teams view and the tablet rail re-resolve to that
    roster; select another project and assert they fall back to the workspace tier. Assert the
    control is a single selector carrying both workspace and project, as
    `#workspace-project-select` does. `project_config` has zero rows today, so every project
    currently resolves to the same workspace roster — **this test must not be written against
    that coincidence.** Write the project-tier row, then assert.
14. **The picker does not move underfoot.** Move a card, then without touching the card selector
    tap MOVE a second time. Assert the same card is still selected, is still in the list, and
    that the second tap did not move a different card. Then assert the moved card's option label
    shows its new column and has risen to the top of the list.
15. **VIEW returns you where you were.** Open VIEW on both a plan and a feature; assert Back
    returns to the exact list position and selection.

### Resilience and capability

16. **Dropped connection.** Kill the link mid-dispatch. Assert the control shows "outcome
    unknown" — not success, not failure — and that retrying does not double-dispatch.
17. **Snappy, measured.** Every control shows its effect in under 100 ms from tap, on a
    throttled connection, independent of when the request resolves. Then kill the link
    mid-operation and confirm the state goes visibly pending and **never silently reverts**.
18. **Capability gating.** Serve the route on a host without `node-pty` and confirm the
    controls state their preconditions rather than 503-ing on tap. `/kanban/move` returns 503
    when `moveCard` is unavailable (`LocalApiServer.ts:3727`), so the column control has a real
    precondition to surface. The manifest is fail-closed on `terminals`
    (`availability?.terminals === true`), which is the precedent to follow.

### On real devices

19. **Real phone, real tunnel.** Reach `/command` from a phone browser — over the running
    `switchboard tailnet`, or an SSH client holding a local forward. Every control operable
    one-handed, no horizontal scroll, no pinch-to-read.
20. **Both form factors, on real devices.** A phone held vertically and an iPad in landscape on
    a desk. **Neither may look like the other's layout stretched or squeezed.** Check the phone
    one-handed with only a thumb. The on-screen keyboard is not part of this test — if anything
    raises it, that is the failure (see item 1).
21. **One screen, measured.** On both devices and in both orientations, assert the surface's own
    scroll height never exceeds its viewport — only the list scrolls. Assert the action button
    is reachable without scrolling in every view. **Measure this against `GET /command`
    directly, not against the route mounted in the desktop shell's iframe** — inside the shell
    the rail eats horizontal space and adds a scroll container, which is not the surface being
    designed.
22. **Safe areas and orientation.** Portrait and landscape on the tablet, and the phone's notch
    and home indicator. Nothing hidden, no orientation lock. If item 5's `viewport-fit=cover`
    assertion is failing, this test cannot pass and its result is meaningless — fix item 5
    first.
23. **The keyboard never raises.** On both devices, tap every control in turn and confirm the
    on-screen keyboard never appears once.

### Goal Invariants

The Goal is additive — a new surface — so these are positive assertions, with negatives paired
to the three things the Goal explicitly forbids (text input, terminal writes, board redesign).

- `getPanelsManifest()` returns an entry with `id: 'command'`, `route: '/command'`,
  `group: 'cold'`, and **not** `railHidden: true` — an unlisted route is undiscoverable and
  was rejected.
- `getPanelHtmlById('command', …)` returns a non-null `PanelHtmlResult`, and `GET /command`
  returns HTTP 200 with `Content-Type: text/html` and a non-empty CSP header.
- The served document contains exactly **four** sub-nav destinations — Dispatch, Move, Mission,
  Teams — and no fifth. VIEW is an overlay and must not appear as a nav destination.
- **Negative, paired:** the served `/command` HTML contains zero `<input`, `<textarea` and
  `contenteditable` occurrences, **and** all five functions are still driveable end-to-end
  (items 8-12 pass). The negative alone passes on a page with no controls at all.
- **Negative, paired:** no control on `/command` posts to `/mission-control/start`,
  `/mission-control/confirm`, or writes `ready`, **and** `POST /kanban/queue/next` is reached
  by the LAUNCH control. Absence of the wrong endpoints is only correct alongside presence of
  the right one.
- **Negative, paired:** the Teams pane binds no input to the pty, **and** the head's output
  streams and scrollback renders. A pane that shows nothing also has no write path.
- **Negative, paired:** `src/webview/kanban.html` and `src/webview/implementation.html` are
  unmodified by this plan — this is a new surface, not a redesign of an existing one — **and**
  `/command` exists and serves. Touching neither file is only correct if something new shipped.
- At least two width breakpoints exist in the command page's CSS that are **not**
  `prefers-reduced-motion`. The Problem Analysis' central finding is that no such breakpoint
  exists anywhere in `src/webview/*.html`; shipping without one means the phone layout was
  stretched, which item 20 exists to catch by eye and this catches mechanically.

## Snappy: the optimistic-update contract (2026-08-31)

**Every control applies its effect immediately and reconciles afterwards.** A tap that waits
on a mobile round-trip before showing anything feels broken, and this surface exists to be
faster than the alternatives, not merely smaller than them.

**Reuse the board's shape, not its code.** `kanban.html` already solves this and the shape is
proven: apply the change to the DOM at once; record the intent in a ledger
(`pendingOptimisticMoves`, `:6295`); open a window during which contradicting state is
suppressed (`OPTIMISTIC_MOVE_WINDOW_MS`, `:6291`); and **guarantee reconciliation when the
window closes** (`armOptimisticGuard`'s expiry timer re-issues a refresh if a render was
withheld). The fourth step is the one that matters — without it a failed operation stays on
screen looking successful forever.

**Three things differ here and must not be copied blind:**

1. **There is no push channel.** The board holds a WebSocket, so its guard exists to defend
   against *pushed* state arriving stale — `KanbanProvider.ts:11217` records the bug it was
   built for: "the stale full-board updateBoard here is what bounced the card back". This
   route uses `fetch()`, so nothing can bounce it back, and equally nothing confirms
   independently. Reconciliation is a re-fetch, not a suppressed push.
2. **2000 ms is a loopback number.** It is commented as covering the "backend
   persist/dispatch round-trip" on a local socket. A phone on cellular can take many seconds
   or never answer. A window tuned for a desk will expire and silently revert a change the
   operator already walked away from. Size it for the worst link, and prefer leaving a state
   visibly *pending* over reverting it.
3. **Optimism must be applied per operation, not uniformly:**
   - **Column moves — fully optimistic.** `POST /kanban/move` is idempotent in effect: moving
     to column X twice lands in column X. Being wrong is cheap; reconciling is cheap.
   - **Dispatch — optimistic about the move, never about the agent.** One tap has two
     outcomes. The card may move instantly; whether an agent actually started must be
     *reported*, never assumed. A confident success indicator on a dispatch that failed is a
     lie about whether work is running, which is the one failure that costs real time.
   - **Mission arm — never optimistic.** `/mission-control/start` does not arm;
     `/mission-control/confirm` does. The plan already requires the reached state be
     reported. Optimism here would manufacture exactly the "looks armed, armed nothing"
     failure the two-step exists to prevent.

**Idempotency is the prerequisite, not a nicety.** The board tolerates a loose window because
duplicate moves are harmless. Dispatch is not: it advances a column *and* fires an agent, so
a retry over a flaky link double-dispatches. Either `/kanban/dispatch` is made idempotent per
(card, column), or the control locks until it has a definite answer. This is the unresolved
choice already flagged in the Edge-Case audit; the optimistic design forces it.

**One known trap, from the board's own open bug.**
`feature_plan_20260706085727_autocode-column-optimistic-move-lag.md` records that the board's
optimistic move **fails silently when the target column is collapsed** — the DOM update has
nowhere to land. The analogue here looked sharper: if the list were filtered, an optimistically
moved card would have to *leave* the visible list, and a card that silently vanishes reads as a
bug even when the operation succeeded. **Resolved by keeping the acted-on card in place** —
see *The list is the column's cards* below. A card that was just acted on stays selected
and visible even when it no longer matches the filter; the list re-filters only when the operator
changes the filter.

## Mission: launch it, or watch it run (2026-08-31)

**The Mission view does two things: launch a mission, and show the progress of one already
underway. It has no arm, ready or confirm control.** Arming is a board and agent concern — a
mission's `ready` flag exists so the scheduler's *start a ready mission* action can pick it up,
which is a desk decision about automation, not something an operator reaches for in a corridor.

**Launch is dispatch.** `launchMission` (`KanbanProvider.ts:14864`) fans out through
`dispatchNextFromQueue` — its docblock: *"the SAME path `POST /kanban/queue/next` and the Run
queue button use"*. Members are already in STAGING with a `queue_position`, since staging is what
created the mission, so launching is dispatching the mission card. It is idempotent by
derivation, not by a stored flag: a mission with a member held (`dispatchedAt` set,
`completedAt` null) is in flight and refuses a second launch.

**A launched mission locks the surface.** While a mission is in flight, Dispatch and Move are
disabled behind a banner naming the mission and saying where to stop it. This is not a UI
preference: the mission's teams are in flight, and a manual dispatch at one is refused by the
server anyway. Locking makes the refusal visible before the tap rather than after it, which
matters most on the surface with the least room to explain an error. The lock lifts when the
mission is stopped — stopping is a board action, not one this surface carries.

**The two states are exclusive, and the control changes with them.**

- **Not started** — members listed as staged, one **LAUNCH** button.
- **Underway** — the button is *gone*, replaced by progress: each member's state (complete /
  which seat holds it / staged), and a line saying how long it has been running and how far it
  has got. A launch control on an in-flight mission is a button whose only outcome is an error.

**Missions never appear in the Dispatch or Move lists.** They have their own view. A mission is
not a card those lists are about, and mixing them would put two different kinds of thing behind
one picker — the exact confusion this view exists to avoid. Structurally this is already true:
`updateBoard` carries `missions` as a collection separate from `cards`
(`KanbanProvider.ts:1400`), so the lists exclude them by construction rather than by filtering.

> **Superseded (2026-08-31):** an earlier revision specced "start a mission" as
> `POST /mission-control/start` then `/confirm`, drawn as a two-step Start → Arm ladder with
> "arm cannot be skipped" as a headline rule. Those endpoints seat and arm the **Mission Control
> persona** (`LocalApiServer.ts:6216`), which is automation-wide and unrelated to any particular
> mission. A later revision replaced the ladder with a "mark ready" flag, which was closer but
> still wrong for this surface: readiness is a scheduling declaration, not an away-from-desk
> action. The function is **launch**, and the state to show is **progress**.

## Scope: one selector, as the board already has (2026-08-31)

**One control in the header scopes the whole surface: a workspace-and-project selector.** It is
the board's own control — `#workspace-project-select` (`kanban.html:2889`), tooltipped *"Select
workspace and project"*, whose every `<option>` carries `dataset.workspaceRoot`, so one choice
sets both. This surface copies that rather than inventing its own arrangement, and it applies to
every view instead of sitting beside a column select.

**The roster follows it.** `terminals.groups` is read through `_getScopedSetting`
(`KanbanProvider.ts:823`), which is two-tier: the **project** tier
(`getProjectConfigJsonSync`) first when a specific project is selected, then the **workspace**
tier. So changing the selector must re-resolve the team roster on both frames — the phone's
Teams view and the tablet's rail. Today no project overrides it (`project_config` has zero
rows), so every project resolves to the same workspace roster; **do not encode that as an
assumption** — a surface that reads `terminals.groups` once at load is correct only until
someone uses a capability that already exists.

> **Superseded (2026-08-31):** two revisions of this section were wrong before this one.
> The first argued for a *workspace* picker rendered conditionally on `/health` reporting more
> than one root, on the grounds that "standalone is single-root" — that read the extension's
> multi-root support as VS Code workspaces, when a workspace is a control-plane root and
> `bootstrap.ts`'s "single-root" means one KanbanDatabase, which is exactly what a control plane
> has. The second replaced it with **two** dropdowns, repo and project.
> **Reason it was wrong:** the board pairs workspace and project in a single control, and
> nothing else in the product asks for two. Repo scope (`_repoScopeFilter`) is a real backend
> filter, but it is not a control this surface needs to carry — a control plane's teams work
> across its repos, and the operator picks work by project.

**Worktrees are not a filter.** There are 17 in this workspace, and a worktree is *where a team
is working*, not a way anyone picks a card. It belongs on a running team as context — "Coding ·
wt-terminal-creation".

## Teams: the fifth function (2026-08-31)

**The operator's most frequent question is "what are the agents doing", and today it is answered
by asking an agent to describe the terminals.** That is a status report filtered through a
model — slower than looking, and capable of being wrong. The surface should answer it directly.

**A fourth nav destination, Teams.** It lists the terminal groups with `teamGroup: true` from the
`terminals.groups` config (`workContextResolver.resolveTeamGroupForTerminal` is the reader), each
row showing the team's icon, its name, its seat count and whether it is working or idle. **Tapping
a team opens its head's terminal, read-only** — the head is the group's `head` field, not a
role guess, since a team can seat several leads.

On the tablet the same teams also appear as icons in the **left rail** beneath the nav, so a
running team is one tap away from any view. `GET /terminals/icon-palette` already serves the icon
set the strip uses; this reuses it rather than inventing a second vocabulary.

**Read-only is the whole point, and it does not breach the no-input rule.** The pane shows output
and scrollback and has no input line, no send field, and no key handling — the keyboard still
never opens. Output already streams over the gateway that backs the browser terminals panel
(`/ws/terminal`, with the scrollback ring in `terminalWsGateway.ts`), so this is a second reader
on a shipped transport, not a new one.

**Every declared team appears, seated or not.** A team that has not been started shows a
**dimmed** jet — the rail's `.strip-icon.is-dormant` treatment — and **tapping it seats the
team**, exactly as the rail's fixed team slots do (`shell-rail-fixed-team-slots.md`: slots are
present whether or not started, and a failed start leaves the slot dim rather than disabling
it). Only a seated team has a lead terminal to open, so tap means *seat* on a dormant row and
*open* on a live one.

**A team a mission holds gets its own state: `Held by mission`, in amber.** It is not idle and
it is not manually dispatchable — `KanbanProvider.ts:12866` refuses with *"Team already in
flight — a seat still holds a card with no completion post"*. Showing it as idle would invite a
dispatch the server is going to reject.

**The roster carries these facts and no more: name, state, seat count.** Anything
finer — what the team is actually doing, which seat has what, how much is banked behind the
current task — is what tapping the team is *for*. A roster that answered those questions would
be a second, worse status display competing with the terminal one tap away.

Queue depth was tried here and cut (2026-08-31). `TeamQueueService`'s per-team file queue is a
real mechanism, but it is a **dispatch** path rather than a schedule or a team property, it sits
awkwardly beside missions — `retire-autoban-and-batch-size.md` established that *missions are
the dispatch primitive* — and a bare violet number on a phone explains none of that. Whether
the team queue folds into missions or is retired is its own question, not this surface's.

**Teams is phone-only as a nav destination.** The tablet reaches teams through the rail icons,
which is the strip idiom the shell already uses; putting a Teams tab beside the rail would be
the same surface twice. The rail entries carry the same three facts as the phone roster.

Two things this must not become:

- **Not the Terminals panel.** No grid, no resize, no tabs, no per-seat switching beyond picking
  a team. One team, one head, its output.
- **Not a write path.** The moment a send field appears here, the surface has a keyboard again and
  the rule that shaped every other control is gone. A team that needs telling something is told
  from the desk or the CLI.

## The list is the column's cards; star is a filter over them (2026-08-31)

Starring already exists and is already how the board marks what matters: `priority_starred` on
`plans`, written by `PUT /kanban/plans/priority`, and `kanbanOrdering.ts:72-80` sorts starred
first on the board. This surface reuses it rather than inventing a scoping rule.

**The list shows the chosen column's cards. A star toggle beside the column `<select>` narrows
that list to starred cards; it is off by default and one tap reverses it.** Starred cards sort
first either way, matching the board, so the shortlist is at the top even unfiltered. Nothing
else scopes the list — no search, no recency window, no separate feature/plan modes. One list,
two switches.

- **Features and plans sit in one list.** A feature dispatches as a whole — `POST /kanban/dispatch`
  takes the card ref and the head delegates subtasks itself (`LocalApiServer.ts:2000-2016`). No
  extra control, no per-subtask picker, no new mechanic.
- **The list stays open** rather than collapsing into a closed dropdown. On this surface the
  shortlist is the thing you came to look at, not a value you set once.
- **Each row carries the two facts you weigh before dispatching**: the card's **complexity**, as
  the project panel's coloured dot with its number inside (same bands as
  `_complexityToCssClass` — ≤2 very-low, ≤4 low, ≤6 medium, ≤8 high, else very-high), and for a
  feature its **subtask count**. A plan shows no count, so the count's presence is itself the
  feature/plan signal that the kind tag confirms.
- **The selection never auto-advances.** A card that has just been acted on stays selected and
  stays visible, even if it no longer matches the column filter. A picker that silently re-points
  at a different card between two taps means the second tap dispatches the wrong card. The list
  re-filters when *you* change the filter — never underfoot.

On the board today: 24 starred cards, 14 of them features, across `Reviewed` (11 features,
9 plans), `Coder` (2), `Planned` (1) and `New` (1). Starring is therefore a useful *narrowing*
of a column, not a replacement for it — a starred-only list would hide most of what is
dispatchable, which is why the filter is off by default.

## Branded, and good in two form factors (2026-08-31)

**This is not a phone page that tolerates a tablet.** It must look deliberate on a phone held
vertically **and** on an iPad sitting in landscape on a desk. Those are roughly 390px and
1180px, and they are ergonomically opposite: one is held one-handed at arm's length with a
thumb as the only pointer; the other is two-handed, further away, and wide.

**Consequence: a single stacked column is the phone layout, not the design.** Stretched to
landscape it is a thin ribbon adrift in empty space, and full-width buttons at 1180px are
absurd. The tablet layout is a genuinely different arrangement — a two-pane split (list on
one side, actions on the other) or a grid — reached by real breakpoints, not by letting a
narrow column grow. This is the single largest piece of design work in the plan and it is
why the original "borrow the ~320-400px sidebar idiom" framing is now insufficient: the
sidebar idiom is the phone half of the answer only.

**Thumb zone inverts between them.** On a phone the primary controls belong in the lower
half, where a thumb reaches without re-gripping; the top of a tall phone is the worst place
for the most-used button. On a desk tablet that concern evaporates and top-anchored reads
better. The two layouts should not fight over one control order.

**Branded means it reads as Switchboard.** The existing industrial token set —
`--accent-primary`, `--panel-bg`, Hanken Grotesk — is the baseline, not the ceiling. The
failure to avoid is a generic admin panel that happens to share a colour: this is the surface
the product is judged by when someone sees it on a phone, and it should look like the board's
sibling.

**The on-screen keyboard never appears, and that is the point.** On an iPad in landscape it
occupies roughly half the screen, and on a phone it buries the bottom third — the exact zone
this layout puts its primary controls in. Both problems are designed out rather than worked
around: there is no text input on the route, so nothing raises the keyboard. Any layout work
that starts reasoning about keyboard-safe placement has smuggled a field back in.

**Also required in both:** 44px minimum targets (already in the Complexity Audit), safe-area
insets for notch and home indicator on the phone, and both orientations working on the
tablet rather than an orientation lock.

### Layout study (2026-08-31)

An interactive mock-up of both layouts, drawn in the product's own tokens (`#0d0d0d` ground,
`#00e5ff` accent, Hanken Grotesk, Menlo for counted values) with real column labels and real
plan titles from `kanban.db`:

**https://claude.ai/code/artifact/44b46992-52fa-46e6-a207-20b535f95fee**

It is a design reference, not a spec — where it and the prose above disagree, the prose wins.

> **Superseded:** the study's Mission block — "a single row (armed state, Start, Arm)", "the
> tablet splits Mission in two", and "Start/Arm are two buttons with two ticks so 'started, not
> armed' is a state the surface can display" — and its status strip: "three-number status
> strip", "status is three numbers on the phone and four on the tablet".
> **Reason:** both were drawn before two later revisions in this same document, and both now
> contradict it. *Mission: launch it, or watch it run* removed the Start/Arm ladder entirely —
> those endpoints seat the Mission Control persona, not a mission — leaving one LAUNCH control
> that is replaced by progress once the mission is in flight. And *Proposed Changes* §2 states
> "There are no board statistics anywhere: the strip that would have carried per-column counts
> carries the nav instead", with "Read-only status: **none**". The study is the oldest artifact
> in this file and is the one a coder is most likely to build from, because it is a picture.
> **Replaced with:** read the study for **layout, ranking and the optimistic states only**. Its
> Mission block and its status strip are stale: Mission is one LAUNCH button or a progress
> list, never Start+Arm; the strip carries the four-destination sub-nav, never counts. Where a
> pixel in the study shows a control the prose has cut, the prose wins — that is the rule
> already stated one line above, and these are the three places it actually bites.

What it settles (with the two corrections above applied):

- **Phone**: Mission, Move card, and **Dispatch last** — the bottom block, the tallest button,
  the only accented surface. Reading order and reach order are opposite on a held phone and
  reach wins. (The study draws a three-number status strip above these; per the callout that
  strip carries the four-destination sub-nav instead, and no counts. The *ordering* below it is
  what this bullet settles.)
- **Rank by area, not by accent.** The first draft gave Mission a resident member picker and
  two button rows, making it roughly twice Dispatch's height and pushing Dispatch off the
  bottom of a 780 px frame — an accented button does not outvote a block owning half the
  screen. Mission now rests as a **single row** with the member picker disclosed behind a
  `New` button, because building a mission is the rare job on a phone and should cost no
  height until it is the job. (The study draws that row as "armed state, Start, Arm"; per the
  callout above it is one LAUNCH button, or the progress list when a mission is in flight. The
  *ranking* — one row, picker disclosed — is what this bullet settles and it still holds.)
- **Tablet**: read-only rail left, controls right, **anchored top**. Not an even 2×2 — that
  grid ranked the surface wrong, giving mission handling half the control area and the
  most-used control a quarter. **Dispatch spans the left column at full height**; Move card
  and Mission share the right. Same ranking as the phone, expressed in area instead of order.
- **The no-text-input rule, in pixels**: mission members are tap-toggle chips, card and column
  are native `<select>`s (the platform's own wheel or sheet — big targets, no keyboard), and
  Start/Arm are two buttons with two ticks so "started, not armed" is a state the surface can
  display.
- **The four optimistic states** are shown live: tapping a control applies instantly, then
  settles. Dispatch settles in two stages — the card first, the agent second — because one tap
  produces two outcomes.

Deliberate choices in the study, each reversible: single dark theme (it mirrors the product).
Its status-count and split-Mission choices are superseded above and are not live options.

**Resolved since:** how the card picker behaves under a filter. The list is the chosen column's
cards with star as an optional filter; an acted-on card stays selected and visible rather than
vanishing, and the selection never auto-advances. See *The list is the column's cards*.

## Design intent — read this before changing the control set (2026-08-31)

**This screen is a touch front-end for the CLI. Nothing more.**

The loop it exists to serve is the CLI's core loop: list what is ready, pick one, tap
advance. Tapping ADVANCE here is the same operation as dispatching from the command line —
not a different capability, the same capability with a target you can hit with a thumb.

**But this route is a deliberate subset of the CLI, not a mirror of it.** The CLI
(`board-commands-in-the-switchboard-cli.md`) is intended to become the *full* Switchboard
interface — everything the board can do, driven from a terminal, for "anyone at a terminal,
not a mobile edge case". This route is the opposite constraint: the few operations worth
doing with a thumb, on a screen small enough that every added control costs the ones already
there. CLI parity is therefore **not** the test for inclusion here, and a control landing in
the CLI is not an argument for landing it here. They will diverge by design, and that
divergence is the point.

**Therefore: no terminal input on this screen. Ever.** Not a relay control, not a message
box, not a target picker, not an xterm, not a single-line send field. This has now been
stated to two separate planners and re-derived out of the plan twice, which is why it is
recorded here as intent rather than as a scope note. A terminal control on this route is not
a feature that was descoped for effort — it is a category error. A screen whose purpose is
"drive the board without a terminal" cannot contain a terminal.

The device reality backs this up: tablets drive the Terminals panel perfectly well over the
WebSocket gateway, so there is nothing for a relay control to add there; and on a phone,
where a panel genuinely is unusable, typing into a shell is not the interaction anyone wants
from a pocket.

**Consequence for the control set.** Three tests, and a control must pass all three.

1. **Is it a board operation you would want to perform away from your desk, one-handed?**
   Not "is it useful" — everything on the board is useful, which is why the CLI gets all of
   it. The question is whether it earns space on a screen where the cost of one more control
   is paid by every other control.
2. **Does it avoid a terminal entirely?** No shell, no relay, no free text aimed at an agent.
   See above — this one is absolute, not a trade-off.
3. **Can it be driven with taps and selects alone?** If it needs a keyboard, it fails. Where
   a value is genuinely required, either the server derives it (as with the mission codename)
   or the control does not ship.

A control that fails (1) belongs in the CLI. A control that fails (2) or (3) belongs
nowhere.

## Scope revision (2026-08-31)

**MESSAGE TERMINAL was removed from the control allowlist and replaced by COLUMN SELECT.**

Two reasons, from operator experience on a tablet on the tailnet:

1. **The terminal control was solving a problem that is not there.** Browser terminals are
   already usable from a touch device — input, scrollback and resize all work. The gap on
   touch is not reaching a terminal, it is moving a card, because every card move on the
   board is HTML5 drag-and-drop and those events do not fire from touch. A send-only relay
   control was the least valuable of the five functions and the only one carrying a
   dependency.

2. **It was the sole source of this plan's soft dependency.** With it gone, every remaining
   function maps to a shipped HTTP route and the plan is independently buildable.

**What this does not change.**

> **Superseded:** "This route remains phone-shaped. Tablets drive the Project panel comfortably
> … which is why the companion documentation plan covers tablets and this route covers phones."
> **Reason:** contradicted later the same day by *Branded, and good in two form factors*, which
> is explicit that the tablet is a first-class target with a genuinely different layout at a
> real breakpoint — "not a phone page that tolerates a tablet" — and by the Goal's own opening
> requirement of "two form factors: a phone held vertically, and an iPad sitting in landscape
> on a desk". Left standing, this paragraph licenses a coder to ship one stretched column and
> call the tablet out of scope, which is the single failure that section was written to
> prevent.
> **Replaced with:** the route targets **both** form factors. That the Project panel is
> serviceable on a tablet is true and is *not* a reason to skip the tablet layout here — this
> surface exists to be the fast path on both devices, and the tablet arrangement is called out
> as "the single largest piece of design work in the plan". What this scope revision actually
> settles is narrower and still stands: MESSAGE TERMINAL is out, COLUMN SELECT is in, and the
> plan lost its last soft dependency.

**One thing to settle during the work:** the Project panel's dropdown posts
`moveKanbanPlanColumn` (keyed by `planFile`), the board posts
`moveCardForward`/`moveCardBackwards` (keyed by session id), and this route will post to
`/kanban/move` (keyed by either, with root resolution). Three paths to one outcome. Confirm
they produce the same side effects — run sheets, cascade, tracker sync — or document where
they diverge, because a card moved from a phone that syncs to Linear differently from one
moved at the desk is a defect nobody will attribute correctly.

## Scope revision 2 — no text input, and MEMO is gone (2026-08-31)

**MEMO was removed from the control allowlist, and with it the last text field on the route.**

The operator's direction, verbatim in substance: memo is not the point of this surface; a
user who wants their memo has other ways to reach it. That settles it — it is not a trade
against MEMO's usefulness, and MEMO should not be reproposed here on the grounds that the
`/memo` route is already bridged and therefore cheap. Cheapness was never the objection.

**The generalised rule is the more important half.** This is a touch command surface: buttons
and dropdowns only, no text input anywhere. MEMO was the control that required sustained
typing, but the mission-name field was a second one, and it is gone too — `createMission`
already assigns a codename when `name` is omitted, which is the path the board's own
new-mission button takes, so the field bought nothing and cost the keyboard.

Three things follow, and they are recorded here so they are not re-litigated:

- **The keyboard-safe-placement problem disappears** rather than being solved. Nothing on the
  route raises a keyboard. Layout work that begins by asking where the keyboard will sit has
  reintroduced a field somewhere.
- **The admission test grew a third question** (see *Design intent* above): a control that
  cannot be driven by taps and selects alone does not ship here. Where a value is genuinely
  needed, the server derives it or the control is cut.
- **The verification is mechanical, not visual.** Served HTML must contain no `<input`,
  `<textarea` or `contenteditable`. A visual check would pass a field that is merely hard to
  reach.

## Cross-reference: a read-only board already travels without the host

*Appended after a sweep of existing plans.*

`board-anywhere-cloud-mobile-snapshot.md` publishes a self-contained, pre-rendered `board.html`
alongside `board.json`/`board.md` on the `switchboard/board` orphan branch, via
`BoardSnapshotPublisher` (which already debounces, hash-dedupes, single-flights and force-pushes on
every board mutation). It is viewable on a phone through static hosting of that branch **with the
local machine off entirely** — no tunnel, no terminator, no exposure of the host at all.

That is strictly better than this plan for *looking* at the board, and it does not compete with it:
this route exists to **act** — dispatch, build and start missions, move cards — which a
published snapshot cannot do.

**Two consequences worth carrying:**

- **Do not add board-viewing to this route's scope.** If the operator's need turns out to be mostly
  "what's the state", the snapshot answers it more cheaply and more safely, and this route's
  justification narrows to the action set. Keep the read-only status display here minimal — enough
  context to act, not a board.
- **It weakened the access plan — which has since been retired, so there is nothing left to
  weigh.**

  > **Superseded:** "`a-phone-on-the-tailnet-has-nothing-to-connect-to.md` spends guard 2's
  > protective effect against tailnet peers … The access plan is justified only by the *acting*
  > half — which is this plan. Worth re-reading that trade with the snapshot in mind before
  > committing to it."
  > **Reason:** that plan has been retired and its premise was wrong. `switchboard tailnet`
  > already ships a real bind policy (`src/standalone/cli.ts`) accepting the tailnet address, the
  > MagicDNS FQDN and its bare first label, and it is the mode the operator runs day to day.
  > There is no exposure trade left to make and no plan left to re-read; an action item pointing
  > at a deleted file is a dead end for whoever follows it.
  > **Replaced with:** reachability is solved and out of scope for this feature. The snapshot
  > remains a useful *contrast* — it delivers viewing with the host off entirely — and the first
  > bullet above (do not add board-viewing to this route's scope) is the live consequence. This
  > bullet has none.

One more finding from that plan, relevant to earlier discussion of artifact-based surfaces: "Claude
artifacts run under a strict CSP that blocks all network requests, so an artifact can never poll
`localhost` or any API." An artifact can render a snapshot; it can never be a live cockpit.

## Recommendation

**Send to Lead Coder** (Complexity 8).

**One seat, not two.** This plan covers three separable deliverables — the command route core
(Dispatch, Move, Mission, two layouts, the optimistic layer), Teams with its read-only terminal
reader, and the VIEW document preview — and by the project's own sizing rule that is a split
candidate. It was considered and **rejected**: all three are views of one page, sharing one
shell, one sub-nav, one token block, one breakpoint set and one optimistic layer. Splitting
would hand two coders two halves of a single document and make the shared shell a merge
surface, which costs more than the parallelism buys. The correct response to the size was to
fix the score — 6 → 8 — so it routes to a seat that can hold the whole page. Do not re-split it
downstream.

**Build order within the seat**, so there is always something demonstrable: (1) route, manifest
entry, page head and shell; (2) Dispatch and Move against the two layouts — this is the
loop the surface exists for and it is testable end-to-end on its own; (3) the optimistic layer
over those two; (4) Mission; (5) Teams and the rail icons; (6) VIEW. Steps 5 and 6 are the
droppable tail if the seat runs long — the surface is useful without them, and is not useful
without steps 1-3.

## Implementation Summary

Implemented the mobile touch-first command route (`/command`) backed by `src/webview/command.html` and `src/webview/command.js`. Registered the route and panel manifest entry (`command`, `group: 'cold'`) with proper CSP and head meta (`viewport-fit=cover`, Hanken Grotesk `@font-face`, `manifest-src 'self'`) across `headlessPanelHtml.ts` and `LocalApiServer.ts`. Implemented the 4 sub-nav views (Dispatch, Move, Mission, Teams), read-only terminal WebSocket output viewer, markdown document VIEW preview overlay, and optimistic updates. Removed the start-team control so dormant teams are displayed read-only with no out-of-scope verb actions. The entire touch surface strictly contains zero text inputs or contenteditable elements, respects 44px tap targets, and supports phone portrait and tablet landscape layouts at distinct media breakpoints.

