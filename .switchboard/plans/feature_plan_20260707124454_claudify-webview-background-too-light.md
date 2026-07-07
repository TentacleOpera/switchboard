# Fix: Claudify theme — webview background behind the grid is too light

**Plan ID:** a1b2c3d4-0004-4a04-9f04-claudifyground0004

## Goal

In the Claudify theme, the background colour behind the grid in the webviews (the ground surface on which the grid lines are drawn) is too light a grey. Make it a dark grey instead, so the claudify webview ground reads as a dark immersive surface rather than a washed-out light grey.

### Problem / background / root cause

The claudify ground colour is `#1C1C1C` — applied consistently as the `background-color` of the gridded surface in every webview:

- `setup.html:473-478` — `body.theme-claudify { background-color: #1C1C1C; ... grid ... }` *(correction: rule spans :473-479; closing brace is on line 479)*
- `setup.html:480-486` — `body.theme-claudify .shared-tab-content { background-color: #1C1C1C; ... grid ... }` (the panel surface — being made opaque/solid by the sibling Issue 3 plan)
- `design.html:2326-2337` — `body.theme-claudify #briefs-content, #design-content, #stitch-content, #preview-pane-design, #stitch-preview-pane { background-color: #1C1C1C; ... grid ... }`

`#1C1C1C` is RGB(28,28,28). Compared to the Afterburner ground (`#101414`, RGB(16,20,20) — `setup.html:458`, `design.html:2152`), the claudify ground is noticeably lighter. The user perceives this as "too light a grey" and wants a dark grey instead.

The `#1C1C1C` value was chosen for a "flat neutral surface" look, but in practice — especially across large webview areas like the Design doc-preview pane — it reads as a washed mid-grey rather than a dark immersive ground. The grid lines (`rgba(255,255,255,0.05)`) over `#1C1C1C` have low contrast, making the surface feel even flatter/lighter.

**Root cause:** the claudify ground `background-color` is set to `#1C1C1C` everywhere the grid appears; it needs to be a darker grey to match the intended dark immersive aesthetic and Afterburner's effective darkness.

## Metadata

**Tags:** frontend, theme, claudify, css, bugfix, design
**Complexity:** 2

## User Review Required

- **Confirm `#0a0a0a` reads as "dark immersive" vs too-black.** The proposed ground colour is RGB(10,10,10) — very near black. Verify visually that it still reads as a dark grey surface (not indistinguishable from the solid `#000000` panels from Issue 3). If it feels too close to pure black, consider `#111111` or `#0d0d0d` as alternatives.
- **Confirm grid-line contrast is acceptable, not harsh.** Darkening the ground from `#1C1C1C` to `#0a0a0a` increases the contrast of the `rgba(255,255,255,0.05)` grid lines. Verify the grid does not become visually prominent or harsh — it should remain a subtle texture.
- **Confirm cross-panel consistency.** After updating all 6 occurrences across 4 files, verify the claudify ground reads identically in Setup, Design, Planning, and Project webviews.

## Complexity Audit

### Routine
- Replacing every claudify ground `background-color: #1C1C1C` with a darker grey. A single value change applied at each occurrence (setup body, setup panel, design content/preview panes).
- Picking the target dark grey. Candidates: `#0a0a0a` (matches `--panel-bg2` in `design.html:42`), `#101414` (matches Afterburner ground), `#111111` (matches `--bg-dim` in `setup.html:22`). Any of these reads as "dark grey". Recommended: `#0a0a0a` for consistency with the existing `--panel-bg2` variable used throughout the webviews, OR introduce a `--claudify-ground` variable.

