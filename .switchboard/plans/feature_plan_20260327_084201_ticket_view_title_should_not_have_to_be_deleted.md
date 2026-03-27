# Ticket View Title Should Use Placeholder Instead of Real Text

## Goal
When opening a plan's ticket view in the kanban, the title input starts with "Untitled Plan" as real text that must be manually deleted before typing a new title. Change this to HTML placeholder text so the input starts empty and ready for typing, while still saving as "Untitled Plan" if no title is provided.

## Metadata
**Tags:** frontend, UI, bugfix
**Complexity:** Low

## User Review Required
- Confirm that changing the display-heading fallback text from "Ticket" to "Untitled Plan" (visible in the `<h1>` when the input is empty) is acceptable.
- Confirm that existing plans already titled "Untitled Plan" should also show an empty input with the placeholder (i.e., "Untitled Plan" is always treated as the default/placeholder value, never displayed as real input text).

## Complexity Audit

### Routine
- Adding an HTML `placeholder` attribute to an existing `<input>` element.
- Changing a JavaScript `.value` assignment to conditionally leave the input empty.
- Adding a fallback default in the save function for empty input values.
- Updating display-heading fallback text from "Ticket" to "Untitled Plan" for consistency.

### Complex / Risky
- None. All changes are confined to the frontend view layer (`review.html`) and do not alter backend save logic, file-rename behavior, or database operations.

## Edge-Case & Dependency Audit

**Race Conditions:** None. The title input is set synchronously during `renderTicketData()` and read synchronously during `savePlanText()`. No async timing issues.

**Security:** No new security concerns. The title value already goes through `.trim()` before being sent to the backend, and the backend already sanitizes via `String(request.topic || '').trim()`.

**Side Effects:**
- The `<h1>` display heading will now show "Untitled Plan" instead of "Ticket" when the input is empty. This is intentional and more descriptive.
- Existing plans with the title "Untitled Plan" will now show an empty input with placeholder text when reopened. Saving without changes will still produce the same "Untitled Plan" title, so this is a no-op for storage.

**Dependencies & Conflicts:**
- No conflict with other plans modifying `kanban.html` (Rename CLI-BAN to AUTOBAN, Replace completed column icons, Add Database Operations Panel) because all changes here are in `src/webview/review.html`.
- No backend changes required — `TaskViewerProvider.ts` already handles empty topics gracefully by falling back to the H1 heading in the plan content.

## Adversarial Synthesis

### Grumpy Critique
This is a four-line change dressed up as a feature request. You're adding a placeholder attribute and an `if` check — a junior dev could do this in five minutes without a plan file. The only thing that could possibly go wrong is if someone deliberately named their plan "Untitled Plan" and now they'll see an empty input, but who does that? Also, changing the h1 fallback from "Ticket" to "Untitled Plan" is a silent UX rename that nobody asked for — you're sneaking in scope creep. And the real-time `input` event listener fallback change means the heading flickers to "Untitled Plan" while typing and clearing — did you think about that?

### Balanced Response
The critique is fair that this is a small change, but even small UX friction compounds when you create dozens of plans. The plan exists to document the exact lines and logic involved so the implementer doesn't have to re-discover them. Regarding the "Untitled Plan" h1 fallback: the current "Ticket" text is a generic label that doesn't match the actual default title, so aligning them is a consistency fix, not scope creep. The flickering concern is a non-issue — the same behavior exists today with "Ticket" appearing while the input is empty; we're simply changing which fallback text appears. And the "deliberately named Untitled Plan" edge case is handled correctly: saving an empty input produces "Untitled Plan", so the round-trip is lossless.

## Proposed Changes

### File: `src/webview/review.html` [MODIFY]

#### Change 1 — Add placeholder to title input (line 464)
**Context:** The `<input>` element has no `placeholder` attribute, so when the value is set to empty, there's no visual hint for the user.
**Logic:** Add `placeholder="Untitled Plan"` so the browser renders greyed-out hint text when the input is empty.
**Implementation:**
```html
<!-- Before -->
<input id="header-title-input" class="title-input hidden" type="text" />

<!-- After -->
<input id="header-title-input" class="title-input hidden" type="text" placeholder="Untitled Plan" />
```
**Edge Cases Handled:** Placeholder text is not submitted as a value — `headerTitleInputEl.value` returns `""` when only the placeholder is showing, which is the desired behavior.

