# Status View Is the Default for Every Seat Except the Lead

## Goal

A seat pane opens in **status view** unless it is the team lead, and that view is worth looking at: the
seat's CLI brand mark large in the centre of the pane, and a prominent **Terminal view** button under
it. Rendering a live xterm becomes the deliberate choice, not the default for every pane on the grid.

### Problem analysis

**The status view already exists and is not what was asked for.** `paneModes[i] === 'status'` selects
it and `renderStatusPane` (`terminals.js:7599`) draws a `.status-pane-card` — identity row, name,
crown, role, plan, declared state, kind. It is a small text card in a large empty pane. It does not
carry the seat's brand at any readable size, and there is no obvious way from inside the pane to
switch to the terminal; the only control is a toolbar button (`.btn-output-pane.is-status`,
`terminals.js:7007`).

It is also **off by default**, so every pane on the grid renders a live terminal whether or not anyone
is reading it.

#### Why the default is wrong, measured

Today's work turned up three costs that are all paid per *rendered* pane, and all avoidable for a seat
nobody is watching:

1. **WebGL churn.** Six layout switches with ONE terminal produced 9 context acquires and 9 releases,
   plus 33 `ResizeObserver` callbacks (see *Every Layout Switch Releases and Re-Acquires a WebGL
   Context Per Terminal*). The per-document ceiling is `MAX_WEBGL_CONTEXTS = 12`; a 3×3 grid of live
   seats approaches it, and panes past it silently fall back to the canvas renderer.
2. **tmux size contention.** Grouped sessions share a window list, so every attached client votes on
   window size. Four browser panes at 221×40 against an SSH client at 183×53 produced a viewport
   mismatch that made panes repeat their bottom line. Fewer live clients is fewer votes.
3. **Output bandwidth.** Every rendered pane is a live WebSocket consuming its seat's output, and
   `transport.js` already fans each push out 6× because it ignores `msg.surface`.

A grid of nine seats is nine of each. In practice the operator is reading one — usually the lead,
because that is where judgement happens and where a team's commit is decided.

#### What the pane should show

- **The seat's CLI brand mark, large and centred.** The board already resolves these:
  `brandIconForCliLabel` (`terminals.js:3082`) maps a CLI label to a key and `brandIconUri`
  (`terminals.js:3110`) resolves it from the `data-brand-icon-*` body attributes, covering 19 brands
  including the Ollama mark added 2026-09-08. At pane size the mark identifies the seat's vendor
  instantly, which four lines of grey text do not.
- **A prominent `Terminal view` button beneath it.** Switching to the live terminal is the pane's
  primary action and belongs in the pane, not only in a toolbar.
- **The status facts kept, demoted.** Name, role, plan and declared state stay — smaller, under the
  button. The card's content is not the problem; its prominence and its emptiness are.

### The lead is the exception

The lead opens in terminal view because it is the seat the operator actually watches: it triages what
members return, and a team commits once as its head. Every other seat is doing work that is reported,
not read.

## Metadata

**Complexity:** 5
**Tags:** ui, performance, refactor
**Dependencies:** none

## User Review Required

None.

## Complexity Audit

### Routine
- Reordering the DOM inside `renderStatusPane` (`terminals.js:7599`) and adding a few CSS classes in
  `terminals.html` (`.status-pane-card` block at `terminals.html:1476`). Pure presentation.
- Reusing the existing brand table (`brandIconForCliLabel` / `brandIconUri`) — no second brand table.
- The `Terminal view` button reuses the existing mode-toggle mechanism (delegated click from
  `contentEl`, `terminals.js:6667`), the same pattern `.pane-mode-toggle` uses (`terminals.js:6713`).

### Complex / Risky
- **The head predicate is path-dependent.** `isTeamHead` (`terminals.js:8908`) reads `terminalGroups`
  for a *registered* `team_` manual group. The team-seating fallback `seatTeamWithoutGroup`
  (`terminals.js:9267`) fires precisely because the team's group did not load
  (`terminals.js:9194` — `'its group did not load'`), so `isTeamHead(headName)` is **false** there.
  Using `isTeamHead` blindly sends the lead to status on the fallback path — the feature's headline
  rule inverted on the exact path it names. The head is known *positionally* in that function
  (`names = [headName, ...delegates]`, line 9281), so the fallback must test `name === headName`, not
  `isTeamHead(name)`.
- **A contract test asserts the current behaviour and must be updated, not broken.**
  `src/test/status-pane-mode-contract.test.js:81-84` asserts
  `paneModes[slot] = 'terminal'` at the team-seating path. Change 1 flips delegates to `status`, so
  this assertion no longer holds. The test is a source-level regex contract (no runtime harness for
  the pane grid), so it must be rewritten to assert the new lead/delegate split — otherwise the
  coder hits a red suite and has to reverse-engineer whether the test or the code is authoritative.
