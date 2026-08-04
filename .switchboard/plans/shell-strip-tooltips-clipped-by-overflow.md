# Shell left strip has no tooltips: the labels are built, then clipped away by the strip's own overflow

## Goal

Make the standalone/browser Switchboard shell's left icon strip show a tooltip on hover for every
button — panel icons, the theme toggle, and fleet terminal buttons. The tooltip elements are **already
built and already revealed on hover**; they are rendered outside their container's clip rectangle and
so are never visible. Fix the containment, don't add a second tooltip system.

### The observed failure

Hovering any icon in the shell's 48px left strip produces nothing. Panel icons (Board, Project, Memo,
Artifacts, Design, Setup, Terminals) are unlabelled glyphs with no way to learn what they are except
clicking each one.

This is browser/standalone-only. `src/webview/shell.html` is the headless app-shell (see its own header
comment, and `:206-207` — "the shell has no VS Code webview equivalent"), so the VS Code host is
unaffected and there is no host-parity dimension to this bug.

### Root cause — the tooltip is drawn 2px past the edge of a clipping box

The strip tooltip is a CSS-only hover reveal. `src/webview/shell.html:110-128`:

```css
.strip-icon .strip-label {
    position: absolute;
    left: 44px;
    top: 50%;
    transform: translateY(-50%);
    ...
    white-space: nowrap;
    opacity: 0;
    z-index: 100;
}
.strip-icon:hover .strip-label { opacity: 1; }
```

And `src/webview/shell.js` populates it in all three places: `buildIcon` appends a `.strip-label` when
`panel.label` is set (`:78-83`), `buildThemeToggle` appends one unconditionally (`:101-103`), and the
fleet terminal builder appends one per terminal (`:215-217`). Verified against the live manifest —
`GET /panels` returns a `label` for all seven panels (`Board`, `Project`, `Memo`, `Artifacts`,
`Design`, `Setup`, `Terminals`), so the `if (panel.label)` guard passes for every icon. **Nothing is
missing.** The elements exist, and `:hover` really does set `opacity: 1`.

The geometry is what kills them. `#strip` (`shell.html:56-68`):

```css
#strip {
    flex: 0 0 48px;
    width: 48px;
    align-items: center;
    overflow-y: auto;
    overflow-x: hidden;   /* ← makes #strip a clip box on BOTH axes */
}
```

Two facts combine:

1. **`overflow-x: hidden` turns `#strip` into a clipping container.** Per the CSS overflow spec, when
   one axis is `visible` and the other is not, the `visible` axis computes to `auto` — so `overflow-y:
   auto` + `overflow-x: hidden` clips both axes. The strip needs `overflow-y: auto` (it scrolls when
   the fleet is large), so this clip is not incidental; it is load-bearing.

2. **The label is positioned entirely outside that box.** `.strip-icon` is `position: relative`
   (`shell.html:82`) and is 36px wide, centred by `align-items: center` in a 48px strip → the button's
   left edge sits at 6px. The label is `left: 44px` relative to the button, so it begins at
   **6 + 44 = 50px** from the strip's left edge, against a content box only **48px** wide. It starts
   2px past the clip edge and, being `white-space: nowrap`, extends far beyond it.

So the tooltip is painted fully outside the clip rectangle. `z-index: 100` cannot rescue it — z-index
orders paint within a stacking context; it does not exempt an element from an ancestor's overflow clip.
This is why the bug reads as "there are no tooltips" rather than "the tooltips are cut off": zero pixels
survive, not most of them.

Fleet terminal buttons are clipped **twice**. `#strip-terminals` (`shell.html:153-165`) is a nested
container with its own `overflow-y: auto; overflow-x: hidden` and `max-height: 40vh`, so their labels
are clipped by the inner box before the outer one even applies.

### Why it partly appears to work, which has hidden the bug

