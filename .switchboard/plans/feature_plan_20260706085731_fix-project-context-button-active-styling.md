# Fix Project Context Button Active Styling in project.html

## Goal

In `project.html`, the "PROJECT CONTEXT: ON" button uses an inline-styled solid teal background with dark text when active, which looks completely different from the standard active button style used elsewhere in the extension (colored outline + colored text on a subtly tinted background). The active state should use the same `.is-active` CSS class pattern that other toggle buttons use.

### Problem Analysis & Root Cause

The project context button's active state is set in `src/webview/project.js` at lines 1302-1312:
```javascript
function updateProjectContextButton() {
    if (!btnProjectContext) return;
    btnProjectContext.textContent = projectContextEnabled ? 'PROJECT CONTEXT: ON' : 'PROJECT CONTEXT: OFF';
    // project.html has no is-teal/is-off classes — toggle the "on" look inline.
    btnProjectContext.style.background = projectContextEnabled ? 'var(--accent-teal)' : '';
    btnProjectContext.style.color = projectContextEnabled ? '#001014' : '';
    btnProjectContext.style.borderColor = projectContextEnabled ? 'var(--accent-teal)' : '';
    btnProjectContext.setAttribute('data-tooltip', ...);
}
```

The comment even acknowledges the problem: "project.html has no is-teal/is-off classes — toggle the 'on' look inline." Instead of adding the CSS classes, the developer used inline styles that produce a solid-filled button (`background: var(--accent-teal)`, `color: #001014`).

The standard active button style in the extension (defined in `kanban.html` at line 455, but `project.html` has its own `.strip-btn` definition at line 136) is:
```css
.strip-btn.is-active {
    color: var(--accent-teal);
    border-color: var(--accent-teal-dim);
    box-shadow: var(--glow-teal);
    background: color-mix(in srgb, var(--accent-teal) 10%, transparent);
}
```

This produces an outline style: teal text, teal border, mostly-transparent background with a subtle tint. The project context button should use this pattern.

The root cause is that `project.html` doesn't define the `.strip-btn.is-active` CSS class (unlike `kanban.html` which does), so the developer worked around it with inline styles instead of adding the class.

## Metadata

- **Tags:** ui, ux
- **Complexity:** 2

## User Review Required

**Yes — visual confirmation recommended before merge.** This is a low-complexity visual change with no logic impact, but the active-state appearance (teal outline + subtle tint vs. the current solid teal fill) is a subjective visual design choice. The coder should verify the new `.is-active` style looks correct in both the default and cyber themes before marking the plan done. No architectural or behavioral review is needed — the gate is purely "does it look right?"

## Complexity Audit

### Routine
- Add a single CSS class (`.strip-btn.is-active`) to `project.html`, matching the canonical definition from `kanban.html`.
- Add an optional hover variant (`.strip-btn.is-active:hover:not(:disabled)`) for interactive parity.
- Replace three inline style assignments in `project.js` with one `classList.toggle` call.
- No backend changes, no logic changes, no new dependencies.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions**
- None — `updateProjectContextButton()` is called from the `projectContextEnabled` message handler (line 553-556) and on initialization; the class toggle is synchronous and idempotent.

**Security**
- None — CSS class toggle on a local DOM element; no user input is processed.

**Side Effects**
- **Other buttons in `project.html`:** The `.strip-btn.is-active` class is generic — it could affect other buttons if they also get `is-active` toggled. Currently, no other button in `project.html` uses `is-active`, so this is safe. If future buttons need it, they'll benefit from the same style.
- **Tooltip change:** The tooltip text change in `updateProjectContextButton` (lines 1309-1311) is preserved unchanged — it's useful UX and unrelated to the styling fix.

**Dependencies & Conflicts**
- **`project.html` `.strip-btn` base style (line 136):** Already defines `background: #111; border: 1px solid var(--border-color); color: var(--text-primary);`. The `.is-active` class will cleanly override these properties via CSS specificity.
- **`--glow-teal` variable:** IS defined in `project.html` at line 36 (`0 0 10px color-mix(in srgb, var(--accent-teal) 50%, transparent)`). The cyber theme overrides it to `none` at line 62, which means `box-shadow: var(--glow-teal)` naturally resolves to `none` in cyber — no separate cyber-theme `.is-active` override is needed. The teal text, teal border, and subtle tint still render correctly in cyber.
- **`--accent-teal-dim` variable:** IS defined in `project.html` at line 32 (`color-mix(in srgb, var(--accent-teal) 40%, transparent)`). Available for the `border-color` property.
- **Cyber theme hover:** `project.html` line 655-656 defines `.cyber-theme-enabled .strip-btn:hover:not(:disabled) { box-shadow: var(--glow-teal); }`, which resolves to `none` in cyber. The `.is-active` hover variant does not need a separate cyber override for the same reason.

No external research is needed — all facts were verified from source by the orchestrator.

## Dependencies

None — single-file UI change, no cross-plan dependencies.

## Adversarial Synthesis

