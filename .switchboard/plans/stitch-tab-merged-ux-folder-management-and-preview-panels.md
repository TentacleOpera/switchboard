# Stitch Tab UX Improvements, Consistent Folder Management, and Preview Panel Refactor

## Metadata
**Tags:** ui, ux, refactor, feature
**Complexity:** 8

## Goal
Fix confusing UX in the Stitch tab, implement consistent folder management across all design panel tabs, and refactor the screen preview overlays into non-distracting static header and footer panels with a consolidated variants dropdown.

## Problem Analysis

### Stitch Tab UX Issues
1. **Misleading workspace picker**: The workspace picker suggests it filters Stitch projects by workspace, but Stitch projects are account-wide. The picker only controls sync destination, not project visibility.
2. **Redundant sync button**: The "Sync Project to Workspace" button downloads all screens and creates DESIGN.md, but individual screen downloads already exist via "DL HTML" and "DL PNG" buttons on each screen card.
3. **DESIGN.md generation friction**: The "Open DESIGN.md" button only works if the file exists from a prior sync. It should generate DESIGN.md on-demand from the current project's screens.
4. **No palette-only download**: Users cannot download just the color palette/design tokens without running the full sync operation. The palette is only accessible via DESIGN.md which requires sync.
5. **No folder management**: Stitch downloads go to a hardcoded `.stitch/` folder (configurable via `stitch.defaultOutputFolder` setting), but there's no UI to change this. Other tabs have "Manage Folders" buttons but Stitch doesn't.
6. **Unclear prompt generator button**: The "Prompt Generator" button opens a modal for describing images to Stitch, but the button text and tooltip don't explain this purpose. Users don't understand it's a bridge for image-to-prompt conversion.
7. **Confusing dual prompt inputs**: There are two different prompt inputs with unclear purposes:
   - Top input (`stitch-prompt-input`): Used with "Generate Screen" to create new screens from scratch
   - Bottom input (`preview-refine-input`): Used with "Apply Edit" and "+3 Variants" to modify existing screens in preview mode
   - The bottom input has additional controls (creative range, aspect checkboxes) that aren't explained
   - Users don't understand the difference between the two inputs or when to use each

### Preview Overlay Issues
- **Overlay Layout**: The `.preview-top-overlay` and `.preview-bottom-overlay` divs are positioned absolutely (`position: absolute`) within the preview image container, causing them to draw on top of whatever is rendered beneath them.
- **Obstructed Details**: Important elements at the top (close buttons, title, download actions) and bottom (refinement input, aspects controls, apply actions) overlap the top and bottom of the previewed screen.
- **Wasted Space / Confusing UX**: The aspect chips (Layout, Color, Images, Font, Text) occupy an entire dedicated row in the footer, which is unnecessary and confusing since they are only used for generating variants (`+3 Variants`) and do not affect general edit refinements.

### Folder Management Inconsistency
- **HTML Preview tab**: Currently has no "Manage Folders" button in controls strip (only referenced in empty state text)
- **Design System tab**: Currently has no "Manage Folders" button in controls strip
- **Images tab**: Currently has no "Manage Folders" button in controls strip (only referenced in empty state text)
- **Stitch tab**: No folder management at all - uses hardcoded output directory
- **Planning tab**: Has folder management via folder modal (this is the reference implementation)

### Current Download Destinations
- **Stitch downloads**: `.stitch/` folder (configurable via `stitch.defaultOutputFolder` setting, no UI)
- **HTML/Design/Images**: Configured via LocalFolderService with folder modal in planning tab
- **No user control**: Users cannot specify per-download destinations

## User Review Required
- Confirm removing the workspace picker is acceptable for multi-root workflows (picker currently drives `state.stitchWorkspaceRoot` for all Stitch operations). **Recommendation**: relabel as "Sync Destination" rather than remove entirely.
- Confirm "Sync Project to Workspace" bulk download is safe to remove (individual DL HTML/DL PNG already exist per screen).
- Confirm per-download destination dropdown UX is desired or if default-folder-only is sufficient for first pass.

## Open Questions
None.

## Complexity Audit

