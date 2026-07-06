# Fix Start Terminal Button Styling in Comms Tab

## Goal

In the Comms Monitor tab of `kanban.html`, the "Start Terminal" button uses a completely different visual style from the rest of the extension's buttons. It has a solid teal background with dark text (`background:var(--accent-teal); color:var(--bg-primary)`), while the established button pattern throughout the extension uses a colored outline + colored text on a dark/transparent background (the `.strip-btn.is-active` or `.strip-btn.is-teal` pattern). The "Start Terminal" button should be restyled to match the extension's standard button aesthetic.

### Problem Analysis & Root Cause

The Comms Monitor lifecycle buttons are created dynamically in JavaScript (lines 9211-9261 of `src/webview/kanban.html`) with inline styles via `btnBaseStyle`. The "Start Terminal" and "Start Polling" buttons both use:
```javascript
startTermBtn.style.cssText = btnBaseStyle + ' background:var(--accent-teal); color:var(--bg-primary);';
```

This produces a solid-filled button that clashes with the extension's design language. The extension's standard active/primary button style (defined in CSS at lines 455-460) is:
```css
.strip-btn.is-active {
    color: var(--accent-teal);
    border-color: var(--accent-teal-dim);
    box-shadow: var(--glow-teal);
    background: color-mix(in srgb, var(--accent-teal) 10%, transparent);
}
```

This is an outline style: teal text, teal border, mostly-transparent background with a subtle teal tint. The "Start Terminal" button should use this aesthetic instead of a solid fill.

The root cause is that these buttons are created with raw inline styles in JS rather than using the extension's CSS classes, so they don't inherit the established design system.

## Metadata

- **Tags:** ui
- **Complexity:** 2

## User Review Required

No — pure CSS inline-style change on two buttons. No logic, state, or backend changes.

## Complexity Audit

### Routine
- Change inline `cssText` styles on two dynamically-created buttons (Start Terminal, Start Polling).
- No logic changes, no backend changes. The "Start Polling" button has the same issue and should be fixed for consistency.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- The `btnBaseStyle` variable is shared by all lifecycle buttons (Start Terminal, Check Auth, Start Polling, Stop Polling, Stop Monitor). Only the "primary action" buttons (Start Terminal, Start Polling) need the teal outline style; the secondary buttons (Check Auth, Stop Polling) already use a darker panel style which is acceptable.
- The "Stop Monitor" button uses `var(--accent-red)` which is intentional (destructive action) — leave it as-is.
- Button disabled states and text changes ("Starting…", etc.) are handled separately and won't be affected.
- The `guardCommsInteraction` wrapper and click handlers must be preserved.

## Proposed Changes

### `src/webview/kanban.html` — Restyle Start Terminal and Start Polling buttons (~lines 9218, 9239)

**Start Terminal button (line 9218):**

Before:
```javascript
startTermBtn.style.cssText = btnBaseStyle + ' background:var(--accent-teal); color:var(--bg-primary);';
```

After:
```javascript
startTermBtn.style.cssText = btnBaseStyle + ' background:color-mix(in srgb, var(--accent-teal) 10%, transparent); color:var(--accent-teal); border:1px solid var(--accent-teal-dim);';
```

**Start Polling button (line 9239):**

Before:
```javascript
startPollBtn.style.cssText = btnBaseStyle + ' background:var(--accent-teal); color:var(--bg-primary);';
```

After:
```javascript
startPollBtn.style.cssText = btnBaseStyle + ' background:color-mix(in srgb, var(--accent-teal) 10%, transparent); color:var(--accent-teal); border:1px solid var(--accent-teal-dim);';
```

Note: The `btnBaseStyle` already includes `border:none;` — the inline `border:1px solid var(--accent-teal-dim)` will override it since it appears later in the cssText string.

## Dependencies

- None — this subtask edits two `cssText` assignments (lines 9218, 9239) in the lifecycle-controls block, independent of the other two subtasks.
- All three subtasks touch `renderCommsMonitorSection` but non-overlapping ranges; safe to land in parallel or any order.

## Adversarial Synthesis

Key risks: the `btnBaseStyle` string already contains `border:none;` — the appended `border:1px solid var(--accent-teal-dim)` must override it (later in cssText wins), which it does. Secondary risk: `color-mix` browser support in VS Code webviews — already used by `.strip-btn.is-active` at line 459, so the runtime supports it. Mitigation: match the exact `color-mix` expression from the existing CSS class to guarantee parity.

## Verification Plan

1. Open the Kanban board and switch to the Comms tab.
2. Enable the Comms Monitor (set to "On").
3. Verify the "Start Terminal" button has a teal outline + teal text on a mostly-transparent background, matching the extension's standard active button style.
4. Click "Start Terminal" and verify the "Start Polling" button that appears has the same outline style.
5. Verify the "Check Auth" and "Stop Polling" buttons retain their existing secondary style.
6. Verify the "Stop Monitor" button retains its red destructive style.
7. Verify all buttons still function correctly (clicking triggers the right backend messages).
8. Skip compilation and automated tests per session directives — visual verification only.

## Review Findings

Implemented and committed in `cbb3771` (`src/webview/kanban.html`). Both `startTermBtn` (9313) and `startPollBtn` (9334) now use `background:color-mix(in srgb, var(--accent-teal) 10%, transparent); color:var(--accent-teal); border:1px solid var(--accent-teal-dim);`, matching the plan exactly; the inline `border` correctly overrides `btnBaseStyle`'s `border:none` (later shorthand wins) and `--accent-teal-dim` is a defined token (both themes). Secondary buttons (Check Auth, Stop Polling) and the red destructive Stop Monitor button were left untouched as intended, and all click handlers still post live backend message types verified against `extension.ts`. Only deviation from the referenced `.strip-btn.is-active` is the omitted `box-shadow: var(--glow-teal)` — but the plan's own "After" snippet omitted it too, so this is plan-compliant and deferred, not a defect. No CRITICAL/MAJOR findings; no code changes required; compile/tests skipped per session directives.
