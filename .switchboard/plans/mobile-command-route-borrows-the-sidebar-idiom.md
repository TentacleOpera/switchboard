# A phone-shaped command route, because the sidebar already solved the layout and the board never serves it

## Goal

Serve a narrow, tap-only command surface from the standalone browser board so the four
away-from-desk functions — dispatch a plan, build a mission, start a mission, move a card to
any column — are reachable without the desktop board. It must be
**snappy, branded, and good-looking in two form factors**: a phone held vertically, and an
iPad sitting in landscape on a desk. The route does not exist.

**Buttons and dropdowns only. There is no text input on this surface — not one field,
anywhere.** This is the route's defining constraint, not a simplification of it: it is a
touch command surface for a CLI-backed board, and every control is a tap or a select. A
control that needs typing is not a control this route can carry.

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

**The functions are already reachable over HTTP, which is what makes this cheap.** All four
target functions are existing `LocalApiServer` routes on the same port the board is served
from, so they need no verb bridging:

| Function | Route |
|---|---|
| Dispatch a plan | `POST /kanban/dispatch` — documented at `:1519` as the one-call "advance a card and fire its agent" |
| Build a mission | `POST /kanban/mission/create`, `POST /kanban/mission/member/add` |
| Start a mission | `POST /mission-control/start`, then `POST /mission-control/confirm` (`:567` — "the only path that arms") |
| Move a card to any column | `POST /kanban/move` (`LocalApiServer.ts:3720`) — takes an arbitrary `targetColumn`, so forward, backward and non-adjacent are one call; resolves the workspace root by card identity; inherits the feature→subtask cascade and the Linear/ClickUp sync fan-out. Distinct from `/kanban/dispatch`: it moves without firing an agent |

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
- **No new verbs.** All four functions are existing HTTP routes. If a control needs a
  verb that does not exist, it is out of scope for this plan.
- **No text input, of any kind.** No textarea, no `<input type="text">`, no
  contenteditable, no search box. Every control is a button or a `<select>`. This is not a
  preference to be traded against a control's usefulness — a control that cannot be driven
  by tapping does not go on this surface, it goes in the CLI.
- **No terminals panel, no PTY, no xterm, and no terminal messaging.** Typing into a shell is
  not a phone interaction, and the send-only relay control this plan originally carried has been
  removed from the allowlist (2026-08-31) — see *Scope revision* below.

## Metadata

**Complexity:** 6
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
  because of the terminal-messaging control, which is no longer in scope. All four functions
  are now backed by shipped HTTP routes, so this route is independently buildable.
- **Sibling, not a prerequisite:** `board-commands-in-the-switchboard-cli.md`. Both are
  front-ends over the same HTTP routes, and neither blocks the other. They are **not** meant to
  reach parity: the CLI is heading for the full Switchboard interface, this route for a small
  thumb-friendly subset. A control added to the CLI is not an argument for adding it here.
- **Not a prerequisite:** the tailnet access plan. This route is testable today over an SSH
  tunnel from a laptop browser resized to 390px, and from a phone with an SSH client.
- **Independent of** the verb-bridging question. The four target functions are HTTP routes.

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
2. **The page.** Own minimal shell, existing design tokens, and **three views behind a sub-nav**
   — Dispatch, Move, Mission — one visible at a time. The nav sits along the bottom on a phone
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
   - **START MISSION** → `POST /mission-control/start` then `/confirm`, with the two steps
     visible and the reached state reported
   - **COLUMN SELECT** (card picker + column `<select>` + MOVE) → `POST /kanban/move`.
     Its list is the chosen column's cards, with a star toggle filtering to starred; the
     selection **never auto-advances**. See *The list is the column's cards*.
     The tap-only equivalent of dropping a card on a column, and the only route to a
     *backward* move on a touch device — the board's backward path
     (`kanban.html:10475` → `moveCardBackwards`) is reachable only from a drop event,
     and HTML5 drag does not fire on touch. Moves only; never dispatches.
   - Read-only status: **none**. Per-column counts are not actionable and were cut; the only
     state shown is per-control (the chip) and the mission's armed state.
3. **Tap-target pass.** 44px minimum on every control, with the vertical rhythm re-tuned
   rather than the type merely enlarged.
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

1. **Real phone, real tunnel.** Reach `/command` from a phone browser (SSH client holding a
   local forward, or the companion access plan once it lands). Every control operable
   one-handed, no horizontal scroll, no pinch-to-read.
2. **Each of the four functions end-to-end**, verified at the *effect* rather than the
   response: a card actually advances and its agent fires; a mission exists on the board with
   the members chosen; the mission is genuinely armed (not merely started); the card lands in the chosen column and stays there
   after a board refresh.