### Complex / Risky
- **Grid-line contrast.** Darkening the ground increases the contrast of the `rgba(255,255,255,0.05)` grid lines, which is desirable (the grid becomes more visible, matching Afterburner's `rgba(255,255,255,0.04)` over `#101414`). No grid-line change required, but verify the grid does not become too prominent.
- **Consistency across webviews.** The same `#1C1C1C` is used in `setup.html` and `design.html`. Both must be updated to the same dark value so claudify reads consistently across all panels. Check `planning.html`, `implementation.html`, `project.html`, and `kanban.html` for any other claudify ground occurrences and update them too.
- **Interaction with Issue 3.** The sibling Issue 3 plan makes the setup `.shared-tab-content` panel solid (removing the grid from the panel). That plan sets the panel to `var(--panel-bg)` = `#000000`. This plan (Issue 4) is about the **body ground** colour (the surface behind the grid, visible in gaps/margins and in design content panes). The two are complementary: panel = solid black, body ground = dark grey with grid. Ensure the body ground value chosen here is distinct from the panel solid fill so the layout still has depth.
- **Published extension** — pure CSS, no migration, no data risk.

## Edge-Case & Dependency Audit

- **All claudify ground occurrences must be found.** Search every webview HTML for `#1C1C1C` in a claudify context and update consistently. Missing one leaves a single panel lighter than the rest.
- **`--panel-bg` / `--panel-bg2` variables.** `design.html` defines `--panel-bg: #000000` and `--panel-bg2: #0a0a0a` (`:41-42`). The claudify ground could reference `var(--panel-bg2)` instead of a hardcoded hex, keeping it DRY and theme-variable-driven. `setup.html` defines `--panel-bg: #000000`, `--panel-bg2: #050505` (`:17-18`) — slightly darker than design's. Decide whether to hardcode `#0a0a0a` everywhere or use the per-file variable (they differ slightly). Recommended: hardcode a single `#0a0a0a` for claudify ground across all webviews so the claudify ground is identical everywhere regardless of each file's `--panel-bg2`.
- **Afterburner untouched.** Do not change `#101414` (afterburner ground). Only the claudify ground changes.
- **Dependencies** — Issue 3's plan edits the claudify `.shared-tab-content` panel rule (makes it solid). This plan edits the claudify body/content ground rules. Coordinate so the panel rule (Issue 3) and body rule (Issue 4) do not both set `background` on the same selector with conflicting values. Issue 3 sets `.shared-tab-content` to solid `#000000`; Issue 4 sets `body.theme-claudify` (the body ground) to dark grey `#0a0a0a`. Different selectors — no conflict.

## Dependencies

None — no cross-session dependencies. Note: sibling Plan B (setup panel opacity) sets `.shared-tab-content` to solid `#000000` — coordinate so the panel solid fill and body ground (this plan, `#0a0a0a`) stay distinct; sibling Plan A (theme broadcast) is TS-only and independent.

## Adversarial Synthesis

Hardcoding `#0a0a0a` across all webviews risks insufficient visual separation from Plan B's solid `#000000` panels (10 RGB units apart), and the per-file `--panel-bg2` divergence (setup `#050505` vs design `#0a0a0a`) means a variable-driven approach would produce inconsistent grounds. The audit is exhaustive — all 6 occurrences across 4 files are enumerated from grep; no JS/inline/style-attribute occurrences exist.

## Proposed Changes

### 1. `src/webview/setup.html` — darken claudify body ground

Replace `setup.html:473-478`:

```css
/* BEFORE */
body.theme-claudify {
    background-color: #1C1C1C;
    background-image:
        linear-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.05) 1px, transparent 1px);
    background-size: 40px 40px, 40px 40px;
}

/* AFTER */
body.theme-claudify {
    background-color: #0a0a0a;   /* dark grey ground (was #1C1C1C — too light) */
    background-image:
        linear-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.05) 1px, transparent 1px);
    background-size: 40px 40px, 40px 40px;
}
```

Leave the `.shared-tab-content` claudify rule to the Issue 3 plan (it makes the panel solid `#000000`).

### 2. `src/webview/design.html` — darken claudify content/preview ground

Replace `design.html:2326-2337`:

```css
/* BEFORE */
body.theme-claudify #briefs-content,
body.theme-claudify #design-content,
body.theme-claudify #stitch-content,
body.theme-claudify #preview-pane-design,
body.theme-claudify #stitch-preview-pane {
    background-color: #1C1C1C;
    background-image:
        linear-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.05) 1px, transparent 1px);
    background-size: 40px 40px, 40px 40px;
}

/* AFTER */
body.theme-claudify #briefs-content,
body.theme-claudify #design-content,
body.theme-claudify #stitch-content,
body.theme-claudify #preview-pane-design,
body.theme-claudify #stitch-preview-pane {
    background-color: #0a0a0a;   /* dark grey ground (was #1C1C1C — too light) */
    background-image:
        linear-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.05) 1px, transparent 1px);
    background-size: 40px 40px, 40px 40px;
}
```

### 3. Audit other webviews for `#1C1C1C` claudify grounds — ACTUAL GREP RESULTS

Grep of `src/webview/*.html` and `src/webview/*.css` for `#1C1C1C` (case-insensitive) found **6 occurrences in 4 files**, all claudify-context grounds. No matches in `.css` files, `implementation.html`, `kanban.html`, or any JS/TS/inline-style source.

| # | File | Line | Selector | Context |
|---|------|------|----------|---------|
| 1 | `setup.html` | 474 | `body.theme-claudify` | Body ground |
| 2 | `setup.html` | 481 | `body.theme-claudify .shared-tab-content` | Panel ground (being made solid by Issue 3) |
| 3 | `design.html` | 2332 | `body.theme-claudify #briefs-content, #design-content, #stitch-content, #preview-pane-design, #stitch-preview-pane` | Content/preview ground |
| 4 | `planning.html` | 2365 | `body.theme-claudify #docs-content, #research-content, #tickets-content, #preview-pane, #preview-pane-tickets` | Content/preview ground |
| 5 | `planning.html` | 3449 | `body.theme-claudify #notebook-content` | Notebook ground |
| 6 | `project.html` | 663 | `body.theme-claudify #kanban-content, #features-content, #constitution-content, #system-content, #tuning-content, #projects-content, #kanban-preview-pane, #features-preview-pane, #constitution-preview-pane, #system-preview-pane, #tuning-preview-pane, #projects-preview-pane` | Content/preview ground |

**Files confirmed clean (no `#1C1C1C`):** `implementation.html`, `kanban.html`, `shared-tabs.css`, all other `.css` files, all `.js`/`.ts` files, no inline `style=` attributes.

**Action:** Change every `background-color: #1C1C1C` in the table above to `background-color: #0a0a0a`. Afterburner `#101414` stays untouched. Occurrence #2 (setup `.shared-tab-content`) is being replaced by Issue 3's solid `#000000` panel — coordinate so both plans don't conflict on that selector.

**Recommendation:** Complexity 2 → **Send to Intern**

## Verification Plan

1. **Manual (installed VSIX):**
   - Set theme to Claudify.
   - Open Design, Setup, Planning, Project, Kanban.
   - Confirm the ground colour (behind the grid, in content areas and body margins) is a **dark grey** (`#0a0a0a`-ish), visibly darker than the previous `#1C1C1C`. It should read as a dark immersive surface, not a washed mid-grey.
2. **Grid visibility:** Confirm the grid lines remain visible but not harsh over the darker ground (contrast improved vs. before).
3. **Cross-panel consistency:** Confirm the claudify ground is the same dark grey in every webview — no single panel lighter than the rest.
4. **Afterburner regression:** Switch to Afterburner; confirm the `#101414` ground is unchanged.
5. **Contrast with solid panels (post-Issue 3):** With the setup panels made solid black (Issue 3), confirm the body ground (dark grey, this plan) is distinguishable from the panel (solid black) — the layout retains depth.

**Stage Complete:** PLAN REVIEWED
