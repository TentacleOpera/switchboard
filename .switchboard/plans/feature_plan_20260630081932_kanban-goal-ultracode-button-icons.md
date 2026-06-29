# Replace Kanban Goal & Ultracode Button Text Labels with Sci-Fi Icons

## Goal

Replace the plain text labels (`UC` and `/goal`) on the `btn-epic-ultracode` and `btn-epic-goal` buttons in the kanban control strip with image icons, matching the visual style of every other button in that strip. The goal button should use `icons/25-101-150 Sci-Fi Flat icons-139.png` and the ultracode button should use `icons/25-101-150 Sci-Fi Flat icons-102.png`.

### Problem
The two epic-workflow toggle buttons (`btn-epic-ultracode` and `btn-epic-goal`) are the only buttons in the kanban top control strip that render plain text labels (`UC` and `/goal`) instead of icon images. Every neighboring button (`btn-delete-project`, `btn-scan-folders`, `btn-autoban`, `btn-remote-control`, `btn-cli-triggers`, `btn-collapse-coders`) uses an `<img>` element sourced from the extension's `icons/` directory via a `{{ICON_*}}` placeholder that is resolved to a webview URI by `KanbanProvider._getHtmlForWebview()`. The two text-label buttons break the visual consistency of the strip.

### Root Cause
**Investigation finding**: In `src/webview/kanban.html` (lines 2490-2495), the two buttons embed raw text nodes instead of `<img>` tags:

```html
<button class="strip-icon-btn is-off" id="btn-epic-ultracode" data-tooltip="Epic workflow: prepend ultracode directive to epic prompts">
    UC
</button>
<button class="strip-icon-btn is-off" id="btn-epic-goal" data-tooltip="Epic workflow: prepend /goal slash command to epic prompts">
    /goal
</button>
```

The icon injection mechanism lives in `src/services/KanbanProvider.ts` (lines 8080-8108): a `iconMap` record maps `{{ICON_*}}` placeholders to `webview.asWebviewUri(...)` URIs, then a regex pass replaces all placeholders in the HTML content. There are currently **no** `{{ICON_ULTRACODE}}` or `{{ICON_GOAL}}` entries in that map, so even if the HTML used the placeholders they would not resolve. Both target icon files exist on disk and are the correct filenames requested by the user.

### Background
- `kanban.html` line 2490-2492: `btn-epic-ultracode` currently renders the literal text `UC`.
- `kanban.html` line 2493-2495: `btn-epic-goal` currently renders the literal text `/goal`.
- `KanbanProvider.ts` lines 8082-8105: the `iconMap` record — no `ULTRACODE`/`GOAL` entries present.
- `KanbanProvider.ts` line 8081: `iconDir = vscode.Uri.joinPath(this._extensionUri, 'icons')` — the icon directory root used by all other entries.
- Existing entries follow the pattern `'{{ICON_NAME}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '<filename>')).toString()`.
- The CSS for `.strip-icon-btn img` (lines 560-565) already constrains image size/filtering; no new CSS is needed — the new `<img>` tags will inherit the same styling as every other icon button, including the `is-off` / `is-active` filter states (lines 582-589, 95-96, 138-139).

## Metadata
- **Tags:** [ui, frontend, feature]
- **Complexity:** 2

## User Review Required
No — this is a pure visual consistency fix using existing icon assets and the existing icon-injection mechanism. No behavioral change to the toggle logic.

## Complexity Audit

### Routine
- Add two new entries (`{{ICON_ULTRACODE}}`, `{{ICON_GOAL}}`) to the `iconMap` in `KanbanProvider.ts`.
- Replace the text node content of the two buttons in `kanban.html` with `<img>` tags using the new placeholders.
- No new CSS, no logic changes, no new dependencies.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — icon placeholders are resolved synchronously during HTML generation before the webview is loaded.
- **Security:** None — icon files are bundled extension assets served via `asWebviewUri`, identical to every other icon already in the strip.
- **Side Effects:** None — the toggle logic in `setEpicWorkflowMode` (kanban.html lines 4204-4211) and the click handlers (lines 7037-7043) operate on the button element and its `is-active`/`is-off` classes, not on the button's inner content. Swapping a text node for an `<img>` child does not affect `classList.toggle` or `getElementById` lookups.
- **Dependencies & Conflicts:**
  1. **Claudify theme image filters**: `body.theme-claudify .strip-icon-btn img` (lines 64-66) and the `is-off` / `is-active` variants (lines 74-75, 95-96) apply CSS filters to all `.strip-icon-btn img` elements. The new icons will automatically inherit these filters — no additional theme-specific rules needed.
  2. **Kanban-icons-colour mode**: `body.theme-claudify.kanban-icons-colour .strip-icon-btn img` (lines 108-122) restores full colour for icon images. The new icons will be included automatically.
  3. **`alt` text accessibility**: The new `<img>` tags should carry `alt` attributes (e.g. `alt="Ultracode"`, `alt="Goal"`) matching the convention used by neighboring buttons (e.g. `alt="Start Automation"`, `alt="CLI Triggers"`).
  4. **Icon file existence**: Verified — both `icons/25-101-150 Sci-Fi Flat icons-139.png` and `icons/25-101-150 Sci-Fi Flat icons-102.png` exist on disk.

