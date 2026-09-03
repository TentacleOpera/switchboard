# The Editor and the Preview Stay Level

## Goal

In the shared markdown editor's split view, the content at the top of the textarea is the content at the top of the preview, and it stays that way as the operator scrolls, types, and as images finish loading. Scrolling either pane moves the other to the matching place.

### Problem analysis

The editor renders a live preview beside the textarea. A single source line such as `![alt](path.png)` occupies one text row on the left and a full-height image on the right. Headings, code blocks and loose lists add smaller divergences in the same direction. The two columns therefore hold **different heights for the same content**, and the difference accumulates down the document in proportion to how many images it contains.

Nothing in `src/webview/markdownEditor.js` couples the two panes today. Worse, they are not even scrolled by the same thing:

- `.md-live-preview` has `overflow-y: auto` and `height: 100%` — it scrolls **internally**.
- `textarea.markdown-editor` has `height: auto` and no overflow rule — it **grows**, and whatever host pane contains the shell is what scrolls it.
- `.md-editor-shell` has `overflow: hidden` and `min-height: 480px`; `.md-body` has `flex: 1` and `overflow: hidden`.

So the operator is already scrolling two different surfaces with two different scrollbars, and the preview's own scroll position is not related to the textarea's at all.

The metrics differ too, which rules out any proportional or ratio-based coupling: the textarea is 13px `var(--font-code)`, the preview is 14px `var(--font-sans)` at `line-height: 1.6`. Even a document with no images does not map linearly from one pane to the other.

**Two earlier plans, now deleted, each addressed a symptom and neither addressed this.**

*Markdown editor toolbar scrolls out of reach on long docs and tickets* proposed removing `overflow: hidden` from the shell so it grows to document height, letting the host pane scroll everything with a sticky toolbar. Under that design editor and preview scroll as one block, so past the first image they are misaligned by the accumulated height difference and can never be brought back into line. It guarantees the panes never match.

*Markdown Editor Independent Preview Scrolling and Inline Image Sizing* proposed a definite-height shell with each pane scrolling independently. That is the right substrate but, on its own, it hands the operator two scrollbars to keep level by hand, and they drift apart again on every keystroke.

Operator decision, 2026-09-04: neither. The fix is content-anchored synchronisation, which subsumes both — the toolbar stays reachable because it sits outside the scrollers, and the panes scroll independently but are driven as one.

## Metadata

- **Complexity:** 6
- **Tags:** webview, markdown-editor, ux

## User Review Required

None.

## Proposed Changes

### 1. Bound the shell so both panes scroll internally

In the injected CSS in `markdownEditor.js`:

- `.md-editor-shell` gains a definite height so it is a bounded flex column rather than a growing block. Keep `overflow: hidden` — it is what makes the shell the scroll boundary — and keep `min-height: 480px` as the floor.
- `.md-body` keeps `flex: 1; overflow: hidden` and gains `min-height: 0`, without which a flex child refuses to shrink below its content and the internal scroll never engages.
- `textarea.markdown-editor` changes from `height: auto` to `height: 100%` with `overflow-y: auto`, so it scrolls itself instead of growing.
- `.md-live-preview` is unchanged; it already scrolls.
- `.md-toolbar` sits above `.md-body` in the shell and is outside both scrollers, so it is always visible. No `position: sticky` is required, which is why the deleted toolbar plan's goal is met without its mechanism.
- Preview images get `max-width: 100%; height: auto` so a wide image neither forces horizontal scroll nor inflates the divergence.

The host panels each need a definite height chain for `height: 100%` to resolve. Add `min-height: 0` and the necessary `height`/`overflow` to the intermediate containers in `planning.html`, `tickets.html`, `design.html` and `project.html`. This is the one part of the deleted preview-scroll plan that is carried over verbatim, and it must be verified in all four panels, not just the one used for development.

### 2. Build an anchor map on every render

`triggerRender` already rebuilds the preview wholesale (`preview.innerHTML = html`) after a 200 ms debounce. Immediately after that assignment, build a map of paired positions.

An **anchor** is a construct that exists identifiably in both the source text and the rendered output, in the same order:

- every ATX heading line (`^#{1,6}\s`)
- every image (`![...](...)`, matched to `preview.querySelectorAll('img')`)
- every fenced code block opener
- the document start and the document end, always

Match **by document order**, not by any marker the renderer must emit: take the *n*th heading in the source and the *n*th heading element in the preview. This is what keeps the design independent of which renderer produced the HTML, and it matters because `renderMarkdown` in `sharedUtils.js` is a hand-rolled line-oriented renderer that a separate plan may replace with `marked`. If the counts on the two sides disagree — which a malformed document can cause — fall back to the document-start and document-end anchors alone, which degrades to proportional scrolling rather than breaking.

Each anchor records the source line index, its measured pixel offset in the textarea, and the `offsetTop` of the matched preview element.

### 3. Measure source offsets with a mirror element

A textarea exposes no per-line geometry. Create one hidden `div` per editor instance, appended beside the textarea, and copy from the textarea's computed style: `font-family`, `font-size`, `line-height`, `letter-spacing`, `padding`, `border-width`, `white-space`, `word-wrap`/`overflow-wrap`, `tab-size`, and the exact content-box `width`. Set it `position: absolute; visibility: hidden; height: auto`.

To measure the offset of source line *n*, set the mirror's text to the source up to that line and read its `scrollHeight`. Doing this once per anchor per render is acceptable; measuring per scroll event is not.

