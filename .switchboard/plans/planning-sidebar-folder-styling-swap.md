# Swap Planning Sidebar Folder/Subheader Styling

## Goal

In `planning.html`, make source folder headers (e.g., "Projects") visually distinct from document cards by stripping their card-like styling and leaving them as plain teal text. Conversely, demote subfolder headers from teal to grey so they sit lower in the visual hierarchy.

**Problem & Root Cause:** Currently, `.source-folder-header` has a tinted background, left border, border-radius, and padding — making it look almost identical to clickable document cards. This creates visual confusion in the Local Docs, Online Docs, Design System, and HTML Preview tabs. Meanwhile, `.folder-subheader` uses `var(--accent-teal)` (the same teal as the folder headers would use), flattening the visual hierarchy between parent folders and child subfolders.

## Metadata

**Tags:** ui, frontend
**Complexity:** 2

## User Review Required

- Confirm that removing padding from `.source-folder-header` (currently `padding: 8px 10px`) and using only margin is acceptable. The header text will sit flush-left against the sidebar edge, which is standard for section labels but differs from the current padded appearance.
- Confirm the color swap: `.source-folder-header` changes from `var(--text-primary)` (white/light) to `var(--accent-teal)`, and `.folder-subheader` changes from `var(--accent-teal)` to `var(--text-secondary)` (grey). This is a significant visual shift.

## Complexity Audit

### Routine
- Replace `.source-folder-header` CSS rule — strip background, border, border-radius, padding; change color to teal
- Replace `.folder-subheader` CSS rule — change color from teal to grey
- Preserve existing margin reset rules unchanged

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — purely CSS changes.
- **Security:** No impact.
- **Side Effects:** Removing padding from `.source-folder-header` means the header text sits flush-left. The `.folder-import-btn` inside the header uses `margin-left: auto` (line 734) so it will still align to the right edge regardless of parent padding. The `.tree-node.folder-subheader` rules (lines 858-872) override background/border/shadow but not color, so the color change will cascade correctly into tree contexts.
- **Dependencies & Conflicts:** No JS changes needed — the same `folder-subheader` and `source-folder-header` classes are already applied by `planning.js`. The `var(--text-secondary)` variable is defined across all themes (default: `#888888`, claude-terracotta: `#A0A0A0`, slightly-darker-black: `#666666`).

## Dependencies

None

## Adversarial Synthesis

Key risks: removing padding from `.source-folder-header` may cause flush-left text alignment that looks unbalanced compared to the padded card content below; the color swap from `var(--text-primary)` to `var(--accent-teal)` is a significant visual shift beyond just "stripping card styling." Mitigations: section headers commonly use flush-left alignment in sidebar UIs; the teal color is the plan's stated design intent and provides the needed visual hierarchy distinction from document cards.

## Proposed Changes

### `src/webview/planning.html`

#### Change 1: Remove card styling from `.source-folder-header` (lines 709–723)

- **Context:** The current rule applies card-like styling (tinted background, left border, border-radius, padding) with `color: var(--text-primary)`. This makes folder headers visually indistinguishable from clickable document cards.
- **Logic:** Strip the background, left border, border-radius, and heavy padding. Change color from `var(--text-primary)` to `var(--accent-teal)` to make headers read as section labels. Keep the flex layout so the "Import" button remains inline on the right. Keep `font-size: 11px`, `font-weight: 700`, and `text-transform: uppercase`.
- **Implementation:** Replace the rule at lines 709–723 with:

  ```css
  .source-folder-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      font-weight: 700;
      color: var(--accent-teal);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin: 8px 0 4px 0;
  }
  ```

  Removed properties: `padding: 8px 10px`, `border-left: 3px solid var(--accent-teal-dim)`, `background: color-mix(...)`, `border-radius: 3px`. Changed: `color: var(--text-primary)` → `color: var(--accent-teal)`.

- **Edge Cases:** The `.folder-import-btn` inside uses `margin-left: auto` (line 734), so right-alignment is preserved without parent padding. No `.tree-node.source-folder-header` override exists, so the base rule applies universally.

#### Change 2: Change `.folder-subheader` color from teal to grey (lines 694–702)

- **Context:** Subfolder headers (e.g., "Requirements", "Architecture") currently use `color: var(--accent-teal)`, the same prominence as the parent folder headers would have after Change 1. This flattens the visual hierarchy.
- **Logic:** Change color to `var(--text-secondary)` so subfolders read as secondary metadata, below the teal parent headers in the visual hierarchy.
- **Implementation:** Replace the rule at lines 694–702 with:

  ```css
  .folder-subheader {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 12px 8px 4px 8px;
      margin-top: 8px;
  }
  ```

  Only change: `color: var(--accent-teal)` → `color: var(--text-secondary)`. All other properties preserved.

- **Edge Cases:** The `.tree-node.folder-subheader` rules (lines 858-872) override background/border/shadow but not color, so the grey color will apply correctly in tree contexts. The `.content-row.collapsed .folder-subheader` rule (line 318) hides subheaders when collapsed — no conflict.

#### Change 3: Preserve margin reset rules (no changes)

- **Context:** These rules ensure proper spacing between headers and subheaders.
- **Logic:** No modification needed.
- **Implementation:** Keep unchanged:
  - `.source-folder-header:first-of-type { margin-top: 4px; }` (line 774)
  - `.source-folder-header + .folder-subheader { margin-top: 0; padding-top: 8px; }` (line 779)

## Scope

Applies uniformly across all folder-bearing tabs: Local Docs, Online Docs, Design System, and HTML Preview. No JavaScript changes required — the same `folder-subheader` and `source-folder-header` classes are already applied by `planning.js`.

## Verification Plan

### Automated Tests
- N/A — this is a pure CSS change with no testable logic. Manual verification only.

### Manual Verification
1. Open the Planning panel and switch to the Local Docs tab.
2. Confirm that source folder names (e.g., "Projects") appear as plain bold teal text with no background/border/padding.
3. Confirm that subfolder names beneath them appear in grey (`var(--text-secondary)`).
4. Confirm the "Import" button remains visible and clickable inline next to source folder names (right-aligned via `margin-left: auto`).
5. Repeat for Online Docs, Design System, and HTML Preview tabs.
6. Verify the visual hierarchy reads clearly: teal folder headers > grey subfolder headers > document cards.
7. Check collapsed state: confirm `.content-row.collapsed .folder-subheader` still hides subheaders correctly.

---

**Recommendation:** Complexity 2 → **Send to Intern**