- **Group page round-trips can clobber an explicit toggle.** `seatActiveGroupPage`
  (`terminals.js:3670`) rebuilds `paneAssignments` from a null array on every page change (line 3686)
  and currently does not touch `paneModes`. If the default is applied there unconditionally, an
  operator who toggles a member to terminal, pages away and back, watches the toggle reset. See
  Outstanding Questions for the per-seat-persistence trade-off.

## Edge-Case & Dependency Audit

- **Race Conditions:** `renderPaneGrid` runs on every 5 s fleet poll and every badge change. The
  status card is rebuilt wholesale each pass (`terminals.js:7069-7072` removes and re-adds). Any
  click listener attached *inside* `renderStatusPane` would accumulate one per pass per pane. The
  `Terminal view` button MUST be delegated from the existing `contentEl` click handler
  (`terminals.js:6667`), class `.status-pane-terminal-btn`, mirroring `.pane-mode-toggle`
  (`terminals.js:6713`). No `addEventListener` in `renderStatusPane`.
- **Security:** No new surface. Brand icons are resolved from `data-brand-icon-*` body attributes
  stamped by the host; an unknown CLI falls back to `brand-cli-default.svg` via
  `brandIconUri('default')`. No `innerHTML` of untrusted content — the button is `textContent`.
- **Side Effects:** Switching a pane to status suspends its stream via `isTerminalRendered`
  (`terminals.js:377`, the status clause) — the socket closes, scrollback survives in `terminalsMap`.
  This is existing behaviour; the default change only makes more panes enter it at seating time. It
  must NOT suspend dispatch, prompt delivery, completion reporting, or the liveness sweep — those are
  mode-independent (see Invariants).
- **Dependencies & Conflicts:** `status-pane-mode-contract.test.js` is the one test that pins
  seating-path mode writes; it conflicts with Change 1 and must be updated in the same diff. No other
  test asserts the default mode. The `paneModes` save/restore path (`terminals.js:1909`) already
  preserves `'status'` across reload — Change 1 does not touch it.

## Dependencies

- none

## Adversarial Synthesis

Key risks: (1) the head predicate `isTeamHead` is false on the team-seating fallback path
(`seatTeamWithoutGroup` fires when the group did not load), so relying on it demotes the lead to
status — the feature's headline rule inverted on the flaky-infrastructure path; (2) the contract test
`status-pane-mode-contract.test.js:81` pins the old "team seating sets terminal" behaviour and breaks
silently under Change 1; (3) `seatActiveGroupPage` rebuilds assignments per page change, so an
unconditional default clobbers explicit toggles on page round-trips. Mitigations: use
`name === headName` in the fallback and `isTeamHead(name)` only on the registered-group path, funnel
both through one helper; update the contract test in the same diff; apply the default in
`seatActiveGroupPage` only to slots whose occupant changed, and raise per-seat persistence as an
Outstanding Question rather than silently expanding scope.

## Proposed Changes

### 1. Default `paneModes` to `status` for non-lead team seats (`src/webview/terminals.js`)

- **Context:** There are two team-seating sites and three individual/explicit seating sites. The
  default applies ONLY to the two team sites. The individual sites keep their existing explicit
  `'terminal'` write — an individual `+` seat is opened deliberately and is not a team member.
- **Logic:** Add a helper that returns the initial mode for a team seat given a head predicate:
  ```js
  // terminal for the head, status for everyone else on the team.
  function defaultTeamSeatMode(name, isHead) {
      return isHead(name) ? 'terminal' : 'status';
  }
  ```
  - **`seatTeamWithoutGroup` (`terminals.js:9267`)** — the fallback path. The group did NOT load, so
    `isTeamHead` cannot answer. The head is positional: `names = [headName, ...delegates]` (line
    9281). Replace line 9291 (`paneModes[slot] = 'terminal';`) with:
    ```js
    paneModes[slot] = defaultTeamSeatMode(name, (n) => n === headName);
    ```
  - **`seatActiveGroupPage` (`terminals.js:3670`)** — the registered-group path. The group IS locked
    and registered, so `isTeamHead` answers correctly. Capture the OLD `paneAssignments` before the
    rebuild (line 3686 builds a fresh null array), then after assigning member `name` to slot
    `freeSlots[n]`, set the mode only when the slot's occupant CHANGED:
    ```js
    const prevAssignments = paneAssignments;
    // ... existing rebuild into `assignments` ...
    paneAssignments = assignments;
    page.forEach((name, n) => {
        const slot = freeSlots[n];
        if (slot === undefined) { return; }
        if (prevAssignments[slot] !== name) {
            paneModes[slot] = defaultTeamSeatMode(name, isTeamHead);
        }
    });
    ```
    This preserves an explicit toggle for a member that stays in the same slot across a re-page, and
    applies the default only to freshly seated slots.
