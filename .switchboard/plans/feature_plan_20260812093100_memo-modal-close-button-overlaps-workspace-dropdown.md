# Memo Modal Close Button Overlaps The Workspace Dropdown

## Goal

Stop the shell's modal close button (`×`) from painting on top of the Memo panel's "Saving to" workspace `<select>`, so the dropdown's right edge and caret are clickable.

### Problem analysis

Opening the Memo modal in the browser cockpit puts the shell's `×` close button directly over the right-hand end of the memo panel's workspace dropdown. The caret is covered, and a click aimed at the dropdown closes the modal instead. The dropdown is still reachable by clicking its left portion, so the bug reads as flaky rather than total — which is worse.

### Root cause

Two independently-authored surfaces both claim the dialog's top-right corner, and neither knows about the other.

**The close button** is created by the shell and positioned against the dialog box, not against the panel content:

`src/webview/shell.html:188-202`
```css
#modal-close {
    position: absolute;
    top: 6px; right: 8px;
    z-index: 1;
    width: 26px; height: 26px;
    ...
}
```

It is appended to `#modal-dialog` (`src/webview/shell.js:44-54`), and `.modal-frame` — the iframe holding the memo panel — fills that same dialog at `width:100%; height:100%` (`shell.html:180-187`). So the button occupies `[dialogRight − 34px, dialogRight − 8px]` and paints **above** the iframe.

**The workspace dropdown** is the last child of a `justify-content: space-between` header inside the iframe, with 20px of right padding:

`src/webview/memo.html:57-62`
```css
.memo-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 12px 20px;
    ...
}
```

`space-between` pushes `.memo-workspace-row` hard against the header's right content edge, i.e. `dialogRight − 20px`.

