# The Composer Is a Modal You Have to Summon — Make It a Dock Tab

kanbanColumn: CREATED

## Goal

The composer is a standing surface in the agent dock, not a dialog behind a button. It stays open
across sends, keeps its draft and its target, and sits beside the board rather than on top of it.

### Problem analysis

The composer exists to let the operator write a prompt **locally** and deliver it in one shot to any
terminal, without switching the active pane. That intent is sound and the delivery path works.

Its placement contradicts it. Today it is a modal overlay:

- `terminals.html:341` — `<div id="composer-modal" class="composer-modal" hidden>`, a `hidden`-toggled
  overlay over the pane grid.
- `terminals.js:1307-1308` — reachable only via `#btn-composer`, which calls `openComposerModal`.
- `terminals.js:12361` — opening it rebuilds the target `<select>` and, at `:12396`, clears the
  textarea unconditionally.
- `terminals.js:12517` — Escape closes it.

So every prompt is a four-step gesture: find the button, open the dialog, type, send, dismiss. The
dialog is modal over the board, so the operator cannot read the pane they are writing to while they
write. And because open clears the input, **a draft does not survive a dismissal** — an accidental
Escape, or a glance at a terminal mid-compose, loses what was typed.

That is the wrong shape for what this actually is. Composing a prompt is not a one-shot dialog
gesture; it is a thing the operator does repeatedly, in a loop with reading the terminal output that
came back. It wants to be a panel that is simply *there*.

The dock is already exactly that shape. `/dock` is a persistent right-hand iframe mounted by
`shell.js:447` into `#dock-frame`, with a saved width, an open/closed state that survives reloads,
and a tab strip (`dock.html:461-464`) already holding **Agent**, **CLI** and **Fleet**. The Agent tab
is already an API-backed control surface rather than a pty, which is precisely the precedent a
composer tab follows.

