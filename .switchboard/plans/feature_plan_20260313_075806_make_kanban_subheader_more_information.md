# Make kanban subheader more informative

## Goal
Update the Kanban header subtitle to better reflect the cross-IDE bridge and copy-prompt functionality. The new subtitle will clearly communicate the two primary ways to interact with the Kanban board: drag-and-drop orchestration and copy-pasting prompts to external IDE agents.

## User Review Required
> [!NOTE] 
> This is a purely visual UI text update in the Kanban webview. No backend logic or orchestration behavior is altered. 
> [!WARNING]
> Adding length to the header text may impact how the header flexbox responds on extremely narrow VS Code panel widths.

## Complexity Audit
### Band A — Routine
- String replacement in the `.kanban-title` element inside `src/webview/kanban.html`.

### Band B — Complex / Risky
- None. This is an isolated, low-risk presentation layer change.

## Edge-Case Audit
- **Race Conditions:** None. This is a static HTML modification.
- **Security:** None.
- **Side Effects:** The expanded text could cause the `.kanban-header` flex container to wrap awkwardly or push the right-side controls (the Refresh button and the global automation dropdown) off-screen if the VS Code window is very narrow. The existing 11px monospace font size mitigates this, but responsive resizing must be tested.

## Adversarial Synthesis
### Grumpy Critique
Making the subheader super long just litters the UI! Users stop reading long strings of text after the first 3 words anyway. If you want to educate them about cross-IDE agents, put a proper tooltip or a help icon. Stretching out the title bar just forces the layout to squish other controls. And what happens when we translate this to other languages later? It'll break the layout entirely!

### Balanced Response
Grumpy's point about UI clutter and text blindness is fair. However, for a developer tool like Switchboard, explicit text in empty header space is often more discoverable than hidden tooltips. We are relying on the small, monospace font to keep the visual weight low. While localization is not currently a requirement for this specific webview, the flex layout will simply wrap the text into a neat block if it exceeds the available space, ensuring other controls like the Refresh button are never pushed off-screen.

## Proposed Changes

### Kanban Webview
#### [MODIFY] `src/webview/kanban.html`
- **Context:** The `.kanban-title` element inside the `.kanban-header` container currently only mentions dragging cards, missing the new cross-IDE copy feature.
- **Logic:** Replace the inner text of the `.kanban-title` div with the expanded instructional string.
- **Implementation:** Change the string `⚡ CLI-BAN - Drag plan cards to trigger CLI Agent actions` to `⚡ CLI-BAN - Drag plan cards to trigger CLI Agent actions | Copy prompts to send to external IDE agents`.
- **Edge Cases Handled:** Standard flexbox rules will handle minor wrapping; no new CSS constraints are required.

## Verification Plan
### Automated Tests
- None required for this HTML string update.

### Manual Testing
1. Open the Switchboard sidebar and click **OPEN CLI-BAN** to launch the Kanban board.
2. Look at the top-left header. Verify it now reads: `⚡ CLI-BAN - Drag plan cards to trigger CLI Agent actions | Copy prompts to send to external IDE agents`.
3. Progressively resize the VS Code window or the editor group panel to make it narrower.
4. Verify that the text remains readable, the "Refresh" button remains accessible, and the layout doesn't break hideously (wrapping to a second line is acceptable if space runs out).

***

## Appendix: Implementation Patch
Apply the following patch to `src/webview/kanban.html`:

```diff
--- src/webview/kanban.html
+++ src/webview/kanban.html
@@ -... +... @@
 </head>
 
 <body>
 
 <div class="kanban-header">
 
-<div class="kanban-title">⚡ CLI-BAN - Drag plan cards to trigger CLI Agent actions</div>
+<div class="kanban-title">⚡ CLI-BAN - Drag plan cards to trigger CLI Agent actions | Copy prompts to send to external IDE agents</div>
 
 <button class="btn-refresh" id="btn-refresh">Refresh</button>
 
 </div>
 
```

***

## Final Review Results

### Implemented Well
- The file `src/webview/kanban.html` was correctly identified and updated.
- The UI retains the appropriate styling and elements.

### Issues Found
- **[MAJOR]** The implemented string diverged from the plan. It read `IDE chat agents` instead of `external IDE agents`.
- **[NIT]** An undocumented `id="kanban-title"` was present on the element in the existing code that was left intact.

### Fixes Applied
- Updated the string in `src/webview/kanban.html` to exactly match the plan text: `⚡ CLI-BAN - Drag plan cards to trigger CLI Agent actions | Copy prompts to send to external IDE agents`. Retained the existing `id` attribute as it might be used elsewhere and causes no harm.

### Validation Results
- Executed compilation tests (`npm run compile` via `npm test`). Webpack successfully bundled the assets, copying `kanban.html` without issue.
- ESLint checks failed globally due to v9 config migration, unrelated to this HTML change.

### Remaining Risks
- The long text may wrap awkwardly on extremely narrow viewports, though flexbox rules should handle it naturally.

### Final Verdict: Ready