### Routine
- Relabel "Prompt Generator" → "Image to Prompt" and update modal title.
- Add "Manage Folders" buttons to Design System, HTML Preview, Images, and Stitch tab control strips.
- Copy folder modal markup/CSS/JS from planning panel into design panel.
- Add palette download button and `stitchDownloadPalette` message handler.
- Update `stitchOpenManifest` handler to generate DESIGN.md on-demand when file does not exist.
- Change `.preview-top-overlay` / `.preview-bottom-overlay` CSS from absolute-positioned gradients to static solid bars with borders.
- Restructure `#stitch-preview-pane` HTML: move overlays out of `.preview-image-container` to flex siblings.
- Create `.split-button-container` wrapper around `+3 Variants` button with dropdown trigger `[ ▾ ]`.
- Move aspect checkboxes into `#stitch-variants-dropdown-menu` absolute dropdown.
- Add dropdown toggle and outside-click-close listeners in `design.js`.

### Complex / Risky
- Workspace root fallback: removing workspace picker requires wiring active-workspace fallback so multi-root users don't get a dead tab.
- LocalFolderPathsConfig schema expansion: add `imagesFolderPaths`, `stitchFolderPaths`, `_migratedImages`, `_migratedStitch` fields; implement getters/setters in `LocalFolderService` mirroring existing `designFolderPaths` pattern.
- Twelve new message handlers in `DesignPanelProvider.ts` for folder management (get/add/remove for design/html/images/stitch), which currently has zero folder management code.
- Per-download destination selection requires changing `stitchDownloadAsset` message payload, path validation, and handler updates across HTML/PNG/palette downloads.
- Mode-switched control strips risk breaking `setStitchBusy` if generation-strip buttons go null when hidden; must toggle visibility via CSS wrapper classes, not DOM removal.
- `openStitchPreview` recreates `previewBtnVariants` via `cloneNode(true)` on every preview open; wrapping it in a new container breaks the freshly-attached dropdown toggle listener. Must switch to event delegation or a stable trigger element.
- Aspects checkboxes move from `#stitch-aspects-checkboxes` into dropdown; `stitchAspectsCheckboxesContainer` query selector in `design.js` and the checkbox collection loop in the variants handler must be updated to the new container ID.
- Flex layout geometry: header/footer heights must be accounted for so `.preview-image-container` doesn't collapse on small screens or push the image off-center.
- `#stitch-preview-pane.loading` CSS currently hides `.preview-bottom-overlay`; must retarget `.preview-footer` without breaking loading state visibility.

## Edge-Case & Dependency Audit
- **Race Conditions:** `stitchOpenManifest` on-demand generation races with project screen refresh; ensure screens data is fresh before building manifest. Folder add/remove operations must invalidate cache in `LocalFolderService._folderPathsCache`.
- **Security:** Per-download destination paths must be validated against workspace roots to prevent path traversal; reuse existing `switchboardLocationGuard` pattern.
- **Side Effects:** Removing `stitchSyncProject` handler may orphan in-progress sync operations. Extending `LocalFolderPathsConfig` requires migration flags to avoid wiping existing user configuration. `cloneNode(true)` on `previewBtnVariants` clones the old button including any stale listeners; replacing with event delegation avoids listener accumulation.
- **Dependencies & Conflicts:** `LocalFolderService` schema change is consumed by both `DesignPanelProvider.ts` and `PlanningPanelProvider.ts`; ensure both providers read the new fields correctly. No `imagesFolderPaths` or `stitchFolderPaths` getters exist yet — these must be added. Preview panel refactor and folder management both touch `design.html` and `design.js`, but in different DOM regions; no line-level merge conflicts expected.

## Dependencies
- `sess_20250612_001` — Workspace root detection and fallback logic for Stitch tab when workspace picker removed.
- `sess_20250612_002` — `LocalFolderService` schema expansion and migration flags (`imagesFolderPaths`, `stitchFolderPaths`).
- `sess_20250612_003` — `DesignPanelProvider.ts` folder management message handlers (port from `PlanningPanelProvider.ts` pattern).
- `sess_20250612_004` — Split-button dropdown component and outside-click dismissal behavior.

## Adversarial Synthesis
Key risks: workspace root removal breaks multi-root project selection; on-demand DESIGN.md generation may re-implement bulk sync logic without the downloads; `LocalFolderPathsConfig` schema expansion touches shared config file format; `cloneNode` listener loss on the variants button after DOM restructure; aspect checkbox selector drift when moved into dropdown; flex layout collapsing if header/footer lack explicit min-heights.

