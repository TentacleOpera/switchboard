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

- **Tags:** ui-cleanup, project-html, button-styling, css
- **Complexity:** 2

## Complexity Audit

**Routine.** Add a CSS class to `project.html` and replace inline styles with class toggling in `project.js`. No backend changes, no logic changes.

## Edge-Case & Dependency Audit

- **`project.html` `.strip-btn` base style (line 136):** Already defines `background: #111; border: 1px solid var(--border-color); color: var(--text-primary);`. The `.is-active` class will override these properties.
- **Cyber theme:** `project.html` has a cyber-theme override at line 655: `.cyber-theme-enabled .strip-btn:hover:not(:disabled)`. The `.is-active` class should also have a cyber-theme variant for the glow effect, matching `kanban.html`'s pattern.
- **Other buttons in project.html:** The `.strip-btn.is-active` class is generic — it could affect other buttons if they also get `is-active` toggled. Currently, no other button in `project.html` uses `is-active`, so this is safe. If future buttons need it, they'll benefit from the same style.
- **Tooltip change:** The tooltip text change in `updateProjectContextButton` (lines 1309-1311) should be preserved — it's useful UX.
- **`--glow-teal` variable:** Verify this variable is defined in `project.html` or its shared CSS. If not, the `box-shadow` can be omitted or a fallback used.

## Proposed Changes

### 1. `src/webview/project.html` — Add `.strip-btn.is-active` CSS class (after line 148)

Add the active button style, matching `kanban.html`'s definition:

```css
.strip-btn.is-active {
    color: var(--accent-teal);
    border-color: var(--accent-teal-dim);
    background: color-mix(in srgb, var(--accent-teal) 10%, transparent);
}
.strip-btn.is-active:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-teal) 14%, transparent);
    border-color: var(--accent-teal);
}
```

Note: `box-shadow: var(--glow-teal)` is omitted because `project.html` may not define `--glow-teal`. If it does (check shared CSS variables), it can be added. The core visual — teal text + teal border + subtle tint — is what matters.

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
- Removed all `style.background/color/borderColor` inline assignments.
- Replaced with `classList.toggle('is-active', projectContextEnabled)` — adds the class when active, removes when inactive.
- Tooltip logic preserved unchanged.

## Verification Plan

1. Open the project panel and switch to the Projects tab.
2. Verify the "PROJECT CONTEXT: OFF" button has the default strip-btn appearance (dark background, standard border).
3. Click the button to enable it — verify it now shows "PROJECT CONTEXT: ON" with a teal outline, teal text, and subtle teal-tinted background (matching the active button style used in the Kanban board).
4. Click again to disable — verify it returns to the default appearance.
5. Test in cyber theme — verify the active state looks correct with the theme's styling.
6. Verify the tooltip updates correctly on toggle.
7. Verify the backend still receives `setProjectContextEnabled` messages correctly.
