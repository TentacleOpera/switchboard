# Plan: Add Versioned Migration for Bundled .agent Workflow Files

## Goal
Implement a versioned migration mechanism for bundled `.agent/` assets so that stale workflow definitions (e.g., `improve-plan.md` referencing deleted MCP tools) are automatically overwritten on extension update, while preserving user-modified files that diverge from bundled defaults.

## Metadata
- **Tags:** workflow, devops, reliability
- **Complexity:** 6

## User Review Required
None — internal extension reliability fix.

## Complexity Audit

### Routine
- Add a `.switchboard/.agent_version.json` version tracker (mirrors existing `.mcp_version.json` pattern at `src/extension.ts:62-101`).
- Add `getAgentVersionFilePath`, `getLastCopiedAgentVersion`, `setLastCopiedAgentVersion`, `shouldRefreshAgentWorkspaceFiles` helper functions — direct mirrors of the MCP version helpers (`src/extension.ts:62-124`).
- Update the copy loop in `performSetup` (`src/extension.ts:3718-3730`) to check version before skipping workflow files.

### Complex / Risky
- Distinguishing canonical bundled files from user-modified files to avoid destroying user customizations.
- Control-plane path (`_bootstrapControlPlaneLayout` at `src/services/ControlPlaneMigrationService.ts:655-688`) uses a different copy mechanism (`_copyDirectoryRecursive` at line 919) that must also be updated — and this recursive function currently has no concept of relative paths, requiring a signature change.
- The `.agent/` directory contains heterogeneous content: some files are canonical extension definitions (workflows), some may be user data (custom personas/rules). A blanket overwrite is unsafe; a blanket skip is what caused this bug.

## Edge-Case & Dependency Audit

### Race Conditions
- Multiple VS Code windows activating the same workspace simultaneously could race on writing `.agent_version.json`. Mitigation: file writes are atomic, and the version value is deterministic (extension version string).

### Security
- None. No new auth or data exposure. The migration only touches files inside `.agent/`.

### Side Effects
- Users who intentionally edited bundled workflow files (e.g., customized `improve-plan.md`) will see their changes overwritten on version change. This is acceptable for workflow files which are canonical extension definitions — the same policy applied to MCP server files.
- Users with custom personas/rules/skills in `.agent/` are unaffected because the migration targets only files under `.agent/workflows/`.

### Dependencies & Conflicts
- None. This is a self-contained extension setup change.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The `_copyDirectoryRecursive` function lacks relative-path awareness — the original plan's `relativePath.startsWith('workflows/')` check would not compile since no such variable exists in that scope; fix requires adding a `basePath` accumulator parameter. (2) Two copy paths (extension.ts and ControlPlaneMigrationService) could diverge in behavior if version tracking is added to only one. (3) Hash-based safety check is over-engineering for V1; simple version-gated overwrite is sufficient for canonical workflow files. Mitigations: add `basePath` param to `_copyDirectoryRecursive`, add version tracking to both code paths, defer hash logic to future enhancement.

## Proposed Changes

### `src/extension.ts` — Version helper functions

**Location:** Insert after line 101 (after `setLastCopiedMcpVersion`), before `shouldRefreshMcpWorkspaceFiles`

**Context:** The MCP version pattern is established at lines 62-124. The agent version helpers mirror this exactly.

**Implementation:**

```typescript
// --- Agent version tracking (mirrors MCP version pattern above) ---

function getAgentVersionFilePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.switchboard', '.agent_version.json');
}

// Intentionally uses synchronous I/O: called infrequently (once per activation),
// reads a tiny JSON file from local disk — negligible event-loop impact.
function getLastCopiedAgentVersion(workspaceRoot: string): string | undefined {
    const versionFilePath = getAgentVersionFilePath(workspaceRoot);
    try {
        if (fs.existsSync(versionFilePath)) {
            const versionData = JSON.parse(fs.readFileSync(versionFilePath, 'utf-8'));
            return versionData.version;
        }
    } catch (e) {
        console.error('Failed to read last agent version:', e);
    }
    return undefined;
}

function setLastCopiedAgentVersion(workspaceRoot: string, version: string): void {
    const versionFilePath = getAgentVersionFilePath(workspaceRoot);
    try {
        const versionData = { version, lastUpdated: new Date().toISOString() };
        fs.writeFileSync(versionFilePath, JSON.stringify(versionData, null, 2));
    } catch (e) {
        console.error('Failed to write agent version:', e);
    }
}

function shouldRefreshAgentWorkspaceFiles(extensionPath: string, workspaceRoot: string): boolean {
    const currentVersion = getExtensionVersion(extensionPath);
    const lastVersion = getLastCopiedAgentVersion(workspaceRoot);

    // Refresh if we can't determine versions (defensive: always copy)
    if (!currentVersion || !lastVersion) {
        return true;
    }

    // Refresh if versions differ
    if (currentVersion !== lastVersion) {
        return true;
    }

    return false;
}
```