The two ranges overlap by **12px** (the select's last 12px sit under the button, from `dialogRight − 20px` to `dialogRight − 8px`), and since the button lives in the parent document it wins the hit test unconditionally — z-index inside the iframe cannot compete with a sibling of the iframe.

This is a generic modal-host defect, not a memo-specific one: **any** panel presented with `presentation: 'modal'` that puts a control in its own top-right corner will collide. Memo is simply the only such panel today (`src/services/headlessPanelHtml.ts:521` is the sole `presentation: 'modal'` manifest row). The fix therefore belongs in the shell's modal host (reserve the corner), with the memo header cooperating (do not fill the reserved strip).

## Metadata

- **Complexity:** 2
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard
- **Feature:** 553bb8eb-08ba-483f-a892-e04c7c8ecd2b

## User Review Required

- None. The reserved width (42px), the decision to apply the memo padding unconditionally rather than behind an "am I in a modal?" class, and the decision to put the source of truth in `shell.html` are all settled below.

## Complexity Audit

### Routine

- Deriving `--modal-close-reserve` from the button's own geometry tokens in `shell.html`.
- Adding `padding-right` to `.memo-header` in `memo.html`.

### Complex / Risky

- **Nothing structural.** The one thing to get right is that the reservation must be a *contract the shell owns*, not a magic number copy-pasted into `memo.html`. A number that merely sits beside the button rots the moment the button is resized.

  > **Superseded:** Declare `--modal-close-reserve: 42px;` on `#modal-dialog` as a documented constant, with `#modal-close` keeping its own literal `right: 8px; width: 26px; height: 26px`.
  > **Reason:** A hand-maintained constant that nothing computes from is documentation, not a contract — nothing in the codebase breaks or changes if the button is resized to 32px and the token is left at 42px. The plan claimed `shell.html` is "the source of truth" while giving that claim no mechanism.
  > **Replaced with:** Give the button's inset and size their own tokens and **derive** the reserve from them with `calc()`. Resizing the button now moves the reserve automatically, so the shell-side half of the contract cannot drift. Only the memo-side mirror stays a literal (custom properties cannot cross an iframe boundary), and that one number is annotated with its owner.

- The two documents are separate CSS scopes; a custom property declared in `shell.html` is **not** inherited into the iframe. The reservation must be declared in both files, with the shell's value documented as the source of truth.
- `src/webview/shell.html` line 165-177 (`#modal-dialog`) is **co-edited by the sibling subtask** in this feature ("Memo Modal Is Oversized"). See `## Dependencies`.

## Edge-Case & Dependency Audit

1. **Cross-document CSS.** `#modal-dialog` and the memo document are different documents. CSS custom properties do not cross an iframe boundary. Declaring the tokens in `shell.html` and re-declaring the resolved value (`42px`) in `memo.html` with a comment naming the shell as the owner is the pragmatic contract; do not attempt to plumb it via `postMessage` for a static constant.
2. **Non-modal use of `memo.html`.** The memo panel is also reachable at `/memo` directly (the shell iframes `panel.route`) and, in the VS Code host, via the memo panel provider. Adding right padding there costs 22px of header space and no correctness — acceptable, and preferable to a conditional class that can desync.
3. **`implementation.html:1600` also hosts a `#memo-textarea`.** That is a different document with its own header; it is not inside the shell modal host and must not be touched.
4. **Other modal panels.** `modalPanels` is populated from the `/panels` manifest (`shell.js:649-654`); today `memo` is the only entry (`headlessPanelHtml.ts:521`). The shell-side reservation is what makes the next one safe, so land it even though only one panel consumes it now.
5. **Tooltip overlay.** `#tooltip-overlay` is body-level `position: fixed, z-index 9999` (`shell.html` comment at 155-161) and paints above the dialog. It is unaffected by this change.
6. **`data-tooltip`, never `title`.** `shell.js:48-51` documents that shell.js is asserted free of native `title` tooltips — the assertion lives in **two** places: `src/test/shell-modal-panel-contract.test.js` ("shell.js still sets no native title tooltips") and `src/test/shell-terminal-strip.test.js:503`. Do not add a `title` to the close button while working in this area.
7. **The select's own `title` is out of scope.** `memo.html:205` puts a native `title="Which workspace this memo is saved to…"` on `#memo-workspace-select`. It is in a different document, no assertion covers it, and removing it is a separate decision. Leave it.
8. **No confirmation dialogs.** Per `CLAUDE.md` — the close button closes immediately and must keep doing so.
9. **Theme parity.** `.memo-header` is painted in both the afterburner (`cyber-theme-enabled`, the default) and `theme-claudify` palettes; padding is theme-neutral, so no per-theme rule is needed. `src/test/memo-panel-style-contract.test.js` asserts that the default theme class does not repaint the panel — a padding change does not touch that assertion.
10. **Box model.** `shell.html:47` declares `* { box-sizing: border-box; margin: 0; padding: 0; }`, so the button's `width: 26px` is its border-box width and the arithmetic `8 + 26 + 8 = 42` holds as written. `memo.html` declares `* { box-sizing: border-box; }` likewise, so `padding-right: 42px` eats into the header's content box rather than widening it.
11. **Race conditions / security / side effects.** None — this is two static CSS declarations. No new listener, no new message, no new state.

## Dependencies

- `sess_none — no external session dependency.`
- **Intra-feature ordering (hard):** this subtask and *Memo Modal Is Oversized: Dead Space Below The Memo Swallows Backdrop-Dismiss Clicks* both edit the `#modal-dialog` rule in `src/webview/shell.html`. Land **this one first**, and run them in **one** agent stream — the project PRD's "one agent stream per provider file" contract applies (same-file parallel edits collide). The sibling plan's Proposed Changes shows the token block as pre-existing context it must preserve; if the order is reversed, this subtask must instead *add* its tokens to whatever `#modal-dialog` block it finds rather than replacing it.

## Adversarial Synthesis

**Risk summary.** Near-zero blast radius: two static CSS declarations, no new listener, no new state, no message traffic. The only real risks are (a) the shell-side reserve and the memo-side mirror silently drifting apart, mitigated by deriving the shell value with `calc()` and annotating the memo literal with its owner, and (b) a merge collision with the sibling subtask, mitigated by the hard ordering in `## Dependencies`. The cost of the fix being wrong is 22px of header whitespace, not a functional regression.

## Proposed Changes

### 1. `src/webview/shell.html` — make the reserved corner a derived, load-bearing token

**Context.** `#modal-dialog` (lines 165-177) is the positioning container for `#modal-close` (lines 188-202). Both are in the same rule region.

**Logic.** Name the button's two geometry inputs, derive the reserve from them, and make the button consume the same names — so the reserve can never disagree with the button it is reserving for.

**Implementation.** Amend `#modal-dialog` and `#modal-close`:

```css
        #modal-dialog {
            position: absolute;
            top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            width: min(820px, 92%);
            height: min(700px, 88%);
            background: var(--bg-elev);
            border: 1px solid var(--border);
            border-radius: 8px;
            box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
            overflow: hidden;
            display: flex;
            /* The strip of the dialog's top-right corner the close button owns.
               A modal panel's own document must keep its top-right controls clear
               of this width — the button is a SIBLING of the .modal-frame iframe,
               so it wins every hit test against anything inside the frame no
               matter what z-index the panel uses.
               DERIVED, not hand-set: #modal-close below consumes the same two
               tokens, so resizing the button moves the reservation with it.
               Panels re-declare the RESOLVED value (42px) in their own stylesheet
               because custom properties do not cross an iframe boundary; THIS
               declaration is the source of truth for that number. */
            --modal-close-inset: 8px;
            --modal-close-size: 26px;
            --modal-close-reserve: calc(var(--modal-close-inset) * 2 + var(--modal-close-size));  /* 42px */
        }
```

```css
        #modal-close {
            position: absolute;
            top: 6px;
            right: var(--modal-close-inset);
            z-index: 1;
            width: var(--modal-close-size);
            height: var(--modal-close-size);
            border: 1px solid transparent;
            border-radius: 4px;
            background: transparent;
            color: var(--text-dim);
            font-family: var(--font);
            font-size: 18px;
            line-height: 1;
            cursor: pointer;
        }
```

**Edge cases.** `#modal-close` is a child of `#modal-dialog`, so both tokens inherit; no `:root` declaration is needed or wanted. `#modal-close:hover` (line 203) is unchanged. The `height` line is left exactly as it is today — the sibling subtask owns it.

### 2. `src/webview/memo.html` — keep the header out of the reserved strip

**Context.** `.memo-header` (lines 57-62) is a `space-between` flex row whose last child is the workspace `<label>`/`<select>` pair.

**Logic.** Widen the header's right padding to the reserved width so `space-between` stops flush with the strip instead of under it. Applied unconditionally — see edge case 2.

**Implementation.**

```css
        /* Reserved corner: the shell's modal close button (#modal-close in
           shell.html) is a SIBLING of this document's iframe and paints above it,
           so a control flush to the right edge is un-clickable in its last ~12px.
           42px mirrors #modal-dialog's --modal-close-reserve; shell.html owns that
           number and derives it from the button's own geometry — if you change it
           there, change it here. Applied unconditionally: the panel is also served
           standalone at /memo and inside the VS Code webview host, where the cost
           is 22px of header whitespace and no correctness. */
        .memo-header {
            display: flex; align-items: center; justify-content: space-between;
            gap: 12px; padding: 12px 20px;
            padding-right: 42px;
            border-bottom: 1px solid var(--border-color);
            background: var(--panel-bg);
        }
```

**Edge cases.** `padding-right` must come **after** the `padding` shorthand or the shorthand resets it. `.memo-workspace-select` keeps `max-width: 240px`, so the header does not wrap at the `92%` narrow-window branch (see verification step 6).

## Verification Plan

Manual, in the browser cockpit. Per session directive, no compilation step and no automated test run is part of this plan.

1. **The reported bug is gone.** Open the browser cockpit, open the Memo modal. The `×` sits clear of the `<select>` with a visible gap; clicking the select's right edge / caret opens the dropdown rather than closing the modal.
2. **Measure, don't eyeball.** In devtools, in the shell document: `document.getElementById('modal-close').getBoundingClientRect()`; in the memo frame: `document.getElementById('memo-workspace-select').getBoundingClientRect()`. Assert `select.right <= close.left`.
3. **The token is load-bearing.** In devtools, set `--modal-close-size: 40px` on `#modal-dialog`. Confirm the computed `--modal-close-reserve` becomes `56px` and the button grows — proving the derivation is live, not decorative. (Revert; the memo mirror is expected NOT to follow — that is the documented iframe-boundary limitation, not a bug.)
4. **Close still works.** Click the `×` — the modal closes immediately, no confirm.
5. **Escape still works.** With focus in the memo textarea, press Escape; the modal closes (exercises `wireModalFrameKeys`, `shell.js:98-108`).
6. **Backdrop click still works.** Click the dimmed area outside the dialog; the modal closes.
7. **Dropdown functions.** Change the workspace in the select; type a line, reopen, and confirm the memo persisted to the newly-selected workspace.
8. **Narrow window.** Resize the browser to ~700px wide so `#modal-dialog` uses the `92%` branch. The reservation still holds and the header does not wrap.
9. **Standalone route.** Load `/memo` directly (no shell). The header renders with the extra right padding; nothing is clipped or misaligned.
10. **Both themes.** Toggle the theme in the rail; header and button spacing are identical in afterburner and claudify.

### Automated Tests

None added, and none run in this pass (session directive). Two existing source-text contracts sit next to this change and must not be broken by it:

- `src/test/shell-modal-panel-contract.test.js` — asserts `shell.html`'s body markup shape and that `shell.js` sets no native `title`. This change touches neither the body markup nor `shell.js`.
- `src/test/memo-panel-style-contract.test.js` — asserts the token palette and that the default theme class does not repaint the panel. A padding declaration touches neither.

## Recommendation

Complexity 2 → **Send to Intern.** Land before the sibling subtask; same agent stream.
