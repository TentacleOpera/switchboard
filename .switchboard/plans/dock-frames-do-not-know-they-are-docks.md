# A dock frame does not know it is a dock — inherited panel settings, late mode class, and a live channel to the shell

## Goal

Fix the three ways a `?dock=1` document behaves as though it were the full-width panel it is a copy
of: it reads the main panel's pane-scoped settings, its mode class lands after first paint so
full-panel chrome flashes, and it can post `switchPanel` to repaint the shell's main content area.
None is specific to any one dock tab; all three follow every document the dock hosts.

### Problem Analysis — how this was found

Reported from the dock's Kanban tab: *"the pane inside the dock just flashed the terminal sidebar
and then did not show any content. Looked like it was trying to show a small window into the larger
panel."*

Each clause was a different defect. One of them — the pane never choosing a board column — was
specific to the Kanban pane, which is being retired by
`agent-dock-three-tabs-agent-cli-fleet.md`. **That one is deliberately not fixed here**; the pane it
affects is going away, and the decision is recorded in Non-goals below.

The other two, plus a third found while investigating, are properties of *any* dock document.

### Defect 1 — the dock reads the main panel's pane-scoped settings

This is the "small window into the larger panel", and it is literal rather than a visual impression.

`loadLayoutSettings` restores from the shared `terminals.*` keys with no dock namespace —
`terminals.layoutMode`, `terminals.paneAssignments`, `terminals.paneModes`,
`terminals.kanbanPaneColumn`, `terminals.kanbanPaneWorkspace`, `terminals.kanbanPaneProject`
(`terminals.js:2199-2220`).

Its tail re-clamps *some* of them for dock mode (`:2224-2234`) — `currentLayout`,
`effectiveLayout`, `paneAssignments`, `paneModes` — which is why the layout comes out right. The
three pane-scoped kanban settings are restored above and **never re-clamped**, so a dock document
carries state belonging to a different pane in a different panel.

Writing is already one-way: `saveLayoutSettings` early-returns for solo and dock (`:2237`). Only the
read side leaks, which is why this has been invisible — the dock corrupts nothing, it just renders
against someone else's state.

### Defect 2 — the mode class lands after first paint

`document.body.classList.add('is-kanban')` and its solo counterpart run inside `init()`
(`terminals.js:846-850`). Every rule that hides the full-panel chrome is keyed on those classes —
`terminals.html:2137-2148` takes out the sidebar, layout toolbar, fallback banner, group tab strip
and empty state with `display: none !important`.

Until `init()` runs, the document paints as the full Terminals panel inside a frame sized for a
terminal. That is the sidebar flash.

**`is-solo` has the identical structure**, so this is not a Kanban problem — it is on the agent tab
today and will be on the CLI tab the rework adds. It was noticed on the Kanban tab only because that
pane then rendered nothing, leaving the flash as the only visible event.

### Defect 3 — a dock frame can switch the shell's main panel

`transport.js:356` posts to the parent on one condition, *am I in an iframe?*:

```js
if (PANEL_SWITCH_VERBS[verb] && window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'switchPanel', panel: PANEL_SWITCH_VERBS[verb] }, '*');
}
```

The shell obeys with `selectPanel(data.panel)` (`shell.js:1041-1045`). `isDockFrame` is never
consulted, so a document in a side pane can repaint the whole content area.
`window.__switchboardSwitchPanel` (`transport.js:441`) is the same post with no verb mapping at all.

**The codebase already knows this rule.** Both other parent-directed relays in `terminals.js` carry
dock guards, with comments explaining exactly this hazard: `postFleetStateToShell` — *"the dock's
fleet snapshot would repaint the rail with default brand icons"* (`:191-195`) — and the
`missionControlArmed` relay, `if (window.parent !== window && !isDockFrame)`, commented *"Mirrors
postFleetStateToShell's embedded + dock guards for the same reasons"* (`:1381`).

Two relays were audited for dock containment. The third lives in `transport.js`, shared
infrastructure with no notion of a dock, and nothing enumerated the parent-directed surface to check
they were all covered.

