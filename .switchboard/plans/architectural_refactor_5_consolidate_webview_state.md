# Architectural Refactor: Consolidate Webview State

## Goal
Eliminate the architectural risk of duplicated frontend state by consolidating role metadata, addon definitions, and agent label mappings out of individual webview HTML files into the existing `sharedDefaults.js` single source of truth.

## Metadata
- **Tags:** frontend, refactor
- **Complexity:** 3 (Low — routine extensions to an existing shared-file pattern)
- **Status:** Reviewed — Fixes Applied

## User Review Required
- Confirm that `ROLE_ADDONS` should be moved to `sharedDefaults.js` (it is currently only in `kanban.html` but is role-configuration data that should be centralized).
- Confirm that `PROMPT_ROLES` / `BUILT_IN_KANBAN_ASSIGNABLE_AGENTS` / the `roles` array in `renderKanbanAssignedAgentOptions` should be unified into a single `BUILT_IN_AGENT_LABELS` constant in `sharedDefaults.js`.
- Confirm the build pipeline copies `src/webview/sharedDefaults.js` to `dist/webview/sharedDefaults.js` (providers load from `dist/`).

## Complexity Audit

### Routine
- Add `BUILT_IN_AGENT_LABELS`, `ROLE_ADDONS`, and `ROLE_KEYS` constants to existing `src/webview/sharedDefaults.js` (lines 1-34).
- Replace inline `PROMPT_ROLES` in `src/webview/setup.html` (line 1387) with reference to `BUILT_IN_AGENT_LABELS`.
- Replace inline `BUILT_IN_KANBAN_ASSIGNABLE_AGENTS` in `src/webview/setup.html` (line 1397) with reference to `BUILT_IN_AGENT_LABELS`.
- Replace inline `roles` array in `src/webview/kanban.html` `renderKanbanAssignedAgentOptions` (line 5718) with reference to `BUILT_IN_AGENT_LABELS`.
- Replace inline `ROLE_ADDONS` in `src/webview/kanban.html` (line 2356) with reference to shared constant.
- Replace inline `roles` list in `src/webview/kanban.html` `loadRoleConfigs` (line 2418) with `Object.keys(DEFAULT_ROLE_CONFIG)`.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** The `<!-- SHARED_DEFAULTS_SCRIPT -->` is injected before the main `<script>` block in all three HTML files. Since `<script src="...">` tags are synchronous by default, the shared constants will be available before the inline script executes. No race condition risk.
- **Security:** The shared script is loaded via `webview.asWebviewUri()` with a nonce, matching the existing CSP. Adding more constants to the same file does not change the security posture.
- **Side Effects:** The `module.exports` guard at the bottom of `sharedDefaults.js` (line 32-33) allows the file to be imported in Node.js tests as well. New constants must be added to this export.
- **Dependencies & Conflicts:** `TaskViewerProvider.ts` (line 16057), `KanbanProvider.ts` (line 5671), and `SetupPanelProvider.ts` (line 1150) all inject `sharedDefaults.js` from `dist/webview/`. No provider changes are needed — only the source file content changes. The build pipeline must copy the updated file to `dist/`.

## Dependencies
- None — this is a self-contained refactor.

## Adversarial Synthesis
Key risks: (1) The plan's original premise was partially stale — `DEFAULT_VISIBLE_AGENTS` and `DEFAULT_ROLE_CONFIG` were already consolidated into `sharedDefaults.js`. The remaining duplication (role labels in 3 places, `ROLE_ADDONS` not yet shared) is real but smaller than originally claimed. (2) Build pipeline must copy `src/webview/sharedDefaults.js` to `dist/webview/sharedDefaults.js`; if it doesn't, changes won't take effect. Mitigations: extend the existing working pattern rather than introducing a new architecture; verify the build copy step before starting.

## Problem
Currently, the default visibility of agents (`lastVisibleAgents`) and default prompt configurations (`DEFAULT_CONFIG`) are hardcoded directly within the `<script>` blocks of three separate webview files:
1. `src/webview/kanban.html`
2. `src/webview/setup.html`
3. `src/webview/implementation.html`