Key risks: the generic `.strip-btn.is-active` class could unintentionally style future buttons that receive `is-active` toggling, and the `classList.toggle` approach silently removes inline styles that may have been set by other code paths. Mitigations: currently no other `project.html` button uses `is-active`; the `classList.toggle` with its boolean argument is deterministic and replaces only the class, not other inline styles that might exist.

## Proposed Changes

### 1. `src/webview/project.html` — Add `.strip-btn.is-active` CSS class (after line 148)

Add the active button style, using the EXACT canonical definition from `kanban.html` (lines 455-460), including `box-shadow: var(--glow-teal)`. This variable IS defined in `project.html` at line 36. In the cyber theme, `--glow-teal` is overridden to `none` at line 62, so the glow naturally disappears without needing a separate cyber-theme `.is-active` override — the teal text, border, and subtle tint still render.

```css
.strip-btn.is-active {
    color: var(--accent-teal);
    border-color: var(--accent-teal-dim);
    box-shadow: var(--glow-teal);
    background: color-mix(in srgb, var(--accent-teal) 10%, transparent);
}
.strip-btn.is-active:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-teal) 14%, transparent);
    border-color: var(--accent-teal);
}
```

The hover variant provides a slightly stronger tint (14% vs 10%) and a solid teal border on hover, matching the interactive feel of `kanban.html`'s buttons. The `box-shadow: var(--glow-teal)` is included in the base `.is-active` rule only (not re-declared on hover) — the existing `.strip-btn:hover:not(:disabled)` rule at line 145-147 and the cyber-theme hover at line 655-656 already handle hover glow.

### 2. `src/webview/project.js` — Replace inline styles with class toggle (~lines 1302-1312)

**Before:**
```javascript
function updateProjectContextButton() {
    if (!btnProjectContext) return;
    btnProjectContext.textContent = projectContextEnabled ? 'PROJECT CONTEXT: ON' : 'PROJECT CONTEXT: OFF';
    // project.html has no is-teal/is-off classes — toggle the "on" look inline.
    btnProjectContext.style.background = projectContextEnabled ? 'var(--accent-teal)' : '';
    btnProjectContext.style.color = projectContextEnabled ? '#001014' : '';
    btnProjectContext.style.borderColor = projectContextEnabled ? 'var(--accent-teal)' : '';
    btnProjectContext.setAttribute('data-tooltip', projectContextEnabled
        ? "Project Context ON — the selected project's PRD is injected into every dispatched prompt. Click to disable."
        : "Project Context OFF — click to inject the selected project's PRD into every dispatched prompt.");
}
```

**After:**
```javascript
function updateProjectContextButton() {
    if (!btnProjectContext) return;
    btnProjectContext.textContent = projectContextEnabled ? 'PROJECT CONTEXT: ON' : 'PROJECT CONTEXT: OFF';
    btnProjectContext.classList.toggle('is-active', projectContextEnabled);
    btnProjectContext.setAttribute('data-tooltip', projectContextEnabled
        ? "Project Context ON — the selected project's PRD is injected into every dispatched prompt. Click to disable."
        : "Project Context OFF — click to inject the selected project's PRD into every dispatched prompt.");
}
```

Key changes:
- Removed all `style.background/color/borderColor` inline assignments and the stale comment about missing classes.
- Replaced with `classList.toggle('is-active', projectContextEnabled)` — adds the class when active, removes when inactive.
- Tooltip logic preserved unchanged.

## Verification Plan

### Automated Tests

Automated tests are SKIPPED per session directive. Verification is manual UI inspection only — no compile step, no test runner.

### Manual UI Steps

1. Open the project panel and switch to the Projects tab.
2. Verify the "PROJECT CONTEXT: OFF" button has the default strip-btn appearance (dark background, standard border).
3. Click the button to enable it — verify it now shows "PROJECT CONTEXT: ON" with a teal outline, teal text, subtle teal-tinted background, and a soft teal glow (matching the active button style used in the Kanban board).
4. Click again to disable — verify it returns to the default appearance.
5. Test in cyber theme — verify the active state renders correctly (glow resolves to `none`; teal text, border, and tint still visible).
6. Verify the tooltip updates correctly on toggle.
7. Verify the backend still receives `setProjectContextEnabled` messages correctly.

## Review Findings

Reviewed `src/webview/project.html` and `src/webview/project.js`. The `.strip-btn.is-active` and `.is-active:hover:not(:disabled)` rules were added (project.html:151-158) matching the canonical kanban definition; `updateProjectContextButton` (project.js:1299-1305) now uses `classList.toggle('is-active', projectContextEnabled)` with zero residual `btnProjectContext.style.*` assignments; all three CSS custom properties (`--accent-teal`, `--accent-teal-dim`, `--glow-teal`) are defined including the cyber `--glow-teal: none` override (project.html:62), so both default and cyber themes render correctly. No other `project.html` element uses `is-active` (no collision) and the call sites (project.js:553/1435/1455) are unchanged, so no double-refresh was introduced. Verification was static (grep + CSS-variable inspection); compile and tests skipped per session directive. No CRITICAL/MAJOR findings — no code changes applied; no material remaining risks.
