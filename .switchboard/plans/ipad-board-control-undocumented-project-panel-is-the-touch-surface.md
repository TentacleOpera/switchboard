# Reaching the board from a tablet is documented; driving it is not, and the control surface that works is the one nobody points at

## Goal

Document the touch operating path for Switchboard. `docs/REMOTE_ACCESS.md` explains how to
get a tablet onto the board and stops there — it never says that card drag is inert on
touch, never names the control that moves a card in any direction, and never says which
surfaces are usable from a tablet at all. The controls already exist and already work; an
operator on an iPad currently discovers them by accident, by editing a plan file, or by
asking an agent to move the card.

### Problem Analysis

**Access is solved and documented. Operation is neither.** `docs/REMOTE_ACCESS.md:54-101`
is current and accurate: `switchboard tailnet` opens a second listener on the Tailscale
interface (`LocalApiServer.ts:876`), the token skip is explained, the Tailscale-down
behaviour is explained, and the insecure-context clipboard fallback
(`src/webview/clipboardFallback.js`) is explicitly documented at `:88-97`. A tablet reaches
the board and the board renders.

**Then the operator hits a wall that no document mentions.** Card moves on the board are
HTML5 drag-and-drop — `draggable="true"` at `kanban.html:9599` and `:9723`, with
`dragstart`/`dragover`/`drop` handlers and `dataTransfer` payloads. **HTML5 drag events do
not fire from touch input on iPadOS or iOS at all.** This is not a styling or hit-target
problem that a pinch-zoom works around: the board is readable and the cards are inert. The
same is true of terminal pane reordering (`terminals.js:4174`, `:7320`) and the
structure-reorder rows (`kanban.html:12480`).

**The capability the operator is missing is not missing.** Three separate paths already
move a card, and all three are tap-only:

| Need | Control | Location |
|---|---|---|
| Move selection forward one stage | Column-header move button | `kanban.html:8264`, `data-action="moveSelected"` |
| Move one card to **any** column, including backward | Column badge → `<select>` dropdown | `project.js:1723-1790`, posts `moveKanbanPlanColumn` |
| Move a card to any column (board, drag-only) | `handleDrop` → `moveCardForward` / `moveCardBackwards` | `kanban.html:10470`, `:10475` |

The third is the one touch loses. The second is its complete functional replacement, one
card at a time — and it is buried behind a click on a column badge inside a plan row in a
panel whose name gives no hint that it is where you go to move a card.

**So the reported symptom — "there is no way to move a card backwards on an iPad" — is
false, and it is reasonable that the operator believed it.** Nothing in the documentation
connects "I am on a tablet" to "use the Project panel's column dropdown", and the board,
which is the obvious place to look, silently does nothing.

### Root Cause

`docs/REMOTE_ACCESS.md` is scoped as a **networking** document — bind addresses, tokens,
tunnels, proxies, what is not supported and why. Reachability was the hard problem, so it
got the document. Nobody wrote the companion operating guide, because on a desktop the
board is self-evident and no guide is needed. The touch device is the only client where
the primary interaction model is unavailable, and it is the one client with no page of its
own.

### Non-goals

- **Not a code change.** No new control, no touch-drag shim, no responsive pass. Every
  control this documents exists and works today. If the writing shows a control to be
  genuinely unusable on touch rather than merely undiscoverable, that is a finding to
  raise, not a fix to make inside this plan.
- **Not the phone command route.** `mobile-command-route-borrows-the-sidebar-idiom.md`
  builds a narrow tap-only surface for phones, which struggle with the Project panel in a
  way tablets do not. That plan stands on its own; this document should link to it once it
  lands, and must not pre-announce it as though it exists.
- **Not a terminal copy story.** Copying text out of a browser terminal on touch is a real
  limitation (xterm renders through `@xterm/addon-webgl` / `addon-canvas`, so there is no
  DOM text for a long-press to select), and it is not solved here. Document the limitation
  honestly; do not imply a workaround that does not exist.
