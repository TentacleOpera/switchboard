# Architectural Refactor: Consolidate Webview State

## Goal
Eliminate the architectural risk of duplicated frontend state by consolidating `lastVisibleAgents`, `DEFAULT_CONFIG`, and other hardcoded defaults out of individual webview HTML files (`kanban.html`, `setup.html`, `implementation.html`) into a single source of truth.

## Metadata
- **Tags:** refactor, architecture, frontend, webview
- **Complexity:** 5 (Moderate)
- **Status:** Planned

## Problem
Currently, the default visibility of agents (`lastVisibleAgents`) and default prompt configurations (`DEFAULT_CONFIG`) are hardcoded directly within the `<script>` blocks of three separate webview files:
1. `src/webview/kanban.html`
2. `src/webview/setup.html`
3. `src/webview/implementation.html`

When a new specialty role (e.g., `ticket_updater`, `researcher`) is added or changed, developers must manually update all three files. Forgetting to do so results in UI bugs, such as columns or checkboxes defaulting to the wrong state on fresh extension installs. This is a brittle pattern that scales poorly as the number of agents grows.

## Proposed Solution

There are two primary ways to consolidate this state in VS Code webviews. The plan recommends **Approach 1** for cleaner separation of concerns.

### Approach 1: Shared Frontend Module (Recommended)
Extract the duplicated configuration into a shared JavaScript file that is loaded by all webviews.

1. **Create Shared Config:**
   Create a new file `src/webview/shared-config.js` containing the unified state:
   ```javascript
   // src/webview/shared-config.js
   window.SWITCHBOARD_CONFIG = {
       defaultVisibleAgents: {
           planner: true, lead: true, coder: true, intern: true, reviewer: true,
           tester: false, analyst: true, jules: true, gatherer: true,
           ticket_updater: false, researcher: false, splitter: false
       },
       defaultRoleConfigs: {
           planner: { /* ... */ },
           // ... other roles
       }
   };
   ```

2. **Update Webview Providers:**
   In the extension host providers (`KanbanProvider.ts`, `SetupProvider.ts`, etc.), ensure that the `shared-config.js` file is converted to a Webview URI and passed to the HTML, or ensure the Content Security Policy (CSP) and local resource roots allow loading it.
   *Note: If the providers currently just `readFileSync` the HTML without replacing script tags with proper `webview.asWebviewUri()` paths, those providers will need to be updated to inject the script URI.*

3. **Refactor HTML Files:**
   - Include the script: `<script src="${sharedConfigUri}"></script>` (or replace a placeholder in the HTML).
   - Replace local `lastVisibleAgents` initialization with `let lastVisibleAgents = { ...window.SWITCHBOARD_CONFIG.defaultVisibleAgents };`.
   - Replace local `DEFAULT_CONFIG` with `window.SWITCHBOARD_CONFIG.defaultRoleConfigs`.

### Approach 2: Backend State Injection
Move the source of truth to the TypeScript extension host and inject it into the HTML string before rendering.

1. **Define Config in TypeScript:**
   Create `src/constants/WebviewConfig.ts` with the default objects.

2. **Inject into HTML:**
   In `KanbanProvider.ts` (and others), read the HTML file, and inject the JSON payload:
   ```typescript
   const htmlContent = fs.readFileSync(htmlPath, 'utf8');
   const configScript = `<script>window.SWITCHBOARD_CONFIG = ${JSON.stringify(WEBVIEW_CONFIG)};</script>`;
   const finalHtml = htmlContent.replace('<!-- CONFIG_INJECTION_POINT -->', configScript);
   ```

3. **Refactor HTML Files:**
   Add `<!-- CONFIG_INJECTION_POINT -->` to the `<head>` of the HTML files and update the local state to read from `window.SWITCHBOARD_CONFIG`.

## Execution Steps
1. [ ] Review and select one of the proposed architectural approaches (Frontend Module vs. Backend Injection).
2. [ ] Identify all instances of duplicated state across `kanban.html`, `setup.html`, and `implementation.html` (e.g. `lastVisibleAgents`, `DEFAULT_CONFIG`, `roles` arrays).
3. [ ] Extract the state into the chosen centralized location.
4. [ ] Refactor the Webview Providers (TypeScript) to serve the shared state (either via URI mapping or string injection).
5. [ ] Refactor the Webview HTML files to consume the centralized state instead of local hardcoded objects.
6. [ ] Manually test all three panels (Kanban, Setup, Implementation) to ensure initial render works correctly without `state.json`.

## Risk & Edge-Case Audit
- **CSP Violations:** Modifying how scripts are loaded can trigger VS Code's strict Content Security Policy. The CSP meta tag in the HTML files must be carefully updated if loading an external local file (Approach 1).
- **Bundle Management:** If the extension uses Webpack/esbuild for the webview assets, the shared file must be included in the build process. Switchboard currently seems to serve raw HTML files from `dist/webview/` or `src/webview/`, so string replacement (Approach 2) is often less risky regarding build tooling.
- **Hydration Race Conditions:** Ensure that the injected state is synchronously available before the main webview scripts execute.
