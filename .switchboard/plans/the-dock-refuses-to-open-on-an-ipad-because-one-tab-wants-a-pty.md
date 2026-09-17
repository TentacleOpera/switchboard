# The Dock Takes Width From the Board, So It Refuses to Open on an iPad

kanbanColumn: CREATED

## Goal

The dock opens on a tablet. Where the viewport cannot afford to show the dock and the board
side by side, the dock overlays the board instead of being refused.

### Problem analysis

The dock is refused outright below 980 CSS px. On an iPad in portrait (768–834 px) the toggle
renders **disabled**, tooltipped "Window too narrow for the agent dock (needs 980px)", and a dock
left open across a reload does not come back (`shell.js:466`, `shell.js:806`).

The number comes from `shell.js:44-48`:

```
const DOCK_MIN = 648, DOCK_DEFAULT = 648, DOCK_MAX = 1100;
const DOCK_MIN_CONTENT = 280;
const DOCK_VIABLE_MIN = 48 + 4 + DOCK_MIN + DOCK_MIN_CONTENT; // 980
```

That is: rail (48) + splitter (4) + dock (648) + **a reserved floor for the board behind it** (280).

**The last term is the whole bug.** The dock is a *splitter* layout — `dockEl` takes real width out
of the content area, `splitterEl` drags the boundary, and `DOCK_MIN_CONTENT` exists so the board is
"never squeezed to 200px" (`shell.js:458`). The viability gate is the logical consequence: if the
two must share the width, and neither can go below its floor, then below 980 px the dock cannot
exist at all.

So the operator is refused a dock not because the dock would not fit, but because **the board would
not fit beside it**. At 768 px the dock itself fits comfortably: 48 + 648 = 696.

**The expected behaviour is that the dock goes over the top.** An overlaying dock has no reason to
reserve board width, because it is not taking any — the board is simply behind it, intact, exactly
as it was. That serves the `DOCK_MIN_CONTENT` intent *better* than refusal does: the board is never
squeezed, and the operator still gets the dock.

A separate top-level surface is not the answer here — that role already belongs to the command
panel. The dock's job is to sit over or beside the board it is acting on.

**On the 648 floor.** `DOCK_MIN = 648` is a pty-sized minimum, set by the CLI tab. The Agent tab is
an API-backed control surface, Fleet is a list, and a future Composer tab is a form — none of them
need 648. That is a real second defect, but it is **not** what blocks the iPad: with overlay mode,
768 px clears the bar with the 648 floor left untouched. Per-tab floors are a follow-on improvement,
not a prerequisite, and this plan deliberately does not bundle them.

## Metadata

- **Complexity:** 5
- **Tags:** dock, layout, mobile, frontend

## User Review Required

None.

## Complexity Audit

### Routine
- An overlay presentation mode for `dockEl` — positioned over the content area rather than beside it.
- Choosing the mode from the viewport width at open, and on resize.
- Recomputing the viability threshold without the `DOCK_MIN_CONTENT` term in overlay mode.

### Complex / Risky
- The splitter is meaningless in overlay mode. It must be inert and invisible there, not a draggable
  control that silently does nothing — a dead affordance is worse than an absent one.
- Crossing the threshold *while the dock is open* switches presentation mode live. The dock must not
  reload, and the `/dock` iframe must keep its state — the existing open/close cycle is careful to
  avoid a reload (`shell.js:452`) and a mode switch must be equally careful.
- Dismissal in overlay mode is a new interaction with no current analogue. The splitter-mode dock is
  dismissed by the rail toggle; an overlay covering the board needs a defined, discoverable way out
  that does not conflict with the board underneath.

## Proposed Changes

### 1. Two presentation modes, chosen by width

**Split mode** — today's behaviour, unchanged, wherever the viewport can afford dock + board side by
side. This is the desktop case and it must not regress.

**Overlay mode** — below that threshold, the dock renders over the content area. The board keeps its
full width behind it and is not reflowed. The dock's own floor still applies; the board's does not,
because none of the board's width is being taken.

Resolve the mode as `{ mode, source }` — which rule chose it and from what width — and log it where
the gate uses it. "Why is the dock overlaying?" must be answerable after the fact, and a mode that
was defaulted must be distinguishable from one that was measured.

### 2. Viability drops the board's floor in overlay mode

