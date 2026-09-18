# Remove Dead Inspect Buttons from Images and Design System Tabs

## Goal

Remove the dead **Inspect** buttons from the **Images** tab and the **Design System** tab of `design.html`. They enable when an image loads but have no click handler anywhere in `design.js`, so they do nothing (Inspect is an HTML-preview-only mode). Remove both buttons and their enable/disable logic.

### Problem Analysis & Root Cause

**Background:** The design panel (`design.html` / `design.js`) has four "Inspect" buttons across its tabs:
1. `stitch-html-btn-inspect` — Stitch HTML tab. **Has** a click handler (`design.js:4614`) that posts `sbInspectToggle`.
2. `html-btn-inspect` — HTML Previews tab. **Has** a click handler (`design.js:4713`) that posts `sbInspectToggle`.
3. `btn-inspect-images` — Images tab. **No click handler.** Dead UI.
4. `btn-inspect-design` — Design System tab. **No click handler.** Dead UI.

**Root cause:** The Inspect feature (eyedropper / measure / auto-detect overlay at `#inspect-overlay`) was built for HTML iframe previews — it inspects rendered DOM elements. The Images and Design System tabs display static images (PNG/JPG/etc.), not HTML, so the Inspect overlay has nothing to inspect. Someone added the buttons and wired up enable/disable logic (toggling the `disabled` attribute when an image loads), but never — and could never — wire a click handler because the Inspect overlay is HTML-only.

**Evidence (verified against current source):**
- `design.html:3687` — `<button id="btn-inspect-design" class="strip-btn" disabled>Inspect</button>` (Design System tab controls strip)
- `design.html:3949` — `<button id="btn-inspect-images" class="strip-btn" disabled>Inspect</button>` (Images tab controls strip)
- `design.js:1501,1514,1518` — enable/disable logic for `btn-inspect-images` (no click handler)
- `design.js:1540,1560,1565` — enable/disable logic for `btn-inspect-design` (no click handler)
- `design.js:4916,4922,4926` — additional enable/disable logic for `btn-inspect-design` in the `design-source-select` change handler

The two working Inspect buttons (`stitch-html-btn-inspect` at `design.html:3789`, `html-btn-inspect` at `design.html:3879`) are **not** affected — they remain untouched.

## Metadata

- **Tags:** frontend, ui, refactor
- **Complexity:** 2

> **Superseded:** `**Tags:** design-panel, dead-ui, cleanup, design.html, design.js`
> **Reason:** Those tags are outside the improve-plan allowed vocabulary (`frontend, backend, auth, … ui, ux, bugfix, feature, refactor, …`); the importer/complexity tooling expects the fixed set, so free-text tags are dropped or mis-classified.
> **Replaced with:** `frontend, ui, refactor` (a UI cleanup in the webview front-end).

## User Review Required

- None. Pure removal of confirmed-dead UI; no behavior a user relies on is lost.

## Complexity Audit

### Routine
- Pure deletion: two `<button>` elements from HTML and their enable/disable logic from JS.
- No new logic, no state changes, no data-flow changes, no message passing.

### Complex / Risky
- The only risk is accidentally touching the two *working* Inspect buttons (`stitch-html-btn-inspect`, `html-btn-inspect`) or the shared `#inspect-overlay`. All three must be left intact. This is a naming-collision hazard, not a logic risk — grep discipline (Verification step 1–2) fully mitigates it.

## Edge-Case & Dependency Audit

- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:**
  - **Do NOT remove the working Inspect buttons.** `stitch-html-btn-inspect` (`design.html:3789`) and `html-btn-inspect` (`design.html:3879`) have real click handlers and must remain.
  - **Do NOT remove the shared `#inspect-overlay`** (`design.html:4240+`). It is used by the two working Inspect buttons.
  - **Stale variable references:** after removing the enable/disable logic, remove any now-orphaned `const inspectBtn = document.getElementById('btn-inspect-...')` declarations too, so no variable silently resolves to `null` and clutters the code.
  - **No CSS cleanup needed:** the buttons use the shared `.strip-btn` class, used by many other buttons.
- **Dependencies & Conflicts:**
  - **No backend/extension dependency:** these buttons never posted messages to the extension host, so no extension-side cleanup is needed.
  - No other plan in this batch touches `design.html`/`design.js`.

## Dependencies
- None.

