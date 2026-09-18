# Driving Switchboard From Another Device

**Complexity:** 8

## Goal

Make Switchboard *drivable* from a device that is not the host — a phone in a pocket, a tablet on
a desk, a laptop on the far end of an SSH tunnel.

**Reaching it is already solved and is not in scope.** `switchboard tailnet` ships a real bind
policy (`src/standalone/cli.ts`) accepting the tailnet address or a MagicDNS name, and it is the
mode the operator runs day to day. The plan that framed the bind as a blocker
(`a-phone-on-the-tailnet-has-nothing-to-connect-to.md`) has been retired. Any text describing this
feature as "Switchboard is unreachable from a phone" is stale and should be deleted on sight, not
worked around.

What remains are the rough edges *after* you arrive:

- **You cannot drive the board by touch.** There is not one width breakpoint in any panel HTML
  file — every `@media` rule is `prefers-reduced-motion` — and every card move is HTML5
  drag-and-drop, which does not fire from a touch device. So the board renders on a phone and
  cannot be operated on one.
- **Getting to the board means typing an address.** Reachability is solved; discovery is not. On a
  device with no keyboard worth using, an address you must type by hand is a real cost.

Together these make one capability: Switchboard **operable** from a device that is not the host.

## How the Subtasks Achieve This

- **A Phone-Shaped Command Route**: serves a narrow tap-only surface — buttons and dropdowns only, no text input — with four views behind a sub-nav: dispatch, move a card, run a mission, and see what a team is doing. Borrows the sidebar idiom that already solved the layout at phone width, and adds a genuinely different tablet arrangement rather than stretching the phone one.
- **The Board Is Reachable Only By Typing A Tailnet Address**: closes the discovery gap left once the bind was fixed — arriving at the board should not require typing an address on a device with no good keyboard.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A phone-shaped command route, because the sidebar already solved the layout and the board never serves it](../plans/mobile-command-route-borrows-the-sidebar-idiom.md) — **PLAN REVIEWED** — ID: 6482f7c3-125d-40be-b341-38eeb57d9bb4
- [ ] [The board is reachable only by typing a tailnet address into Safari, and the browser chrome it opens in costs a column of board height](../plans/board-installs-to-the-home-screen-as-a-standalone-app.md) — **PLAN REVIEWED** — ID: 088bdaa1-5a0a-40f4-a962-dd0d03e507d3
<!-- END SUBTASKS -->

## Dependencies & sequencing

The command route lands **first**, and the two are only loosely coupled now that the bind and the answer-back plans are both retired. The route ships all five of its functions standalone; the address-discovery subtask makes arriving at it cheaper and is worth nothing before there is something worth arriving at.

The route is testable today with no dependency at all — over an SSH tunnel from a laptop browser resized to 390px, or from a phone against the running `switchboard tailnet`. Sequence: route, then discovery.

**Moved out (2026-08-31):** `html-previews-run-on-a-second-server-no-tunnel-reaches.md` was a member of this feature and is now a standalone starred card. It is not phone or touch work — blank previews hit anyone whose browser is not on the host machine, including the SSH-tunnel and Remote-SSH postures the project already recommends. It should follow the host-aware panel-guard pattern established by `standalone-remote-access-story.md` rather than invent a second convention.

One documentation coupling: the address-discovery subtask writes to `docs/REMOTE_ACCESS.md`, as do `document-the-storage-and-deployment-model-as-it-ships.md` and the now-separate previews card. Sequence those edits.

### Reconciled shared surfaces (added 2026-08-31 by the improve-feature pass)

The two subtasks meet on three surfaces. **None of them is a blocking dependency** — the
sequencing above stands, and either subtask can ship first — but each is an obligation on
whichever lands **second**, and each is now written into both plan files so neither coder has
to discover it.

1. **The CSP is not two copies.** The discovery subtask specifies `manifest-src 'self'` in
   "both places" (`headlessPanelHtml.ts:162` and `shell.html:17`). The command route adds a
   **third** — its own page generator carries its own policy string, as all thirteen
   generators in that file do — and the phone install points at `/command`, so that third copy
   is the one that decides whether a phone install works. Reconciled end-state: the mechanical
   CSP assertion is written over the **set** of shell-class policies, never two named sites.
2. **`viewport-fit=cover` is required on two separate documents.** `/command` is a top-level
   page with its own `<head>` and inherits nothing from `shell.html`. `env(safe-area-inset-*)`
   resolves to `0px` without it, so a safe-area pass on either page is dead CSS that still
   reads as implemented. Both plans now state this at their own head-tag step.
3. **`start_url` — two form factors want two answers.** `/` is right for the tablet (a full
   board, full-screen) and wrong for the phone (the board is inert on touch; full-screen does
   not fix unusable). Reconciled end-state: **one static manifest at `start_url: /`, and the
   phone reaches `/command` by a tap on the rail** — which the command route's manifest entry
   already provides. No second manifest, no second installed icon.

**No merges, deletions or splits.** The two subtasks are genuinely distinct deliverables — a
new surface, and how an existing one is launched — with no duplicated work and no contradictory
design on a shared symbol. The command route was assessed as a split candidate (three separable
deliverables) and deliberately kept whole; see its Recommendation for why.

## Team Dispatch Instructions

### A phone-shaped command route, because the sidebar already solved the layout and the board never serves it

- **Seat:** lead — Complexity 8. Corrected from 6 during this pass; the score predated the
  optimistic-update contract, Teams and VIEW being appended to the plan. A Coder seat is the
  wrong routing for a new top-level page with its own shell and CSP, two layouts at real
  breakpoints, a second consumer of the `/ws/terminal` gateway, and a per-operation optimistic
  layer with three different optimism policies.
