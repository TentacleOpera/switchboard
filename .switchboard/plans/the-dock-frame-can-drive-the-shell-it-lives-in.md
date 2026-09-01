# A dock iframe can switch the shell's main panel — the panel-switch bridge has no dock guard

## Goal

Stop a document rendered inside the right-hand dock from driving the shell that hosts it. The dock's
Kanban pane posts `switchPanel` to its parent, and the shell obeys — so an action taken in a
narrow side pane repaints the whole content area, most visibly as "the terminals panel keeps opening
inside the dock." Add the dock guard the two sibling relays already have, and close the origin hole
on the one message arm that lacks it.

### Problem Analysis — reported symptom

Using the dock's Kanban tab, the terminals panel repeatedly appears. It is not a one-off: it recurs
during normal use of that pane.

### Why the dock is a terminals document in the first place

`#dock-kanban-frame` is not a board iframe. `shell.js:479` sets its src to
**`/terminals?kanban=1&dock=1`** — the Terminals panel, parameterised to render one kanban pane
(`terminals.js:208-209` parses `kanban=1`; `:848-856` sets `paneModes[0] = 'kanban'`). The dock's
agent tab is the same document with `?solo=<name>&dock=1` (`shell.js:553`).

So both dock tabs are Terminals documents. Anything the Terminals panel can do to its parent, the
dock can do — and the dock's parent is the shell, not a panel.

### The mechanism: `transport.js`'s panel-switch bridge does not know about the dock

`transport.js:312-320` maps verbs to panels:

```js
const PANEL_SWITCH_VERBS = {
    openKanban: 'board',          openPlanningPanel: 'project',
    openProjectPanel: 'project',  openSetupPanel: 'setup',
    openDesignPanel: 'design',    openTicketsPanel: 'tickets',
    openConnectionsPanel: 'connections',
};
```

and `:356-358` fires on the only condition it checks — *am I in an iframe?*

```js
if (PANEL_SWITCH_VERBS[verb] && window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'switchPanel', panel: PANEL_SWITCH_VERBS[verb] }, '*');
    return;
}
```

`window.__switchboardSwitchPanel` (`:441`) is the same post with no verb mapping at all.

The shell obeys (`shell.js:1041-1045`):

```js
if (data.type === 'switchPanel' && typeof data.panel === 'string') {
    if (frames.has(data.panel)) { selectPanel(data.panel); }
}
```

**`isDockFrame` is never consulted on this path.** That is the whole defect, and the file already
knows the rule. The two other parent-directed messages in `terminals.js` both carry the guard:

- `postFleetStateToShell` — *"the dock's fleet snapshot would repaint the rail with default brand
  icons — postFleetStateToShell returns early when this flag is set (edge case 2)"*
  (`terminals.js:191-195`).
- the `missionControlArmed` relay — `if (window.parent !== window && !isDockFrame)`
  (`terminals.js:1381`), commented *"Mirrors postFleetStateToShell's embedded + dock guards for the
  same reasons."*

Two relays were audited for dock containment. The panel-switch bridge, which lives in a different
file and predates the dock, was not.

### The second hole, in the same handler

Of the four arms in the shell's message listener, three check the sender:

| Arm | Origin check |
| :--- | :--- |
| `switchPanel` | **none** (`shell.js:1041`) |
| `missionControlArmed` | `if (event.origin !== location.origin) return;` (`:1053`) |
| `terminalFleetState` | same (`:1059`) |
| `popoutTerminal` | same (`:1070`) |

And the sender posts with targetOrigin `'*'` (`transport.js:357`, `:441`), not `location.origin` as
every guarded relay uses. The `frames.has(data.panel)` check bounds the *damage* to switching to a
real panel, but the arm accepts the message from any frame the page ever hosts.

### Root Cause

