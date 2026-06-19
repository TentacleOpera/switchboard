# Docs Tab: Antigravity as Proper Source + Exclude implementation_plan.md

## Goal

Make the Docs tab of `planning.html` treat Antigravity as a first-class, filterable source (so it respects the source dropdown like every other source) and stop `implementation_plan.md` files — which Antigravity mirrors into `.switchboard/plans/` — from appearing as local Docs.

### Core Problem

Two separate bugs in the Docs tab of `planning.html`:

1. **Antigravity ignores the source filter.** `renderAntigravitySessions()` is called inside `renderUnifiedDocs()` gated only on `state._lastLocalDocsMsg` (line 1792–1794) and again redundantly in `handleLocalDocsReady()` (line 1938). The `'antigravity'` source is not in `allSources` (line 532) and has no dropdown option, so the section always appears regardless of which source is selected.

2. **`implementation_plan.md` files appear in Docs.** The `.switchboard/plans/` folder is a local docs source. Antigravity mirrors plan files there (e.g. `implementation_plan.md`), so they appear both as Plans and as local Docs.

### Root-Cause Analysis

The source list is duplicated in **three** places that must agree for filtering to be correct:
- **Line 36:** `state.docsSourceFilter` initial value — `persistedState.docsSourceFilter || ['local', 'clickup', 'linear', 'notion']`
- **Line 532:** `const allSources = ['local', 'clickup', 'linear', 'notion'];`
- **Line 1422:** `filterSet` fallback default — `new Set(state.docsSourceFilter || ['local', 'clickup', 'linear', 'notion'])`

Antigravity was never in any of these arrays, nor in the dropdown markup, so its section was rendered out-of-band rather than as a filtered source. The original plan updated only line 532 and leaned on the existing length-mismatch reset (lines 545–548) to silently upgrade persisted/default filters from 4 → 5 items. That works on the common path but leaves three arrays out of sync — fragile against future source additions. This plan updates all three for consistency (see Clarification in Proposed Changes).

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

