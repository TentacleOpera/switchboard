# Planning Panel: Sort Imported Docs by Recency and Add Import Button Feedback

## Goal

Make freshly imported clipboard docs appear at the top of the imported-docs list (sorted by import recency, not subpage `displayOrder`), and give the "Import from Clipboard" button a clear success/error flash so users get immediate visual feedback.

## Metadata
**Tags:** frontend, ui, ux, bugfix
**Complexity:** 3

---

## User Review Required

- **Sort definition (confirm intent):** After the fix, the most-recently-imported parent doc (and its source header) floats to the top of the imported-docs list; subpages within a doc stay in their existing `displayOrder` sequence. Confirm this is the desired ordering.
- **Button lockout:** The success/error flash applies `pointer-events: none` for its 1.5s duration (matching the existing `copyFlash`/`flashIconBtn` convention), so the button is click-inert for ~1.5s after an import completes even though it is re-enabled. This is intentional and harmless but is a behavior change worth a nod.

---

## Problem

Two related UX problems with the "Import from Clipboard" flow in `planning.html`:

1. **Docs appear in the wrong order.** After import, the new doc appears somewhere in the middle of the imported-docs list, making it hard to find. The current sort uses `displayOrder` (a subpage ordering field), not import recency. The DB already returns docs `ORDER BY imported_at DESC`, but the frontend immediately overrides this with `order` ascending.

2. **No visual feedback on the import button.** The button says "IMPORTING…" during the async operation, then silently resets. There is no success flash, and no visual indication of error when the clipboard is empty (the error is only shown in the small status text below the button).

---

## Root Cause

