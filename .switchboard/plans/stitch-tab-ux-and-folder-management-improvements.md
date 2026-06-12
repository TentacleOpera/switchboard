# Stitch Tab UX Improvements and Consistent Folder Management

## Metadata
**Tags:** ui, ux, refactor, feature
**Complexity:** 7

## Goal
Fix confusing UX in the Stitch tab and implement consistent folder management across all design panel tabs.

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
- Confirm removing the workspace picker is acceptable for multi-root workflows (picker currently drives `state.stitchWorkspaceRoot` for all Stitch operations).
- Confirm "Sync Project to Workspace" bulk download is safe to remove (individual DL HTML/DL PNG already exist per screen).
- Confirm per-download destination dropdown UX is desired or if default-folder-only is sufficient for first pass.

## Complexity Audit

### Routine
- Relabel "Prompt Generator" → "Image to Prompt" and update modal title.
- Add "Manage Folders" buttons to Design System, HTML Preview, Images, and Stitch tab control strips.
- Copy folder modal markup/CSS/JS from planning panel into design panel.
- Add palette download button and `stitchDownloadPalette` message handler.
- Update `stitchOpenManifest` handler to generate DESIGN.md on-demand when file does not exist.

### Complex / Risky
- Workspace root fallback: removing workspace picker requires wiring active-workspace fallback so multi-root users don't get a dead tab.
- LocalFolderPathsConfig schema expansion: add `imagesFolderPaths`, `stitchFolderPaths`, `_migratedImages`, `_migratedStitch` fields; implement getters/setters in `LocalFolderService` mirroring existing `designFolderPaths` pattern.
- Twelve new message handlers in `DesignPanelProvider.ts` for folder management (get/add/remove for design/html/images/stitch), which currently has zero folder management code.
- Per-download destination selection requires changing `stitchDownloadAsset` message payload, path validation, and handler updates across HTML/PNG/palette downloads.
- Mode-switched control strips risk breaking `setStitchBusy` if generation-strip buttons go null when hidden; must toggle visibility via CSS wrapper classes, not DOM removal.

## Edge-Case & Dependency Audit
- **Race Conditions:** `stitchOpenManifest` on-demand generation races with project screen refresh; ensure screens data is fresh before building manifest. Folder add/remove operations must invalidate cache in `LocalFolderService._folderPathsCache`.
- **Security:** Per-download destination paths must be validated against workspace roots to prevent path traversal; reuse existing `switchboardLocationGuard` pattern.
- **Side Effects:** Removing `stitchSyncProject` handler may orphan in-progress sync operations. Extending `LocalFolderPathsConfig` requires migration flags to avoid wiping existing user configuration.
- **Dependencies & Conflicts:** `LocalFolderService` schema change is consumed by both `DesignPanelProvider.ts` and `PlanningPanelProvider.ts`; ensure both providers read the new fields correctly. No `imagesFolderPaths` or `stitchFolderPaths` getters exist yet — these must be added.

## Dependencies
- `sess_20250612_001` — Workspace root detection and fallback logic for Stitch tab when workspace picker removed.
- `sess_20250612_002` — `LocalFolderService` schema expansion and migration flags (`imagesFolderPaths`, `stitchFolderPaths`).
- `sess_20250612_003` — `DesignPanelProvider.ts` folder management message handlers (port from `PlanningPanelProvider.ts` pattern).

## Adversarial Synthesis
Key risks: workspace root removal breaks multi-root project selection; on-demand DESIGN.md generation may re-implement bulk sync logic without the downloads; `LocalFolderPathsConfig` schema expansion touches shared config file format. Mitigations: keep workspace picker relabeled as "Sync Destination" rather than removing entirely; generate DESIGN.md from cached screen metadata if available; add `_migratedImages`/`_migratedStitch` flags to preserve existing config.

## Requirements

