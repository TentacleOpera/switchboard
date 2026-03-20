Here is the improved plan, structured precisely according to the strict Switchboard "How to Plan" guide.

***

# Make access main program button consistent styling

## Goal
Standardize the initial appearance of the "Access main program" button (the Jurassic Park easter egg) to use the default "ghost grey" secondary button style. This reduces unnecessary visual clutter and prevents a non-functional, low-priority feature from demanding user attention with a persistent red outline.

## User Review Required
> [!NOTE] 
> This is a purely visual UI change inside the webview. It does not alter any actual agent functionality or orchestration features.
> [!WARNING] 
> Care must be taken not to remove the `margin-top` spacing when removing the color styles, otherwise the button will collide with the active controls above it.

## Complexity Audit
### Band A — Routine
- Removing the inline `color` and `border-color` CSS properties from a single HTML element in `src/webview/implementation.html`.

### Band B — Complex / Risky
- None.


## Edge-Case Audit
- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** The existing JavaScript click listener handles the "DENIED" animation by programmatically applying new `style.background` and `style.color` properties dynamically, and then stripping them away after 1000ms. Stripping the initial inline colors simply means it returns to the standard grey, exactly as desired.

## Adversarial Synthesis
### Grumpy Critique
You are taking the fun out of the easter egg! It's supposed to look like a dangerous terminal command from the movie, that's why it was red! Making it a boring grey button completely defeats the purpose of the reference. Also, if you change it to grey, users might actually click it thinking it's a real feature and get confused by the "DENIED" animation.

### Balanced Response
Grumpy's point about the cinematic accuracy of the red button is valid, but UX consistency within a dense developer tool must take precedence. A bright red button constantly signals "danger" or "error state" to the user, drawing the eye unnecessarily when they are trying to manage real agents. By making it grey initially, it blends in with the UI until clicked, at which point the "DENIED" animation (which turns red) delivers the punchline effectively without polluting the default layout.

## Proposed Changes

### Sidebar Webview
#### [MODIFY] `src/webview/implementation.html`
- **Context:** The `btn-easter-egg` element is currently hardcoded with inline styles giving it a red border and text.
- **Logic:** We will strip the red color variables from the inline style, allowing it to fall back to the standard `.secondary-btn` CSS class (ghost grey).
- **Implementation:** Locate the button inside `#terminal-operations-fields`. Change `style="margin-top: 6px; border-color: color-mix(in srgb, var(--accent-red) 30%, transparent); color: var(--accent-red);"` to simply `style="margin-top: 6px;"`.
- **Edge Cases Handled:** Preserves the 6px top margin so it doesn't crash into the real operational buttons above it.

## Verification Plan
### Automated Tests
- None required for this HTML style change.

### Manual Testing
1. Launch the Switchboard extension and open the sidebar.
2. Expand the **TERMINAL OPERATIONS** section.
3. Verify that the "Access main program" button is now the same neutral grey color as standard secondary buttons (like "INIT PLUGIN" or "OPEN FOLDER").
4. Verify the vertical spacing between "RESET ALL AGENTS" and "Access main program" remains intact.
5. Click the "Access main program" button. Verify the "DENIED" animation still functions correctly (turns solid red, then reverts to ghost grey after 1 second).

---

## Appendix: Implementation Patch

Apply the following patch to `src/webview/implementation.html`:

```diff
--- src/webview/implementation.html
+++ src/webview/implementation.html
@@ -... +... @@
 <div class="system-section">
 <div class="panel-toggle" id="terminal-operations-toggle">
 <div class="section-label" style="margin:0">TERMINAL OPERATIONS</div>
 <span class="chevron open" id="terminal-operations-chevron">▶</span>
 </div>
 <div class="panel-fields open" id="terminal-operations-fields">
 <button id="createAgentGrid" class="secondary-btn is-teal w-full">OPEN AGENT TERMINALS</button>
 <button id="btn-deregister-all" class="secondary-btn error w-full">RESET ALL AGENTS</button>
-<button id="btn-easter-egg" class="secondary-btn w-full" style="margin-top: 6px; border-color: color-mix(in srgb, var(--accent-red) 30%, transparent); color: var(--accent-red);">Access main program</button>
+<button id="btn-easter-egg" class="secondary-btn w-full" style="margin-top: 6px;">Access main program</button>
 </div>
 </div>
 <!-- SETUP -->
```