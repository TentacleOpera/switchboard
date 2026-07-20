# Style the unstyled "Export as Skill" button in the Prompts tab

## Goal

The "EXPORT AS SKILL" button in the Prompts tab of `kanban.html` renders as a plain,
unstyled browser-default button. It sits inline next to the Role `<select>` dropdown
inside the Role Selector subsection, so the contrast with the styled dropdown is
immediately visible to the user.

### Problem analysis

- The button markup at `src/webview/kanban.html:2969` is:
  ```html
  <button id="prompts-tab-btn-export-skill" class="secondary-btn"
          style="height:26px; line-height:24px; padding:0 12px; margin:0;">
    EXPORT AS SKILL
  </button>
  ```
- The `class="secondary-btn"` is the intended style hook, but **`kanban.html` never
  defines a CSS rule for `.secondary-btn`**. A grep for `\.secondary-btn\s*\{`
  against `src/webview/kanban.html` returns zero matches.
- The class *is* defined in the sibling webview `src/webview/implementation.html`
  (lines 812–844): solid `--panel-bg2` fill, `--border-color` border,
  `--text-secondary` text, mono font, uppercase, letter-spacing, hover/disabled
  states. It was simply never ported into `kanban.html` when the Prompts tab was
  added.
- The inline `style="height:26px;..."` on the button only sets box dimensions; it
  does nothing for background, border, color, font, or hover — so the button falls
  back to the user agent default look.

### Root cause

Missing CSS rule. The `.secondary-btn` class is referenced in `kanban.html` but its
definition was never copied over from `implementation.html`. The same gap affects
the other `.secondary-btn` buttons in the file (the two "Validate" buttons at lines
2991 and 3095, and the "CANCEL" button at line 3356), and the unrelated
`.action-btn` class is likewise referenced but undefined — but the user-visible
trigger for this plan is the EXPORT AS SKILL button.

## Metadata

- **Complexity:** 2
- **Tags:** frontend, ui, bugfix

## Complexity Audit

**Routine.** This is a pure CSS addition — no logic, no data flow, no state. The
exact rule to port already exists verbatim in `implementation.html` and uses only
CSS variables (`--panel-bg2`, `--border-color`, `--text-secondary`,
`--border-bright`, `--text-primary`, `--font-mono`) that are already declared in
`kanban.html`'s `:root` / `body.theme-claudify` blocks (lines 24–50). No new
abstraction, no cross-file coordination, no behavior change. Risk of regression is
limited to visual appearance of the buttons that already carry the class.

## Edge-Case & Dependency Audit

- **Other buttons sharing the class.** Adding the rule will also style the two
  "Validate" buttons (lines 2991, 3095) and the "CANCEL" button (line 3356). This
  is desirable — they are currently unstyled for the same reason and should match
  the design system. The plan does not change their markup, only their appearance.
- **Inline-style overrides.** The EXPORT AS SKILL button carries
  `style="height:26px; line-height:24px; padding:0 12px; margin:0;"`. The CSS rule
  sets `padding: 8px`, but inline styles win by specificity, so the compact
  inline padding is preserved — only the missing background/border/color/font come
  from the rule. Verify visually that the button keeps its intended compact size.
- **Theme variants.** `kanban.html` has a `body.theme-claudify` block that
  re-declares `--text-secondary`, `--border-color`, `--border-bright`. Because the
  ported rule uses the CSS variables (not hardcoded colors), it automatically
  adapts to both the base and Claudify themes. No theme-specific override needed.
- **`.action-btn` gap (out of scope but noted).** The "SAVE COLUMN", "ADD
  TERMINAL", and "CLEAR & RESET" buttons use `class="action-btn"`, which is also
  undefined in `kanban.html`. This plan intentionally scopes to `.secondary-btn`
  to match the reported issue (the EXPORT AS SKILL button). A separate plan can
  address `.action-btn` if the user reports those buttons as unstyled.
- **No JS / build changes.** The fix is a `<style>` block edit only; no
  recompilation, no message-handler changes, no webview API surface change.

## Proposed Changes

### `src/webview/kanban.html`

Port the `.secondary-btn` rule (and its `:hover` / `:disabled` / `.dispatching`
states) from `src/webview/implementation.html:812–844` into `kanban.html`'s
`<style>` block. Place it adjacent to the existing `.agents-tab-custom-agent-item-btn`
rule (around line 1215) so all secondary-button styling lives together.

Insert the following CSS block:

```css
/* Secondary button — ported from implementation.html so .secondary-btn
   references in this file (EXPORT AS SKILL, Validate, CANCEL) are styled
   instead of falling back to the user-agent default. Uses the same CSS
   variables already declared in :root / body.theme-claudify above. */
.secondary-btn {
    background: var(--panel-bg2);
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    padding: 8px;
    font-size: 10px;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 1.2px;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: none;
    border-radius: 2px;
}

.secondary-btn:hover {
    background: color-mix(in srgb, var(--border-bright) 10%, transparent);
    border-color: var(--border-bright);
    color: var(--text-primary);
}

.secondary-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
    color: var(--vscode-disabledForeground, var(--text-secondary));
    border-color: var(--border-color);
    box-shadow: none;
}

.secondary-btn.dispatching {
    opacity: 0.7;
    cursor: wait;
}
```

No markup changes. No JS changes. The existing inline `style` on the EXPORT AS
SKILL button is left untouched — it correctly overrides `padding` for the compact
layout while inheriting the new background/border/color/font from the rule.

## Verification Plan

1. **Build / typecheck.** No TS or build step is affected (HTML/CSS only), but run
   the project's standard build to confirm no incidental breakage:
   - `npm run compile` (or the workspace's equivalent) — expect zero new errors.
2. **Visual check in the webview.**
   - Open the Switchboard kanban webview in VS Code.
   - Go to the **Prompts** tab.
   - Confirm the "EXPORT AS SKILL" button next to the Role dropdown now has the
     dark panel background, thin border, muted mono uppercase text, and a hover
     state (border brightens, text brightens) matching the design system.
   - Confirm the button retains its compact height (~26px) from the inline style.
3. **Sibling buttons.** Confirm the two "Validate" buttons (Planner workflow path
   and Planner Feature workflow path) and the column-modal "CANCEL" button now
   render with the same secondary-button look instead of the browser default.
4. **Theme check.** Toggle the Claudify theme on and off and confirm the button
   adapts (the rule uses CSS variables, so both themes should look correct).
5. **Functional regression.** Click EXPORT AS SKILL with a built-in role selected
   and then with a custom agent selected; confirm the existing
   `promptsExportBtn.addEventListener('click', ...)` handler at line 4584 still
   fires and the button text briefly shows "EXPORTED!" as before.

## Completion Report

Implemented the pure-CSS fix: ported the `.secondary-btn` rule (plus `:hover`,
`:disabled`, `.dispatching` states) from `src/webview/implementation.html` into
`src/webview/kanban.html`'s `<style>` block, placed adjacent to the
`.agents-tab-custom-agent-item-btn` rules so all secondary-button styling lives
together. No markup or JS changes. File changed:
`src/webview/kanban.html` (inserted ~38 lines after the
`.agents-tab-custom-agent-item-btn.delete:hover` block). The rule uses only CSS
variables already declared in `kanban.html`'s `:root` / `body.theme-claudify`,
so the EXPORT AS SKILL button (and the sibling Validate / CANCEL buttons) now
render with the design-system look in both themes, while the EXPORT AS SKILL
button's inline `padding`/`height` styles keep its compact size via specificity.
No issues encountered. Per task instructions, compilation and automated tests
were skipped.
