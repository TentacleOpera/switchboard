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
- **Tags:** bugfix, ui, ux
- **Complexity:** 3
- **Project:** browser-switchboard

> **Superseded:** Tags were `bugfix, ui, standalone, browser-shell, accessibility`, and a `**Repo:** `switchboard`` line was present.
> **Reason:** `standalone`, `browser-shell`, and `accessibility` are not in the allowed tag list (the a11y aspect is covered by `ux`); the improvement session is single-repo, so no **Repo:** line is emitted.
> **Replaced with:** `bugfix, ui, ux`, no **Repo:** line, and a **Project:** pin for browser-switchboard.

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

## Complexity Audit

### Routine
- Two small self-contained files touched (`shell.html`, `shell.js`); no TypeScript compiled surface.
- The pattern being ported is proven in-repo (`kanban.html`'s overlay, ~76 existing `data-tooltip`
  consumers) — this is a port, not an invention.
- Deletions dominate: `.strip-label` CSS, three JS call sites, one `title` assignment.
- No CSP, manifest, verb, schema, or provider changes; VS Code host unaffected (shell is
  standalone-only).

### Complex / Risky
- The one genuinely new logic piece is tooltip lifecycle beside a **mutating** rail: hide on strip
  scroll (absent in kanban's usage) and hide on the terminal section's full rebuild
  (`container.innerHTML = ''`, `shell.js:185`), which can remove the hovered target mid-hover so
  `mouseout` never fires.
- Right-side placement with flip-to-left is new geometry relative to kanban's above/below logic.

## Edge-Case & Dependency Audit

- **Race Conditions:** `renderTerminalSection` rebuilds every terminal button on each
  `terminalFleetState` postMessage (`shell.js:185`). A fleet update landing mid-hover removes the
  tooltip's target element without a `mouseout`, stranding the tooltip. Mitigation: hide the tooltip
  at the top of `renderTerminalSection` (and on any strip DOM rebuild), in addition to scroll/click.
- **Security:** Tooltip text assigned via `textContent` (as kanban does), never `innerHTML` — a
  hostile `worktreePath` or panel label renders as text, not markup. No CSP change required
  (`style-src 'unsafe-inline' 'self'` already permits `element.style` writes).
- **Side Effects:** Removing `btn.title` (`shell.js:204`) ends the native-tooltip asymmetry; nothing
  else consumes it (grepped — no test or doc relies on it). The overlay is `pointer-events: none`,
  so it cannot swallow clicks aimed at the strip or the iframe content.
- **Dependencies & Conflicts:** None. The *Browser Terminals — New Pane & Window Capabilities* and
  *Terminals Sidebar* features touch `terminals.html`/`terminals.js`, not `shell.html`/`shell.js`;
  the only shared surface is the terminal metadata shape (`name`, `role`, `worktreePath`, `light`),
  which this plan does not change.

## Dependencies

None.

Worth sequencing awareness, not a hard dependency: the *Browser Terminals — New Pane & Window
Capabilities* and *Terminals Sidebar* features touch `terminals.html`/`terminals.js`, not
`shell.html`/`shell.js`. The only overlap is the shell's fleet section reading terminal metadata
(`name`, `role`, `worktreePath`, `light`), whose shape this plan does not change.

## Adversarial Synthesis

Key risks: the original change 4 targeted a code path that does not exist (disabled panels are
**omitted**, not greyed — `shell.js:294`), the terminal strip's full rebuild on every fleet-state
push can strand a tooltip on a removed target, and the flip-to-left fallback clamps over the icon
itself in a 48px rail. Mitigations: change 4 superseded to a no-op, hide the tooltip on strip DOM
rebuild as well as scroll/click, and accept the flip clamp as a degenerate-window cosmetic case.
Overall risk stays low — the ported pattern is proven in-repo and the change is deletion-heavy.

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
- Hide on `scroll` of `#strip` and `#strip-terminals`, on `click`, and **on terminal-section
  rebuild** — a `position: fixed` tooltip does not follow a scrolling target, so a strip scroll
  would leave it stranded beside the wrong icon. Worse, `renderTerminalSection` clears with
  `container.innerHTML = ''` (`shell.js:185`) on every fleet-state push: if the hovered button is
  removed mid-hover, no `mouseout` ever fires and the tooltip strands beside empty space. Call the
  hide function at the top of `renderTerminalSection`. The scroll case does not arise in kanban's
  usage and the rebuild case is shell-specific — these are the genuinely new pieces of logic.

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

### 4. Disabled buttons — no work needed (superseded)

> **Superseded:** The claim that `.strip-icon[disabled]` "is used when the manifest reports
> `enabled: false`" and therefore disabled icons need a hit-testing workaround so they can still
> show a tooltip (keep the button enabled, gate the action, add an "unavailable" tooltip).
> **Reason:** The premise is false against the code. `renderManifest` **omits** disabled panels
> entirely — `if (panel.enabled === false) { continue; }` (`shell.js:294`), with a deliberate
> design comment at `:289-293`: a capability the host lacks is "a dead control the user can never
> turn on — it just reads as 'broken'", matching PRD contract #6 (capability-gating honesty —
> absent, not disabled). `buildIcon` is never called for a disabled panel, so `btn.disabled = true`
> (`shell.js:61`) and the `[disabled]` CSS (`shell.html:105-109`) are dead code today, and no
> disabled icon is ever rendered to hover over. The manifest does carry `enabled` flags
> (`headlessPanelHtml.ts:468-475`, e.g. `terminalsEnabled` false when `node-pty` is missing), but
> the shell's contract is omission.
> **Replaced with:** Nothing. No disabled-icon tooltip work, no hit-testing change, no
> "unavailable" copy. Leave the dead `btn.disabled` line and `[disabled]` CSS untouched — removing
> them is a separate cleanup, out of scope for this plan.

