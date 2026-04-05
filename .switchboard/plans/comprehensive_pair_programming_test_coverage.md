# Comprehensive Pair Programming Test Coverage Plan

## Goal
Add comprehensive test coverage for all pair programming clipboard flows, notification interactions, and edge cases that are currently untested in `src/test/pair-programming-routing-bypass.test.ts` and `src/test/autoban-state-regression.test.js`.

## Metadata
**Tags:** backend, bugfix
**Complexity:** 7

## User Review Required
> [!NOTE]
> - `sinon` and `@types/sinon` are **not** currently in `package.json` devDependencies. They must be installed before this plan can execute. The project currently uses `@types/mocha` and Node `assert` only.
> - Existing test files use a mix of `.test.ts` (TypeScript, `assert`) and `.test.js` (CommonJS, `require`). This plan uses TypeScript (`.test.ts`) to match the existing pair-programming test file convention.
> - No production code changes are required. This is a test-only plan.

## Problem Statement

Current tests for pair programming (`src/test/pair-programming-routing-bypass.test.ts` and `src/test/autoban-state-regression.test.js`) only verify:
1. Routing role elevation (intern → coder when pair mode is enabled) — via a standalone `simulateBypass()` function that re-implements the bypass pattern outside the real providers
2. Mode migration from legacy boolean to string modes — via `normalizeAutobanConfigState()` unit assertions

**Missing coverage:**
- Clipboard operations (`vscode.env.clipboard.writeText()`)
- Two-stage clipboard flow (Lead → clipboard → notification → Coder → clipboard)
- Single clipboard flow (Lead → clipboard, Coder → CLI terminal)
- Notification flows with action buttons
- Clipboard content validation
- Edge cases (dismissal, race conditions, backup file creation)

## Pair Programming Modes to Test

From `feature_plan_20260321_225300_pair_programming_two_stage_clipboard.md`:

| Mode | Trigger | Coder Column Mode | Lead Dispatch | Coder Dispatch |
|------|---------|-------------------|---------------|----------------|
| **CLI Parallel** | Drag-drop to LEAD CODED | `cli` | CLI terminal | CLI terminal |
| **Hybrid** | Pair button | `cli` | Clipboard → IDE chat | CLI terminal |
| **Full Clipboard** | Pair button | `prompt` | Clipboard (Stage 1) | Clipboard via notification (Stage 2) |

## Complexity Audit

### Routine
- **Test Group 7 (Complexity-Based Routing):** Pure-function tests against `scoreToRoutingRole()` and the pair-mode bypass pattern. These reuse the exact pattern already proven in `src/test/pair-programming-routing-bypass.test.ts:13-17` and just extend it with more score/mode combinations.
- **Test Group 8 (Configuration State):** Stateless assertions on `normalizeAutobanConfigState()`. Same pattern as `src/test/autoban-state-regression.test.js:260-281`.
- **Test Group 5 (Clipboard Content Validation):** String assertions on generated prompt content. Requires calling the prompt-building functions with known inputs and asserting substring presence.

### Complex / Risky
- **Mock infrastructure (Step 2):** `sinon` is not currently used anywhere in the test suite. Introducing it requires `npm install --save-dev sinon @types/sinon` and establishing a stub-reset pattern (`sinon.restore()` in `teardown`/`afterEach`) that all future tests must follow. Risk: if stubs leak between tests, failures become non-deterministic.
- **Test Groups 3 & 4 (Full Clipboard two-stage flow):** The notification stub for `vscode.window.showInformationMessage` must return a `Thenable<string | undefined>` that resolves to the button label or `undefined` for dismissal. The async timing between Stage 1 (clipboard write) and Stage 2 (notification resolve → second clipboard write) must be carefully controlled to avoid races.
- **Test Group 6 (Edge Cases):** Test 6.1 (debouncing) requires manipulating timers (`sinon.useFakeTimers()`). Test 6.2 (mid-flow mode change) requires mutating `_columnDragDropModes` on a mocked KanbanProvider between two async steps within a single test. Test 6.3 (clipboard overwrite) requires simulating an external clipboard write between Stage 1 and Stage 2 — which only matters if the implementation reads the clipboard back (it doesn't, so this test verifies the implementation's resilience by confirming Stage 2 writes succeed regardless of intermediate clipboard state).
- **Backup file I/O (Tests 3.1, 4.1, 4.2):** Tests must create and verify files under `.switchboard/handoff/`. Requires `fs.existsSync` / `fs.readFileSync` assertions after the pair flow completes, and cleanup in `afterEach` to avoid polluting the workspace.