## Dependencies
- None — this plan is fully self-contained.

## Adversarial Synthesis

Key risks: (1) Toggle logic operates on `classList` of the button elements, never on inner content — **verified by codebase grep**: all 6 references to `btn-epic-ultracode`/`btn-epic-goal` are the button definitions plus `getElementById` + `classList.toggle` handlers; **zero** `textContent`/`innerText` reads on these IDs and no other code references the literal strings `UC`/`/goal`, so swapping the text node for an `<img>` is safe. (2) The `is-off` dimming filter applies to `.strip-icon-btn.is-off img` descendants — the new `<img>` inherits it correctly in both states, but the 25-101-150 icon range may have different luminance than the 25-1-100 neighbors, so glyph legibility under dimming must be confirmed visually (see Verification Plan). (3) The two icon filenames were user-chosen; semantic fit of the glyphs to "ultracode"/"goal" is a cosmetic, user-owned acceptance check, not a plan blocker. Mitigations: treat the visual + theme checks as the real acceptance gate; no compile or automated tests needed per session directives. No research needed — all factual claims verified against source.

## Proposed Changes

### File 1: `src/webview/kanban.html` (lines 2490-2495)

Replace the text-label button bodies with `<img>` tags using new placeholders.

**Before:**
```html
<button class="strip-icon-btn is-off" id="btn-epic-ultracode" data-tooltip="Epic workflow: prepend ultracode directive to epic prompts">
    UC
</button>
<button class="strip-icon-btn is-off" id="btn-epic-goal" data-tooltip="Epic workflow: prepend /goal slash command to epic prompts">
    /goal
</button>
```

**After:**
```html
<button class="strip-icon-btn is-off" id="btn-epic-ultracode" data-tooltip="Epic workflow: prepend ultracode directive to epic prompts">
    <img src="{{ICON_ULTRACODE}}" alt="Ultracode">
</button>
<button class="strip-icon-btn is-off" id="btn-epic-goal" data-tooltip="Epic workflow: prepend /goal slash command to epic prompts">
    <img src="{{ICON_GOAL}}" alt="Goal">
</button>
```

### File 2: `src/services/KanbanProvider.ts` (lines 8082-8105, the `iconMap`)

Add two new entries to the `iconMap` record so the placeholders resolve to webview URIs.

**Add inside the `iconMap` object (e.g. after the `{{ICON_CLI}}` entry at line 8092):**
```ts
'{{ICON_ULTRACODE}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-101-150 Sci-Fi Flat icons-102.png')).toString(),
'{{ICON_GOAL}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-101-150 Sci-Fi Flat icons-139.png')).toString(),
```

The existing regex replacement loop at lines 8106-8108 will pick these up automatically — no other code changes needed.

## Verification Plan

> Session directives: **no compilation** (`npm run compile`, tsc, webpack) and **no automated tests** are run as part of this plan. The project is assumed pre-compiled; the test suite is run separately by the user. All verification below is manual, via an installed VSIX.

### Automated Tests
- None apply. This is a pure visual/icon-asset swap with no behavioral logic change, and automated tests are explicitly skipped per session directives. The toggle logic (`setEpicWorkflowMode` / `updateEpicWorkflowToggleUi`) is unchanged and continues to be exercised by the manual checks below.

### Manual Visual Checks (installed VSIX)

1. **Glyph legibility at strip size**: Open the kanban board in VS Code. Confirm the ultracode and goal buttons in the top control strip now render icon images instead of the text `UC` / `/goal`. Confirm both glyphs are recognizable at the constrained `.strip-icon-btn img` dimensions — if either icon is illegible, flag to the user (the filenames were user-chosen; a substitute from the `icons/` set may be needed).
2. **Toggle behaviour**: Click the ultracode button — confirm it switches to the `is-active` state (icon brightens / filter changes per theme) and that clicking goal deactivates ultracode (mutual exclusivity preserved). Confirm the `setEpicWorkflowMode` round-trip still works and that `getElementById` lookups still resolve (no `null` short-circuit introduced by the content swap).
3. **Theme consistency — including `is-off` dimming**: Switch between default, Claudify, and Claudify+kanban-icons-colour themes. Confirm the new icons inherit the same dim/bright/colour filters as the neighboring icon buttons. **Pay specific attention to the `is-off` (dimmed) state**: the 25-101-150 icon range may have different luminance than the 25-1-100 neighbors — verify the dimmed glyph is still distinguishable and not a black smear.
4. **Tooltip check**: Hover both buttons — confirm the `data-tooltip` text still appears (unchanged by the inner-content swap).
5. **No stale text leak**: Confirm no remaining `UC` / `/goal` text labels appear anywhere in the strip (the swap is complete, not partial).

## Recommendation

Complexity is 2 (routine, two-file icon-asset swap reusing the existing `iconMap` injection mechanism). **Send to Intern.**
