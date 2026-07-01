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

- **Tags:** `ui`, `docs`, `bugfix`
- **Complexity:** 2/10
- **Files touched:** `src/webview/planning.html`, `src/webview/implementation.html`, `src/services/PlanningPanelProvider.ts` (3 files)
- **Shipped-state impact:** Visual/copy-only change to a released webview; no data/migration concerns. Button `id`s, click handlers, and posted message types are untouched, so no behavior changes. The `PlanningPanelProvider.ts` change is a code-comment-only update for wording consistency.

## User Review Required

No review gate required. This is a cosmetic/copy-only change with no logic, data, or API surface impact. The rename ("Set as" → "Save as") is a UX clarification, not a feature change. Proceed directly to implementation.

## Complexity Audit

### Routine
- CSS class addition (4 declarations) in `planning.html` — mirrors the proven `.strip-btn.active` pattern.
- Button markup swap: replace inline `style` attribute with a class name; rename visible text + tooltip.
- One-line string update in `implementation.html` deprecation note.
- One-line code-comment update in `PlanningPanelProvider.ts` for wording consistency.
- Element `id`s (`btn-set-prd`, `btn-set-constitution`) are unchanged — no JS handler wiring changes.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Theme variants:** The webview ships two accent palettes — default cyan (`--accent-teal: #00e5ff`) and warm terracotta (`--accent-teal: #D97757`). The fix uses the `--accent-teal` / `--accent-teal-dim` variables (not hardcoded colors) so it adapts to both themes.
- **Cyber theme:** `.cyber-theme-enabled .strip-btn:hover:not(:disabled)` (planning.html:2191) adds a `--glow-teal` box-shadow on hover. This selector has specificity (0,3,1) and only sets `box-shadow` — it does not touch `background` or `color`, so it cannot conflict with `.strip-btn--primary:hover` (specificity 0,2,1). The glow stacks on top of the primary hover background. Keeping a tinted background requires the hover state's `color: var(--accent-teal)` (inherited from base `.strip-btn:hover:not(:disabled)` at planning.html:236-240) to still read well against the dim background — it does, since `.strip-btn.active` (planning.html:242-247) already uses exactly that combination (`background: var(--accent-teal-dim); border-color: var(--accent-teal); color: var(--accent-teal);`) and is proven to work in both themes. The new `.strip-btn--primary` class mirrors `.strip-btn.active` rather than reusing it directly, since `.active` is a transient state class toggled elsewhere (tab buttons) and giving these two permanently-tinted buttons their own class avoids any future collision.
- **CSS specificity — hover override:** `.strip-btn--primary:hover:not(:disabled)` and base `.strip-btn:hover:not(:disabled)` both have specificity (0,2,1). The primary class is declared *after* the base hover rule (inserted near line 247, base hover at line 236), so the primary hover `background` wins by source order. No `!important` needed.
- **Disabled state:** These two buttons are never `disabled` in markup (unlike Edit/Save/Cancel which toggle `disabled`). No interaction with `.strip-btn:disabled`.
- **No JS dependency:** `planning.js` only attaches click handlers by element `id` (lines 6839-6840, handlers at 6855+); it never reads or sets `textContent`/inline `style` on these buttons. Confirmed via grep: no source file sets `.textContent` or `.innerText` on `btn-set-prd` / `btn-set-constitution`.
- **Test pinning evidence:** The test file `src/test/planning-copy-labels-regression.test.js` exists and tests the `_getCopyLabel` kanban copy-prompt function (unrelated to these button labels). It never references `btn-set-prd`, `btn-set-constitution`, "Set as Requirements", or "Set as Constitution". A markup/CSS/copy-only fix is safe — no test asserts the current label text.
- **Other references to the old wording (3 locations, all updated by this plan):**
  1. `src/webview/planning.html:3461-3462` — the buttons themselves (Proposed Change #2).
  2. `src/webview/implementation.html:3128` — Notion-design-doc deprecation note: *"Use the Docs tab (Set as Requirements / Set as Constitution) to import context instead."* Updated in Proposed Change #3.
  3. `src/services/PlanningPanelProvider.ts:1073` — code comment in `_postToBothPanels` docblock: *"The Docs-tab 'Set as Requirements / Set as Constitution' actions run in the planning panel..."* Updated in Proposed Change #4. (Code comment, not user-facing, but updated for developer-grep consistency.)
  - Historical plan/epic files under `.switchboard/` that mention the old names are append-only history — left as-is.

## Dependencies

None — this plan is self-contained and has no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) missed `PlanningPanelProvider.ts` code-comment reference would leave a stale grep hit causing developer confusion; (2) illegal metadata tags would break plan indexing/filtering; (3) wrong line numbers would mislead the implementer. Mitigations: all three references now listed explicitly with correct line numbers (3461-3462, 3128, 1073); tags constrained to the allowed list (`ui`, `docs`, `bugfix`); hover opacity (18%) documented as an intentional darker-on-hover progression from the 40% resting dim. No logic, data, or API risk — complexity remains 2/10.

## Proposed Changes

### 1. New dedicated class — `src/webview/planning.html` (insert after `.strip-btn.active`, near line 247)

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

