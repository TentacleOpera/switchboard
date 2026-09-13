# Stage 2b — vscodeShim Removal

kanbanColumn: CREATED

## Goal

Delete `src/standalone/vscodeShim.ts` (645 lines) and remove every `import * as vscode from 'vscode'`
from the 28 service files that currently import it. The shim is what makes the standalone host run
shared services that import `vscode` — once those services shed the import (replaced by `hostSeams.ts`
abstractions), the shim is dead code and the services become simply "the product" instead of
"shared".

### Problem analysis

**The shim is the fake VS Code API that makes shared services run headless.** It provides a
`SecretStorage` adapter, no-op `window.*` stubs, a `Uri` class, and a `WorkspaceFolder` interface —
645 lines of code that exists only because 28 service files import `vscode` directly instead of
through an abstraction. The standalone host's webpack alias maps `vscode` to this shim so the
services compile and run, but the shim's `window.*` stubs reject with "not available in the
headless standalone host" — meaning any service that calls `vscode.window.showInputBox` in the
standalone host silently fails.

**The density is the encouraging part:** 280 `vscode.*` call sites in `TaskViewerProvider` (29,747
lines) is under 1%. `TaskViewerProvider` is overwhelmingly host-agnostic logic wearing a thin VS
Code veneer. The shim exists to paper over that veneer; removing the veneer removes the shim.

## Metadata

- **Complexity:** 7
- **Tags:** refactor, infrastructure

## User Review Required

None.

## Complexity Audit

### Routine