- **Acceptance:**
  - `GET /command` returns 200 with a non-empty CSP, and `getPanelsManifest()` carries an
    entry with `id: 'command'`, `group: 'cold'`, and **not** `railHidden: true`.
  - Served HTML contains **zero** `<input`, `<textarea` and `contenteditable` — asserted by
    grep, not by eye — and no `password`, `PAT`, `scaffold`, `airlock`, `deregister`, `delete`
    or `memo` control.
  - Dispatch fires an agent and advances a card; Move lands a **backward** move and dispatches
    nothing; a mission launches through `POST /kanban/queue/next` and **no** control writes
    `ready` or calls `/mission-control/start` or `/confirm`.
  - At least two width breakpoints that are not `prefers-reduced-motion`, and the page's own
    scroll height never exceeds the viewport when measured against `GET /command` directly
    (not against the route inside the desktop shell's iframe).
  - `viewport-fit=cover` present in the page's own viewport meta; a dropped link shows
    "outcome unknown" and a retry does not double-dispatch.
- **Must not touch:** `src/webview/kanban.html` (keeps its drag-and-drop and desktop layout —
  this adds a surface, it does not make the existing one responsive) and
  `src/webview/implementation.html` (the extension sidebar must not regress). No new verbs —
  every function is an existing HTTP route; a control needing a route that does not exist is
  out of scope. No confirmation dialogs, and no destructive controls at all — no delete, no
  reset, no deregister. No PTY input, relay, send field or xterm on this surface. No wiring in
  `extension.ts`: `serveStatic` is wired only in `bootstrap.ts`, so this route is
  standalone-only by construction and adding an extension wiring would be net-new scope.

### The board is reachable only by typing a tailnet address into Safari, and the browser chrome it opens in costs a column of board height

- **Seat:** coder — Complexity 4. Raised from 3 during this pass. Not an intern: both defects
  that decide whether this ships working — the missing `manifest-src` and the wrong
  `Content-Type` — produce a page that renders perfectly and an install that quietly stays a
  bookmark. Neither is visible by looking.
- **Acceptance:**
  - `<meta name="apple-mobile-web-app-capable" content="yes">` present in `shell.html`, and
    `<link rel="apple-touch-icon">` resolving to a 180×180 asset. **This is the acceptance
    check that carries the goal** — research (2026-08-31) established that iOS does *not* apply
    a manifest over plain `http` on a remote origin, so the Apple meta tag, not the manifest,
    is what removes Safari's chrome on the tailnet. A reviewer who sees this tag deleted as
    "deprecated legacy" is looking at a broken install.
  - `manifest-src` present in **both** the policy built by `getShellHtml`
    (`headlessPanelHtml.ts:162`) and the `<meta http-equiv>` in `shell.html:17`, asserted by a
    test written over the set of shell-class policies rather than two hardcoded sites.
  - The manifest URL returns 200 with `Content-Type: application/manifest+json`, and its JSON
    carries `display: "standalone"` and `start_url: "/"`.
  - Icon assets at 180×180, 192×192, 512×512 plus a 512 maskable variant, each asserted
    **square** (`width === height`) — not merely present. `icon.png` is 236×230, which is why
    it cannot be reused. The 180×180 ships with square corners and no pre-baked rounding; iOS
    applies its own squircle mask and double-rounds a pre-rounded source.
  - `viewport-fit=cover` present in `shell.html`'s viewport meta.
  - Installed on a real iPad from the MagicDNS URL over plain `http`: correct name and icon,
    **no address bar and no toolbar**, and terminals still stream.
- **Must not touch:** no service worker, no `beforeinstallprompt`, no push, no offline, no
  install-prompt UI, and no TLS / `tailscale serve` dependency — all explicit non-goals. Do not
  remove `apple-mobile-web-app-capable` on the grounds that the manifest supersedes it; on this
  transport it does not. Not a
  responsive pass: this changes how the board is launched, not how it lays out. Do not build a
  generated-per-workspace manifest; the board's `#workspace-project-select` already reaches
  every workspace from one `start_url`. Do not widen the CSP beyond the single `manifest-src`
  directive, and do not touch the bind policy, the peer check, the Host guard or the token
  model.

## Review Findings

Both subtasks were implemented in one commit (`0b91aa16`) and reviewed together. The
discovery subtask (`088bdaa1`) is sound — every Goal Invariant holds and its CSP test is
correctly written over the *set* of shell-class policies, which is what caught the command
route's third copy. The command route (`6482f7c3`) shipped with all three board reads against
the wrong response envelope, four reads against field names their writers do not persist, a
permanently-empty team roster backfilled with two fabricated teams, Teams unreachable on the
tablet, and its plan-required tap-to-seat removed on the false premise that `ptyStartTeam` does
not exist; all are fixed, and the feature's own reconciled shared surfaces (the third CSP copy,
`viewport-fit=cover` on both pages, one manifest at `start_url: /`) are each satisfied. The
feature goal — Switchboard *operable* from a device that is not the host — is achieved in code
but not yet demonstrated: no part of either subtask has been exercised on a phone or tablet, and
the running server predates both routes.

## Deferred Findings

- MAJOR — Neither subtask's on-device verification was executed (no phone, no iPad, no install, no one-screen measurement). Both subtasks' core mechanisms are manual-only; passing contract suites is not evidence either surface works in the hand. See each subtask's own Deferred Findings. `.switchboard/features/reaching-switchboard-from-somewhere-else-7a679748-e1bd-45fd-a54d-81d59cebdfb5.md:1`
- NIT — The subtask checklist above still shows both items unchecked and **PLAN REVIEWED**; the board, not this file, is the authority on column state. `.switchboard/features/reaching-switchboard-from-somewhere-else-7a679748-e1bd-45fd-a54d-81d59cebdfb5.md:36`
