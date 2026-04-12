# Design Comprehensive Test Suite for Notion, ClickUp, and Linear Integrations

## Goal
Design and implement a comprehensive test suite for the Notion, ClickUp, and Linear integration services to ensure reliability, catch regressions, and validate all critical functionality.

## Metadata
**Tags:** backend, devops
**Complexity:** 7

## Context
The Switchboard extension has three external integrations:
- **Notion** (`NotionFetchService.ts`): Fetches design documents from Notion pages and converts them to markdown
- **ClickUp** (`ClickUpSyncService.ts`): Syncs kanban plans to ClickUp tasks and imports tasks from ClickUp
- **Linear** (`LinearSyncService.ts`): Syncs kanban plans to Linear issues and imports issues from Linear
- **IntegrationAutoPullService**: Manages scheduled auto-pull for ClickUp and Linear

Current test coverage is minimal - only regression tests for specific features (auto-pull, token prompts) and one unit test for `IntegrationAutoPullService`. We need comprehensive coverage for all integration services.

## User Review Required
> [!NOTE]
> - This plan is test-only; it should not change integration behavior or user-facing copy.
> - Any new suite-specific scripts or CI filters must stay aligned with the existing `vscode-test` and `pretest` flow.

## Complexity Audit
### Routine
- Test directory layout, shared fixtures, and regression guards that only assert stable headers, config shape, and command registration.
- Pure-function coverage for Notion URL parsing, markdown conversion edge cases, and config normalization where inputs are deterministic.
- Package script additions that wrap existing test entry points without introducing new runtime behavior.

### Complex / Risky
- Shared HTTP / SecretStorage / VS Code mocks that must safely stub async callbacks, prompt flows, and request retries without leaking state between tests.
- Multi-step ClickUp and Linear setup/import flows, because they involve chained prompts, pagination, state changes, and rollback behavior.
- CI workflow and coverage wiring, because the suite spans mixed JS/TS test files and must stay compatible with `vscode-test` and the existing pretest compile path.

## Edge-Case & Dependency Audit
- **Race Conditions:** Shared stubs and fake timers must be reset between tests so one suite cannot leak state into another. Any async prompt or notification flow should resolve deterministically inside the test harness, not via real timing.
- **Security:** The tests must never hit live Notion, ClickUp, or Linear APIs, and they must not write secrets to disk. SecretStorage should be mocked in memory only.
- **Side Effects:** Keep all generated fixtures and scratch files inside workspace-local test directories that are cleaned up after the run. Avoid OS temp paths and avoid writing to user workspaces.
- **Dependencies & Conflicts:** The active plan `add_project_management_accordion_to_central_setup.md` will move ClickUp and Linear setup entry points out of the Kanban board. Keep this suite focused on service contracts, prompts, and payloads so it survives that migration. Related integration implementation plans can also change prompts, config shapes, or state payloads; if those land first, regenerate fixtures before tightening assertions.

## Adversarial Synthesis
### Grumpy Critique

*Throws the plan across the room.*

1. You keep calling this "comprehensive" while spreading the suite across Notion, ClickUp, Linear, shared mocks, CI wiring, and E2E flows. That is not one test plan; that's three service suites, a harness rewrite, and a release candidate's worth of fixture drift.
2. The shared mocks are the real risk. If `vscode.window.showInputBox`, `showQuickPick`, `showInformationMessage`, and SecretStorage all behave slightly differently in each suite, the tests will become a brittle puppet show instead of a safety net.
3. UI assertions are the wrong battlefield for a plan this broad. Any plan that relocates buttons or changes message plumbing will break string-based tests unless you scope them to service contracts and stable payloads.
4. The plan still assumes workspace-local scratch space and cleanup discipline but doesn't say how to keep fixtures out of `/tmp` or other ephemeral paths. That needs to be explicit or someone will improvise.

### Balanced Response

The scope is broad, but the plan now separates routine coverage from the genuinely risky paths. Shared helpers are limited to deterministic stubs, not framework magic; each suite resets state between tests, and workspace-local scratch dirs are required instead of OS temp paths.

