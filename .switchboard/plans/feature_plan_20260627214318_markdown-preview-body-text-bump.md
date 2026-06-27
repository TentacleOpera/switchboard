# Bump markdown preview body text +1pt in planning, design, and project views

## Goal

The body text (paragraphs and list items) rendered inside the markdown preview panes of `planning.html`, `design.html`, and `project.html` is slightly too small — it reads as smaller than even terminal text, making plan/constitution/kanban content hard to read. The base font-size for these preview containers is `13px`; it should be bumped up one point to `14px`.

### Problem analysis & root cause

All three webview HTML files declare a "Unified Markdown Preview Styling" block that sets a single base `font-size: 13px` on the markdown preview container. Body-level elements (`p`, `li`) inherit this base via `font-size: inherit`, and headings (`h1`–`h6`) are sized in `em` units relative to this same base. There is no separate paragraph font-size override — the entire body-text scale is anchored to the container's `13px`.

At `13px` in a VS Code webview (which renders at device pixel ratios that often make 13px appear smaller than the editor's own ~14px terminal/editor font), the preview body text ends up visually smaller than the surrounding terminal and editor chrome, hurting readability.

**Root cause:** The base font-size constant (`13px`) chosen for the markdown preview containers is one point too small relative to the editor/terminal baseline the user reads alongside.

**Fix:** Change the container base from `13px` → `14px` in all three files. Because headings and body text both derive from this base (via `em` and `inherit` respectively), a single one-line change per file lifts the entire readable scale by one point while preserving all relative proportions.

## Metadata

- **Tags:** `css`, `webview`, `typography`, `planning`, `design`, `project`, `accessibility`, `ux`
- **Complexity:** 2/10
- **Files touched:** 3 (`src/webview/planning.html`, `src/webview/design.html`, `src/webview/project.html`)
- **Risk:** Very low — pure CSS font-size bump, no logic/data changes.

## Complexity Audit

**Routine.** This is a three-line CSS value change (one per file) plus updating inline comments that hard-reference the old `13px` base. There are no conditional branches, no JS logic, no state, and no migrations. The only subtlety is ensuring all three files are updated consistently so the preview typography stays uniform across views.

The change is unreleased-dev-only styling tuning? No — these styles ship in the published extension, but a font-size bump is a non-breaking visual refinement with no data/state implications, so no migration is required.

## Edge-Case & Dependency Audit

1. **Heading scaling side effect.** Headings use `em` units relative to the container base. Bumping `13px → 14px` proportionally scales all headings:
   - h1: 26px → 28px
   - h2: 19.5px → 21px
   - h3: 16.25px → 17.5px
   - h4: 13px → 14px (equals new body size)
   - h5: ~11.4px → ~12.25px
   - h6: ~11.05px → ~11.9px

   This is desirable — the user asked to bump body text, and keeping headings on the same base preserves the visual hierarchy ratio. No separate heading changes are needed.

2. **Inline code / code blocks.** Inline `code` uses `font-size: 0.85em` (relative to base) in all three files; code blocks (`pre code`) inherit. Both scale proportionally with the base bump — no separate change required.

3. **Theme variants (cyber-theme, claudify).** These themes override heading font-family/color/letter-spacing but do **not** override the container base `font-size`. They will inherit the new `14px` base automatically. Verified: no `font-size` override on `#markdown-preview*` or `#kanban-preview-content*` under `.cyber-theme-enabled` or `.theme-claudify` selectors.

4. **Stale comments.** Several inline comments hardcode "13px base" (e.g. `/* 2em relative to 13px base = 26px */`, `/* Inherits from container's 13px */`). These must be updated to `14px` to avoid misleading future readers. This is the bulk of the per-file edits.

5. **Other webview files.** `kanban.html` also has markdown preview styling but was not named in the issue. It is out of scope — leaving it at `13px` would create an inconsistency, but the user explicitly scoped this to planning/design/project. (See Verification Plan for a note on optional follow-up.)

6. **No JS dependencies.** No JavaScript reads or computes against `13px`; the preview renderers inject HTML into these containers without touching font-size. Confirmed by grep — no `fontSize`/`13` references in the webview JS that bind to these containers.

7. **`dist/` not relevant.** Per project rules, `dist/` is not used during dev/testing; `src/` is the source of truth. No `dist/` audit needed.

## Proposed Changes

### File 1: `src/webview/planning.html`

**Change A — container base font-size (line ~1022):**

```css
/* BEFORE */
#markdown-preview,
#markdown-preview-online,
#markdown-preview-design,
#markdown-preview-tickets,
#kanban-preview-pane {
    ...
    font-family: var(--font-family);
    font-size: 13px;
    line-height: 1.5;
    ...
}

/* AFTER */
#markdown-preview,
#markdown-preview-online,
#markdown-preview-design,
#markdown-preview-tickets,
#kanban-preview-pane {
    ...
    font-family: var(--font-family);
    font-size: 14px;
    line-height: 1.5;
    ...
}
```

**Change B — update stale `13px` comments** on heading/paragraph rules to reference `14px`:
- h1 comment: `/* 2em relative to 13px base = 26px */` → `/* 2em relative to 14px base = 28px */`
- h2 comment: `/* 1.5em relative to 13px base = 19.5px */` → `/* 1.5em relative to 14px base = 21px */`
- h3 comment: `/* 1.25em relative to 13px base = 16.25px */` → `/* 1.25em relative to 14px base = 17.5px */`
- `p` rule comment: `/* Inherits from container's 13px */` → `/* Inherits from container's 14px */`

### File 2: `src/webview/design.html`

**Change A — container base font-size (line ~1022):**

```css
/* BEFORE */
#markdown-preview,
#markdown-preview-online,
#markdown-preview-design,
#markdown-preview-tickets,
#markdown-preview-briefs,
#kanban-preview-pane {
    ...
    font-family: var(--font-family);
    font-size: 13px;
    ...
}

/* AFTER */
#markdown-preview,
#markdown-preview-online,
#markdown-preview-design,
#markdown-preview-tickets,
#markdown-preview-briefs,
#kanban-preview-pane {
    ...
    font-family: var(--font-family);
    font-size: 14px;
    ...
}
```

**Change B — update stale `13px` comments** (same set as planning.html: h1/h2/h3 `em` comments and the `p` `inherit` comment).

### File 3: `src/webview/project.html`

**Change A — container base font-size (line ~847):**

```css
/* BEFORE */
#kanban-preview-content,
#epics-preview-content,
#constitution-preview-content,
#system-preview-content,
#tuning-preview-content {
    ...
    font-family: var(--font-family);
    font-size: 13px;
    line-height: 1.5;
    ...
}

/* AFTER */
#kanban-preview-content,
#epics-preview-content,
#constitution-preview-content,
#system-preview-content,
#tuning-preview-content {
    ...
    font-family: var(--font-family);
    font-size: 14px;
    line-height: 1.5;
    ...
}
```

**Change B — update stale `13px` comments** on the heading `em` rules (h3 comment `/* 1.25em relative to 13px base = 16.25px */` → `14px base = 17.5px`; check for and update any other `13px base` references in this file's preview block).

## Verification Plan

1. **Grep verification (no stale `13px`):**
   ```
   grep -n "13px" src/webview/planning.html src/webview/design.html src/webview/project.html
   ```
   Confirm no remaining `13px` references inside the "Unified Markdown Preview Styling" blocks or their heading/paragraph comment lines. (Other unrelated `13px` values elsewhere in the files — e.g. `.planning-select` — are out of scope and should remain.)

2. **Grep verification (new `14px` present):**
   ```
   grep -n "font-size: 14px" src/webview/planning.html src/webview/design.html src/webview/project.html
   ```
   Confirm exactly one new `font-size: 14px` in each file's markdown-preview container block.

3. **Visual verification (manual, via installed VSIX):**
   - Open the Planning view → select a plan → confirm body text in the markdown preview is visibly larger and now reads at least as large as terminal text.
   - Open the Design view → select a design doc / brief → confirm same.
   - Open the Project view → select a kanban plan / constitution / tuning doc → confirm same.
   - Toggle the cyber theme and claudify theme on each view → confirm headings scaled proportionally and no layout breakage.

4. **No build step required for dev verification** — `src/` is the source of truth per project rules. `npm run compile` is only needed when producing a release VSIX.

5. **Optional follow-up (out of scope, flag only):** `src/webview/kanban.html` was not named in the issue but likely has the same `13px` base. If the user wants fully uniform typography across all markdown previews, a separate follow-up can align it. Do not touch it in this plan.
