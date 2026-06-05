# Switchboard Visual Themes: Claude Terracotta and Slightly Darker Black

## Metadata
**Complexity:** 4
**Tags:** frontend, ui, ux, configuration

Provide a user interface to configure visual themes in the Setup panel and apply the selected theme dynamically to all primary webviews (Setup, Kanban, and Planning/Research panels). Currently, only the default "Afterburner" theme exists. This change adds "Claude Terracotta" and "Slightly Darker Black" themes, allowing users to customize their visual workspace.

## User Review Required

> [!NOTE]
> The theme configuration setting (`switchboard.theme.name`) will be stored globally in VS Code settings. Changing the theme in the Setup panel will immediately propagate the change across all active Switchboard webviews.

## Open Questions
None. The design requirements and specifications provided in the request are complete.

## Proposed Changes

### Configuration Contribution

#### [MODIFY] [package.json](file:///Users/patrickvuleta/Documents/GitHub/switchboard/package.json)
- Add a new VS Code configuration setting `"switchboard.theme.name"` with `afterburner` as the default value, and `afterburner`, `claude-terracotta`, and `slightly-darker-black` as the enum options.

### Extension Services

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)
- Add a helper `handleGetThemeSetting()` to read `"switchboard.theme.name"`.
- Add a helper `handleSetThemeSetting(theme: string)` to update `"switchboard.theme.name"`.
- In `postSetupPanelState` and `_postSidebarConfigurationState`, send the current theme name via message type `'themeNameSetting'`.
- In `broadcastToWebviews`, ensure messages are also propagated to the Kanban webview panel.

#### [MODIFY] [SetupPanelProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/SetupPanelProvider.ts)
- Add a message handler case for `'setThemeSetting'` to save the theme and broadcast it to all other active webviews using `broadcastToWebviews({ type: 'themeChanged', theme })`.

### Frontend Webviews

#### [MODIFY] [setup.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html)
- Add two new radio buttons in the theme selection list for "Claude Terracotta" and "Slightly Darker Black".
- Define CSS variable overrides inside `<style>` under `body.theme-claude-terracotta` and `body.theme-slightly-darker-black` to customize surfaces, backgrounds, borders, active states, text colors, and highlights.
- Adapt primary solid-fill buttons (`.action-btn`) and ghost/outlined buttons (`.secondary-btn`) to look customized in both themes (using terracotta tones or solid monochrome styles).
- Update JS to listen to theme selection changes and post them to the extension, and to handle incoming `'themeNameSetting'` and `'themeChanged'` messages.

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)
- Define CSS variable overrides under `body.theme-claude-terracotta` and `body.theme-slightly-darker-black`.
- Update JS message listener to handle `'themeNameSetting'` and `'themeChanged'` messages and update the body class accordingly.

#### [MODIFY] [planning.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html)
- Define CSS variable overrides under `body.theme-claude-terracotta` and `body.theme-slightly-darker-black`.

#### [MODIFY] [planning.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js)
- Update `handleThemeChanged(theme)` to set the appropriate body class when a `'themeChanged'` or `'themeNameSetting'` message is received.
- Handle `'themeNameSetting'` inside the main message listener switch block.

## Verification Plan

### Automated Tests
- Run `npm run compile` to verify that there are no TypeScript compilation errors.
- Run existing test suites `npm test` to ensure no regressions are introduced.

### Manual Verification
1. Open the Switchboard Setup panel and select the "Theme" tab.
2. Select "Claude Terracotta" and verify:
   - The Setup page colors immediately change to terracotta tones.
   - Solid action buttons become terracotta red/orange.
   - Text contrast meets expectations.
3. Open the Kanban board and verify that the Kanban board colors also update to match the "Claude Terracotta" theme.
4. Select "Slightly Darker Black" in the Setup panel and verify:
   - The Setup page changes to deep black, high-contrast white, and shades of gray.
   - Solid buttons become stark white on black.
   - Sidebar and terminal panel borders use subtle dividers.
5. Verify that selecting "Afterburner" restores the original default visual theme.