The high-risk areas are called out explicitly: recursive Notion conversion, ClickUp/Linear multi-step flows, and CI integration. UI-facing tests are scoped to stable contracts and payloads so the suite can survive setup-panel migrations without becoming a brittle snapshot test farm.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### Low Complexity Work
- Create the test directory structure, shared helpers, and fixture directories that only expose the suite to existing tooling.
- Add routine regression coverage for stable contracts: token prompts, config normalization, API/header presence, and command registration.
- Keep all generated test artifacts workspace-local and cleanup-safe; do not rely on OS temp paths.

### High Complexity Work
- Build the shared mock layer that has to emulate VS Code webview prompts, SecretStorage, and HTTP behavior across async flows.
- Cover multi-step ClickUp and Linear setup/import paths, including pagination, rollback, debouncing, and fallback lookup behavior.
- Validate Notion recursion and markdown conversion across nested blocks, rich text annotations, tables, and large-page truncation.

### 1. Test Structure and Organization

Create a new test directory structure under `src/test/integrations/`:
```
src/test/integrations/
├── notion/
│   ├── notion-fetch-service.test.js
│   ├── notion-url-parsing.test.js
│   ├── notion-markdown-conversion.test.js
│   └── notion-regression.test.js
├── clickup/
│   ├── clickup-sync-service.test.js
│   ├── clickup-setup-flow.test.js
│   ├── clickup-import-flow.test.js
│   ├── clickup-rate-limiting.test.js
│   └── clickup-regression.test.js
├── linear/
│   ├── linear-sync-service.test.js
│   ├── linear-setup-flow.test.js
│   ├── linear-import-flow.test.js
│   ├── linear-graphql-client.test.js
│   └── linear-regression.test.js
└── shared/
    ├── http-mock-helpers.js
    ├── secret-storage-mock.js
    └── vscode-mock.js
```

### 2. Shared Test Infrastructure

**File: `src/test/integrations/shared/http-mock-helpers.js`**
- Mock HTTPS requests for all three services
- Simulate various HTTP responses (success, errors, timeouts, rate limits)
- Record and verify request patterns
- Support request/response interception for testing

**File: `src/test/integrations/shared/secret-storage-mock.js`**
- Mock VS Code SecretStorage
- Store/retrieve API tokens in memory
- Support token validation scenarios

**File: `src/test/integrations/shared/vscode-mock.js`**
- Mock VS Code APIs (window.showInputBox, showQuickPick, showErrorMessage, etc.)
- Simulate user interactions
- Track which prompts were shown and with what parameters

### 3. Notion Integration Tests

**File: `src/test/integrations/notion/notion-fetch-service.test.js`**
- **Config I/O**: Test loading/saving config with valid and invalid data
- **Cache I/O**: Test loading/saving cached content
- **Token Management**: Test token retrieval with valid/missing tokens
- **Availability Check**: Test `isAvailable()` with valid token, invalid token, network errors
- **URL Parsing**: Test `parsePageId()` with various Notion URL formats:
  - Standard notion.so URLs with UUIDs
  - notion.site URLs
  - URLs with and without hyphens in UUIDs
  - Invalid URLs (non-Notion domains, malformed URLs)
- **Page Title Fetching**: Test `fetchPageTitle()` with various page structures
- **Block Fetching**: Test `fetchBlocksRecursive()` with:
  - Simple pages (no children)
  - Nested blocks (depth limits)
  - Pagination (has_more handling)
  - Rate limiting delays
- **Markdown Conversion**: Test `convertBlocksToMarkdown()` with all block types:
  - Paragraphs, headings (H1-H3)
  - Lists (bulleted, numbered)
  - To-do items (checked/unchecked)
  - Toggles, callouts, quotes
  - Code blocks with language
  - Images, bookmarks, embeds
  - Tables
  - Column layouts
  - Rich text formatting (bold, italic, strikethrough, code)