Fleet terminal buttons also set a **native** tooltip — `btn.title = t.worktreePath || t.name`
(`shell.js:204`). Native `title` tooltips are painted by the browser chrome, not the document, so
overflow cannot clip them. That means terminal icons *do* produce a (slow, unstyled) hover tooltip
showing a filesystem path, while panel icons and the theme toggle produce nothing at all — they carry
only `aria-label` (`shell.js:60`, `:97`), which is screen-reader-only and invisible to a sighted user.

That asymmetry is the tell: the strip looks like it has "some" tooltips, so the styled system has never
been suspected.

### Why the fix is a port, not an invention

The panels already solve exactly this problem. `src/webview/kanban.html` runs a **body-level portal
tooltip**: a single `#tooltip-overlay` div (`:3465`) styled `position: fixed; z-index: 9999`
(`:2045-2065`), positioned from `el.getBoundingClientRect()` and clamped to the viewport
(`:4111-4173`), driven by delegated `mouseover`/`mouseout` on `document` (with the explicit note that
these bubble and `mouseenter`/`mouseleave` do not). Because it is `position: fixed` and lives outside
the strip, no ancestor overflow can clip it. There are ~76 `data-tooltip` attributes across the panels
using this pattern.

The shell simply never got it — it hand-rolled an in-flow absolute label instead, and that choice is
what is incompatible with a scrolling 48px rail.

One thing does **not** port verbatim: kanban's placement logic prefers **above** the target and flips
below (`:4133-4137`). For a narrow left rail the tooltip must sit to the **right** of the icon, which
is what the current `left: 44px` design intends. The port needs a right-side placement with a
flip-to-left fallback, not a copy of the vertical logic.

## Metadata
- **Tags:** bugfix, ui, standalone, browser-shell, accessibility
- **Complexity:** 3
- **Repo:** `switchboard`

## User Review Required (decisions, with defaults)

1. **Port the portal into the shell, or extract it to a shared module?** Default: **port a small
   right-placed variant into `shell.js`**. The shell is deliberately dependency-light (it loads only
   `shell.js` and must work before any panel iframe is alive), and `kanban.html`'s copy is inline in a
   9000-line file rather than in `sharedUtils.js`, so extraction is a refactor of the panels, not of
   the shell. Alternative: lift the overlay into `sharedUtils.js` and have both consume it — cleaner,
   but widens blast radius to every panel for a shell bug.

2. **Keep, drop, or fold in the terminal buttons' native `title`?** Default: **fold it in and drop the
   `title`** — put the full `worktreePath` into the portal tooltip as a second line (the overlay
   already supports `white-space: pre-line`, `kanban.html:2054`) and delete `shell.js:204`. Leaving
   `title` in place means a styled tooltip and a native one both fire on the same hover.

3. **Should the tooltip include the terminal's activity state?** The `aria-label` already spells it out
   (`… [${t.light}]`, `shell.js:203`) precisely because the status dot encodes state by shape for
   non-colour-safe viewing. Default: **yes, include it**, so the sighted hover and the screen-reader
   label say the same thing.

4. **Keep `.strip-label` as a fallback?** Default: **delete it entirely** (CSS and all three JS call
   sites). A dead hover element that only works if someone later removes the overflow is worse than no
   element — it is what made this bug invisible.

## Dependencies

None.

Worth sequencing awareness, not a hard dependency: the *Browser Terminals — New Pane & Window
Capabilities* and *Terminals Sidebar* features touch `terminals.html`/`terminals.js`, not
`shell.html`/`shell.js`. The only overlap is the shell's fleet section reading terminal metadata
(`name`, `role`, `worktreePath`, `light`), whose shape this plan does not change.

## Proposed Changes

### 1. Add the portal overlay to the shell — `src/webview/shell.html`

- Add `<div id="tooltip-overlay"></div>` as a **sibling of `#strip` and `#content`** inside `<body>`,
  so it is outside every clipping container.
- Add its CSS, adapted from `kanban.html:2045-2065` but using the shell's own tokens (`--bg-elev`,
  `--border`, `--text`, `--font`) so it matches the strip rather than the panels: `position: fixed;
  z-index: 9999; pointer-events: none; white-space: pre-line; max-width: 320px;` with the existing
  `opacity`/`visibility` pair and the `.visible` class.
