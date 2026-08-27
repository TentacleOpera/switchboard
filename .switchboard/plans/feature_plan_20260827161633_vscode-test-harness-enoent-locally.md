# vscode-test harness fails locally with ENOENT, blocking KanbanProvider and agentPromptBuilder suites

## Goal

The `vscode-test` harness cannot launch on this machine. It downloads VS Code 1.135.0 then fails with `spawn .../Visual Studio Code.app/Contents/MacOS/Electron ENOENT`. This makes the two CI-wired mocha suites (`npm test --grep KanbanProvider` and `--grep agentPromptBuilder`) unverifiable during local review passes — every KanbanProvider change lands on CI's word alone.

The `.vscode-test.mjs` config lists 5 test files that run inside a downloaded VS Code instance via `@vscode/test-cli`. The harness downloads a VS Code build, extracts it, and spawns the Electron binary. The ENOENT error means the download or extraction completed but the expected binary path does not exist at `Visual Studio Code.app/Contents/MacOS/Electron`.

**Root cause:** Likely a version mismatch between the downloaded VS Code build and the expected binary path, or a corrupted/incomplete download. The `@vscode/test-cli` package may be pinning a VS Code version whose macOS distribution changed its bundle structure, or the download cache is in a stale state.

## Metadata

**Complexity:** 4
**Tags:** test, devops, infrastructure
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Clear the vscode-test download cache and re-download.
- Pin a known-good VS Code version in `.vscode-test.mjs` or `package.json`.
- If the issue is a macOS architecture mismatch (Apple Silicon vs Intel), specify the correct download.

**Complex/Risky:**
- The ENOENT on `Visual Studio Code.app/Contents/MacOS/Electron` suggests the VS Code archive was extracted but the `.app` bundle structure doesn't match what `@vscode/test-cli` expects. This can happen when:
  - The downloaded version is a Insiders build with a different bundle name.
  - The platform/arch detection in `@vscode/test-cli` picks the wrong download (e.g., x64 on ARM64).
  - The download was interrupted and the extraction produced a partial directory.
- Changing the VS Code version may surface test failures that were previously masked by the version that CI uses (Ubuntu vs macOS differences).

## Edge-Case & Dependency Audit

- **`.vscode-test.mjs`:** The config does not specify a `version` — it uses the default, which `@vscode/test-cli` resolves to the latest stable. The issue mentions 1.135.0 specifically. Pinning a version may help.
- **`package.json`:** Check the `@vscode/test-cli` and `@vscode/vscode-test` versions. An outdated version may not handle newer macOS distributions correctly.
- **macOS architecture:** On Apple Silicon, `@vscode/test-cli` should download the ARM64 build. If it downloads the x64 build, the Rosetta-translated binary may not spawn correctly. Check `process.arch` and the downloaded archive type.
- **Cache location:** The download cache is at `~/.vscode-test/` (or `$HOME/.vscode-test/`). Clearing it forces a fresh download. The cache was empty on this machine (`find` returned nothing), so the download may be failing silently or extracting to a different location.
- **CI vs local:** CI runs on `ubuntu-latest` where the harness works. The issue is macOS-specific. The fix should not break the Linux CI path.

## Proposed Changes

### 1. Diagnose the download and extraction

```bash
# Run the harness with verbose output to see what it downloads and where
npx vscode-test --verbose 2>&1 | tee vscode-test-debug.log

# Check the download cache
ls -la ~/.vscode-test/
find ~/.vscode-test -name "Electron" -o -name "Code*" 2>/dev/null
```

### 2. Pin a known-good VS Code version

In `.vscode-test.mjs`, add a version pin:

```javascript
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    version: '1.96.0',  // or another known-good stable version
    files: [
        'out/test/pair-programming-*.test.js',
        'out/services/__tests__/KanbanProvider.test.js',
        'out/services/__tests__/kanbanColumnDerivation.test.js',
        'out/services/__tests__/GlobalPlanWatcherService.test.js',
        'out/services/__tests__/agentPromptBuilder.test.js',
        'out/test/kanban-complexity.test.js',
    ],
    mocha: {
        preload: ['./src/test/bootstrap/sandboxStateHome.js']
    }
});
```

### 3. Clear cache and re-download

```bash
rm -rf ~/.vscode-test/
npx vscode-test --grep KanbanProvider
```

### 4. If version pinning doesn't help, check for architecture mismatch

```bash
# Check the machine architecture
uname -m

# Force the correct architecture in the download
# @vscode/test-cli uses the 'platform' option — try:
# version: 'insiders' or a specific version that has ARM64 builds
```

### 5. Update `@vscode/test-cli` if outdated

```bash
npm ls @vscode/test-cli @vscode/vscode-test
npm install @vscode/test-cli@latest --save-dev
```

## Verification Plan

1. Run `npx vscode-test --grep KanbanProvider` — assert the suite launches and passes.
2. Run `npx vscode-test --grep agentPromptBuilder` — assert the suite launches and passes.
3. Run `npm test` (full vscode-test suite) — assert all 5 test files run.
4. Verify the fix does not break CI by checking the `integration-tests.yml` workflow still passes on `ubuntu-latest`.
5. If the fix involves pinning a version, verify that version is available for both macOS and Linux.
