# Switchboard Stitch SDK Feature Completion: OAuth Authentication & Design System CRUD

## Goal

1. Add **dual authentication** to the Stitch integration: support both API key (existing) and OAuth (`accessToken`) flows via `StitchToolClient`.
2. Add **full Design System lifecycle management** to the Design panel: create, update, list, and apply Stitch design systems to project screens.
3. Place Design System CRUD in the existing **Design System tab** (`design-content`), reusing the Stitch project selection from the Stitch tab via shared webview state.

### Problem Analysis & Root Cause

Previous agents incorrectly claimed that several Stitch SDK capabilities were "impossible" to integrate. The root cause was a shallow reading of the SDK surface — they only explored the high-level `stitch` singleton and missed the `StitchToolClient` dependency-injection pattern, the `DesignSystem` class lifecycle, and the `project.upload()` image pipeline. Switchboard currently uses only the screen-generation subset of the SDK (projects, screens, generate, edit, variants, getHtml, getImage) and a read-only `listDesignSystems()` call. This leaves significant value on the table:

1. **Auth:** Only API-key auth is supported, blocking team/enterprise use cases where sharing a raw key is unacceptable. Additionally, the current API key banner is a one-time setup flow — once saved, it is hidden and there is no UI to change or clear the key.
2. **Design Systems:** `listDesignSystems()` is used only to dump tokens into `DESIGN.md`. There is no UI to create, update, or apply design systems to screens.

The user has scoped this plan to **OAuth** and **Design System CRUD** only.

## Metadata
- **Complexity:** 7
- **Tags:** frontend, backend, api, ui, feature, auth

## User Review Required
- **Auth mode default:** Confirm `apiKey` remains the default for backward compatibility.
- **OAuth token storage:** Confirm `switchboard.stitch.accessToken` stored in VS Code settings (application scope) is acceptable. VS Code does not encrypt settings values by default; users should treat `accessToken` as they treat the existing `apiKey`.
- **Design System sub-tab placement:** Confirm adding a sub-tab switcher inside the `design-content` tab (Local Docs / Stitch Design Systems) is acceptable UX.
- **Apply screen selection flow:** Confirm the proposed "screen-selection modal" for applying design systems is the desired UX over, e.g., a multi-select list inline.

## Complexity Audit

### Routine
- Adding new VS Code settings (`authMode`, `accessToken`) to `package.json`
- Extending existing webview state and message handler patterns
- Reusing existing `_stitchOperationLock` for mutation handlers
- Adding `postMessage` / `vscode.postMessage` wiring for new commands
- CSS styling for sub-tabs, cards, and modals in the existing dark-theme design

### Complex / Risky
- **Auth cache invalidation:** `_stitchSdkPromise` is a module-level singleton. Switching auth modes requires nullifying it and coordinating with the `extension.ts` configuration-change listener.
- **Dual-auth validation logic:** Replacing the monolithic `hasKey` check with a mode-aware `_validateStitchAuth()` helper that handles both API-key (env-based) and OAuth (`StitchToolClient`-based) flows.
- **`sourceScreen` data mapping for Apply:** The SDK's `apply_design_system` requires `SelectedScreenInstance[]` (`{ id, sourceScreen }`). `stitch.project(id)` returns a `Project` whose `data` is the **string ID itself** (constructor signature is `new Project(client, data)` and `Stitch.project(id)` calls `new Project(this.client, id)` — verified in `generated/src/stitch.js:36-37`), so `project.data.screenInstances` is `undefined`. Fetching `screenInstances` requires an explicit `get_project` MCP tool call, which is not currently used anywhere in the codebase.
- **Private/protected client — Apply cannot borrow the sdk's client (VERIFIED):** The plan's `client.callTool("get_project", ...)` step has no reachable `client`. `Stitch.client` is declared `private` and `Project.client` is `protected` (verified in `generated/src/stitch.d.ts` and `generated/src/project.d.ts`). In OAuth mode the handler already constructs its own `StitchToolClient`, but in **API-key mode (the default)** there is no client object to reach. The Apply handler MUST instantiate its **own** `StitchToolClient` to call `get_project`: `new StitchToolClient()` (reads `STITCH_API_KEY` from env, which `_setupStitchAuth` sets in apiKey mode) or `new StitchToolClient({ accessToken })` in OAuth mode. Without this, Apply is broken for all existing (API-key) users.
- **`SelectedScreenInstance.id` is required but source `id` is optional (VERIFIED):** `SelectedScreenInstance` requires `{ id: string; sourceScreen: string }` (both non-optional, `generated/src/types.generated.d.ts:215`), but the `ScreenInstance[]` returned by `get_project` has BOTH `id?` and `sourceScreen?` optional (`generated/src/types.generated.d.ts` `ScreenInstance`). The mapping must filter out instances with no `id` AND restrict to real screens (`type === 'SCREEN_INSTANCE'` or absent), excluding `DESIGN_SYSTEM_INSTANCE` / `GROUP_INSTANCE` entries.
- **Sub-tab DOM insertion in `design-content`:** The existing tab has a rigid `.content-row > #tree-pane-design + .preview-panel-wrapper` layout. Inserting a sub-tab switcher without breaking the existing tree+preview layout requires careful HTML/CSS placement.
- **Read vs. write concurrency:** `stitchListDesignSystems` is read-only and must NOT acquire `_stitchOperationLock`, unlike mutation handlers (`create`, `update`, `apply`).