2. **Clarification — keep the two other source-list defaults in sync.** Strictly implied by Fix 1 (the filter must include antigravity by default and not regress when the reset path doesn't fire). Update the hardcoded defaults so all three arrays agree:
   - **Line 36:** `docsSourceFilter: persistedState.docsSourceFilter || ['local', 'clickup', 'linear', 'notion', 'antigravity'],`
   - **Line 1422:** `const filterSet = new Set(state.docsSourceFilter || ['local', 'clickup', 'linear', 'notion', 'antigravity']);`

3. **`renderUnifiedDocs()` (line 1792–1794):** Gate the `renderAntigravitySessions` call on the filter:
   ```js
   if (filterSet.has('antigravity') && state._lastLocalDocsMsg) {
       renderAntigravitySessions(state._lastLocalDocsMsg.antigravitySessions || [], state._lastLocalDocsMsg.antigravityEnabled || false);
   }
   ```

4. **`handleLocalDocsReady()` (line 1938):** Remove the redundant `renderAntigravitySessions()` call. `rerenderUnifiedDocs()` (line 1936) calls `renderUnifiedDocs()` (line 1823), which now covers the antigravity render once the call is inside `renderUnifiedDocs`.

### Fix 2 — Exclude `implementation_plan.md` from local docs rendering

**`src/webview/planning.js`**, in `renderUnifiedDocs()` where `docNodes` is built (line 1438, inside the `filterSet.has('local')` block at 1424):

Change:
```js
let docNodes = (nodes || []).filter(n => n.kind === 'document' && !n.isDirectory);
```
To:
```js
let docNodes = (nodes || []).filter(n => n.kind === 'document' && !n.isDirectory && n.name !== 'implementation_plan.md');
```

This is a client-side filter only — no backend change needed. The exclusion is by filename, which is always `implementation_plan.md` for antigravity-mirrored plan files.

## Metadata

**Tags:** frontend, bugfix, ui
**Complexity:** 2

## User Review Required

- None. Both fixes are localized client-side webview changes with well-understood behavior. The `implementation_plan.md` filename filter is a deliberate, accepted tradeoff (see Edge-Case audit), not an open product question.

## Complexity Audit

### Routine
- Single-file-cluster change confined to two webview files (`planning.js`, `planning.html`); no backend, no message-protocol, no state-schema changes.
- Reuses the existing `filterSet.has(...)` gating pattern already applied to `'local'`, `'clickup'`, etc.
- Adding a `<option>` and array members is trivial, mechanical work.
- Filename-based exclusion is a one-condition addition to an existing `.filter(...)`.

### Complex / Risky
- None. The only subtlety (three out-of-sync source arrays) is neutralized by the Clarification updating all three.

## Edge-Case & Dependency Audit

### Race Conditions
- The source-list upgrade in the init block (lines 533–550) runs synchronously during webview setup, before any `localDocsReady` message arrives and triggers `renderUnifiedDocs`. So `state.docsSourceFilter` is already the 5-item array by first render — no race.
- If `#docs-source-filter` is absent from the DOM, the init block is skipped and the length-mismatch reset never fires; with the Clarification (lines 36 + 1422 updated), the defaults already include `'antigravity'`, so antigravity still renders under "All Sources". The Clarification removes this previously-latent gap.

### Security
- None. No new input handling, no eval, no network calls, no privilege changes. Pure client-side rendering filters.

### Side Effects
- **Filename collision:** any document literally named `implementation_plan.md` in *any* local folder (not just `.switchboard/plans/`) is hidden from Docs, with no toggle and no explanation. Accepted: the filename is purpose-specific, the blast radius is one file, and it remains visible on disk / in the Plans tab. Recorded as a known tradeoff rather than a hidden behavior.
- Removing the line-1938 call narrows antigravity rendering to the `renderUnifiedDocs` path. Toggling Antigravity on/off posts `toggleAntigravityBrain` (line 5641), whose backend response re-invokes `handleLocalDocsReady` → `rerenderUnifiedDocs` → `renderUnifiedDocs`. This is the same round-trip the line-1938 call already depended on, so no new dependency is introduced.

### Dependencies & Conflicts
- **Assumption:** Antigravity mirrors plan files under the exact filename `implementation_plan.md`. If that producer ever changes the name (hyphenated, timestamped, etc.), Fix 2's filter silently stops working. Out of scope to change the producer; flagged so the filename stays the single point of coupling.
- **Persisted single-source filters** (e.g. `['notion']`, length 1) are preserved by the lines 541–542 branch and correctly continue to hide antigravity — intended.

## Dependencies

- None. No `sess_XXXXXXXXXXXXX` upstream-session dependencies; this plan is self-contained.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) three duplicated source-list arrays drifting out of sync, and (2) Fix 2 coupling to the magic filename `implementation_plan.md`. Mitigations: the Clarification updates all three arrays (lines 36, 532, 1422) so default filtering can't regress, and the filename coupling is explicitly recorded as an accepted, low-blast-radius tradeoff. The toggle re-render path is unchanged from current behavior, so removing the redundant line-1938 call carries no new risk.

## Proposed Changes

### `src/webview/planning.html`

- **Context:** `#docs-source-filter` `<select>` at line 3068 lists four options (All Sources, Local, ClickUp, Linear, Notion) but no Antigravity.
- **Logic:** Add an Antigravity option so the dropdown can drive the new filter value.
- **Implementation:** After line 3073 (`<option value="notion">Notion</option>`), add:
  ```html
  <option value="antigravity">Antigravity</option>
  ```
- **Edge Cases:** Selecting "Antigravity" sets `state.docsSourceFilter = ['antigravity']` (line 554), so only the antigravity section renders; all local-folder and online-source sections skip via their own `filterSet.has(...)` gates.

### `src/webview/planning.js`