#### Change 2 — Leave input empty for default-titled plans (lines 869–870)
**Context:** `renderTicketData()` sets the input value to whatever `state.topic` is, including "Untitled Plan" for new drafts.
**Logic:** When the topic is "Untitled Plan" (case-insensitive match on the trimmed value), set the input value to `""` so the placeholder shows instead. Update the h1 display fallback from `'Ticket'` to `'Untitled Plan'` for consistency.
**Implementation:**
```javascript
// Before (lines 869-870)
headerTitleEl.textContent = state.topic || 'Ticket';
headerTitleInputEl.value = state.topic;

// After
const isDefaultTitle = (state.topic || '').trim().toLowerCase() === 'untitled plan';
headerTitleEl.textContent = state.topic && !isDefaultTitle ? state.topic : 'Untitled Plan';
headerTitleInputEl.value = isDefaultTitle ? '' : state.topic;
```
**Edge Cases Handled:** Existing plans with a real custom title are unaffected — only the literal default "Untitled Plan" triggers the placeholder behavior.

#### Change 3 — Default to "Untitled Plan" on save when input is empty (line 897)
**Context:** `savePlanText()` reads the input value with `.trim()` and sends it directly. If the user never typed anything, this sends an empty string.
**Logic:** Fall back to `'Untitled Plan'` when the trimmed value is empty, preserving the existing default-title behavior.
**Implementation:**
```javascript
// Before (line 897)
const nextTopic = headerTitleInputEl.value.trim();

// After
const nextTopic = headerTitleInputEl.value.trim() || 'Untitled Plan';
```
**Edge Cases Handled:** Whitespace-only input (e.g., spaces/tabs) is caught by `.trim()` and treated as empty, correctly falling back to "Untitled Plan".

#### Change 4 — Update real-time display fallback (line 956)
**Context:** The `input` event listener updates the h1 heading in real-time, falling back to `'Ticket'` when the input is empty.
**Logic:** Change the fallback to `'Untitled Plan'` to match the placeholder and the save-default.
**Implementation:**
```javascript
// Before (line 956)
headerTitleEl.textContent = headerTitleInputEl.value.trim() || 'Ticket';

// After
headerTitleEl.textContent = headerTitleInputEl.value.trim() || 'Untitled Plan';
```
**Edge Cases Handled:** Consistent fallback across initialization, real-time display, and save logic.

## Verification Plan

### Automated Tests
- No existing unit or integration tests cover the ticket view title input behavior (the view is a webview HTML file rendered inside VS Code). Adding automated tests for this would require a webview testing harness that does not currently exist in the project.

### Manual Tests
1. **New draft plan:** Create a new plan via the kanban. Open its ticket view. Verify the title input is empty with greyed-out "Untitled Plan" placeholder text. Verify the `<h1>` heading displays "Untitled Plan".
2. **Save without title:** With the input still empty, click Save. Verify the plan is saved with the title "Untitled Plan" and the file is named accordingly.
3. **Save with custom title:** Clear the input, type "My Feature". Verify the h1 updates in real-time to "My Feature". Click Save. Verify the plan is saved with "My Feature" as the title.
4. **Reopen custom-titled plan:** Close and reopen the ticket view for the "My Feature" plan. Verify the input shows "My Feature" as real text (not placeholder).
5. **Reopen default-titled plan:** Close and reopen the ticket view for an "Untitled Plan" plan. Verify the input is empty with placeholder text, not real "Untitled Plan" text.
6. **Whitespace-only title:** Enter only spaces in the title input and save. Verify it saves as "Untitled Plan".
7. **Keyboard save:** Enter a title and press Ctrl/Cmd+S. Verify the title is saved correctly.

## Recommendation
Proceed with implementation. This is a low-risk, high-frequency UX improvement. All four changes are in a single file (`src/webview/review.html`) and total roughly 5 modified lines. No backend changes are needed.
