# The dock's Kanban pane flashes the sidebar and renders nothing — dock mode is a third entry point nothing accounts for

## Goal

Make the dock's Kanban pane render. Three defects stand between opening the tab and seeing cards:
the pane never picks a column, the dock inherits the main panel's persisted layout, and the
dock-mode body class is applied after first paint so the full-panel chrome flashes. All three are
the same omission — `?kanban=1&dock=1` is a third way into kanban mode, and the paths that make
kanban mode work were written for the other two.

### Problem Analysis — reported symptom

Opening the dock's Kanban tab: *"the pane inside the dock just flashed the terminal sidebar and then
did not show any content. Looked like it was trying to show a small window into the larger panel."*

That description is precise, and each clause is a different defect.

### Defect 1 — "did not show any content": the pane never picks a column

`renderKanbanPane` (`terminals.js:7101`) opens with `let chosen = kanbanPaneColumn[index];` and
every downstream read depends on it — the fetch (`:7723`, `const col = kanbanPaneColumn[index]`),
the response guard (`:7752`), the empty label (`:7330`,
`` `No plans in ${columnLabelForId(kanbanPaneColumn[index])}` ``).

**Both user-driven paths into kanban mode default it explicitly:**

```js
// :6549 — pane mode toggle
if (!kanbanPaneColumn[index]) { kanbanPaneColumn[index] = 'CREATED'; }
// :7646 — the other toggle site
if (!kanbanPaneColumn[targetIndex]) { kanbanPaneColumn[targetIndex] = 'CREATED'; }
```

**The dock path does not.** `init()` (`:848-856`) and `loadLayoutSettings()` (`:2228-2233`) both set
`paneModes = ['kanban']` and neither touches `kanbanPaneColumn`. So `kanbanPaneColumn[0]` is
whatever the restored setting held — `undefined` for any user whose main panel has no kanban pane in
slot 0, which is the default.

`undefined` then survives every correction. The snap-to-offered logic (`:7142-7145`) tests
`chosen === AGGREGATE_CODED_ID` (false) and `coded.includes(chosen)` (false), so `snapTo` stays
`null` and nothing repairs it. The pane fetches an undefined column and paints nothing.

### Defect 2 — "a small window into the larger panel": the dock reads the main panel's settings

This is literal, not just a visual impression. `loadLayoutSettings` restores from the shared
`terminals.*` keys — `terminals.layoutMode`, `terminals.paneAssignments`, `terminals.paneModes`,
`terminals.kanbanPaneColumn` — with no dock namespace. The dock is a viewport onto the main panel's
persisted state.

The tail of that function re-clamps `currentLayout`, `paneAssignments` and `paneModes` for dock
mode (`:2224-2234`), which is why the *layout* is right. `kanbanPaneColumn`, `kanbanPaneWorkspace`
and `kanbanPaneProject` are restored above (`:2212-2220`) and **not** re-clamped — so the dock
inherits three pane-scoped settings belonging to a different pane in a different panel.

Writing is already one-way: `saveLayoutSettings` early-returns for solo and dock (`:2237`), so the
dock never persists. Only the read side leaks.

### Defect 3 — "flashed the terminal sidebar": the mode class lands after first paint

`document.body.classList.add('is-kanban')` runs inside `init()` (`:850`). The CSS that hides the
full-panel chrome is keyed on it (`terminals.html:2143-2148` — sidebar, layout toolbar, fallback
banner, group tab strip, empty state, all `display: none !important`). Until `init()` runs, the
document paints as the full Terminals panel, in a pane sized for a terminal — the sidebar flash.

`is-solo` has the identical structure (`:2137-2141`), so this is shared, not kanban-specific. It is
more visible here because the kanban pane then renders nothing, leaving the flash as the only thing
that happened.

### Root Cause

Kanban mode had two entry points, both user-driven toggles inside a full-width panel, and both
correctly seed the pane's column. The dock added a third — a URL parameter, at document init, in a
narrow frame — and it was wired by setting `paneModes` alone, which is the part that *looks* like
the mode. The seeding, the settings namespace and the paint-order concern are all things the toggle
paths got for free by running after the panel was already up.

