# Plan: Fix Markdown Editor Internal Scrollbar

## Goal
Stop the markdown editor (tickets detail edit mode) from collapsing into a cramped box with a tiny internal scrollbar. The editor should present a comfortably tall edit area and let the surrounding pane scroll for overflow, instead of forcing everything into a short, internally-scrolling region.

**Problem.** The markdown editor in the tickets detail view shows an internal scrollbar with a fixed, low height rather than expanding naturally within its container.

**Root cause (confirmed against the code).**
- `src/webview/markdownEditor.js` styles `.md-editor-shell` with `height: 100%; overflow: hidden` (lines ~7-17).
- Inside it, `.md-body` has `flex: 1; overflow: hidden; height: 100%` (lines ~79-87) and `.md-body > textarea.markdown-editor` has `height: 100% !important` (line ~99).
- `enterTicketsEditMode` (PlanningPanelProvider.ts ~line 10068) gives the textarea inline `min-height:480px;height:auto;resize:vertical`.
- The shell's `height: 100%` resolves against `#tickets-detail-content`, which has **no defined height** — its only rule is a child-background override (`planning.html` line ~2472). A percentage height against an auto-height ancestor is not definite, so the whole `height:100%` chain (shell → body → textarea) collapses toward content/`min-height` and, combined with `overflow:hidden`, yields the tiny internal scrollbar instead of a natural, tall editor.

**Container facts (grounding — confirmed in `planning.html`):**
- `#tickets-detail-content` (line 3911) — child of `#markdown-preview-tickets`; **no** height/overflow/flex/display rule of its own.
- `#markdown-preview-tickets` (CSS lines 1048-1061) — already `flex: 1; overflow-y: auto`. It is a **block** container (no `display:flex`), and it is a flex *item* of `.preview-content-wrapper`.
- `.preview-content-wrapper` (CSS line 1005 + inline at line 3899) — `display:flex; flex-direction:column; flex:1; overflow-y:auto`.
- **Therefore an existing scroll container already wraps the editor** (`#markdown-preview-tickets`, `overflow-y:auto`). The fix is to let the editor size to content and hand overflow to that existing scroller — not to invent a new one.

## Metadata
- **Tags:** ui, bugfix
- **Complexity:** 5

## User Review Required
- **Edit-area scroll behaviour (genuine product call):** Two acceptable end-states —
  1. **CSS-only (recommended):** the edit textarea has a comfortable `min-height` (≥480px) floor; content beyond that scrolls *inside the textarea* (a normal, full-size editor). Simplest, zero JS.
  2. **Textarea auto-grow:** the textarea grows with its content so it never scrolls internally and the surrounding pane (`#markdown-preview-tickets`) does all the scrolling. Matches "the container should scroll, not a tiny inner area" literally, but requires a small JS addition (set `height = scrollHeight` on input).
  Default is option 1 unless you want the page-scrolls-only feel of option 2.

## Complexity Audit

### Routine
- The core change is CSS in one file's injected stylesheet.
- Removing a proven no-op (see Superseded below) and leaning on an already-present outer scroller.

### Complex / Risky
- **Shared-shell blast radius.** `.md-editor-shell`, `.md-body`, and the textarea rule are **shared** across every editor mount point — Planning tabs (docs/design/kanban/devdocs/tickets) and the Design panel — not just Tickets. Any height-behaviour change affects all of them. This is acceptable because every mount wraps the editor in a `flex:1; overflow-y:auto` pane, so content-driven sizing degrades uniformly — but it must be eyeballed at more than one mount point.
- **Flex/auto-height interaction is empirical.** The exact combination of shell/body/textarea height rules that yields the desired result in the VS Code webview (Chromium) is hard to prove statically; expect one visual-verification iteration in the running extension.

## Edge-Case & Dependency Audit
- **Race Conditions:** None. Static stylesheet + one-time DOM insertion.
- **Security:** None. CSS-only (plus, under option 2, a DOM-height write with no user-controlled markup).
- **Side Effects:** Height behaviour changes at all editor mount points (see blast radius). The split-view row (`textarea` + `.md-live-preview`) must remain balanced — both are `flex:1` in `.md-body`; verify the preview pane still stretches to match the editor after the height rules change.
- **Dependencies & Conflicts:** **Overlap with "Fix Blue Background on Markdown Editor Panel."** Both edit the `.md-editor-shell` rule block (lines ~7-17): this plan changes its `height`, the blue-bg plan changes its `background`. Different properties, no contradiction. Executed by one worker they are a single coherent edit; if split across parallel workers, land together to avoid a merge conflict. The table-icon subtask touches a different region (line ~417) — no conflict.

## Dependencies
- Coordinated-edit relationship with **`feature_plan_20260716_fix_blue_background_on_markdown_editor.md`** (shared `.md-editor-shell` rule block). No hard ordering; land together.
- Independent of the image-preview and table-icon subtasks.

## Adversarial Synthesis
Key risks: (1) the shared shell means a wrong height rule regresses docs/design/kanban editors, not just tickets — mitigated by relying on the outer `overflow-y:auto` pane every mount already has, and verifying multiple mounts; (2) partially fixing the shell (`min-height`) while leaving the inner `.md-body`/textarea `height:100%` chain intact would re-introduce a collapsed inner box — so the fix must relax the whole chain, not just the shell. The original plan's second step (adding `flex:1` to `#tickets-detail-content`) is a no-op and is superseded below.

## Proposed Changes

