# Fix: Projects Tab Missing Theme Styles and Weird File Path Display

## Goal

The Projects tab in `project.html`'s doc preview does not have the same display rules (CSS theme styling) as the other tabs (Constitution, System, Tuning). Markdown content in the Projects tab renders with default VS Code styling instead of the themed styling (teal accents, uppercase headings, borders, cyber/claudify theme support). Additionally, a raw file path string is displayed directly above the content — a visual inconsistency that no other tab has. Fix both issues so the Projects tab is visually identical to the other governance tabs.

### Problem Analysis & Root Cause

**Issue A — Missing theme styles:**

The `#projects-preview-content` element is included in the base container styling (line 862 of `project.html`) but is **missing from every single markdown element styling rule** that applies themes. There are 22+ CSS rules in `project.html` that style markdown elements (h1-h6, p, li, pre, code, blockquote, ul/ol, table, th, td, a, hr, img) for the kanban, epics, constitution, system, and tuning preview panes — but `#projects-preview-content` is absent from all of them. This means markdown rendered in the Projects tab gets unstyled output: no teal accent colors, no uppercase heading transforms, no bordered code blocks, no themed tables.

**Root cause:** When the Projects tab was added, the developer included `#projects-preview-content` in the base container rule but failed to add it to the ~22 specific element styling rules. This is a copy-paste omission — every rule lists 5 selectors (kanban, epics, constitution, system, tuning) and the projects selector was simply never appended.

**Issue B — Weird file path display:**

At line 1497 of `project.html`, there is a dedicated element:
```html
<div id="projects-prd-path-hint" style="font-size:10px; font-family:monospace; color:var(--text-secondary); opacity:0.7; margin-bottom:6px;"></div>
```

This element is populated at line 533 of `project.js`:
```javascript
if (projectsPrdPathHint) projectsPrdPathHint.textContent = msg.path || '';
```

It displays the raw filesystem path (e.g., `/Users/patrick/.../switchboard/.switchboard/projects/my-project/prd.md`) directly above the rendered markdown content. No other tab (Constitution, System, Tuning) has this element. It is visually jarring and inconsistent.

**Root cause:** The Projects tab was built with an extra path hint element that the other tabs don't have. This was likely added for debugging or developer convenience and was never removed or made consistent with the other tabs' design.

## Metadata
- **Tags:** bug, frontend, css, ui, project-html, themes, projects-tab
- **Complexity:** 3

## Complexity Audit

### Routine
- Adding `#projects-preview-content` to 22+ existing CSS selectors (mechanical find-and-append)
- Removing or relocating the file path hint element
- Visual verification across themes

### Complex / Risky
- **CSS specificity** — Adding `#projects-preview-content` to existing selectors increases their length but doesn't change specificity (all are ID-level). No risk of overriding or being overridden.
- **Theme compatibility** — Need to verify the fix works with both the cyber theme and the claudify theme, plus the default (no theme) state.

## Edge-Case & Dependency Audit

- **All 22+ CSS rules must be updated** — Missing even one will leave a visual inconsistency (e.g., tables styled but links not styled).
- **Cyber theme glow effects** — Lines 779-805 have cyber-theme-specific glow effects for code, pre, and blockquote. These must also include `#projects-preview-content`.
- **Claudify theme** — Lines 833-849 have claudify-theme-specific heading styles. These must also include `#projects-preview-content`.
- **File path hint removal** — Removing the element from HTML and the population code from JS must be done together to avoid a null reference error.
- **No dependencies on other files** — all changes are within `project.html` and `project.js`.

## Proposed Changes

### 1. Add `#projects-preview-content` to all markdown element CSS rules

**File:** `src/webview/project.html`

For each of the following CSS rules, append `#projects-preview-content` (and the appropriate child selector) to the selector list. The pattern is: wherever `#constitution-preview-content h1` appears, add `#projects-preview-content h1` alongside it.

**Base heading styles (line 874-884):**
```css
/* Before: */
#kanban-preview-content h1, #kanban-preview-content h2, /* ... */, #tuning-preview-content h6 {
/* After: */
#kanban-preview-content h1, #kanban-preview-content h2, /* ... */, #tuning-preview-content h6, #projects-preview-content h1, #projects-preview-content h2, #projects-preview-content h3, #projects-preview-content h4, #projects-preview-content h5, #projects-preview-content h6 {
```

**Cyber theme heading typography (line 887-894):**
```css
/* Add: body.cyber-theme-enabled #projects-preview-content h1, body.cyber-theme-enabled #projects-preview-content h2, ... */
```

**Cyber theme h1 color (line 896-902):**
```css
/* Add: body.cyber-theme-enabled #projects-preview-content h1 */
```