## Adversarial Synthesis
Key risks: accidentally deleting one of the two *working* Inspect buttons (`stitch-html-btn-inspect`, `html-btn-inspect`) or the shared `#inspect-overlay`, or leaving an orphaned `const inspectBtn` that resolves to `null`. Mitigations: target only the two dead IDs (`btn-inspect-design`, `btn-inspect-images`); remove their `const inspectBtn` declarations along with the enable/disable lines; and gate the change on the two grep checks in the Verification Plan (dead IDs → zero matches; working IDs + `#inspect-overlay` → still present).

## Proposed Changes

### File 1: `src/webview/design.html`

**Change 1 — Remove the Design System tab Inspect button (`design.html:3687`):**
```html
<button id="btn-inspect-design" class="strip-btn" disabled>Inspect</button>
```

**Change 2 — Remove the Images tab Inspect button (`design.html:3949`):**
```html
<button id="btn-inspect-images" class="strip-btn" disabled>Inspect</button>
```

### File 2: `src/webview/design.js`

**Change 3 — Remove `btn-inspect-images` enable/disable logic (Images tab file-preview handler, around `:1501,1514,1518`):**
- `:1501` — `const inspectBtn = document.getElementById('btn-inspect-images');`
- `:1514` — `if (inspectBtn) inspectBtn.removeAttribute('disabled');` (inside `imageImg.onload`)
- `:1518` — `if (inspectBtn) inspectBtn.setAttribute('disabled', 'true');` (else branch)

**Change 4 — Remove `btn-inspect-design` enable/disable logic (Design System tab file-preview handler, around `:1540,1557–1561,1565`):**
- `:1540` — `const inspectBtn = document.getElementById('btn-inspect-design');`
- `:1557–1561` — the `const sourceSelect = document.getElementById('design-source-select'); if (sourceSelect && sourceSelect.value === 'local') { if (inspectBtn) inspectBtn.removeAttribute('disabled'); }` block inside `imgImg.onload`. `sourceSelect` here exists **only** to gate the inspect enable, so removing the whole block leaves nothing else dangling.
- `:1565` — `if (inspectBtn) inspectBtn.setAttribute('disabled', 'true');` (else branch)

**Change 5 — Remove `btn-inspect-design` logic in the `design-source-select` change handler (around `:4916,4922,4926`):**
- `val === 'local'` branch — the `const inspectBtn = …` + `inspectBtn.removeAttribute('disabled')` lines (`:4916`).
- `val === 'stitch'` branch — the `const inspectBtn = …` + `inspectBtn.setAttribute('disabled', 'true')` lines (`:4922`).
- `val === 'claude'` branch — the `const inspectBtn = …` + `inspectBtn.setAttribute('disabled', 'true')` lines (`:4926`).

Leave the rest of each branch intact (e.g. `refreshStitchDesignSystems()`, `updateClaudeImportTargetHint()`, `state.designSystemSubTab = val`).

**Edge Cases.**
- Removing the `const inspectBtn` lines eliminates the orphaned-null risk. No `document.getElementById('btn-inspect-...')` reference should survive.

## Verification Plan

### Automated Tests
- Out of scope per session directive (skip tests, skip compilation).

### Manual / Grep Verification
1. **Dead IDs gone:** `grep -n 'btn-inspect-design\|btn-inspect-images' src/webview/design.html src/webview/design.js` → expect **zero** matches.
2. **Working buttons intact:** `grep -n 'stitch-html-btn-inspect\|html-btn-inspect' src/webview/design.html src/webview/design.js` → confirm both buttons and their click handlers (`design.js:4614`, `4713`) are still present; and confirm `#inspect-overlay` still exists.
3. **Manual UI check (removed):** open the design panel; on the **Images** and **Design System** tabs confirm no Inspect button appears in either controls strip; load an image in each — confirm no webview dev-console errors.
4. **Manual UI check (working):** on the **Stitch HTML** and **HTML Previews** tabs confirm the Inspect Mode buttons remain and still toggle the overlay.
5. **No console errors:** switching tabs and loading images produces no `Cannot read properties of null` errors related to the removed buttons.

## Recommendation
Complexity 2 → **Send to Intern.** Pure, well-scoped deletion with exact line references; the only discipline required is not touching the two working buttons or `#inspect-overlay`, which the grep checks enforce.