**And `switchPanel` is the only one of the shell's four message arms with no origin check**
(`:1041`, versus `:1053`, `:1059`, `:1070` which all have one), while the sender posts with `'*'`
rather than `location.origin`. The `frames.has(data.panel)` test bounds the damage to switching to a
real panel, but the arm accepts the message from any frame the page hosts.

### Root Cause

The dock was added as a third flex child of the shell reusing `/terminals` as its content rather
than introducing a new document type — a deliberate, cheap choice recorded at `shell.js:433-438`
(*"reuses `/terminals?solo=&dock=1` as its iframe src — no new terminal…"*).

The cost of that reuse is that every behaviour of the Terminals panel now has two meanings depending
on which slot the document occupies, and each one has to be individually taught the difference.
Settings scope, paint order and parent messaging were each written when there was only one slot.
Two relays were retrofitted with dock guards; nothing enumerated the rest.

### Non-goals

- **Not fixing the Kanban pane's missing column default.** The dock's kanban entry paths set
  `paneModes` without seeding `kanbanPaneColumn` — both toggle paths do (`:6549`, `:7646`), the dock
  path does not, so the column is `undefined` and nothing repairs it. That is the "no content" half
  of the report, and it is **not fixed**: `agent-dock-three-tabs-agent-cli-fleet.md` retires the pane
  entirely. Recorded here so a later reader finds the diagnosis rather than rediscovering it.
- **Not changing what the dock renders.** The `/terminals?…&dock=1` reuse stays.
- **Not removing the panel-switch bridge.** It is correct for a panel in the content area.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, bugfix, reliability, security
**Feature:** eb81e078-5849-41b0-a242-e6f718dd4ff9

## Dependencies

- **Blocks `agent-dock-three-tabs-agent-cli-fleet.md`.** All three defects follow any `?dock=1`
  document, and that plan adds a CLI tab on the same pattern. The paint flash is already on the
  agent tab, which survives. Landing the rework first ships new instances of known bugs.
- **Partly superseded, later, by `the-dock-becomes-its-own-document.md`.** Defects 1 and 2 —
  inherited panel settings and the late mode class — cannot occur in a document that has no panel
  settings and no full-panel chrome to hide. Defect 3 is **not** superseded: `transport.js` is
  shared by every panel including a future `/dock`, and the shell's missing origin check is a shell
  bug. This plan still ships first and in full — the dock document is a longer track behind a
  viewport extraction, and the guards are needed throughout.

## User Review Required

None.

**No dock affordance needs to switch the main panel.** Confirmed: a side pane changing the whole
content area is the surprise being removed, not a feature being lost. The guard is therefore
unconditional — no opt-in, no exception list.

## Complexity Audit

### Routine

- Re-clamping three arrays alongside the four already re-clamped.
- Adding an `isDockFrame` guard and an origin check.

### Complex / Risky

- **Moving the mode class earlier means moving it out of `init()`.** It must be set from
  `location.search` at document scope, before first paint, **without duplicating the parse**
  (`:203-214`). Two parsers that can disagree about dock mode is worse than the flash.
- **`is-solo` and `is-kanban` move together.** Fixing only one leaves the flash on the dock's
  most-used tab. While the Kanban pane is being retired, `is-kanban` is still live until that lands,
  and the mechanism is shared.
- **Namespacing must not orphan the main panel's settings.** The `terminals.*` keys are shipped. The
  fix is for the dock to *ignore* them, not to rename or migrate them — the main panel keeps reading
  and writing exactly as today, so no migration is involved.
- **`transport.js` has no `isDockFrame`.** It is shared by every panel and does not parse the dock
  parameter. Derive it there from `location.search`, mirroring `terminals.js:213`, rather than
  importing from the terminals panel — that way every panel the dock may ever host is covered,
  including the CLI tab.
- **`window.__switchboardSwitchPanel` is a public global** with no verb mapping. Guarding only
  `PANEL_SWITCH_VERBS` leaves the direct call open.
