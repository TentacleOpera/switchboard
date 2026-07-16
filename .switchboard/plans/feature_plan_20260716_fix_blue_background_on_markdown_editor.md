# Plan: Fix Blue Background on Markdown Editor Panel

## Goal
Make the markdown editor's shell, toolbar, live-preview pane, view-toggle, and table popover use the app's black theme background instead of the blue-black GitHub fallback (`#0d1117` / `#161b22`), so the editor visually matches the rest of the panel.

**Problem.** The markdown editor panel shows an ugly blue-ish background (`#0d1117`) instead of matching the theme's pure-black background.

**Root cause.** `src/webview/markdownEditor.js` styles several editor surfaces with CSS custom properties that are **never defined** in any host webview's `:root`, so every one falls through to a hard-coded GitHub-dark fallback:
- `.md-editor-shell` (line ~12): `background: var(--bg-color, #0d1117)` — `--bg-color` is undefined.
- `.md-toolbar` (line ~27): `background: var(--toolbar-bg, #161b22)` — `--toolbar-bg` is undefined.
- `.md-view-toggle` (line ~59): `background: var(--toggle-bg, #0d1117)` — `--toggle-bg` is undefined. *(Not listed in the original plan — see Clarification.)*
- `.md-live-preview` (line ~109): `background: var(--preview-bg, #0d1117)` — `--preview-bg` is undefined.
- `.md-table-popover` (line ~138): `background: var(--toolbar-bg, #161b22)` — same undefined `--toolbar-bg`. *(Not listed in the original plan — see Clarification.)*

`#0d1117` is GitHub's dark-theme blue-black; against the app's real `--panel-bg: #000000` it reads as blue. `#161b22` is a blue-ish dark gray.

**Verified facts (grounding):**
- `--panel-bg: #000000` and `--panel-bg2: #0a0a0a` **are** defined in `:root` of `planning.html` (lines 40-41) and in all six webview HTMLs (`design`, `implementation`, `kanban`, `planning`, `project`, `setup`).
- The four blue-fallback var names (`--bg-color`, `--toolbar-bg`, `--preview-bg`, `--toggle-bg`) appear **nowhere** in the webviews — confirming the fallback is always taken.
- `markdownEditor.js` mounts inside `planning.html` (Planning panel: docs/design/kanban/devdocs/tickets tabs) and the Design panel — both black-theme documents. CSS custom properties on `:root` cascade to the elements `markdownEditor.js` injects into the same DOM, so `--panel-bg`/`--panel-bg2` resolve correctly at every mount point.

## Metadata
- **Tags:** ui, bugfix
- **Complexity:** 3

