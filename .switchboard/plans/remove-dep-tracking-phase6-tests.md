# Remove Dependency Tracking — Phase 6: Tests & Dist Sync

## Goal

Remove all dependency-related test assertions and files, then sync updated webview files to `dist/webview/`. After this phase, the test suite is clean and the packaged extension is in sync.

## Problem Analysis

Phases 1-5 removed all dependency tracking code. This phase cleans up the test files that still assert dependency-related behaviour, and copies the updated webview files to the dist directory so the packaged extension reflects the changes.

## Metadata

- **Complexity:** 3
- **Tags:** refactor, test

## User Review Required

None — removal only, no new behaviour.

## Complexity Audit

### Routine
- Delete two standalone test files
- Remove dependency assertions from 4 existing test files
- Copy webview files to dist

### Complex / Risky
- **`prompts-tab-move-regression.test.js`** — the dependency assertions (lines 460–488) are interleaved with UAT and Setup tab assertions. Must remove only the Dependencies tab checks while preserving the UAT and Setup checks that follow. The test also checks for `data-tab="dependencies"` at lines 299–301 — must remove those without breaking the tab count assertions.
- **`kanban-default-prompt-previews.test.js`** — line 136 asserts `DEPENDENCY CHECK ENABLED` is absent when disabled, and line 157 asserts it's present when enabled. After Phase 2, the directive no longer exists, so the "enabled" test will fail. Must remove both assertions and the config toggle that enables it for the test.

## Edge-Case & Dependency Audit

- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** None — test-only changes and file copy.
- **Dependencies & Conflicts:** All previous phases must be complete. Tests will fail if run before Phases 1-5 are done.

## Dependencies

- Phase 1 (UI layer)
- Phase 2 (Prompt pipeline)
- Phase 3 (Service handlers)
- Phase 4 (TaskViewerProvider)
- Phase 5 (Data layer)

## Adversarial Synthesis

Key risk: Surgical test removal. Some tests have dependency assertions embedded within broader test functions. Removing too much could break unrelated assertions. Mitigation: read each test function carefully and remove only the dependency-specific lines, preserving the surrounding test structure.

## Proposed Changes

### Delete test files
- Delete `src/test/plan-dependency-parser.test.js` (252 lines)
- Delete `src/test/kanban-dependency-ordering.test.js` (231 lines)

### `src/test/prompts-tab-move-regression.test.js`
- Remove assertions checking for Dependencies tab button and `data-tab="dependencies"` (around lines 299–301)
- Remove assertions checking for "Plan Dependencies" subsection header (around lines 460–466)
- Remove assertions checking for `btn-copy-deps-prompt` in `.subsection-actions` (around lines 479–488)
- Preserve UAT and Setup tab assertions that follow

### `src/test/kanban-default-prompt-previews.test.js`
- Remove assertion that planner preview should not include `DEPENDENCY CHECK ENABLED` when disabled (line 136)
- Remove the config toggle `KanbanProvider.promptsConfig.dependencyCheckEnabled = true` (line 140 area)
- Remove assertion that planner preview should include `DEPENDENCY CHECK ENABLED` when enabled (line 157)

### `src/test/minimal-prompt.test.js`
- Remove assertion that prompt should not include `DEPENDENCY CHECK` when disabled (line 24)
- Remove assertion that prompt should not include `DEPENDENCY CHECK` by default (line 35)
- Remove `dependencyCheckEnabled: true` from test options and the assertion that prompt should include `DEPENDENCY CHECK ENABLED` when enabled (lines 44–49)

### `src/test/agent-prompt-builder-subagents.test.js`
- Remove `dependencyCheckEnabled: true` from test options (line 210)
- Remove assertion that custom workflow should append dependency check add-on (line 214)

### Dist sync
- Copy `src/webview/kanban.html` to `dist/webview/kanban.html`
- Copy `src/webview/sharedDefaults.js` to `dist/webview/sharedDefaults.js`

## Verification Plan

### Automated Tests
- Run the full test suite. All tests must pass with no dependency-related failures.
- Specifically verify: `prompts-tab-move-regression.test.js`, `kanban-default-prompt-previews.test.js`, `minimal-prompt.test.js`, `agent-prompt-builder-subagents.test.js`

### Manual Verification
- `ls dist/webview/` — confirm updated files are present
- Grep dist files for `dependency` — no matches expected

**Recommendation: Send to Intern** (Complexity 3 — surgical test removals and file copy)
