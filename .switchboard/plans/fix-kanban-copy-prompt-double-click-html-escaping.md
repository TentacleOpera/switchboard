# Fix Kanban Copy Prompt Double-Click Issue - HTML Escaping Root Cause

## Goal
Fix the kanban card "copy prompt" button requiring two clicks to move a card and copy to clipboard. The core problem is that dynamic plan/session IDs containing CSS metacharacters (`"`, `\`, etc.) are interpolated unescaped into `document.querySelector` selector strings, causing the DOM lookup to fail silently. `escapeAttr()` only performs HTML entity encoding for markup generation; it does not protect CSS selector syntax. When the browser parses the HTML, attributes are decoded to their raw values, and those raw values then break CSS selectors if they contain quotes, backslashes, or other CSS-special characters. The fix is to wrap all dynamic ID interpolations inside CSS selector strings with `CSS.escape()`.

## Metadata
**Complexity:** 3
**Tags:** bugfix, ui, frontend

## User Review Required
- [ ] Confirm the corrected root cause analysis (CSS selector escaping, not HTML entity mismatch)
- [ ] Verify the double-click symptom explanation is acceptable as a working hypothesis

## Complexity Audit

### Routine
- Single-file localized changes in `src/webview/kanban.html`
- Replaces raw string interpolation with `CSS.escape()` wrapper
- Adds defensive polyfill (already natively available in VS Code webviews)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** Copy button click posts `promptSelected` message and optimistically moves card via `moveCardsOptimistically`. If the selector fails, the card does not move but the backend message is still sent. Rapid double-clicking may send duplicate messages; extension host deduplication is outside this plan's scope.
- **Security:** Removing `escapeAttr()` was considered and rejected to maintain XSS protection. `CSS.escape()` does not affect HTML attribute escaping; it only affects CSS selector strings.
- **Side Effects:** Drag-and-drop handlers use the same card lookup selectors. Fixing them ensures consistency. No data migration needed.
- **Dependencies & Conflicts:** None. No other files reference these selectors.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) Earlier drafts incorrectly cited HTML entity mismatch rather than CSS selector syntax escaping — corrected above. (2) The `CSS.escape` polyfill is a naive regex and non-spec-compliant, but it is defensive dead code since native support is guaranteed in VS Code webviews. (3) The double-click symptom mechanism remains a working hypothesis rather than a proven chain of causation. Mitigations: Accurate documentation, minimal scope, standard API usage.

## Proposed Changes

### File: `src/webview/kanban.html`

#### 1. Add CSS.escape polyfill (line 2773)
**Context:** VS Code webviews run on Chromium with native `CSS.escape` support, but a defensive polyfill guards against edge-case environments.

**Logic:** If `window.CSS.escape` is missing, provide a minimal fallback.

**Implementation:**
```javascript
// CSS.escape polyfill for handling special characters in DOM lookups
if (!window.CSS) {
    window.CSS = {};
}
if (!window.CSS.escape) {
    window.CSS.escape = function(value) {
        return String(value).replace(/([^\w-])/g, '\\$1');
    };
}
```
**Status:** ✅ Applied

**Edge Cases:** Polyfill does not match full CSS.escape spec (leading digits, empty strings). Not exercised in practice.

#### 2. Update `moveCardsOptimistically` card lookup (line 3840)
**Context:** Optimistic card movement fails silently when the selector breaks on special characters.

**Logic:** Wrap `id` with `CSS.escape` in both `data-plan-id` and `data-session` selectors.

**Implementation:**
```javascript
sessionIds.forEach(id => {
    const cardEl = document.querySelector(`.kanban-card[data-plan-id="${CSS.escape(id)}"]`) || document.querySelector(`.kanban-card[data-session="${CSS.escape(id)}"]`);
    if (!cardEl) return;
    // ...
});
```
**Status:** ✅ Applied

**Edge Cases:** If `id` is empty string, `CSS.escape('')` returns `''`; the selector will not match anything, which is correct.

#### 3. Update drag start handler (line 5144)
**Context:** Adds `dragging` class to cards being transferred.

**Implementation:**
```javascript
idsToTransfer.forEach(id => {
    const el = document.querySelector(`.kanban-card[data-plan-id="${CSS.escape(id)}"]`) || document.querySelector(`.kanban-card[data-session="${CSS.escape(id)}"]`);
    if (el) el.classList.add('dragging');
});
```
**Status:** ✅ Applied

#### 4. Update `CODED_AUTO` drop handler (line 5256)
**Context:** DOM optimistic update during coded column drop.

**Implementation:**
```javascript
const cardEl = document.querySelector(`.kanban-card[data-plan-id="${CSS.escape(id)}"]`) || document.querySelector(`.kanban-card[data-session="${CSS.escape(id)}"]`);
```
**Status:** ✅ Applied

#### 5. Update `COMPLETED` drop handler (line 5359)
**Context:** Moving cards to completed column.

**Implementation:**
```javascript
const cardEl = document.querySelector(`.kanban-card[data-plan-id="${CSS.escape(id)}"]`) || document.querySelector(`.kanban-card[data-session="${CSS.escape(id)}"]`);
```
**Status:** ✅ Applied

#### 6. Update general drop handler (line 5434)
**Context:** Moving cards to any target column.

**Implementation:**
```javascript
const cardEl = document.querySelector(`.kanban-card[data-plan-id="${CSS.escape(id)}"]`) || document.querySelector(`.kanban-card[data-session="${CSS.escape(id)}"]`);
```
**Status:** ✅ Applied

#### 7. Update `copyPlanLinkResult` button lookup (lines 5862, 5865)
**Context:** Updates the copy button to "Copied!" state after backend responds.

**Implementation:**
```javascript
if (msg.planId) {
    btn = document.querySelector(`.card-btn.copy[data-plan-id="${CSS.escape(msg.planId)}"]`);
}
if (!btn && msg.sessionId) {
    btn = document.querySelector(`.card-btn.copy[data-plan-id="${CSS.escape(msg.sessionId)}"]`) || document.querySelector(`.card-btn.copy[data-session="${CSS.escape(msg.sessionId)}"]`);
}
```
**Status:** ✅ Applied

## Verification Plan

### Automated Tests
- No automated unit/integration tests for webview DOM selector behavior exist in this codebase.
- **Session directive:** Compilation and automated test execution skipped per user request. Test suite will be run separately.

### Manual Verification
1. Create or identify card IDs containing CSS metacharacters: `"`, `\`, `>`, spaces
2. Click "Copy Prompt" button once — verify card moves to next column immediately
3. Verify button text changes to "Copied!" and shows green flash animation
4. Drag-and-drop the same card — verify it moves correctly
5. Test card operations: Review, Complete, Recover — verify selectors still resolve
6. Test with a normal alphanumeric ID to ensure no regression

## Files Changed
- `src/webview/kanban.html`

## Risks
- **Low risk**: CSS.escape is a standard web API with broad browser support
- **Backward compatible**: This only affects lookups that were already failing for special characters
- **No data migration needed**: This is purely a frontend DOM lookup fix

## Alternative Considered
Remove HTML escaping from `data-plan-id` attributes entirely. However, this could introduce XSS vulnerabilities if plan IDs ever contain user-controlled content. The CSS.escape approach is safer and more robust.

---

**Recommendation:** Send to Intern