Nothing enumerated what "being in kanban mode" requires, so a third entry point could satisfy the
visible half of it and ship.

### Also found: a dock frame can switch the shell's main panel

Not the reported symptom, and independently shippable, but the same root cause and worth fixing in
the same pass.

`transport.js:356` posts `switchPanel` to the parent on one condition — *am I in an iframe?*

```js
if (PANEL_SWITCH_VERBS[verb] && window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'switchPanel', panel: PANEL_SWITCH_VERBS[verb] }, '*');
}
```

The shell obeys with `selectPanel(data.panel)` (`shell.js:1041-1045`). `isDockFrame` is never
consulted, so a dock document can repaint the main content area. `window.__switchboardSwitchPanel`
(`transport.js:441`) is the same post with no verb mapping.

The codebase already knows this rule — the two other parent-directed relays in `terminals.js` both
carry dock guards, and one is commented *"Mirrors postFleetStateToShell's embedded + dock guards for
the same reasons"* (`:1381`). The third relay lives in `transport.js`, shared infrastructure with no
notion of a dock.

**And `switchPanel` is the only one of the shell's four message arms with no origin check**
(`:1041` versus `:1053`, `:1059`, `:1070`), while the sender posts with `'*'`.

### Non-goals

- **Not changing what the dock renders.** The `/terminals?…&dock=1` reuse stays.
- **Not the dock tab rework.** `agent-dock-three-tabs-agent-cli-fleet.md` retires this pane; see
  Dependencies for why this still ships first.
- **Not redesigning the kanban pane.** Only its dock entry path.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, bugfix, reliability

## Dependencies

- **Blocks `agent-dock-three-tabs-agent-cli-fleet.md`, which retires this pane.** Fixing a pane
  slated for removal is worth it for two reasons. Defects 2 and 3 are **not kanban-specific**: the
  settings-namespace leak affects any dock pane reading `terminals.*`, and the paint-order flash
  affects `is-solo` — the agent tab, which survives, and the CLI tab that plan adds. The
  `switchPanel` leak belongs to any `?dock=1` document for the same reason. Only defect 1 dies with
  the pane.

## User Review Required

- **Confirm the Kanban pane is worth repairing at all,** given it is scheduled for retirement. The
  alternative is to fix defects 2, 3 and the `switchPanel` leak now and let defect 1 go with the
  pane — cheaper, and leaves the tab visibly broken until the rework lands.

## Complexity Audit

### Routine

- Seeding `kanbanPaneColumn[0]` on the dock path.
- Adding an `isDockFrame` guard and an origin check.

### Complex / Risky

- **The `'CREATED'` default is not obviously right for a dock.** The toggle paths pick it for a pane
  the user just flipped while looking at the board. A dock pane opened cold might better default to
  the same column the board is showing. `'CREATED'` matches the existing paths and is the
  conservative choice; anything else is a product decision, not a bug fix.
- **Namespacing the dock's pane settings must not orphan the main panel's.** The keys are shipped
  (`terminals.kanbanPaneColumn` and siblings). The fix is for the dock to *ignore* them, not to
  rename or migrate them — the main panel keeps reading and writing exactly as today.
- **Moving the body class earlier means moving it out of `init()`.** It must be set from
  `location.search` at document scope, before first paint, without duplicating the parse
  (`:203-214`). Two parsers that can disagree about dock mode is worse than the flash.
- **`is-solo` shares defect 3.** Fixing only `is-kanban` leaves the flash on the agent tab — the
  dock's most-used tab. Both classes move together or the fix is half done.
- **`transport.js` has no `isDockFrame`.** It is shared by every panel. Derive it there from
  `location.search`, mirroring `terminals.js:213`, rather than importing from the terminals panel —
  that way every panel the dock may ever host is covered.

## Edge-Case & Dependency Audit

- **A user whose main panel *does* have a kanban pane in slot 0** currently gets a dock pane that
  works by coincidence, on that pane's column. After the fix it gets its own. Expected, and worth
  stating so it is not reported as a regression.