- **Edge cases:**
  - A seat with no team (individual `+` seat, sidebar displacing click `terminals.js:5676`, Open All
    `terminals.js:9704`, unlock auto-fill `terminals.js:3565`) is NOT routed through either team
    site — it keeps `paneModes[i] = 'terminal'`. Do not add a global "on seat assigned" hook; the
    default is call-site-local to the two team functions.
  - A solo/popout pane is always terminal view (`paneModes = ['terminal']` at `terminals.js:1928`).
  - An explicit operator toggle (toolbar `.btn-output-pane` at `terminals.js:6599`, or the new
    in-pane `Terminal view` button) writes `paneModes[i]` directly and persists via
    `saveLayoutSettings()`; the default helper is never re-applied to a slot whose occupant did not
    change, so the choice survives a reload (saved modes restored at `terminals.js:1909`) and survives
    a re-page that keeps the same member in the same slot.

> **Superseded:** (original Change 1) "When a pane is first assigned a seat, choose `status` unless
> that seat is its team's head."
> **Reason:** "its team's head" via `isTeamHead` is false on the `seatTeamWithoutGroup` fallback
> (the group did not load), so the lead would be demoted to status — the feature's headline rule
> inverted on the flaky path. The plan also did not name the two distinct seating sites nor the
> individual/explicit sites that must stay terminal.
> **Replaced with:** A `defaultTeamSeatMode(name, isHead)` helper called from exactly the two
> team-seating sites; the fallback passes `(n) => n === headName` (positional), the registered-group
> path passes `isTeamHead`; individual/explicit seating sites keep their existing `'terminal'` write.

### 2. Rebuild the status card around the brand and the button (`src/webview/terminals.js`, `src/webview/terminals.html`)

- **Context:** `renderStatusPane` (`terminals.js:7599`) currently puts a 14×14 brand in the identity
  row (`terminals.html:1495`). The card is rebuilt wholesale on every reconcile, so the button is
  delegated, not inline-listened (see Edge-Case audit).
- **Logic:** Restructure `renderStatusPane`'s DOM order to: (1) a centred hero block with the brand
  mark large; (2) the `Terminal view` button directly beneath; (3) the existing identity / plan /
  declared / inferred blocks below, smaller. Resolve the mark through `brandIconForCliLabel` /
  `brandIconUri` exactly as today (line 7622) — do not add a second brand table. The button:
  ```js
  const termBtn = document.createElement('button');
  termBtn.className = 'status-pane-terminal-btn';
  termBtn.type = 'button';
  termBtn.textContent = 'Terminal view';
  termBtn.title = 'Turn this pane\'s terminal output back on';
  card.appendChild(termBtn);
  ```
  Wire it by adding a branch to the existing `contentEl` click handler (`terminals.js:6667`), beside
  the `.pane-mode-toggle` branch (`terminals.js:6713`):
  ```js
  if (target.classList.contains('status-pane-terminal-btn')) {
      e.stopPropagation();
      if (!paneAssignments[index]) { return; }
      if (paneModes[index] === 'kanban') { return; }
      paneModes[index] = 'terminal';
      saveLayoutSettings();
      renderPaneGrid();
      return;
  }
  ```
  Add CSS in `terminals.html` (after the `.status-pane-card` block at line 1476): a
  `.status-pane-hero` centred flex block, a `.status-pane-hero-brand` large img (e.g. `width: 56px;
  height: 56px; object-fit: contain;`), and a `.status-pane-terminal-btn` styled to read as the
  primary action. Demote the existing identity/declared/inferred blocks visually (smaller font,
  reduced prominence) but keep their content and classes intact.
- **Edge cases:**
  - An unknown CLI falls back to `brand-cli-default.svg` via `brandIconUri('default')` (line 7623) —
    unchanged.
  - An exited seat keeps the existing `.is-exited` dimming on the brand (`terminals.html:1501`);
    apply the same class to the hero brand.
  - The unreachable branch (`renderStatusPane` line 7605, `.is-unreachable`) is rendered before the
    hero block and returns early — it is unaffected and stays visually distinct
    (`terminals.html:1571`).

### 3. Switching to terminal view must not cost a reconnect (INVARIANT — already implemented)