### 5. Regression test — extend `src/test/shell-terminal-strip.test.js`

> **Superseded:** "Follow whatever harness the browser-shell tests already use; if the shell has no
> existing UI test, assert structurally over the served HTML/JS text rather than standing up a new
> browser harness for this."
> **Reason:** The harness already exists and was missed: `src/test/shell-terminal-strip.test.js`
> runs source-text contract tests over `shell.html`/`shell.js` (`fs.readFileSync` + marker-block
> assertions against the real files) — exactly the structural style the fallback described. There is
> no browser harness, and none is needed.
> **Replaced with:** Add the assertions below as new tests in
> `src/test/shell-terminal-strip.test.js`, using its existing `block()`/regex idiom.

Assert, over the real `shell.html`/`shell.js` source text (and the rendered strip where practical):

- every `.strip-icon` (panel, theme toggle, terminal) carries a non-empty `data-tooltip`;
- no `.strip-label` element and no `.strip-label` CSS rule survives anywhere in `shell.html`/`shell.js`
  (the specific dead-code trap this plan closes);
- `#tooltip-overlay` is a direct child of `body`, not a descendant of `#strip` — the assertion that
  actually encodes the root cause, so re-nesting it re-breaks the build rather than the UI;
- no `.strip-icon` sets a native `title`.

## Verification Plan

### Automated Tests

None run in this pass — the session directive skips automated tests and compilation. The
source-text contract tests in change 5 are authored, not executed, here; run them in the coding
session.

### Manual

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
5. **Scroll & rebuild behaviour.** Hover to show a tooltip, then scroll the strip with the wheel —
   the tooltip hides rather than floating beside the wrong icon. Then hover a terminal button and
   trigger a fleet-state change (start or stop a terminal in another client) — the tooltip hides on
   the section rebuild instead of stranding beside a removed button.
6. **Edge flipping.** Narrow the window until the tooltip would overflow the right edge → flips to the
   icon's left. Hover the topmost and bottommost icons → stays fully on-screen.
