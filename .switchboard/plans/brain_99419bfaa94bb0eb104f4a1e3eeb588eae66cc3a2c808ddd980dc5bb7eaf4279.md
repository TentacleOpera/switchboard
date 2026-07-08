# Feature A · A2b — Per-Verb Handler Burn-Down (All Panels)

This plan implements the structural framework for the remaining 600-arm burn-down across all panels (Kanban, Planning, Design, Setup, TaskViewer) and establishes the CI parity gate to track and enforce coverage.

## Proposed Changes

### 1. Unified Service Infrastructure & Routing
We will set up the generic POST endpoints on `LocalApiServer` for all panels:
- `POST /kanban/verb/<name>` (already exists)
- `POST /planning/verb/<name>`
- `POST /design/verb/<name>`
- `POST /setup/verb/<name>`
- `POST /taskviewer/verb/<name>`

We will scaffold the service skeletons:
- `src/services/planningService.ts`
- `src/services/designService.ts`
- `src/services/setupService.ts`
- `src/services/taskViewerService.ts`

Each provider (e.g. `PlanningPanelProvider`, `SetupPanelProvider`) will get a `handleServiceVerb` dispatcher, lazy service initialization, and delegation logic identical to `KanbanProvider`.

### 2. CI Parity Gate
We will implement the parity check script:
- **`scripts/check-protocol-parity.js`**:
  - Reads `protocol-catalog.json`.
  - Scans each provider's `handleServiceVerb` switch block to verify which verbs are implemented.
  - Lists exactly which verbs are mapped vs remaining.
  - Returns a non-zero exit status if there are catalogued verbs that do not have service endpoints (optionally configured to allow warning/soft mode until all 600 are completed, or strict for already-migrated services).
  - Add to `package.json` as `npm run parity:check` and wire it into the GitHub Actions workflow `.github/workflows/integration-tests.yml`.

### 3. Core Verb Migrations
We will migrate a batch of core verbs across multiple panels to verify and test the multi-panel service plumbing:
- **Kanban panel**: `addProject`, `deleteProject`, `setProjectFilter`, `setAutomationMode`, `startOrchestrator`, `stopOrchestrator`, `selectWorkspace`.
- **Setup panel**: `getStartupCommands`, `saveStartupCommands`, `getSetting`, `saveSetting`.
- **Planning panel**: `getRemoteConfig`, `setRemoteConfig`.

## Verification Plan

### Automated Tests
- Run `npm run parity:check` to list coverage and verify the script correctly detects implemented vs unimplemented verbs.
- Run `npm run compile` to verify TypeScript compilation.