- **`saveLayoutSettings` must stay one-way.** Its dock early-return (`:2237`) is what stops the dock
  writing back; seeding a column must not route through a save.
- **The standalone full-page route** (`/terminals` not iframed) is unaffected: `window.parent ===
  window`, so the `switchPanel` bridge already no-ops. Assert it stays so.
- **Popped-out terminal windows** (`shell.js:1074`) have an `opener`, not a `parent` — a different
  path the new guard must not catch.
- **`linear.js:358` posts `switchPanel → tickets`** from the content area and must keep working.
  This is the regression the guard most plausibly causes.
- **Both hosts serve these files** — `getShellHtml` is wired in `bootstrap.ts:3469` and
  `TaskViewerProvider.ts:4190`. No new endpoint, so no composition-root work.
- **No `confirm()` in this diff**, per `CLAUDE.md`.

## Proposed Changes

### 1. `terminals.js` — seed the column on the dock path

In both dock-mode arms (`init():848-856`, `loadLayoutSettings():2228-2233`), apply the same default
the toggle paths use: `if (!kanbanPaneColumn[0]) { kanbanPaneColumn[0] = 'CREATED'; }`.

### 2. `terminals.js` — stop the dock inheriting pane-scoped settings

In the dock clamp (`:2228-2233`), reset `kanbanPaneColumn`, `kanbanPaneWorkspace` and
`kanbanPaneProject` to dock-local values alongside `paneModes` and `paneAssignments`, rather than
leaving the restored arrays in place.

### 3. `terminals.html` / `terminals.js` — set the mode class before first paint

Parse the mode parameters once at document scope and apply `is-solo` / `is-kanban` there, before
`init()`. One parser, both classes.

### 4. `transport.js` + `shell.js` — dock containment

Derive `isDockFrame` in `transport.js`; guard both `switchPanel` senders (`:356`, `:441`) and warn
rather than fail silently; post with `location.origin`. Add the missing origin check to the shell's
`switchPanel` arm.

### 5. Enumerate the parent-directed message surface

List every parent-directed `postMessage` under `src/webview/` and record whether each is dock-safe.
Two were guarded ad hoc; the list is so the next one is checked against something.

## Verification Plan

### Automated Tests

1. **A dock kanban pane resolves a column with no persisted setting.** Seed an empty
   `terminals.kanbanPaneColumn`, enter via `?kanban=1&dock=1`, assert `kanbanPaneColumn[0]` is
   `'CREATED'` and the pane fetches that column. The reported bug, pinned directly.
2. **The dock ignores a persisted pane column.** Seed `['CODE REVIEWED']`; the dock still opens on
   its own default. Pins defect 2 independently of defect 1 — with only fix 1, a stale setting still
   leaks in.
3. **`saveLayoutSettings` still writes nothing in dock mode** after the seeding change.
4. **`is-kanban` and `is-solo` are both set before first paint** — asserted on the document, not on
   `init()` having run.
5. **A dock document does not post `switchPanel`,** for the verb map and for
   `window.__switchboardSwitchPanel`. Two assertions: a verb-only fix leaves the global open.
6. **A non-dock panel still switches** — the regression guard for fix 4.
7. **The full-page route no-ops** whether or not `dock=1` is present.
8. **All four shell message arms carry an origin check** — asserted as a property of the handler, so
   a fifth arm added without one fails.
9. **Every parent-directed `postMessage` in `src/webview/` is on the audited list** (step 5). The
   gate whose absence let a third relay ship unguarded while two carried comments about this hazard.

### Goal Invariants

- Opening the dock's Kanban tab shows cards, with no full-panel chrome flashing first.
- A dock document reads no pane-scoped state belonging to the main panel, and can change nothing
  outside its own frame.

### Manual

- Open the dock's Kanban tab on a profile that has never used a kanban pane — cards appear.
- Switch to the agent tab and back — no sidebar flash on either.
- Work the pane's normal actions; `#content` never changes behind the dock.
- Confirm `linear.js`'s Tickets switch still works from the content area.
