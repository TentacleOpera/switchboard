# Fix "Set as PRD" / "Set as Constitution" Buttons: Contrast + Unclear Labeling in Docs Tab

## Goal

The **Set as Requirements (PRD)** and **Set as Constitution** buttons in the Docs tab controls strip (`planning.html`) have two compounding problems:

1. **Contrast bug:** they render with grey text on a teal/blue-tinted background, which looks broken and is inconsistent with every other button in the same strip (Edit, Save, Cancel, Sync to Online, Import).
2. **Unclear labeling:** the names "Set as Requirements (PRD)" / "Set as Constitution" read like a status toggle on the document you're viewing. What they actually do is **copy the content of the currently-open doc into a different target** — "Set as Requirements (PRD)" opens a project picker and copies the doc into that project's PRD slot; "Set as Constitution" copies the doc into the active workspace's Constitution file. Both show a **Keep / Append / Replace** modal if the target already has content. Low-contrast text compounds this: the buttons read as disabled/informational badges rather than actionable copy commands.

This plan fixes both: a proper tinted "primary action" style (so these two visually stand out as the special, doc-copying actions they are), and a rename to language that signals a copy/destination action instead of an in-place toggle.

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

- **Tags:** `ui`, `css`, `copy`, `planning-webview`, `docs-tab`, `polish`
- **Complexity:** 2/10
- **Files touched:** `src/webview/planning.html`, `src/webview/implementation.html` (2 files)
- **Shipped-state impact:** Visual/copy-only change to a released webview; no data/migration concerns. Button `id`s, click handlers, and posted message types are untouched, so no behavior changes.

## Complexity Audit

**Routine.** This is a CSS-class + visible-text/tooltip change across two HTML files. No logic, no data flow, no API surface, no message-type changes. Confirmed via grep that no test pins the exact button text (`planning-copy-labels-regression.test.js` tests an unrelated kanban-copy-prompt function) and no other source file references these labels except the `implementation.html` deprecation note, which is updated in this same plan to stay consistent.

## Edge-Case & Dependency Audit

- **Theme variants:** The webview ships two accent palettes — default cyan (`--accent-teal: #00e5ff`) and warm terracotta (`--accent-teal: #D97757`). The fix uses the `--accent-teal` / `--accent-teal-dim` variables (not hardcoded colors) so it adapts to both themes.
- **Cyber theme:** `.cyber-theme-enabled .strip-btn:hover:not(:disabled)` adds a `--glow-teal` box-shadow on hover. Keeping a tinted background requires the hover state's `color: var(--accent-teal)` to still read well against the dim background — it does, since `.strip-btn.active` (planning.html:242-247) already uses exactly that combination (`background: var(--accent-teal-dim); border-color: var(--accent-teal); color: var(--accent-teal);`) and is proven to work in both themes. The new `.strip-btn--primary` class mirrors `.strip-btn.active` rather than reusing it directly, since `.active` is a transient state class toggled elsewhere (tab buttons) and giving these two permanently-tinted buttons their own class avoids any future collision.
- **Disabled state:** These two buttons are never `disabled` in markup (unlike Edit/Save/Cancel which toggle `disabled`). No interaction with `.strip-btn:disabled`.
- **No JS dependency:** `planning.js` only attaches click handlers by element `id` (lines ~6771–6973); it never reads or sets `textContent`/inline `style` on these buttons, and no test pins their exact label text (confirmed via grep — `planning-copy-labels-regression.test.js` covers an unrelated kanban copy-prompt function). A markup/CSS/copy-only fix is safe.
- **Other references to the old wording:** `implementation.html:3128` has a Notion-design-doc deprecation note that says *"Use the Docs tab (Set as Requirements / Set as Constitution) to import context instead."* This must be updated to the new label so it doesn't point users at button text that no longer exists. (Historical plan/epic files under `.switchboard/` that mention the old names are append-only history — left as-is.)

## Proposed Changes

### 1. New dedicated class — `src/webview/planning.html` (near line 247, after `.strip-btn.active`)

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

### 2. Button markup + copy — `src/webview/planning.html` (lines 3458–3459)

Replace the inline-styled buttons with the new class, and rename the visible text from a status-toggle phrasing ("Set as...") to a save/copy phrasing that signals "this writes the open doc somewhere else," matching the existing **Save**/**Save As** mental model already used elsewhere in the strip:

```html
<button id="btn-set-prd" class="strip-btn strip-btn--primary" title="Copy the open document into a project's PRD. You'll choose the project; if it already has a PRD you can keep, append, or replace it.">Save as PRD</button>
<button id="btn-set-constitution" class="strip-btn strip-btn--primary" title="Copy the open document into this workspace's Constitution. If one already exists you can keep, append, or replace it.">Save as Constitution</button>
```

Element `id`s (`btn-set-prd`, `btn-set-constitution`) are unchanged — `planning.js` click handlers keep working with no JS edits.

### 3. Update the matching deprecation note — `src/webview/implementation.html` (line 3128)

```js
deprecationMsg.innerText = 'Notion Design Doc settings are deprecated. Use the Docs tab (Save as PRD / Save as Constitution) to import context instead.';
```

## Verification Plan

1. Build the VSIX and open the Planning panel → Docs tab in VS Code.
2. Confirm the two buttons show teal text on a dim-teal background (no more grey-on-tint), and read "Save as PRD" / "Save as Constitution".
3. Toggle the warm/terracotta theme and re-check contrast on both buttons.
4. Enable the cyber theme and hover each button — confirm the `--glow-teal` hover glow still appears and no styling regresses.
5. Hover each button and confirm the new tooltip text explains the copy/destination behavior.
6. Click each button to confirm the existing project-picker / collision-modal flow (`planning.js` ~line 6788+) still fires unchanged; styling/copy change must not affect click handlers or posted message types.
7. Open the Automation tab's agent list with the Notion design-doc setting present and confirm the deprecation note in `implementation.html` reads "Save as PRD / Save as Constitution".
8. Visually compare the full controls strip — the two buttons should now read as deliberate "primary/special" actions, distinguishable at a glance from Edit/Save/Cancel, with no contrast issue.
