# Add Graceful Fallback for Hardcoded cyber-theme-enabled on body in design.html

## Metadata
**Complexity:** 2
**Tags:** bugfix, frontend, ux

## Goal

### Problem
`<body class="cyber-theme-enabled">` (`:3504`) hardcodes the cyber theme as active. The `body.theme-claudify` overrides at `:94-99` suggest another theme exists, but there's no mechanism in the HTML to toggle it — it must be done by JS. If JS fails to load (e.g., `design.js` 404s, CSP blocks it, network error), the user is stuck in cyber mode with no way to switch.

### Root Cause
The theme class is applied in the static HTML as a default, with the expectation that JS will toggle it based on user settings. This creates a hard dependency on JS for theme switching.

## Approach
1. **Keep `cyber-theme-enabled` as the default** in the HTML (reasonable since it's the primary theme)
2. **Add a fallback mechanism**: If JS doesn't load within a timeout, the theme should still be functional. This is already the case since cyber theme is purely CSS — the issue is only that users can't switch themes without JS.
3. **Add a `<noscript>` fallback** that displays a message if JS is disabled
4. **Or accept the current behavior** — if JS fails to load, the entire panel is non-functional anyway (all interactivity is in JS), so being stuck in cyber theme is the least of the problems
5. **Recommended**: Accept the current behavior as a non-issue. The panel is a JS-driven webview — if JS doesn't load, nothing works, not just theme switching. Document this in a comment near the body tag.

## Files Changed
- `src/webview/design.html` — add explanatory comment (minimal change)

## Risks
- This is arguably a non-issue given the JS dependency. The plan may be closed as "won't fix" after assessment.

## Verification
- Verify that the panel works correctly when JS loads (theme can be toggled by JS)
- No additional testing needed if the recommendation is to accept current behavior