- **Full Fetch Flow**: Test `fetchAndCache()` end-to-end with:
  - Valid token and URL
  - Missing token (prompt scenario)
  - Invalid token
  - Inaccessible page (403)
  - Large pages (truncation at 50k chars)
  - Network errors
- **Error Handling**: Test timeout handling, malformed JSON responses

**File: `src/test/integrations/notion/notion-url-parsing.test.js`**
- Dedicated unit tests for URL parsing edge cases
- Test with real Notion URL examples from production
- Test Unicode and special characters in URLs

**File: `src/test/integrations/notion/notion-markdown-conversion.test.js`**
- Dedicated unit tests for markdown conversion
- Test with real Notion block structures from production
- Validate output format matches expected markdown
- Test nested structures and complex layouts

**File: `src/test/integrations/notion/notion-regression.test.js`**
- Regression tests for critical Notion features
- Ensure API version header is present
- Ensure token validation happens before API calls
- Ensure error messages are user-friendly
- Ensure config paths are correct

### 4. ClickUp Integration Tests

**File: `src/test/integrations/clickup/clickup-sync-service.test.js`**
- **Config I/O**: Test loading/saving config with normalization
- Test that legacy configs are normalized with safe defaults
- Test that invalid intervals default to 60 minutes
- **Token Management**: Test token retrieval and prompting
- **Availability Check**: Test with valid/invalid tokens
- **Setup Flow**: Test `setup()` with:
  - Valid token and workspace selection
  - Token prompt scenario
  - Space selection (multiple spaces)
  - Existing folder detection and reuse
  - New folder creation
  - List creation for all canonical columns
  - Custom field creation (success and fallback)
  - Cleanup on failure (transactional behavior)
- **Sync Methods**: Test `syncPlan()` with:
  - New plan creation
  - Existing plan update
  - Column mapping (mapped vs unmapped columns)
  - Complexity to priority mapping
  - Custom field population vs fallback
  - Loop guard prevention
- **Task Finding**: Test `_findTaskByPlanId()` with:
  - Custom field filter (primary)
  - Tag search (fallback)
  - Not found scenarios
- **Task Creation**: Test `_createTask()` with:
  - Various complexity levels
  - Tags and custom fields
  - Description content
- **Task Update**: Test `_updateTask()` with:
  - Name updates
  - Description updates
  - List movement on column change
- **Batch Sync**: Test `syncColumn()` with:
  - Multiple plans
  - Rate limiting
  - Batch processing
  - Error counting
- **Debounced Sync**: Test `debouncedSync()` with:
  - Rapid moves coalescing
  - Timer clearing
- **Import Flow**: Test `importTasksFromClickUp()` with:
  - Task pagination
  - Subtask handling
  - Tag filtering (skip Switchboard-owned tasks)
  - File existence checks
  - Status to column mapping
  - Metadata extraction (priority, due dates, assignees, etc.)
  - Stub plan file generation
  - Custom field extraction
  - Checklist handling
- **Rate Limiting**: Test retry logic with exponential backoff
- **Error Handling**: Test network errors, API errors, timeout handling

**File: `src/test/integrations/clickup/clickup-setup-flow.test.js`**
- Dedicated tests for the setup wizard flow
- Test user interaction scenarios
- Test edge cases (no workspaces, no spaces, API errors during setup)

**File: `src/test/integrations/clickup/clickup-import-flow.test.js`**
- Dedicated tests for task import
- Test with real ClickUp task structures
- Test subtask relationships
- Test metadata extraction accuracy

**File: `src/test/integrations/clickup/clickup-rate-limiting.test.js`**
- Test retry logic with exponential backoff
- Test consecutive failure tracking
- Test rate limit delay configuration

**File: `src/test/integrations/clickup/clickup-regression.test.js`**
- Regression tests for critical ClickUp features
- Ensure Authorization header format
- Ensure API version is v2
- Ensure custom field fallback works
- Ensure cleanup happens on setup failure
- Ensure token prompt uses masked input

### 5. Linear Integration Tests

