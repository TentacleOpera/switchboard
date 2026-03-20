# Review column out of alignment

## Goal
- The reviewed column is now out of alignment after the buttons were put in the strip for the other columns. please put the icon strip back for the reviewed column, just with no buttons in it. 

## Proposed Changes
- Added CSS rule to ensure the last column (Reviewed) has the same header height as other columns by forcing its button area to have the same min-height

## Verification Plan
- The Reviewed column header should now align with other columns

## Open Questions
- None

## Complexity Audit
**Manual Complexity Override:** Low

### Band B — Complex / Risky
- None.

## Reviewer Pass — 2026-03-19

### Stage 1: Grumpy Principal Engineer

**[NIT]** *The CSS specificity dance.* You've got `.kanban-column:last-child .column-button-area` setting both `height` AND `min-height` to `32px`. The parent `.column-button-area` class already has `min-height: 32px`. So you're just pinning `height` on the last column. Fine, but the comment says "ensure last column has same header height" — it's the *button area* height, not the *header* height. Misleading comment, though the code is correct. I've seen empires fall over misleading CSS comments. Well, maybe not empires. Interns, definitely.

**[NIT]** *Empty div in the DOM.* Line 886 renders `<div class="column-button-area"></div>` for the Reviewed column. An empty div with `min-height: 32px` to act as a spacer. It works, but it's semantically a spacer pretending to be a button area. Future maintainers might add buttons to it thinking it's ready for content. A comment in the HTML template would be polite. Not critical — the CSS class name makes the intent semi-obvious.

**Verdict**: Two NITs. Zero functional issues. The fix is minimal, correct, and does exactly what the goal stated.

### Stage 2: Balanced Synthesis

- **Keep**: Both changes (CSS rule at lines 527-531, empty button area div at line 886). They solve the alignment problem with zero risk.
- **Fix now**: Nothing. Both NITs are cosmetic/comment-level and not worth a change cycle.
- **Defer**: Consider adding an HTML comment `<!-- empty strip for alignment -->` at line 886 in a future cleanup pass.

### Code Fixes Applied
None required — no CRITICAL or MAJOR findings.

### Verification Results
- **TypeScript compile**: `npx tsc --noEmit` → **PASS** (exit code 0, zero errors)
- **Visual**: Empty `.column-button-area` div renders for the Reviewed column, matching the 32px height of populated strips in other columns

### Files Changed
- `src/webview/kanban.html` (lines 527-531: CSS rule; line 886: empty button area div)

### Remaining Risks
- None. Trivial cosmetic fix with no functional side effects.

### Status: ✅ APPROVED