- **Not a rewrite of the access material.** `REMOTE_ACCESS.md:54-101` is accurate. Leave it.

## Metadata

**Complexity:** 2
**Tags:** docs, ux, mobile
**Project:** Browser Switchboard

## User Review Required

One decision: **where the operating guide lives.**

- **Option A — a new section inside `docs/REMOTE_ACCESS.md`.** The operator is already
  reading it to get connected, so the next question is answered in place. Risk: a
  networking document grows a UI-guide half and its focus blurs.
- **Option B — a new `docs/TOUCH_ACCESS.md`, cross-linked from the Tailscale section.**
  Keeps each document single-purpose and gives the touch story room to grow (phone route,
  paste button, copy limitation). Risk: one more file to keep current, and a link is easier
  to miss than a heading.

**Recommendation: B**, with a short pointer paragraph at the end of the Tailscale section.
The touch story already has three moving parts and two pending plans; it will outgrow a
subsection, and `REMOTE_ACCESS.md` has a clear remit worth protecting.

## Complexity Audit

### Routine

- Writing prose against controls that already exist and can be exercised by hand.
- One cross-link from the Tailscale section.

### Complex / Risky

- **Every claim must be verified on a real touch device before it is written.** This
  document's entire value is that the operator trusts it. A guide that says "tap the column
  badge in the Project panel" and is wrong about which element is tappable is worse than no
  guide, because it converts a discoverable problem into a documented dead end. The badge
  handler is at `project.js:1760-1790` and the dropdown is `display:none` until the badge is
  clicked — confirm that toggle actually fires from a tap, not just a mouse click.
- **Moving a card can dispatch an agent, and the document must say so before it says how
  to move a card.** The column-header move button dispatches when CLI triggers are enabled;
  `handleDrop` routes forward moves through `triggerAction` / `triggerBatchAction`
  (`kanban.html:10459-10466`). An operator moving a card from a tablet to tidy the board can
  start a team without meaning to. Name the toggle that turns this off (`toggleCliTriggers`)
  in the same breath, not in a later section.
- **Forward and backward are not symmetric, and pretending otherwise is a trap.** The
  Project panel's dropdown posts `moveKanbanPlanColumn` (`project.js:1788`), which is a
  different verb from the board's `moveCardForward` / `moveCardBackwards` and is keyed by
  `planFile` rather than session id. Whether it fires the same dispatch and run-sheet side
  effects is **not established** and must be checked before the document implies the two
  routes are equivalent. If they differ, the difference is the single most useful sentence
  in the guide.
- **Multi-select does not survive the switch.** The board's move button acts on a
  selection; the Project dropdown moves exactly one plan. An operator with six cards to walk
  backwards needs to know it is six operations, not one, before they start.

## Edge-Case & Dependency Audit

**Accuracy hazards**
- Column sets are user-configurable (`updateKanbanStructure`, custom columns), so the guide
  must describe the mechanism, never a fixed column list that will drift.
- `_kanbanAvailableColumns` populates the dropdown (`project.js:1724`); if it is filtered or
  empty in some states, the guide's instruction silently fails. Check an unusual case —
  a plan in a feature-only column, an archived plan — before promising it always works.

**Side effects**
- Documenting the Project panel as the touch control surface raises its status. Future
  changes to that panel acquire a documented dependency, which is a real constraint on
  whoever next reworks it. Say so in the document's own text so the constraint is visible
  where it binds.

**Security**
- None. No new surface, no new exposure, no change to the guards. Reviewing this plan does
  not require a security pass.

**Migration**
- None.

## Dependencies

- **None blocking.** Every control documented is shipped.
- **Forward links, not prerequisites:** `mobile-command-route-borrows-the-sidebar-idiom.md`
  (phone surface) and the terminal paste-button plan. Add links when they land; do not
  reference them as though they exist.