- **Context:** This is a verification target, not new work. The mechanism already exists.
- **Logic:** The seat's socket and scrollback survive a mode change because `terminalsMap`
  (`terminals.js:327`) holds the entry whether or not it is rendered. The status branch
  (`terminals.js:7054`) keeps the entry but removes `.active`; the terminal branch re-attaches the
  existing container. The no-move invariant at `terminals.js:7085`
  (`if (entry.container.parentNode !== contentEl)`) re-parents only when needed, so pressing
  `Terminal view` attaches the existing view rather than creating one. The new in-pane button
  (Change 2) sets `paneModes[i] = 'terminal'` and calls `renderPaneGrid`, which routes through this
  existing branch — no new socket, scrollback intact.
- **Edge cases:** The no-move invariant must continue to hold: only re-parent when
  `entry.container.parentNode !== contentEl`. Do not relax it.

### 4. A seat in status view must still be fully live (INVARIANT — already true)

- **Logic:** Not rendering is not the same as not running. Dispatch, prompt delivery, completion
  reporting and the liveness sweep are unaffected by pane mode — they key off `paneAssignments` and
  fleet state, not `paneModes`. Only the output stream suspends, via `isTerminalRendered`
  (`terminals.js:377`, the status clause) in the reconcile's trailing loop (`terminals.js:6060`).
- **Rationale:** Stated because it is the obvious way to get this wrong — suspending a seat's stream
  to save work would make the pane a lie. No code change; the invariant is documented so the coder
  does not "implement" something already present and risk breaking it.

## Verification Plan

### Automated Tests
- Update `src/test/status-pane-mode-contract.test.js:81-84` ('the team seating path flips the slot to
  terminal alongside the assignment') to assert the new split: the head's slot is `'terminal'`, each
  delegate's slot is `'status'`, at the `seatTeamWithoutGroup` path (`terminals.js:9291`).
- Add a contract assertion that `seatTeamWithoutGroup` uses the positional head predicate
  (`name === headName`), not `isTeamHead`, so the lead stays terminal when the group did not load.
- A newly seated team: the lead's pane is terminal view, every member's is status.
- An individually created seat (sidebar displacing click / Open All / unlock auto-fill) opens in
  terminal view — the default helper is NOT called from those sites.
- An explicit mode choice persists across a reload (saved `paneModes` restored at `terminals.js:1909`)
  and is not overridden by the default.
- `Terminal view` (in-pane button) attaches the existing entry — no new socket, scrollback intact.
- A seat in status view still reports completion and still receives a dispatched prompt.
- The `Terminal view` button is delegated from `contentEl` (`terminals.js:6667`); `renderStatusPane`
  contains no `addEventListener` (source-level assertion, mirroring the existing contract-test style).

### Goal Invariants
- In a seated team, exactly one pane (the head's) holds a live terminal; every other member's pane
  renders the status card (`paneModes[i] === 'status'`).
- On the `seatTeamWithoutGroup` fallback path, the head's `paneModes` slot equals `'terminal'`
  (assert `name === headName` is the predicate used, not `isTeamHead`).
- An individual (non-team) seat's `paneModes` slot equals `'terminal'` at every non-team seating
  site (`terminals.js:5676`, `terminals.js:9704`, `terminals.js:3565`).
- `paneModes[i]` never changes whether a seat runs, is dispatched to, or reports (negative: no
  seating site gates dispatch/prompt/completion on `paneModes`).
- The brand shown in the status hero is resolved by the same `brandIconForCliLabel` /
  `brandIconUri` table the title bar uses (`terminals.js:3082` / `terminals.js:3110`) — no second
  brand table exists in `renderStatusPane`.

### Manual
- Start a four-seat team, confirm one live terminal (the lead) and three brand cards, and confirm
  the WebGL count reflects one rendered pane rather than four.
- Toggle a member to terminal, reload the window, confirm the toggle persisted.
- Toggle a member to terminal, page the locked group away and back, confirm the toggle survived
  (same member, same slot) — and note the round-trip limitation in Outstanding Questions.

## Outstanding Questions
- **[user]** Per-seat vs per-slot mode persistence across group page round-trips. Today `paneModes`
  is keyed by slot index and rebuilt per page in `seatActiveGroupPage`; the change preserves a
  toggle only when the same member stays in the same slot, so a member that moves slots on a re-page
  resets to the default. True per-seat persistence (keying mode by member name) would fix this but
  rewrites ~23 `paneModes[i]` read sites plus the save/restore path — a larger change than this
  complexity-5 plan. Proceeding on the assumption that per-slot persistence with occupant-change
  detection is acceptable for now and that per-seat persistence is a follow-up if the round-trip
  reset is felt in practice.
