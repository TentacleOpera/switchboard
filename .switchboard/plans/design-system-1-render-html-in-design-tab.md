# Plan: Design System #1 — Make the Design System Tab See and Render HTML

## Goal
Make an **HTML design system a first-class, selectable, renderable artifact** in the Design System tab. Add `.html`/`.htm` to the design-docs file walker and route the tab's preview through the iframe renderer that already exists elsewhere in the same panel. This is the root of the whole initiative: until the tab can see an HTML design system, nothing downstream (binding it to a project, extracting its tokens, injecting it into prompts) has an artifact to operate on.

### Problem Context
The real-world design system this initiative exists to serve is an HTML page — e.g. `/Users/patrickvuleta/Documents/GitHub/patrickwork/designs/viaapp-design-system.html` (869 lines, ~72 KB, 14 `<section>` blocks of rendered swatches, type specimens, and component examples). That file is **not merely unpreviewable in the Design System tab — it never appears in the tree at all.**

The design-docs walker's whitelist, `_isDesignOrImageFile` (`src/services/LocalFolderService.ts:1193`), accepts:
`.md .txt .markdown .rst .adoc .png .jpg .jpeg .gif .svg .json .css .scss .less .sass .yaml .yml .xml`

It accepts CSS, SCSS, and XML — and **excludes `.html`/`.htm`**. So `listDesignFiles()` (`:1068`) never returns the file, `_sendDesignDocsReady` (`src/services/DesignPanelProvider.ts:1327`) never maps it to a tree node, and the tab's empty state accurately describes what it supports: *"Select a design document, image, JSON, or YAML file from the sidebar to preview"* (`src/webview/design.html:3714`).

