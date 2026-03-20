# Increase 'Create Plan' modal size

## Notebook Plan

The current size of the create plan modal is extremely tiny. Make it bigger to be more usable.

## Goal
- Increase the dimensions (width and height) of the "Create Plan" modal to improve usability.
- Ensure the text input areas within the modal expand to take advantage of the increased space.
- Ensure the modal remains responsive and centered on the screen.

## Proposed Changes
- (Pending Investigation) Locate the HTML and CSS defining the "Create Plan" modal (likely within a webview file like `kanban.html` or a dedicated modal template).
- Update the CSS classes for the modal container to increase its `width`, `max-width` (e.g., from a narrow fixed width to something like `800px` or `80vw`), and `height` (or `max-height`).
- Update the text area styling within the modal to increase its `min-height` (e.g., to `150px` or `200px`) and ensure it uses `resize: vertical` or flex-grow to fill available space.

## Verification Plan
- Trigger the "Create Plan" action to open the modal.
- Verify that the modal appears significantly larger than before.
- Verify that the input fields/text areas are spacious enough for multi-line plan descriptions.
- Resize the VS Code window or webview panel to ensure the modal scales down gracefully without breaking the layout.

## Open Questions
- Is the modal a custom HTML element overlaying a webview, or is it utilizing a native VS Code UI component (like an InputBox or WebviewPanel)? The approach will differ depending on the technology used.

## Review Feedback
- **Grumpy Review:** "Extremely tiny"? "Make it bigger"? Is this a UI specification or a toddler's drawing prompt?! How much bigger? 800px? 90vw? Does it scale? Is it just the width or does the text area need more height? "More usable" isn't a CSS value! You can't just throw this at a frontend dev and expect them to guess what dimensions you think are "usable". We need actual CSS values, flexbox properties, or a grid layout defined before touching the code! And where is this modal even defined?
- **Balanced Synthesis:** The feedback regarding the modal size is a valid UX concern. While the request lacks specific dimensions, the intent is clear: increase the width and height of the modal and its internal text areas. The implementation involves identifying the CSS properties for the modal container and text areas and updating them to more generous defaults (e.g., max-width 800px, larger min-height) while maintaining responsiveness.

#### Complexity Audit
- Band A (routine task). Updating CSS dimensions for a webview modal/container.

#### Edge-Case Audit
- Race conditions: None identified.
- Side effects: Using fixed large sizes (e.g. 800px) might break the layout on smaller screens or if the VS Code panel is narrow. Needs to rely on responsive units.
- Security holes: None identified.

***

## Final Review Results

### Implemented Well
- The `max-width` of `.modal-card` in `src/webview/implementation.html` was properly increased to `800px`, which gives a significantly wider surface area for text input while retaining responsiveness via the base `width: 100%`.
- The `.modal-textarea` `min-height` was bumped up to `200px` with `resize: vertical`, providing adequate height out of the box with room to grow.
- The implementer smartly added inline `max-width` overrides (`style="max-width: 480px;"` and `style="max-width: 520px;"`) to the *other* modals (Recover Plans and Custom Agent), isolating the width increase to only the Create Plan modal where it was intended.

### Issues Found
- None. The adjustments perfectly met the goals of the plan while avoiding unintended layout breakage for the other popups.

### Fixes Applied
- None required.

### Validation Results
- Executed `npm run compile`. Webpack processed and copied the HTML correctly without breaking the build.
- Analyzed the CSS structural logic in the source, confirming `100%` width rules ensure `800px` max caps out gracefully on smaller panels.

### Remaining Risks
- The explicit inline style attributes on other modals (`max-width: 480px;`) could become tech debt if a generalized "large vs small" modal class system is needed later, but it works safely for the current scope.

### Final Verdict: Ready