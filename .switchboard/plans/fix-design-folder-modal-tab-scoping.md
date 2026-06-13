# Fix Design Panel Folder Modal Tab Scoping

## Goal
Fix the folder management modal in design.html so it appears correctly when opened from any tab, not just the Stitch tab.

The modal (`id="folder-modal"`) is currently nested inside the `#stitch-content` div (lines 3817-3839). Because `#stitch-content` is a tab container hidden via `display: none` when inactive (`.research-tab-content` CSS at line 164-168), any child element — even one with `position: fixed` — becomes invisible when the Stitch tab is not active. The JavaScript scoping logic (`folderModalScope` in `design.js` lines 3039-3048) already correctly sets the modal title and folder list per tab, but users cannot see the modal when triggered from non-Stitch tabs. In `planning.html`, the folder modal is correctly positioned at the document root, outside all tab content divs (line 3253), which is the pattern this fix follows.

## Metadata
**Tags:** ui, bugfix, frontend
**Complexity:** 2

## User Review Required
**No.** This is a pure bug fix with no product scope or UX behavior changes. The modal content and scoping logic remain identical; only DOM placement changes.

## Complexity Audit

### Routine
- Single-file HTML change: cut-and-paste one `<div>` block
- No JavaScript logic modifications required
- No new patterns introduced; follows existing `planning.html` precedent
- `position: fixed` with `z-index: 1000` ensures modal overlays viewport regardless of new parent

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. This is a static DOM structure change with no asynchronous behavior.
- **Security:** No new attack surface. Modal markup and event handlers remain unchanged.
- **Side Effects:** The modal will now be visible from all five tabs (Briefs, Design, HTML Previews, Images, Stitch). This is the intended and expected behavior. The `.container` div (line 116-119) does not define `overflow: hidden`, `transform`, or `filter`, so it does not create a new containing block for `position: fixed`.
- **Dependencies & Conflicts:** The `stitch-prompt-modal` at line 3842 is similarly nested inside `#stitch-content` and suffers from the same visibility issue, but it is explicitly out of scope for this plan. No other dependencies.

## Dependencies
None. Self-contained single-file change.

## Adversarial Synthesis
Key risks: (1) The `stitch-prompt-modal` at line 3842 shares the same nesting bug and will remain broken, creating inconsistent UX. (2) If future CSS changes add `transform` or `filter` to `.container`, the modal's `position: fixed` could become relative to the container instead of the viewport. Mitigations: (1) Document the sibling modal issue in code comments or a follow-up ticket. (2) Keep the modal outside `.container` entirely (after line 3858) to immunize against future CSS changes — this matches `planning.html` exactly.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.html`

- **Context:** The `folder-modal` div (lines 3817-3839) is nested inside `#stitch-content` (line 3685-3857), which is a tab content pane that CSS hides when inactive. All other tabs have "Manage Folders" buttons wired to `openFoldersModal(scope)` in `design.js`, but the modal only renders when the Stitch tab is active because of the `display: none` ancestry.
- **Logic:** Move the modal to be a sibling of the tab content panes, outside `#stitch-content` but inside `.container`. This places it in the same structural position as `planning.html` (line 3253), ensuring it is never inside a hidden tab container. The modal's `position: fixed` and `z-index: 1000` will then overlay the viewport correctly from any tab.
- **Implementation:**
  1. Cut lines 3817-3839 (the entire `folder-modal` div including its comment).
  2. Paste after line 3857 (the closing `</div>` of `#stitch-content`) but before line 3858 (the closing `</div>` of `.container`).
  3. Preserve exact indentation: the modal should be at 8-space indent (same level as the tab content divs inside `.container`).
  4. The final structure around lines 3855-3862 should read:
     ```html
             </div>
         </div>

         <!-- Folder Management Modal (Copied from planning panel) -->
         <div class="folder-modal" id="folder-modal" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="folder-modal-title">
             <div class="modal-content">
                 ...
             </div>
         </div>
     </div>
     ```
- **Edge Cases:**
  - **Clarification:** The modal title and folder list content are already dynamically scoped by `openFoldersModal()` in `design.js`; this fix only addresses visibility. No JS changes needed.
  - **Note:** The `stitch-prompt-modal` (lines 3841-3856) remains inside `#stitch-content` and will continue to be invisible from other tabs. A separate fix is required for that modal.

## Verification Plan

### Automated Tests
Skipped per session directive.

### Manual Verification
1. Open the Design panel in VS Code.
2. Switch to the **Briefs** tab and click "Manage Folders" → modal appears immediately with title "Manage Briefs Folders".
3. Close the modal, switch to **HTML Previews** tab, click "Manage Folders" → modal appears with title "Manage HTML Previews Folders".
4. Repeat for **Images**, **Design System**, and **Stitch** tabs.
5. Confirm the folder list inside the modal updates correctly per tab scope (e.g., different paths shown for Design vs HTML Previews).
6. Confirm the modal can be dismissed via the X button, clicking the backdrop, and pressing Escape.

---

**Recommendation:** Send to Intern