Meanwhile the capability already exists three times over in the same webview:
- **A working HTML iframe renderer** — `html-preview-frame` with `injectBaseTag`, `srcdoc`, fit-on-load and zoom (`src/webview/design.js:1516`–`1541`).
- **A second working HTML renderer** — `stitch-html-preview-frame` (`:1595`–`1618`).
- **HTML-aware tree grouping that is dead code** — `getDocType` (`:985`) already maps `.html`/`.htm` → `'html'`, and `groupDocsByType` (`:996`) already builds an `html` group with a `TYPE_LABELS.html = 'HTML'` label and `TYPE_ORDER` slot (`:976`–`:983`). **Neither function is called anywhere** (verified: the only reference is `groupDocsByType`'s own internal call to `getDocType` at `:999`).

So the frontend was written in anticipation of HTML design docs; the backend walker filters them out before they ever arrive.

### Root Cause Analysis
- **HTML support was built per-tab, not generalised.** The HTML Previews tab got its own dedicated scanner — `if (path.extname(entry) !== '.html') continue;` (`DesignPanelProvider.ts:1219`) — and its own renderer. Because that tab solved HTML for itself, the shared design-docs walker was never extended.
- **The Design System tab was modelled as a markdown/token-doc viewer.** Its preview pane is literally named `markdown-preview-design` (`design.html:3713`), so the design-time assumption was prose or structured data, not a rendered page.
- **Half-finished generalisation.** `getDocType`/`groupDocsByType` are the vestige of an attempt to make the design-docs tree type-aware including HTML; the walker change that would have made them meaningful never landed, so they were left unwired.

## Metadata
- **Tags:** frontend, backend, ui, bugfix
- **Complexity:** 4

> **Superseded:** Complexity: 3.
> **Reason:** The change spans three files (`LocalFolderService.ts`, `design.html`, `design.js`) and includes preview-pane routing plus wiring previously-dead tree-grouping code — multi-file coordination, even if every piece is pattern reuse. The 1–10 scale reserves 3 for routine single-file changes.
> **Replaced with:** Complexity: 4 (low, multi-file, all pattern reuse).

## User Review Required
- **None.** The artifact format (HTML), the whitelist addition, and reuse of the existing renderer are all settled.

## Complexity Audit

### Routine
- Add `'.html', '.htm'` to the `_isDesignOrImageFile` whitelist (`LocalFolderService.ts:1193`), under a `// Rendered design systems` comment alongside the existing category comments.
- Update the empty-state copy at `design.html:3714` to include HTML.

### Complex / Risky
- **Preview routing.** The Design System tab currently renders everything into `markdown-preview-design`. It needs an iframe sibling and a branch on doc type. Reuse the proven `html-preview-frame` approach — `injectBaseTag(htmlContent, webviewUri)` then `srcdoc` (`design.js:1541`) — rather than writing a third renderer.
- **Relative asset resolution.** The user's file is self-contained, but design systems generally reference local fonts/images. `injectBaseTag` (`design.js:574`) exists precisely for this; it must be applied on the DS-tab path too, or relative assets silently 404.
- **Wire or delete the dead helpers.** `getDocType`/`groupDocsByType` should be *wired* (grouping the DS tree by type, with HTML first per the existing `TYPE_ORDER`) rather than deleted — that is the behaviour they were written for, and an HTML design system deserves its own tree group next to markdown docs.

## Edge-Case & Dependency Audit

- **Race Conditions:** Selecting an HTML doc while a design-folder rescan is in flight follows the same request/response pattern as existing doc previews — no new race is introduced. The iframe's fit-on-load/zoom handshake reuses the existing `html-preview-frame` load-event pattern; do not add a second load handler on the shared frame idiom.
- **Security:** User HTML renders inside a sandboxed `srcdoc` iframe within the webview — the identical trust boundary the HTML Previews and Stitch tabs already accept for the same class of file. Grant the new iframe exactly the sandbox/CSP posture of the existing `html-preview-frame`; do not add `allow-same-origin` or script permissions beyond what that frame already has.
- **Side Effects:** The whitelist addition surfaces `.html` files to *every* consumer of `listDesignFiles()` — currently the design-docs tree via `_sendDesignDocsReady` — so HTML files will newly appear in the tree for all users who have them in design folders (intended). Markdown title extraction is gated on text extensions (`LocalFolderService.ts:1168–1172`), so large HTML files add no scan cost. Wiring `groupDocsByType` regroups the tree for existing users (HTML first per `TYPE_ORDER`) — a deliberate, cosmetic reordering.
- **Dependencies & Conflicts:** No upstream dependencies. #7 (create from zero) is blind without this rendering; #3/#4/#8 need the artifact selectable. No other subtask touches `LocalFolderService.ts`, so no merge-order contention on this file.

## Dependencies
- **None — this is the root of the set.** Plans #3 (token extraction), #4 (per-project binding), #7 (create from zero) and #8 (derive from existing app) all require an HTML design system to be selectable and viewable first.
- Independently shippable and independently valuable: on its own it makes existing HTML design systems usable in the tab.

## Adversarial Synthesis
Key risks: (1) missing `injectBaseTag` on the new DS-tab path, silently 404ing relative assets — covered by manual verification with a real file; (2) webview CSP rejecting `srcdoc` in the DS pane — unlikely since the same pane hierarchy already hosts two working `srcdoc` iframes, which serve as the reference implementation; (3) regressing non-HTML previews when branching on doc type — covered by the unchanged-behaviour manual checks. Purely additive to a read-only file scan; users with no HTML design docs see no change.

## Proposed Changes

### `src/services/LocalFolderService.ts`
1. `_isDesignOrImageFile` (`:1193`): add `'.html', '.htm'`.
2. Leave the markdown title-extraction branch (`:1168`–`1185`) untouched — HTML titles are not needed for the tree; the filename is sufficient.

### `src/webview/design.html`
1. Add an HTML preview wrapper + iframe inside the DS tab's `preview-panel-wrapper` (`:3710`), modelled on the existing `html-preview-wrapper`/`html-preview-frame` markup.
2. Update the empty state at `:3714` to "Select a design document, HTML design system, image, JSON, or YAML file from the sidebar to preview".

### `src/webview/design.js`
1. In the DS-tab preview path, branch on `getDocType(doc)` (`:985`): `'html'` → render into the new iframe via `injectBaseTag` + `srcdoc`; everything else keeps its current behaviour.
2. Wire `groupDocsByType` (`:996`) into the DS tree render so HTML design systems group under the existing `TYPE_LABELS.html` heading.
3. Reuse `applyZoom` (`:243`) for the DS-tab iframe so a large design system can be zoomed/fit like other HTML previews.

## Verification Plan

### Automated Tests
- `npm run compile`.
- Unit-assert `_isDesignOrImageFile('x.html') === true` and `_isDesignOrImageFile('x.htm') === true`, with the existing accepted/rejected extensions unchanged (guard against an accidental whitelist regression).

### Manual Verification
1. Add `/Users/patrickvuleta/Documents/GitHub/patrickwork/designs` as a design folder. Confirm `viaapp-design-system.html` **appears in the tree** (it currently does not).
2. Select it; confirm it renders as a live page — colour swatches, type specimens and component examples visible, not raw markup and not an empty pane.
3. Confirm zoom/fit works on the rendered page.
4. Confirm markdown, JSON, YAML and image previews are unchanged.
5. Confirm HTML docs appear under their own "HTML" group heading in the tree.

## Risk Assessment
- **Low.** An additive whitelist entry plus reuse of a renderer already proven in two other tabs of the same webview. The realistic failure modes are (1) missing `injectBaseTag` on the new path, breaking relative assets — covered by manual step 2 with a real file; (2) webview CSP rejecting `srcdoc` in the DS pane — the same pane hierarchy already hosts working iframes, so this is unlikely, and the existing wrappers are the reference implementation.
- No migration concern: purely additive to a read-only file scan. Users with no HTML design docs see no change.

**Recommendation:** Send to Coder

## Completion Summary
Implemented HTML design system rendering in the Design System tab. Added `.html` and `.htm` to `_isDesignOrImageFile` whitelist in `LocalFolderService.ts`, mapped `html` fileType in `DesignPanelProvider.ts`, added HTML preview container iframe and updated empty state in `design.html`, and added iframe src/srcdoc preview loading logic in `design.js`. Files changed: `src/services/LocalFolderService.ts`, `src/services/DesignPanelProvider.ts`, `src/webview/design.html`, `src/webview/design.js`. No issues encountered.