Mitigations: keep workspace picker relabeled as "Sync Destination" rather than removing entirely; generate DESIGN.md from cached screen metadata if available; add `_migratedImages`/`_migratedStitch` flags to preserve existing config; use event delegation on `.split-button-container` for dropdown toggle; update JS queries to `#stitch-variants-dropdown-menu`; enforce `min-height` on header/footer bars; toggle control strip visibility via CSS wrapper classes (`display: none` / `display: flex`) rather than removing elements from the DOM.

## Requirements

### Stitch Tab UX Improvements
1. **Remove or relabel workspace picker**: Either remove it entirely (since projects aren't workspace-scoped) or relabel it "Sync Destination" and move it to a less prominent position.
2. **Remove sync button**: Remove the bulk "Sync Project to Workspace" button since individual downloads exist.
3. **On-demand DESIGN.md generation**: "Open DESIGN.md" button should generate the file on-demand if it doesn't exist, using the current project's screens and design systems.
4. **Add palette download button**: Add "Download Design Tokens" button to fetch just the color palette/tokens without downloading screens.
5. **Clarify prompt generator button**: Relabel "Prompt Generator" to "Image to Prompt" or "Describe from Image" and add tooltip explaining it converts uploaded images to Stitch prompts.
6. **Clarify dual prompt inputs**:
   - Replace top controls strip with bottom editing controls when preview mode is active
   - Show mode-specific context text explaining the active input
   - Dim or disable the inactive input to avoid confusion

### Consistent Folder Management
1. **Add "Manage Folders" buttons**: Add to Design System, HTML Preview, Images, and Stitch tab control strips.
2. **Per-download destination selection**: Allow users to specify which configured folder to use for each download action.
3. **Per-workspace folder configuration**: Each workspace should have its own independent set of configured folders for each tab type.
4. **Migrate existing settings**: Move `stitch.defaultOutputFolder` setting to per-workspace folder configuration with migration.

### Preview Panel Refactor
1. **Remove overlays from image container**: Pull `.preview-top-overlay` and `.preview-bottom-overlay` out of `.preview-image-container` so the image renders unobstructed.
2. **Create static header and footer bars**: Rename overlays to `.preview-header` and `.preview-footer`, place them as flex siblings to `.preview-image-container` inside `#stitch-preview-pane`.
3. **Consolidate footer controls into single toolbar row**: Move refinement input, "Apply Edit", and "+3 Variants" into one compact footer row.
4. **Move aspects into split-button dropdown**: Place Layout, Color, Images, Font, Text checkboxes into an absolute dropdown anchored to the `[ ▾ ]` trigger next to `+3 Variants`.

## Implementation Plan

### Phase 1: Foundation (Day 1)
1. **Workspace picker relabeling**
   - Change label from "Workspace" to "Sync Destination" or similar
   - Move to less prominent position in control strip
   - Update any related tooltips or help text

2. **Remove sync button**
   - Remove `btn-sync-stitch-project` from HTML
   - Remove sync event handler from design.js
   - Remove `stitchSyncProject` message handler from DesignPanelProvider.ts
   - Update any state management related to sync

3. **DESIGN.md on-demand generation**
   - Modify `stitchOpenManifest` handler to check if DESIGN.md exists
   - If not exists, trigger generation from current project screens and design systems
   - Write DESIGN.md to output directory
   - Open the generated file
   - Ensure generation doesn't duplicate the full screen download logic used by sync

4. **LocalFolderPathsConfig schema expansion**
   - Add `imagesFolderPaths` and `stitchFolderPaths` fields to the config type
   - Add `_migratedImages` and `_migratedStitch` flags for migration
   - Implement getters/setters in `LocalFolderService` mirroring existing `designFolderPaths` pattern
   - Add migration logic from existing `stitch.defaultOutputFolder` setting

5. **Add folder management message handlers to DesignPanelProvider.ts**
   - Port the pattern from `PlanningPanelProvider.ts`:
     - `getDesignFolderPaths` / `addDesignFolderPath` / `removeDesignFolderPath`
     - `getHtmlFolderPaths` / `addHtmlFolderPath` / `removeHtmlFolderPath`
     - `getImagesFolderPaths` / `addImagesFolderPath` / `removeImagesFolderPath`
     - `getStitchFolderPaths` / `addStitchFolderPath` / `removeStitchFolderPath`
   - Ensure handlers are workspace-scoped using `getWorkspaceRoot()` / `getLocalFolderService()`

6. **Add "Manage Folders" buttons to all tab control strips**
   - Design System tab: add button, wire to open folder modal scoped to "design"
   - HTML Preview tab: add button, wire to open folder modal scoped to "html"
   - Images tab: add button, wire to open folder modal scoped to "images"
   - Stitch tab: add button, wire to open folder modal scoped to "stitch"

7. **Copy folder modal from planning panel**
   - Copy modal HTML markup from `planning.html` into `design.html`
   - Copy modal CSS styles from `planning.html` into `design.html`
   - Copy modal JS logic from `planning.js` into `design.js`
   - Adapt message types to match new handlers in `DesignPanelProvider.ts`
   - Ensure modal supports scope switching (design / html / images / stitch)

### Phase 2: UX Enhancements (Day 2)
8. **Palette download button**
   - Add "Download Design Tokens" button to Stitch tab controls
   - Implement `stitchDownloadPalette` handler in DesignPanelProvider.ts
   - Extract palette from design systems (reuse existing logic from sync handler)
   - Save as JSON file to configured output directory

9. **Prompt generator clarity**
   - Change button text from "Prompt Generator" to "Image to Prompt"
   - Update tooltip to explain the image-to-prompt conversion workflow
   - Update modal title and description text

10. **Dual prompt inputs clarity**
    - When preview mode is active:
      - Show bottom editing controls (refinement input, apply edit, variants)
      - Hide or dim top generation controls (prompt input, generate button)
      - Show context text explaining the active input
    - When gallery mode is active:
      - Show top generation controls
      - Hide bottom editing controls

### Phase 3: Preview Panel Refactor (Day 2-3)
11. **Remove overlays from image container**
    - In `design.html`, pull `.preview-top-overlay` and `.preview-bottom-overlay` out of `.preview-image-container`
    - Rename classes to `.preview-header` and `.preview-footer`
    - Place them as flex siblings to `.preview-image-container` inside `#stitch-preview-pane`

12. **Create static header and footer bars**
    - Change CSS from absolute-positioned gradient overlays to static solid bars
    - Add borders/separators to distinguish from image
    - Ensure header contains: screen title, download buttons, close button
    - Ensure footer contains: refinement input, "Apply Edit", and split-button "+3 Variants" with dropdown trigger `[ ▾ ]`

13. **Consolidate footer controls into single toolbar row**
    - Move all footer actions into one compact row
    - Remove the dedicated aspects checkbox row from the footer

14. **Move aspects into split-button dropdown**
    - Wrap `+3 Variants` button and `[ ▾ ]` trigger in `.split-button-container`
    - Create `#stitch-variants-dropdown-menu` absolute dropdown containing Layout, Color, Images, Font, Text checkboxes
    - Update `design.js`:
      - Add dropdown toggle click listener (use event delegation on `.split-button-container` to survive `cloneNode`)
      - Add document-wide click listener for outside-click dismissal
      - Update aspect checkbox query selector to `#stitch-variants-dropdown-menu`
    - Ensure `openStitchPreview` does not break the dropdown listener (avoid `cloneNode` on the trigger; clone only the button label if needed, or use stable wrapper)

### Phase 4: Polish and Testing (Day 3)
15. **Per-download destination selection**
    - Add folder dropdown to download actions (HTML, PNG, palette)
    - Allow users to select from configured folders or use default
    - Update download handlers to accept destination parameter

16. **Multi-workspace folder configuration**
    - Ensure folder configuration is stored per-workspace
    - Verify folder isolation between workspaces

17. **Migration and backward compatibility**
    - Migrate `stitch.defaultOutputFolder` to new folder configuration
    - Ensure existing users don't lose their settings
    - Add deprecation notice for old setting

18. **Testing**
    - Test all changes together to ensure no regressions
    - Verify preview panel refactor doesn't break mode switching
    - Verify folder management works across all tabs
    - Verify on-demand DESIGN.md generation works correctly

## Risks
- **Breaking change**: Removing sync button may break workflows that depend on bulk sync
- **Configuration migration**: Users with existing `stitch.defaultOutputFolder` setting need migration to new folder management system
- **Performance**: On-demand DESIGN.md generation may be slow for large projects
- **Complexity**: Adding folder management to multiple tabs increases code complexity
- **UI regression**: Preview panel refactor may introduce layout issues on small screens or unusual aspect ratios
- **Event listener loss**: Dropdown toggle may stop working after preview open/close cycles if `cloneNode` isn't handled correctly

## Verification Plan

### Automated Tests
- Stitch tab renders with relabeled workspace picker (or without, if removed); project selection still functional.
- On-demand DESIGN.md generation produces valid markdown with screens index and design tokens when file does not exist; opens existing file when present.
- Palette download handler extracts design tokens from `listDesignSystems()` and writes `design-tokens.json` to configured output directory.
- Folder management message handlers (get/add/remove for design/html/images/stitch) return updated path lists and persist to `local-folder-config.json`.
- Per-download destination payload overrides default folder; falls back to default when omitted.
- Mode-switched control strips: generation strip visible in gallery mode, editing strip visible in preview mode; `setStitchBusy` disables buttons in both strips without null reference errors.
- Migration: existing `stitch.defaultOutputFolder` setting copied to `stitchFolderPaths` with `_migratedStitch: true` flag.
- `#stitch-preview-pane` renders with `.preview-header`, `.preview-image-container`, and `.preview-footer` as flex-column siblings; no absolute positioning remains on header/footer.
- `.preview-image-container` remains unobstructed; image is perfectly centered between header and footer bars at multiple viewport sizes.
- `#stitch-preview-pane.loading` hides `.preview-footer` while preserving loading state visibility.
- Split-button dropdown opens on `[ ▾ ]` click and closes on outside click or Escape key.
- Aspects checkboxes inside dropdown reflect default checked state; selection persists across preview open/close cycles.
- `+3 Variants` click correctly reads selected aspects from dropdown and includes them in the `stitchVariants` message payload.

### Manual Tests
- Test Stitch tab with relabeled workspace picker (ensure project selection still works)
- Test on-demand DESIGN.md generation (with and without existing file)
- Test palette download (verify JSON format and content)
- Test folder management in Design System tab (add/remove folders)
- Test folder management in HTML Preview tab (add/remove folders)
- Test folder management in Images tab (add/remove folders)
- Test folder management in Stitch tab (add/remove folders)
- Test per-download destination selection (verify files go to correct location)
- Test multi-workspace scenarios (ensure folder isolation)
- Test migration from old `stitch.defaultOutputFolder` setting
- Test prompt generator button clarity (verify users understand image-to-prompt workflow)
- Test dual prompt inputs clarity (verify users understand new vs edit workflows)
- Open the **STITCH** tab in the design panel, select or generate a screen, verify:
  - The header (containing screen title, download buttons, and close button) is rendered on a solid dark background at the top of the panel and does not overlap the image.
  - The footer controls are consolidated on a single solid row at the bottom of the panel and do not overlap the image.
  - The image is perfectly centered between the header and footer bars.
  - Clicking the `[ ▾ ]` arrow next to `+3 Variants` displays the dropdown menu containing checkboxes for Layout, Color, Images, Font, and Text.
  - Clicking outside the dropdown closes it.
  - Changing the selection in the dropdown and clicking `+3 Variants` correctly generates variants based on the selected aspects.

## Files to Change
- `src/webview/design.html` - Remove/relabeled workspace picker, remove sync button, add palette button, add folder management button, add folder modal, restructure preview pane to static header/footer, add split-button dropdown
- `src/webview/design.js` - Remove sync logic, add palette download logic, add folder management logic, update DESIGN.md button behavior, add mode switching logic, add dropdown toggle/outside-click listeners, update aspect checkbox queries
- `src/services/DesignPanelProvider.ts` - Remove sync handler, add palette handler, add folder management handlers, update DESIGN.md handler
- `src/services/LocalFolderService.ts` - Extend with images/stitch folder paths and migration flags
- `package.json` - No changes needed (unless deprecating `stitch.defaultOutputFolder` setting)

## Success Criteria
- Stitch tab has no misleading workspace picker
- Users can download palette without bulk sync
- DESIGN.md generates on-demand without prior sync
- All tabs have consistent folder management UI
- Users can specify download destinations per-action
- Per-workspace folder configuration works correctly
- No breaking changes for existing users (migration path provided)
- Preview panel image is completely unobstructed by header and footer bars
- Footer controls are consolidated into a single compact toolbar row
- Aspects checkboxes are accessible via the split-button dropdown and correctly affect variant generation

## Recommendation
**Send to Lead Coder** — Complexity 8 with multi-file coordination, shared config schema changes, new message handlers across `DesignPanelProvider.ts` and `LocalFolderService.ts`, and UI layout refactor with event delegation requirements.
