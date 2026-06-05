# Switchboard Visual Themes: Claude Terracotta and Slightly Darker Black

## Goal
Add two new visual themes ("Claude Terracotta" and "Slightly Darker Black") to Switchboard, allowing users to select a theme from the Setup panel and have it immediately propagate across all active webviews (Setup, Kanban, Planning/Research panels).

### Background & Core Problems
Currently, only the default "Afterburner" theme exists. The Theme tab in Setup (setup.html line 978-990) has a single radio button for "Afterburner" and persists the selection via `vscode.getState()` (webview-local state, line 3367), which does not survive panel recreation or propagate to other webviews. There is no `switchboard.theme.name` VS Code configuration setting, so theme state is isolated to the Setup panel and never reaches the Kanban or Planning panels. The `handleThemeChanged()` function in planning.js (line 2100-2102) is a no-op stub.

## Metadata
**Tags:** frontend, ui, ux
**Complexity:** 5

## User Review Required

> [!NOTE]
> The theme configuration setting (`switchboard.theme.name`) will be stored globally in VS Code settings. Changing the theme in the Setup panel will immediately propagate the change across all active Switchboard webviews.

## Complexity Audit

### Routine
- Adding `switchboard.theme.name` enum config to package.json
- Adding radio buttons for "Claude Terracotta" and "Slightly Darker Black" themes in setup.html Theme tab
- Defining CSS variable overrides under `body.theme-claude-terracotta` and `body.theme-slightly-darker-black` in each webview HTML file
- Updating `handleThemeChanged()` in planning.js to set body class
- Adding `themeNameSetting` message handler in kanban.html and planning.js message listeners

### Complex / Risky
- Extending `_postSharedWebviewMessage` / `broadcastToWebviews` to reach Kanban and Planning panel webviews (currently only reaches sidebar + Setup panel — see line 3518-3521 of TaskViewerProvider.ts)
- Migrating theme persistence from `vscode.getState()` to VS Code configuration with proper init-time hydration across all panels
- Coordinating theme change propagation across 3+ independent webview panels with different provider backends (TaskViewerProvider, KanbanProvider, PlanningPanelProvider)

## Edge-Case & Dependency Audit

- **Race Conditions:** If the user changes the theme while the Kanban or Planning panel is not yet open, the theme must still apply when the panel is later opened. This requires each provider to read `switchboard.theme.name` on panel init (not just rely on broadcast).
- **Security:** No security implications — themes are purely cosmetic CSS variable overrides.
- **Side Effects:** Changing `switchboard.theme.name` via VS Code settings UI (outside the Setup panel) should also propagate. Each provider should listen for `onDidChangeConfiguration` for this setting.
- **Dependencies & Conflicts:** The existing `cyberAnimationSetting` pattern (PlanningPanelProvider line 291-296) provides the dual-path model: config change listener + broadcast message. This plan should follow that exact pattern. The `themeChanged` message type already exists in PlanningPanelProvider (line 286) but is triggered by VS Code color theme changes, not Switchboard visual themes — these must not conflict. Rename the Switchboard theme message to `switchboardThemeChanged` to avoid collision.

## Dependencies
- None

## Adversarial Synthesis
Key risks: multi-panel broadcast requires extending `_postSharedWebviewMessage` to reach Kanban and Planning providers (currently sidebar+setup only); theme persistence must migrate from webview getState to VS Code config with proper init-time hydration across all panels. Mitigations: follow the existing `cyberAnimationSetting` dual-path pattern (config listener + broadcast); add `switchboardThemeNameSetting` message to `postSetupPanelState` and `_postSidebarConfigurationState` for init hydration; authoritative palettes are specified verbatim in the plan — no design iteration needed.

## Proposed Changes

### Configuration Contribution

#### [MODIFY] [package.json](file:///Users/patrickvuleta/Documents/GitHub/switchboard/package.json)
- Add a new VS Code configuration setting `"switchboard.theme.name"` with `afterburner` as the default value, and `afterburner`, `claude-terracotta`, and `slightly-darker-black` as the enum options.
- Set scope to `"window"` (per-workspace-window, consistent with other Switchboard settings and the "global" intent from User Review Required).
- Add to `contributes.configuration.properties` (after the existing theme-related `switchboard.theme.disableCyberAnimation` if present, or near other visual settings):
  ```json
  "switchboard.theme.name": {
      "type": "string",
      "enum": ["afterburner", "claude-terracotta", "slightly-darker-black"],
      "enumDescriptions": [
          "Afterburner — Default cyberpunk teal theme with scanline effects",
          "Claude Terracotta — Warm terracotta accent on professional dark surfaces",
          "Slightly Darker Black — Minimalist monochrome with tonal depth and luminance"
      ],
      "default": "afterburner",
      "description": "Visual theme for Switchboard webviews. Applies to Setup, Kanban, and Planning panels.",
      "scope": "window"
  }
  ```