The dock was added as a **third flex child** of the shell (`shell.html:490`), reusing
`/terminals` as its content rather than introducing a new document type — a deliberate,
cheap choice recorded in `shell.js:433-438` (*"reuses `/terminals?solo=&dock=1` as its iframe src —
no new terminal…"*). The cost of that reuse is that every parent-directed message the Terminals
panel can send now has two possible meanings depending on which slot the document occupies. Each
relay had to be individually taught the difference. Two were. The third lives in `transport.js`,
which is shared infrastructure with no notion of a dock, and nothing enumerated the parent-directed
message surface to check they were all covered.

### Why this outlives the Kanban pane

`agent-dock-three-tabs-agent-cli-fleet.md` retires the Kanban dock pane. **That does not fix this.**
The leak is a property of *any* `?dock=1` Terminals document, and that plan adds a CLI tab using the
same pattern. Fixing containment is therefore a prerequisite for the dock rework, not a casualty of
it — the new tab would inherit the same bridge.

### Non-goals

- **Not changing what the dock renders.** The `/terminals?...&dock=1` reuse stays.
- **Not removing the panel-switch bridge.** It is correct for a panel in the content area.
- **Not the dock tab rework.** That is the sibling plan; this is its prerequisite.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, bugfix, reliability, security

## User Review Required

- **Confirm the symptom is the main content area switching, not the dock pane itself re-rendering.**
  The mechanism above explains "the terminals panel opens" as `selectPanel('terminals')` repainting
  `#content` behind the dock. If instead the *pane inside the dock* reverts from kanban to a terminal
  grid, that is a second defect in `paneModes` resolution and step 1 below will separate them.
- **Confirm no dock affordance legitimately needs to switch the main panel.** This plan assumes
  none does: a side pane changing the whole content area is the surprise being removed. If one does,
  it needs an explicit opt-in rather than the ambient bridge.

## Complexity Audit

### Routine

- Adding an `isDockFrame` guard and an origin check.

### Complex / Risky

- **`transport.js` has no `isDockFrame`.** It is shared by every panel and does not parse the dock
  parameter. The guard must be derived there (read `dock=1` from `location.search`, mirroring
  `terminals.js:213`) rather than imported, or `transport.js` gains a dependency on the terminals
  panel. Deriving it in one place inside `transport.js` keeps every panel covered, including future
  ones the dock may host.
- **`window.__switchboardSwitchPanel` is a public global** (`:441`) with no verb mapping. It must
  carry the same guard; guarding only `PANEL_SWITCH_VERBS` leaves the direct call open.
- **Tightening the origin check must not silently break the bridge.** `transport.js` posts with
  `'*'`. Changing the shell to require same-origin while the sender still posts `'*'` is fine
  (targetOrigin constrains the *receiver*, `event.origin` reports the *sender*), but both should
  move to `location.origin` together so the pattern matches the three guarded relays exactly.
- **Silent failure is the wrong shape.** A dock frame that requests a panel switch should be a
  no-op the developer can see, not a dropped message — a `console.warn` naming the dock, matching
  how `transport.js:346-348` already reports a malformed post.

## Edge-Case & Dependency Audit

- **The standalone full-page route** (`/terminals` opened directly, not iframed) must be unaffected:
  `window.parent === window` there, so the bridge already no-ops. Assert it stays that way.
- **Popped-out terminal windows** (`shell.js:1074`, `window.open('/terminals?solo=…')`) have an
  `opener`, not a `parent` — a different path that must not be caught by the new guard.
- **A panel legitimately in the content area keeps working.** `linear.js:358` posts
  `switchPanel → tickets` and is not a dock document; it must be unaffected. This is the regression
  the fix most plausibly causes.
- **Both hosts serve `shell.html` and `transport.js`** — `getShellHtml` is wired in `bootstrap.ts`
  and `TaskViewerProvider.ts`, so the fix reaches both with no composition-root work. No new
  endpoint is added.
- **No `confirm()` anywhere in this diff**, per `CLAUDE.md`.

## Proposed Changes

### 1. Reproduce and classify first

Open the dock's Kanban tab and record which surface changes: `#content` behind the dock (the
mechanism above), or the pane inside the dock. Capture the posted message. This decides whether the
plan is one fix or two, and it is cheap.

### 2. `src/webview/transport.js` — teach the bridge about the dock

Derive `isDockFrame` from `location.search` once at module scope. Guard both senders — the
`PANEL_SWITCH_VERBS` arm (`:356`) and `window.__switchboardSwitchPanel` (`:441`) — so a dock
document does not post `switchPanel`. Warn rather than fail silently. Post with `location.origin`.

### 3. `src/webview/shell.js` — close the origin hole

Add `if (event.origin !== location.origin) return;` to the `switchPanel` arm, matching its three
siblings.

### 4. Enumerate the surface

List every parent-directed `postMessage` in the webview tree and record, per message, whether it is
dock-safe. Two were guarded ad hoc; the point of the list is that the next one added is checked
against something rather than remembered.

## Verification Plan

### Automated Tests

1. **A dock document does not post `switchPanel`.** Drive `transport.js` with `dock=1` in the search
   string and a `PANEL_SWITCH_VERBS` verb; assert no post to parent. The direct regression.
2. **`window.__switchboardSwitchPanel` is guarded identically** under `dock=1` — the hole that a
   verb-only fix leaves open.
3. **A non-dock panel still switches.** Same call without `dock=1` posts as today. The regression
   this fix most plausibly causes.
4. **The full-page route no-ops.** `window.parent === window` → no post, dock param or not.
5. **The shell drops a cross-origin `switchPanel`,** and all four arms in the listener carry an
   origin check — asserted as a property of the handler, so a fifth arm added without one fails.
6. **Every parent-directed `postMessage` in `src/webview/` is on the audited list.** A source-level
   gate over the enumeration from step 4. This is the assertion whose absence let a third relay ship
   unguarded while two carried careful comments about exactly this hazard.

### Goal Invariants

- A document rendered in the dock cannot change what the main content area displays.
- The dock's containment rule is enforced in one place that every panel inherits, not re-derived per
  relay.

### Manual

- Work the dock's Kanban tab through its normal actions; `#content` never changes behind it.
- Repeat on the agent tab — same document, same bridge, and the tab most used.
- Confirm `linear.js`'s Tickets switch still works from the content area.
