# Fix .content-row Collapsed State !important Usage in design.html

## Metadata
**Complexity:** 2
**Tags:** refactor, frontend

## Goal

### Problem
`.content-row.collapsed > :first-child` uses `flex: 0 0 40px !important` and `.content-row.collapsed > :last-child` uses `flex: 1 !important` (`:231-236`). The `!important` is needed because the base rule (`:222-229`) sets `flex` with a transition (`transition: flex 0.2s ease` at `:220`), and the collapsed state must override it. Using `!important` is a code smell that makes future overrides harder and indicates the transition is fighting the collapsed state.

### Root Cause
The transition on `flex` creates a specificity conflict — the collapsed state needs to win over the base `flex` value during the transition. Instead of structurally avoiding the conflict, `!important` was used as a shortcut.

## Approach
1. **Remove the transition from the base flex rule** (`:220`) — transitions on `flex` are unreliable anyway (not all browsers animate `flex` smoothly)
2. **Transition `flex-basis` or `width` instead** if animation is desired — these animate more reliably
3. **Remove `!important`** from the collapsed state rules once the transition conflict is resolved
4. Alternatively, increase specificity of the collapsed rule (e.g., `.content-row.collapsed > #tree-pane`) to override without `!important`

## Files Changed
- `src/webview/design.html` — CSS changes on `.content-row` rules

## Risks
- Removing the flex transition may make sidebar collapse/expand feel abrupt — need to test if animation is actually visible (0.2s is very fast)
- If animation is desired, moving to `flex-basis` transition requires the base rule to use `flex-basis` explicitly

## Verification
- Toggle sidebar collapse on each tab — verify it collapses to 40px and expands back
- Verify no layout glitches during the transition