## User Review Required
- None. This is a straightforward theme-alignment fix. `--panel-bg` (#000000) for the shell and `--panel-bg2` (#0a0a0a) for the chrome surfaces (toolbar, preview, toggle, popover) matches how the surrounding panel already distinguishes base vs. raised surfaces.

## Complexity Audit

### Routine
- Single-file, CSS-only change (`markdownEditor.js` injected `<style>` block).
- Reuses existing, already-defined theme variables — no new variables introduced.
- Chosen fallbacks are black (`#000000` / `#0a0a0a`), so the fix is safe even in any future host that omits the vars.

### Complex / Risky
- Minor: the change affects the editor at **every** mount point (Planning tabs + Design panel), not just Tickets. This is desirable (they all share the bug) but should be eyeballed in more than one tab.

## Edge-Case & Dependency Audit
- **Race Conditions:** None. Static stylesheet injected once (guarded by `if (!document.getElementById('md-editor-styles'))`).
- **Security:** None. Pure CSS literal values; no user input.
- **Side Effects:** Changes editor background everywhere the shell mounts. `.md-toggle-btn.active` (accent-teal) and `.md-table-cell.highlighted` (accent-teal) are intentional accents and are **not** touched.
- **Dependencies & Conflicts:** **Overlap with "Fix Markdown Editor Internal Scrollbar."** Both edit the `.md-editor-shell` rule block (lines ~7-17) of the same injected stylesheet — this plan changes its `background`, the scrollbar plan changes its `height`. Different properties, no contradiction, but the same rule block. When executed by a single worker they are applied as one coherent edit; if ever split across parallel workers, land them together to avoid a merge conflict. The table-icon subtask touches a different region (line ~417) of the same file — no conflict.

## Dependencies
- Coordinated-edit relationship with **`feature_plan_20260716_fix_markdown_editor_internal_scrollbar.md`** (shared `.md-editor-shell` rule block). No hard ordering; land together.
- Independent of the image-preview and table-icon subtasks.

## Adversarial Synthesis
Key risks: the change is global to the editor (all mount points), so a wrong colour choice would regress several tabs at once — mitigated by reusing the already-proven `--panel-bg`/`--panel-bg2` values with black fallbacks. Secondary risk was an incomplete fix leaving the view-toggle and table popover still blue; this plan closes that by expanding scope to all five undefined-var surfaces. No logic or data risk.

## Proposed Changes

### `src/webview/markdownEditor.js` — injected `<style>` block
Replace each undefined variable + blue fallback with an existing theme variable + black fallback.

- **Context / Logic / Implementation** — five edits in the `style.textContent` template:

  ```css
  /* .md-editor-shell (line ~12) */
  - background: var(--bg-color, #0d1117);
  + background: var(--panel-bg, #000000);

  /* .md-toolbar (line ~27) */
  - background: var(--toolbar-bg, #161b22);
  + background: var(--panel-bg2, #0a0a0a);

  /* .md-view-toggle (line ~59) */
  - background: var(--toggle-bg, #0d1117);
  + background: var(--panel-bg2, #0a0a0a);

  /* .md-live-preview (line ~109) */
  - background: var(--preview-bg, #0d1117);
  + background: var(--panel-bg2, #0a0a0a);

  /* .md-table-popover (line ~138) */
  - background: var(--toolbar-bg, #161b22);
  + background: var(--panel-bg2, #0a0a0a);
  ```

- **Clarification (scope of the two extra rules).** The original plan listed only the shell, toolbar, and preview. The view-toggle (`.md-view-toggle`, line ~59) and the table-size popover (`.md-table-popover`, line ~138) share the **identical** root cause (undefined var → GitHub-blue fallback) and are part of the editor chrome the plan's own Verification requires to "match the theme." Fixing them is the same defect, not net-new scope — included here so the fix is complete rather than leaving two surfaces still blue.

- **Edge Cases:** The preview is set to `--panel-bg2` (a hair lighter than the shell's `--panel-bg`) so the split-view border between editor and preview stays legible, matching the raised-surface convention used elsewhere in the panel. If a perfectly flat look is preferred, `--panel-bg` may be used for the preview too — cosmetic, not required.

## Verification Plan

### Automated Tests
- None. Per session directive, no automated tests are run; there is no test harness for injected webview CSS.

### Manual / Observational
1. Open a ticket → edit mode. Confirm the editor shell, toolbar, view-toggle strip, and live-preview pane are black (matching the panel), with no blue cast.
2. Click the table button → confirm the size-picker popover background is also black, not blue.
3. Repeat in at least one other mount point (a Local/Design doc editor in the Planning or Design panel) to confirm no regression there.
4. Toggle Split / Edit / Preview views → all three states stay on-theme.

## Recommendation
Complexity 3 → **Send to Intern.** Routine single-file CSS alignment; the only care point is verifying more than one mount point since the fix is global to the editor.

## Completion Report (2026-07-16)
Implemented all five edits in the injected `<style>` block of `src/webview/markdownEditor.js`: `.md-editor-shell` → `var(--panel-bg, #000000)`; `.md-toolbar`, `.md-view-toggle`, `.md-live-preview`, `.md-table-popover` → `var(--panel-bg2, #0a0a0a)`. Grep confirms no `#0d1117`/`#161b22` fallbacks remain in the file. Landed together with the scrollbar fix's edits to the same `.md-editor-shell` rule block as one coherent change. No issues encountered; multi-mount visual check remains manual.

## Review Findings
Reviewed all five var swaps against the plan; no CRITICAL/MAJOR findings. Orphaned-reference audit: no remaining `--bg-color`/`--toolbar-bg`/`--preview-bg`/`--toggle-bg` usages in `markdownEditor.js` (the matches in `kanban.html`/`implementation.html`/`setup.html` are those files' own `:root` definitions for unrelated surfaces — not the editor). `--panel-bg`/`--panel-bg2` are defined in all six webview `:root` blocks, so the vars resolve at every mount point; black fallbacks keep it safe if a host omits them. No code fixes applied. Remaining risk: none functional — only the manual multi-mount eyeball that the split-view editor/preview border stays legible with `--panel-bg2` on the preview.