### Extension Services

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)
- Add a helper `handleGetThemeSetting()` to read `"switchboard.theme.name"` from VS Code config:
  ```typescript
  public handleGetThemeSetting(): string {
      return vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
  }
  ```
- Add a helper `handleSetThemeSetting(theme: string)` to update `"switchboard.theme.name"`:
  ```typescript
  public async handleSetThemeSetting(theme: string): Promise<void> {
      await vscode.workspace.getConfiguration('switchboard').update('theme.name', theme, vscode.ConfigurationTarget.Workspace);
  }
  ```
- In `postSetupPanelState` (around line 3572), add a message sending the current theme name:
  ```typescript
  this._setupPanelProvider.postMessage({
      type: 'switchboardThemeNameSetting',
      theme: this.handleGetThemeSetting()
  });
  ```
- In `_postSidebarConfigurationState` (around line 3527), add a message sending the current theme name to the sidebar webview:
  ```typescript
  this._view?.webview.postMessage({
      type: 'switchboardThemeNameSetting',
      theme: this.handleGetThemeSetting()
  });
  ```
- Extend `broadcastToWebviews` (line 3523) to also post to the Kanban and Planning panel webviews:
  ```typescript
  public broadcastToWebviews(message: any): void {
      this._postSharedWebviewMessage(message);
      this._kanbanProvider?.postMessage(message);
      // PlanningPanelProvider receives theme via onDidChangeConfiguration listener (see below)
  }
  ```
- Add a `onDidChangeConfiguration` listener in the constructor or activation to detect `switchboard.theme.name` changes and broadcast:
  ```typescript
  this._disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
          if (e.affectsConfiguration('switchboard.theme.name')) {
              const theme = this.handleGetThemeSetting();
              this.broadcastToWebviews({ type: 'switchboardThemeChanged', theme });
          }
      })
  );
  ```

#### [MODIFY] [SetupPanelProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/SetupPanelProvider.ts)
- Add a message handler case for `'setThemeSetting'` in `_handleMessage` (around line 122):
  ```typescript
  case 'setThemeSetting': {
      const theme = typeof message.theme === 'string' ? message.theme : 'afterburner';
      await this._taskViewerProvider.handleSetThemeSetting(theme);
      // Broadcast to all other active webviews
      this._taskViewerProvider.broadcastToWebviews({ type: 'switchboardThemeChanged', theme });
      // Also update the setup panel itself
      this._panel?.webview.postMessage({ type: 'switchboardThemeNameSetting', theme });
      break;
  }
  ```

#### [MODIFY] [PlanningPanelProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts)
- Add an `onDidChangeConfiguration` listener for `switchboard.theme.name` (following the existing pattern at line 291-296 for `cyberAnimationSetting`):
  ```typescript
  this._disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
          if (e.affectsConfiguration('switchboard.theme.name')) {
              const theme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
              this._panel?.webview.postMessage({ type: 'switchboardThemeChanged', theme });
          }
      })
  );
  ```
- In `_handleFetchRoots` (around line 2286), send the current theme on panel init:
  ```typescript
  const currentTheme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
  this._panel?.webview.postMessage({ type: 'switchboardThemeNameSetting', theme: currentTheme });
  ```

#### [MODIFY] [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)
- Add a `postMessage` method (if not already present) to forward messages to the Kanban webview panel.
- Add an `onDidChangeConfiguration` listener for `switchboard.theme.name` to forward theme changes to the Kanban webview.
- On panel init / `resolveWebviewView`, send the current theme name via `switchboardThemeNameSetting` message.

### Frontend Webviews

#### [MODIFY] [setup.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html)
- Add two new radio buttons in the theme selection list (line 985-990) for "Claude Terracotta" and "Slightly Darker Black":
  ```html
  <label class="db-radio-option">
      <input type="radio" name="theme-selection" value="claude-terracotta">
      <span>Claude Terracotta</span>
  </label>
  <label class="db-radio-option">
      <input type="radio" name="theme-selection" value="slightly-darker-black">
      <span>Slightly Darker Black</span>
  </label>
  ```