## Edge-Case & Dependency Audit

### Race Conditions
- If the user rapidly toggles auth mode in the webview, the extension host may nullify `_stitchSdkPromise` while an in-flight Stitch operation is using the old SDK instance. Mitigation: the existing `_stitchOperationLock` already serializes mutations; reads that don't use the lock are safe because the SDK instance itself is stateless.

### Security
- `accessToken` is stored in VS Code `ConfigurationTarget.Global` (application-scoped), identical to the existing `apiKey`. VS Code settings are not encrypted at rest. This is an inherited risk from the existing auth model.
- In OAuth mode, `process.env.STITCH_API_KEY` must be explicitly cleared to prevent the SDK from silently falling back to the API key env var.

### Side Effects
- `_stitchSdkPromise` is module-scoped in `DesignPanelProvider.ts`. It is NOT reset on panel close/reopen. Changing auth settings via the webview must nullify it so the next `loadStitch()` call instantiates a fresh SDK.
- The `extension.ts` configuration-change listener (`e.affectsConfiguration('switchboard.stitch.apiKey')`) currently only posts `stitchApiKeyStatus`. It must be extended to also watch `authMode` and `accessToken`, and to nullify `_stitchSdkPromise`.

### Dependencies & Conflicts
- **File:** `src/extension.ts` — MUST be updated for the new configuration listener. It is currently missing from the file table.
- **SDK behavior (VERIFIED against `node_modules/@google/stitch-sdk/dist`):** `StitchToolClient` is exported from the index and its config accepts `accessToken?` (`spec/client.d.ts` `StitchConfigSchema`). `new Stitch(client)` is the constructor (`generated/src/stitch.d.ts`). `Project.createDesignSystem`, `listDesignSystems`, `designSystem(id)` and `DesignSystem.update(input)` / `apply(SelectedScreenInstance[])` all exist as typed. `DesignSystemInput.designTokens` is a `string`. `get_project` is a real tool whose input is `{ name: "projects/{id}" }` and whose response includes optional `screenInstances?: ScreenInstance[]`. `project.listDesignSystems()` is already called today in the `stitchOpenManifest` and `stitchDownloadPalette` handlers (so the read path is proven).
- **`DesignSystemInput` shape (VERIFIED):** `designTokens` is a `string` field, NOT a JSON object. The "JSON editor" modal must account for this (e.g., separate fields for `displayName`, `styleGuidelines`, and a `designTokens` textarea that accepts a JSON-string value). **Clarification:** `DesignSystemInput` also exposes a fourth field, `theme?: DesignTheme` (a structured object of fonts/color-modes/roundness). This is intentionally OUT OF SCOPE for v1 — the create/edit modal will not set it, and create/update calls will leave `theme` undefined. This is a deliberate omission, not an oversight.
- **Auth-gating is net-new, not relocation (VERIFIED):** Today only `_handleMessage`'s top-level `hasKey` (line 951) is consumed by exactly ONE handler — `stitchListProjects` (line 1252) — plus the status post at line 969. Other Stitch handlers (`stitchGenerate`, `stitchGetProjectScreens`, etc.) do NOT gate on `hasKey` today; they call `loadStitch()` and rely on the env var. Therefore the plan's "per-handler `_setupStitchAuth()` checks" are **net-new gating** added to those handlers, not a mechanical relocation of one check. The new design-system handlers (`list`/`create`/`update`/`apply`) especially must each call `_setupStitchAuth()` and bail on `!valid`.