- **Stale neighbour, worth resolving separately:**
  `a-phone-on-the-tailnet-has-nothing-to-connect-to.md` is built on the premise that the
  bind is hardcoded `127.0.0.1` and nothing listens on the tailnet interface. That is no
  longer true — `LocalApiServer.ts:876` binds a tailnet listener and `REMOTE_ACCESS.md`
  documents it. That plan should be closed or rewritten on the board. It is not this plan's
  work, but writing this document while that one sits open invites a contradiction.

## Adversarial Synthesis

The way this fails is by being written from the code rather than from the device. Every
instruction here is a physical claim about what happens when a finger touches glass, and
the reading of `project.js` that says a badge is clickable is not evidence that it is
tappable — iOS synthesises click from tap only under conditions that `:hover`-dependent and
`display:none`-toggled controls routinely break. The second failure is tonal: a guide that
frames the Project dropdown as *the* way to move cards implies the board's inertness is a
design choice rather than an unavailable capability, which will read as gaslighting to an
operator who just spent ten minutes trying to drag a card. State plainly that drag does not
work on touch, that it is a platform limitation of HTML5 drag-and-drop, and that the
dropdown is the working substitute. Mitigation for both: write the document with an iPad in
hand, and have someone who has never used the Project panel follow it end to end.

## Proposed Changes

1. **New `docs/TOUCH_ACCESS.md`** (subject to the Option A/B decision above), covering:
   - **What does not work, and why.** Card drag on the board, terminal pane reordering,
     structure reordering — all HTML5 drag-and-drop, all inert on touch. One sentence of
     cause, no apology, no workaround implied.
   - **Moving a card forward.** The column-header move button, multi-select behaviour, and
     the dispatch consequence with `toggleCliTriggers` named in the same paragraph.
   - **Moving a card backward or to any column.** The Project panel path, written as a
     literal tap sequence, with the one-card-at-a-time limitation stated up front.
   - **What works normally on touch.** Terminals (input, scrollback, resize), the panels,
     memo, tickets — so the operator knows the boundary of the problem.
   - **What is genuinely unavailable.** Copying text out of a terminal, with the canvas
     rendering cause given honestly and no invented workaround.
   - **Tablet versus phone.** Tablets drive the Project panel comfortably; phones do not,
     which is what the command route is for. Link once it exists.
2. **A pointer paragraph** at the end of `docs/REMOTE_ACCESS.md`'s Tailscale section: you
   are connected — if you are on a tablet or phone, read `TOUCH_ACCESS.md` next.
3. **No source changes.**

### Migration

None. Documentation only; no shipped state, setting, format or behaviour changes.

## Verification Plan

1. **Follow the document on a real iPad, from a cold start**, over the tailnet URL, without
   touching a desktop. Every instruction executes as written or the instruction is wrong.
2. **Move a card backward end to end** via the documented Project-panel path and confirm on
   the board that it landed in the intended column and stayed there after a refresh.
3. **Confirm the dispatch warning is true**, in both directions: with CLI triggers on,
   verify a forward move via the column button fires an agent; with the toggle off, verify
   it does not. If a *backward* move via the Project dropdown also dispatches, that is a
   finding — record it and correct the document rather than omitting it.
4. **Check the verb asymmetry.** Establish whether `moveKanbanPlanColumn` records a run
   sheet and triggers the same side effects as `moveCardBackwards`
   (`KanbanProvider.ts:10681`). Document whichever answer is true.
5. **Confirm the badge tap works**, specifically that the `display:none` → `block` toggle at
   `project.js:2050-2067` fires from a tap and that the resulting `<select>` opens the
   native iOS picker.
6. **Have someone else follow it.** Someone who has not used the Project panel should move a
   card backward on a tablet using only this document. Where they hesitate, the document is
   wrong.
7. **No source diff.** `git diff --stat` touches only `docs/`.