**File: `src/test/integrations/linear/linear-sync-service.test.js`**
- **Config I/O**: Test loading/saving config with normalization
- **Sync Map**: Test sessionId → issueId mapping persistence
- **Token Management**: Test token retrieval and prompting
- **GraphQL Client**: Test `graphqlRequest()` with:
  - Valid queries and mutations
  - Variable substitution
  - HTTP errors (non-200 status)
  - GraphQL errors (response.errors array)
  - Timeout handling
  - Malformed JSON responses
- **Availability Check**: Test with valid/invalid tokens
- **Setup Flow**: Test `setup()` with:
  - Token prompt and validation
  - Team selection
  - Project selection (optional)
  - State mapping for all canonical columns
  - Label creation (existing and new)
  - Config persistence
- **Sync Methods**: Test `syncPlan()` with:
  - New issue creation
  - Existing issue update
  - State changes
  - Priority mapping (complexity → Linear priority)
  - Label assignment
  - Project scoping
- **Issue Creation**: Test `_createIssue()` with:
  - All required fields
  - Optional project field
  - Description formatting
  - Sync map update
- **Debounced Sync**: Test `debouncedSync()` with coalescing
- **Import Flow**: Test `importIssuesFromLinear()` with:
  - GraphQL pagination (cursor-based)
  - Sub-issue handling
  - Sync map filtering (skip already synced)
  - Status filtering (skip completed/cancelled)
  - File existence checks
  - State type to column mapping
  - Metadata extraction (priority, due dates, assignees, labels, etc.)
  - Parent-child relationships
  - Comments extraction
  - Attachments extraction
  - Cycle and project info
  - Stub plan file generation
- **Retry Logic**: Test exponential backoff
- **Error Handling**: Test network errors, GraphQL errors, timeout handling

**File: `src/test/integrations/linear/linear-setup-flow.test.js`**
- Dedicated tests for the setup wizard flow
- Test team/project selection scenarios
- Test state mapping edge cases

**File: `src/test/integrations/linear/linear-import-flow.test.js`**
- Dedicated tests for issue import
- Test with real Linear issue structures
- Test nested sub-issues
- Test GraphQL cursor pagination

**File: `src/test/integrations/linear/linear-graphql-client.test.js`**
- Dedicated unit tests for GraphQL client
- Test query formatting
- Test error parsing
- Test variable handling

**File: `src/test/integrations/linear/linear-regression.test.js`**
- Regression tests for critical Linear features
- Ensure GraphQL endpoint is correct
- Ensure Authorization header format
- Ensure error handling for GraphQL errors
- Ensure label color is set correctly
- Ensure sync map is updated on issue creation

### 6. IntegrationAutoPullService Tests

**File: `src/test/integrations/shared/integration-auto-pull-service.test.js`**
- Move existing test to new location
- Add tests for:
  - Multiple workspace support
  - Multiple integration support (ClickUp + Linear simultaneously)
  - Interval reconfiguration during in-flight runs
  - Workspace-level stop
  - Edge cases (null runner, zero interval)

### 7. End-to-End Integration Tests

**File: `src/test/integrations/e2e/integration-workflow.test.js`**
- Test full workflow scenarios:
  - Setup → Sync → Import cycle for ClickUp
  - Setup → Sync → Import cycle for Linear
  - Notion fetch → Plan creation → Sync to external tool
  - Auto-pull scheduling and execution
- Use mocked external APIs but real service instances
- Test data flow between services

### 8. Test Data and Fixtures

**Directory: `src/test/integrations/fixtures/`**
- Store sample API responses from Notion, ClickUp, Linear
- Store sample plan files
- Store sample config files
- Use real-world examples anonymized

### 9. Test Execution and CI

**File: `package.json` updates**
- Add test scripts for each integration:
  - `test:integration:notion`
  - `test:integration:clickup`
  - `test:integration:linear`
  - `test:integration:all`
- Add coverage thresholds for integration tests

