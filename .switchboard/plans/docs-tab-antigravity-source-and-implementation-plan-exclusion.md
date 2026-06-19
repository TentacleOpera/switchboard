# Docs Tab: Antigravity as Proper Source + Exclude implementation_plan.md

## Problem

Two separate bugs in the Docs tab of `planning.html`:

1. **Antigravity ignores the source filter.** `renderAntigravitySessions()` is called unconditionally inside `renderUnifiedDocs()` (line 1793) and again redundantly in `handleLocalDocsReady()` (line 1938). The 'antigravity' source is not in `allSources` and has no dropdown option, so the section always appears regardless of which source is selected.

2. **`implementation_plan.md` files appear in Docs.** The `.switchboard/plans/` folder is a local docs source. Antigravity mirrors plan files there (e.g. `implementation_plan.md`), so they appear both as Plans and as local Docs.

## Solution

### Fix 1 — Add 'antigravity' to the source dropdown and honour the filter

**`src/webview/planning.html`** (line ~3073):
- Add `<option value="antigravity">Antigravity</option>` to the `#docs-source-filter` select, after the existing four options.

**`src/webview/planning.js`**:

1. **`allSources` (line 532):** Add `'antigravity'` to the array:
   ```js
   const allSources = ['local', 'clickup', 'linear', 'notion', 'antigravity'];
   ```
   The existing validity-check logic (lines 540–548) already handles the case where a persisted filter has the wrong length — it resets to `allSources`. So existing users with the old 4-item persisted filter will automatically be upgraded to include 'antigravity' on next load.

2. **`renderUnifiedDocs()` (line 1792–1794):** Gate the `renderAntigravitySessions` call on the filter:
   ```js
   if (filterSet.has('antigravity') && state._lastLocalDocsMsg) {
       renderAntigravitySessions(state._lastLocalDocsMsg.antigravitySessions || [], state._lastLocalDocsMsg.antigravityEnabled || false);
   }
   ```

3. **`handleLocalDocsReady()` (line 1938):** Remove the redundant `renderAntigravitySessions()` call. `rerenderUnifiedDocs()` (line 1936) already covers it now that the call is inside `renderUnifiedDocs`.

### Fix 2 — Exclude `implementation_plan.md` from local docs rendering

**`src/webview/planning.js`**, in `renderUnifiedDocs()` where `docNodes` is built (line 1438):

Change:
```js
let docNodes = (nodes || []).filter(n => n.kind === 'document' && !n.isDirectory);
```
To:
```js
let docNodes = (nodes || []).filter(n => n.kind === 'document' && !n.isDirectory && n.name !== 'implementation_plan.md');
```

This is a client-side filter only — no backend change needed. The exclusion is by filename, which is always `implementation_plan.md` for antigravity-mirrored plan files.

## Edge Cases

- **"All Sources" selected:** `filterSet` contains all entries including 'antigravity', so antigravity renders as before.
- **Specific non-antigravity source selected:** `filterSet.has('antigravity')` is false → antigravity section is not rendered.
- **"Antigravity" selected:** `filterSet = ['antigravity']` → only the antigravity section renders; all local-folder and online-source sections are skipped (they're already gated on their own `filterSet.has(...)` checks).
- **Antigravity disabled by toggle:** `renderAntigravitySessions` already handles `enabled === false` by returning early after clearing the section — no change needed there.
- **Persisted `docsSourceFilter` with old 4-item array:** reset to new 5-item `allSources` by the existing length-check guard on lines 545–548.
- **`implementation_plan.md` in a non-plans folder:** still excluded. Acceptable — the filename is purpose-specific enough that false positives are negligible.

## Files Changed

| File | Change |
|------|--------|
| `src/webview/planning.html` | Add `<option value="antigravity">` to `#docs-source-filter` |
| `src/webview/planning.js` | Add 'antigravity' to `allSources`; gate `renderAntigravitySessions` on filter; remove redundant call in `handleLocalDocsReady`; exclude `implementation_plan.md` from `docNodes` |

## Out of Scope

- Backend/extension changes (no message protocol changes needed)
- Changing what files the antigravity feature mirrors to `.switchboard/plans/`

## Metadata

**Complexity:** 2  
**Tags:** frontend, bugfix, ui