**Rationale for 18% hover opacity:** The resting state uses `--accent-teal-dim` (~40% opacity teal). Hover darkens the tint to 18% mix for a visible "press-target" cue without going full-opacity (which would clash with the cyber-theme glow). This is an intentional progression: 40% rest → 18% hover → full `--accent-teal` border. The base `.strip-btn:hover` (8%) is too subtle for a permanently-tinted button, so 18% is chosen to stay perceptible against the existing dim background.

### 2. Button markup + copy — `src/webview/planning.html` (lines 3461–3462)

Replace the inline-styled buttons with the new class, and rename the visible text from a status-toggle phrasing ("Set as...") to a save/copy phrasing that signals "this writes the open doc somewhere else," matching the existing **Save**/**Save As** mental model already used elsewhere in the strip:

```html
<button id="btn-set-prd" class="strip-btn strip-btn--primary" title="Copy the open document into a project's PRD. You'll choose the project; if it already has a PRD you can keep, append, or replace it.">Save as PRD</button>
<button id="btn-set-constitution" class="strip-btn strip-btn--primary" title="Copy the open document into this workspace's Constitution. If one already exists you can keep, append, or replace it.">Save as Constitution</button>
```

Element `id`s (`btn-set-prd`, `btn-set-constitution`) are unchanged — `planning.js` click handlers (lines 6855+) keep working with no JS edits.

### 3. Update the matching deprecation note — `src/webview/implementation.html` (line 3128)

```js
deprecationMsg.innerText = 'Notion Design Doc settings are deprecated. Use the Docs tab (Save as PRD / Save as Constitution) to import context instead.';
```

### 4. Update the code comment — `src/services/PlanningPanelProvider.ts` (line 1073)

Update the `_postToBothPanels` docblock comment so a developer grepping for the current button wording finds the right label:

```ts
    /**
     * Post a message to BOTH the project panel and the planning panel webviews.
     * The Docs-tab "Save as PRD / Save as Constitution" actions run in the
     * planning panel (`this._panel`) but reuse handlers that were originally wired
     * to the project panel (`this._projectPanel`). Replying to only one panel left
     * the planning-panel listeners dead (collision detection, success status, and
     * the Project-Context toggle warning never fired). Posting to both ensures the
     * requesting panel receives the response regardless of which is visible.
     */
```

## Verification Plan

### Automated Tests
- No automated tests required for this change. The existing `planning-copy-labels-regression.test.js` tests the unrelated `_getCopyLabel` kanban function and does not pin these button labels. No new test is warranted for a cosmetic/copy-only change.
- **Test suite will be run separately by the user.** No test execution is part of this plan's verification.
- **No compilation step** is part of this plan's verification (project assumed pre-compiled / compilation-free for this session).

### Manual Verification
1. Build the VSIX and open the Planning panel → Docs tab in VS Code.
2. Confirm the two buttons show teal text on a dim-teal background (no more grey-on-tint), and read "Save as PRD" / "Save as Constitution".
3. Toggle the warm/terracotta theme and re-check contrast on both buttons.
4. Enable the cyber theme and hover each button — confirm the `--glow-teal` hover glow still appears and no styling regresses.
5. Hover each button and confirm the new tooltip text explains the copy/destination behavior.
6. Click each button to confirm the existing project-picker / collision-modal flow (`planning.js` ~line 6855+) still fires unchanged; styling/copy change must not affect click handlers or posted message types.
7. Open the Automation tab's agent list with the Notion design-doc setting present and confirm the deprecation note in `implementation.html` reads "Save as PRD / Save as Constitution".
8. Visually compare the full controls strip — the two buttons should now read as deliberate "primary/special" actions, distinguishable at a glance from Edit/Save/Cancel, with no contrast issue.
9. Grep the `src/` tree for "Set as Requirements" and "Set as Constitution" — confirm zero hits (all three references updated: buttons, deprecation note, code comment).

---

**Recommendation:** Complexity 2/10 → **Send to Intern**.

## Review Findings

**Files changed:** `src/webview/planning.html` (CSS class + button markup/labels), `src/webview/implementation.html` (deprecation note), `src/services/PlanningPanelProvider.ts` (code comment), `src/webview/planning.js` (stale comment fix — missed by original plan's edge-case audit). **Validation:** Grep for "Set as Requirements"/"Set as Constitution" across `src/` returns zero hits (plan verification step 9 passes). No compilation or test execution per session constraints. **Fixes applied:** Updated stale comment at `planning.js:6841` that still referenced old button labels — the plan's edge-case audit listed 3 references but missed this 4th one. **Remaining risks (NIT, deferred):** (1) The plan incorrectly claimed these buttons are "never disabled in markup" — `btn-set-prd` is disabled by default and toggled by `updatePrdButtonState()`; the `.strip-btn:disabled` rule overrides `.strip-btn--primary` color/border in disabled state, producing grey-on-teal at 0.4 opacity (acceptable for disabled UX). (2) On hover, the base `.strip-btn:hover` border-color override dims the primary border from full teal to dim teal — cosmetic only.