7. **Disabled panels are absent, not greyed.** Boot with `node-pty` unavailable so the manifest
   reports `enabled: false` for Terminals — confirm the Terminals icon simply does not appear in the
   strip (the deliberate omission contract, `shell.js:294`), and every icon that does appear shows a
   tooltip. (Supersedes the original "greyed icon still shows a tooltip" check — see change 4.)
8. **Theme.** Toggle to Claudify and back; the tooltip's border/background follow the shell's tokens
   in both themes (the strip retints `--accent` per `shell.html:43-46`).
9. **Accessibility unregressed.** Every strip button keeps its `aria-label`; the fleet terminal label
   still spells out the activity state, so the shape-coded status dot (`shell.html:176-202`) still has
   a text equivalent. The overlay stays `pointer-events: none` and is not announced as content.

10. **Panels unaffected.** Open Board and hover a column icon — `kanban.html`'s own `#tooltip-overlay`
    still works. The shell's overlay lives in the parent document and the panels' in their iframes;
    confirm no duplicate or cross-frame tooltip.
11. `npm run lint` green.

> **Superseded:** The previous **## Uncertain Assumptions** section listed four open items: no
> containing block for `position: fixed`; whether `enabled: false` is reachable; whether a shell UI
> test harness exists; whether `btn.title` is relied on elsewhere.
> **Reason:** All four were resolved by direct code inspection during the improve pass — (1)
> `shell.html` has no `transform`/`filter`/`perspective`/`will-change`/`contain` on `body` or
> `#strip` (verified); (2) the manifest does carry `enabled` flags (`headlessPanelHtml.ts:468-475`)
> but `renderManifest` omits disabled panels (`shell.js:294`), so change 4 was superseded; (3)
> `src/test/shell-terminal-strip.test.js` exists and is the harness for change 5; (4) a grep of
> `src/test` shows nothing relies on the terminal buttons' `title`.
> **Replaced with:** No remaining uncertainties — no web research required.

## Out of Scope

- Redesigning the strip, adding text labels beside icons, or making it expandable.
- The panels' own tooltips inside their iframes — they already work.
- Extracting a shared tooltip module for every panel (see decision 1); this plan fixes the shell.
- Keyboard-triggered tooltips on focus. The `aria-label`s already give keyboard and screen-reader users
  the names; hover parity is the reported gap. Worth a follow-up, not a silent scope addition.
- Touch/mobile hover equivalents.

---

## Completion Report

Implemented the portal-tooltip port exactly as planned: `src/webview/shell.html` gained a body-level `#tooltip-overlay` (sibling of `#strip` and `#content`, `position: fixed; z-index: 9999; pointer-events: none; white-space: pre-line`, styled on the shell's own tokens) and lost the `.strip-icon .strip-label` / `:hover` CSS rules; `src/webview/shell.js` gained a right-placed tooltip module (measure-off-screen-then-place, flip-to-left fallback, vertical clamping, delegated `mouseover`/`mouseout` with the `relatedTarget` containment check) with hides on capture-phase rail scroll, click, and at the top of `renderTerminalSection` before its `innerHTML = ''` wipe. All three builders now set `data-tooltip` (`buildIcon` from `panel.label || panel.id` with the label-guard dropped, theme toggle `'Toggle Theme'`, terminals `name · role · worktreeBase [light]` plus the full `worktreePath` on a second line), and the native `btn.title` was deleted; `aria-label`s are untouched. `src/test/shell-terminal-strip.test.js` gained five source-text contract tests: non-empty `data-tooltip` on every builder, zero surviving `strip-label` traces, overlay-is-a-body-sibling (the root-cause guard), no native `title`, and hide-before-wipe ordering. Issues: one self-caught defect — a code comment in `shell.html` literally contained the string `.strip-label`, which would have tripped the dead-code guard; reworded before landing. Per session directives, compilation and automated tests were not run; `node --check src/webview/shell.js` passes, and the new contract tests are authored, not executed (they run under `node src/test/shell-terminal-strip.test.js`).