### `src/webview/markdownEditor.js` — injected `<style>` block (primary change)
Make the editor content-driven and hand overflow to the existing outer scroller. Relax the entire `height:100%` chain, not just the shell.

- **`.md-editor-shell` (lines ~7-17):**
  ```css
  - height: 100%;
  + min-height: 480px;
  ```
  (Keep `display/flex-direction/border/overflow/width/box-sizing`. Dropping the fixed `height:100%` lets the shell grow with its content; the `min-height` floor prevents the cramped-box symptom. Coordinate with the blue-bg plan's `background` edit to the same rule.)

- **`.md-body` (lines ~79-87):**
  ```css
  - height: 100%;
  ```
  (Remove the percentage height; keep `flex: 1`. With the shell no longer at a fixed 100%, `flex:1` correctly fills the shell's content area and the leftover `height:100%` would only re-collapse against the now-auto shell.)

- **`.md-body > textarea.markdown-editor` (line ~99):**
  ```css
  - height: 100% !important;
  + height: auto;
  ```
  (Let the textarea's inline `min-height:480px` (from `enterTicketsEditMode`) drive its size. Under **option 1**, content beyond 480px scrolls inside the textarea. Under **option 2**, add the JS auto-grow below so it never scrolls internally.)

- **`.md-live-preview` (lines ~103-111):** keep `flex:1; overflow-y:auto`; verify it still stretches to the editor's height in split view after the above. If it collapses, change its `height: 100%` to `align-self: stretch` (flex default already stretches, so no change is expected — verify).

### (Option 2 only) `src/webview/markdownEditor.js` — textarea auto-grow
In the existing `input` handler (~line 569, alongside the debounced `triggerRender`), add:
```js
const autoGrow = () => { textarea.style.height = 'auto'; textarea.style.height = textarea.scrollHeight + 'px'; };
// call autoGrow() on input and once after attach
```
This makes the pane (`#markdown-preview-tickets`) the sole scroller. Only implement if the user chooses option 2 in User Review Required.

### Superseded: the original `#tickets-detail-content` change
> **Superseded:** "In `planning.html`, ensure `#tickets-detail-content` has `overflow-y: auto; flex: 1; min-height: 0` so the editor can scroll naturally within the pane."
> **Reason:** `#markdown-preview-tickets` (the parent of `#tickets-detail-content`) is a **block**, not a flex container, so `flex:1` / `min-height:0` on `#tickets-detail-content` have no effect (flex item properties require a flex parent). Additionally, `#markdown-preview-tickets` is **already** `overflow-y:auto; flex:1`, so a second overflow container on the child is redundant and would just create a nested scroll region — a second way to produce the exact "tiny inner scrollbar" being fixed.
> **Replaced with:** No change to `planning.html` is required. Rely on the existing `#markdown-preview-tickets` scroller and make the editor content-driven in `markdownEditor.js` (above). If, after verification, a mount point still collapses, scope a height override to the tickets context (`#markdown-preview-tickets .md-editor-shell { … }`) rather than adding flex properties to a block-parented child.

## Verification Plan

### Automated Tests
- None. Per session directive, no automated tests are run; layout behaviour here is only meaningfully verifiable by eye in the running webview.

### Manual / Observational
1. Enter edit mode on a ticket → the editor fills a comfortable area (≥480px), with no tiny/cramped internal scrollbar.
2. Type enough text to exceed the viewport → under option 1 the textarea scrolls at ≥480px; under option 2 the `#markdown-preview-tickets` pane scrolls and the textarea does not.
3. Resize the panel → the editor adapts without collapsing.
4. Split view → editor and preview panes stay the same height and both remain usable.
5. **Regression check (blast radius):** open a Local/Design doc editor (Planning or Design panel) in edit mode and confirm it is not cramped or double-scrolling after the shared-shell change.

## Recommendation
Complexity 5 → **Send to Coder.** CSS-only in the common case, but the shared-shell blast radius and the empirical flex/auto-height tail need someone who will verify multiple mount points, not just tickets.

## Completion Report (2026-07-16)
Implemented option 1 (CSS-only, the plan's default): in `src/webview/markdownEditor.js`, `.md-editor-shell` `height: 100%` → `min-height: 480px`; removed `height: 100%` from `.md-body`; textarea `height: 100% !important` → `height: auto`. `.md-live-preview` left unchanged per plan (flex stretch keeps split panes balanced). No `planning.html` change (superseded step honored). Verified the relaxed chain doesn't collapse other mounts: shell min-height + `.md-body flex:1` + flex-stretch keeps textareas ≥~440px everywhere, and the higher-specificity `height: auto` rule still overrides planning.html's `.markdown-editor { height: 100% }`. Visual verification at multiple mounts remains manual.

## Review Findings
Regression-audited the shared-shell blast radius across all mount points (tickets, docs, design, kanban, devdocs, project). No CRITICAL/MAJOR findings: `.md-editor-shell` `min-height:480px` floors every mount; `.md-body` is `display:flex` so its `flex:1` children (textarea + preview) stretch cross-axis via default `align-items:stretch`, keeping the textarea tall even in mounts without the tickets-only inline `min-height:480px` (planning.js:10040) — no collapse. `.md-live-preview`'s retained `height:100%` is now redundant (flex stretch covers it) but harmless, matching the plan's "verify, no change expected." No orphaned references to the removed `height:100%` rules. No code fixes applied. Remaining risk: empirical only — the plan's own visual-verification steps (split-view balance, resize behaviour) remain manual in the running webview.
