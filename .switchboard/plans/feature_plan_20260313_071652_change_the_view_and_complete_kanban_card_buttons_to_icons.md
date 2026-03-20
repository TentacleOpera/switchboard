# Change the view and complete kanban card buttons to icons

## Goal
Improve Kanban card density and visual hierarchy by replacing text-based "VIEW" and "COMPLETE" buttons with clear iconography (eye and checkmark). This will allow the "Copy Prompt" button to remain prominent while reducing visual clutter on the cards.

## User Review Required
> [!NOTE] 
> This is a visual UI change. The new icons will need to be manually verified in the VS Code panel to ensure they scale correctly, maintain the industrial aesthetic, and offer clear tooltips for discoverability.

## Complexity Audit
### Band A — Routine
- CSS and HTML updates in `src/webview/kanban.html`.
- Modifying the `createCardHtml` string template to replace text with SVG icons and a nested flex container.
- Adding tooltip attributes (`title`) to the new icon buttons.

### Band B — Complex / Risky
- None.


## Edge-Case Audit
- **Race Conditions:** None. These are static DOM structural changes.
- **Security:** None.
- **Side Effects:** Using raw OS emojis (👁️, ✔️) could render inconsistently across Windows, macOS, and Linux, potentially clashing with Switchboard's dark, industrial UI aesthetic. We will use inline SVGs to ensure perfect cross-platform consistency. 

## Adversarial Synthesis
### Grumpy Critique
Using SVGs inline directly inside the JavaScript template literal string is going to make `kanban.html` a nightmare to read and maintain! It'll be a massive wall of unreadable path data mixed with logic. Also, if you use `currentColor`, what happens when the button is in a disabled state? The SVG needs to inherit the correct opacity or it will look fully active while the button isn't! Have you thought about the color mix?

### Balanced Response
Grumpy is right that inline SVGs can clutter JavaScript template literals, but since VS Code webviews don't easily allow importing external asset files without complex URI transformations, inline SVGs are the most robust approach here. To mitigate unreadability, the SVGs are minified and kept extremely simple. Regarding the disabled state and colors, using `currentColor` guarantees that if the parent button's text color changes (via opacity or a CSS class like `.disabled`), the SVG icon will match it perfectly without requiring additional CSS rules.

## Proposed Changes

### Kanban Webview
#### [MODIFY] `src/webview/kanban.html`
- **Context:** The action buttons inside each Kanban card take up too much horizontal space, making the layout feel cramped.
- **Logic:** We will add a new `.icon-btn` utility class to constrain the button to a clean square. Inside `createCardHtml`, we will separate the "Copy Prompt" button from the utility buttons by wrapping the utilities in their own right-aligned flex group.
- **Implementation:** Update the `<style>` block to include the `.icon-btn` modifier. Update `createCardHtml` to inject SVGs for the "View" and "Complete" buttons, applying the new class and `title` attributes.
- **Edge Cases Handled:** Using `currentColor` inside the SVGs ensures the icons automatically respect the existing hover state color transitions (e.g., turning teal on hover).

## Verification Plan

### Automated Tests
- None required for this HTML/CSS layout change.

### Manual Testing
1. Open the Kanban board (`CLI-BAN`) via the Switchboard sidebar.
2. Verify that each card now shows an eye icon and a checkmark icon in the bottom right, while the "Copy Prompt" button remains clearly visible on the left.
3. Hover over the eye icon and verify the native OS tooltip displays "View Plan".
4. Hover over the checkmark icon and verify the tooltip displays "Complete Plan".
5. Click both icons to ensure their original IPC messages (opening the plan and marking it complete) still trigger successfully.

***

## Appendix: Implementation Patch

Apply the following patch to `src/webview/kanban.html`:

```diff
--- src/webview/kanban.html
+++ src/webview/kanban.html
@@ -... +... @@
 .card-btn:hover {
 background: color-mix(in srgb, var(--text-secondary) 10%, transparent);
 border-color: var(--border-bright);
 color: var(--text-primary);
 }
 
 .card-btn.complete:hover {
 border-color: var(--accent-teal-dim);
 color: var(--accent-teal);
 }
 
+.card-btn.icon-btn {
+padding: 4px;
+width: 20px;
+height: 20px;
+display: flex;
+align-items: center;
+justify-content: center;
+}
+
 .empty-state {
 text-align: center;
 padding: 20px 10px;
@@ -... +... @@
 <div class="kanban-card" draggable="true" data-session="${card.sessionId}">
 <div class="card-topic" title="${escapeHtml(card.topic)}">${escapeHtml(shortTopic)}</div>
 <div class="card-meta">Complexity: <span class="complexity-indicator ${complexityClass}">${complexity}</span> · ${timeAgo}</div>
 
-<div class="card-actions">
-<button class="card-btn copy" data-session="${card.sessionId}">${copyLabel}</button>
-<button class="card-btn view" data-session="${card.sessionId}">View</button>
-<button class="card-btn complete" data-session="${card.sessionId}">Complete</button>
-</div>
+<div class="card-actions" style="display: flex; justify-content: space-between; align-items: center;">
+<button class="card-btn copy" data-session="${card.sessionId}">${copyLabel}</button>
+<div style="display: flex; gap: 4px;">
+<button class="card-btn icon-btn view" data-session="${card.sessionId}" title="View Plan">
+<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8c0 0 3-4.5 6.5-4.5S14.5 8 14.5 8s-3 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2.5"/></svg>
+</button>
+<button class="card-btn icon-btn complete" data-session="${card.sessionId}" title="Complete Plan">
+<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6"/></svg>
+</button>
+</div>
+</div>
 
 </div>`;
 }
```