**File: `.github/workflows/integration-tests.yml`**
- CI workflow for integration tests
- Run on every PR
- Run on schedule for regression detection
- Report coverage

## Implementation Order

1. **Phase 1: Shared Infrastructure (Low complexity)** (Week 1)
   - Create shared mock helpers
   - Set up test directory structure
   - Write tests for IntegrationAutoPullService (move existing)

2. **Phase 2: Notion Tests (Mixed complexity)** (Week 2)
   - Write unit tests for URL parsing and markdown conversion
   - Write service tests with HTTP mocks
   - Write regression tests
   - Achieve >80% coverage for NotionFetchService

3. **Phase 3: ClickUp Tests (High complexity)** (Week 3)
   - Write unit tests for setup flow
   - Write service tests with HTTP mocks
   - Write import flow tests
   - Write rate limiting tests
   - Write regression tests
   - Achieve >80% coverage for ClickUpSyncService

4. **Phase 4: Linear Tests (High complexity)** (Week 4)
   - Write unit tests for GraphQL client
   - Write service tests with GraphQL mocks
   - Write setup flow tests
   - Write import flow tests
   - Write regression tests
   - Achieve >80% coverage for LinearSyncService

5. **Phase 5: E2E Tests (High complexity)** (Week 5)
   - Write end-to-end workflow tests
   - Test cross-integration scenarios
   - Validate data flow

6. **Phase 6: CI and Documentation (Low-to-medium complexity)** (Week 6)
   - Set up CI workflows
   - Add test scripts to package.json
   - Document test structure in README
   - Add test coverage reporting

## Success Criteria

- **Coverage**: >80% code coverage for all integration services
- **Regression**: All existing regression tests continue to pass
- **Speed**: Full test suite runs in <2 minutes
- **Reliability**: Tests are deterministic (no flaky tests)
- **Maintainability**: Tests are well-documented and easy to understand
- **CI**: Tests run automatically on PR and schedule

## Recommended Agent
Send to **Lead Coder** — complexity 7. This plan spans shared mocks, multi-step integration flows, CI wiring, and fixture-driven regression coverage.

## Risks and Mitigations

**Risk**: External API changes may break mocks
- **Mitigation**: Use real API responses from production as fixtures, update fixtures when APIs change

**Risk**: Tests may be flaky due to timing issues
- **Mitigation**: Use fake timers for async operations, avoid real network calls, use deterministic mock responses

**Risk**: High maintenance burden for fixtures
- **Mitigation**: Keep fixtures minimal and focused on critical paths, document fixture format

**Risk**: SecretStorage and VS Code API mocking complexity
- **Mitigation**: Reuse existing mock patterns from codebase, keep mocks simple and focused

## Notes

- All tests should use the existing Node.js `assert` module (no external test frameworks)
- Follow existing test patterns in the codebase (regression tests, fake timers)
- Tests should be fast - no real network calls, no real file system writes to user directories
- Use workspace-local scratch directories under `src/test/fixtures/generated/` with cleanup; do not rely on OS temp paths
- Mock all external dependencies (HTTPS, VS Code APIs, SecretStorage)
- Document complex test scenarios with comments

## Review Pass Results

### Fixed Items
- None. No CRITICAL or MAJOR defects were found that required code changes.

### Files Changed
- `.switchboard/plans/design_comprehensive_test_suite_for_notion_clickup_linear_integrations.md`

### Validation Results
- `npm run compile` ✅
- `npx tsc --noEmit` ⚠️ fails on the known pre-existing `ArchiveManager` dynamic import complaint in `src/services/KanbanProvider.ts:2405`
- `node src/test/integrations/run-integration-tests.js all` ✅

### Remaining Risks
- No explicit coverage gate is enforced yet.
- Setup-flow coverage is still co-located inside the sync-service suites rather than split into dedicated files.
- The plan's suggested fixture root (`src/test/fixtures/generated/`) differs from the actual workspace-local integration fixture root in use.

### Unresolved Issues
- Yes: the NIT-level structural deviations above remain by design.
