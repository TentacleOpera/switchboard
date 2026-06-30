# Fix "Set as PRD" / "Set as Constitution" Button Styling in Docs Tab

## Goal

The **Set as Requirements (PRD)** and **Set as Constitution** buttons in the Docs tab controls strip (`planning.html`) render with grey text on a teal/blue-tinted background, which looks broken and is inconsistent with every other button in the same strip (Edit, Save, Cancel, Sync to Online, Import).

### Problem Analysis & Root Cause

All controls-strip buttons share the `.strip-btn` class, whose default style is:

```css
.strip-btn {
    background: transparent;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);   /* #8C8C8C — grey */
    ...
}
```

The two PRD/Constitution buttons override the background and border **inline** but do **not** override the text color:

```html
<button id="btn-set-prd" class="strip-btn"
        style="background: var(--accent-teal-dim); border-color: var(--accent-teal);"
        title="...">Set as Requirements (PRD)</button>
<button id="btn-set-constitution" class="strip-btn"
        style="background: var(--accent-teal-dim); border-color: var(--accent-teal);"
        title="...">Set as Constitution</button>
```

Result: `color: var(--text-secondary)` (#8C8C8C grey) is inherited from `.strip-btn` while the background becomes `--accent-teal-dim` (a 40%-opacity teal/cyan, or terracotta in the warm theme). Grey-on-tinted-teal is low-contrast and visually inconsistent with the other transparent-background strip buttons.

This is the only place in the controls strip where inline styles override the shared button appearance. Every other `.strip-btn` keeps the default transparent background + grey text, which reads correctly. The two buttons were likely given a tinted background to mark them as "primary/special" actions but the matching `color` override was omitted.

## Metadata

- **Tags:** `ui`, `css`, `planning-webview`, `docs-tab`, `polish`
- **Complexity:** 2/10
- **Files touched:** `src/webview/planning.html` (1 file)
- **Shipped-state impact:** Visual-only change to a released webview; no data/migration concerns.

## Complexity Audit

**Routine.** This is a pure CSS/inline-style fix in a single HTML file. No logic, no data flow, no API surface. The only judgment call is which visual treatment to adopt (see Proposed Changes — both options are low-risk).

## Edge-Case & Dependency Audit

- **Theme variants:** The webview ships two accent palettes — default cyan (`--accent-teal: #00e5ff`) and warm terracotta (`--accent-teal: #D97757`). Any fix must use the `--accent-teal` / `--accent-teal-dim` variables (not hardcoded colors) so it adapts to both themes. Both proposed options below are variable-based.
- **Cyber theme:** `.cyber-theme-enabled .strip-btn:hover:not(:disabled)` adds a `--glow-teal` box-shadow on hover. The fix must not break hover behavior. Removing the inline background (Option A) lets the existing `.strip-btn:hover` rule apply cleanly. Keeping a tinted background (Option B) requires the hover rule's `color: var(--accent-teal)` to still read well against the dim background — it does, since `.strip-btn.active` already uses exactly that combination.
- **Disabled state:** These two buttons are never `disabled` in markup (unlike Edit/Save/Cancel which toggle `disabled`). No interaction with `.strip-btn:disabled`.
- **No JS dependency:** `planning.js` only attaches click handlers (lines ~6771–6809); it does not manipulate the inline `style` of these buttons, so a markup/CSS-only fix is safe.

## Proposed Changes

**File:** `src/webview/planning.html` (lines 3458–3459)

Pick **one** of the two options. Option A is recommended for strict consistency with the rest of the strip; Option B preserves the "special action" visual intent while fixing the contrast.

### Option A (recommended) — Make them match every other strip button

Remove the inline `background`/`border-color` overrides so the buttons inherit the default `.strip-btn` appearance (transparent background, grey text, teal-on-hover). This is the most consistent and the smallest diff.

```html
<button id="btn-set-prd" class="strip-btn" title="Set the open document as Project Requirements (PRD)">Set as Requirements (PRD)</button>
<button id="btn-set-constitution" class="strip-btn" title="Set the open document as Workspace Constitution">Set as Constitution</button>
```

### Option B — Keep the tinted "primary action" look but fix the text color

Add `color: var(--accent-teal);` to the inline style so the text matches the border/background tint (mirrors the `.strip-btn.active` state, which is already proven to read well in both themes):

```html
<button id="btn-set-prd" class="strip-btn" style="background: var(--accent-teal-dim); border-color: var(--accent-teal); color: var(--accent-teal);" title="Set the open document as Project Requirements (PRD)">Set as Requirements (PRD)</button>
<button id="btn-set-constitution" class="strip-btn" style="background: var(--accent-teal-dim); border-color: var(--accent-teal); color: var(--accent-teal);" title="Set the open document as Workspace Constitution">Set as Constitution</button>
```

> Note: Prefer moving these out of inline styles into a dedicated class (e.g. `.strip-btn--primary`) if Option B is chosen, to keep the markup clean and allow hover/active overrides without `!important`. A minimal class-based version:

```css
.strip-btn--primary {
    background: var(--accent-teal-dim);
    border-color: var(--accent-teal);
    color: var(--accent-teal);
}
.strip-btn--primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-teal) 18%, transparent);
}
```
```html
<button id="btn-set-prd" class="strip-btn strip-btn--primary" title="...">Set as Requirements (PRD)</button>
<button id="btn-set-constitution" class="strip-btn strip-btn--primary" title="...">Set as Constitution</button>
```

## Verification Plan

1. Build the VSIX and open the Planning panel → Docs tab in VS Code.
2. Confirm the two buttons no longer show grey-on-blue text:
   - **Option A:** buttons look identical to Edit/Save/Cancel (transparent bg, grey text, teal text + dim border on hover).
   - **Option B:** buttons show teal text on dim-teal background, readable in both the default cyan theme and the warm terracotta theme.
3. Toggle the warm/terracotta theme and re-check contrast on both buttons.
4. Enable the cyber theme and hover each button — confirm the `--glow-teal` hover glow still appears and no styling regresses.
5. Click each button to confirm the existing project-picker flow (`planning.js` ~line 6788+) still fires; styling change must not affect click handlers.
6. Visually compare the full controls strip — all buttons should now share a coherent visual language with no odd-one-out.