### Stitch Tab UX Improvements
1. **Remove or relabel workspace picker**: Either remove it entirely (since projects aren't workspace-scoped) or relabel it "Sync Destination" and move it to a less prominent position.
2. **Remove sync button**: Remove the bulk "Sync Project to Workspace" button since individual downloads exist.
3. **On-demand DESIGN.md generation**: "Open DESIGN.md" button should generate the file on-demand if it doesn't exist, using the current project's screens and design systems.
4. **Add palette download button**: Add "Download Design Tokens" button to fetch just the color palette/tokens without downloading screens.
5. **Clarify prompt generator button**: Relabel "Prompt Generator" to "Image to Prompt" or "Describe from Image" and add tooltip explaining it converts uploaded images to Stitch prompts.
6. **Clarify dual prompt inputs**: 
   - Replace top controls strip with bottom editing controls when preview mode is active
   - In gallery mode: Show top controls (new screen generation with model/device selectors, prompt input, "Generate Screen" button)
   - In preview mode: Show bottom controls (screen editing with model selector, prompt input, creative range, aspect checkboxes, "Apply Edit"/"+3 Variants" buttons)
   - This eliminates confusion by showing only relevant controls for current workflow
   - Keep model selector visible in both modes (shared state)
   - Move device selector to be shared between both workflows

### Folder Management Consistency
1. **Add folder management to all design.html tabs**: Add "Manage Folders" button to Design System, HTML Preview, Images, and Stitch tabs controls strips.
2. **Per-download destination selection**: Allow users to specify download destination per-action (e.g., "Download to: [dropdown]").
3. **Consistent folder modal**: Reuse the existing folder modal from planning tab across all design panel tabs.

### User Control Improvements
1. **Output folder configuration**: Allow users to configure where Stitch downloads go via UI (not just settings).
2. **Per-workspace folders**: Support different output folders per workspace (like HTML/Design tabs already do).
3. **Clear download feedback**: Show where files are being downloaded to with visual feedback.

## Implementation Plan

### Phase 1: Stitch Tab UX Cleanup
1. **Remove workspace picker from Stitch tab**
   - Remove `stitch-workspace-filter` select element from design.html
   - Remove corresponding event listener in design.js
   - Keep workspace selection internal (use active workspace or default)
   - Update `stitchListProjects` to use current workspace without filter

2. **Remove sync button**
   - Remove `btn-sync-stitch-project` button from design.html
   - Remove `stitchSyncProject` message handler from DesignPanelProvider.ts
   - Remove sync-related state and functions from design.js

3. **Implement on-demand DESIGN.md generation**
   - Modify `stitchOpenManifest` handler in DesignPanelProvider.ts:
     - If DESIGN.md exists, open it
     - If not, generate it on-demand using current project's screens and design systems
     - Call `listDesignSystems()` and fetch screens data
     - Write DESIGN.md to output directory
     - Open the generated file
   - Update button text to "Generate/Open DESIGN.md" to reflect dual behavior

4. **Add palette download button**
   - Add "Download Design Tokens" button to Stitch tab controls strip
   - Add `stitchDownloadPalette` message handler in DesignPanelProvider.ts:
     - Call `projectInstance.listDesignSystems()`
     - Extract design tokens/palette data
     - Save to `design-tokens.json` or similar in output directory
     - Show success message with file location
   - Add corresponding event listener in design.js

5. **Clarify prompt generator button**
   - Relabel button from "Prompt Generator" to "Image to Prompt"
   - Add tooltip: "Upload reference images to generate detailed prompts for Stitch"
   - Update modal title from "Design Prompt Generator" to "Image to Prompt Converter"
   - Update modal instructions to clarify the workflow

6. **Replace controls based on mode**
   - In gallery mode: Show generation controls strip (model selector, device selector, prompt input, "Generate Screen" button)
   - In preview mode: Hide generation controls strip, show editing controls strip (model selector, prompt input, creative range, aspect checkboxes, "Apply Edit"/"+3 Variants" buttons)
   - Move shared controls (model selector, device selector) to a neutral location or duplicate in both strips
   - Use CSS display toggling based on `state.activePreviewScreenId` to switch between control strips
   - This eliminates dual-input confusion by showing only relevant controls

### Phase 2: Folder Management Consistency
1. **Add folder management to all design.html tabs**
   - Add "Manage Folders" button to Design System tab controls strip
   - Add "Manage Folders" button to HTML Preview tab controls strip
   - Add "Manage Folders" button to Images tab controls strip
   - Add "Manage Folders" button to Stitch tab controls strip (next to project selector)
   - Reuse existing folder modal from planning tab (copy modal HTML to design.html)
   - Add folder management message handlers in DesignPanelProvider.ts:
     - `getDesignFolderPaths` - return configured design system folders
     - `addDesignFolderPath` - add folder to configuration
     - `removeDesignFolderPath` - remove folder from configuration
     - `getHtmlFolderPaths` - return configured HTML preview folders
     - `addHtmlFolderPath` - add folder to configuration
     - `removeHtmlFolderPath` - remove folder from configuration
     - `getImagesFolderPaths` - return configured image folders
     - `addImagesFolderPath` - add folder to configuration
     - `removeImagesFolderPath` - remove folder from configuration
     - `getStitchFolderPaths` - return configured stitch output folders
     - `addStitchFolderPath` - add folder to configuration
     - `removeStitchFolderPath` - remove folder from configuration
   - Integrate with LocalFolderService or extend it for all tab types
   - Update `_getStitchOutputDir` to use configured folder instead of hardcoded setting

2. **Implement per-download destination selection**
   - Add destination dropdown to download buttons (DL HTML, DL PNG, Download Design Tokens)
   - Default to currently selected folder
   - Allow user to select from configured folders or "Choose folder..."
   - Pass selected destination in download message

### Phase 3: Consistent Workspace Scoping
1. **Per-workspace folder configuration**
   - Store folder paths per workspace root (like htmlFolderPathsByRoot, designFolderPathsByRoot)
   - Update folder management to work with workspace-scoped paths
   - Ensure folder selection respects current workspace filter

2. **Update download logic**
   - All download operations use workspace-scoped folder configuration
   - Fallback to default folder if no workspace-specific folder configured
   - Show clear error if no folder configured for current workspace

## Edge Cases
- **No folder configured**: Show clear error message prompting user to configure folder
- **Multiple workspaces**: Ensure folder selection respects current workspace filter
- **Folder not accessible**: Handle permission errors gracefully with user-friendly message
- **DESIGN.md generation failure**: Handle API errors gracefully, show retry option
- **Design systems not available**: Handle cases where project has no design systems (graceful degradation)

## Risks
- **Breaking change**: Removing sync button may break workflows that depend on bulk sync
- **Configuration migration**: Users with existing `stitch.defaultOutputFolder` setting need migration to new folder management system
- **Performance**: On-demand DESIGN.md generation may be slow for large projects
- **Complexity**: Adding folder management to multiple tabs increases code complexity

## Verification Plan

### Automated Tests
- Stitch tab renders without workspace picker; project selection still functional.
- On-demand DESIGN.md generation produces valid markdown with screens index and design tokens when file does not exist; opens existing file when present.
- Palette download handler extracts design tokens from `listDesignSystems()` and writes `design-tokens.json` to configured output directory.
- Folder management message handlers (get/add/remove for design/html/images/stitch) return updated path lists and persist to `local-folder-config.json`.
- Per-download destination payload overrides default folder; falls back to default when omitted.
- Mode-switched control strips: generation strip visible in gallery mode, editing strip visible in preview mode; `setStitchBusy` disables buttons in both strips without null reference errors.
- Migration: existing `stitch.defaultOutputFolder` setting copied to `stitchFolderPaths` with `_migratedStitch: true` flag.

### Manual Tests
- Test Stitch tab without workspace picker (ensure project selection still works)
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

## Files to Change
- `src/webview/design.html` - Remove workspace picker, sync button, add palette button, add folder management button, add folder modal
- `src/webview/design.js` - Remove sync logic, add palette download logic, add folder management logic, update DESIGN.md button behavior
- `src/services/DesignPanelProvider.ts` - Remove sync handler, add palette handler, add folder management handlers, update DESIGN.md handler
- `src/services/LocalFolderService.ts` - Potentially extend for Stitch folder management or create separate service
- `package.json` - No changes needed

## Success Criteria
- Stitch tab has no misleading workspace picker
- Users can download palette without bulk sync
- DESIGN.md generates on-demand without prior sync
- All tabs have consistent folder management UI
- Users can specify download destinations per-action
- Per-workspace folder configuration works correctly
- No breaking changes for existing users (migration path provided)

## Recommendation
**Send to Lead Coder** — Complexity 7 with multi-file coordination, shared config schema changes, and new message handlers across `DesignPanelProvider.ts` and `LocalFolderService.ts`.