The threshold becomes rail + dock floor, not rail + splitter + dock floor + board floor. Below even
that, the toggle may still disable — but it must say which term failed, not "window too narrow".

### 3. The splitter is inert and hidden in overlay mode

No drag handle, no resize, no pointer target. In overlay mode the dock's width is its floor or the
viewport, whichever is smaller.

### 4. A defined dismissal for overlay mode

The rail toggle continues to close the dock. Escape closes it **only when focus is not inside a text
field in the dock** — a half-written prompt must not be destroyed by a stray key (see the Composer
card). Choose one additional dismissal gesture and make it consistent; do not add a confirmation
step of any kind.

### 5. Mode switches do not reload the dock

Crossing the threshold with the dock open changes presentation only. The `/dock` iframe keeps its
`src`, its active tab and its state, exactly as the open/close cycle already does.

## Edge-Case & Dependency Audit

1. **Rotation.** An iPad rotating portrait↔landscape crosses the threshold in both directions with
   the dock open. Each crossing is a live mode switch, not a close-and-reopen.
2. **A force-closed dock must not self-reopen.** `shell.js:461` is explicit that a width-forced close
   is not a user preference. Overlay mode makes forced closes rarer, but the rule stands wherever one
   still happens.
3. **The board underneath keeps running.** Overlay does not suspend anything — panes behind the dock
   still stream and paint. That is a separate defect (*Panes Keep Painting While You Type Somewhere
   Else*); this plan must not be verified against it, and must not claim its benefit.
4. **Boot restore.** `shell.js:806` restores a dock left open. It must resolve the mode before
   restoring, or a dock saved in split mode reopens into a viewport that cannot hold it.
5. **Persisted width.** `clampDockWidth` (`shell.js:77`) clamps against `window.innerWidth - 48 - 4 -
   DOCK_MIN_CONTENT`. In overlay mode that subtraction is wrong and would clamp a dock narrower than
   it needs to be.
6. **The iPad software keyboard.** Nothing in `shell.js` touches `visualViewport`; only
   `window.resize` is observed (`terminals.js:1497`). An overlay dock holding a focused text field is
   the first surface where that gap is load-bearing — the keyboard may cover the dock's lower half
   with nothing reacting.

## Dependencies

None. **Blocks** *The Composer Is a Modal You Have to Summon* — a composer in the dock is
unreachable on a tablet until this lands.

## Both Hosts

`shell.js` and `dock.html` are shared webview assets served by the standalone host
(`src/standalone/`), which is this plan's composition root. The VS Code extension host is out of
scope — it is being removed and needs no wiring here.

## Adversarial Synthesis

Key risks: (1) overlay mode regressing the desktop split layout, which is the common case and the
one nobody is complaining about — split mode must be provably untouched above the threshold; (2) a
live mode switch reloading the `/dock` iframe, losing the active tab and any draft, which would
surface as "rotating my iPad wiped what I typed"; (3) a splitter left draggable-but-inert in overlay
mode, which reads as a broken control; (4) `clampDockWidth` keeping the board-floor subtraction in
overlay mode and quietly under-sizing the dock — a wrong value that looks like a working one.
Mitigations: resolve the mode through one tagged resolver, switch presentation without touching
`src`, hide the splitter outright, and make the clamp mode-aware.

## Verification Plan

1. On a 768 px viewport the dock opens, overlaying the board; the toggle is enabled.
2. Above the threshold the dock splits the layout exactly as it does today, and the board is never
   squeezed below `DOCK_MIN_CONTENT`.
3. Rotating portrait↔landscape with the dock open switches mode live, without reloading the dock or
   losing its active tab.
4. The splitter is absent and non-interactive in overlay mode.
5. A dock left open survives a reload at tablet width.
6. A width-forced close does not self-reopen.
7. Where the toggle still disables, the tooltip names the term that failed.

### Goal Invariants

- Assert the viability threshold excludes `DOCK_MIN_CONTENT` in overlay mode and includes it in
  split mode.
- Assert the resolved `{ mode, source }` is logged where the gate uses it.
- Assert a mode switch does not change the dock iframe's `src` or reset its active tab.
- Assert `clampDockWidth` does not subtract the board floor in overlay mode.
- Assert the dock opens at 768 px with `DOCK_MIN` left at its current value.
- Assert split-mode geometry above the threshold is byte-for-byte as today.