## Dependencies
- No external session dependencies. This plan is self-contained.

## Adversarial Synthesis

Key risks: (1) the Apply flow's `get_project` call has no reachable client — `Stitch.client`/`Project.client` are private/protected, so the handler must instantiate its OWN `StitchToolClient` (critical in API-key mode, the default, where no client is otherwise constructed); (2) `SelectedScreenInstance` requires `id`+`sourceScreen` but the `get_project` response makes both optional, so the mapping must filter missing-`id`/non-screen instances before mapping; (3) auth cache invalidation requires coordination across `DesignPanelProvider.ts` and `extension.ts` (originally omitted `extension.ts`); (4) the `apply` flow cannot use `project.data.screenInstances` because `stitch.project(id)` sets `data` to the string ID, requiring `get_project`; (5) `_stitchOperationLock` must NOT wrap `list` (read-only). Mitigations: instantiate a dedicated `StitchToolClient` per the auth mode and call `callTool("get_project", { name: "projects/" + projectId })`; filter `screenInstances` to truthy-`id` real screens then map with `sourceScreen || id`; nullify `_stitchSdkPromise` in both the `stitchSaveAuthConfig` handler and the `extension.ts` config listener; restrict the lock to mutation handlers only.

## Proposed Changes

### OAuth Authentication
- [R1] New setting `switchboard.stitch.authMode` with enum values `apiKey` | `oauth`. Default: `apiKey`.
- [R2] New sensitive setting `switchboard.stitch.accessToken` (application-scoped).
- [R3] The Stitch tab's API key banner must become a **persistent auth configuration panel** with a mode toggle.
- [R4] In API-key mode: behavior identical to today (`stitch.apiKey` setting + `STITCH_API_KEY` env).
- [R5] In OAuth mode: `loadStitch()` must instantiate `new Stitch(new StitchToolClient({ accessToken }))`.
- [R6] Auth credentials must be validated before any Stitch API call. A new `stitchValidateAuth` message handler should perform a lightweight ping (e.g., `sdk.projects()`).
- [R7] The auth configuration panel must show current auth status (configured / not configured / invalid).
- [R8] The auth configuration panel must remain **always accessible** — not a one-time setup banner. A "Configure Auth" button (e.g., gear icon) must be present in the Stitch tab controls to toggle the panel open/closed at any time.

### Design System CRUD
- [R9] A new section in the `design-content` tab for **Stitch Design Systems**.
- [R10] The section must display the currently selected Stitch project (read from shared `state.selectedStitchProjectId`). If no project is selected in the Stitch tab, show a link/button to switch to the Stitch tab.
- [R11] **List:** Fetch and display design systems for the selected project using `project.listDesignSystems()`.
- [R12] **Create:** A button to create a new design system. Opens a modal with a JSON editor for the design system object. Calls `project.createDesignSystem(designSystem)`.
- [R13] **Update:** For each listed design system, an "Edit" button that opens the same JSON editor pre-populated with current data. Calls `designSystem.update(designSystem)`.
- [R14] **Apply:** For each listed design system, an "Apply to Screens" button. Opens a modal showing the project's screens. User selects screens; the extension calls `designSystem.apply(project.data.screenInstances)` where `screenInstances` is `{ id: string; sourceScreen: string }[]`.
- [R15] After any mutation (create, update, apply), the design system list must refresh automatically.

### `package.json`
- **Context:** Extension manifest already contains `switchboard.stitch.apiKey` and related settings.
- **Logic:** Add `switchboard.stitch.authMode` (enum `apiKey` | `oauth`, default `apiKey`) and `switchboard.stitch.accessToken` (type `string`, default `""`, scope `application`). Update `switchboard.stitch.apiKey` description to clarify it is used only in `apiKey` mode.
- **Edge Cases:** Existing users with `apiKey` set must see no behavioral change; the `authMode` default ensures this.