- Replacing `vscode.Uri` calls with a host-agnostic URI utility (the shim's `Uri` class at `vscodeShim.ts:85` is a thin wrapper — most call sites use `vscode.Uri.file()` which can be replaced with a simple path-to-URL converter).
- Replacing `vscode.EventEmitter` with a standalone event emitter (the shim's `EventEmitter` at `vscodeShim.ts:36` is a minimal implementation — Node's `EventEmitter` or a custom type works).

### Complex / Risky

- **280 `vscode.*` call sites in `TaskViewerProvider` alone.** Each must be replaced by a `hostSeams.ts` abstraction or confirmed headless-only. The seam layer already exists at `src/services/hostSeams.ts` — but it may not cover every call site.
- **28 service files import `vscode`.** Each must be audited: does it use `vscode.workspace.getConfiguration()` (config reads), `vscode.window.*` (UI), `vscode.Uri` (path handling), or `vscode.SecretStorage` (token storage)? Each category needs a different replacement.
- **The standalone host breaks if the shim is deleted before the services are refactored.** The shim is what makes the standalone host run these services today. The order is: refactor services → confirm no `vscode` imports → delete shim. Not the reverse.
- **`vscode.workspace.getConfiguration()` is the most pervasive call.** Many services read configuration via `vscode.workspace.getConfiguration('switchboard')`. After Stage 2, the extension is a client and reads config from the host over HTTP. The standalone host reads config from its own config provider (`StandaloneHostPathConfigProvider`). Both need a unified config-reading abstraction that is not `vscode.workspace.getConfiguration()`.

## Edge-Case & Dependency Audit

### Race Conditions

- None. This is a refactoring stage with no runtime behavior change — the services work the same way, just through abstractions instead of the shim.

### Security

- `vscode.SecretStorage` is used for token storage. The shim provides a `SecretStorage` adapter over `StandaloneHostSecrets` (encrypted secrets). The replacement must preserve the encryption — a plain file or env var is a regression.

### Side Effects

1. **The standalone host must continue working throughout the refactoring.** The shim can only be deleted after every service file has shed its `vscode` import. Intermediate states (some files refactored, some not) must compile and run.
2. **No runtime behavior change.** This stage does not change what the product does — it changes how the services reach the VS Code API (through seams instead of directly).

### Dependencies & Conflicts

3. **Stage 2 must land first.** The extension must have stopped being a host before the shim removal makes sense — if the extension is still a host, it needs `vscode` imports for real.
4. **`hostSeams.ts` may need extension.** The existing seam layer at `src/services/hostSeams.ts` may not cover every `vscode.*` call site. Gaps must be identified and filled before the corresponding service can shed its import.

## Dependencies

- Stage 2 (extension stops being a host) — must land first. Same feature.

## Adversarial Synthesis

Key risks: 280 call sites across 28 files is a large surface area, and the standalone host breaks if the shim is deleted prematurely. Mitigations: refactor service-by-service, compile and test after each, delete the shim only when `grep -rl "from 'vscode'" src/services/*.ts` returns zero files.

## Proposed Changes

### `src/services/hostSeams.ts`

- **Context:** The existing seam layer that abstracts VS Code API calls for headless use.
- **Logic:** Audit which `vscode.*` call sites are not yet covered by `hostSeams.ts`. Add abstractions for: `vscode.workspace.getConfiguration()` (config reads), `vscode.window.showInformationMessage/showWarningMessage/showErrorMessage` (notifications), `vscode.Uri.file()` (path handling), `vscode.EventEmitter` (events).
- **Implementation:** Extend the `HostSeams` interface and its two implementations (extension and standalone). Each new seam has a real implementation in the extension and a headless implementation in the standalone host.
- **Edge Cases:** A seam that has no headless implementation (e.g. `showInputBox`) should reject with a clear message, not silently return undefined.

### `src/services/TaskViewerProvider.ts`

- **Context:** 280 `vscode.*` call sites — the largest concentration.
- **Logic:** Replace each `vscode.*` call with the corresponding `hostSeams` abstraction. The provider already has a `_seams()` accessor (line 7933 references it).
- **Implementation:** Work through the file systematically — config reads first (most common), then notifications, then URI handling, then events. Compile and test after each category.
- **Edge Cases:** Some `vscode.*` calls may be in dead code paths (panel lifecycle code deleted in Stage 1). Those calls disappear when the dead code is removed.

### `src/services/KanbanProvider.ts`

- **Context:** 103 `vscode.*` call sites — the second largest.
- **Logic:** Same pattern as TaskViewerProvider — replace with `hostSeams` abstractions.
- **Edge Cases:** Same — some calls may be in panel lifecycle code deleted in Stage 1.

### Remaining 26 service files

- **Context:** 26 other service files import `vscode` (of 135 total service files).
- **Logic:** Audit each file's `vscode.*` usage. Replace with `hostSeams` abstractions or confirm the import is unnecessary (some may import `vscode` for type annotations only).
- **Implementation:** Process in batches, compiling and testing after each batch.
- **Edge Cases:** A file that imports `vscode` for a single type (e.g. `vscode.Disposable`) can replace it with a local interface or import from `hostSeams.ts`.

### `src/standalone/vscodeShim.ts`

- **Context:** 645 lines — the fake VS Code API.
- **Logic:** Delete the file entirely. Also remove the webpack alias that maps `vscode` to this shim.
- **Implementation:** Only after `grep -rl "from 'vscode'" src/services/*.ts` returns zero files.
- **Edge Cases:** The webpack config (`webpack.config.standalone.js` or equivalent) must be updated to remove the alias. Test files that import `vscode` are fine — they run in the extension context.

## Verification Plan

### Automated Tests

> NOTE: Per the dispatching directive, compilation and automated tests are not executed in this
> review pass. The checks below remain written down for the implementer to run.

1. `npm run compile` — typecheck passes after each service file is refactored.
2. `npm test` — existing test suite passes.
3. `grep -rl "from 'vscode'" src/services/*.ts` returns zero files (excluding `.bak` files).
4. `test -f src/standalone/vscodeShim.ts` fails (file deleted).
5. The standalone host starts and serves the board — `switchboard api GET /health` returns `ok`.

### Goal Invariants

- Assert `src/standalone/vscodeShim.ts` does not exist. Paired positive: assert no file in `src/services/` matches `grep -rl "from 'vscode'"`.
- Assert the standalone host's webpack config does not alias `vscode` to the shim.

### Manual Verification

1. The standalone host starts, serves the board, and all provider panels work (Kanban, Planning, Setup, Design, Tickets).
2. No service file imports `vscode`.
3. The shim file is deleted.