- **Silent failure is the wrong shape.** A dock frame requesting a panel switch should be a no-op the
  developer can see — a `console.warn` naming the dock, matching how `transport.js:346-348` already
  reports a malformed post.

## Edge-Case & Dependency Audit

- **The standalone full-page route** (`/terminals` opened directly, not iframed) must be unaffected:
  `window.parent === window`, so the bridge already no-ops. Assert it stays that way.
- **Popped-out terminal windows** (`shell.js:1074`, `window.open('/terminals?solo=…')`) have an
  `opener`, not a `parent` — a different path the new guard must not catch.
- **`linear.js:358` posts `switchPanel → tickets`** from the content area and must keep working.
  This is the regression the guard most plausibly causes.
- **`saveLayoutSettings` must stay one-way.** Its dock early-return (`:2237`) is what stops the dock
  writing back; the re-clamp must not route through a save.
- **Both hosts serve these files** — `getShellHtml` is wired in `bootstrap.ts:3474` and
  `src/services/TaskViewerProvider.ts:4198`. No new endpoint, so no composition-root work.
- **No `confirm()` in this diff**, per `CLAUDE.md`.

## Adversarial Synthesis

Key risks: duplicate `isDockFrame` parser drift between `terminals.js` and `transport.js`; origin
check semantics in sandboxed iframes (defense-in-depth, not primary fix); unguarded parent-directed
relays beyond the three known. Mitigations: cross-reference comments between parsers so a change to
one prompts a check of the other; document the origin check as secondary to the dock guard on the
sender; enumerate the full parent-directed `postMessage` surface (Proposed Change 4) to catch the
next unguarded relay.

## Proposed Changes

### 1. `terminals.js` — stop the dock inheriting pane-scoped settings

In the dock clamp (`:2228-2233`), reset `kanbanPaneColumn`, `kanbanPaneWorkspace` and
`kanbanPaneProject` to dock-local values alongside the four already re-clamped.

### 2. `terminals.js` / `terminals.html` — set the mode class before first paint

Parse the mode parameters once at document scope and apply `is-solo` / `is-kanban` there, before
`init()`. One parser, both classes.

### 3. `transport.js` + `shell.js` — dock containment

Derive `isDockFrame` in `transport.js` from `location.search` (mirroring `terminals.js:214`); guard
both `switchPanel` senders (`:358`, `:441`) and warn rather than fail silently; post with
`location.origin`. Add the missing origin check to the shell's `switchPanel` arm — this is
defense-in-depth; the dock guard on the sender is the primary fix. Add a cross-reference comment in
both parsers (`terminals.js` and `transport.js`) pointing at each other, so a change to one prompts
a check of the other.

### 4. Enumerate the parent-directed message surface

List every parent-directed `postMessage` under `src/webview/` and record whether each is dock-safe.
Two were guarded ad hoc; the list is so the next one is checked against something rather than
remembered.

## Verification Plan

### Automated Tests

1. **The dock ignores persisted pane-scoped settings.** Seed `terminals.kanbanPaneColumn` with a
   value; a `?dock=1` document does not adopt it. Pins defect 1 directly.
2. **`saveLayoutSettings` still writes nothing in dock mode** after the re-clamp change.
3. **`is-kanban` and `is-solo` are both set before first paint** — asserted on the document, not on
   `init()` having run.
4. **One parser.** Source-level: the dock/solo/kanban parameters are read in exactly one place.
   Guards the duplicate-parser risk the fix introduces.
5. **A dock document does not post `switchPanel`,** asserted twice — for the verb map and for
   `window.__switchboardSwitchPanel`. A verb-only fix leaves the global open.
6. **A non-dock panel still switches.** The regression this fix most plausibly causes.
7. **The full-page route no-ops** whether or not `dock=1` is present.
8. **All four shell message arms carry an origin check** — asserted as a property of the handler, so
   a fifth arm added without one fails.
9. **Every parent-directed `postMessage` in `src/webview/` is on the audited list** (step 4). The
   gate whose absence let a third relay ship unguarded while two carried careful comments about
   exactly this hazard.

