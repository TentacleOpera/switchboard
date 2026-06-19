# Fix #preview-pane-tickets Padding Override in design.html

## Metadata
**Complexity:** 1
**Tags:** bugfix, frontend

## Goal

### Problem
`#preview-pane-tickets` has its padding set twice in `design.html`:
- `:906` — group selector `#preview-pane, #preview-pane-online, #preview-pane-tickets` sets `padding: 0 16px 16px 16px`
- `:2668` — `#preview-pane-tickets` alone sets `padding: 0`

Both are ID selectors with equal specificity. The second wins by source order, silently removing all padding. Anyone reading the first rule would expect 16px horizontal/bottom padding that doesn't actually apply.

### Root Cause
A later rule was added to reset padding for the tickets preview pane without removing it from the earlier group selector.

## Approach
1. Remove `#preview-pane-tickets` from the group selector at `:900` (along with `#preview-pane` and `#preview-pane-online` if those are also dead — see dead CSS plan)
2. Keep the `padding: 0` rule at `:2668` if it's intentional, or remove it if padding is actually desired
3. If `#preview-pane` and `#preview-pane-online` are dead (likely), remove the entire group selector at `:898-908`

## Files Changed
- `src/webview/design.html` — remove conflicting selector

## Risks
- If `#preview-pane-tickets` is also dead CSS (no tickets tab in current HTML), this entire conflict is moot and both rules should be removed as part of the dead CSS cleanup

## Verification
- If tickets tab exists: verify ticket detail preview renders with correct padding
- If tickets tab is dead: verify removal causes no visual change