**There are currently two composers.** `terminals.js:12325-12520` and `command.js:226-233, 436-441,
733+` implement the same dialog twice, and `command.js:733` says so in a comment ("Mirrors the
terminals panel's composer"). A dock tab is the opportunity to have one.

### Not the lag

The operator also reports the composer feeling laggy on an iPad. **This plan does not fix that and
must not be verified against it.** The dock is a same-origin iframe in the same document tree, so it
shares a main thread with the terminals panel; a composer in the dock queues behind the same xterm
parsing and WebGL painting it does today. That defect has its own card — *Panes Keep Painting While
You Type Somewhere Else*. Do not let this plan claim its benefit.

## Metadata

- **Complexity:** 6
- **Tags:** composer, dock, terminals, frontend, ux

## User Review Required

None.

## Complexity Audit

### Routine
- A fourth tab in the dock's tab strip, following the Agent tab's pattern.
- Moving the target `<select>`, textarea, status line and SEND button into it unchanged.
- Reusing `deliverComposerPrompt`'s existing delivery path.

### Complex / Risky
- The composer currently lives inside the terminals document and reads its fleet state directly. In
  the dock it is a different document and must source the terminal list over the same verb the dock's
  other tabs use — not by reaching into the parent.
- Draft persistence across tab switches, dock close/reopen, and reload — the thing that makes a
  standing surface worth having — is net-new state with a defined lifetime.
- Two existing composers must collapse into one, or this adds a third.

## Proposed Changes

### 1. A Composer tab in the dock

Add a fourth tab beside Agent, CLI and Fleet. It holds the target select, the prompt textarea, the
status line and SEND — the same controls, in a panel that does not overlay the board.

It is a form, not a pty, so it is comfortable far below the dock's current 648 px floor. That floor
is CLI-derived and applies to every tab today; narrowing it per tab is a known follow-on, but this
tab does not require it — the overlay change in the dock card is what makes the composer reachable
on a tablet.

### 2. The draft survives

The typed prompt and the selected target persist across tab switches, dock close/reopen, and page
reload. Clearing happens on a successful send, not on open — the inverse of today's `:12396`
behaviour.

Persisted draft state is per-surface convenience, not board state: it does not belong in the kanban
database and must not be synced anywhere.

### 3. Delivery is unchanged

Keep `deliverComposerPrompt`'s existing path: `POST /terminals/verb/sendToTerminal` with
**`standingOrders:false`**. That flag is load-bearing and the reason is already on the record at
`terminals.js:12336` — the standalone handler applies standing orders by default, and a user-typed
prompt is not a system dispatch. Appending standing orders to it silently corrupts the operator's
intent. Carry the comment across with the code.

Multi-line input keeps its bracketed-paste framing; a single line starting with `/` keeps being sent
as a control string.

### 4. One composer, not three

The dock tab replaces both the `terminals.html` modal and the `command.html` modal. Delete both
rather than leaving them as a second way in. If the command view's own composer must outlive this
for reasons its in-flight fixes require, say so explicitly in the implementation and leave exactly
one duplicate, not two.

### 5. The button becomes a way to the tab

`#btn-composer` stays, but it opens the dock on the Composer tab rather than a dialog. An operator
who knows the button keeps their muscle memory; the surface it reveals is now persistent.

## Edge-Case & Dependency Audit

1. **The dock is unavailable at tablet widths today.** Below 980 px the toggle is disabled outright
   (`shell.js:466`), because the dock splits the layout and reserves board width beside it. Landing
   this before the overlay change makes the composer *unreachable* on an iPad — strictly worse than
   the modal. This ordering is not optional.
2. **The target terminal can die while a draft sits.** A draft aimed at a terminal that has since
   exited must surface that on send, not deliver into nothing. `deliverComposerPrompt` already
   reports failure; the standing surface simply makes the window between compose and send longer.
3. **The fleet list goes stale.** The modal refreshed its `<select>` on every open. A tab that is
   always open has no such moment — it needs a refresh that does not fight the operator's current
   selection. The existing code already preserves the prior selection across a refresh
   (`terminals.js:12440`); keep that property.
4. **Escape.** In a modal, Escape dismissed. In a dock tab, Escape must not close the dock out from
   under a half-written prompt.
5. **The command view is mid-repair.** Its composer is in a surface being actively fixed. Coordinate
   the deletion in Change 4 rather than racing it.

## Dependencies

**Depends on *The Dock Takes Width From the Board, So It Refuses to Open on an iPad*.** That card
makes the dock open at tablet widths at all, by overlaying the board rather than splitting it.
Landing this first ships a composer the operator cannot reach on the device that prompted the
request.

Independent of *Panes Keep Painting While You Type Somewhere Else* — different defect, different
file, no shared code. Neither blocks the other.

## Both Hosts

`dock.html`, `shell.js` and the webview assets are served by the standalone host
(`src/standalone/`), which is this plan's composition root. The VS Code extension host is out of
scope — it is being removed and needs no wiring here.

## Adversarial Synthesis

Key risks: (1) shipping ahead of the dock width fix produces a composer that is unreachable exactly
where it was asked for, which is the single most likely way this lands badly; (2) dropping
`standingOrders:false` in the move silently corrupts every prompt with appended orders, and nothing
would surface it — the flag is invisible in the UI and the failure looks like the agent behaving
oddly; (3) leaving the old modals in place means three composers and a bug report about which one
works; (4) claiming the iPad lag as a benefit of this change, which it is not. Mitigations: hard
ordering on the dock card, carry the standing-orders comment with the code, delete both modals in
the same change, and verify against placement only.

## Verification Plan

1. The dock has a Composer tab; the composer is reachable without a modal.
2. A prompt typed, then interrupted by a tab switch, a dock close/reopen, and a reload, is still
   there.
3. A successful send clears the draft; a failed send does not.
4. Delivery reaches the selected terminal without switching the active pane, and without appending
   standing orders.
5. Multi-line input arrives as a bracketed-paste block; a leading `/` single line arrives as a
   control string.
6. On a 768 px viewport the Composer tab opens (requires the dock card).
7. Neither `terminals.html` nor `command.html` still contains a composer modal.
8. Escape inside the composer does not close the dock.

### Goal Invariants

- Assert the composer's delivery call still sends `standingOrders:false`.
- Assert a draft survives tab switch, dock close/reopen and reload, and is cleared only on a
  successful send.
- Assert no `composer-modal` element remains in `terminals.html` or `command.html`.
- Assert the composer does not read fleet state from the parent document.

### Implementation Summary (2026-09-20)

The Composer is now a standing fourth tab in the agent dock: `dock.html` carries the pane and tab button, `dock.js` switches it via `DOCK_TABS`, and the new `dockComposer.js` owns the target select, textarea, status line and SEND. Delivery keeps the existing `/terminals/verb/sendToTerminal` route with `paced: true, standingOrders: false`, and the target list is fetched via `ptyListTerminals` — never `window.parent`. The draft and target persist in `localStorage` under `sb.composerDraft` across tab switches, dock close/reopen and reload, and only a successful send clears the text. Both modal implementations were removed from `terminals.html`/`terminals.js`/`terminals.css` and `command.html`/`command.js`; their COMPOSER buttons now post `openDockTab` to the shell, which opens the dock and relays `dockActivateTab` once the /dock document is ready. Because the plan's verification requires the tab at 768px, the dependency card's overlay mode was also landed: `resolveDockPresentation()` returns a tagged `{mode, source}` — split above 980px, overlay above 696px, off below — with the splitter hidden in overlay and no iframe reload on mode switches.

## Review Findings

Reviewed commit `7acce75d` across `dock.html`, `dock.js`, the new `dockComposer.js`, `shell.{html,js}`, `terminals.{html,js,css}`, `command.{html,js}` and the two contract suites, then fixed the three findings the Review head triaged back. The goal is met: the composer is the dock's fourth tab (`dock.html:650` `#dock-composer-pane`, wired by `dockComposer.js`, activated at `dock.js:203-212`), no `composer-modal`/`openComposerModal`/`deliverComposerPrompt` survives in `terminals.*` or `command.*`, draft persistence is real (`sb.composerDraft`, restored at `dockComposer.js:245`, cleared only inside the `data.success` branch at `:202-203`), and `standingOrders:false` + `paced:true` carry their reason comment. The suite's two red assertions were **test defects, not code defects** — `composer-contract.test.js:152` tripped on the module's own header comment promising never to read `window.parent`, and `:180` grepped for identifiers (`clearDraft`/`removeItem`) the implementation does not use — so both were **fixed in the test**: the `window.parent` scan now runs on comment-stripped source and the draft assertion is scoped to the `data.success` branch and names the real `writeDraft('')`/`persistDraft()` seams, with a new self-check test proving the stripped-source gate still fails on an injected real read (verified empirically against a mutated copy). Also **fixed**: `shell.js:142`'s sub-696px refusal now renders an operator-visible notice naming the measured width and the floor, so `#btn-composer` is no longer a clickable-and-incapable control that only logs to the console. Verification run locally: `compile-tests` clean, `compile` clean, `test:contract:composer` 25/0 (was 22/2), `test:contract:shell-agent-dock` 63/0, plus `kanban-optimistic-actions` and `verb-engine-kanban` green. Remaining risk: the standing tab still refreshes its fleet list only on activation, which is the plan's own edge case 3.

## Deferred Findings

- MAJOR — `src/webview/dockComposer.js:118`: `refreshTargets` runs only from `activate()` (`:221`, called by `dock.js:210` on tab selection). A dock left open on the Composer tab shows a fleet list frozen at activation — exactly the "a tab that is always open has no such moment" case the plan's edge case 3 named. No periodic or event-driven refresh exists; the selection-preservation logic at `:142`/`:163` is already in place for one.
- NIT — `src/webview/shell.js:73-113` and `:1188`: the dependency card's presentation resolver, overlay mode, splitter hiding and Escape dismissal landed inside this commit rather than its own. Defensible (verification item 6 needs 768px) but that card's review never covered it.
- NIT — `src/webview/shell.js:198`: a pending `openDockTab` is still dropped after 3s into a `console.info` with nothing shown to the operator. The width refusal now has a visible notice; this path does not.
- NIT — `src/webview/dockComposer.js:132-137`: on a failed `ptyListTerminals` fetch the function returns early, leaving the previous options selectable and SEND armed against a possibly-stale target. The status line does distinguish unreachable from empty (`:135` vs `:153`), so the empty-list-needs-a-source rule is satisfied; disabling SEND would close the rest.
- NIT — `src/webview/terminals.js:1404` and `src/webview/command.js:450`: opening `/terminals` or `/command` outside the shell makes COMPOSER a silent no-op. Documented as intended; not reachable in the shipped shell.
- NIT — `src/webview/dock.js:911`: in overlay mode Escape with focus on the SEND button (a `BUTTON`, not covered by the field guard) closes the dock. The draft survives in `localStorage`, so nothing is lost, but it is a dismissal the plan's edge case 4 did not want.