**Note:** `crypto` is already imported at line 4 — no new import needed. The `hashFile` helper from the original plan is **deferred** to a future enhancement (see Future Enhancement note below).

### `src/extension.ts` — Updated copy loop in `performSetup`

**Location:** Lines 3718-3730 (the `.agent` file copy loop)

**Context:** Currently, `.agent` files are copied with a "skip if exists" policy:

```typescript
for (const relativePath of agentFiles) {
    const srcUri = vscode.Uri.joinPath(agentSourceUri, relativePath);
    const destUri = vscode.Uri.joinPath(workspaceUri, '.agent', relativePath);

    // Ensure parent directory exists
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destUri.fsPath)));

    try {
        await vscode.workspace.fs.stat(destUri);
    } catch {
        await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: false });
    }
}
```

This means once a user has old workflow files, they are never updated.

**Implementation — Replace the copy loop (lines 3718-3730) with:**

```typescript
    // 2a. Version-gated workflow migration
    const needsWorkflowMigration = shouldRefreshAgentWorkspaceFiles(extensionUri.fsPath, workspaceUri.fsPath);

    for (const relativePath of agentFiles) {
        const srcUri = vscode.Uri.joinPath(agentSourceUri, relativePath);
        const destUri = vscode.Uri.joinPath(workspaceUri, '.agent', relativePath);

        // Ensure parent directory exists
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destUri.fsPath)));

        const isWorkflowFile = relativePath.startsWith('workflows' + path.sep) && relativePath.endsWith('.md');

        if (isWorkflowFile && needsWorkflowMigration) {
            // Workflow files are canonical extension definitions — always overwrite on version change
            await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: true });
            continue;
        }

        // Existing behavior: skip if file already exists (preserves user customizations)
        try {
            await vscode.workspace.fs.stat(destUri);
        } catch {
            await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: false });
        }
    }

    // Update agent version tracking after successful copy
    const currentVersion = getExtensionVersion(extensionUri.fsPath);
    if (currentVersion) {
        setLastCopiedAgentVersion(workspaceUri.fsPath, currentVersion);
    }
```

**Edge Cases:**
- `relativePath` values from `crawlDirectory` use `path.join()` (line 4345), so on Windows the separator is `\` and on POSIX it's `/`. The check `relativePath.startsWith('workflows' + path.sep)` handles both platforms correctly.
- On fresh install (no `.agent_version.json`), `shouldRefreshAgentWorkspaceFiles` returns `true`, but no destination files exist yet, so `overwrite: true` is harmless and equivalent to the existing `overwrite: false` path.
- The blocklist step (lines 3732-3739) and AGENTS.md scaffolding (lines 3741-3748) remain unchanged after the copy loop.

### `src/services/ControlPlaneMigrationService.ts` — Updated `_bootstrapControlPlaneLayout`

**Location:** Lines 655-688

**Context:** The control-plane setup path copies bundled `.agent` files with `{ overwrite: false }`:

```typescript
await this._copyDirectoryRecursive(bundledAgentDir, path.join(parentDir, '.agent'), { overwrite: false });
```

**Implementation:**

1. Add version-gated overwrite for workflow files. After the existing directory creation (lines 656-661) and before the bundled agent copy (line 669):

```typescript
    // Check if agent workflow files need migration (version-gated)
    const needsAgentMigration = this._shouldRefreshAgentVersion(parentDir, extensionPath);

    const bundledAgentDir = path.join(extensionPath, BUNDLED_AGENT_DIR);
    if (fs.existsSync(bundledAgentDir)) {
        await this._copyDirectoryRecursive(
            bundledAgentDir,
            path.join(parentDir, '.agent'),
            { overwrite: false, overwriteWorkflows: needsAgentMigration }
        );
    }

    // ... existing bundledAgentsFile and bundledMcpDir logic unchanged (lines 672-687) ...

    // Update agent version tracking after successful copy
    if (extensionPath) {
        const currentVersion = this._getExtensionVersion(extensionPath);
        if (currentVersion) {
            this._setAgentVersion(parentDir, currentVersion);
        }
    }
