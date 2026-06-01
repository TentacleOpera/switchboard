# Watch and Sync Multiple Antigravity Brain Paths

Support concurrent use of the Antigravity chat sandbox (`~/.gemini/antigravity/`) and the Antigravity CLI sandbox (`~/.gemini/antigravity-cli/`) by extending the extension's brain watcher, session lister, and artifact fetcher to monitor both paths.

## User Review Required

> [!NOTE]
> The brain watcher and planning panel were originally designed to prioritize `antigravity-cli` on startup but only watch `antigravity` for plan mirroring. By changing these components to use array-based tracking, we will watch and list artifacts from both directories concurrently.

> [!IMPORTANT]
> The change requires modifying `src/test/brain-source-layout-regression.test.js` because the test uses static regex analysis to assert that the watcher is set up for a single `antigravityRoot`. We will update the test to expect multi-path loop watching.

## Proposed Changes

### Extension Services

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)

- Introduce `_getAntigravityRoots(): string[]` to return both candidate paths.
- Update `_getAntigravityPlanRoots()` and `_getAntigravitySourceKind()` to operate over all paths returned by `_getAntigravityRoots()`.
- Convert `_brainWatcher` to `_brainWatchers: vscode.FileSystemWatcher[]` and `_brainFsWatcher` to `_brainFsWatchers: fs.FSWatcher[]`.
- Update `_setupBrainWatcher()`, `reinitializeBrainWatcher()`, and `dispose()` to setup, track, and tear down watchers for all detected active brain roots.
- Update `_resolveBrainSourcePathForMirrorHash()` to check containment against all brain roots.
- Update `_getConfiguredPlanFolderValidationError()` and `seedBrainPlanBlacklistFromCurrentBrainSnapshot()` to check all roots.

#### [MODIFY] [LocalFolderService.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/LocalFolderService.ts)

- Introduce `detectAntigravityBrainPaths(): string[]` to return all paths in `_ANTIGRAVITY_BRAIN_PATHS` that exist.
- Update `listAntigravitySessions()` to aggregate sessions across all active paths.
- Update `fetchAntigravityArtifact()` to validate paths against all active brain roots.

#### [MODIFY] [PlanningPanelProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts)

- Convert `_antigravityWatcher` to `_antigravityWatchers: vscode.FileSystemWatcher[]`.
- Update `_setupAntigravityWatcher()` and `dispose()` to manage watchers for all paths returned by `detectAntigravityBrainPaths()`.

---

### Tests

#### [MODIFY] [brain-source-layout-regression.test.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/test/brain-source-layout-regression.test.js)

- Update the third regression test's regex to expect a multi-path watch setup (e.g. checking `roots` loop or `_getAntigravityRoots` iteration).

## Verification Plan

### Automated Tests
- Run `npm run test` or `npx mocha src/test/brain-source-layout-regression.test.js` to ensure the regression tests pass.

### Manual Verification
- Start the extension in Debug mode.
- Enable "Antigravity Brain" in the settings / UI.
- Verify that sessions from both `~/.gemini/antigravity/brain/` and `~/.gemini/antigravity-cli/brain/` appear in the ARTIFACTS tab.
- Edit an `implementation_plan.md` in both locations and verify they both successfully mirror to the workspace `.switchboard/plans/` directory.
