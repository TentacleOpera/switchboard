# Remove Invented "Repo Folders & Files" Subheader from Claude Tab

## Goal

The Claude tab in `design.html` displays a subheader labeled "Repo Folders & Files" above the file/folder list in the sidebar. This subheader text was invented by the implementer — the user never requested it and finds it confusing and unprofessional. It must be removed. If subheaders are needed for organization, they should use the type-based names defined in the companion plan (Folders / HTML / Images), not an invented catch-all label.

**Core problem & root cause:** In `renderClaudeDocs` (`design.js` L4255-4258), the implementer added a `type-subheader` div with `textContent = 'Repo Folders & Files'`. This text appears nowhere in the original plan (`feature_plan_20260624210143_design-html-claude-tab.md`) and was not part of the user's requirements. The `renderHtmlDocs` function uses `'HTML Previews'` (L675) and `renderImagesDocs` uses `'Images'` (L748) — both sensible, type-specific labels. The Claude tab's subheader should follow the same pattern, not invent a new category name.

## Metadata

- **Tags:** ui, ux, bugfix, frontend
- **Complexity:** 1/10

## User Review Required

No. This is a trivial deletion of invented UI text. The user explicitly requested removal. No product-scope or architectural decision is needed.

## Complexity Audit

### Routine
- Removing the `typeSubheader.textContent = 'Repo Folders & Files'` block in `renderClaudeDocs` (design.js L4255-4258) — 4 lines deleted, no logic change.
- The `type-subheader` CSS class is NOT orphaned: it remains in use by `renderHtmlDocs` (L673-676) and `renderImagesDocs` (L746-749). No CSS cleanup needed.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

**Race Conditions:** None. The subheader is created synchronously during render; removing it has no timing implications.

**Security:** None.

**Side Effects:**
- **Standalone (this plan only):** The subheader is removed, leaving the file list without a section header. This is acceptable — the tab itself is labeled "CLAUDE", so the list's context is clear.
- **If the companion subheaders plan is also implemented:** This plan's change is subsumed — the single subheader is replaced by three type-based subheaders ("Folders", "HTML", "Images"). In that case, no separate change is needed here.
- **Execution-order note:** If both plans are queued, implement the companion plan (`feature_plan_20260625104016`) FIRST. This plan then becomes a no-op (the 4 target lines are already replaced). Implementing this plan first is harmless but shifts the companion plan's line-number context, requiring the companion executor to re-read the file before editing.
- **Pre-existing bug (out of scope, flagged for future plan):** The empty-state message at L4235 says "No HTML preview files found." but the Claude tab shows folders, HTML, *and* images. This is a pre-existing inaccuracy unrelated to the subheader removal and is NOT part of this plan's scope.

**Dependencies & Conflicts:**
- Companion plan: `feature_plan_20260625104016_claude-tab-separate-images-html-subheaders.md` — "Separate Images and HTML in Claude Tab with Subheaders". If implemented, it supersedes this plan (replaces the single subheader with three type-based ones). The two plans are compatible; they target the same 4 lines.

## Dependencies

- `feature_plan_20260625104016_claude-tab-separate-images-html-subheaders.md` — Separate Images and HTML in Claude Tab with Subheaders (supersedes this plan if implemented first; compatible).

## Adversarial Synthesis

Key risks: (1) execution-order coordination with the companion subheaders plan — if this plan lands first, the companion's line-number diff context shifts (mitigation: implement companion first, or re-read file before editing); (2) the plan must declare a default action rather than hedging (mitigation: default to standalone deletion). No research needed — all claims verified against actual source. The `type-subheader` CSS class is not orphaned by this removal.

## Proposed Changes

### File 1 — `src/webview/design.js` — `renderClaudeDocs` function (L4255-4258)

**Default action — standalone fix (remove the subheader entirely):**

Remove these 4 lines (L4255-4258):
```js
const typeSubheader = document.createElement('div');
typeSubheader.className = 'type-subheader';
typeSubheader.textContent = 'Repo Folders & Files';
docList.appendChild(typeSubheader);
```

After removal, the `docNodes.forEach(...)` loop at L4260 follows directly after the empty-state guard at L4250-4253. The file list renders without a section header — acceptable since the tab is labeled "CLAUDE".

**If the companion plan (`feature_plan_20260625104016`) is also implemented**, these 4 lines are replaced by the `renderGroup('Folders', ...)` / `renderGroup('HTML', ...)` / `renderGroup('Images', ...)` calls defined in that plan. In that case, implement the companion plan instead and skip this standalone deletion.

## Verification Plan

### Automated Tests

No automated tests required. This is a pure UI text deletion with no logic change. Per session directives, compilation and test suites are skipped; the user will run the test suite separately.

### Manual Verification

1. Open the design panel, go to the Claude tab.
2. Verify the sidebar file list does NOT show "Repo Folders & Files" anywhere.
3. Verify the file list still renders correctly (folders and files visible, clickable).
4. Verify clicking a folder still sets the target folder; clicking an HTML/image file still loads the preview.
5. If the companion plan is also implemented, verify the "Folders", "HTML", and "Images" subheaders appear instead (and empty groups show no subheader).

---

**Recommendation:** Complexity 1/10 → **Send to Intern**. This is a 4-line deletion of invented UI text with no logic, no dependencies (unless the companion subheaders plan is queued), and no migration concerns.

## Implementation Status — Implemented 2026-06-25 (Epic Orchestrator)

**Done — subsumed by the companion plan.** Per this plan's own execution-order note, companion plan `feature_plan_20260625104016` (Separate Images and HTML with subheaders) was implemented, which replaces the single `'Repo Folders & Files'` subheader with three type-based subheaders (Folders / HTML / Images). The standalone 4-line deletion was therefore unnecessary.

- **Verification:** `node --check src/webview/design.js` → syntax OK. Repo-wide grep for `"Repo Folders"` → zero matches in `src/`.

### Acceptance Criteria
- [x] No `'Repo Folders & Files'` text anywhere in `src/` (confirmed by grep).
- [x] File list still renders correctly (folders + files visible/clickable) — handled by companion plan's `renderGroup`.
- [x] Type-based subheaders ("Folders", "HTML", "Images") appear instead, with empty groups suppressed.

### Pending (requires running the VSIX — not done by orchestrator)
- [ ] Manual Verification steps 1–5 (visual confirmation in the Claude tab).