When a new specialty role (e.g., `ticket_updater`, `researcher`) is added or changed, developers must manually update all three files. Forgetting to do so results in UI bugs, such as columns or checkboxes defaulting to the wrong state on fresh extension installs. This is a brittle pattern that scales poorly as the number of agents grows.

### Current State (Updated from Code Review)

**Already consolidated** (as of current codebase):
- `DEFAULT_VISIBLE_AGENTS` and `DEFAULT_ROLE_CONFIG` are defined in `src/webview/sharedDefaults.js` (lines 1-30).
- All three HTML files contain `<!-- SHARED_DEFAULTS_SCRIPT -->` (kanban.html:2350, setup.html:1247, implementation.html:1822) which providers replace with a `<script src="...">` tag.
- All three providers (`KanbanProvider.ts`:5671, `SetupPanelProvider.ts`:1150, `TaskViewerProvider.ts`:16057) inject the shared script URI with proper nonce.
- HTML files reference these as globals: `let lastVisibleAgents = { ...DEFAULT_VISIBLE_AGENTS }` (kanban.html:2827, setup.html:1282, implementation.html:2204).

**Still duplicated / not yet shared:**
1. **Role label/assignment metadata** — appears in 3 places:
   - `PROMPT_ROLES` in `src/webview/setup.html` (line 1387-1395) — `{ key: 'planner', label: 'Planner' }, ...`
   - `BUILT_IN_KANBAN_ASSIGNABLE_AGENTS` in `src/webview/setup.html` (line 1397-1405) — nearly identical with `role` instead of `key`
   - `roles` array in `renderKanbanAssignedAgentOptions` in `src/webview/kanban.html` (line 5718-5726) — same data again
2. **`ROLE_ADDONS`** — defined only in `src/webview/kanban.html` (lines 2356-2410, ~55 lines) but is role-configuration data that belongs in the shared file for single-source-of-truth consistency.
3. **`roles` list in `loadRoleConfigs`** — `src/webview/kanban.html` (line 2418) hardcodes `['planner', 'lead', 'coder', ...]` which is derivable from `Object.keys(DEFAULT_ROLE_CONFIG)`.

## Proposed Solution

**Extend the existing `sharedDefaults.js` pattern** — do not create a new file or a new architecture. The shared-file + placeholder-injection pattern is already working in production for `DEFAULT_VISIBLE_AGENTS` and `DEFAULT_ROLE_CONFIG`. Add the remaining role metadata to the same file.

### Approach: Extend `sharedDefaults.js` (Recommended — follows established pattern)

1. **Add new constants to `src/webview/sharedDefaults.js`:**
   ```javascript
   // Role key/label pairs for UI rendering
   const BUILT_IN_AGENT_LABELS = [
       { key: 'planner', label: 'Planner' },
       { key: 'lead', label: 'Lead Coder' },
       { key: 'coder', label: 'Coder' },
       { key: 'reviewer', label: 'Reviewer' },
       { key: 'tester', label: 'Acceptance Tester' },
       { key: 'intern', label: 'Intern' },
       { key: 'analyst', label: 'Analyst' },
       { key: 'ticket_updater', label: 'Ticket Updater' },
       { key: 'researcher', label: 'Researcher' },
       { key: 'splitter', label: 'Splitter' }
   ];

   // Derivable helper
   const ROLE_KEYS = Object.keys(DEFAULT_ROLE_CONFIG);

   // Role addon UI metadata (moved from kanban.html)
   const ROLE_ADDONS = {
       planner: [
           { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
           { id: 'dependencyCheck', label: 'Dependency Check', tooltip: 'Query Kanban for cross-plan dependencies', default: false },
           // ... (full definition from kanban.html:2356-2410)
       ],
       // ... other roles
   };
   ```

2. **Update `module.exports`** in `sharedDefaults.js` (line 33) to include new constants.