```

2. Add private helper methods to `ControlPlaneMigrationService` (insert near the existing `_resolveBundledMcpDirectory` at line 690):

```typescript
    private static _getExtensionVersion(extensionPath: string): string | undefined {
        const packageJsonPath = path.join(extensionPath, 'package.json');
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            return packageJson.version;
        } catch {
            return undefined;
        }
    }

    private static _getAgentVersionFilePath(rootDir: string): string {
        return path.join(rootDir, '.switchboard', '.agent_version.json');
    }

    private static _getLastAgentVersion(rootDir: string): string | undefined {
        try {
            const versionFilePath = this._getAgentVersionFilePath(rootDir);
            if (fs.existsSync(versionFilePath)) {
                const versionData = JSON.parse(fs.readFileSync(versionFilePath, 'utf-8'));
                return versionData.version;
            }
        } catch { /* non-fatal */ }
        return undefined;
    }

    private static _setAgentVersion(rootDir: string, version: string): void {
        try {
            const versionFilePath = this._getAgentVersionFilePath(rootDir);
            const versionData = { version, lastUpdated: new Date().toISOString() };
            fs.writeFileSync(versionFilePath, JSON.stringify(versionData, null, 2));
        } catch { /* non-fatal */ }
    }

    private static _shouldRefreshAgentVersion(rootDir: string, extensionPath?: string): boolean {
        if (!extensionPath) return false;
        const currentVersion = this._getExtensionVersion(extensionPath);
        const lastVersion = this._getLastAgentVersion(rootDir);
        if (!currentVersion || !lastVersion) return true;
        return currentVersion !== lastVersion;
    }
```

### `src/services/ControlPlaneMigrationService.ts` — Updated `_copyDirectoryRecursive`

**Location:** Lines 919-939

**Context:** The current recursive function has no concept of relative paths from the root — it only knows `sourceDir` and `targetDir` at each recursion level. The original plan's `relativePath.startsWith('workflows/')` check would not work because no `relativePath` variable exists in scope.

**Implementation — Add `basePath` accumulator parameter:**

```typescript
    private static async _copyDirectoryRecursive(
        sourceDir: string,
        targetDir: string,
        options: { overwrite: boolean; overwriteWorkflows?: boolean },
        basePath: string = ''
    ): Promise<void> {
        await fs.promises.mkdir(targetDir, { recursive: true });
        const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
        for (const entry of entries) {
            const sourcePath = path.join(sourceDir, entry.name);
            const targetPath = path.join(targetDir, entry.name);
            const entryRelativePath = basePath ? path.join(basePath, entry.name) : entry.name;
            if (entry.isDirectory()) {
                await this._copyDirectoryRecursive(sourcePath, targetPath, options, entryRelativePath);
                continue;
            }
            const isWorkflowFile = entryRelativePath.startsWith('workflows' + path.sep) && entry.name.endsWith('.md');
            const shouldOverwrite = options.overwrite || (isWorkflowFile && options.overwriteWorkflows);
            if (!shouldOverwrite && fs.existsSync(targetPath)) {
                continue;
            }
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.promises.copyFile(sourcePath, targetPath);
        }
    }
