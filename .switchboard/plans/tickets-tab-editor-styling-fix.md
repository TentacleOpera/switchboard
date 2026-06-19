# Soften Tickets Tab Inline Editor Styling to Match Docs Tab

## Goal
Make the tickets tab inline edit-mode editor (title + description) look seamless and consistent with the docs tab `.markdown-editor`, replacing harsh teal outlines and the dark `panel-bg2` box with soft, panel-matched styling — without breaking soft-wrap, save, or resize behavior.

## Metadata
**Tags:** ui, frontend, bugfix
**Complexity:** 2

## User Review Required
- **Concrete `min-height` value:** ✅ Resolved — `480px` approved.
- **Title editability affordance:** ✅ Resolved — neutral `1px solid var(--border-color)` soft box approved. User accepts that discoverability via clicking is sufficient; no focus-only highlight needed (inline `style=` can't express `:focus` anyway).

## Problem
The tickets tab's inline edit mode (`enterTicketsEditMode()` in `src/webview/planning.js`) builds a `<textarea>` and a `contenteditable` `<h1>` via injected HTML with harsh inline styles that clash with the rest of the UI:
- `outline: 1px solid var(--accent-teal)` on **both** the title H1 (line 5992) and the description textarea (line 5993) creates bright teal borders.
- `background: var(--panel-bg2, #1e1e1e)` renders the textarea as a dark box that stands out against the panel background.
- `min-height: 240px` starts the editor too small, forcing the user to manually drag it larger.
- `border-radius: 4px` adds a rounded-box look that the docs editor does not have.

The docs tab uses the `.markdown-editor` CSS class (`src/webview/planning.html:2323-2337`) which is seamless: `background: var(--panel-bg)`, `border: none`, `outline: none`, `height: 100%`, `padding: 16px`.

## Complexity Audit

### Routine
- Editing two inline `style=` strings in a single function (`enterTicketsEditMode()`), `src/webview/planning.js:5992-5993`. Pure presentation change; no logic, no data flow, no new state.
- Verified non-coupling: the save handler (`src/webview/planning.js:5605-5619`) reads the editor by **element ID** (`ticket-edit-description`, `ticket-edit-title`), never by class or style. Restyling cannot break save.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit
- **Race Conditions:** None. Synchronous DOM string-build inside one function; no async, no shared mutable state touched.
- **Security:** No change. Existing `escapeHtml()` on title/markdown content is preserved verbatim; this plan only edits static style literals, not interpolated user content.
- **Side Effects:**
  - **Do NOT reuse the `.markdown-editor` class or `height:100%`.** The docs editor gets `height:100%` only because it sits inside a `.edit-mode` flex container with a bounded-height parent (preview hidden via `.edit-mode #markdown-preview { display:none }`). The tickets tab has **no** `.edit-mode` container, so `height:100%` would collapse the textarea. Use `min-height` instead.
  - The `.markdown-editor` class also carries `white-space: pre` and `tab-size: 4`. The tickets editor edits raw markdown prose; applying the class would disable soft-wrap and force horizontal scrolling on long lines. Keep the textarea's default soft-wrap by **not** adding the class — soften the inline styles only.
  - Cyber theme: `.cyber-theme-enabled .markdown-editor` restyles the docs editor; the tickets inline editor never responded to it (it doesn't use the class). This remains a pre-existing, out-of-scope limitation — noted, not fixed here.
- **Dependencies & Conflicts:** None. Self-contained within `enterTicketsEditMode()`. Renders for both Linear and ClickUp providers (the function branches on `provider` only for content, not styling), so the single style change covers both paths.

## Dependencies
- None

## Adversarial Synthesis
**Risk Summary:** Key risks are (1) naively copying the docs `height:100%`/`.markdown-editor` class, which would collapse the textarea (no bounded parent) and kill soft-wrap (`white-space:pre`); and (2) fully stripping the title outline, leaving no editable affordance since inline styles can't express `:focus`. Mitigations: keep inline styling with softened values + a concrete `min-height:480px` instead of the class; replace the title's teal outline with a neutral `var(--border-color)` box rather than removing it. Save/resize/both-providers are unaffected (save keys off element IDs, not styling).

## Proposed Changes

### `src/webview/planning.js` — `enterTicketsEditMode()` (description textarea, line 5993)
- **Context:** Injected `<textarea id="ticket-edit-description">` currently styled with teal outline, `panel-bg2` background, `min-height:240px`, and `border-radius:4px`.
- **Logic:** Match the docs `.markdown-editor` look (seamless, panel-matched) while preserving soft-wrap and resize, which the docs class would break.
- **Implementation:** In the inline `style` string, apply:
  - `background: var(--panel-bg2,#1e1e1e)` → `background: var(--panel-bg)`
  - `outline: 1px solid var(--accent-teal)` → `outline: none`
  - `min-height: 240px` → `min-height: 480px`
  - Remove `border-radius: 4px` (flat, docs-consistent)
  - Keep `border: none`, `resize: vertical`, `box-sizing: border-box`, `line-height`, `font-size`, `color`, and the existing `font-family` (no class, so soft-wrap is retained).
  - *Clarification (optional, strictly to match docs):* `padding: 8px` → `padding: 16px` to mirror the docs editor exactly. Defer to user preference; not required for the core fix.
- **Edge Cases:** No `.edit-mode` container exists here, so `min-height` (not `height:100%`) is mandatory. Soft-wrap must stay on — do not add the `.markdown-editor` class.

### `src/webview/planning.js` — `enterTicketsEditMode()` (contenteditable title H1, line 5992)
- **Context:** `<h1 id="ticket-edit-title" contenteditable="true">` styled with `outline:1px solid var(--accent-teal)`, `border-radius:4px`, `padding:4px 8px`.
- **Logic:** Soften the teal outline to a neutral, non-jarring affordance that still signals the title is editable. Inline styles cannot express `:focus`, so the affordance must be a static, low-key border.
- **Implementation:** Replace `outline:1px solid var(--accent-teal)` with `border:1px solid var(--border-color)` (and `outline:none`). Keep `border-radius:4px` and `padding:4px 8px` so it reads as a subtle editable field.
- **Edge Cases:** Title must remain visually distinct from rendered (read-only) headings but must not look like an alarm. A neutral border achieves this; full removal would erase the editable cue.

## Validation

### Automated Tests
- None applicable — this is a static inline-style change in webview-injected HTML with no testable logic branch. (Per session directive, the test suite is run separately by the user.)

### Manual Verification
- Open the tickets tab, select a ticket, click **Edit**.
- Confirm the textarea has **no** teal outline, blends with the panel background (`var(--panel-bg)`), and is flat (no rounded corners).
- Confirm the editor starts at a comfortable height (~480px) without needing immediate resize, and that `resize: vertical` still works.
- Confirm long markdown lines **soft-wrap** (no horizontal scroll).
- Confirm the title H1 shows a subtle neutral border, not a teal box, and is still obviously editable.
- Confirm **Save** persists edited title + body correctly, and verify on **both** a Linear ticket and a ClickUp ticket.

---

**Recommendation:** Complexity 2 → **Send to Coder.**

## Review Findings

**Reviewed:** `src/webview/planning.js:6240-6241` (`enterTicketsEditMode()`). Implementation matches plan exactly — title H1 uses `border:1px solid var(--border-color);outline:none`, textarea uses `background:var(--panel-bg);outline:none;min-height:480px;padding:16px` with no `border-radius`. No teal outlines or `panel-bg2` remain in the edit mode. Save handler reads by element ID (`ticket-edit-description`, `ticket-edit-title`), not styling — no breakage risk. Both Linear and ClickUp providers share the same function. `escapeHtml()` preserved on all interpolated content. CSS variables `--border-color` and `--panel-bg` confirmed defined in `:root` (planning.html:52-54). No `.markdown-editor` class added — soft-wrap preserved. **No files changed. No fixes needed. Zero remaining risks.**