3. **Update HTML files** to reference shared constants instead of inline definitions:
   - `setup.html`: Replace `PROMPT_ROLES` (line 1387) with `BUILT_IN_AGENT_LABELS`
   - `setup.html`: Replace `BUILT_IN_KANBAN_ASSIGNABLE_AGENTS` (line 1397) with `BUILT_IN_AGENT_LABELS.map(r => ({ role: r.key, label: r.label }))` or adjust consuming code to use `key` instead of `role`
   - `kanban.html`: Replace `ROLE_ADDONS` (line 2356) with the shared constant
   - `kanban.html`: Replace `roles` in `renderKanbanAssignedAgentOptions` (line 5718) with `BUILT_IN_AGENT_LABELS`
   - `kanban.html`: Replace `roles` in `loadRoleConfigs` (line 2418) with `ROLE_KEYS`

4. **No provider changes needed** — the `<!-- SHARED_DEFAULTS_SCRIPT -->` injection mechanism already loads the file.

## Proposed Changes

### `src/webview/sharedDefaults.js` (lines 1-34)
- **Context:** This is the existing shared defaults file, already loaded by all three webviews.
- **Logic:** Add `BUILT_IN_AGENT_LABELS`, `ROLE_ADDONS`, and `ROLE_KEYS` constants after the existing `DEFAULT_ROLE_CONFIG` definition (after line 30). Update `module.exports` (line 33) to include the new exports.
- **Implementation:** Append the new constants. The `ROLE_ADDONS` definition should be copied verbatim from `kanban.html:2356-2410` to preserve all tooltip text and default values.
- **Edge Cases:** The `module.exports` guard (line 32) ensures the file works in both browser (webview) and Node.js (test) contexts. New constants must be added to the export object.

### `src/webview/setup.html` (lines 1387-1405)
- **Context:** Contains two inline role metadata arrays that duplicate each other and the data in `sharedDefaults.js`.
- **Logic:** Replace `PROMPT_ROLES` (line 1387) with `const PROMPT_ROLES = BUILT_IN_AGENT_LABELS;` (or adjust if the consuming code expects a specific shape). Replace `BUILT_IN_KANBAN_ASSIGNABLE_AGENTS` (line 1397) with `const BUILT_IN_KANBAN_ASSIGNABLE_AGENTS = BUILT_IN_AGENT_LABELS.map(r => ({ role: r.key, label: r.label }));`.
- **Implementation:** Note that `PROMPT_ROLES` uses `{ key, label }` while `BUILT_IN_KANBAN_ASSIGNABLE_AGENTS` uses `{ role, label }`. The shared constant should use `{ key, label }` (matching `PROMPT_ROLES`), and the kanban-assignable version can be derived. Verify all consumers of `BUILT_IN_KANBAN_ASSIGNABLE_AGENTS` (search for `.role` access pattern) work with the derived shape.
- **Edge Cases:** `PROMPT_ROLES` currently only includes 7 roles (excluding `ticket_updater`, `researcher`, `splitter`). The shared `BUILT_IN_AGENT_LABELS` includes all 10. Verify that the setup prompt override UI should show all 10 roles or if the current 7-role subset is intentional. **Clarification:** The 7-role subset appears intentional — `ticket_updater`, `researcher`, and `splitter` are specialized roles that don't need prompt overrides. Consider adding a `PROMPT_OVERRIDE_ROLES` subset constant or filtering in the UI.