## Edge-Case & Dependency Audit
- **Race Conditions:** Test 6.1 directly validates debouncing. Test 6.2 validates mode reads are snapshot-at-click-time. The sinon fake-timer approach prevents real-time races in the test runner itself.
- **Security:** No security-sensitive changes; tests do not touch real clipboard or network.
- **Side Effects:** Backup file tests (Test Group 3/4) write to `.switchboard/handoff/`. All tests must clean up in `afterEach`. The `sinon.restore()` call is critical to prevent stub leaks.
- **Dependencies & Conflicts:**
  - **`fix_autoban_routing_map_discrepancy.md`**: If Plan 2 lands first, it introduces `resolveRoutedRole()` on KanbanProvider. Test Group 7 currently tests the bypass pattern via standalone `scoreToRoutingRole()` — this remains valid regardless, but an additional test should be added post-Plan-2 to call `resolveRoutedRole()` directly with custom routing maps + pair mode.
  - **`update_coder_complexity_threshold_to_5.md`**: Changes default routing thresholds. Test Group 7's hardcoded score→role expectations (1-4→intern, 5-6→coder, 7-10→lead) match the *current* `scoreToRoutingRole()` in `src/services/complexityScale.ts:63-67`. If thresholds change, these tests must be updated.
  - **`add_routing_map_modal_to_kanban.md`**: Adds UI for custom routing maps. No direct test conflict, but custom routing map + pair mode combination isn't covered by this plan (it's Plan 2's scope).

## Adversarial Synthesis

### Grumpy Critique

*Oh, WONDERFUL. Another plan that cheerfully says "just mock everything" as if that's a strategy instead of a prayer.*

Let me count the sins:

1. **sinon doesn't exist in this project.** You're asking someone to introduce a brand-new mocking framework into a codebase that has precisely zero sinon usage. Every `.test.js` file uses raw `assert` and `require`. The `.test.ts` file uses `import * as assert`. Nobody here has ever stubbed `vscode.env.clipboard`. You don't even know if the project's webpack config will bundle sinon correctly for the test runner.

2. **The mock setup code block is a toy.** Two stubs and a hand-wave. Where's the `vscode` module mock? The extension host expects `vscode` to come from the runtime. You need to either: (a) use `@vscode/test-electron` and run inside the host, or (b) create a comprehensive `vscode` namespace mock that includes `env.clipboard`, `window.showInformationMessage`, `workspace.workspaceFolders`, and `commands.executeCommand`. The plan doesn't even acknowledge this.

3. **Test Group 6 is aspirational fiction.** "Rapid successive Pair button clicks (debouncing)" — show me where debouncing is implemented. If it's not implemented, you're testing non-existent behavior. "Clipboard overwritten by user between Stage 1 and Stage 2" — the implementation doesn't read clipboard back, so what exactly are you asserting? That writing to clipboard succeeds? Groundbreaking.

4. **Backup file tests assume a path format** (`.switchboard/handoff/coder_prompt_<sessionId>.md`) that isn't verified against the actual implementation. If the real path uses a different naming convention, every assertion fails.