### Sort
- `KanbanDatabase.getImportedDocs` ([KanbanDatabase.ts:1813](../../src/services/KanbanDatabase.ts#L1813)) queries `ORDER BY imported_at DESC` — correct at the DB level. Each row exposes `importedAt: String(row.imported_at)` (an **ISO timestamp string**, set as `new Date().toISOString()` at [PlanningPanelProvider.ts:5903](../../src/services/PlanningPanelProvider.ts#L5903)).
- `PlanningPanelProvider._handleFetchImportedDocs` ([PlanningPanelProvider.ts:5554](../../src/services/PlanningPanelProvider.ts#L5554)) builds `allDocs` with `order: entry.displayOrder || 0` and `lastSyncedAt: entry.lastSyncedAt || entry.importedAt`. **`importedAt` is not passed as its own field**, so the frontend has no recency timestamp to sort on.
- In the frontend (`handleImportedDocsReady`, [planning.js:2503](../../src/webview/planning.js#L2503)), all docs are sorted by `order` ascending — wiping the DB's recency ordering. Docs are then grouped `sourceId → parentDocName` into nested `Map`s ([planning.js:2506-2517](../../src/webview/planning.js#L2506-L2517)); `Map.forEach` ([planning.js:2520](../../src/webview/planning.js#L2520), [2532](../../src/webview/planning.js#L2532)) renders in insertion order, which follows the `displayOrder` sort, not recency.

### Button feedback
- On click ([planning.js:710-713](../../src/webview/planning.js#L710-L713)): button disables and says "IMPORTING…" — fine.
- On `importResearchDocResult` success ([planning.js:3239-3242](../../src/webview/planning.js#L3239-L3242)): button is re-enabled and reset to "IMPORT FROM CLIPBOARD" with no animation.
- On error ([planning.js:3270-3282](../../src/webview/planning.js#L3270-L3282)): button is re-enabled silently; error message only appears in `#research-import-status` below.

---

## Complexity Audit

### Routine
- Backend: add one additive field (`importedAt`) to the `allDocs.push({...})` object. No schema, query, or contract change — the value is already on `entry`.
- CSS: two `@keyframes` + two state classes, modeled directly on the existing `copyFlash` block already in `planning.html`.
- JS result handler: add/remove a flash class with the standard reflow trick. Self-contained, no state changes.

### Complex / Risky
- **Frontend sort rewrite (the one moderate risk).** Replacing the single global sort with a per-group/per-source recency sort requires rebuilding the nested `Map` iteration into sorted arrays at two levels, and computing a numeric recency key per group. The non-obvious hazard: `importedAt` is an **ISO string**, so any `Math.max(...importedAtValues)` returns `NaN` (string→Number coercion) and silently breaks the sort. Timestamps MUST be parsed with `Date.parse(x) || 0`.

---

## Edge-Case & Dependency Audit

- **Race Conditions:** None introduced. `handleImportedDocsReady` already fully re-renders from a single `importedDocsReady` message; sorting is pure and synchronous. The flash class is added in the result handler after the button is re-enabled — no overlap with the in-flight import state.
- **Security:** None. No new data crosses the webview boundary; `importedAt` is a server-generated timestamp, rendered only as a sort key (never injected into the DOM as text/HTML).
- **Side Effects:**
  - Adding `importedAt` to the doc payload is additive; no existing consumer reads an unknown field, and `state.importedDocs` entries ([planning.js:2542-2567](../../src/webview/planning.js#L2542-L2567)) are keyed by name/slug/id and unaffected.
  - The flash class applies `pointer-events: none` for 1.5s, briefly making a re-enabled button click-inert. Matches existing convention; see User Review Required.
- **Dependencies & Conflicts:**
  - `planning.html` already defines a `copyFlash` keyframe ([planning.html:1702](../../src/webview/planning.html#L1702)) that fades to the element's resting state (`transparent` / `var(--text-secondary)`). The new keyframes MUST follow the same "fade to real resting state" convention — the `.planning-button` resting state is `background: var(--panel-bg2); color: var(--accent-teal)` ([planning.html:489-501](../../src/webview/planning.html#L489-L501)). **Do NOT use `--planning-button-bg` (it does not exist) or `var(--text-primary)`.**
  - Inline folder import buttons (`.folder-import-btn`) are reset separately ([planning.js:3245-3248](../../src/webview/planning.js#L3245-L3248)); the flash must target only `#btn-import-research-doc-clipboard`.

---

## Dependencies

- None

---

## Adversarial Synthesis

Key risks: (1) `importedAt` is an ISO **string**, so the plan's original `Math.max(importedAt)` sort sketch returns `NaN` and silently fails to sort — timestamps must be parsed with `Date.parse(x) || 0`; (2) the original CSS referenced a non-existent `--planning-button-bg` variable and wrong resting colors, causing a visible color pop at animation end. Mitigations: both are corrected inline below — numeric timestamp parsing in the sort, and resting-state colors matched to the real `.planning-button` (`var(--panel-bg2)` / `var(--accent-teal)`). Residual risk is low and confined to the two-level `Map`→sorted-array rewrite, which is spelled out step-by-step.

---

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`

**Context:** `_handleFetchImportedDocs` ([line 5554](../../src/services/PlanningPanelProvider.ts#L5554)) builds each entry of `allDocs`.

**Logic:** Expose `importedAt` as a first-class field so the frontend has a stable recency timestamp to sort on.

**Implementation:** In the `allDocs.push({...})` object, add `importedAt: entry.importedAt` alongside the existing fields (keep `lastSyncedAt` and all others unchanged):

```ts
allDocs.push({
    sourceId: entry.sourceId,
    docId: entry.remoteDocId || entry.slugPrefix,
    docName: entry.docName,
    parentDocName: entry.parentDocName || entry.docName,
    slugPrefix: entry.slugPrefix,
    canSync: ['clickup', 'linear', 'notion'].includes(entry.sourceId),
    order: entry.displayOrder || 0,
    lastSyncedAt: entry.lastSyncedAt || entry.importedAt,
    importedAt: entry.importedAt   // <-- added (ISO string)
});
```

**Edge Cases:** `entry.importedAt` is `NOT NULL` in the schema ([KanbanDatabase.ts:255](../../src/services/KanbanDatabase.ts#L255)) and always populated as an ISO string, so no undefined guard is needed here; the frontend still guards for safety.

### `src/webview/planning.js` — two-level recency sort in `handleImportedDocsReady`

**Context:** [planning.js:2503-2517](../../src/webview/planning.js#L2503-L2517) sorts globally by `order` then groups into nested `Map`s rendered via `Map.forEach`.

**Logic:**
- **Within a parent group:** sort by `order` ascending (preserves subpage hierarchy — unchanged from today).
- **Between parent groups within a source:** sort by the group's recency key descending (most recently imported group first).
- **Between source headers:** sort sources by their max recency key descending.

A group's/source's recency key is the **`Math.max` of the parsed numeric `importedAt`** of its docs. **`importedAt` is an ISO string — parse it: `Date.parse(doc.importedAt) || 0`.** Do NOT pass raw strings to `Math.max`.

**Implementation (Clarification — spells out the original sketch):**
1. Keep the within-group `order` sort. Replace the single global sort at [line 2503](../../src/webview/planning.js#L2503) with grouping first, then sort each group's array by `order` ascending.
2. Add a helper near the top of the function:
   ```js
   const recencyOf = doc => Date.parse(doc && doc.importedAt) || 0;
   const groupRecency = arr => arr.reduce((m, d) => Math.max(m, recencyOf(d)), 0);
   ```
3. After building `docsBySourceAndParent`, convert BOTH `Map` iterations to sorted arrays before rendering (there is no `Map.sort`):
   - Source level: `const sortedSources = [...docsBySourceAndParent.entries()].sort((a, b) => sourceRecency(b[1]) - sourceRecency(a[1]));` where `sourceRecency(parentGroups)` = `Math.max` of `groupRecency` over all its groups.
   - Within each source: `const sortedGroups = [...parentGroups.entries()].sort((a, b) => groupRecency(b[1]) - groupRecency(a[1]));`
   - Replace `docsBySourceAndParent.forEach(...)` ([line 2520](../../src/webview/planning.js#L2520)) and `parentGroups.forEach(...)` ([line 2532](../../src/webview/planning.js#L2532)) with `for...of` over these sorted arrays; the inner per-doc rendering body is unchanged.

**Edge Cases:**
- **Multi-page docs:** subpages share the same import batch, so `Math.max` and `min` are effectively equal; `Math.max` is used consistently (most-recent-activity-in-group). The group correctly floats to top. *(Resolves the earlier min-vs-max inconsistency: use `Math.max` everywhere.)*
- **Old docs with no/unparseable `importedAt`:** `Date.parse(...) || 0` yields `0`, sorting them to the bottom — correct.
- `local-folder` source is still skipped at render time ([line 2522](../../src/webview/planning.js#L2522)); it may appear in the sort arrays but is not rendered.

### `src/webview/planning.html` — flash keyframes + state classes

**Context:** Add to the `<style>` block, next to the existing `copyFlash` keyframe ([planning.html:1702-1710](../../src/webview/planning.html#L1702-L1710)).

**Logic:** Success = green flash fading to the button's real resting state; error = red flash fading to the same. Resting state of `.planning-button` is `background: var(--panel-bg2); color: var(--accent-teal)` — match it so there is no color pop when the class is removed on `animationend`.

**Implementation (corrected — no `--planning-button-bg`):**

```css
@keyframes importBtnSuccess {
    0%   { background-color: var(--vscode-testing-iconPassed, #73c991); color: #000; }
    70%  { background-color: var(--vscode-testing-iconPassed, #73c991); color: #000; }
    100% { background-color: var(--panel-bg2); color: var(--accent-teal); }
}
@keyframes importBtnError {
    0%   { background-color: #f14c4c; color: #fff; }
    70%  { background-color: #f14c4c; color: #fff; }
    100% { background-color: var(--panel-bg2); color: var(--accent-teal); }
}
.planning-button.import-success {
    animation: importBtnSuccess 1.5s ease-out forwards;
    pointer-events: none;
}
.planning-button.import-error {
    animation: importBtnError 1.5s ease-out forwards;
    pointer-events: none;
}
```

**Edge Cases:** `animation: ... forwards` holds the 100% frame until the class is removed on `animationend`, and the 100% frame matches the CSS resting state — so removal is seamless.

### `src/webview/planning.js` — apply flash in the result handler

**Context:** `importResearchDocResult` case, after re-enabling the button ([planning.js:3239-3242](../../src/webview/planning.js#L3239-L3242)).

**Logic:** On success add `import-success`; on error (including empty clipboard, which lands in the `else` branch at [line 3270](../../src/webview/planning.js#L3270)) add `import-error`. Use the reflow trick so a rapid second import re-triggers the animation.

**Implementation:** Add a local helper mirroring kanban's `flashIconBtn` ([kanban.html:3885](../../src/webview/kanban.html#L3885)):

```js
const flashImportBtn = (cls) => {
    if (!btnResearchClipboard) return;
    btnResearchClipboard.classList.remove('import-success', 'import-error');
    void btnResearchClipboard.offsetWidth; // reflow → restart animation
    btnResearchClipboard.classList.add(cls);
    btnResearchClipboard.addEventListener('animationend',
        () => btnResearchClipboard.classList.remove(cls), { once: true });
};
```

Call `flashImportBtn('import-success')` inside the `if (msg.success)` branch and `flashImportBtn('import-error')` inside the `else` branch. Target only `#btn-import-research-doc-clipboard` — leave the `.folder-import-btn` reset untouched.

**Edge Cases:** Double-click is already prevented during import (button `disabled` + "IMPORTING…"). The `remove → reflow → add` sequence re-triggers the flash if a new import completes before a prior animation ends.

---

## Files Changed

| File | Change |
|---|---|
| `src/services/PlanningPanelProvider.ts` | Add `importedAt` field to each doc object in `allDocs` |
| `src/webview/planning.js` | Two-level recency sort (numeric `Date.parse`) in `handleImportedDocsReady`; flash helper + calls in `importResearchDocResult` handler |
| `src/webview/planning.html` | Two CSS keyframe animations + two button state classes (resting colors matched to `.planning-button`) |

---

## Verification Plan

### Manual acceptance (primary)
1. Import a doc from clipboard → its source header and the doc itself appear at the **top** of the imported-docs list; the button flashes **green** then fades to its normal teal-on-panel state with no color pop.
2. Import a second, different doc → it now sits above the first; subpages within each multi-page doc remain in their original `displayOrder`.
3. Click Import with an **empty clipboard** → button flashes **red**, and the existing `#research-import-status` error text still shows.
4. Pre-existing docs with a missing/blank `importedAt` sort to the bottom rather than disappearing or throwing.
5. Inline `.folder-import-btn` buttons still reset to "Import" and are unaffected by the flash.

### Automated Tests
- Per session directive, the test suite is run separately by the user; no new automated tests are required for this change. If desired, a unit test could cover the pure sort: given docs with mixed `importedAt` ISO strings and `order` values, assert the rendered group/source ordering is recency-desc with within-group `order`-asc. (Optional — the sort logic would need extraction from the DOM-coupled `handleImportedDocsReady` to be unit-testable.)

---

**Recommendation:** Complexity 3 (≤ 6) → **Send to Coder.** The two correctness fixes (numeric timestamp parsing in the sort; real resting-state colors in the CSS) are baked into the Proposed Changes above and must be implemented as written.