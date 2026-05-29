# Fix Kanban "Copy Prompt for Selected" Icon Bug

## Goal
Fix the wrong icon displayed on the "Copy prompt for selected plans" button in kanban column headers by replacing the incorrectly assigned `{{ICON_22}}` (automation/play icon) with the correct `{{ICON_PROMPT}}` (prompt/copy icon).

## Metadata
- **Tags:** frontend, bugfix, UI
- **Complexity:** 2

## User Review Required
None. This is a pure cosmetic one-token fix with no functional behaviour changes.

## Complexity Audit

### Routine
- Single-file, single-line change in a template/HTML file
- No logic changes — only a string constant reassignment
- The target token `{{ICON_PROMPT}}` already exists in the same icon constant block and is correctly mapped in `KanbanProvider.ts`
- No state, no events, no data flow involved

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None. Icon assignment is static template substitution at render time.

### Security
- None. No user input involved.

### Side Effects
- **Other `{{ICON_22}}` usages must NOT be changed.** Three occurrences of `{{ICON_22}}` exist in the codebase:
  1. `ICON_AUTOBAN` (line 3150) — correct; this IS the play/automation icon.
  2. Static HTML `<img src="{{ICON_22}}"` at line 2013 — a separate "Start Automation" button; leave untouched.
  3. `ICON_PROMPT_SELECTED` (line 3156) — **this is the only occurrence to change.**
- **`ICON_PROMPT_ALL` (`{{ICON_115}}`) is correct** — it maps to `25-101-150 Sci-Fi Flat icons-115.png`, a distinct icon; no change needed there.

### Dependencies & Conflicts
- `{{ICON_PROMPT}}` is already registered in `KanbanProvider.ts` at line 6606:
  ```
  '{{ICON_PROMPT}}': webview.asWebviewUri(..., '25-1-100 Sci-Fi Flat icons-22.png').toString()
  ```
  No changes to `KanbanProvider.ts` are required.

## Dependencies
- None

## Adversarial Synthesis
The only risk is an accidental find-and-replace of all `{{ICON_22}}` occurrences — `ICON_AUTOBAN` must remain unchanged. The fix is otherwise zero-risk: `{{ICON_PROMPT}}` is already registered and used correctly elsewhere in the same file. Mitigation: edit exactly line 3156, not a global replace.

## Proposed Changes

### `src/webview/kanban.html`

**Context:** Icon constant block starting at line 3149. `ICON_PROMPT_SELECTED` is currently assigned `{{ICON_22}}` (the automation/play icon), which is identical to `ICON_AUTOBAN`.

**Logic:** Replace only the `ICON_PROMPT_SELECTED` constant value with `{{ICON_PROMPT}}`, which maps to `25-1-100 Sci-Fi Flat icons-22.png` (the prompt/copy icon).

**Implementation:**

- **File:** `src/webview/kanban.html`
- **Line:** 3156 (exact)
- Change:
  ```diff
  - const ICON_PROMPT_SELECTED = '{{ICON_22}}';
  + const ICON_PROMPT_SELECTED = '{{ICON_PROMPT}}';
  ```

**Edge Cases:**
- Do NOT modify `ICON_AUTOBAN` on line 3150, which legitimately uses `{{ICON_22}}`.
- Do NOT modify the static `<img src="{{ICON_22}}"` at line 2013.

## Verification Plan

### Manual Verification
1. Open the Switchboard kanban view in VS Code.
2. Confirm the "Copy prompt for selected plans and advance to next stage" button in each column header now displays the prompt/copy icon (`25-1-100 Sci-Fi Flat icons-22.png`) instead of the automation/play icon (`25-101-150 Sci-Fi Flat icons-138.png`).
3. Confirm the automation toggle button (ICON_AUTOBAN) in column headers still shows the original play icon — it should be unchanged.
4. Confirm the `ICON_PROMPT_ALL` button beside it still shows its own distinct icon (unchanged).
5. Confirm the tooltip on the fixed button still reads: "Copy prompt for selected plans and advance to next stage".

### Automated Tests
- None required for this cosmetic icon swap.

---

**Recommendation:** Send to Intern