- **Delete** the `.strip-icon .strip-label` and `.strip-icon:hover .strip-label` rules
  (`:110-128`).

No CSP change needed: the shell's policy already allows `style-src 'unsafe-inline' 'self'`, and the
overlay is positioned by assigning to `element.style`, which is not CSP-gated.

### 2. Right-placed positioning + delegation — `src/webview/shell.js`

Add a small tooltip module mirroring `kanban.html:4111-4173`, with placement rewritten for a left rail:

- Measure off-screen first (`left/top = -9999px`, add `.visible`, then read `getBoundingClientRect()`) —
  the same measure-then-place trick kanban uses, needed because the text is variable width.
- **Horizontal:** `left = rect.right + GAP`. If that overflows `document.documentElement.clientWidth`,
  flip to `left = rect.left - tipWidth - GAP`; clamp to ≥4px.
- **Vertical:** centre on the icon (`top = rect.top + rect.height / 2 - tipHeight / 2`), clamped into
  `[4, clientHeight - tipHeight - 4]` so buttons near the top or bottom of a scrolled strip stay
  on-screen.
- Delegate on `document` with **`mouseover`/`mouseout`**, not `mouseenter`/`mouseleave` — kanban's
  comment at `:4158` records why (only the former bubble). Reuse its `relatedTarget` containment check
  so moving between a button and its own glyph child does not flicker.
- Hide on `scroll` of `#strip` and `#strip-terminals`, and on `click` — a `position: fixed` tooltip
  does not follow a scrolling target, so a strip scroll would leave it stranded beside the wrong icon.
  This case does not arise in kanban's usage and is the one genuinely new piece of logic.

### 3. Switch all three builders to `data-tooltip` — `src/webview/shell.js`

- `buildIcon` (`:53-89`): set `btn.dataset.tooltip = panel.label || panel.id`; remove the
  `.strip-label` block (`:78-83`). Dropping the `if (panel.label)` guard means a manifest entry with
  no label still gets a tooltip (its id) rather than silently none.
- `buildThemeToggle` (`:91-120`): set `btn.dataset.tooltip = 'Toggle Theme'`; remove `:101-103`.
  Consider reflecting the *next* theme ("Switch to Claudify") since the button already knows the
  current one — flagged, not assumed.
- Fleet terminal builder (`:190-220`): set
  `btn.dataset.tooltip = name · role · worktreeBase [light]` plus the full `worktreePath` on a second
  line; remove `btn.title` (`:204`) and the `.strip-label` block (`:215-217`). Keep `aria-label`
  (`:203`) exactly as-is — it is the accessible name, and the tooltip is not a substitute for it.

### 4. Disabled buttons must still explain themselves

`.strip-icon[disabled]` (`shell.html:105-109`) is used when the manifest reports `enabled: false`
(`shell.js:61`) — e.g. panels gated off when `node-pty` is unavailable (`bootstrap.ts:460`). A disabled
`<button>` in most browsers **suppresses `mouseover` on the element itself**, so a disabled icon would
be the one place still showing nothing — and it is the place a tooltip matters most.

Resolve by keeping the button enabled for hit-testing and gating the *action* instead: keep
`aria-disabled="true"` + the `.strip-icon[disabled]`-equivalent styling via a class, and return early
in the click handler (`shell.js:84-87` already does exactly this — `if (panel.enabled === false)
{ return; }`). Give disabled icons a tooltip that says why, e.g. `Terminals — unavailable (node-pty
not loaded)` where the manifest supplies a reason, falling back to `<label> — unavailable`.

### 5. Regression test

Add a shell UI test asserting, over the rendered strip:

- every `.strip-icon` (panel, theme toggle, terminal) carries a non-empty `data-tooltip`;
- no `.strip-label` element and no `.strip-label` CSS rule survives anywhere in `shell.html`/`shell.js`
  (the specific dead-code trap this plan closes);
- `#tooltip-overlay` is a direct child of `body`, not a descendant of `#strip` — the assertion that
  actually encodes the root cause, so re-nesting it re-breaks the build rather than the UI;