### `src/webview/kanban.html` (lines 2356-2410, 2418, 5718-5726)
- **Context:** Contains `ROLE_ADDONS` (addon UI metadata), a `roles` list in `loadRoleConfigs`, and a `roles` array in `renderKanbanAssignedAgentOptions`.
- **Logic:** Replace `const ROLE_ADDONS = { ... }` (line 2356) with a reference to the shared constant (already available via `sharedDefaults.js`). Replace `const roles = ['planner', ...]` (line 2418) with `const roles = ROLE_KEYS;`. Replace the `roles` array in `renderKanbanAssignedAgentOptions` (line 5718) with `BUILT_IN_AGENT_LABELS`.
- **Implementation:** The `ROLE_ADDONS` block is ~55 lines. Deleting it and referencing the shared constant is a net reduction. The `renderKanbanAssignedAgentOptions` function uses `r.key` and `r.label` which matches the `BUILT_IN_AGENT_LABELS` shape directly.
- **Edge Cases:** The `roles` array in `renderKanbanAssignedAgentOptions` (line 5718) currently only has 7 roles (same as `PROMPT_ROLES`). The shared `BUILT_IN_AGENT_LABELS` has 10. Verify whether the kanban column assignment dropdown should include all 10 roles or just the 7 "core" ones. **Clarification:** The column assignment dropdown likely should include all roles since custom kanban columns can be assigned to any role.

### `src/webview/implementation.html`
- **Context:** Already uses `DEFAULT_VISIBLE_AGENTS` from `sharedDefaults.js` (line 2204). No additional inline role metadata to consolidate.
- **Logic:** No changes needed — this file already consumes shared defaults correctly.
- **Implementation:** N/A
- **Edge Cases:** N/A

## Verification Plan

### Automated Tests
- No existing unit tests for webview HTML/JS were found. Manual verification is required.
- **Manual test checklist:**
  1. Open Kanban panel → verify "Prompts" tab renders role addon checkboxes correctly for all roles
  2. Open Kanban panel → verify "Kanban Structure" modal shows all agent options in the "Assigned Agent" dropdown
  3. Open Setup panel → verify "Custom Prompts" modal shows role tabs for all expected roles
  4. Open Setup panel → verify "Kanban Structure" section shows correct agent visibility toggles
  5. Open Implementation panel → verify agent onboarding section shows correct default visibility
  6. After all panels verified, add a test role to `sharedDefaults.js` and confirm it appears in all three panels without any HTML file changes

## Original Proposed Approaches (Preserved for Reference)

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
1. [x] Review and select one of the proposed architectural approaches (Frontend Module vs. Backend Injection). → **Selected: Extend existing `sharedDefaults.js` pattern (variant of Approach 1, already partially implemented)**
2. [x] Identify all instances of duplicated state across `kanban.html`, `setup.html`, and `implementation.html` (e.g. `lastVisibleAgents`, `DEFAULT_CONFIG`, `roles` arrays). → **Done: `DEFAULT_VISIBLE_AGENTS`/`DEFAULT_ROLE_CONFIG` already consolidated; remaining: `PROMPT_ROLES`, `BUILT_IN_KANBAN_ASSIGNABLE_AGENTS`, `ROLE_ADDONS`, `roles` lists**
3. [x] Verify build pipeline copies `src/webview/sharedDefaults.js` to `dist/webview/sharedDefaults.js`. → **Verified: `webpack.config.js` CopyPlugin copies `src/webview/*.js` to `dist/webview/`. `npm run compile` succeeds.**
4. [x] Add `BUILT_IN_AGENT_LABELS`, `ROLE_ADDONS`, and `ROLE_KEYS` constants to `src/webview/sharedDefaults.js` and update `module.exports`. → **Done. Also added `PROMPT_OVERRIDE_EXCLUDED_KEYS` during review (see Review Findings below).**
5. [x] Replace inline `PROMPT_ROLES` and `BUILT_IN_KANBAN_ASSIGNABLE_AGENTS` in `src/webview/setup.html` with references to shared constants. → **Done. `PROMPT_ROLES` now uses `BUILT_IN_AGENT_LABELS.filter(r => !PROMPT_OVERRIDE_EXCLUDED_KEYS.has(r.key))` to preserve the original 7-role subset. `BUILT_IN_KANBAN_ASSIGNABLE_AGENTS` removed entirely (kanban column modal removed from Setup panel — see Out-of-Scope Changes below).**
6. [x] Replace inline `ROLE_ADDONS`, `roles` list, and `roles` array in `src/webview/kanban.html` with references to shared constants. → **Done. `ROLE_ADDONS` removed, `DEFAULT_CONFIG = { ...DEFAULT_ROLE_CONFIG }`, `ROLE_KEYS` in `loadRoleConfigs`, `BUILT_IN_AGENT_LABELS` in `renderKanbanAssignedAgentOptions`, `DEFAULT_VISIBLE_AGENTS` for `lastVisibleAgents`.**
7. [ ] Manually test all three panels (Kanban, Setup, Implementation) to ensure initial render works correctly without `state.json`.