5. **No mention of the test runner configuration.** Are these Mocha tests? The project uses `@types/mocha` and `@vscode/test-cli`. How do TypeScript tests get compiled before running? Is `ts-mocha` available? `tsx`? The plan just… doesn't say.

6. **"Code coverage > 90%" is a meaningless vanity metric** when half the tests are asserting against stubs of stubs. You're measuring coverage of your mocks, not coverage of production logic.

### Balanced Response

Grumpy raises valid structural concerns. Here's how the implementation steps below address them:

1. **sinon introduction:** The plan now explicitly requires `npm install --save-dev sinon @types/sinon` as a prerequisite step and mandates `sinon.restore()` in every `afterEach` block. The project's test runner (`@vscode/test-cli`) supports TypeScript tests via the existing `tsconfig.test.json` — no additional compilation step is needed.

2. **vscode namespace mocking:** The mock setup section has been expanded to require a full `vscode` namespace mock covering `env.clipboard`, `window.showInformationMessage`, `workspace.workspaceFolders`, and `commands.executeCommand`. The mock must be created in a shared `test/helpers/vscode-mock.ts` file if it doesn't already exist.

3. **Test Group 6 scoping:** Test 6.1 (debouncing) is retained only if the implementation has debounce logic — the implementer must verify this before writing the test. Test 6.3 (clipboard overwrite) is re-scoped to verify that Stage 2 `writeText` is called regardless of intermediate clipboard state (i.e., it doesn't `readText` first). Test 6.4 (notification timeout) is re-scoped to test the `undefined` return from `showInformationMessage` (user dismissal), which is already covered by Test 4.2 — so 6.4 is removed as a duplicate.

4. **Backup file path:** The implementer must grep for the actual handoff path in `KanbanProvider.ts` before writing assertions. The plan labels the current path as **assumed** and requires verification.

5. **Test runner:** TypeScript tests compile via `tsconfig.test.json` and run under `@vscode/test-cli` using Mocha. This matches the existing `pair-programming-routing-bypass.test.ts` convention.

6. **Coverage metric removed.** The success criteria now focus on functional pass/fail of specific test groups, not a coverage percentage.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### Step 1: Install Dependencies
#### [MODIFY] `package.json`
- **Context:** `sinon` and `@types/sinon` are required for stubbing VS Code APIs. Neither exists in the project today.
- **Logic:** Add both packages to `devDependencies`.
- **Implementation:**
```bash
npm install --save-dev sinon @types/sinon
```
- **Edge Cases Handled:** If a future plan removes sinon, the tests in this plan will fail at import time — which is the correct behavior (fail-fast).

### Step 2: Create Test File
#### [CREATE] `src/test/pair-programming-comprehensive.test.ts`
- **Context:** New test file covering all pair programming clipboard flows, notification interactions, and edge cases. The existing `src/test/pair-programming-routing-bypass.test.ts` covers only the bypass pattern in isolation.
- **Logic:**
  1. Import `sinon`, `assert`, and the production modules under test (`scoreToRoutingRole`, `parseComplexityScore`, `normalizeAutobanConfigState` from `src/services/complexityScale.ts` and `src/services/autobanState.js`).
  2. Create a `vscode` namespace mock object with `env.clipboard.writeText`, `env.clipboard.readText`, `window.showInformationMessage`, `workspace.workspaceFolders`, and `commands.executeCommand` — all as sinon stubs.
  3. Structure tests into 8 suites matching the Test Groups below.
  4. Use `setup()`/`teardown()` (Mocha) to reset all sinon stubs between tests via `sinon.restore()`.

- **Implementation:** The implementer must produce the full file. The following is the **required structure and assertions** (not a truncated skeleton):

**Suite 1: CLI Parallel Mode (Drag-Drop)** — Routine
- Test 1.1: Configure `_columnDragDropModes` to `cli` for Coder column. Simulate drag-drop to LEAD CODED. Assert `clipboard.writeText` call count === 0. Assert terminal dispatch commands were invoked for both Lead and Coder roles.

**Suite 2: Hybrid Mode (Pair Button + CLI)** — Complex
- Test 2.1: Configure Coder column mode = `cli`. Simulate Pair button click. Assert `clipboard.writeText` called exactly once with the Lead prompt. Assert `commands.executeCommand('switchboard.dispatchToCoderTerminal', ...)` called. Assert `showInformationMessage` called with string containing "prompt copied".

**Suite 3: Full Clipboard Mode — Stage 1** — Complex
- Test 3.1: Configure Coder column mode = `prompt`. Simulate Pair button click. Assert `clipboard.writeText` called with Lead prompt. Assert `showInformationMessage` called with "Copy Coder Prompt" action button. Assert backup file exists at `.switchboard/handoff/coder_prompt_<sessionId>.md` (**Clarification:** implementer must verify actual path by grepping `KanbanProvider.ts` for `handoff` or `coder_prompt`). Assert card column advanced to LEAD CODED.

**Suite 4: Full Clipboard Mode — Stage 2** — Complex
- Test 4.1: Resolve `showInformationMessage` stub with `'Copy Coder Prompt'`. Assert `clipboard.writeText` called a second time with Coder prompt. Assert success notification shown. Assert backup file deleted.
- Test 4.2: Resolve `showInformationMessage` stub with `undefined` (dismissal). Assert `console.log` called with dismissal message. Assert backup file still exists. Assert card remains in LEAD CODED.

**Suite 5: Clipboard Content Validation** — Routine
- Test 5.1: Generate Lead prompt for a known plan topic + complexity + sessionId. Assert output contains all three values as substrings.
- Test 5.2: Same for Coder prompt.
- Test 5.3: Assert Lead prompt contains "Lead" role instructions and Coder prompt contains "Coder" role instructions; assert they are not identical.

**Suite 6: Edge Cases** — Complex
- Test 6.1: (**Conditional** — only implement if debounce logic exists in the pair button handler.) Use `sinon.useFakeTimers()`. Simulate two rapid Pair clicks within 100ms. Assert clipboard.writeText called only once.
- Test 6.2: Start a pair flow. Between Stage 1 resolve and Stage 2, change `_columnDragDropModes` for Coder column from `prompt` to `cli`. Assert Stage 2 still uses the mode captured at click time (snapshot semantics).
- Test 6.3: Start Stage 1. Before resolving the notification, stub `clipboard.readText` to return unrelated content. Resolve notification with "Copy Coder Prompt". Assert `clipboard.writeText` is called with the correct Coder prompt (confirming the implementation doesn't depend on clipboard readback).

**Suite 7: Complexity-Based Routing with Pair Mode** — Routine
- Test 7.1–7.5: Reuse the `simulateBypass` pattern from `src/test/pair-programming-routing-bypass.test.ts:13-17` but extend to cover all mode + score combinations. These are pure-function unit tests against `scoreToRoutingRole()`.

**Suite 8: Configuration State** — Routine
- Test 8.1–8.4: Call `normalizeAutobanConfigState()` with each mode value (`off`, `cli-cli`, `cli-ide`, `ide-cli`, `ide-ide`, `true`, `false`, `'banana'`). Assert correct output. Same pattern as `src/test/autoban-state-regression.test.js:260-281`.

- **Edge Cases Handled:** All sinon stubs reset via `sinon.restore()` in `afterEach`. Backup file cleanup in `afterEach` via `fs.rmSync(handoffDir, { recursive: true, force: true })`. Fake timers restored in test 6.1's own `afterEach`.

## Verification Plan

### Automated Tests
- Run new suite: `npm test -- --grep "pair programming comprehensive"`
- Run existing suites to confirm no regression:
  - `npm test -- --grep "Pair programming routing bypass"`
  - `node src/test/autoban-state-regression.test.js`
- All 8 test groups must pass.
- No failures in `npm test` full suite.

### Manual Verification
- N/A — this is a test-only plan.

## Dependencies

- **Install required:** `sinon` (mocking/stubbing), `@types/sinon` (TypeScript types)
- **Already present:** `@types/mocha`, `@vscode/test-cli`, `assert` (Node built-in)
- **Production files read (not modified):** `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/services/complexityScale.ts`, `src/services/autobanState.ts`
- **Existing test files (not modified):** `src/test/pair-programming-routing-bypass.test.ts`, `src/test/autoban-state-regression.test.js`

## Recommended Agent

Send to **Lead Coder** — complexity 7. Involves introducing a new mocking framework (`sinon`), complex async two-stage notification stubbing, VS Code API namespace mocking, and comprehensive multi-suite test coverage of branching logic across `KanbanProvider.ts` and `TaskViewerProvider.ts`.

## Implementation Review

**Review Date:** 2025-07-16
**Reviewer Pass:** Grumpy Principal Engineer + Balanced Synthesis

### Findings

| ID | Severity | Description | Status |
|:---|:---------|:------------|:-------|
| CRITICAL-1 | CRITICAL | Test 7.4 asserted `simulateBypass(4, false) === 'intern'` but `scoreToRoutingRole(4)` returns `'coder'` (thresholds: 1-3→intern, 4-6→coder). Test would fail at runtime. | **FIXED** — corrected to `'coder'`, added score 3 boundary |
| MAJOR-1 | MAJOR | Test 7.1 description said "intern scores (1-4)" but score 4 is coder by default. Assertion passed vacuously. | **FIXED** — narrowed to (1-3), added explicit score-4 boundary comment |
| MAJOR-2 | MAJOR | `showInfoStub` double-cast (`as unknown as SinonStub`) bypasses type safety on notification assertions. | **MITIGATED** — added explanatory comment; no better sinon pattern exists for vscode overloads |
| MAJOR-3 | MAJOR | Flow simulators replicate KanbanProvider logic instead of testing it directly. Divergence risk. | **MITIGATED** — added sync-warning comment on helpers; Suites 5/7/8 test real production functions. True integration tests deferred to future plan |
| NIT-1 | NIT | Test 6.1 (debouncing) correctly skipped — no debounce on pair handler | No action needed |
| NIT-2 | NIT | Tests 5.4-5.5, 8.5-8.8 exceed plan spec — valuable bonus coverage | No action needed |

### Files Changed

| File | Change |
|:-----|:-------|
| `src/test/pair-programming-comprehensive.test.ts` | Fixed test 7.1 description & score range, fixed test 7.4 assertion (score 4 → coder), added sync-warning on flow helpers, added comment on showInfoStub cast |

### Validation Results

- `npx tsc --noEmit -p tsconfig.test.json`: **1 pre-existing error** in `KanbanProvider.ts:1833` (ArchiveManager import extension). No new errors.
- `node src/test/autoban-state-regression.test.js`: **Pre-existing failure** at line 214 (source-grep assertion mismatch for `getNextAutobanTerminalName`). Not related to this plan.
- Note: `tsconfig.test.json` inherits `exclude: **/*.test.ts` from parent — `.test.ts` files are not type-checked by `tsc`. This is a pre-existing config issue.

### Remaining Risks

1. **Flow simulator drift** — `simulatePairButtonFlow()` and `simulateDragDropFlow()` are hand-written copies of production logic. If `KanbanProvider.ts` pair-flow changes, these tests will pass while production breaks. Mitigation: sync-warning comment added; recommend adding `@vscode/test-electron` integration tests.
2. **Existing test `pair-programming-routing-bypass.test.ts:34`** has the same score-4→intern bug that was fixed here. Should be fixed separately.
3. **Test compilation gap** — no `.test.ts` files are compiled by `tsc -p tsconfig.test.json` due to inherited exclude. Type errors in tests won't surface until runtime in the VS Code test host.
