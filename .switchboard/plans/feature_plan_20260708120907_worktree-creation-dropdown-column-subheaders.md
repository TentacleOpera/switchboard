# Feature Plan: Add Column Subheaders to Worktree Creation Dropdown

## Goal

### Problem
The manual feature worktree creation dropdown in the Worktrees tab of `kanban.html` is a flat list of feature topics with no grouping. When there are many features across different kanban columns, it's hard to find the right one. The plan-select dropdown in `implementation.html` already has column subheaders (via `<optgroup>`) that group plans by their kanban column — the worktree creation dropdown should follow the same pattern.

### Background
- **Current dropdown**: `src/webview/kanban.html` lines 10510–10523 — a flat `<select>` with `<option>` elements for each feature card, filtered to exclude features that already have a worktree. Built inside `createWorktreesPanel()` (function starts at line 10363).
- **Reference implementation**: `src/webview/implementation.html` lines 2594–2611 — uses `<optgroup>` with `group.label` set to the column display label (uppercase), grouping plans by `kanbanColumn` (line 2570: `const col = sheet.kanbanColumn || 'CREATED'`).
- **Column definitions in kanban.html**: lines 3955–3963 define `columnDefinitions` (module-level `let`) with `{ id, label, role, autobanEnabled }` pairs: CREATED → "New", PLAN REVIEWED → "Planned", LEAD CODED → "Lead Coder", CODER CODED → "Coder", CODE REVIEWED → "Reviewed", ACCEPTANCE TESTED → "Acceptance Tested", COMPLETED → "Completed". This is a module-level variable, in scope inside `createWorktreesPanel()`.
- **Card property**: In kanban.html, feature cards have a `column` property (e.g., `feature.column === 'CREATED'`). Verified: `card.column` used in 27+ places in kanban.html (not `kanbanColumn` which is implementation.html's property).
- **Worktree exclusion map**: `currentFeatureWorktrees` (line 3969, `let currentFeatureWorktrees = {}`) — an Object keyed by planId, used at line 10518 to exclude features that already have a worktree.

### Root Cause
The worktree creation dropdown was built as a simple flat list without considering the column-grouping pattern already established in `implementation.html`. No `<optgroup>` elements are used, so all features appear in an ungrouped list.

## Metadata

- **Tags:** frontend, ui, ux
- **Complexity:** 3

## User Review Required

No — this is a pure UI enhancement that follows an established pattern (`<optgroup>`) already used in `implementation.html` in the same codebase. No product-scope change, no data model change, no breaking change. Safe to implement without user sign-off.

## Complexity Audit

### Routine
- Replacing the flat `forEach` loop with a grouping loop that creates `<optgroup>` elements per column.
- Building a `colIdMap` from `columnDefinitions` to map column IDs to display labels.
- Sorting features by column order before grouping.

### Complex / Risky
- None. This is a self-contained UI change following an established pattern in the same codebase.

## Edge-Case & Dependency Audit

### Race Conditions
- None. The dropdown is built synchronously from `currentCards` state.

### Security
- None.

### Side Effects
- The dropdown will now show column subheaders (e.g., "NEW", "PLANNED", "CODER") above grouped features. This improves findability. No functional change to worktree creation.

### Dependencies & Conflicts
- Must use `card.column` (kanban.html property) not `kanbanColumn` (implementation.html property) — the property names differ between the two webviews.
- Must use `columnDefinitions` from kanban.html (lines 3955–3963), not the hardcoded list from implementation.html.

## Dependencies

- No upstream plan dependencies. This is a standalone UI enhancement.
- No cross-plan conflicts — the dropdown rendering code (lines 10510–10523) is not touched by the other two subtasks in this feature.

## Adversarial Synthesis

Key risks: (1) Feature cards with a `column` value not in `columnDefinitions` (e.g., a custom column or undefined) — the code handles this with `colIdMap.has(a) ? ... : 999` sort fallback and `info ? info.label : colId` display fallback. (2) Empty feature list (no features without worktrees) — the default "-- Choose a Feature --" option remains, no empty `<optgroup>` is created (the `if (features.length === 0) continue` guard). (3) No `<optgroup>` styling issues in VS Code webview — the same element is already used in `implementation.html` without issues. Low risk overall.

## Proposed Changes

---

### 1. `src/webview/kanban.html` — Replace flat dropdown with column-grouped dropdown

**Context**: Lines 10510–10523, the feature worktree creation dropdown inside `createWorktreesPanel()`.

**Implementation**:
```javascript
// BEFORE (lines 10510-10523):
const featureSelect = document.createElement('select');
featureSelect.style.cssText = 'flex: 1; padding: 4px; font-size: 11px; background: var(--input-bg, #222); color: var(--text-normal, #ccc); border: 1px solid var(--border-color);';
const featureDefaultOpt = document.createElement('option');
featureDefaultOpt.value = '';
featureDefaultOpt.textContent = '-- Choose a Feature --';
featureSelect.appendChild(featureDefaultOpt);
const featureCards = (Array.isArray(currentCards) ? currentCards : []).filter(c => c.isFeature);
featureCards.forEach(feature => {
    if (currentFeatureWorktrees[feature.planId]) return;
    const opt = document.createElement('option');
    opt.value = feature.planId;
    opt.textContent = feature.topic;
    featureSelect.appendChild(opt);
});

// AFTER:
const featureSelect = document.createElement('select');
featureSelect.style.cssText = 'flex: 1; padding: 4px; font-size: 11px; background: var(--input-bg, #222); color: var(--text-normal, #ccc); border: 1px solid var(--border-color);';
const featureDefaultOpt = document.createElement('option');
featureDefaultOpt.value = '';
featureDefaultOpt.textContent = '-- Choose a Feature --';
featureSelect.appendChild(featureDefaultOpt);

// Build column ID → label map from columnDefinitions
const colIdMap = new Map();
(columnDefinitions || []).forEach((col, index) => {
    const normId = (col.id || '').trim().toUpperCase();
    colIdMap.set(normId, { index, label: col.label || col.id });
});

// Group feature cards by column, sorted by column order
const featureCards = (Array.isArray(currentCards) ? currentCards : [])
    .filter(c => c.isFeature)
    .filter(c => !currentFeatureWorktrees[c.planId]); // exclude features that already have a worktree

const groups = new Map();
for (const feature of featureCards) {
    const col = (feature.column || 'CREATED').trim().toUpperCase();
    if (!groups.has(col)) groups.set(col, []);
    groups.get(col).push(feature);
}

// Sort groups by column order (using columnDefinitions index)
const sortedGroupKeys = Array.from(groups.keys()).sort((a, b) => {
    const aIdx = colIdMap.has(a) ? colIdMap.get(a).index : 999;
    const bIdx = colIdMap.has(b) ? colIdMap.get(b).index : 999;
    return aIdx - bIdx;
});

for (const colId of sortedGroupKeys) {
    const features = groups.get(colId);
    if (features.length === 0) continue;
    const info = colIdMap.get(colId);
    const displayLabel = info ? info.label : colId;
    const group = document.createElement('optgroup');
    group.label = displayLabel.toUpperCase();
    for (const feature of features) {
        const opt = document.createElement('option');
        opt.value = feature.planId;
        opt.textContent = feature.topic;
        group.appendChild(opt);
    }
    featureSelect.appendChild(group);
}
```

**Note**: `columnDefinitions` is a module-level `let` (line 3955), in scope inside `createWorktreesPanel()` (line 10363). No scope issues — the `colIdMap` code works as-is.

---

### 2. `dist/webview/kanban.html`

Rebuild via `npm run build`. Do NOT manually edit.

## Verification Plan

### Manual Verification
- [ ] Open the Worktrees tab, click "Create Worktree" (manual feature creation)
- [ ] Verify the dropdown shows column subheaders (e.g., "NEW", "PLANNED", "LEAD CODER") as `<optgroup>` labels
- [ ] Verify features are grouped under their correct column subheader
- [ ] Verify features with existing worktrees are still excluded
- [ ] Verify selecting a feature from a grouped subheader still creates the worktree correctly
- [ ] Verify the dropdown updates when cards move between columns (re-open the dropdown after a card move)
- [ ] Compare visual style with the implementation.html plan-select dropdown — should match

### Automated

- Compilation (`npm run compile`) and automated tests are SKIPPED per session directive. Verify via the manual checklist above using an installed VSIX.

## Files Changed

- `src/webview/kanban.html` — replace flat dropdown with column-grouped `<optgroup>` dropdown
- `dist/webview/kanban.html` — rebuild artefact