- Define CSS variable overrides inside `<style>` under `body.theme-claude-terracotta` and `body.theme-slightly-darker-black`. These are the **authoritative palettes** — implement verbatim:

  **Theme 1: Claude Terracotta** — Balances the warmth of the Claude Code terracotta with a professional, dark-mode IDE aesthetic.
  ```css
  /* Claude Terracotta — warm terracotta accent on professional dark surfaces */
  body.theme-claude-terracotta {
      /* Backgrounds */
      --bg-color: #1A1A1A;          /* Primary Surface — Main editor/Kanban area */
      --panel-bg: #121212;          /* Sidebar/Panels — Left sidebar and bottom terminal */
      --panel-bg2: #1A1A1A;         /* Secondary surface */
      --bg-dim: #1A1A1A;

      /* Primary Accent (Terracotta) — Active tab indicators, progress bar fills, critical state icons */
      --accent-teal: #D97757;
      --accent-teal-dim: color-mix(in srgb, #D97757 40%, transparent);
      --accent-teal-bright: #E08868;
      --glow-teal: 0 0 10px color-mix(in srgb, #D97757 50%, transparent);

      /* Secondary/Action (Muted Terracotta) — Primary action buttons (solid fill), hover states for outlined buttons */
      --accent-green: #A35941;
      --accent-red: #e05544;
      --accent-orange: #D97757;

      /* Borders & Outlines */
      --border-color: #2D2D2D;      /* Section Dividers */
      --border-bright: #2D2D2D;
      --border-dim: #2D2D2D;
      /* Button Borders: #D97757 at 60% opacity for "ghost" style — handled via color-mix in .secondary-btn */

      /* Typography */
      --text-primary: #FFFFFF;      /* Headings/Active Text */
      --text-secondary: #A0A0A0;   /* Secondary/Body Text */
  }
  /* Claude Terracotta — button overrides */
  body.theme-claude-terracotta .action-btn {
      background: #A35941;          /* Muted Terracotta solid fill */
      border-color: #A35941;
      color: #FFFFFF;
  }
  body.theme-claude-terracotta .action-btn:hover:not(:disabled) {
      background: #D97757;          /* Primary Terracotta on hover */
      border-color: #D97757;
  }
  body.theme-claude-terracotta .secondary-btn {
      border-color: color-mix(in srgb, #D97757 60%, transparent);  /* Ghost style at 60% opacity */
      color: #D97757;
  }
  body.theme-claude-terracotta .secondary-btn:hover:not(:disabled) {
      background: color-mix(in srgb, #D97757 10%, transparent);
      border-color: #D97757;
      color: #FFFFFF;
  }
  ```

  **Theme 2: Slightly Darker Black** — A minimalist, high-focus theme that uses tonal depth and luminance instead of color to define the interface.
  ```css
  /* Slightly Darker Black — minimalist monochrome with tonal depth and luminance */
  body.theme-slightly-darker-black {
      /* Backgrounds */
      --bg-color: #0A0A0A;          /* Primary Surface — Deepest black for main workspace */
      --panel-bg: #0A0A0A;          /* Deepest black */
      --panel-bg2: #141414;         /* Secondary Surface — Slightly lighter for sidebars and terminal panels */
      --bg-dim: #141414;

      /* Accents (Monochrome) */
      --accent-teal: #E0E0E0;       /* Active States — Light gray for active tabs/borders */
      --accent-teal-dim: color-mix(in srgb, #E0E0E0 40%, transparent);
      --accent-teal-bright: #FFFFFF;
      --glow-teal: 0 0 10px color-mix(in srgb, #E0E0E0 30%, transparent);
      --accent-green: #E0E0E0;
      --accent-red: #ff4444;
      --accent-orange: #E0E0E0;

      /* Borders & Dividers */
      --border-color: #1F1F1F;      /* Subtle Dividers */
      --border-bright: #333333;     /* Interactive Outlines */
      --border-dim: #1F1F1F;

      /* Typography */
      --text-primary: #F5F5F5;      /* Primary Text — High contrast */
      --text-secondary: #666666;    /* De-emphasized Text — Metadata, timestamps, inactive labels */
  }
  /* Slightly Darker Black — button overrides: High-Action Highlighting uses #FFFFFF on black for primary CTAs */
  body.theme-slightly-darker-black .action-btn {
      background: #FFFFFF;          /* White on black for primary CTAs */
      border-color: #FFFFFF;
      color: #0A0A0A;
  }
  body.theme-slightly-darker-black .action-btn:hover:not(:disabled) {
      background: #E0E0E0;
      border-color: #E0E0E0;
      color: #0A0A0A;
  }
  body.theme-slightly-darker-black .secondary-btn {
      border-color: #333333;        /* Interactive Outlines */
      color: #E0E0E0;
  }
  body.theme-slightly-darker-black .secondary-btn:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.05);  /* Semi-transparent white overlay for hover on dark surfaces */
      border-color: #E0E0E0;
      color: #F5F5F5;
  }
  /* Slightly Darker Black — special hover effect: semi-transparent white overlay on dark surfaces */
  body.theme-slightly-darker-black .strip-btn:hover:not(:disabled),
  body.theme-slightly-darker-black .tab-btn:hover,
  body.theme-slightly-darker-black .db-radio-option:hover,
  body.theme-slightly-darker-black .db-action-btn:hover {
      background: rgba(255, 255, 255, 0.05);
  }
  ```