Copying the width is the load-bearing part: without it, wrapped lines are measured at the wrong height and every anchor below the first wrap is wrong. Re-measure on container resize, using a `ResizeObserver` on `.md-body`.

### 4. Map piecewise-linearly between anchors

Scrolling one pane converts its position to "between anchor *i* and *i+1*, fraction *f*", and sets the other pane to the same fraction between the same two anchors:

```
targetScroll = anchor[i].other + f * (anchor[i+1].other - anchor[i].other)
```

Between anchors the mapping is linear; **at every anchor it re-locks exactly**. This is the property that makes images stop mattering: an image's height difference is absorbed entirely within the interval that contains it, and everything below it is realigned at the next anchor.

One driver at a time. On `scroll`, the pane that received the event becomes the driver for a short window; the follower's programmatic `scrollTop` assignment must not make it the driver in turn. Use a flag cleared on the next animation frame rather than a timer.

### 5. Keep the caret level after a re-render

After the debounced re-render replaces the preview's DOM, the preview's `scrollTop` refers to elements that no longer exist. Reposition it to the anchor interval containing the **caret line**, derived from `textarea.selectionStart`, rather than restoring the previous pixel offset. The operator's editing position stays framed on both sides while typing.

### 6. Re-measure when an image loads

An image's height is unknown until it loads, and that is precisely the moment the two columns diverge. Attach a `load` listener to each preview `img` when the map is built. On load, re-measure that anchor's `offsetTop` and every anchor after it, and re-apply the current alignment if the operator is not mid-scroll. Also handle `error`, where the broken-image placeholder has its own height.

Ticket previews are the common case here and are already the subject of *Tickets Panel: Inline Images Are Blank On First View*, whose one-shot retry changes an image's height a second time. That plan's retry must therefore also fire the re-measure; note the coupling in both.

### 7. Scope, and what is deliberately not built

- Synchronisation is **always on**. No toggle, no lock button, no setting.
- It runs **only in `view-split`**. `view-edit` and `view-preview` show one pane and need no coupling; the shell's view classes already gate this.
- It is **inactive above the 30,000-character cutoff**, where `triggerRender` replaces the preview with a "Live preview paused" placeholder and forces edit mode. There is nothing to align.
- No renderer change. No source-position markers injected into the HTML.
- No change to `renderMarkdown` in `sharedUtils.js`.

## Edge-Case & Dependency Audit

1. **Anchor counts disagree between source and preview.** Fall back to start-and-end anchors, which yields proportional scrolling. Never throw; a misaligned preview is a nuisance, a broken editor is not.
2. **A document with no headings and no images.** Two anchors, proportional mapping, which is correct for uniform text.
3. **An image taller than the viewport.** The interval containing it maps a few source lines onto a large preview span. Scrolling through it in the preview moves the textarea very little. That is the honest mapping; do not clamp it.
4. **Rapid typing.** The map rebuilds at most every 200 ms with the existing debounce. Do not rebuild on every keystroke.
5. **Resize.** A `ResizeObserver` on `.md-body` invalidates the mirror width and re-measures. Coalesce to one animation frame.
6. **View mode switch.** Entering `view-split` rebuilds the map, because the pane widths change and every wrapped-line measurement with them.
7. **The `md-editor-shell` height change is a shipped-surface change.** Four host panels embed this editor. Verify all four; a definite height that fails to resolve in one of them collapses the editor to `min-height`.
8. **`.md-live-preview` already has `height: 100%`,** so it is the pane most likely to be already correct. The textarea is the one changing behaviour.
9. **Mobile layout.** Below 640px `.md-body` becomes `flex-direction: column`. Sync still applies; the mirror width must come from the textarea's live content-box width, not a cached value.

## Dependencies

- **Serialise with two tickets plans** on the edit-mode entry region of `tickets.js` (around 3073 to 3123, and the textarea inline style near 3100): *Markdown editor missing from the Tickets panel*, which rewrites `enterTicketsEditMode` to be async, and *Safe Auto-Sync*, which adds edit-mode messaging in the same functions. Any order works; they must not be authored in parallel.
- **Coupled with** *Tickets Panel: Inline Images Are Blank On First View* — its retry changes image heights after first paint and must trigger the re-measure in change 6.
- Independent of the renderer-replacement work by design.

## Verification Plan

Verification is UAT on an installed VSIX. The live server serves the VSIX's `dist/`, not `src/`, so a source-only change proves nothing here.

1. **The headline test.** Open a ticket with at least four inline images in split view. Scroll the textarea to a heading below the third image. The same heading is at the top of the preview. Repeat driving from the preview.
2. Repeat test 1 **before the images have finished loading**, then again after. The alignment corrects itself on load rather than staying off by the images' height.
3. Type in the middle of a long document. After the re-render settles, the caret's line is still framed in the preview.
4. Scroll to the very bottom of either pane; the other is also at its bottom. Same at the top.
5. A document with no images and no headings scrolls proportionally with no jumps.
6. **The toolbar is visible at every scroll position of a long document**, in all four host panels. This is the acceptance criterion inherited from the deleted toolbar plan.
7. A wide image does not produce horizontal scrolling in the preview.
8. Switch to edit-only and preview-only and back to split; no errors, and the alignment is correct after the switch.
9. Resize the panel narrow enough to wrap many lines; alignment holds, confirming the mirror width is live.
10. Open a document over 30,000 characters; the preview shows the paused placeholder and nothing throws.
11. Regression: the editor still renders at `min-height: 480px` in a short document, and the surface colours are unchanged — `.md-editor-shell` and `.md-live-preview` must stay byte-identical in background, per the existing comment in the CSS.
