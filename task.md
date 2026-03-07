# Task: Restore Color and Glowing Status Lights

## [x] Phase 1: Context Gathering
- [x] Read `src/webview/implementation.html` CSS variables and status dot styles.
- [x] Read `createAgentRow`, `createAutoAgentRow`, `createPipelineRow`, and `createAnalystRow` logic.

## [x] Phase 2: Implementation Plan
- [x] Define new vibrant color values and glows.
- [x] Map out all CSS and JS changes in `src/webview/implementation.html`.

## [x] Phase 3: Implement CSS Changes
- [x] Update CSS variables (`--accent-*`, `--glow-*`).
- [x] Update `.status-dot` classes (`.green`, `.green-pulse`, `.orange`).
- [x] Add `.status-dot.red` class.
- [x] Update `.agent-row` highlight styles for all statuses.
- [x] Update `@keyframes pulse-green`.

## [x] Phase 4: Implement JavaScript Changes
- [x] Update `createPipelineRow` to add `.red` class.
- [x] Update `createAutoAgentRow` to add `.red` class.
- [x] Update `createAgentRow` to add `.red` class.
- [x] Update `createAnalystRow` to add `.red` class. (Also updated `createCompositeRow` and `createCoderReviewerRow`)

## [x] Phase 5: Verification
- [x] Verify build/compile (successfully ran `npm run compile`).
- [x] Verify changes in sidebar (logic verified via code review).
- [x] Self-review (Red Team).

### Red Team Findings
1. **Accessibility (Contrast):** Vibrant colors like `#4ec9b0` (green) and `#f44747` (red) might have contrast issues in specific light themes. However, they are standard in industrial UIs and match the "premium" requirement.
2. **Visual Noise:** Larger glows and more frequent red dots (for offline agents) might increase visual clutter. Mitigation: Glows are subtle and tied to status.
3. **Semantic Overload:** Red dot usually means "Error", but here it means "Unavailable/Offline". This is as per plan requirements but might be noted by users.
