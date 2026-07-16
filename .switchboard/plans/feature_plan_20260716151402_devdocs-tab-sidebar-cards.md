# Give the Dev Docs Tab Proper Sidebar Cards Like the Other Tabs

## Goal

The **Dev Docs** tab in `planning.html` renders its document list as unstyled plain rows, while every other list tab (Docs, etc.) renders nice bordered "sidebar cards" with hover/selected glow. Make the Dev Docs list render the same card styling as the other planning tabs by converging it onto the existing `.tree-node` card pattern.

### Problem / background / root-cause analysis

**Symptom:** in the Dev Docs tab, the sidebar list of dev docs / READMEs appears as flat, un-carded text blocks — no border, no background gradient, no hover ring, no selected-state glow — visibly inconsistent with the Docs tab's cards right next to it.

**Root cause — wrong CSS class, undefined in this webview.**
`renderDevDocsList()` (`src/webview/planning.js:12153–12172`) builds each row as:
```js
const row = document.createElement('div');
row.className = 'system-file-item';
...
row.innerHTML = `<div style="font-weight:500;">${escapeHtml(doc.title || doc.fileName)}${readmeBadge}</div>${wsLabel}`;
```
The class `system-file-item` is styled **only in `project.html`** (`project.html:326–351`, the `.constitution-file-item, .system-file-item` shared rule with card background, border, hover, and selected glow). It is **not defined anywhere in `planning.html`** (grep confirmed: zero `.system-file-item` matches in `planning.html`; the only `planning.js` references are the three inside `renderDevDocsList()` at lines 12155, 12167, 12177). Since each webview ships its own self-contained `<style>` block, the class has no effect in the Planning panel — the rows render with default `div` styling (no card).

**The canonical "nice sidebar card" pattern in `planning.html` is `.tree-node`.** The Docs tab builds its cards via `renderDocCard()` (`planning.js:2544–2582`), which creates a `.tree-node` wrapper containing `.card-text` > `.card-title` (+ optional `.card-subtitle`) and an optional `.card-actions` row. The `.tree-node` styling lives in `planning.html`:
- base: `border: 1px solid var(--border-color); background: linear-gradient(...); border-radius: 4px; margin: 3px 0;` (line 906–921)
- hover: teal border-left + box-shadow (line 923–927)
- selected: teal border + glow + inset (line 929–935)
- `.tree-node:has(.card-text)` switches to vertical card layout (line 938–943)
- `.card-title` (line 1867), `.card-subtitle` (line 1875), `.card-text` (line 1888)
- Claudify overrides (lines 107–136) and Afterburner overrides (lines 2183–2187) already exist

So the fix is to make the Dev Docs rows use the `.tree-node` card structure (`.card-text` / `.card-title` / `.card-subtitle`) that is already styled in `planning.html`, instead of the orphaned `system-file-item` class. **No new CSS is required** — this reuses the existing, theme-aware card styling that the other tabs already use.

**Why not just add `.system-file-item` CSS to `planning.html`:** that would duplicate the card styling under a second class name and leave two parallel card systems in the same webview. Reusing `.tree-node` converges the Dev Docs tab onto the single existing card pattern, which is what "like the other tabs" asks for.

## Metadata

- **Tags:** frontend, ui, ux, refactor
- **Complexity:** 3

## User Review Required

- **None.** Reusing `.tree-node` (rather than importing `.system-file-item` CSS) is the design call, justified above; it matches "like the other tabs" and keeps one card system per webview.

## Complexity Audit

### Routine
- Rewrite the row-building loop in `renderDevDocsList()` to emit `.tree-node` + `.card-text` + `.card-title` (+ `.card-subtitle` for the workspace label) instead of `.system-file-item` + inline-styled divs.
- Update the two `.system-file-item` querySelector references inside `renderDevDocsList()` (the click-clear loop at line 12167 and the first-item lookup at line 12177) to `.tree-node`.
- Move the README badge into the card title (a small inline span inside `.card-title`) so it stays visible inside the card layout.

### Complex / Risky
- None material. The `.tree-node:has(.card-text)` selector relies on `:has()` support, which the Docs tab already depends on — no new browser-support risk. The click-selection logic is unchanged in behaviour, only the class name swapped. Building the card via DOM `createElement`/`textContent` (as `renderDocCard()` does) is *safer* than the current `innerHTML` string — `textContent` auto-escapes, so it removes the current reliance on `escapeHtml()` for the title.