```

**Key change:** The `basePath` parameter (default `''`) accumulates the relative path during recursion. On the first call from `_bootstrapControlPlaneLayout`, it's `''` (default). When recursing into a subdirectory like `workflows/`, it becomes `'workflows'`. This allows `entryRelativePath.startsWith('workflows' + path.sep)` to correctly identify workflow files at any nesting depth.

**Cross-platform note:** `path.join` produces platform-specific separators (`\` on Windows, `/` on POSIX). The `startsWith('workflows' + path.sep)` check handles both. The `basePath` default parameter means all existing call sites (lines 669, 682) continue to work without changes — the new parameter is optional.

### `package.json` — Optional version bump

If this change ships in a new extension version (e.g., `1.6.0`), the version bump itself triggers the migration for all users on update.

### Future Enhancement (deferred)

**Hash-based safety check for user-modified workflow files:**

The ideal long-term approach uses SHA-256 hashes to detect user modifications:

1. Compute SHA-256 hash of the bundled source file.
2. Compute SHA-256 hash of the destination file on disk (if it exists).
3. Compute SHA-256 hash of the PREVIOUS bundled version (stored in a migration manifest shipped with the extension).
4. If the on-disk hash matches the previous bundled hash, the user has NOT modified it → safe to overwrite.
5. If the on-disk hash does NOT match the previous bundled hash, the user MAY have modified it → skip with a warning logged to the output channel.

This requires:
- A `hashFile` helper (already sketched in original plan, `crypto` is imported at `extension.ts:4`).
- A migration manifest file (e.g., `.agent/MANIFEST.json`) shipped with the extension containing hashes of all bundled workflow files from the previous version.
- Build-time tooling to generate this manifest.

This is deferred because workflow files are canonical extension definitions — overwriting them on version change is the correct behavior, matching the policy for MCP server files. The hash check would only matter if users are expected to customize workflow files, which is not a supported use case today.

## Verification Plan

### Automated Tests

1. **Unit test: `src/test/agent-version-migration.test.js`**
   - Mock `getExtensionVersion` returning `"1.6.0"`.
   - Write an old `improve-plan.md` with `complete_workflow_phase` to a temp `.agent/workflows/` directory.
   - Write `.switchboard/.agent_version.json` with `"1.5.9"`.
   - Run the migration logic (extracted to a testable pure function or via the existing test harness).
   - Assert that `improve-plan.md` is overwritten with the bundled version.
   - Assert that `.switchboard/.agent_version.json` is updated to `"1.6.0"`.

2. **Unit test: non-workflow files unaffected**
   - Write a custom `.agent/personas/coder.md` to temp directory.
   - Run migration with version change.
   - Assert file is NOT overwritten.

3. **Unit test: same-version skips migration**
   - Write `.switchboard/.agent_version.json` with `"1.6.0"`.
   - Mock `getExtensionVersion` returning `"1.6.0"`.
   - Assert `shouldRefreshAgentWorkspaceFiles` returns `false`.
   - Assert workflow files are NOT overwritten.

4. **Unit test: fresh install (no version file)**
   - No `.switchboard/.agent_version.json` exists.
   - Assert `shouldRefreshAgentWorkspaceFiles` returns `true`.
   - After setup, assert `.agent_version.json` is written with current version.

5. **Unit test: ControlPlaneMigrationService `_bootstrapControlPlaneLayout`**
   - Mock bundled `.agent/workflows/improve-plan.md`.
   - Call `_bootstrapControlPlaneLayout` with an existing control plane that has an old `improve-plan.md`.
   - Assert workflow file is overwritten.
   - Assert persona file is NOT overwritten.
   - Assert `.switchboard/.agent_version.json` is written.

6. **Unit test: `_copyDirectoryRecursive` with `overwriteWorkflows`**
   - Create source dir with `workflows/test.md` and `personas/coder.md`.
   - Create target dir with existing copies of both files.
   - Call with `{ overwrite: false, overwriteWorkflows: true }`.
   - Assert `workflows/test.md` is overwritten.
   - Assert `personas/coder.md` is NOT overwritten.

### Manual Tests

1. **Fresh install test:**
   - Install extension in a clean VS Code profile.
   - Open a workspace.
   - Verify `.agent/workflows/` are copied correctly.
   - Verify `.switchboard/.agent_version.json` exists with correct version.

2. **Update migration test:**
   - Install old extension version (or manually write old workflow files and set `.agent_version.json` to old version).
   - Update to new extension version.
   - Verify stale `improve-plan.md` references are gone.
   - Verify `.switchboard/.agent_version.json` is updated.

3. **Control plane migration test:**
   - Run "Setup Control Plane" on a parent directory with repos that have old `.agent/workflows/`.
   - Verify workflow files in the control plane's `.agent/workflows/` are updated.
   - Verify `.switchboard/.agent_version.json` is written in the control plane root.

4. **Cross-platform path test:**
   - Verify `relativePath.startsWith('workflows' + path.sep)` works correctly on both Windows and POSIX.

## Execution Summary

**Status:** REVIEWED

**Recommended complexity:** 6 (multi-file change, two distinct code paths, requires careful handling of user data vs canonical files, plus a signature change to a shared recursive utility).

**Recommendation: Send to Coder** (complexity 6 — changes are localized but require testing both single-repo activation and control-plane paths; the logic is straightforward but must not destroy user customizations).

---

## Review Results (2026-05-15)

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | Zero unit tests for the entire feature — plan specified 6, none existed | MAJOR | **Fixed**: wrote 11 unit tests in `src/test/agent-version-migration.test.js` |
| 2 | Plan doc had `startsWith('workflows') + path.sep` (operator-precedence typo); actual code correctly has `startsWith('workflows' + path.sep)` | NIT | **Fixed**: corrected plan doc to match implementation |
| 3 | `shouldRefreshAgentWorkspaceFiles` missing directory-existence guard that MCP equivalent has | NIT | **Deferred**: fallback copy path handles missing files; not a bug |
| 4 | `_shouldRefreshAgentVersion` returns `false` on missing `extensionPath` while `shouldRefreshAgentWorkspaceFiles` returns `true` on missing version info | NIT | **Deferred**: unreachable in practice; semantic inconsistency only |

### Stage 2: Balanced Synthesis

- **Fix now**: Unit tests (MAJOR — migration overwrites user files with zero automated proof), plan doc typos (NIT — documentation must match code)
- **Defer**: Directory-existence guard (nice-for-consistency, not a bug), semantic inconsistency (unreachable path)

### Code Changes Applied

1. **New file**: `src/test/agent-version-migration.test.js` — 11 unit tests covering:
   - `_copyDirectoryRecursive` with `overwriteWorkflows: true` overwrites workflow files only (Test 1)
   - `_copyDirectoryRecursive` without `overwriteWorkflows` preserves workflow files (Test 2)
   - New files are copied even without overwrite (Test 3)
   - `_shouldRefreshAgentVersion` returns `true` on version mismatch (Test 4)
   - `_shouldRefreshAgentVersion` returns `false` when versions match (Test 5)
   - `_shouldRefreshAgentVersion` returns `true` on fresh install (no version file) (Test 6)
   - `_shouldRefreshAgentVersion` returns `false` when extensionPath is undefined (Test 7)
   - `_setAgentVersion` / `_getLastAgentVersion` round-trip (Test 8)
   - `_bootstrapControlPlaneLayout` writes version file and preserves custom personas (Test 9)
   - Nested workflow files are also overwritten (Test 10)
   - Non-.md files in workflows/ are NOT overwritten (Test 11)

2. **Plan doc fix**: Corrected operator-precedence typos in `isWorkflowFile` checks (lines 145, 281)

### Verification Results

- **TypeScript**: No new errors (2 pre-existing errors in ClickUpSyncService.ts and KanbanProvider.ts are unrelated)
- **Unit tests**: All 11 tests pass (`agent version migration test passed`)
- **Existing tests**: `control-plane-migration.test.js` has a pre-existing failure (KanbanDatabase init issue, unrelated to this change)

### Remaining Risks

1. **No automated test for `extension.ts` copy loop**: The `performSetup` copy loop in extension.ts uses `vscode.workspace.fs` APIs that require a VS Code extension host to test. The ControlPlaneMigrationService path is fully tested; the extension.ts path follows the same logic but cannot be unit-tested without a VS Code test harness.
2. **Cross-platform path separator**: The `startsWith('workflows' + path.sep)` check is correct on both POSIX and Windows, but this is only verified on macOS in the current test run. Windows CI would be needed for full confidence.
3. **Stale file cleanup**: If a workflow file is removed from the bundled `.agent/workflows/` in a future version, the old file will persist in the workspace. This is the same behavior as the MCP version migration and is a separate concern.