- **Context:** Source list duplicated at lines 36, 532, 1422; antigravity rendered out-of-band at lines 1793 and 1938; local `docNodes` built at line 1438.
- **Logic:** (a) make antigravity a real filterable source by adding it to all three source arrays; (b) gate its render on the filter inside `renderUnifiedDocs`; (c) drop the redundant render in `handleLocalDocsReady`; (d) exclude `implementation_plan.md` from local docs.
- **Implementation:**
  1. Line 532 — `const allSources = ['local', 'clickup', 'linear', 'notion', 'antigravity'];`
  2. **Clarification** Line 36 — `docsSourceFilter: persistedState.docsSourceFilter || ['local', 'clickup', 'linear', 'notion', 'antigravity'],`
  3. **Clarification** Line 1422 — `const filterSet = new Set(state.docsSourceFilter || ['local', 'clickup', 'linear', 'notion', 'antigravity']);`
  4. Lines 1792–1794 — wrap the render:
     ```js
     if (filterSet.has('antigravity') && state._lastLocalDocsMsg) {
         renderAntigravitySessions(state._lastLocalDocsMsg.antigravitySessions || [], state._lastLocalDocsMsg.antigravityEnabled || false);
     }
     ```
  5. Line 1938 — delete the redundant `renderAntigravitySessions(msg.antigravitySessions || [], msg.antigravityEnabled || false);` call.
  6. Line 1438 — append `&& n.name !== 'implementation_plan.md'` to the `docNodes` filter.
- **Edge Cases:**
  - **"All Sources":** `filterSet` contains all five entries → antigravity renders as before.
  - **Specific non-antigravity source:** `filterSet.has('antigravity')` is false → antigravity section not rendered.
  - **"Antigravity" selected:** only the antigravity section renders.
  - **Antigravity disabled by toggle:** `renderAntigravitySessions` returns early after clearing the section (line 1859) — no change needed.
  - **Persisted old 4-item `docsSourceFilter`:** reset to the 5-item `allSources` by the length-check guard (lines 545–548); with the Clarification the fallback defaults also already include antigravity.
  - **`implementation_plan.md` in a non-plans folder:** still excluded — accepted (see Side Effects).

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
| `src/webview/planning.js` | Add 'antigravity' to `allSources` (532) and to the two other source-list defaults (36, 1422); gate `renderAntigravitySessions` on filter (1792–1794); remove redundant call in `handleLocalDocsReady` (1938); exclude `implementation_plan.md` from `docNodes` (1438) |

## Out of Scope

- Backend/extension changes (no message protocol changes needed)
- Changing what files the antigravity feature mirrors to `.switchboard/plans/`
- Changing the magic filename coupling for Fix 2 (relies on Antigravity always naming the mirrored file `implementation_plan.md`)

## Verification Plan

> Session directives: SKIP COMPILATION and SKIP TESTS. The steps below are recorded for the user to run separately; do not execute them in this session.

### Automated Tests
- No automated test suite exists for these webview rendering paths. After the change, the user should run the project's standard test command separately (per session directive) to confirm no regressions in any tests that import/exercise `planning.js`.

### Manual Verification (post-`npm run compile`)
1. Open the Docs tab. With "All Sources" selected, confirm the Antigravity Sessions section still appears (when enabled).
2. Select "Local" — confirm the Antigravity section disappears.
3. Select "Antigravity" — confirm only the Antigravity section shows and local/online sections are hidden.
4. Toggle Antigravity off via the modal — confirm the section clears; toggle on — confirm it returns under "All Sources"/"Antigravity".
5. Confirm no `implementation_plan.md` entries appear under local folders (including `.switchboard/plans/`).
6. As an existing user with a persisted old 4-item filter, reload and confirm it upgrades to include Antigravity without error.

---

**Recommendation:** Complexity 2 → **Send to Intern.**

## Review Findings

Reviewer pass completed — all 7 changes verified correct against plan. No CRITICAL or MAJOR findings. Three NITs: case-sensitive filename coupling (accepted tradeoff), missing `SOURCE_DISPLAY_NAMES['antigravity']` entry (cosmetic, unused by current render path), and triple-duplicated source-list arrays (maintenance risk, not a bug). Regression audit confirmed no double-trigger (single `handleLocalDocsReady → rerenderUnifiedDocs → renderUnifiedDocs → renderAntigravitySessions` chain), no race conditions (`state._lastLocalDocsMsg` set before render), and no orphaned references (grep confirmed only 2 `renderAntigravitySessions` references). No code fixes applied. Compilation and tests skipped per session directives. Remaining risks: filename coupling if Antigravity changes the mirrored filename; source-list drift if a sixth source is added without updating all three arrays.