## Edge-Case & Dependency Audit

- **Race Conditions:** none — pure synchronous DOM construction.
- **Security:** none — pure DOM/markup change inside the sandboxed webview. Switching from `innerHTML` + `escapeHtml()` to `createElement` + `textContent` keeps titles/labels safely escaped.
- **Side Effects:**
  - **Selection clearing:** the click handler currently does `devdocsListPane.querySelectorAll('.system-file-item').forEach(el => el.classList.remove('selected'))`. After the change it MUST query `.tree-node`, or the old selected card stays highlighted.
  - **Auto-select first doc (line 12177):** queries `.system-file-item` to grab the first row — MUST become `.tree-node`, or the first-card highlight + `selectDevDoc` won't fire.
  - **`buildSidebarToggleRow` call (line 12130):** unaffected — it prepends the toggle row before the card loop. Because the toggle row is a `.tree-node`? No — it is its own element; confirm the new `.tree-node` querySelectors don't accidentally select the toggle row as "first card." If the toggle row is not a `.tree-node`, `querySelector('.tree-node')` correctly returns the first *doc* card. Verify during implementation.
  - **Empty state (line 12143–12151):** uses `.empty-state`, unchanged.
- **Dependencies & Conflicts:**
  - **Sibling loose plan `fix-dev-docs-tab-empty-list-dropdown-and-buttons.md`** (Jul 9, not part of this feature) also touches `renderDevDocsList()`. Note: `buildSidebarToggleRow` **already exists in current source** (`planning.js:12110`, called at 12130), so that portion of the sibling plan appears already landed. This plan only changes per-row markup and the two `.system-file-item` querySelectors — different lines from the toggle-row/workspace-picker concerns — so no conflict. Coordinate ordering only if both are coded in the same pass.
  - **Sibling subtask in this feature** (`remove-claudify-pixel-font-option.md`) also edits `planning.js`, but at `case 'pixelFontSetting'` (~line 4875) — thousands of lines from `renderDevDocsList()` (~12127+). No overlap; either order.
  - **`renderDocCard()` reuse:** not directly reusable — it carries Docs-specific `dataset` attributes (`sourceId`, `nodeId`, `kind`, `root`, `sourceFolder`, `absolutePath`) and an `actions`/`deleteHandler`/`syncHandler` model Dev Docs doesn't need (Dev Docs uses strip buttons, not in-card action buttons). Building a lightweight `.tree-node` card inline in `renderDevDocsList()` is cleaner than forcing `renderDocCard()`'s signature.
  - **Theme support:** `.tree-node` already has Claudify (`planning.html:107–136`) and Afterburner (`planning.html:2183–2187`) overrides, so Dev Docs cards automatically match the active theme with no extra theme work.

## Dependencies

- `sess_local_20260716 — improve-feature: Claudify & Planning Tab UI Polish` (this feature; sibling subtask = pixel-font removal, independent)

## Adversarial Synthesis

Key risks: (1) **stale selection highlight** if either `.system-file-item` querySelector is left un-swapped — the old selected card never de-selects, or the first-card auto-select silently no-ops; (2) **toggle-row mis-selection** — `querySelector('.tree-node')` must return the first *doc* card, not the sidebar toggle row. Mitigations: swap **both** querySelectors to `.tree-node` in the same edit, and verify the toggle row is not a `.tree-node` during implementation. No CSS changes and no browser-support risk (`:has()` already in use).

## Proposed Changes

### `src/webview/planning.js` — `renderDevDocsList()` row loop (lines 12153–12172)

Replace the row construction with a `.tree-node` card:

```js
docs.forEach(doc => {
    const row = document.createElement('div');
    row.className = 'tree-node';
    if (_devDocSelected && _devDocSelected.path === doc.path) row.classList.add('selected');
    row.dataset.path = doc.path;

    const cardText = document.createElement('div');
    cardText.className = 'card-text';

    const cardTitle = document.createElement('div');
    cardTitle.className = 'card-title';
    cardTitle.textContent = doc.title || doc.fileName;
    if (doc.sourceType === 'readme') {
        const badge = document.createElement('span');
        badge.style.cssText = 'font-size:9px; background:var(--accent-teal); color:#000; padding:1px 5px; border-radius:3px; margin-left:6px; vertical-align:middle;';
        badge.textContent = 'README';
        cardTitle.appendChild(badge);
    }
    cardText.appendChild(cardTitle);

    if (!_devDocsWsFilter && doc.workspaceLabel) {
        const cardSubtitle = document.createElement('div');
        cardSubtitle.className = 'card-subtitle';
        cardSubtitle.textContent = doc.workspaceLabel;
        cardText.appendChild(cardSubtitle);
    }
    row.appendChild(cardText);

    row.addEventListener('click', () => {
        if (state.dirtyFlags.devdocs) exitEditMode('devdocs');
        devdocsListPane.querySelectorAll('.tree-node').forEach(el => el.classList.remove('selected'));
        row.classList.add('selected');
        selectDevDoc(doc);
    });
    devdocsListPane.appendChild(row);
});
```

### `src/webview/planning.js` — auto-select first doc (lines 12176–12179)

Update the first-row lookup from `.system-file-item` to `.tree-node`:
```js
if (!stillVisible && docs.length > 0) {
    const first = devdocsListPane.querySelector('.tree-node');
    if (first) first.classList.add('selected');
    selectDevDoc(docs[0]);
}
```
(Confirm the `buildSidebarToggleRow` element at line 12130 is not itself a `.tree-node`; if it were, prepend a doc-specific selector such as `.tree-node[data-path]` here and in the click-clear loop.)

### No CSS changes
`.tree-node`, `.tree-node:has(.card-text)`, `.card-title`, `.card-subtitle`, and the Claudify/Afterburner overrides already exist in `planning.html` (lines 906–979, 107–136, 1867–1888, 2183–2187). No new styles are added.

## Verification Plan

> Per session directive: **no project compilation step** and **no automated tests** in this verification. Verification is grep-based + manual visual inspection in the installed VSIX (the repo's `dist/` is not used in dev/testing).

### Automated Tests
- **None** — per session directive. This is a pure DOM/markup change; verified visually + by grep.

### Manual / observational
1. **Grep sweep:** `system-file-item` no longer appears in `planning.js` (zero references in the Dev Docs path).
2. **Visual parity:** open the Planning panel, switch to the Dev Docs tab, and confirm each doc row renders as a bordered card with the gradient background, matching the Docs tab's cards — not flat text.
3. **Hover/selected:** hover a card (teal border-left + shadow appears) and click a card (selected glow + teal text); click a second card and confirm the first de-selects.
4. **README badge:** switch the source filter to README and confirm the README badge still renders inside the card title.
5. **Workspace subtitle:** set the workspace filter to "All Workspaces" and confirm the workspace label shows as the card subtitle; switch to a single workspace and confirm the subtitle disappears (matches Docs-tab behaviour).
6. **Theme check:** repeat under Claudify (terracotta accents) and Afterburner (cyan glow) — cards should pick up the active theme automatically via the existing `.tree-node` overrides.
7. **Selection still drives preview:** clicking a card still loads the doc preview and enables the Import / Draft-with-agent strip buttons (unchanged `selectDevDoc` path); the toggle row is not selectable as a card.

## Recommendation

Complexity **3** → **Send to Intern.** Single-file, single-function DOM rewrite reusing existing CSS; the only care point is swapping *both* `.system-file-item` querySelectors to `.tree-node`. No open decisions for the user.

## Completion Report

Rewrote `renderDevDocsList()` in `src/webview/planning.js` to emit `.tree-node` > `.card-text` > `.card-title` (+ `.card-subtitle`) card structure instead of the orphaned `system-file-item` class. Swapped both `.system-file-item` querySelectors (click-clear loop and auto-select first doc) to `.tree-node`. README badge moved into `.card-title` as inline span; workspace label rendered as `.card-subtitle`. Switched from `innerHTML` + `escapeHtml()` to `createElement` + `textContent` for safer escaping. Confirmed `buildSidebarToggleRow` uses class `sidebar-toggle-row` (not `.tree-node`), so querySelector correctly returns first doc card. Zero `system-file-item` references remain in `planning.js`. No issues encountered.