## Risk & Edge-Case Audit
- **CSP Violations:** Modifying how scripts are loaded can trigger VS Code's strict Content Security Policy. The CSP meta tag in the HTML files must be carefully updated if loading an external local file (Approach 1). → **Mitigated: The shared script loading pattern is already working in production with proper nonce injection. Adding more constants to the same file does not change the CSP story.**
- **Bundle Management:** If the extension uses Webpack/esbuild for the webview assets, the shared file must be included in the build process. Switchboard currently seems to serve raw HTML files from `dist/webview/` or `src/webview/`, so string replacement (Approach 2) is often less risky regarding build tooling. → **Mitigated: The existing `sharedDefaults.js` is already part of the build output. Verify the copy step in step 3.**
- **Hydration Race Conditions:** Ensure that the injected state is synchronously available before the main webview scripts execute. → **Mitigated: `<script src="...">` tags are synchronous by default. The `<!-- SHARED_DEFAULTS_SCRIPT -->` placeholder appears before the main `<script>` block in all three HTML files.**
- **Role subset mismatch:** `PROMPT_ROLES` and `renderKanbanAssignedAgentOptions` currently include only 7 of 10 roles. The shared `BUILT_IN_AGENT_LABELS` includes all 10. Need to verify whether the UI should show all roles or maintain the current subset. See "Edge Cases" under Proposed Changes for each file.

**Recommendation: Send to Coder** (Complexity 3 ≤ 6)

---

## Review Findings (2026-05-15)

### Reviewer Pass Summary
All planned consolidation steps (3-6) are implemented and verified. One MAJOR finding was fixed in-place. Several out-of-scope changes were identified and documented.

### Files Changed by Review
- `src/webview/sharedDefaults.js` — Added `PROMPT_OVERRIDE_EXCLUDED_KEYS` constant and updated `module.exports`
- `src/webview/setup.html` — Changed `PROMPT_ROLES` from `BUILT_IN_AGENT_LABELS` (10 roles) to `BUILT_IN_AGENT_LABELS.filter(r => !PROMPT_OVERRIDE_EXCLUDED_KEYS.has(r.key))` (7 roles, preserving original behavior)

### Findings

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | CRITICAL | Scope creep: ~1,100 lines of out-of-scope changes in setup.html (Custom Agents tab removal, Kanban Structure tab removal, Database UI refactor to multi-DB cards). Not specified in the plan. | Documented below. Changes appear functionally coherent and the Kanban panel already provides the removed functionality. Not reverted. |
| 2 | MAJOR | `PROMPT_ROLES = BUILT_IN_AGENT_LABELS` showed all 10 roles in prompt override UI, but the original had only 7 (excluding `ticket_updater`, `researcher`, `splitter`). The plan itself flagged this edge case and recommended the 7-role subset was intentional. | **Fixed**: Added `PROMPT_OVERRIDE_EXCLUDED_KEYS` to `sharedDefaults.js` and filtered in `setup.html`. |
| 3 | MAJOR | `renderKanbanAssignedAgentOptions` now shows all 10 roles instead of 7. Behavioral change not explicitly validated. | **Accepted**: All roles should be assignable to custom kanban columns. This is the correct behavior. |
| 4 | NIT | `<!-- SHARED_DEFAULTS_SCRIPT -->` was not present in committed `kanban.html` or `setup.html` — the plan's "Current State" section incorrectly stated it was already there. Implementation correctly added it. | Documented. No fix needed. |
| 5 | NIT | `dist/webview/sharedDefaults.js` timestamp older than HTML dist files, suggesting manual copy rather than clean webpack build. | `npm run compile` run during review; all dist files now consistent. |
| 6 | MAJOR | `BUILT_IN_KANBAN_ASSIGNABLE_AGENTS` and the entire kanban column modal removed from setup.html. This is feature removal, not refactor. | **Accepted**: Kanban panel already provides column management. Setup panel was redundant. |
| 7 | NIT | Extra unrelated changes in kanban.html (configurable clear-terminal delay, sort order changes, CODED_AUTO handling, drag-drop mode merge). | Documented. Not reverted. |
| 8 | NIT | Extra unrelated changes in implementation.html (Linear parent filter, ClickUp detail reset). | Documented. Not reverted. |