### Goal Invariants

- A dock document reads no pane-scoped state belonging to the main panel; it renders correctly with
  dock-local defaults regardless of the main panel's persisted settings.
- No full-panel chrome (sidebar, toolbar, fallback banner, group tab strip) is visible at any point
  during dock document load; the dock form is present on first paint.
- A dock document can change nothing outside its own frame; a non-dock panel can still post
  `switchPanel` to the shell (linear.js Tickets switch works).

### Manual

- Open the dock's agent tab — no sidebar flash.
- Work the pane's normal actions; `#content` never changes behind the dock.
- Confirm `linear.js`'s Tickets switch still works from the content area.

## Implementation Summary

All four proposed changes landed. Defect 1: `loadLayoutSettings` now re-clamps `kanbanPaneColumn`, `kanbanPaneWorkspace`, and `kanbanPaneProject` to dock-local defaults when `isDockFrame` is set, so a dock document no longer renders against the main panel's pane-scoped state. Defect 2: the `is-solo` / `is-kanban` / `is-team-scoped` body class is applied at module scope (right after the single `location.search` parse), before `init()` runs, eliminating the first-paint sidebar/toolbar flash; `init()` re-applies defensively as an idempotent fallback. Defect 3: `transport.js` derives its own `isDockFrame` from `location.search` (with cross-reference comments to `terminals.js`), guards both `switchPanel` senders (`PANEL_SWITCH_VERBS` and `__switchboardSwitchPanel`) with a `console.warn` no-op, and posts with `location.origin` instead of `'*'`; `shell.js`'s `switchPanel` arm now carries the origin check the other three arms already had. Change 4: the full parent-directed `postMessage` surface is enumerated as a comment in `transport.js`, recording each relay's dock-safety status. Syntax verified via `node --check` on all three files; compilation and tests skipped per orders.


## Review Findings

Reviewed against the plan's three defects; all three land, but defect 2's fix did not
reach its Goal Invariant and was corrected. The mode class was applied at the top of
`terminals.js` — the last of seven parser-blocking scripts (~1.1 MB of xterm, the
viewport module and the panel), with `.terminals-sidebar` as the first element in
`<body>` — so the chrome could still paint unclassed and the reported flash survived;
the parse and the class now live in a nonce'd body-top script in `terminals.html`
(`src/webview/terminals.html`), which publishes `window.__SB_TERMINAL_MODE__` for
`terminals.js` to consume, keeping the plan's one-parser rule intact and reporting
loudly rather than silently defaulting if the early script did not run. Defect 1's
re-clamp and defect 3's `transport.js` guards, `location.origin` post and shell-side
origin check are all correct as written. The plan specified nine automated tests and
shipped none, so five were added to the CI-wired `shell-agent-dock` suite covering the
clamp, both `switchPanel` senders, the `linear.js` non-regression, a
classify-every-arm origin gate, and the relay audit. Files changed:
`src/webview/terminals.html`, `src/webview/terminals.js`,
`src/test/shell-agent-dock.test.js`; `test:contract:shell-agent-dock` is 40/0 (32/2 at
HEAD) and `test:contract:shell-terminal-strip` 75/0.

## Deferred Findings

- NIT `src/webview/terminals.js:216` — `?kanban=1` still parses into `isKanbanDock`, which now has no live caller anywhere in the codebase. Retiring the dock URL parameters is owned by `the-dock-becomes-its-own-document.md` (its Proposed Change 4), which has not been implemented.
- NIT `src/webview/terminals.js:1971` — `saveLayoutSettings` early-returns on `soloTerminalName || isKanbanDock` rather than `isDockFrame`. Every dock tab is currently a `?solo=` document so the guard holds, but a future `?dock=1` document without `solo=` would write the main panel's layout settings back.
- NIT `src/webview/shell.js:1603` — the `switchboardThemeChanged` shell arm deliberately carries no origin check (transport.js dispatches theme pushes as synthetic events with an empty origin). This is now recorded as an explicit exemption in the new arm-classification test rather than left as an unexplained gap.