### `src/extension.ts`
- **Context:** Contains the `onDidChangeConfiguration` listener that currently only watches `switchboard.stitch.apiKey` (line ~1856).
- **Logic:** Extend the listener to also watch `switchboard.stitch.authMode` and `switchboard.stitch.accessToken`. When any of the three settings change, call a new exported helper (e.g., `invalidateStitchSdkCache()`) that nullifies `_stitchSdkPromise` in `DesignPanelProvider.ts`, then post `stitchAuthStatus` to the webview if the design panel is open.
- **Edge Cases:** If the user edits settings.json manually while a Stitch operation is in progress, the next `loadStitch()` call will get a fresh instance; in-flight operations use the already-resolved SDK instance and are unaffected.

### `src/services/DesignPanelProvider.ts`
- **Context:** Module-level `_stitchSdkPromise` caches the `stitch` singleton. `_setupStitchApiKey()` sets `process.env.STITCH_API_KEY` and returns a boolean. `_handleMessage()` evaluates `hasKey` once at the top. `_stitchOperationLock` guards mutations.
- **Logic:**
  1. Replace `_setupStitchApiKey()` with `_setupStitchAuth(): { mode: 'apiKey' | 'oauth'; valid: boolean }`. In `apiKey` mode, read `switchboard.stitch.apiKey` or `STITCH_API_KEY` env, set `process.env.STITCH_API_KEY`, return `valid: true`. In `oauth` mode, read `switchboard.stitch.accessToken`; if present, clear `process.env.STITCH_API_KEY` (prevent fallback) and return `valid: true`.
  2. Replace `loadStitch()` with `loadStitch(mode, accessToken)`: if `mode === 'apiKey'`, use existing `import('@google/stitch-sdk').then(m => m.stitch)`; if `mode === 'oauth'`, import the SDK then return `new Stitch(new StitchToolClient({ accessToken }))`.
  3. Export a helper `invalidateStitchSdkCache()` that sets `_stitchSdkPromise = undefined`.
  4. In `_handleMessage`, replace the top-level `hasKey` with per-handler auth validation. All handlers that call Stitch (`stitchListProjects`, `stitchGetProjectScreens`, `stitchGenerate`, etc.) must call `_setupStitchAuth()` and return an error if `!valid`.
  5. Add `stitchSaveAuthConfig` handler: update both settings via `config.update()`, nullify `_stitchSdkPromise`, post `stitchAuthStatus`.
  6. Add `stitchValidateAuth` handler: call `_setupStitchAuth()`, instantiate SDK via `loadStitch()`, call `sdk.projects()`, catch errors, post `{ type: 'stitchAuthStatus', valid, error }`.
  7. Add `stitchListDesignSystems` handler (read-only, NO `_stitchOperationLock`): get project, call `project.listDesignSystems()`, post results.
  8. Add `stitchCreateDesignSystem` handler (locked): call `project.createDesignSystem(designSystem)`, post success, then trigger list refresh.
  9. Add `stitchUpdateDesignSystem` handler (locked): get design system via `project.designSystem(assetId)`, call `designSystem.update(designSystem)`, post success, then trigger list refresh.
  10. Add `stitchApplyDesignSystem` handler (locked):
      - **Instantiate a dedicated `StitchToolClient`** (do NOT attempt to read the sdk's `client` — it is `private`/`protected`). In apiKey mode: `new StitchToolClient()` (picks up `STITCH_API_KEY` set by `_setupStitchAuth`). In OAuth mode: `new StitchToolClient({ accessToken })`. Import `StitchToolClient` from `@google/stitch-sdk`.
      - Call `await dedicatedClient.callTool("get_project", { name: "projects/" + projectId })` (input arg `name` is `projects/{id}`, verified against the SDK tool schema) to obtain `screenInstances`.
      - **Filter then map:** keep only instances where `instance.id` is truthy AND (`instance.type === 'SCREEN_INSTANCE'` OR `instance.type` is undefined) — excludes `DESIGN_SYSTEM_INSTANCE` / `GROUP_INSTANCE`. Then map: `{ id: instance.id, sourceScreen: instance.sourceScreen || instance.id }`. This guarantees both required fields of `SelectedScreenInstance` are populated.
      - Get the design system handle (`project.designSystem(assetId)`), call `designSystem.apply(selectedScreenInstances)`, format the returned `Screen[]`, and post `stitchScreensReady` so the gallery updates.
- **Edge Cases:** Source `ScreenInstance.id` AND `sourceScreen` are BOTH optional in the `get_project` response, but `SelectedScreenInstance` requires both — the filter (drop missing `id`) plus the `sourceScreen || id` fallback prevent SDK rejection. `apply` returns updated `Screen[]`; the handler should format them and post `stitchScreensReady` so the gallery updates. If filtering leaves zero valid screens, post a `stitchError` ("no applicable screens") rather than calling `apply` with an empty array.

### `src/webview/design.html`
- **Context:** `stitch-content` has `#stitch-api-banner` (lines ~3702). `design-content` has `#controls-strip-design` + `.content-row` with `#tree-pane-design` and `.preview-panel-wrapper`.
- **Logic:**
  1. In `stitch-content`: replace `#stitch-api-banner` with a collapsible `#stitch-auth-panel`. Add mode toggle (radio), API-key input (password), accessToken input (password), status indicator, and save button. Add a gear icon button `#btn-configure-auth` to `#controls-strip-stitch` that toggles the panel.
  2. In `design-content`: insert a sub-tab switcher bar immediately after `#controls-strip-design` and before `.content-row`. The switcher has two buttons: "Local Docs" and "Stitch Design Systems". Clicking switches visibility of `#design-local-panel` (wrap existing `.content-row`) and `#design-systems-panel` (new). The new panel contains: project name display, "Create New" button, `#stitch-design-systems-list` container, and modals for create/edit (JSON fields) and apply (screen-selection checklist).
- **Edge Cases:** If `state.selectedStitchProjectId` is empty, show a "Go to Stitch tab to select a project" prompt instead of the list.

### `src/webview/design.js`
- **Context:** State object has `stitchApiKeyConfigured`, `selectedStitchProjectId`, etc. Message handlers in the big `switch` block process `stitchApiKeyStatus`, `stitchProjectsReady`, etc.
- **Logic:**
  1. Add state keys: `stitchAuthMode`, `stitchAccessToken`, `stitchAuthValid`, `designSystemSubTab`, `stitchDesignSystems`.
  2. Wire `#btn-configure-auth` to toggle `#stitch-auth-panel` display.
  3. On auth mode toggle, show/hide the relevant credential input. On save, post `stitchSaveAuthConfig` with `{ mode, apiKey, accessToken }`.
  4. Handle `stitchAuthStatus`: update state and UI indicators.
  5. Handle `stitchDesignSystemsReady`: populate list container.
  6. Add `renderStitchDesignSystems()`, `openDesignSystemModal()`, `openApplyModal()` helpers.
  7. On mutation success (`stitchDesignSystemCreated`, `stitchDesignSystemUpdated`, `stitchDesignSystemApplied`), auto-post `stitchListDesignSystems` to refresh.
- **Edge Cases:** Persist `stitchAuthMode` and `stitchAccessToken` in `vscode.setState()` so the panel remembers them across reloads, BUT do NOT persist sensitive values if VS Code state storage is not secure. (Clarification: the existing pattern stores UI state, not credentials; credentials live in VS Code settings only.)

## Architecture & Approach

### Authentication

The current `loadStitch()` function eagerly caches the `stitch` singleton:

```typescript
function loadStitch(): Promise<any> {
    if (!_stitchSdkPromise) {
        _stitchSdkPromise = import('@google/stitch-sdk').then(m => m.stitch);
    }
    return _stitchSdkPromise;
}
```

For OAuth, we must **conditionally instantiate** the `Stitch` class with a `StitchToolClient`:

```typescript
import { Stitch, StitchToolClient } from "@google/stitch-sdk";
const client = new StitchToolClient({ accessToken });
const sdk = new Stitch(client);
```

The plan is to replace `loadStitch()` with `loadStitch(authMode, accessToken)` that:
1. If `authMode === 'apiKey'`: uses the existing singleton path (sets `STITCH_API_KEY` env, returns `m.stitch`).
2. If `authMode === 'oauth'`: returns `new Stitch(new StitchToolClient({ accessToken }))`.

**Cache invalidation:** `_stitchSdkPromise` is a module-level variable, not a Map. It cannot be "keyed." When auth settings change, the promise must be explicitly set to `undefined` so the next `loadStitch()` call re-instantiates. This nullification must happen in two places: (1) the `stitchSaveAuthConfig` message handler in `DesignPanelProvider.ts`, and (2) the `onDidChangeConfiguration` listener in `extension.ts`.

**Credential storage:** API key is already stored in VS Code settings (`switchboard.stitch.apiKey`). OAuth `accessToken` will follow the same pattern (`switchboard.stitch.accessToken`). The webview will post messages to save these, identical to `stitchSaveApiKey`.

### Design System CRUD

The `design-content` tab currently manages **local design documents** (markdown files in workspace folders). Adding Stitch design system management here creates a dual-purpose tab. The cleanest UI pattern is a **sub-tab switcher** within `design-content`:
- **Local Docs** (existing)
- **Stitch Design Systems** (new)

This avoids crowding the existing tree-pane + preview layout.

**Shared state access:** The `design-content` tab JavaScript runs in the same webview context as `stitch-content`. `state.selectedStitchProjectId` is already available.

**Backend handlers:** New message types in `DesignPanelProvider.ts`:
- `stitchListDesignSystems` → `project.listDesignSystems()` (read-only, does NOT use `_stitchOperationLock`)
- `stitchCreateDesignSystem` → `project.createDesignSystem()` (locked mutation)
- `stitchUpdateDesignSystem` → `designSystem.update()` (locked mutation)
- `stitchApplyDesignSystem` → `designSystem.apply(selectedScreenInstances)` (locked mutation)

For `apply`, the extension host must first fetch project metadata via a **dedicated** `StitchToolClient` instance (`new StitchToolClient()` in apiKey mode / `new StitchToolClient({ accessToken })` in OAuth mode — the sdk's internal client is `private`/`protected` and cannot be reused) calling `callTool("get_project", { name: "projects/" + projectId })` to obtain `screenInstances`, then filter to instances with a truthy `id` and screen-type and map each to `{ id: instance.id, sourceScreen: instance.sourceScreen || instance.id }` because `stitch.project(id)` sets `data` to the string ID (so `project.data.screenInstances` is undefined).

## Implementation Steps

### Phase 1: OAuth Authentication

1. **Package manifest** (`package.json`):
   - Add `switchboard.stitch.authMode` (enum `apiKey` | `oauth`, default `apiKey`).
   - Add `switchboard.stitch.accessToken` (type `string`, default `""`, scope `application`).
   - Update `switchboard.stitch.apiKey` description to clarify it's for API-key mode.

2. **Extension host bootstrap** (`src/extension.ts`):
   - Extend `onDidChangeConfiguration` listener (~line 1856) to watch `switchboard.stitch.authMode` and `switchboard.stitch.accessToken`.
   - On change, call an exported `invalidateStitchSdkCache()` helper that nullifies `_stitchSdkPromise` in `DesignPanelProvider.ts`, then post `stitchAuthStatus` if the design panel is open.

3. **Extension host** (`src/services/DesignPanelProvider.ts`):
   - Replace `loadStitch()` with `loadStitch(authMode, accessToken?)` that conditionally returns `m.stitch` or `new Stitch(new StitchToolClient({ accessToken }))`.
   - Replace `_setupStitchApiKey()` with `_setupStitchAuth()` returning `{ mode, valid }`. In OAuth mode, clear `process.env.STITCH_API_KEY` to prevent fallback.
   - Export `invalidateStitchSdkCache()` helper.
   - Remove the top-level `hasKey` from `_handleMessage`; add per-handler auth checks.
   - Add `stitchSaveAuthConfig` handler: update settings, nullify `_stitchSdkPromise`, post `stitchAuthStatus`.
   - Add `stitchValidateAuth` handler: instantiate SDK, call `sdk.projects()`, post `{ valid, error }`.

4. **Webview HTML** (`src/webview/design.html`):
   - Replace `#stitch-api-banner` with a collapsible `#stitch-auth-panel` containing mode toggle, API-key input, accessToken input, status indicator, and save button.
   - Add a "Configure Auth" gear icon button to `#controls-strip-stitch` that toggles the panel.

5. **Webview JS** (`src/webview/design.js`):
   - Add state keys: `stitchAuthMode`, `stitchAccessToken`.
   - Wire auth mode toggle to show/hide credential inputs.
   - On save, post `stitchSaveAuthConfig` with `{ mode, apiKey, accessToken }`.
   - Handle `stitchAuthStatus` to update UI indicators.

### Phase 2: Design System CRUD

1. **Extension host** (`src/services/DesignPanelProvider.ts`):
   - Add `stitchListDesignSystems` handler (read-only, NO lock): call `project.listDesignSystems()`, post `stitchDesignSystemsReady`.
   - Add `stitchCreateDesignSystem` handler (locked): call `project.createDesignSystem(designSystem)`, post success, then re-fetch list.
   - Add `stitchUpdateDesignSystem` handler (locked): call `project.designSystem(assetId).update(designSystem)`, post success, then re-fetch list.
   - Add `stitchApplyDesignSystem` handler (locked): instantiate a **dedicated** `StitchToolClient` (`new StitchToolClient()` in apiKey mode / `new StitchToolClient({ accessToken })` in OAuth mode — the sdk's own client is `private`/`protected` and cannot be borrowed); call `dedicatedClient.callTool("get_project", { name: "projects/" + projectId })` to get `screenInstances`; filter to instances with a truthy `id` and screen-type, map to `SelectedScreenInstance[]`; call `designSystem.apply(selectedScreenInstances)`; post `stitchScreensReady` with updated screens.

2. **Webview HTML** (`src/webview/design.html`):
   - Inside `design-content`, insert a sub-tab switcher bar immediately after `#controls-strip-design` and before `.content-row`.
   - Wrap existing `.content-row` inside `#design-local-panel`.
   - Add `#design-systems-panel` (hidden by default) containing: project name display (or "no project selected" prompt), "Create New" button, `#stitch-design-systems-list` container, and modals for create/edit (fields: `displayName`, `styleGuidelines`, `designTokens` string) and apply (screen-selection checklist from cached screens).

3. **Webview JS** (`src/webview/design.js`):
   - Add state keys: `designSystemSubTab`, `stitchDesignSystems`.
   - Add `renderStitchDesignSystems()`, `openDesignSystemModal()`, `openApplyModal()` helpers.
   - Wire create/update/apply buttons to post messages.
   - Handle `stitchDesignSystemsReady` to refresh list.
   - On mutation success messages, auto-post `stitchListDesignSystems` to refresh.

4. **Webview CSS** (`src/webview/design.html` inline styles):
   - Styles for sub-tab switcher.
   - Styles for design system cards.
   - Styles for design system modal (form fields).
   - Styles for screen-selection modal.

### Phase 3: Validation

1. **Manual testing:**
   - Test API-key mode still works (regression).
   - Test OAuth mode with dummy credentials (verify correct SDK instantiation).
   - Test design system CRUD end-to-end: create → list → update → apply.
   - Test concurrent operation locking.

## Files to Modify

| File | Changes |
|------|---------|
| `package.json` | New settings: `stitch.authMode`, `stitch.accessToken`; update `stitch.apiKey` description |
| `src/extension.ts` | Extend config-change listener to watch `authMode`/`accessToken`; nullify `_stitchSdkPromise` |
| `src/services/DesignPanelProvider.ts` | Auth-aware `loadStitch()`, `_setupStitchAuth()`, `invalidateStitchSdkCache()`, `stitchSaveAuthConfig`, `stitchValidateAuth`, `stitchListDesignSystems`, `stitchCreateDesignSystem`, `stitchUpdateDesignSystem`, `stitchApplyDesignSystem` |
| `src/webview/design.html` | Auth panel redesign (`#stitch-auth-panel`), Design System sub-tab UI (`#design-systems-panel`), modals |
| `src/webview/design.js` | Auth state management (`stitchAuthMode`, `stitchAccessToken`), Design System CRUD wiring, modal helpers |

## Risks & Edge Cases

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Auth cache invalidation** | Medium | `_stitchSdkPromise` is a module-level variable, not a Map. It must be explicitly set to `undefined` in both `stitchSaveAuthConfig` handler and `extension.ts` config listener. |
| **User cannot change API key once saved** | Low | Current system hides the banner after save with no reopen button. The new persistent auth panel with a toggle button fixes this edge case. |
| **Design Systems tab depends on Stitch tab state** | Low | `state.selectedStitchProjectId` is shared in the same webview. If the user hasn't opened the Stitch tab, the state may not be hydrated. Add a "Select Project" fallback in the Design Systems sub-tab. |
| **Apply `sourceScreen` data source** | Medium | `stitch.project(id)` sets `data` to the string ID. `screenInstances` must be fetched via `callTool("get_project", { name: "projects/"+id })`. Fallback to `instance.id` if `sourceScreen` is undefined. |
| **Apply has no reachable SDK client (API-key mode)** | High | `Stitch.client`/`Project.client` are `private`/`protected`. The Apply handler must construct its OWN `StitchToolClient` (`new StitchToolClient()` in apiKey mode after env is set; `{ accessToken }` in OAuth mode). Otherwise Apply is broken for all default-mode users. |
| **`SelectedScreenInstance.id` missing** | Medium | Source `ScreenInstance.id` is optional; `SelectedScreenInstance.id` is required. Filter out instances with no `id` and non-`SCREEN_INSTANCE` types before mapping; bail with `stitchError` if zero remain. |
| **`DesignSystemInput.theme` unset** | Low | `theme` (structured `DesignTheme`) is a real 4th input field but intentionally out of scope for v1; create/update leave it undefined. Documented as a Clarification, not a regression. |
| **OAuth + API-key env collision** | Medium | `_setupStitchAuth()` must clear `process.env.STITCH_API_KEY` when `authMode === 'oauth'` to prevent the SDK from falling back to the env var. |
| **Read-operation locking** | Low | Only mutation handlers (`create`, `update`, `apply`) acquire `_stitchOperationLock`. `listDesignSystems` is read-only and must remain unlocked. |
| **Missing `extension.ts` update** | Medium | The configuration listener lives in `extension.ts`. It was omitted from the original file table. Extend it to watch `authMode` and `accessToken`. |

## Verification Plan

### Automated Tests
- **Skip:** Do not run `tsc`, `jest`, or any compilation/test suite during this session. The user will run tests separately.

### Manual Testing Checklist
1. **Regression — API-key mode**
   - Open Design panel → Stitch tab.
   - Ensure existing API-key workflow (save key, list projects, generate screen) still works.
   - Verify `_stitchSdkPromise` is not nullified unnecessarily.
2. **OAuth mode instantiation**
   - Switch auth mode to OAuth, enter a dummy `accessToken`.
   - Click "Validate Auth"; verify `stitchValidateAuth` calls `sdk.projects()` and posts correct status.
   - Verify `process.env.STITCH_API_KEY` is cleared when mode switches to OAuth.
3. **Auth cache invalidation**
   - With panel open, change `accessToken` in VS Code settings.json.
   - Verify `extension.ts` listener triggers and nullifies `_stitchSdkPromise`.
   - Verify next Stitch operation uses the new token.
4. **Design System CRUD**
   - Select a project in the Stitch tab.
   - Switch to Design System sub-tab in `design-content`.
   - Create a design system; verify list refreshes.
   - Edit the design system; verify changes persist.
   - Click "Apply to Screens"; verify the modal shows cached screens.
   - Apply to one screen; verify `stitchApplyDesignSystem` instantiates its own `StitchToolClient`, fetches `get_project` first, filters out non-screen / missing-`id` instances, then calls `apply()`.
   - Verify Apply works in **API-key mode** specifically (the dedicated-client gap manifests only there — OAuth mode happens to construct a client already).
5. **Concurrent operation safety**
   - Start a screen generation (locks `_stitchOperationLock`).
   - While generating, attempt to list design systems; verify the list still loads (no lock).
   - Attempt to create a design system while generating; verify it is blocked until generation completes.
6. **Edge case — missing `sourceScreen`**
   - Apply a design system to a project where some `ScreenInstance` lacks `sourceScreen`.
   - Verify the fallback to `instance.id` prevents SDK rejection.

## Recommendation

**Send to Lead Coder** — Complexity 7. The feature spans 5 files, introduces a new auth pattern (`StitchToolClient`), requires careful cache invalidation across `DesignPanelProvider.ts` and `extension.ts`, and depends on an undocumented `get_project` tool call to obtain `screenInstances` for the Apply flow.
