# Move Claude Tab to Second Position (After Stitch)

## Goal

The Claude tab in `design.html` is currently the fourth tab (after Stitch, Briefs, and HTML Previews). It should be the second tab, immediately after Stitch. The current tab order is: STITCH → BRIEFS → HTML PREVIEWS → CLAUDE → IMAGES → DESIGN SYSTEM. The desired order is: STITCH → CLAUDE → BRIEFS → HTML PREVIEWS → IMAGES → DESIGN SYSTEM.

**Core problem & root cause:** The tab buttons in `design.html` are defined in a fixed order at L3626-3631. The Claude button was appended after HTML Previews when it was implemented, rather than being placed in the user's intended position. The `switchTab` function in `design.js` (~L136-183) is order-independent (it matches by `data-tab` attribute), so this is purely a DOM ordering issue.

## Metadata

- **Tags:** ui, ux
- **Complexity:** 1/10

## User Review Required

No. This is a trivial DOM reordering with no logic impact. The change is fully verified by visual inspection of the tab bar and clicking each tab.

## Complexity Audit

### Routine
- Reordering the `<button>` elements in the tab bar (`design.html` L3626-3631). This is a pure markup change with no logic impact.
- The `switchTab` function (`design.js` L136-183) matches by `data-tab` attribute, not by DOM index — confirmed by code reading.
- The CSS in `shared-tabs.css` uses flexbox with `gap: 2px` and zero `nth-child` or position-based selectors — reordering has no CSS impact.
- Tab content panels are matched by ID (`tabName + '-content'`), not by button position — confirmed at `design.js` L146-147.
- The `btn-goto-stitch-tab` handler (`design.js` L3736) uses `data-tab="stitch"` selector — position-independent.

### Complex / Risky
- None. The `switchTab` function is data-attribute-driven, not index-driven. No JS changes needed.

## Edge-Case & Dependency Audit

**Race Conditions:** None. Tab switching is synchronous DOM manipulation.

**Security:** None.

**Side Effects:**
- The default active tab is STITCH (`class="shared-tab-btn active" data-tab="stitch"`). Moving the Claude button does not change which tab is active on load. No impact.
- The initial tab restoration logic (`design.js` L2657-2665) reads the persisted `activeTab` value and calls `switchTab(restoredTab)` — this is data-attribute-driven and unaffected by button position.

**Dependencies & Conflicts:**
- No dependencies. No other code references tab button positions by index.

**Clarification (pre-existing bug, not introduced by this change):**
- The `validTabs` array at `design.js` L2659 is `['stitch', 'briefs', 'html-preview', 'images', 'design']` — it is missing `'claude'`. This means if a user is on the Claude tab, closes the design panel, and reopens it, the persisted `'claude'` value fails the `validTabs.includes()` check and the panel silently falls back to the STITCH default. This is a pre-existing bug unrelated to the reordering. It is noted here for awareness; fixing it is optional and out of scope for this plan unless the user explicitly requests it. If fixed, add `'claude'` to the `validTabs` array at `design.js` L2659.

## Dependencies

None. This plan has no dependencies on other plans or sessions.

## Adversarial Synthesis

Key risks: None for the reordering itself — all tab logic is data-attribute-driven and CSS is position-independent. The only finding is a pre-existing bug: the `validTabs` array at `design.js` L2659 omits `'claude'`, breaking tab persistence for the Claude tab on panel reload. Mitigations: The reordering is safe to proceed as-is; the `validTabs` bug is documented as a Clarification and can be fixed separately by adding `'claude'` to the array.

## Proposed Changes

### File 1 — `src/webview/design.html` (L3626-3631)

**Context:** The tab bar is a flexbox container (`#research-tab-bar`) with six `<button>` elements. The order of these buttons determines the visual left-to-right tab order. No JavaScript or CSS depends on button position.

**Logic:** Move the Claude button from position 4 to position 2 (immediately after STITCH).

**Implementation:**

**Before:**
```html
<button class="shared-tab-btn active" data-tab="stitch">STITCH</button>
<button class="shared-tab-btn" data-tab="briefs">BRIEFS</button>
<button class="shared-tab-btn" data-tab="html-preview">HTML PREVIEWS</button>
<button class="shared-tab-btn" data-tab="claude">CLAUDE</button>
<button class="shared-tab-btn" data-tab="images">IMAGES</button>
<button class="shared-tab-btn" data-tab="design">DESIGN SYSTEM</button>
```

**After:**
```html
<button class="shared-tab-btn active" data-tab="stitch">STITCH</button>
<button class="shared-tab-btn" data-tab="claude">CLAUDE</button>
<button class="shared-tab-btn" data-tab="briefs">BRIEFS</button>
<button class="shared-tab-btn" data-tab="html-preview">HTML PREVIEWS</button>
<button class="shared-tab-btn" data-tab="images">IMAGES</button>
<button class="shared-tab-btn" data-tab="design">DESIGN SYSTEM</button>
```

The Claude button moves from position 4 to position 2. No other changes required.

**Edge Cases:** None. The `active` class remains on the STITCH button. No other button has `active` class.

### File 2 (Optional, out of scope) — `src/webview/design.js` (L2659)

**Context:** Pre-existing bug — the `validTabs` array omits `'claude'`, preventing tab persistence restoration for the Claude tab.

**Implementation (only if user approves):**
```javascript
// Before:
const validTabs = ['stitch', 'briefs', 'html-preview', 'images', 'design'];

// After:
const validTabs = ['stitch', 'claude', 'briefs', 'html-preview', 'images', 'design'];
```

## Verification Plan

### Automated Tests

No automated tests required. This is a pure markup change with no logic impact. The test suite will be run separately by the user.

### Manual Verification

1. Open the design panel.
2. Verify the tab bar reads left-to-right: STITCH, CLAUDE, BRIEFS, HTML PREVIEWS, IMAGES, DESIGN SYSTEM.
3. Click each tab and verify the correct content panel shows (no cross-wiring).
4. Verify STITCH is still the default active tab on load.
5. (Optional, if `validTabs` fix applied) Switch to the Claude tab, close and reopen the design panel, and verify the Claude tab is restored as active.

## Recommendation

Complexity 1/10 → **Send to Intern**. This is a single-line DOM reordering with no logic impact.

## Implementation Status — Implemented 2026-06-25 (Epic Orchestrator)

**Done.** Part of the "Claude Tab: Independent Folder Management" epic.

- **Verification:** `node --check src/webview/design.js` → syntax OK.

### Acceptance Criteria
- [x] Tab order is `STITCH, CLAUDE, BRIEFS, HTML PREVIEWS, IMAGES, DESIGN SYSTEM` — reordered `<button>` elements in `design.html` (`#research-tab-bar`).
- [x] STITCH remains the default active tab — `active` class untouched on the STITCH button.
- [x] **`validTabs` persistence bug fixed** (was marked optional/out-of-scope in this plan) — added `'claude'` to the `validTabs` array in `design.js`. Applied because moving Claude to the prominent 2nd slot while leaving its tab unable to persist (silently snaps back to STITCH on reload) would undercut the change. **Deviation from literal plan scope — flagged for review.**

### Pending (requires running the VSIX — not done by orchestrator)
- [ ] Visual confirmation of left-to-right tab order and per-tab content wiring (Manual Verification steps 2–4).
- [ ] Claude-tab persistence across panel reopen (Manual Verification step 5).