**Cyber theme h2-h6 colors (line 904-910):**
```css
/* Add: body.cyber-theme-enabled #projects-preview-content h2, body.cyber-theme-enabled #projects-preview-content h3, ... */
```

**Claudify theme h1 (line 833-837):**
```css
/* Add: body.theme-claudify #projects-preview-content h1 */
```

**Claudify theme h2-h6 (line 845-849):**
```css
/* Add: body.theme-claudify #projects-preview-content h2, body.theme-claudify #projects-preview-content h3, ... */
```

**Base h1 specific (line 912-924):**
```css
/* Add: #projects-preview-content h1 */
```

**Base h2 specific (line 926-938):**
```css
/* Add: #projects-preview-content h2 */
```

**Base h3-h6 specific (line 940-962):**
```css
/* Add: #projects-preview-content h3, #projects-preview-content h4, #projects-preview-content h5, #projects-preview-content h6 */
```

**Paragraph styles (line 996-1005):**
```css
/* Add: #projects-preview-content p */
```

**List item styles (line 1007-1016):**
```css
/* Add: #projects-preview-content li */
```

**Code block styles (line 1026-1050):**
```css
/* Add: #projects-preview-content pre, #projects-preview-content pre code */
```

**Inline code styles (line 1052-1065):**
```css
/* Add: #projects-preview-content code */
```

**Blockquote styles (line 1067-1078):**
```css
/* Add: #projects-preview-content blockquote */
```

**List styles (line 1080-1087):**
```css
/* Add: #projects-preview-content ul, #projects-preview-content ol */
```

**Table styles (line 1090-1137):**
```css
/* Add: #projects-preview-content table, #projects-preview-content th, #projects-preview-content td */
```

**Link styles (line 1140-1156):**
```css
/* Add: #projects-preview-content a */
```

**HR styles (line 1158-1166):**
```css
/* Add: #projects-preview-content hr */
```

**Image styles (line 1168-1178):**
```css
/* Add: #projects-preview-content img */
```

**Cyber theme inline code glow (line 779-785):**
```css
/* Add: body.cyber-theme-enabled #projects-preview-content code */
```

**Cyber theme code block glow (line 788-795):**
```css
/* Add: body.cyber-theme-enabled #projects-preview-content pre */
```

**Cyber theme blockquote glow (line 798-805):**
```css
/* Add: body.cyber-theme-enabled #projects-preview-content blockquote */
```

### 2. Remove the weird file path hint element

**File:** `src/webview/project.html` (line 1497)

Remove this line:
```html
<div id="projects-prd-path-hint" style="font-size:10px; font-family:monospace; color:var(--text-secondary); opacity:0.7; margin-bottom:6px;"></div>
```

**File:** `src/webview/project.js` (line 533)

Remove or comment out this line:
```javascript
if (projectsPrdPathHint) projectsPrdPathHint.textContent = msg.path || '';
```

Also remove the element reference declaration (search for `projectsPrdPathHint` in the variable declarations section of `project.js` and remove it).

### 3. Alternative: Move path hint to controls strip (if path display is desired)

If the user wants to keep the path visible but in a less intrusive location, move it to the controls strip area (next to the workspace filter) instead of above the content:

**File:** `src/webview/project.html` (controls strip for projects tab, ~line 1485)

Add a subtle status span:
```html
<span id="projects-prd-path-hint" class="strip-status" style="font-size:11px; color:var(--text-secondary); opacity:0.6;"></span>
```

This keeps the path info available but visually consistent with other tabs' controls strips.

## Verification Plan

1. **Default theme — Projects tab:** Open project.html → Projects tab → select a project with a PRD → verify markdown renders with the same styling as the Constitution tab (themed headings, bordered code blocks, styled tables, etc.).
2. **Cyber theme — Projects tab:** Enable cyber theme → switch to Projects tab → verify teal accent colors, heading uppercase transforms, code block glow effects all appear.
3. **Claudify theme — Projects tab:** Enable claudify theme → switch to Projects tab → verify claudify heading styles apply.
4. **No file path above content:** Open Projects tab → select a project → verify there is NO raw file path string displayed above the markdown content.
5. **Other tabs unaffected:** Switch to Constitution, System, Tuning tabs → verify their styling is unchanged (no visual regression).
6. **All markdown elements styled:** In the Projects tab, verify: headings (h1-h6), paragraphs, lists (ul/ol), code blocks, inline code, blockquotes, tables, links, horizontal rules, and images all have themed styling.
7. **Empty state:** Open Projects tab with no project selected → verify the empty state still displays correctly.