### Out-of-Scope Changes (Documented for Transparency)

The following changes were made alongside the planned refactor but were NOT specified in the plan:

**setup.html:**
- Removed "Custom Agents" tab (HTML, CSS, JS — ~500 lines deleted). Custom agent management is now only in the Kanban panel.
- Removed "Kanban" tab (HTML, CSS, JS — ~400 lines deleted). Kanban structure management is now only in the Kanban panel.
- Refactored Database tab from single-DB to multi-DB card layout (~200 lines new code). Supports per-workspace database configuration.
- Refactored Notion backup UI from static HTML to dynamically rendered per-DB cards.
- Removed `BUILT_IN_KANBAN_ASSIGNABLE_AGENTS`, `getKanbanAssignedAgentOptions`, `renderKanbanAssignedAgentOptions`, `openKanbanColumnModal`, `closeKanbanColumnModal`, `saveKanbanColumnDraft`, `showInlineCustomAgentForm`, `hideInlineCustomAgentForm`, `saveCustomAgentDraft`, `syncLocalKanbanStructureWithCustomAgents`, `getRenderableKanbanStructure`, `reorderVisibleKanbanStructure`, `renderKanbanStructureList`, `renderCustomAgentConfigList`, `sanitizeCustomAgentId`, `toCustomAgentRole`, `sanitizeKanbanColumnId`, `getProposedPath`.
- Added `renderDatabases()`, `lastAllDbPaths`, event delegation for database card interactions.

**kanban.html:**
- Added configurable clear-terminal delay (new `clearTerminalBeforePromptDelay` variable, UI input, message handlers).
- Changed non-planning column sort order: `_ts` (newest first) then `createdAt` descending.
- Improved CODED_AUTO handling in "Copy Prompt" button for collapsed coder lanes.
- Changed `columnDragDropModes` update from replace to merge (`Object.entries` loop).
- Added `<!-- SHARED_DEFAULTS_SCRIPT -->` placeholder (was missing from committed version).

**implementation.html:**
- Added `<!-- SHARED_DEFAULTS_SCRIPT -->` placeholder (was missing from committed version).
- Added Linear issue parent filter (`issue?.parentId` check).
- Added ClickUp detail panel state reset on plan change.

### Validation Results
- **Webpack build**: `npm run compile` — compiled successfully
- **TypeScript check**: `npx tsc --noEmit` — 2 pre-existing errors (import path extensions), 0 new errors
- **Structural invariants**: All verified (see verification output above)
- **Manual testing**: Step 7 still pending — requires VS Code runtime

### Remaining Risks
1. **Manual testing needed** (step 7): The webview HTML/JS has no automated tests. All three panels must be manually verified in VS Code.
2. **Out-of-scope changes lack specification**: The Custom Agents tab removal, Kanban tab removal, and Database UI refactor have no plan document defining their requirements. If they introduce regressions, there's no spec to validate against.
3. **`PROMPT_OVERRIDE_EXCLUDED_KEYS` maintenance**: If a new specialized role is added (e.g., `jules_operator`), it must be added to this set in `sharedDefaults.js` to avoid appearing in the prompt override UI. This is a minor ongoing maintenance burden.