3. **Mission arm is not skippable.** Call start without confirm and assert the UI reports
   "started, not armed" rather than success.
4. **Backward moves work, and move only.** Move a card from a late column to an earlier one
   and confirm it lands. Then confirm no agent was dispatched by the move — `/kanban/move` and
   `/kanban/dispatch` are separate routes and the column control must never reach the second.
   Verify against the board's own classification (`kanban.html:10470-10475`), which routes
   forward moves through `triggerAction`/`triggerBatchAction` and backward moves through
   `moveCardBackwards` with no dispatch.
5. **Dropped connection.** Kill the link mid-dispatch. Assert the control shows "outcome
   unknown", not success and not failure, and that retrying does not double-dispatch.
6. **Allowlist holds.** Grep the served page for `password`, `PAT`, `scaffold`, `airlock`,
   `deregister`, `delete`, `memo` and assert none are reachable. Add a test asserting the control set,
   so a later sidebar addition cannot leak in.
5a. **The picker does not move underfoot.** Move a card, then without touching the card
   selector tap MOVE a second time. Assert the same card is still selected, is still in the
   list, and that the second tap did not move a different card. Then assert the moved card's
   option label shows its new column and has risen to the top of the list.
6a. **No text input, asserted mechanically.** Grep the served page for `<textarea`, `<input`
   and `contenteditable` and assert **zero** matches — this is a served-HTML assertion, not a
   visual check, so it holds against a later well-meaning addition. Then, on both devices,
   tap every control in turn and confirm the on-screen keyboard never raises once.
7. **Desktop unregressed.** Open the extension sidebar and confirm `implementation.html` is
   byte-identical in behaviour; confirm the new nav entry displaces no existing panel.
8. **Guards unchanged.** Re-run `loopback-hostname-contract` and confirm a non-loopback peer
   and a non-loopback Host still 403. This plan must be exposure-neutral.
8a. **One screen, measured.** On both devices and in both orientations, assert the surface's
   own scroll height never exceeds its viewport — only the list scrolls. Assert the action button
   is reachable without scrolling in every view.
9. **Snappy, measured.** Every control shows its effect in under 100 ms from tap, on a
   throttled connection, independent of when the request resolves. Then kill the link
   mid-operation and confirm the state goes visibly pending and never silently reverts.
10. **Both form factors, on real devices.** A phone held vertically and an iPad in landscape
   on a desk. Neither may look like the other's layout stretched or squeezed. Check the
   phone one-handed with only a thumb. The on-screen keyboard is not part of this test — if
   anything raises it, that is the failure (see 6a).
11. **Capability gating.** Serve the route on a host without `node-pty` and confirm the
   route's controls state their preconditions rather than 503-ing on tap. `/kanban/move`
   returns 503 when `moveCard` is unavailable (`LocalApiServer.ts:3727`), so the column
   control has a real precondition to surface.

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
What it settles:

- **Phone**: three-number status strip, then Mission, Move card, and **Dispatch last** — the
  bottom block, the tallest button, the only accented surface. Reading order and reach order
  are opposite on a held phone and reach wins.
- **Rank by area, not by accent.** The first draft gave Mission a resident member picker and
  two button rows, making it roughly twice Dispatch's height and pushing Dispatch off the
  bottom of a 780 px frame — an accented button does not outvote a block owning half the
  screen. Mission now rests as a single row (armed state, Start, Arm) with the member picker
  disclosed behind a `New` button, because building a mission is the rare job on a phone and
  should cost no height until it is the job.
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

Deliberate choices in the study, each reversible: single dark theme (it mirrors the product);
status is three numbers on the phone and four on the tablet; the tablet splits Mission in two.

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

**What this does not change.** This route remains phone-shaped. Tablets drive the Project
panel comfortably — its column badge dropdown (`project.js:1723-1790`) already performs
any-direction moves one card at a time — which is why the companion documentation plan
covers tablets and this route covers phones, where that panel is genuinely cramped.

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
- **It weakens the access plan, not this one.** `a-phone-on-the-tailnet-has-nothing-to-connect-to.md`
  spends guard 2's protective effect against tailnet peers. If viewing is the main want, that
  spend buys little, because the snapshot already delivers viewing at zero exposure. The access plan
  is justified only by the *acting* half — which is this plan. Worth re-reading that trade with the
  snapshot in mind before committing to it.

One more finding from that plan, relevant to earlier discussion of artifact-based surfaces: "Claude
artifacts run under a strict CSP that blocks all network requests, so an artifact can never poll
`localhost` or any API." An artifact can render a snapshot; it can never be a live cockpit.