- no `.strip-icon` sets a native `title`.

Follow whatever harness the browser-shell tests already use; if the shell has no existing UI test,
assert structurally over the served HTML/JS text rather than standing up a new browser harness for this.

## Verification Plan

1. **Reproduce first, and prove the diagnosis rather than assuming it.** Boot the standalone CLI, open
   the shell, hover a panel icon → nothing. In devtools, select the `.strip-label` under that button
   and confirm it has non-zero dimensions and computed `opacity: 1` while hovered — i.e. it is
   *rendered and visible*, just clipped. Then set `#strip { overflow: visible }` live and confirm the
   label appears. That sequence distinguishes clipping from a missing element; if the label has zero
   dimensions or `opacity: 0` on hover, this plan's root cause is wrong and the fix must change.
2. **Every button.** After the fix, hover all seven panel icons, the theme toggle, and each fleet
   terminal button — each shows a styled tooltip. Confirm the correct text, notably `Artifacts` for
   the `planning` panel (the manifest label differs from the route id).
3. **No double tooltip.** Hover a terminal button and confirm exactly one tooltip and no slow native
   one appearing a second later.
4. **Clipping is genuinely escaped.** With enough terminals to make both `#strip` and `#strip-terminals`
   scroll, hover a terminal near the bottom — the tooltip renders fully, outside both boxes.
5. **Scroll behaviour.** Hover to show a tooltip, then scroll the strip with the wheel — the tooltip
   hides rather than floating beside the wrong icon.
6. **Edge flipping.** Narrow the window until the tooltip would overflow the right edge → flips to the
   icon's left. Hover the topmost and bottommost icons → stays fully on-screen.
7. **Disabled icons.** Boot with `node-pty` unavailable so the manifest reports `enabled: false`, and
   confirm the greyed icon still shows a tooltip explaining why, and still does not switch panels when
   clicked.
8. **Theme.** Toggle to Claudify and back; the tooltip's border/background follow the shell's tokens
   in both themes (the strip retints `--accent` per `shell.html:43-46`).
9. **Accessibility unregressed.** Every strip button keeps its `aria-label`; the fleet terminal label
   still spells out the activity state, so the shape-coded status dot (`shell.html:176-202`) still has
   a text equivalent. The overlay stays `pointer-events: none` and is not announced as content.
10. **Panels unaffected.** Open Board and hover a column icon — `kanban.html`'s own `#tooltip-overlay`
    still works. The shell's overlay lives in the parent document and the panels' in their iframes;
    confirm no duplicate or cross-frame tooltip.
11. `npm run lint` green.

## Uncertain Assumptions

- **That no ancestor establishes a containing block for `position: fixed`.** A `transform`, `filter`,
  `perspective`, `will-change` or `contain` on `body` or `#strip` would make a fixed-position tooltip
  clip anyway. Inspection of `shell.html` shows none — `body` is a plain flex row — but appending the
  overlay to `body` (change 1) is what makes this robust regardless, so verify the served DOM rather
  than trusting the source.
- **That `enabled: false` is currently reachable.** `bootstrap.ts:460` logs that panels are unaffected
  when `node-pty` is missing, so change 4's disabled path may be dormant today. It is still the
  documented meaning of `panel.enabled` (`shell.js:61`) and must not be the one hover that stays dead.
- **That the shell has no existing UI test harness.** Not confirmed; change 5 falls back to structural
  assertions if so.
- **That `title` on terminal buttons is not relied on by anything else** (a screenshot test, a doc).
  Grep before deleting.

## Out of Scope

- Redesigning the strip, adding text labels beside icons, or making it expandable.
- The panels' own tooltips inside their iframes — they already work.
- Extracting a shared tooltip module for every panel (see decision 1); this plan fixes the shell.
- Keyboard-triggered tooltips on focus. The `aria-label`s already give keyboard and screen-reader users
  the names; hover parity is the reported gap. Worth a follow-up, not a silent scope addition.
- Touch/mobile hover equivalents.
