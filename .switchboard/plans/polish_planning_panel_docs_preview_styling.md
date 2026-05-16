# Polish Planning Panel Docs Preview Styling

## Goal
Align the Planning Panel's markdown docs preview and sidebar with the premium dark-mode aesthetic of the Kanban board by refining typography, colour hierarchy, spacing, and scrollbars.

## Metadata
**Tags:** ui, polish, css
**Complexity:** 2

## User Review Required
None. Purely visual CSS changes with no functional or breaking changes.

## Complexity Audit

### Routine
- **Heading colour changes** in `#markdown-preview` and `#markdown-preview-online`
  - Change `h1` and `h2` from `var(--accent-teal)` to crisp white/grays (`#f0f0f0`, `#e0e0e0`)
  - Add bottom border to `h1` for grounding
  - Reserve teal exclusively for links and interactive accents
- **Body typography tweaks**
  - Increase `line-height` to `1.7` for paragraphs and list items
  - Soften body text colour to `#a0a0a0`
  - Reduce font size to `13px` for body text
- **Code block styling**
  - Switch border from `var(--accent-teal-dim)` to `var(--border-color)`
  - Increase padding to `16px`
  - Use `var(--panel-bg2)` background
- **Preview container framing**
  - Change `max-width` from `900px` to `800px`
  - Add `margin: 0 auto` to centre the content
  - Increase padding to `40px`
- **Sidebar header subdual**
  - Change `.imported-docs-header` colour from teal to `var(--text-secondary)`
- **Custom scrollbar addition**
  - Add WebKit scrollbar styles using `--panel-bg` and `#333333` / `#555555`

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:** None — CSS only.

**Security:** No security implications.

**Side Effects:**
- Visual appearance of the Planning Panel docs preview will shift from "default dark markdown" to "contained, app-like document viewer".
- Online preview (`#markdown-preview-online`) will receive identical styling to keep both preview panes consistent.
- Scrollbar styling applies globally within the webview; this is desired for all panels.

**Dependencies & Conflicts:**
- No active plans touching `src/webview/planning.html` CSS in the Kanban board.
- Complements the multi-repo search fix (`fix_planning_panel_docs_multi_repo_search.md`) by improving the visual presentation of the docs it now successfully finds.

## Dependencies
None

## Adversarial Synthesis
Key risks: Over-restricting `max-width` to `800px` may feel too narrow on ultra-wide monitors, and hardcoded `40px` padding might cramp small views. Mitigations: `margin: 0 auto` preserves readability on wide monitors, and flexible flexbox containers handle varying widths gracefully.

## Proposed Changes

### [`src/webview/planning.html`]
- **Context:** Embedded CSS styles for the local (`#markdown-preview`) and online (`#markdown-preview-online`) markdown preview panes, as well as sidebar elements.
- **Logic:** Refine colours, typography, padding, and scrollbars to match the workspace's dark-mode aesthetic.
- **Implementation:**
  - Update `h1` colours to `#f0f0f0` with a `1px solid var(--border-color)` bottom border.
  - Update `h2` colours to `#e0e0e0` with `margin-top: 24px`.
  - Set `p` and `li` to `line-height: 1.7`, `color: #a0a0a0`, and `font-size: 13px`.
  - Update `pre` blocks to use `background: var(--panel-bg2)`, `border: 1px solid var(--border-color)`, and `padding: 16px`.
  - Change preview container `max-width` to `800px`, add `margin: 0 auto`, and increase padding to `40px`.
  - Change `.imported-docs-header` colour to `var(--text-secondary)`.
  - Add global WebKit scrollbar styles (`::-webkit-scrollbar` with track and thumb colours based on `--panel-bg`).
- **Edge Cases:** Ensure CSS rules remain strictly scoped by ID (`#markdown-preview`, `#markdown-preview-online`) so they do not inadvertently break typography in the sidebar or tree view.

## Verification Plan

### Automated Tests
- None. This is a purely visual CSS change; manual visual verification via the webview is required.
