# Board Collapse 06 — Write the Markdown Editor Scroll-Sync Plan

## Goal

Replace the two conflicting markdown-editor subtasks with one plan that addresses the actual cause: the editor and the preview hold different heights for the same content, so they never line up. This is the one genuine authoring job in the Board Collapse feature — a new technical plan written from scratch, not a board edit.

### Problem analysis

The shared markdown editor renders a live preview beside the textarea. A single source line such as `![alt](path.png)` occupies one text row on the left and a full-height image on the right. Every image, and to a lesser degree every heading and code block, adds height on one side and not the other. The two columns drift apart in proportion to how many images a document has.

Two subtasks of *The Shared Markdown Editor Stops Fighting the Operator* each set `.md-editor-shell` to the opposite value and neither addresses this:

- *Markdown editor toolbar scrolls out of reach* removes `overflow: hidden` so the shell grows to document height and the host pane scrolls, with a sticky toolbar. Under that design editor and preview scroll together as one block, so past the first image the two panes are permanently misaligned by the accumulated height difference. It guarantees they never line up.
- *Markdown Editor Independent Preview Scrolling and Inline Image Sizing* gives the shell a definite height and makes the textarea and preview each scroll independently. That fixes the toolbar for a different reason but hands the operator two scrollbars to keep level by hand, which drift apart again on every keystroke.

The feature file says "land them together as a single layout pass" without reconciling the contradiction. Operator decision, 2026-09-04: neither. The correct fix is content-anchored scroll synchronisation.

Verified at HEAD (`src/webview/markdownEditor.js`, 605 lines): the preview is rebuilt wholesale via `preview.innerHTML = html` in `triggerRender`, debounced 200 ms on input, with live preview disabled above 30,000 characters. There is no scroll coupling of any kind today, and no source-position information survives rendering. `renderMarkdown` in `sharedUtils.js` is a hand-rolled line-oriented renderer; a separate plan may later replace it with `marked`, so the design must not depend on which renderer produced the HTML.

## Metadata

- **Complexity:** 6
- **Tags:** webview, markdown-editor, ux, plans

## Proposed Changes

This subtask produces **one new plan file** and removes two. It writes no code.

### 1. Author the plan

Title: *The Editor and the Preview Stay Level*. It must specify:

- **Two independent scrollers, one driver.** The shell is bounded and the textarea and preview each scroll. Only the pane the operator is actually scrolling drives; the other follows, with a re-entrancy flag so the follower's programmatic scroll does not drive back.
- **An anchor map, rebuilt on every render.** Each heading and each image in the source is paired with the corresponding element in the preview, matched by document order rather than by any marker the renderer must emit — so the map survives a renderer swap. The document start and end are always anchors.
- **Source-side measurement through a mirror element.** A textarea gives no per-line geometry, so a hidden div with identical font, width, padding and `white-space` settings is used to measure the pixel offset of each anchor line. Wrapped lines are therefore measured correctly.
- **Re-measurement on image load.** An image's height is unknown until it loads, and that is the moment the two columns diverge. Each preview image gets a load listener that remeasures its anchor and, if the operator is not mid-scroll, re-applies the current alignment.
- **Piecewise-linear mapping between anchors.** A scroll position converts to "between anchor *n* and *n+1*, fraction *f*", and the other pane is set to the same fraction between the same two anchors. Between anchors the mapping is linear; at every anchor it re-locks exactly. Images therefore stop accumulating error.
- **The caret stays level after a re-render.** Following a debounced re-render the preview is repositioned to the anchor interval containing the caret line, rather than left at its previous pixel offset.
- **Behaviour above the 30,000-character live-preview cutoff**, where the preview is a placeholder and there is nothing to sync.
- **Images capped at `max-width: 100%`** in the preview, carried over from the preview-scroll subtask, so a wide image no longer forces horizontal scroll or a large vertical gap.
- **The host-panel flex height chains** in `planning.html`, `tickets.html`, `design.html` and `project.html` made definite, also carried over, because a bounded shell requires them.
- **No mode toggle and no lock button.** Synchronisation is always on.
- **Acceptance criteria**, including the one inherited from the toolbar subtask: the toolbar is visible at every scroll position of a long document. Plus the load-bearing one: in a document with several images, the heading at the top of the editor is the heading at the top of the preview, before and after the images have loaded.

Verification in the authored plan must be UAT on an installed VSIX against a real ticket with inline images — the live server serves the VSIX's `dist/`, not `src/`.

### 2. Replace the cards

- Create the new plan file in `.switchboard/plans/`.
- Delete *Markdown editor toolbar scrolls out of reach on long docs and tickets* and *Markdown Editor Independent Preview Scrolling and Inline Image Sizing*.
- Feature *The Shared Markdown Editor Stops Fighting the Operator* then has no subtasks. Remove it; the new plan sits loose in Planned.
- Note in the new plan that `tickets.js` near line 3100 and the tickets edit-mode entry are also edited by *Markdown editor missing from the Tickets panel* and *Safe Auto-Sync*, so those three serialise.

## Verification Plan

- Exactly one active plan addresses markdown editor scrolling, and its Goal names the height divergence caused by inline images as the cause.
- Neither superseded subtask remains on the board; the feature is gone.
- The new plan contains no `overflow` directive presented as the fix in itself, and no mode toggle.
- The new plan's acceptance criteria include both the toolbar-visibility line and the heading-alignment line.
- `git status` shows only `.switchboard/` changes.