- Adapt primary solid-fill buttons (`.action-btn`) and ghost/outlined buttons (`.secondary-btn`) to look customized in both themes (using terracotta tones or solid monochrome styles). The CSS variable overrides above will cascade through the existing `color-mix()` expressions that reference `--accent-teal`.
- Update JS: Change the theme radio change handler (line 3359-3370) to post `setThemeSetting` to the extension instead of only saving to `vscode.getState()`:
  ```javascript
  radio.addEventListener('change', (e) => {
      vscode.postMessage({ type: 'setThemeSetting', theme: e.target.value });
      // ... existing animation visibility logic ...
  });
  ```
- Add a handler for incoming `'switchboardThemeNameSetting'` message to sync the radio button state:
  ```javascript
  case 'switchboardThemeNameSetting':
      const themeRadio = document.querySelector(`input[name="theme-selection"][value="${msg.theme}"]`);
      if (themeRadio) themeRadio.checked = true;
      document.body.className = document.body.className.replace(/theme-\S+/g, '').trim();
      if (msg.theme !== 'afterburner') document.body.classList.add(`theme-${msg.theme}`);
      // ... update animation settings visibility ...
      break;
  ```
- On the `'theme'` tab activation (line 1456-1465), read from the `switchboardThemeNameSetting` message data instead of `persistedState.selectedTheme`.

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)
- Define CSS variable overrides under `body.theme-claude-terracotta` and `body.theme-slightly-darker-black` (same authoritative palette as setup.html, adjusted for kanban's `:root` variable names which differ slightly — e.g., `--accent-teal-dim`, `--glow-teal`).
- Update JS message listener to handle `'switchboardThemeNameSetting'` and `'switchboardThemeChanged'` messages and update the body class accordingly:
  ```javascript
  case 'switchboardThemeNameSetting':
  case 'switchboardThemeChanged':
      document.body.className = document.body.className.replace(/theme-\S+/g, '').trim();
      if (msg.theme && msg.theme !== 'afterburner') {
          document.body.classList.add(`theme-${msg.theme}`);
      }
      break;
  ```

#### [MODIFY] [planning.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html)
- Define CSS variable overrides under `body.theme-claude-terracotta` and `body.theme-slightly-darker-black` (same authoritative palette, adjusted for planning.html's `:root` variable names).

#### [MODIFY] [planning.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js)
- Update `handleThemeChanged(theme)` (line 2100-2102) to set the appropriate body class:
  ```javascript
  function handleThemeChanged(theme) {
      document.body.className = document.body.className.replace(/theme-\S+/g, '').trim();
      if (theme && theme !== 'afterburner') {
          document.body.classList.add(`theme-${theme}`);
      }
  }
  ```
- Handle `'switchboardThemeNameSetting'` inside the main message listener switch block (around line 2673):
  ```javascript
  case 'switchboardThemeNameSetting':
      handleThemeChanged(msg.theme);
      break;
  case 'switchboardThemeChanged':
      handleThemeChanged(msg.theme);
      break;
  ```
- Note: The existing `case 'themeChanged'` (line 2673) is for VS Code color theme changes and should remain separate. The new `switchboardThemeChanged` is for Switchboard visual themes.

## Verification Plan

### Automated Tests
- (Skipped per session directive — no compilation or test execution)

### Manual Verification
1. Open the Switchboard Setup panel and select the "Theme" tab.
2. Select "Claude Terracotta" and verify:
   - The Setup page colors immediately change to terracotta tones.
   - Solid action buttons become terracotta red/orange.
   - Text contrast meets expectations.
3. Open the Kanban board and verify that the Kanban board colors also update to match the "Claude Terracotta" theme.
4. Open the Planning/Research panel and verify it also reflects the "Claude Terracotta" theme.
5. Select "Slightly Darker Black" in the Setup panel and verify:
   - The Setup page changes to deep black, high-contrast white, and shades of gray.
   - Solid buttons become stark white on black.
   - Sidebar and terminal panel borders use subtle dividers.
6. Verify that selecting "Afterburner" restores the original default visual theme.
7. Close and reopen the Kanban and Planning panels — verify the selected theme persists and is applied on panel open.
8. Change the theme via VS Code Settings UI (`switchboard.theme.name`) and verify all open panels update immediately.

**Recommendation:** Send to Coder
